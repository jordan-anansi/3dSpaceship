import { Vector3 } from 'three';
import { Player, Shot } from '../schema';
import { SHIP_RADIUS, TICK_DT } from '../tuning';
import { tierOf } from '../catalog';
import type { CatalogEntry } from '../catalog';
import type { FireContext, StepContext, WeaponDef } from './types';

// The reference implementation for the interface in ./types.ts — a
// travel-time projectile with a swept hit test. (It used to be the starting
// gun as well; the railgun holds that slot now, and the bolt is bought.)
//
// Only BIRTH state is replicated (origin, dir, spawnTick); flight is a
// straight line, so clients and the server both place the bolt analytically
// on the shared tick timeline as origin + dir · BOLT_SPEED · age. That means
// zero per-tick position patches and perfectly smooth motion.
//
// BOLT_SPEED and TICK_DT are duplicated in public/weapon-fx.js and
// public/client.js — both sides must place bolts identically or clients render
// hits the server disagrees with. The client also solves a screen-space lead
// pip against BOLT_SPEED, BOLT_LIFE_TICKS and BOLT_HIT_RADIUS (see the "bolt
// lead pip" section of client.js), so retuning any of the three without
// following it there leaves the HUD marking hits this file won't award.
// First-person: the camera sits AT the ship, so the bolt line IS the
// reticle's centre ray — for distant targets, at least. Bolts take travel
// time, so moving targets have to be led.
// Doubled with cruise speed. A bolt has to stay meaningfully faster than the
// ships it's shot at: at 80 against a target also doing 80, a crossing target
// simply cannot be led — there is no firing solution at any angle.
export const BOLT_SPEED = 160;      // units/s — ships cruise at 80, so dodgeable but leadable
// Halved to hold the range at 400 units. Range is the bolt's role boundary
// against the railgun's 600; letting it ride up to 800 with the new speed
// would have made the short-range repeater outrange the sniper.
const BOLT_LIFE_TICKS = 150;        // 2.5s at 60Hz ⇒ 400 units of range
// Ship bounding sphere padded by the bolt's own body. Derived, not a literal:
// SHIP_RADIUS is the one knob for how big a target is, and a hardcoded figure
// here would quietly stop tracking it the first time it moves.
const BOLT_HIT_RADIUS = SHIP_RADIUS + 0.4;
const BOLT_BASE_DAMAGE = 34;        // three shots to kill a base 100-hull ship
const BOLT_DAMAGE_PER_TIER = 10;
const BOLT_BASE_COOLDOWN_MS = 300;
const BOLT_COOLDOWN_PER_TIER = 60;

const cards: CatalogEntry[] = [
  {
    // The bolt used to be owned from the start; the railgun took that slot, so
    // it needs its own unlock. Priced UNDER the flak's 200 because it's the
    // sidegrade you buy to answer the railgun's weakness — nothing to shoot at
    // range — rather than a new capability. Its tiers gate behind it, which
    // they never had to when every player already had the gun.
    id: 'bolt',
    name: 'Bolt Cannon',
    kind: 'tech',
    blurb: () => `Rapid travel-time repeater. ${BOLT_BASE_DAMAGE} damage a shot, ${BOLT_BASE_COOLDOWN_MS}ms between them — the close-range answer to a slow beam.`,
    maxTier: 1,
    baseCost: 150,
    costMult: 1,
  },
  {
    id: 'boltCadence',
    name: 'Bolt Cadence',
    kind: 'upgrade',
    blurb: (t) => `Bolt cooldown ${BOLT_BASE_COOLDOWN_MS - BOLT_COOLDOWN_PER_TIER * (t - 1)}ms → ${BOLT_BASE_COOLDOWN_MS - BOLT_COOLDOWN_PER_TIER * t}ms.`,
    maxTier: 3,
    baseCost: 100,
    costMult: 1.6,
    requires: 'bolt',
  },
  {
    id: 'boltDamage',
    name: 'Bolt Damage',
    kind: 'upgrade',
    blurb: (t) => `Bolt damage ${BOLT_BASE_DAMAGE + BOLT_DAMAGE_PER_TIER * (t - 1)} → ${BOLT_BASE_DAMAGE + BOLT_DAMAGE_PER_TIER * t}.`,
    maxTier: 3,
    baseCost: 100,
    costMult: 1.6,
    requires: 'bolt',
  },
];

export const bolt: WeaponDef = {
  id: 'bolt',
  name: 'Bolt Cannon',
  lifeTicks: BOLT_LIFE_TICKS,
  cards,

  damage: (player: Player) => BOLT_BASE_DAMAGE + BOLT_DAMAGE_PER_TIER * tierOf(player, 'boltDamage'),
  cooldownMs: (player: Player) =>
    BOLT_BASE_COOLDOWN_MS - BOLT_COOLDOWN_PER_TIER * tierOf(player, 'boltCadence'),

  fire(ctx: FireContext) {
    ctx.spawnShot({ kind: 'bolt', origin: ctx.origin, dir: ctx.dir });
  },

  // Swept hit test along THIS tick's flight segment. It has to be a segment
  // test, not a point sample: a bolt covers ~1.3 units per tick, more than
  // its own hit radius, so point sampling would tunnel straight through ships.
  step(shot: Shot, id: string, ctx: StepContext) {
    const age = ctx.tick - shot.spawnTick;
    if (age <= 0) return;

    const dir = new Vector3(shot.dx, shot.dy, shot.dz);
    const segStart = new Vector3(shot.ox, shot.oy, shot.oz)
      .addScaledVector(dir, BOLT_SPEED * (age - 1) * TICK_DT);
    const segLen = BOLT_SPEED * TICK_DT;

    const hit = ctx.sweepShips({
      from: segStart, dir, maxDist: segLen, radius: BOLT_HIT_RADIUS, exclude: shot.shooter,
    });
    // rocks stop bolts, so cover is real cover
    const rockDist = ctx.sweepAsteroids(segStart, dir, segLen);

    if (hit && hit.dist <= rockDist) {
      const shooter = ctx.players.get(shot.shooter);
      ctx.damage(hit.id, shooter ? bolt.damage(shooter) : BOLT_BASE_DAMAGE, shot.shooter);
      ctx.deleteShot(id);
    } else if (rockDist < segLen) {
      ctx.deleteShot(id);
    }
  },
};
