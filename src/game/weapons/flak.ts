import { Vector3 } from 'three';
import { Player, Shot } from '../schema';
import { SHIP_RADIUS, TICK_DT } from '../tuning';
import { tierOf } from '../catalog';
import type { CatalogEntry } from '../catalog';
import type { StepContext, FireContext, WeaponDef } from './types';

// Area denial. A slow shell that bursts at a distance the PLAYER dials in
// with the wheel, so the skill is estimating range rather than tracking a
// target — the shell doesn't have to touch anything to hurt.
//
// Flight is analytic like the bolt's (origin + dir · FLAK_SPEED · age); the
// only extra replicated state is the fuse distance, in `param`.
//
// FLAK_SPEED is duplicated in public/weapon-fx.js. It matters more here than
// for any other weapon: the player judges the fuse off where they can SEE the
// shell, so a client drawing it at a different speed would be aiming a
// different gun from the one the server is simulating.
export const FLAK_SPEED = 110;      // units/s — slower than the bolt's 160; it's placed, not aimed

// Backstop only. Max fuse (200) at 110 units/s is ~109 ticks, so the fuse
// always fires first and a shell can never expire as a silent dud. The
// margin got WIDER when speeds doubled — the shell reaches any given fuse
// distance in half the ticks — so this stays where it is.
const FLAK_LIFE_TICKS = 200;
// ship bounding sphere padded by the shell's own body — derived so it tracks
// SHIP_RADIUS rather than drifting away from it
const FLAK_HIT_RADIUS = SHIP_RADIUS + 0.6;
// At the centre of the burst — and above BASE_HULL on purpose, so a shell you
// placed right is a kill rather than a setup. The falloff is what keeps this
// from being a free win: the plateau is only 30% of the radius, and a ship
// out at the rim still takes a third of this. Hull Plating remains the answer
// — one tier (130) already survives a dead-centre burst.
const FLAK_CORE_DAMAGE = 120;
const FLAK_BASE_BLAST_RADIUS = 9;   // units — a ship is 1, so this is a real volume to place
const FLAK_BLAST_RADIUS_PER_TIER = 2;
// Damage at the rim, as a fraction of core. Falloff is what makes placement
// matter: without it the whole sphere is a free hit and the fuse stops being
// a decision.
const FLAK_BASE_RIM_FRACTION = 1 / 3;
const FLAK_RIM_FRACTION_PER_TIER = 1 / 6;
// Inner share of the radius that takes UNREDUCED damage. Distances here are
// centre-to-centre, and a ship is a whole unit wide, so without a plateau a
// dead-on burst would already be shaving damage off just for being slightly
// off the ship's origin point. A direct hit should read as a direct hit.
const FLAK_CORE_FRACTION = 0.3;
// The wheel is client-driven, so these are a clamp, not a contract. Below the
// minimum the shell bursts inside your own flight path (harmless, but it
// reads as a misfire); above the maximum it stops being a ranged guess and
// turns into a slow cross-map bolt.
const FLAK_FUSE_MIN = 15;
const FLAK_FUSE_MAX = 150;
const FLAK_FUSE_FALLBACK = 40;      // matches Player.fuse's schema default
const FLAK_BASE_COOLDOWN_MS = 900;

const blastRadiusOf = (player: Player) =>
  FLAK_BASE_BLAST_RADIUS + FLAK_BLAST_RADIUS_PER_TIER * tierOf(player, 'flakBurst');

const rimFractionOf = (player: Player) =>
  Math.min(1, FLAK_BASE_RIM_FRACTION + FLAK_RIM_FRACTION_PER_TIER * tierOf(player, 'flakShrapnel'));

const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;

const cards: CatalogEntry[] = [
  {
    id: 'flak',
    name: 'Flak Launcher',
    kind: 'tech',
    blurb: () => `Shell bursts at a distance you dial with the wheel. ${FLAK_CORE_DAMAGE} damage at the core, ${FLAK_BASE_BLAST_RADIUS} unit radius.`,
    maxTier: 1,
    baseCost: 200,
    costMult: 1,
  },
  {
    // Radius over damage: a bigger sphere changes how precisely you have to
    // read range, which is the weapon's actual skill. More core damage would
    // only reward the bursts you were already placing well.
    id: 'flakBurst',
    name: 'Burst Radius',
    kind: 'upgrade',
    blurb: (t) => `Blast radius ${FLAK_BASE_BLAST_RADIUS + FLAK_BLAST_RADIUS_PER_TIER * (t - 1)} → ${FLAK_BASE_BLAST_RADIUS + FLAK_BLAST_RADIUS_PER_TIER * t} units.`,
    maxTier: 2,
    baseCost: 120,
    costMult: 1.6,
    requires: 'flak',
  },
  {
    // The falloff CURVE, not the peak. This is the "near enough" upgrade:
    // core damage is untouched, but a burst you misjudged by a few units
    // stops being a tickle. Flattening the curve is a different weapon;
    // raising the peak is the same weapon with a bigger number.
    id: 'flakShrapnel',
    name: 'Dense Shrapnel',
    kind: 'upgrade',
    blurb: (t) => `Damage at the rim ${pct(FLAK_BASE_RIM_FRACTION + FLAK_RIM_FRACTION_PER_TIER * (t - 1))} → ${pct(FLAK_BASE_RIM_FRACTION + FLAK_RIM_FRACTION_PER_TIER * t)} of core.`,
    maxTier: 2,
    baseCost: 110,
    costMult: 1.6,
    requires: 'flak',
  },
];

