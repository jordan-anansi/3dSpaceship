import { Player } from '../schema';
import { SHIP_RADIUS } from '../tuning';
import { tierOf } from '../catalog';
import type { CatalogEntry } from '../catalog';
import type { FireContext, WeaponDef } from './types';

// The starting gun. Hitscan, slow cycle, punishing damage: every shot is a
// decision rather than a stream, and the gun is entirely aim.
//
// Nothing flies. The replicated Shot is an inert TRACER — no step(), it just
// ages out after lifeTicks — whose only job is to tell clients where to draw
// the beam. Its `param` carries the beam's true length (ship, rock, or max
// range, whichever came first) so the drawn beam stops where the shot
// actually stopped instead of punching through the target.
//
// RAIL_TRACER_LIFE_TICKS is duplicated as RAIL_TRACER_LIFE in
// public/weapon-fx.js: the client fades the beam over exactly that window, so
// if the two drift the beam either vanishes mid-fade or hangs around solid.

const RAIL_RANGE = 600;             // units — far enough that terrain, not range, is the limit
// Two shots kill a base 100 hull with headroom to spare, and exactly one tier
// of Hull Plating (130) pushes that to three. That bracket is the whole
// reason the number isn't 70: the railgun should be answerable by investing
// in hull, not by out-aiming it.
const RAIL_BASE_DAMAGE = 60;
const RAIL_BASE_COOLDOWN_MS = 1400;
const RAIL_COOLDOWN_PER_TIER = 250;
// A beam has no body of its own, so unlike the bolt's padded figure this is
// exactly the ship's bounding sphere.
const RAIL_BASE_HIT_RADIUS = SHIP_RADIUS;
const RAIL_HIT_RADIUS_PER_TIER = 0.5;
const RAIL_TRACER_LIFE_TICKS = 12;  // 0.2s — duplicated in public/weapon-fx.js

const hitRadiusOf = (player: Player) =>
  RAIL_BASE_HIT_RADIUS + RAIL_HIT_RADIUS_PER_TIER * tierOf(player, 'railBore');

const cooldownFor = (tier: number) => RAIL_BASE_COOLDOWN_MS - RAIL_COOLDOWN_PER_TIER * tier;

// No 'rail' tech card: the railgun is the STARTING gun (see weapons/index.ts
// → defaultWeapon), so there is nothing to unlock. Its tiers are therefore
// unconditional rather than gated behind `requires: 'rail'` — a requirement
// on something every player already owns would just never filter anything,
// and `available()` reads tierOf(requires) === 0, which is exactly what an
// owned-by-default weapon reports.
const cards: CatalogEntry[] = [
  {
    // Cooldown rather than damage on purpose: damage would just move the
    // shots-to-kill count, while cycle time moves what the gun IS. At 1.4s
    // it's a pure opening-shot weapon you have to disengage after; at 0.9s
    // it's a duelling gun you can actually hold an angle with.
    id: 'railCycle',
    name: 'Rail Capacitor',
    kind: 'upgrade',
    blurb: (t) => `Railgun cooldown ${cooldownFor(t - 1)}ms → ${cooldownFor(t)}ms.`,
    maxTier: 2,
    baseCost: 130,
    costMult: 1.6,
  },
  {
    // The other axis that changes the gun's role: at 600 units a 1-unit
    // target sphere is about a tenth of a degree wide, so effective range is
    // set by aim precision long before it's set by RAIL_RANGE. Widening the
    // envelope buys usable range, not raw power.
    id: 'railBore',
    name: 'Wide Bore',
    kind: 'upgrade',
    blurb: (t) => `Beam hit radius ${(RAIL_BASE_HIT_RADIUS + RAIL_HIT_RADIUS_PER_TIER * (t - 1)).toFixed(1)} → ${(RAIL_BASE_HIT_RADIUS + RAIL_HIT_RADIUS_PER_TIER * t).toFixed(1)} units. Forgives aim at long range.`,
    maxTier: 2,
    baseCost: 120,
    costMult: 1.6,
  },
];

export const railgun: WeaponDef = {
  id: 'rail',
  name: 'Railgun',
  lifeTicks: RAIL_TRACER_LIFE_TICKS,
  cards,

  damage: (_player: Player) => RAIL_BASE_DAMAGE,
  cooldownMs: (player: Player) => cooldownFor(tierOf(player, 'railCycle')),

  fire(ctx: FireContext) {
    // The one weapon that rewinds. A hitscan shot lands on the tick it's
    // fired, so the only world it can fairly resolve against is the one the
    // shooter was looking at when they pulled — otherwise every ping-worth of
    // lead has to be guessed on a weapon whose whole premise is that it
    // doesn't need leading. Travel-time weapons deliberately skip this (see
    // SweepOpts.positions): they're dodgeable by design, and rewinding on top
    // of that double-compensates into "dodged, died anyway".
    //
    // Null means clientTick fell out of the 32-tick (~0.5s) ring buffer.
    // Live positions are the honest fallback: a shooter that laggy goes back
    // to leading their shots, which is strictly better than resolving against
    // a world nobody was ever in.
    const positions = ctx.positionsAt(ctx.clientTick) ?? undefined;

    const hit = ctx.sweepShips({
      from: ctx.origin,
      dir: ctx.dir,
      maxDist: RAIL_RANGE,
      radius: hitRadiusOf(ctx.shooter),
      exclude: ctx.shooterId,
      positions,
    });
    // Rocks stop the beam, same as bolts — cover has to be real cover against
    // the gun that most wants to shoot across the whole map.
    const rockDist = ctx.sweepAsteroids(ctx.origin, ctx.dir, RAIL_RANGE);

    // Whichever is nearer terminates the beam. sweepAsteroids returns
    // Infinity when the ray is clear, so the min also handles "hit nothing".
    let beamLen = Math.min(rockDist, RAIL_RANGE);
    if (hit && hit.dist <= rockDist) {
      beamLen = hit.dist;
      ctx.damage(hit.id, railgun.damage(ctx.shooter), ctx.shooterId);
    }

    ctx.spawnShot({ kind: 'rail', origin: ctx.origin, dir: ctx.dir, param: beamLen });
  },
};
