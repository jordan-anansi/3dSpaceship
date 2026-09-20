import { Vector3 } from 'three';
import { Player, Shot } from '../schema';
import { TICK_DT } from '../tuning';
import { tierOf } from '../catalog';
import type { CatalogEntry } from '../catalog';
import type { FireContext, StepContext, WeaponDef } from './types';

// The starting gun, and the reference implementation for the interface in
// ./types.ts — a travel-time projectile with a swept hit test.
//
// Only BIRTH state is replicated (origin, dir, spawnTick); flight is a
// straight line, so clients and the server both place the bolt analytically
// on the shared tick timeline as origin + dir · BOLT_SPEED · age. That means
// zero per-tick position patches and perfectly smooth motion.
//
// BOLT_SPEED and TICK_DT are duplicated in public/client.js — both sides must
// place bolts identically or clients render hits the server disagrees with.
// First-person: the camera sits AT the ship, so the bolt line IS the
// reticle's centre ray — for distant targets, at least. Bolts take travel
// time, so moving targets have to be led.
export const BOLT_SPEED = 80;       // units/s — ships cruise at 40, so dodgeable but leadable
const BOLT_LIFE_TICKS = 300;        // 5s at 60Hz ⇒ 400 units of range
const BOLT_HIT_RADIUS = 1.0;        // ship bounding sphere padded by the bolt's own size
const BOLT_BASE_DAMAGE = 34;        // three shots to kill a base 100-hull ship
const BOLT_DAMAGE_PER_TIER = 10;
const BOLT_BASE_COOLDOWN_MS = 300;
const BOLT_COOLDOWN_PER_TIER = 60;

const cards: CatalogEntry[] = [
  {
    id: 'boltCadence',
    name: 'Bolt Cadence',
    kind: 'upgrade',
    blurb: (t) => `Bolt cooldown ${BOLT_BASE_COOLDOWN_MS - BOLT_COOLDOWN_PER_TIER * (t - 1)}ms → ${BOLT_BASE_COOLDOWN_MS - BOLT_COOLDOWN_PER_TIER * t}ms.`,
    maxTier: 3,
    baseCost: 100,
    costMult: 1.6,
  },
  {
    id: 'boltDamage',
    name: 'Bolt Damage',
    kind: 'upgrade',
    blurb: (t) => `Bolt damage ${BOLT_BASE_DAMAGE + BOLT_DAMAGE_PER_TIER * (t - 1)} → ${BOLT_BASE_DAMAGE + BOLT_DAMAGE_PER_TIER * t}.`,
    maxTier: 3,
    baseCost: 100,
    costMult: 1.6,
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
