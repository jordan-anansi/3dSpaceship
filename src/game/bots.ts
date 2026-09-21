import { MapSchema } from '@colyseus/schema';
import { Quaternion, Vector3 } from 'three';
import { Player } from './schema';
import { applyStats } from './upgrades';
import {
  ASTEROID_FIELD, LOCAL_FORWARD, LOCAL_RIGHT, SPAWN_RADIUS, TICK_DT, asteroidCenters,
} from './tuning';
import { BOLT_SPEED } from './weapons';

// Bots exist so a solo player has something to fight. They are Players in the
// same map as humans, with isBot set — the client renders them through the
// identical path, and the room simulates them through the identical physics.
// A bot produces the same {moveZ, moveX} stick input a human's keyboard does
// and then goes through accelerate(), so it inherits momentum, carving and
// drag for free. That's the point: they fly like ships, not like turrets, and
// any change to the movement model applies to them automatically.
//
// The only thing they do differently is orientation — no mouse, no look
// batches, so they slew directly toward their aim point at a capped rate.
// That rate limit IS their accuracy model: a bot leads its target perfectly
// but can only turn so fast, so strafing across one is genuinely evasive
// while flying straight at one is not.

const TURN_RATE = 100 * (Math.PI / 180); // rad/s the nose can slew
const RETARGET_SEC = 1.5;
const FIRE_CONE = 5 * (Math.PI / 180);   // aim must be this close before firing
const FIRE_RANGE = 260;
// Preferred standoff. Bots thrust in beyond it and back off inside it, which
// keeps them circling at a readable distance instead of face-hugging.
const RANGE_NEAR = 45;
const RANGE_FAR = 95;
const JINK_SEC = 1.1;          // how often the orbit direction flips

// --- aim error ---
// Two parts, and the split is the point:
//   BASE     — a floor, so point-blank is never a guaranteed hit.
//   PER_UNIT — grows with range. An absolute-only offset does the OPPOSITE
//              of what you'd expect: the same 4 units of error is a wide
//              miss at 20 units and a rounding error at 400, which makes
//              bots most lethal exactly where a player can least react.
const AIM_JITTER_BASE = 1.9;
const AIM_JITTER_PER_UNIT = 0.035;
// Re-rolled on its own short timer, deliberately NOT tied to the jink. One
// offset held across a whole burst means every shot in that burst hits or
// every shot misses — which reads as the bot randomly being a crack shot
// rather than as spray.
const AIM_DRIFT_SEC = 0.3;
// Asteroid avoidance: if a rock's surface is within this cone/distance ahead,
// steering away outranks shooting. Without it bots grind along rocks forever.
const AVOID_DIST = 55;
const AVOID_PAD = 8;

export interface BotInput {
  moveZ: number;
  moveX: number;
  /** true on the tick the bot wants to pull the trigger */
  wantsFire: boolean;
}

interface Brain {
  target: string | null;
  retargetIn: number;
  jinkIn: number;
  orbit: 1 | -1;
  /** seconds until the aim offset is re-rolled */
  driftIn: number;
  /** current aim offset, magnitude <= 1; scaled by range at use */
  jitter: Vector3;
}

let botSerial = 0;

const randomSpawn = () => {
  // uniform point on a sphere — ships arrive from every direction, and never
  // inside the planet or a rock at the origin
  const u = Math.random() * 2 - 1;
  const theta = Math.random() * 2 * Math.PI;
  const s = Math.sqrt(1 - u * u);
  return new Vector3(s * Math.cos(theta), u, s * Math.sin(theta)).multiplyScalar(SPAWN_RADIUS);
};

export class Bots {
  private brains = new Map<string, Brain>();

  /**
   * Top the field up to `desired` total combatants by adding or removing
   * bots. Humans always count toward the total, so bots quietly make room as
   * real players arrive rather than piling on top of them.
   *
   * `round` scales their loadout: bots pick up the same catalog tiers players
   * do, so they stay a threat into a long run instead of becoming target
   * practice by round five.
   */
  sync(players: MapSchema<Player>, desired: number, max: number, round: number) {
    const humans: string[] = [];
    const bots: string[] = [];
    players.forEach((p, id) => (p.isBot ? bots : humans).push(id));

    const want = Math.max(0, Math.min(max, desired - humans.length));
    for (let i = bots.length; i < want; i++) this.spawn(players, round);
    for (let i = bots.length; i > want; i--) {
      const id = bots[i - 1];
      players.delete(id);
      this.brains.delete(id);
    }
    // bots already in the field keep up with the round they're fighting in
    players.forEach((p) => { if (p.isBot) this.equip(p, round); });
  }

