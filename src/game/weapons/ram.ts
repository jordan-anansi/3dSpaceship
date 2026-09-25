import { Quaternion, Vector3 } from 'three';
import { Player, Shot } from '../schema';
import { LOCAL_FORWARD, TICK_DT } from '../tuning';
import { tierOf } from '../catalog';
import type { CatalogEntry } from '../catalog';
import type { FireContext, StepContext, WeaponDef } from './types';

// The battering ram. A weapon in the sense that you select it and pull the
// trigger, but it fires nothing: it slams a shock dome out of the bow and
// holds it there for a second, and anything caught inside dies outright.
//
// Why a weapon rather than a third ability key: the ram has to COST something
// or "press it on every approach" is the only correct play. Putting it on the
// weapon wheel means holding it is holding an empty gun — the whole time it's
// selected you cannot shoot — and the shared refire gate in LobbyRoom.fire()
// means using it locks every other gun for the full five seconds too. That
// pair is the entire balance: it's a commitment, and you pay for it whether
// or not it connects.
//
// Unlike every other shot in the game, this one is NOT placed analytically on
// the tick timeline — it's welded to the ship and moves with it. So the
// replicated Shot carries only the radius in `param`, and both the server's
// hit test and the client's mesh read the shooter's LIVE transform each frame.
// (public/weapon-fx.js marks this with `attach: true`.)

export const RAM_DURATION_TICKS = 60;      // 1s of live dome
export const RAM_COOLDOWN_MS = 5000;
const RAM_COOLDOWN_TICKS = Math.round(RAM_COOLDOWN_MS / 1000 / TICK_DT);
export const RAM_BASE_RADIUS = 18;         // units — a ship is ~2, so this is a room
const RAM_RADIUS_PER_TIER = 6;
// Not a damage number so much as a statement. Clamped to the victim's hull
// inside LobbyRoom.damage(), so it can't inflate scrap payouts or the damage
// column on the scoreboard.
const RAM_KILL_DAMAGE = 9999;

const radiusOf = (player: Player) =>
  RAM_BASE_RADIUS + RAM_RADIUS_PER_TIER * tierOf(player, 'ramField');

const cards: CatalogEntry[] = [
  {
    id: 'ram',
    name: 'Battering Ram',
    kind: 'tech',
    blurb: () => `Slam a ${RAM_BASE_RADIUS}-unit shock dome out of your bow for one second. Anything caught inside it is destroyed. Fires nothing, and locks every gun for ${RAM_COOLDOWN_MS / 1000}s.`,
    maxTier: 1,
    // The most expensive unlock in the shop. It's the only thing in the game
    // that ignores hull entirely, so a Hull Plating stack is no answer to it —
    // the price is where that gets paid for.
    baseCost: 300,
    costMult: 1,
  },
  {
    // Radius, not duration or cooldown. Radius changes how precisely you have
    // to close, which is the skill the weapon actually asks for; a longer
    // window or a shorter lockout would just let you press it more often.
    id: 'ramField',
    name: 'Field Amplifier',
    kind: 'upgrade',
    blurb: (t) => `Dome radius ${RAM_BASE_RADIUS + RAM_RADIUS_PER_TIER * (t - 1)} → ${RAM_BASE_RADIUS + RAM_RADIUS_PER_TIER * t} units.`,
    maxTier: 2,
    baseCost: 160,
    costMult: 1.7,
    requires: 'ram',
  },
];

export const ram: WeaponDef = {
  id: 'ram',
  name: 'Battering Ram',
  lifeTicks: RAM_DURATION_TICKS,
  cards,

  damage: (_player: Player) => RAM_KILL_DAMAGE,
  cooldownMs: (_player: Player) => RAM_COOLDOWN_MS,

  fire(ctx: FireContext) {
    // The shared refire gate in LobbyRoom already enforces the cooldown; this
    // is only the replicated copy the HUD draws its wedge from, and it's set
    // here rather than in the room so the room needs to know nothing about
    // which weapon happens to have a readout.
    ctx.shooter.ramReadyTick = ctx.tick + RAM_COOLDOWN_TICKS;
    ctx.spawnShot({
      kind: 'ram',
      origin: ctx.origin,
      dir: ctx.dir,
      param: radiusOf(ctx.shooter),
    });
  },

  step(shot: Shot, id: string, ctx: StepContext) {
    const shooter = ctx.players.get(shot.shooter);
    // Leaving drops the dome. If the ship was destroyed, the active field
    // continues its normal lifespan riding the drifting wreck.
    if (!shooter) {
      ctx.deleteShot(id);
      return;
    }

    const center = new Vector3(shooter.x, shooter.y, shooter.z);
    const forward = LOCAL_FORWARD.clone()
      .applyQuaternion(new Quaternion(shooter.qx, shooter.qy, shooter.qz, shooter.qw));
    const radius = shot.param;

    for (const victim of ctx.shipsInRadius(center, radius, shot.shooter)) {
      const target = ctx.players.get(victim.id);
      if (!target) continue;
      // Front hemisphere only — it's a dome off the bow, not a bubble. Tested
      // centre-to-centre against the nose direction, so a ship exactly
      // abeam counts as in front rather than falling into a seam.
      const toward = new Vector3(target.x - center.x, target.y - center.y, target.z - center.z);
      if (toward.lengthSq() > 1e-6 && toward.normalize().dot(forward) < 0) continue;
      ctx.damage(victim.id, RAM_KILL_DAMAGE, shot.shooter);
    }
  },
};