/** Burst at `at`: the cosmetic shell, the falloff damage, then the shot dies. */
function detonate(ctx: StepContext, shot: Shot, id: string, at: Vector3) {
  // The shooter can leave (or die) mid-flight; the shell is already committed,
  // so fall back to base numbers rather than dropping the burst.
  const shooter = ctx.players.get(shot.shooter);
  const radius = shooter ? blastRadiusOf(shooter) : FLAK_BASE_BLAST_RADIUS;
  const rim = shooter ? rimFractionOf(shooter) : FLAK_BASE_RIM_FRACTION;

  // Drawn at the TRUE damage radius, so players learn the real size of the
  // sphere they're placing instead of a decorative one.
  ctx.spawnBlast(at, radius);

  // No self-damage: the fuse can legitimately be dialled to 15 units, well
  // inside your own blast, and a weapon that punishes you for using its own
  // minimum setting is a trap rather than a risk.
  const core = FLAK_CORE_FRACTION * radius;
  for (const victim of ctx.shipsInRadius(at, radius, shot.shooter)) {
    // dist is centre-to-centre: full damage inside the core plateau, then
    // linear down to `rim` at the edge. Clamped both ends so a ship straddling
    // the boundary can never read as negative or over-full falloff.
    const t = Math.min(1, Math.max(0, (victim.dist - core) / (radius - core)));
    ctx.damage(victim.id, FLAK_CORE_DAMAGE * (1 - (1 - rim) * t), shot.shooter);
  }

  ctx.deleteShot(id);
}

export const flak: WeaponDef = {
  id: 'flak',
  name: 'Flak Launcher',
  lifeTicks: FLAK_LIFE_TICKS,
  cards,

  // Core damage — the HUD number. What a target actually takes depends on
  // where it was standing (see detonate).
  damage: (_player: Player) => FLAK_CORE_DAMAGE,
  cooldownMs: (_player: Player) => FLAK_BASE_COOLDOWN_MS,

  fire(ctx: FireContext) {
    // Clamp rather than trust: ctx.fuse comes off the wheel, i.e. off the
    // client. Number.isFinite also catches a NaN, which Math.min/max would
    // happily carry straight through into the shot's param.
    const fuse = Number.isFinite(ctx.fuse)
      ? Math.min(FLAK_FUSE_MAX, Math.max(FLAK_FUSE_MIN, ctx.fuse))
      : FLAK_FUSE_FALLBACK;
    ctx.spawnShot({ kind: 'flak', origin: ctx.origin, dir: ctx.dir, param: fuse });
  },

  step(shot: Shot, id: string, ctx: StepContext) {
    const age = ctx.tick - shot.spawnTick;
    if (age <= 0) return;

    const dir = new Vector3(shot.dx, shot.dy, shot.dz);
    const flown = FLAK_SPEED * (age - 1) * TICK_DT; // distance at the START of this tick
    const segStart = new Vector3(shot.ox, shot.oy, shot.oz).addScaledVector(dir, flown);

    // Never test past the fuse point. The shell has already burst by then, so
    // a segment that overshot it could hand a direct hit to a ship sitting
    // BEYOND the burst — one that was never in the shell's path at all.
    const stepLen = FLAK_SPEED * TICK_DT;
    const toFuse = Math.max(0, shot.param - flown);
    const segLen = Math.min(stepLen, toFuse);

    // Swept, like the bolt. The shell only covers ~0.9 units a tick, less than
    // its hit radius, but a target closing head-on at cruise speed adds its
    // own 0.67 on top — the gap between samples exceeds the radius in exactly
    // the head-on case where a point sample must not tunnel.
    const hit = ctx.sweepShips({
      from: segStart, dir, maxDist: segLen, radius: FLAK_HIT_RADIUS, exclude: shot.shooter,
    });
    const rockDist = ctx.sweepAsteroids(segStart, dir, segLen);

    // Contact beats the fuse. A shell that sailed through a hull because the
    // fuse happened to be dialled long would read as a broken weapon, not as
    // a missed estimate.
    let popDist: number;
    if (hit && hit.dist <= rockDist) popDist = hit.dist;
    else if (rockDist < segLen) popDist = rockDist;
    else if (toFuse <= stepLen) popDist = toFuse; // fuse burns out inside this tick
    else return;

    detonate(ctx, shot, id, segStart.clone().addScaledVector(dir, popDist));
  },
};
