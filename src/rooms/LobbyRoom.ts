import { Room, Client } from '@colyseus/core';
import { MapSchema } from '@colyseus/schema';
import { Quaternion, Vector3 } from 'three';
import { Bots } from '../game/bots';
import { tierOf } from '../game/catalog';
import { Blast, LobbyState, Player, Shot } from '../game/schema';
import { applyStats, buy, drawOffer, skip, statsFor } from '../game/upgrades';
import { WEAPONS, defaultWeapon, weaponFor } from '../game/weapons';
import type { Hit, StepContext, SweepOpts } from '../game/weapons';
import {
  ASTEROID_FIELD, BOT_FIRE_COOLDOWN_MULT, BOT_MAX, BOT_TARGET_COMBATANTS, COMBAT_SECONDS, DASH_CEIL_MULT,
  DASH_FALLOFF_DRAG, DASH_FALLOFF_TIME, DASH_IMPULSE, DEATH_BLAST_RADIUS, DRAG_GOVERNOR,
  DRAG_RAMP_HI_MULT, DRAG_RAMP_LO_MULT, HISTORY_TICKS, INTERMISSION_SECONDS, LOCAL_FORWARD,
  LOCAL_RIGHT, LOCAL_UP, MOUSE_SENS, RESPAWN_DELAY_SEC, ROUND_STIPEND_BASE, ROUND_STIPEND_PER_ROUND,
  SCRAP_PER_BOT_KILL, SCRAP_PER_DAMAGE, SCRAP_PER_PLAYER_KILL, SHIP_RADIUS, SHOP_SECONDS,
  SPAWN_RADIUS, SPEED_RAIL, STOP_SPEED, TICK_DT, asteroidCenters,
} from '../game/tuning';

/**
 * Which shot is currently resolving damage. Bound into the weapon context so
 * damage() can attribute a hit without every weapon having to pass it: the
 * token collapses multi-victim damage from one shot into one "hit" for
 * accuracy, and the weapon id names the gun in the killfeed accurately even
 * if the shooter has switched weapons since the shell left the tube.
 */
interface DamageSource { token: string; weapon: string }

// The client implements the 'mouse' control scheme and nothing else: pointer
// deltas yaw/pitch the ship, q/e roll, w/s thrust, a/d strafe once Lateral
// Thrusters are bought. The older 'flight' (torque) and 'strafe' (direct
// look) schemes and their client are archived in
// legacy/client-keyboard-controls.js and in git history — the server-side
// branches for them were dropped when movement tuning became per-player,
// because carrying three schemes through that meant triplicating every
// upgrade.

interface Input {
  moveZ: number; // -1..1, +1 = forward
  moveX: number; // -1..1, +1 = strafe right
}

const NO_INPUT: Input = { moveZ: 0, moveX: 0 };

const clamp1 = (v: unknown) => Math.max(-1, Math.min(1, Number(v) || 0));

// look batches: one accumulated chunk of client input. dx/dy in pixels, roll
// already integrated to radians by the client (it knows its own frame
// timing). seq is client-authored and strictly increasing.
interface LookBatch { seq: number; dx: number; dy: number; roll: number }
const MAX_LOOK_PX = 1000;     // per-batch pixel clamp (≈2 rad of turn)
const MAX_BATCH_ROLL = 0.25;  // per-batch roll clamp, rad (~90°/s at 33ms batches)

const BLAST_LIFE_TICKS = 40;  // long enough for the client's expand-and-fade

// Source's Accelerate(), vectorised. The asymmetry is the whole trick:
// addSpeed is measured against the CLAMPED maxWish, while accelSpeed is
// scaled by the FULL wishSpeed. Pushing along the way you're already moving
// converges on maxWish instead of stacking; pushing across your velocity
// costs nothing against the cap and raises total speed. Both thrust and the
// dash go through here — they differ only in their two knobs.
function accelerate(p: Player, wishDir: Vector3, wishSpeed: number, maxWish: number, accel: number, dt: number) {
  const currentSpeed = p.vx * wishDir.x + p.vy * wishDir.y + p.vz * wishDir.z;
  const addSpeed = maxWish - currentSpeed;
  if (addSpeed <= 0) return;
  const accelSpeed = Math.min(addSpeed, accel * wishSpeed * dt);
  p.vx += wishDir.x * accelSpeed;
  p.vy += wishDir.y * accelSpeed;
  p.vz += wishDir.z * accelSpeed;
}

// Build a wishDir/wishSpeed pair from stick input in the ship's local frame.
// Source normalises wishDir and carries the deflection in wishSpeed, so a
// diagonal (w+d) is a DIRECTION, not a √2 speed bonus.
//
// strafeScale below 1 is applied to moveX BEFORE normalising, which is the
// right place for it: weak lateral thrusters bias the wish direction toward
// the nose AND shrink the total deflection, rather than just capping sideways
// speed after the fact. Same trick Source uses for differing forward/side
// move speeds.
function wishFromInput(moveZ: number, moveX: number, strafeScale: number, orientation: Quaternion) {
  const wishVel = new Vector3()
    .addScaledVector(LOCAL_FORWARD, moveZ)
    .addScaledVector(LOCAL_RIGHT, moveX * strafeScale);
  const mag = Math.min(1, wishVel.length());
  if (mag < 1e-6) return { dir: wishVel, mag: 0 };
  return { dir: wishVel.normalize().applyQuaternion(orientation), mag };
}