  private spawn(players: MapSchema<Player>, round: number) {
    const bot = new Player();
    bot.isBot = true;
    bot.name = `DRN-${String(++botSerial).padStart(2, '0')}`;
    const at = randomSpawn();
    bot.x = at.x; bot.y = at.y; bot.z = at.z;
    // face roughly inward, where the action is
    const q = new Quaternion().setFromUnitVectors(LOCAL_FORWARD, at.clone().negate().normalize());
    bot.qx = q.x; bot.qy = q.y; bot.qz = q.z; bot.qw = q.w;
    this.equip(bot, round);
    const id = `bot_${botSerial}`;
    players.set(id, bot);
    this.brains.set(id, {
      target: null, retargetIn: 0, jinkIn: 0, driftIn: 0, orbit: 1, jitter: new Vector3(),
    });
  }

  // Bot loadout by round. Deliberately behind what a player can reach — a
  // player who spends well should out-scale them, which is the reward for
  // shopping well.
  private equip(bot: Player, round: number) {
    // Bots stay on the bolt even though players now START on the railgun.
    // A travel-time projectile is dodgeable, which is the only thing making
    // a perfect-aim opponent fair; hand that same aim a hitscan beam and
    // there is no counterplay left, just damage on a timer. So this is an
    // explicit assignment rather than the schema default.
    bot.weapon = 'bolt';
    bot.tech.set('bolt', 1);
    bot.tech.set('plating', Math.min(4, Math.floor(round / 2)));
    bot.tech.set('overdrive', Math.min(4, Math.floor((round - 1) / 2)));
    bot.tech.set('boltDamage', Math.min(3, Math.floor(round / 3)));
    applyStats(bot);
  }

  /** Forget a bot's memory when it leaves the field. */
  forget(id: string) {
    this.brains.delete(id);
  }

  /**
   * Turn the bot's nose and decide its stick input for this tick. Writes the
   * orientation directly (bots have no look batches to fold) and returns the
   * input the caller feeds through the same accelerate() path humans use.
   */
  steer(bot: Player, id: string, players: MapSchema<Player>, tick: number, dt: number): BotInput {
    const brain = this.brains.get(id);
    if (!brain) return { moveZ: 0, moveX: 0, wantsFire: false };

    const here = new Vector3(bot.x, bot.y, bot.z);

    brain.retargetIn -= dt;
    if (brain.retargetIn <= 0 || !this.stillValid(players, brain.target)) {
      brain.target = this.nearestEnemy(players, id, here);
      brain.retargetIn = RETARGET_SEC;
    }
    brain.jinkIn -= dt;
    if (brain.jinkIn <= 0) {
      brain.jinkIn = JINK_SEC;
      brain.orbit = Math.random() < 0.5 ? 1 : -1;
    }
    brain.driftIn -= dt;
    if (brain.driftIn <= 0) {
      brain.driftIn = AIM_DRIFT_SEC;
      // a random point in the unit ball: direction uniform on the sphere,
      // magnitude cube-rooted so offsets aren't all bunched at the rim
      const u = Math.random() * 2 - 1;
      const theta = Math.random() * 2 * Math.PI;
      const s = Math.sqrt(1 - u * u);
      brain.jitter
        .set(s * Math.cos(theta), u, s * Math.sin(theta))
        .multiplyScalar(Math.cbrt(Math.random()));
    }

    const target = brain.target ? players.get(brain.target) : undefined;
    const orientation = new Quaternion(bot.qx, bot.qy, bot.qz, bot.qw);

    // Nothing to shoot: cruise back toward the middle of the field so bots
    // don't accumulate out at the edges waiting for someone to find them.
    if (!target) {
      const home = here.clone().negate();
      const dist = home.length();
      this.slew(orientation, dist > 1 ? home.normalize() : LOCAL_FORWARD, dt);
      this.write(bot, orientation);
      return { moveZ: dist > SPAWN_RADIUS * 0.5 ? 1 : 0, moveX: 0, wantsFire: false };
    }

    // Lead the shot. Bolts take travel time, so aiming at where the target IS
    // never connects against anything moving. One iteration is plenty at
    // these speeds — solving the quadratic exactly buys nothing a player
    // would notice, and the aim jitter swamps the difference anyway.
    const targetPos = new Vector3(target.x, target.y, target.z);
    const range = here.distanceTo(targetPos);
    const flightTime = range / BOLT_SPEED;
    // Error is measured off the TRUE range, not the jittered one, so the
    // offset can't feed back on itself and run away.
    const spread = AIM_JITTER_BASE + AIM_JITTER_PER_UNIT * range;
    const lead = targetPos.clone()
      .addScaledVector(new Vector3(target.vx, target.vy, target.vz), flightTime)
      .addScaledVector(brain.jitter, spread);

    const toTarget = lead.clone().sub(here);
    const dist = toTarget.length();
    let aim = dist > 1e-3 ? toTarget.clone().divideScalar(dist) : LOCAL_FORWARD.clone();

    // Rocks outrank targets: a bot grinding its nose into an asteroid while
    // dutifully tracking someone on the far side of it looks broken.
    const avoid = this.avoidance(here, aim, tick);
    const evading = avoid !== null;
    if (avoid) aim = aim.add(avoid).normalize();

    this.slew(orientation, aim, dt);
    this.write(bot, orientation);

    // Fire only when actually pointed at them — the turn-rate limit above is
    // what makes this miss, so there's no separate accuracy roll.
    const facing = LOCAL_FORWARD.clone().applyQuaternion(orientation);
    const onTarget = !evading
      && dist < FIRE_RANGE
      && facing.angleTo(toTarget.divideScalar(dist)) < FIRE_CONE;

    // close in when far, back off when crowded, and always drift sideways so
    // they present a moving target rather than a closing dot
    let moveZ = 0;
    if (dist > RANGE_FAR) moveZ = 1;
    else if (dist < RANGE_NEAR) moveZ = -1;
    return { moveZ, moveX: brain.orbit, wantsFire: onTarget };
  }

