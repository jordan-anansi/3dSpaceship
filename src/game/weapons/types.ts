import { MapSchema } from '@colyseus/schema';
import { Vector3 } from 'three';
import { Player, Shot } from '../schema';
import type { CatalogEntry } from '../catalog';

// The seam between LobbyRoom (which owns state, ticks and position history)
// and the individual weapons (which own behaviour). A weapon never reaches
// into room state directly: everything it can do is a method on one of these
// contexts, so adding a gun can't quietly break the simulation.

export interface SweepOpts {
  /** start of the swept segment */
  from: Vector3;
  /** unit direction */
  dir: Vector3;
  /** how far along `dir` to test */
  maxDist: number;
  /** target sphere radius: the ship's bounding sphere padded by the shot's own size */
  radius: number;
  /** session id to skip — normally the shooter, so you can't shoot yourself */
  exclude?: string;
  /**
   * Rewound positions to test against instead of live ones. Hitscan should
   * pass these (see FireContext.positionsAt); travel-time weapons should not
   * — they're dodgeable by design, and rewinding on top of that
   * double-compensates into "dodged, died anyway".
   *
   * The map does not have to be complete: a ship missing from it (joined
   * after that tick was recorded, say) is tested against its LIVE position
   * rather than skipped. Rewinding is a fairness adjustment, so the failure
   * mode has to be "slightly less compensated", never "invulnerable".
   */
  positions?: Map<string, Vector3>;
}

export interface Hit {
  id: string;
  /**
   * What "distance" means depends on which call produced this:
   *   sweepShips    — distance from `from` along `dir` to the impact point.
   *   shipsInRadius — centre-to-centre distance from the blast point, less
   *                   the ship's own radius, floored at 0. A ship whose hull
   *                   is clipped by the blast reports 0, not a negative.
   */
  dist: number;
}

/** Everything both contexts share: the world, and the ways to touch it. */
interface WorldContext {
  tick: number;
  players: MapSchema<Player>;

  /** Nearest ship whose bounding sphere the segment enters, or null. */
  sweepShips(opts: SweepOpts): Hit | null;
  /** Distance to the first asteroid surface along the ray, or Infinity. */
  sweepAsteroids(from: Vector3, dir: Vector3, maxDist: number): number;
  /** Every living ship within `radius` of a point, nearest first. */
  shipsInRadius(center: Vector3, radius: number, exclude?: string): Hit[];

  /**
   * Apply damage and credit it. Handles scrap payout, death, the kill
   * counter and scheduling the respawn — weapons never do any of that
   * themselves. Damage to a dead or already-destroyed ship is ignored.
   */
  damage(victimId: string, amount: number, byId: string): void;

  /** Spawn a cosmetic detonation clients can draw. No damage of its own. */
  spawnBlast(pos: Vector3, radius: number): void;
}

export interface FireContext extends WorldContext {
  shooterId: string;
  shooter: Player;
  /** muzzle — the ship's position, which is also where the reticle ray starts */
  origin: Vector3;
  /** unit aim direction, already folded up to the shooter's stated look seq */
  dir: Vector3;
  /**
   * This weapon's own unlock tier. Mostly vestigial: by convention a
   * weapon's stats live in its own upgrade cards, read off the Player with
   * tierOf(player, 'yourCardId'), so an unlock is maxTier 1 and this is
   * always 1. Kept for a weapon that genuinely wants tiered unlocks.
   */
  tier: number;
  /** the tick the shooter says they were looking at, clamped to the history window */
  clientTick: number;
  /**
   * The shooter's dialled-in fuse distance in units (mouse wheel). Only
   * meaningful to weapons that detonate at a chosen range; clamp it to your
   * own sensible min/max rather than trusting it. Others ignore it.
   */
  fuse: number;

  /**
   * Rewound positions for a past tick, for hitscan lag compensation.
   * Null if that tick has aged out of the ring buffer.
   */
  positionsAt(tick: number): Map<string, Vector3> | null;

  /** Put a shot into replicated state. `param` is yours to interpret. */
  spawnShot(init: { kind: string; origin: Vector3; dir: Vector3; param?: number }): string;
}

export interface StepContext extends WorldContext {
  /** seconds this tick covers */
  dt: number;
  /** remove the shot from replicated state (clients flash on removal) */
  deleteShot(id: string): void;
}

export interface WeaponDef {
  id: string;
  name: string;
  /**
   * Shots per trigger pull are up to fire(); this is the gate between pulls.
   * Takes the whole Player because a weapon's stats usually live in ITS OWN
   * upgrade cards (e.g. 'boltCadence'), not in the weapon's unlock tier —
   * read them with tierOf(player, 'yourCardId').
   */
  cooldownMs(player: Player): number;
  /** a shot of this kind is force-expired after this many ticks */
  lifeTicks: number;
  /** damage per hit, for the HUD. fire()/step() remain the source of truth. */
  damage(player: Player): number;
  /** pull the trigger. Aim, cooldown and ownership are already validated. */
  fire(ctx: FireContext): void;
  /**
   * Advance one in-flight shot of this kind by a tick, and resolve whatever
   * it hits. Omit entirely for hitscan weapons whose shots are inert tracers.
   */
  step?(shot: Shot, id: string, ctx: StepContext): void;
  /** this weapon's unlock and tier cards, folded into the shop catalog */
  cards: CatalogEntry[];
}