const randomSpawn = () => {
  // uniform point on a sphere, so respawns arrive from every direction
  const u = Math.random() * 2 - 1;
  const theta = Math.random() * 2 * Math.PI;
  const s = Math.sqrt(1 - u * u);
  return new Vector3(s * Math.cos(theta), u, s * Math.sin(theta)).multiplyScalar(SPAWN_RADIUS);
};

export class LobbyRoom extends Room<LobbyState> {
  private inputs = new Map<string, Input>();
  // ONE refire gate per player, not one per weapon. Sharing it is deliberate:
  // per-weapon timers would let you swap rail → flak → bolt to fire three
  // shots inside one railgun cooldown, which is strictly better than picking
  // a gun and beats every honest loadout.
  private lastFireTime = new Map<string, number>();
  // ordered queue of look batches per session, drained into the orientation
  // by update() each tick — or early by fire(), so a shot's aim includes
  // every batch the shooter had applied locally when they pulled the trigger
  private pendingLook = new Map<string, LookBatch[]>();
  // position snapshots for the last HISTORY_TICKS ticks (lag compensation)
  private history: { tick: number; positions: Map<string, Vector3> }[] = [];
  private shotCounter = 0;
  private blastCounter = 0;
  private fireCounter = 0;
  // sessionId → socket, so damage() can send a hitmarker to one shooter
  // without scanning the client list on every point of damage dealt
  private clientsById = new Map<string, Client>();
  // shooter → the last shot token they scored with. One shot may damage
  // several ships in one resolution pass (a flak burst, a ram dome); this
  // collapses that into a single counted hit. Contiguity is what makes one
  // slot enough: all of a shot's damage lands inside one fire() or one
  // step() call, so no other shot can interleave with it.
  private lastHitToken = new Map<string, string>();
  // seconds of elevated post-dash drag still owed, per session. The dash
  // itself is instantaneous, so this is the only state it leaves behind.
  private dashFalloff = new Map<string, number>();
  private bots = new Bots();

  onCreate() {
    this.setState(new LobbyState());

    this.onMessage('setDrag', (_client, value: unknown) => {
      const drag = Number(value);
      if (Number.isFinite(drag)) {
        this.state.drag = Math.max(0, Math.min(5, drag));
        console.log(`[lobby] drag set to ${this.state.drag}`);
      }
    });

    this.onMessage('input', (client, msg: Partial<Input>) => {
      this.inputs.set(client.sessionId, {
        moveZ: clamp1(msg?.moveZ),
        moveX: clamp1(msg?.moveX),
      });
    });

    this.onMessage('look', (client, msg: Partial<LookBatch>) => {
      const clampPx = (v: unknown) => Math.max(-MAX_LOOK_PX, Math.min(MAX_LOOK_PX, Number(v) || 0));
      const seq = Math.floor(Number(msg?.seq) || 0);
      const queue = this.pendingLook.get(client.sessionId) ?? [];
      // seq must strictly increase past everything queued AND everything
      // already folded — replays/reorders are dropped, not applied twice
      const player = this.state.players.get(client.sessionId);
      const lastSeq = queue.length ? queue[queue.length - 1].seq : (player?.lookSeq ?? 0);
      if (seq <= lastSeq) return;
      queue.push({
        seq,
        dx: clampPx(msg?.dx),
        dy: clampPx(msg?.dy),
        roll: Math.max(-MAX_BATCH_ROLL, Math.min(MAX_BATCH_ROLL, Number(msg?.roll) || 0)),
      });
      this.pendingLook.set(client.sessionId, queue);
    });

    this.onMessage('fire', (client, msg: { seq?: number; tick?: number }) =>
      this.fire(client.sessionId, Math.floor(Number(msg?.seq) || 0), Math.floor(Number(msg?.tick) || 0)));

    this.onMessage('dash', (client, msg: { seq?: number }) =>
      this.dash(client.sessionId, Math.floor(Number(msg?.seq) || 0)));

    // --- progression ---

    this.onMessage('startGame', (client) => {
      if (this.state.phase !== 'lobby') return;
      const who = this.state.players.get(client.sessionId)?.name ?? client.sessionId;
      console.log(`[lobby] ${who} started the run`);
      this.beginShop();
    });

    this.onMessage('buy', (client, msg: { id?: string }) => {
      if (this.state.phase !== 'shop') return;
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const err = buy(player, String(msg?.id ?? ''));
      if (err) client.send('shopError', err);
      else console.log(`[lobby] ${player.name} bought ${msg?.id}`);
    });

    this.onMessage('skip', (client) => {
      if (this.state.phase !== 'shop') return;
      const player = this.state.players.get(client.sessionId);
      if (player) skip(player);
    });

    this.onMessage('setWeapon', (client, msg: { id?: string }) => {
      const player = this.state.players.get(client.sessionId);
      const id = String(msg?.id ?? '');
      if (!player || !WEAPONS.has(id)) return;
      // you can only select something you actually own
      if (id !== defaultWeapon && tierOf(player, id) === 0) return;
      player.weapon = id;
    });

    this.onMessage('setFuse', (client, value: unknown) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const fuse = Number(value);
      if (Number.isFinite(fuse)) player.fuse = Math.max(5, Math.min(200, fuse));
    });