  private write(bot: Player, q: Quaternion) {
    bot.qx = q.x; bot.qy = q.y; bot.qz = q.z; bot.qw = q.w;
  }

  /** Rotate `q` toward `aim`, no faster than TURN_RATE. */
  private slew(q: Quaternion, aim: Vector3, dt: number) {
    const want = new Quaternion().setFromUnitVectors(LOCAL_FORWARD, aim);
    const facing = LOCAL_FORWARD.clone().applyQuaternion(q);
    const angle = facing.angleTo(aim);
    if (angle < 1e-4) return;
    q.slerp(want, Math.min(1, (TURN_RATE * dt) / angle)).normalize();
  }

  private stillValid(players: MapSchema<Player>, id: string | null) {
    if (!id) return false;
    const p = players.get(id);
    return !!p && p.alive;
  }

  private nearestEnemy(players: MapSchema<Player>, self: string, here: Vector3) {
    let best: string | null = null;
    let bestDist = Infinity;
    players.forEach((p, id) => {
      if (id === self || !p.alive) return;
      // Bots prefer humans but will scrap with each other if that's all
      // there is — an empty-looking field of idle drones reads as broken.
      const bias = p.isBot ? 2.5 : 1;
      const d = here.distanceToSquared(new Vector3(p.x, p.y, p.z)) * bias;
      if (d < bestDist) { bestDist = d; best = id; }
    });
    return best;
  }

  /**
   * A steering nudge away from any rock the bot is about to fly into, or null
   * if the way ahead is clear. Returns a unit-ish vector to blend into the
   * aim direction, not a replacement heading — blending keeps the bot roughly
   * pointed at its target while it slides around the obstacle.
   */
  private avoidance(here: Vector3, heading: Vector3, tick: number): Vector3 | null {
    const centers = asteroidCenters(tick * TICK_DT);
    for (let i = 0; i < ASTEROID_FIELD.length; i++) {
      const rock = ASTEROID_FIELD[i];
      const toRock = new Vector3(
        centers[i * 3] - here.x,
        centers[i * 3 + 1] - here.y,
        centers[i * 3 + 2] - here.z,
      );
      const along = toRock.dot(heading);
      // Lookahead scales with the rock. A fixed 55 units is a sensible margin
      // around a 10-unit boulder and no margin at all around a 500-unit
      // monolith — by the time its CENTRE is 55 units ahead you are already
      // deep inside it, so bots would fly straight into the big ones.
      const lookahead = AVOID_DIST + rock.r;
      if (along < 0 || along > lookahead) continue; // behind, or far enough off
      const clearance = rock.r + AVOID_PAD;
      // perpendicular distance from the rock's centre to our flight line
      const perp = toRock.clone().addScaledVector(heading, -along);
      if (perp.length() > clearance) continue;
      // push directly away from the line's closest approach; when we're dead
      // on the centre line `perp` is degenerate, so pick any perpendicular
      const away = perp.lengthSq() > 1e-4
        ? perp.negate().normalize()
        : new Vector3().crossVectors(heading, LOCAL_RIGHT).normalize();
      // stronger the closer the rock is — a distant one barely bends us
      return away.multiplyScalar(1.5 * (1 - along / lookahead) + 0.5);
    }
    return null;
  }
}