    this.setSimulationInterval((dtMs) => this.update(dtMs / 1000));
  }

  // ---------------------------------------------------------------- phases

  private secondsToTicks = (seconds: number) => Math.round(seconds / TICK_DT);

  private humans() {
    const out: Player[] = [];
    this.state.players.forEach((p) => { if (!p.isBot) out.push(p); });
    return out;
  }

  private beginShop() {
    this.state.round += 1;
    this.state.phase = 'shop';
    this.state.phaseEndTick = this.state.tick + this.secondsToTicks(SHOP_SECONDS);
    this.clearOrdnance();
    for (const player of this.humans()) {
      player.ready = false;
      drawOffer(player);
    }
    console.log(`[lobby] round ${this.state.round}: shop open`);
  }

  private beginCombat() {
    this.state.phase = 'combat';
    this.state.phaseEndTick = this.state.tick + this.secondsToTicks(COMBAT_SECONDS);
    this.clearOrdnance();
    // Bots are synced at the START of combat so their loadout matches the
    // round being fought, and so a player who joined during the shop is
    // already counted when we decide how many to field.
    this.bots.sync(this.state.players, BOT_TARGET_COMBATANTS, BOT_MAX, this.state.round);
    this.state.players.forEach((p, id) => {
      p.ready = false;
      p.offer.clear();
      p.upgrades.clear();
      p.kills = 0;
      p.deaths = 0;
      p.roundScrap = 0;
      p.damageDealt = 0;
      p.shotsFired = 0;
      p.shotsHit = 0;
      p.ramReadyTick = 0;
      this.respawn(p, id);
    });
    console.log(`[lobby] round ${this.state.round}: fight`);
  }

  private beginIntermission() {
    this.state.phase = 'intermission';
    this.state.phaseEndTick = this.state.tick + this.secondsToTicks(INTERMISSION_SECONDS);
    this.clearOrdnance();
    // Everyone who saw the round through gets paid, win or lose. The stipend
    // is what guarantees the next shop is never a dead screen — combat
    // earnings alone can be zero for a player who had a bad round, and a
    // shop with nothing affordable in it is just a 30-second pause.
    const stipend = ROUND_STIPEND_BASE + ROUND_STIPEND_PER_ROUND * this.state.round;
    for (const player of this.humans()) {
      player.scrap += stipend;
      player.roundScrap += stipend;
    }
    console.log(`[lobby] round ${this.state.round} over — stipend ${stipend}`);
  }

  private stepPhase() {
    const { phase, tick, phaseEndTick } = this.state;
    if (phase === 'lobby') return;

    const expired = phaseEndTick > 0 && tick >= phaseEndTick;

    if (phase === 'shop') {
      const humans = this.humans();
      // end early once everyone has decided — no reason to sit out the clock.
      // An empty room (everyone disconnected mid-shop) falls through to the
      // timer rather than starting a fight nobody is in.
      const allReady = humans.length > 0 && humans.every((p) => p.ready);
      if (allReady || expired) this.beginCombat();
      return;
    }

    if (phase === 'combat' && expired) { this.beginIntermission(); return; }
    if (phase === 'intermission' && expired) this.beginShop();
  }

  /** Drop every in-flight shot and blast — used on every phase boundary. */
  private clearOrdnance() {
    this.state.shots.clear();
    this.state.blasts.clear();
    // the tokens only ever refer to shots that no longer exist now
    this.lastHitToken.clear();
  }

  // ------------------------------------------------------------ simulation

  update(dt: number) {
    this.state.tick++;
    this.stepPhase();

    this.state.players.forEach((p, sessionId) => {
      // Derived fresh each tick rather than cached. It's eight map lookups
      // and a small object; the alternative is an invalidation rule that has
      // to fire on purchases, bot re-equips and joins, and silently
      // desyncs the simulation from the player's loadout when it doesn't.
      const stats = statsFor(p);
      const input = this.stepIntent(p, sessionId, dt);

      // Friction first, then accelerate — Source's order. Doing it this way
      // round means the projection cap gets the last word, so straight-line
      // flight actually arrives at maxWish instead of settling just under it.
      const preSpeed = Math.hypot(p.vx, p.vy, p.vz);
      if (preSpeed > 0) {
        const control = Math.max(preSpeed, STOP_SPEED); // floor: drift terminates
        const drag = this.dragFor(sessionId, preSpeed, stats.maxWish);
        const scale = Math.max(0, preSpeed - control * drag * dt) / preSpeed;
        p.vx *= scale; p.vy *= scale; p.vz *= scale;
      }

      // A destroyed ship keeps its momentum and coasts to a stop as a wreck,
      // but takes no input — it's out until respawn.
      if (p.alive && (input.moveZ || input.moveX)) {
        const orientation = new Quaternion(p.qx, p.qy, p.qz, p.qw);
        const { dir, mag } = wishFromInput(input.moveZ, input.moveX, stats.strafeScale, orientation);
        if (mag > 0) {
          accelerate(p, dir, stats.wishSpeed * mag, stats.maxWish * mag, stats.thrustAccel, dt);
        }
      }

      // The dash impulse itself landed in dash(); all that's left per tick is
      // to run down its falloff window (dragFor() reads it above).
      const falloff = this.dashFalloff.get(sessionId);
      if (falloff !== undefined) {
        if (falloff - dt <= 0) this.dashFalloff.delete(sessionId);
        else this.dashFalloff.set(sessionId, falloff - dt);
      }

      // juice trickles back continuously — one whole charge per
      // juiceRegenSec, with no post-spend lockout
      if (p.juice < stats.juiceMax) {
        p.juice = Math.min(stats.juiceMax, p.juice + dt / stats.juiceRegenSec);
      }

      // No magnitude cap here by design — capping |v| would undo the whole
      // point of the projection cap and flatten carving back into scripted
      // arcade flight. This is only the integrator rail (see SPEED_RAIL).
      const speed = Math.hypot(p.vx, p.vy, p.vz);
      if (speed > SPEED_RAIL) {
        const k = SPEED_RAIL / speed;
        p.vx *= k; p.vy *= k; p.vz *= k;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      this.collideAsteroids(p);

      if (!p.alive && p.respawnTick > 0 && this.state.tick >= p.respawnTick) this.respawn(p, sessionId);
    });

    this.stepShots();
    this.stepBlasts();

    // snapshot everyone's position for lag-compensated rewind. Slots recycle
    // every HISTORY_TICKS ticks; each stores its tick so a stale slot can
    // never be mistaken for the requested one.
    const positions = new Map<string, Vector3>();
    this.state.players.forEach((p, sessionId) => positions.set(sessionId, new Vector3(p.x, p.y, p.z)));
    this.history[this.state.tick % HISTORY_TICKS] = { tick: this.state.tick, positions };
  }

  /**
   * Resolve one ship's intent for this tick: fold pending look batches (or,
   * for a bot, run the AI and let it write its own orientation), and return
   * the stick input to accelerate along.
   */
  private stepIntent(p: Player, sessionId: string, dt: number): Input {
    if (!p.isBot) {
      // pointer deltas yaw/pitch the ship directly; roll arrives
      // pre-integrated inside the same batches. All rotation is
      // momentum-free — nothing persists on release.
      this.drainLook(p, sessionId);
      return p.alive ? (this.inputs.get(sessionId) ?? NO_INPUT) : NO_INPUT;
    }

    if (!p.alive) return NO_INPUT;
    const intent = this.bots.steer(p, sessionId, this.state.players, this.state.tick, dt);
    if (intent.wantsFire && this.state.phase === 'combat') this.fire(sessionId, 0, this.state.tick);
    return { moveZ: intent.moveZ, moveX: intent.moveX };
  }

  // Fold queued look batches (up to and including upToSeq) into the player's
  // orientation. Per batch: yaw, then pitch, then roll, about local axes —
  // the exact fold the client runs for prediction, so given the same batches
  // both sides compute the same quaternion.
  private drainLook(p: Player, sessionId: string, upToSeq = Infinity) {
    const queue = this.pendingLook.get(sessionId);
    if (!queue?.length) return;
    const orientation = new Quaternion(p.qx, p.qy, p.qz, p.qw);
    while (queue.length && queue[0].seq <= upToSeq) {
      const batch = queue.shift()!;
      if (batch.dx) orientation.multiply(new Quaternion().setFromAxisAngle(LOCAL_UP, -batch.dx * MOUSE_SENS));
      if (batch.dy) orientation.multiply(new Quaternion().setFromAxisAngle(LOCAL_RIGHT, -batch.dy * MOUSE_SENS));
      if (batch.roll) orientation.multiply(new Quaternion().setFromAxisAngle(LOCAL_FORWARD, batch.roll));
      orientation.normalize();
      p.lookSeq = batch.seq;
    }
    p.qx = orientation.x; p.qy = orientation.y; p.qz = orientation.z; p.qw = orientation.w;
  }

  /** Hand every in-flight shot to its weapon, and expire the stragglers. */
  private stepShots() {
    this.state.shots.forEach((shot, id) => {
      const def = weaponFor(shot.kind);
      if (this.state.tick - shot.spawnTick > def.lifeTicks) {
        this.state.shots.delete(id);
        return;
      }
      // One context per shot rather than one for the tick: each carries the
      // shot's own id as the damage token, which is what lets a burst that
      // catches three ships count as one hit. Shots in flight are a handful,
      // so the allocation is nothing next to the sweeps it wraps.
      def.step?.(shot, id, this.stepContext({ token: id, weapon: shot.kind }));
    });
  }

  private stepBlasts() {
    this.state.blasts.forEach((blast, id) => {
      if (this.state.tick - blast.spawnTick > BLAST_LIFE_TICKS) this.state.blasts.delete(id);
    });
  }

  // ------------------------------------------------------------- combat

  /**
   * Apply damage and everything that follows from it. The single place a
   * ship's hull ever goes down, so scrap payout, the kill counter and the
   * respawn schedule can't get out of step with each other.
   */
  private damage(victimId: string, amount: number, byId: string, source?: DamageSource) {
    if (this.state.phase !== 'combat') return;
    const victim = this.state.players.get(victimId);
    if (!victim || !victim.alive || amount <= 0) return;
    // self-damage is never a thing — every weapon excludes its shooter, and
    // this is the backstop if one forgets
    if (victimId === byId) return;

    const dealt = Math.min(amount, victim.hull);
    victim.hull -= dealt;
    const killed = victim.hull <= 0;

    const shooter = this.state.players.get(byId);
    if (shooter) {
      // Clamped to the hull above, so an instant-kill weapon's nominal damage
      // can't inflate this into a meaningless number on the scoreboard.
      shooter.damageDealt += dealt;
      if (source && this.lastHitToken.get(byId) !== source.token) {
        this.lastHitToken.set(byId, source.token);
        shooter.shotsHit += 1;
      }
      // Paying for damage rather than only for kills means engaging is always
      // worth something, so a player who loses every duel still shops.
      if (!shooter.isBot) {
        const earned = dealt * SCRAP_PER_DAMAGE;
        shooter.scrap += earned;
        shooter.roundScrap += earned;
      }
    }

    // Hitmarker. Sent per damage EVENT, not per shot: a flak burst catching
    // two ships should tick twice, which is a different question from what
    // accuracy counts above. Fire-and-forget — a shooter who has already
    // disconnected simply isn't in the map.
    this.clientsById.get(byId)?.send('hit', {
      amount: Math.round(dealt),
      killed,
      victim: victim.name,
    });

    if (!killed) return;

    victim.hull = 0;
    victim.alive = false;
    victim.deaths += 1;
    victim.respawnTick = this.state.tick + this.secondsToTicks(RESPAWN_DELAY_SEC);
    // The wreck keeps drifting server-side but stops being drawn, so without
    // something at the moment of death a ship just blinks out. Cosmetic only.
    this.spawnBlast(new Vector3(victim.x, victim.y, victim.z), DEATH_BLAST_RADIUS, 'death');
    if (shooter) {
      shooter.kills += 1;
      if (!shooter.isBot) {
        const bounty = victim.isBot ? SCRAP_PER_BOT_KILL : SCRAP_PER_PLAYER_KILL;
        shooter.scrap += bounty;
        shooter.roundScrap += bounty;
      }
    }
    // Broadcast rather than sent to the two parties: the feed is for everyone,
    // and knowing who is beating whom is how you decide where to fly next.
    // The weapon comes off the SHOT (via source), not off shooter.weapon — a
    // shell still in flight when its owner switched guns should credit the
    // gun that fired it.
    this.broadcast('kill', {
      by: shooter?.name ?? '',
      byId,
      byBot: shooter?.isBot ?? false,
      victim: victim.name,
      victimId,
      victimBot: victim.isBot,
      weapon: source ? weaponFor(source.weapon).name : '',
    });
    console.log(`[lobby] ${shooter?.name ?? '?'} destroyed ${victim.name}`);
  }

  /** Full hull, zeroed velocity, fresh position on the spawn sphere. */
  private respawn(p: Player, sessionId: string) {
    const at = randomSpawn();
    p.x = at.x; p.y = at.y; p.z = at.z;
    p.vx = 0; p.vy = 0; p.vz = 0;
    // face the middle of the field so you spawn looking at something
    const q = new Quaternion().setFromUnitVectors(LOCAL_FORWARD, at.clone().negate().normalize());
    p.qx = q.x; p.qy = q.y; p.qz = q.z; p.qw = q.w;
    const stats = applyStats(p);
    p.hull = stats.maxHull;
    p.juice = stats.juiceMax;
    p.alive = true;
    p.respawnTick = 0;
    // The client predicts its own orientation from look batches it has
    // already applied locally. A respawn moves the nose server-side, so any
    // batch still queued from before the death would be folded on top of the
    // NEW orientation and drag the camera off. Dropping the queue lets the
    // client's reconcile step snap to this quaternion instead.
    this.pendingLook.delete(sessionId);
  }

  // ------------------------------------------------------------- weapons

  /**
   * Server-authoritative fire. Aim is derived from the shooter's own input
   * stream, never from client-supplied geometry: `seq` names the last look
   * batch they had applied locally, so folding up to it reproduces exactly
   * the orientation that was in the middle of their screen. `clientTick` is
   * the world they were looking at, for weapons that lag-compensate.
   */
  private fire(sessionId: string, seq: number, clientTick: number) {
    if (this.state.phase !== 'combat') return;
    const shooter = this.state.players.get(sessionId);
    if (!shooter || !shooter.alive) return;

    const def = weaponFor(shooter.weapon);
    // selection is validated on the way in, but a weapon can also be lost
    // (never, today) — falling back beats firing something unowned
    if (def.id !== defaultWeapon && tierOf(shooter, def.id) === 0) return;

    const now = Date.now();
    const last = this.lastFireTime.get(sessionId);
    // Bots pay a cadence penalty on whatever they're holding, rather than
    // having a hardcoded bot rate — so it keeps applying if they're ever
    // given something other than the bolt cannon.
    const cooldown = def.cooldownMs(shooter) * (shooter.isBot ? BOT_FIRE_COOLDOWN_MULT : 1);
    if (last !== undefined && now - last < cooldown) return;
    this.lastFireTime.set(sessionId, now);

    // bots have no look batches; their orientation is already current
    if (!shooter.isBot) this.drainLook(shooter, sessionId, seq);

    const aim = new Quaternion(shooter.qx, shooter.qy, shooter.qz, shooter.qw);
    const dir = LOCAL_FORWARD.clone().applyQuaternion(aim).normalize();

    // Counted here rather than inside the weapon: this is the point at which
    // the trigger pull definitely became a shot (owned, off cooldown, alive),
    // and counting it anywhere else would make accuracy a function of how
    // each weapon happens to be written.
    shooter.shotsFired += 1;

    def.fire({
      ...this.worldContext({ token: `f${this.fireCounter++}`, weapon: def.id }),
      shooterId: sessionId,
      shooter,
      origin: new Vector3(shooter.x, shooter.y, shooter.z),
      dir,
      tier: Math.max(1, tierOf(shooter, def.id)),
      fuse: shooter.fuse,
      // clamp into the history window: a client that lies about its tick
      // gets the oldest rewind we still have, never a future one
      clientTick: Math.max(
        this.state.tick - HISTORY_TICKS + 1,
        Math.min(this.state.tick, clientTick || this.state.tick),
      ),
      positionsAt: (tick: number) => this.positionsAt(tick),
      spawnShot: (init) => this.spawnShot(sessionId, init),
    });
  }

  private spawnShot(
    shooterId: string,
    init: { kind: string; origin: Vector3; dir: Vector3; param?: number },
  ) {
    const shot = new Shot();
    shot.kind = init.kind;
    shot.shooter = shooterId;
    shot.ox = init.origin.x; shot.oy = init.origin.y; shot.oz = init.origin.z;
    shot.dx = init.dir.x; shot.dy = init.dir.y; shot.dz = init.dir.z;
    shot.param = init.param ?? 0;
    shot.spawnTick = this.state.tick;
    const id = `s${this.shotCounter++}`;
    this.state.shots.set(id, shot);
    return id;
  }

  private spawnBlast(pos: Vector3, radius: number, kind = 'burst') {
    const blast = new Blast();
    blast.kind = kind;
    blast.x = pos.x; blast.y = pos.y; blast.z = pos.z;
    blast.radius = radius;
    blast.spawnTick = this.state.tick;
    this.state.blasts.set(`b${this.blastCounter++}`, blast);
  }

  private positionsAt(tick: number) {
    const slot = this.history[((tick % HISTORY_TICKS) + HISTORY_TICKS) % HISTORY_TICKS];
    return slot && slot.tick === tick ? slot.positions : null;
  }

  /**
   * The half of the weapon context that both fire() and step() share.
   *
   * `source` names the shot whose damage this context will apply, and is
   * baked into the damage closure rather than added to the WeaponDef
   * interface — a weapon shouldn't have to remember to pass its own identity
   * along to get accuracy and killfeed attribution right.
   */
  private worldContext(source: DamageSource) {
    return {
      tick: this.state.tick,
      players: this.state.players as MapSchema<Player>,
      sweepShips: (opts: SweepOpts) => this.sweepShips(opts),
      sweepAsteroids: (from: Vector3, dir: Vector3, maxDist: number) =>
        this.sweepAsteroids(from, dir, maxDist),
      shipsInRadius: (center: Vector3, radius: number, exclude?: string) =>
        this.shipsInRadius(center, radius, exclude),
      damage: (victimId: string, amount: number, byId: string) =>
        this.damage(victimId, amount, byId, source),
      spawnBlast: (pos: Vector3, radius: number) => this.spawnBlast(pos, radius),
    };
  }

  private stepContext(source: DamageSource): StepContext {
    return {
      ...this.worldContext(source),
      dt: TICK_DT,
      deleteShot: (id: string) => { this.state.shots.delete(id); },
    };
  }

  /**
   * Nearest ship whose bounding sphere the segment from→from+dir·maxDist
   * enters. Segment-sphere, not a point sample: a bolt covers ~1.3 units per
   * tick, more than its own hit radius, so sampling points would tunnel
   * straight through ships.
   */
  private sweepShips(opts: SweepOpts): Hit | null {
    const r2 = opts.radius * opts.radius;
    let victim: string | null = null;
    let hitDist = opts.maxDist;
    this.state.players.forEach((p, sessionId) => {
      if (sessionId === opts.exclude || !p.alive) return;
      const center = opts.positions?.get(sessionId) ?? new Vector3(p.x, p.y, p.z);
      const toCenter = center.clone().sub(opts.from);
      let t: number;
      if (toCenter.lengthSq() <= r2) {
        t = 0; // segment starts inside the sphere: point-blank hit
      } else {
        const b = toCenter.dot(opts.dir);        // projection onto the segment
        if (b < 0) return;                       // sphere is behind this segment
        const d2 = toCenter.lengthSq() - b * b;  // perpendicular distance²
        if (d2 > r2) return;                     // flight path passes wide
        t = b - Math.sqrt(r2 - d2);              // nearest intersection
        if (t > opts.maxDist) return;            // not reached yet
      }
      if (t < hitDist) { hitDist = t; victim = sessionId; }
    });
    return victim ? { id: victim, dist: hitDist } : null;
  }

  /** Distance to the first asteroid surface along the ray, or Infinity. */
  private sweepAsteroids(from: Vector3, dir: Vector3, maxDist: number) {
    const centers = asteroidCenters(this.state.tick * TICK_DT);
    let nearest = Infinity;
    for (let i = 0; i < ASTEROID_FIELD.length; i++) {
      // scalars, not Vector3s: this runs per rock per shot per tick, and the
      // allocations were the expensive part long before the arithmetic was
      const cx = centers[i * 3] - from.x;
      const cy = centers[i * 3 + 1] - from.y;
      const cz = centers[i * 3 + 2] - from.z;
      const r = ASTEROID_FIELD[i].r;
      const r2 = r * r;
      const distSq = cx * cx + cy * cy + cz * cz;
      if (distSq <= r2) return 0; // already inside the rock
      // broad phase: the belt is 2700 units across, so most rocks are nowhere
      // near any given ray and this one compare rejects them
      const reach = maxDist + r;
      if (distSq > reach * reach) continue;
      const b = cx * dir.x + cy * dir.y + cz * dir.z;
      if (b < 0) continue;
      const d2 = distSq - b * b;
      if (d2 > r2) continue;
      const t = b - Math.sqrt(r2 - d2);
      if (t <= maxDist && t < nearest) nearest = t;
    }
    return nearest;
  }

  /** Every living ship within `radius` of a point, nearest first. */
  private shipsInRadius(center: Vector3, radius: number, exclude?: string): Hit[] {
    const hits: Hit[] = [];
    this.state.players.forEach((p, sessionId) => {
      if (sessionId === exclude || !p.alive) return;
      // surface-to-centre: a ship whose hull is clipped by the blast counts,
      // not only one whose origin point is inside it
      const dist = Math.max(0, center.distanceTo(new Vector3(p.x, p.y, p.z)) - SHIP_RADIUS);
      if (dist <= radius) hits.push({ id: sessionId, dist });
    });
    return hits.sort((a, b) => a.dist - b.dist);
  }

  // ---------------------------------------------------------------- moving

  // Effective drag this tick — Deadlock's staged bleed:
  //   just dashed → DASH_FALLOFF_DRAG x for DASH_FALLOFF_TIME, so the burst
  //                 is a burst. Thrust can still pull you back up to
  //                 maxWish against it; only the overspeed truly decays.
  //   otherwise   → ramps from the base value up to DRAG_GOVERNOR x as speed
  //                 crosses the ramp window
  // The second stage is a governor, not a cap: overspeed is allowed, it just
  // costs you. Replacing it with a hard clamp would flatten carving back
  // into scripted arcade flight. The window is a MULTIPLE of the player's own
  // maxWish, so Overdrive moves the governor up with the ship instead of
  // quietly becoming a hard ceiling at high tiers.
  private dragFor(sessionId: string, speed: number, maxWish: number) {
    const base = this.state.drag;
    if (this.dashFalloff.has(sessionId)) return base * DASH_FALLOFF_DRAG;
    const lo = DRAG_RAMP_LO_MULT * maxWish;
    const hi = DRAG_RAMP_HI_MULT * maxWish;
    const t = Math.min(1, Math.max(0, (speed - lo) / (hi - lo)));
    return base * (1 + t * (DRAG_GOVERNOR - 1));
  }

  // Source's ClipVelocity() with overbounce = 1.0: project velocity onto the
  // contact plane and leave the tangential part completely intact. Grazing a
  // rock costs you only the component you drove INTO it, so tight geometry
  // is something to carve through rather than something to avoid. Rocks are
  // spheres, so the plane normal is just the outward radial direction.
  private collideAsteroids(p: Player) {
    const centers = asteroidCenters(this.state.tick * TICK_DT);
    for (let i = 0; i < ASTEROID_FIELD.length; i++) {
      const cx = centers[i * 3];
      const cy = centers[i * 3 + 1];
      const cz = centers[i * 3 + 2];
      const surface = ASTEROID_FIELD[i].r + SHIP_RADIUS;
      // scalar broad phase before the sqrt — at 100 rocks this rejects
      // essentially all of them for the cost of three multiplies
      let nx = p.x - cx, ny = p.y - cy, nz = p.z - cz;
      const distSq = nx * nx + ny * ny + nz * nz;
      if (distSq >= surface * surface) continue;
      const dist = Math.sqrt(distSq);
      if (dist < 1e-6) continue;
      nx /= dist; ny /= dist; nz /= dist; // outward unit normal

      // lift the ship back out to the surface so it can't sink in
      p.x = cx + nx * surface;
      p.y = cy + ny * surface;
      p.z = cz + nz * surface;

      // only the inward component is removed; no bounce, no tangential loss
      const backoff = p.vx * nx + p.vy * ny + p.vz * nz;
      if (backoff < 0) {
        p.vx -= nx * backoff;
        p.vy -= ny * backoff;
        p.vz -= nz * backoff;
      }
    }
  }

  // Spend one juice charge to open a dash window. Direction is read from the
  // w/a/s/d the player was holding at the instant they hit shift — the server
  // already has that state, because the socket is ordered and the keydown
  // that set it arrived first. `seq` names the last look batch they'd applied
  // locally, same as fire(), so the dash goes where they were actually
  // pointed rather than where the last tick left them.
  private dash(sessionId: string, seq: number) {
    const p = this.state.players.get(sessionId);
    if (!p || !p.alive || p.juice < 1) return;
    const stats = statsFor(p);
    if (stats.juiceMax <= 0) return; // no Juice Capacitor, no dash
    p.juice -= 1;

    this.drainLook(p, sessionId, seq);
    const orientation = new Quaternion(p.qx, p.qy, p.qz, p.qw);

    const input = this.inputs.get(sessionId) ?? NO_INPUT;
    const dir = new Vector3()
      .addScaledVector(LOCAL_FORWARD, input.moveZ)
      // a dash sideways doesn't need lateral thrusters — the capacitor dumps
      // into whichever axis you asked for. Strafe tech gates SUSTAINED
      // sideways thrust, not one impulse.
      .addScaledVector(LOCAL_RIGHT, input.moveX);
    // no directional input = dash along the nose; normalising also means a
    // diagonal (w+a) dash is exactly as strong as a straight one, no more
    if (dir.lengthSq() === 0) dir.copy(LOCAL_FORWARD);
    dir.normalize().applyQuaternion(orientation);

    // Both clamps, applied at once. The ceiling limits where the dash is
    // willing to leave you on this axis; the impulse limits how far it may
    // move you to get there. Whichever binds first wins.
    const currentSpeed = p.vx * dir.x + p.vy * dir.y + p.vz * dir.z;
    const delta = Math.min(DASH_IMPULSE, DASH_CEIL_MULT * stats.maxWish - currentSpeed);
    if (delta > 0) {
      p.vx += dir.x * delta;
      p.vy += dir.y * delta;
      p.vz += dir.z * delta;
    }

    // re-dashing just restarts the falloff window
    this.dashFalloff.set(sessionId, DASH_FALLOFF_TIME);
  }

  // ------------------------------------------------------------ membership

  onJoin(client: Client, options: { name?: string }) {
    const player = new Player();
    player.name = (options.name || 'anonymous').slice(0, 24);
    // No tech entry for the starting gun. Ownership of `defaultWeapon` is a
    // special case everywhere it's checked (setWeapon, fire, the HUD strip),
    // so granting it a tier would be a second source of truth — and there is
    // no catalog card that could ever legitimately set one.
    applyStats(player);
    const at = randomSpawn();
    player.x = at.x; player.y = at.y; player.z = at.z;
    const q = new Quaternion().setFromUnitVectors(LOCAL_FORWARD, at.clone().negate().normalize());
    player.qx = q.x; player.qy = q.y; player.qz = q.z; player.qw = q.w;

    this.state.players.set(client.sessionId, player);
    this.clientsById.set(client.sessionId, client);
    // Joining mid-shop gets you cards for the round you're about to fight;
    // joining mid-combat drops you straight in, and you shop at the break.
    if (this.state.phase === 'shop') drawOffer(player);
    console.log(`[lobby] ${player.name} joined (${client.sessionId})`);
  }

  onLeave(client: Client) {
    const player = this.state.players.get(client.sessionId);
    console.log(`[lobby] ${player?.name} left (${client.sessionId})`);
    this.state.players.delete(client.sessionId);
    this.clientsById.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.lastFireTime.delete(client.sessionId);
    this.pendingLook.delete(client.sessionId);
    this.dashFalloff.delete(client.sessionId);
    this.lastHitToken.delete(client.sessionId);
    this.bots.forget(client.sessionId);

    // A run with nobody left in it goes back to the start rather than
    // grinding through rounds of bots for an empty room.
    if (this.humans().length === 0 && this.state.phase !== 'lobby') {
      this.state.phase = 'lobby';
      this.state.round = 0;
      this.state.phaseEndTick = 0;
      this.clearOrdnance();
      this.bots.sync(this.state.players, 0, 0, 0);
      console.log('[lobby] room empty — run reset');
    }
  }
}
