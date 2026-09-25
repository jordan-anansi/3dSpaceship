import { ArraySchema } from '@colyseus/schema';
import { Card, Player } from './schema';
import { CatalogEntry, costOf, tierOf } from './catalog';
import { WEAPON_CARDS, defaultWeapon } from './weapons';
import {
  BASE_HULL, JUICE_MAX, JUICE_REGEN_SEC, MAX_WISH, THRUST_ACCEL, WISH_SPEED,
} from './tuning';

// Re-exported so callers have one obvious place to import shop vocabulary
// from, even though the definitions live in the leaf module.
export { costOf, tierOf } from './catalog';
export type { CatalogEntry } from './catalog';

// Ship-wide derived stats. Everything the simulation reads per-player comes
// from here rather than straight off the tuning constants, so an upgrade is
// always "add a term to statsFor" and never "find every read site".
export interface Stats {
  wishSpeed: number;
  maxWish: number;
  thrustAccel: number;
  maxHull: number;
  juiceMax: number;
  juiceRegenSec: number;
  /** 0 = no lateral thrusters at all; otherwise a fraction of forward thrust */
  strafeScale: number;
}

const SHIP_CARDS: CatalogEntry[] = [
  // --- technologies ---
  {
    id: 'juice',
    name: 'Juice Capacitor',
    kind: 'tech',
    blurb: () => 'shift dashes. One charge, refilling continuously.',
    maxTier: 1,
    baseCost: 150,
    costMult: 1,
  },
  {
    id: 'juiceCap',
    name: 'Juice Capacity',
    kind: 'upgrade',
    blurb: (t) => `${JUICE_MAX + t - 1} → ${JUICE_MAX + t} dash charges.`,
    maxTier: 2,
    baseCost: 140,
    costMult: 1.8,
    requires: 'juice',
  },
  {
    id: 'juiceRegen',
    name: 'Juice Recharge',
    kind: 'upgrade',
    blurb: (t) => `Charge refill ${(JUICE_REGEN_SEC - 1.2 * (t - 1)).toFixed(1)}s → ${(JUICE_REGEN_SEC - 1.2 * t).toFixed(1)}s.`,
    maxTier: 3,
    baseCost: 110,
    costMult: 1.6,
    requires: 'juice',
  },

  // --- ship hull & flight upgrades ---
  {
    id: 'plating',
    name: 'Hull Plating',
    kind: 'upgrade',
    blurb: (t) => `Max hull +${30 * t}.`,
    maxTier: 4,
    baseCost: 90,
    costMult: 1.6,
  },
  {
    id: 'overdrive',
    name: 'Overdrive',
    kind: 'upgrade',
    // Worth spelling out on the card: this is a cap on the projection of
    // velocity onto your input, so it raises the carving ceiling too, not
    // just the straight line.
    blurb: (t) => `Cruise speed +${6 * t} u/s. Carving ceiling rises with it.`,
    maxTier: 4,
    baseCost: 80,
    costMult: 1.6,
  },
  {
    id: 'reactor',
    name: 'Reactor',
    kind: 'upgrade',
    blurb: () => 'Thrust acceleration +24%. Reach cruise speed sooner.',
    maxTier: 3,
    baseCost: 80,
    costMult: 1.6,
  },
];

// Weapons contribute their own unlocks and tiers (see weapons.ts) so adding a
// gun is one file, not an edit here as well.
export const CATALOG: CatalogEntry[] = [...SHIP_CARDS, ...WEAPON_CARDS];

const byId = new Map(CATALOG.map((entry) => [entry.id, entry]));

export const entryFor = (id: string) => byId.get(id);

export interface BaseWorldSettings {
  maxSpeed?: number;
  thrustAccel?: number;
  baseHull?: number;
}

/** Collapse owned tiers into the numbers the simulation actually reads. */
export function statsFor(player: Player, baseSettings?: BaseWorldSettings): Stats {
  const baseSpeed = baseSettings?.maxSpeed ?? MAX_WISH;
  const baseAccel = baseSettings?.thrustAccel ?? THRUST_ACCEL;
  const baseHull = baseSettings?.baseHull ?? BASE_HULL;
  const juice = tierOf(player, 'juice');
  return {
    wishSpeed: baseSpeed,
    maxWish: baseSpeed + 6 * tierOf(player, 'overdrive'),
    thrustAccel: baseAccel + 0.06 * tierOf(player, 'reactor'),
    maxHull: baseHull + 30 * tierOf(player, 'plating'),
    juiceMax: juice ? JUICE_MAX + tierOf(player, 'juiceCap') : 0,
    juiceRegenSec: Math.max(1.5, JUICE_REGEN_SEC - 1.2 * tierOf(player, 'juiceRegen')),
    strafeScale: 1.0, // A/D thrusts at 100% full power identical to W/S
  };
}

// Push derived stats onto the replicated Player. Called after every purchase
// and on join, so `maxHull` / `juiceMax` on the wire are always current.
// Buying capacity tops you up by the amount gained rather than refilling —
// a mid-run Hull Plating shouldn't double as a free repair.
export function applyStats(player: Player, baseSettings?: BaseWorldSettings) {
  const stats = statsFor(player, baseSettings);
  if (player.godMode) {
    player.maxHull = 99999;
    player.hull = 99999;
  } else {
    const hullGain = stats.maxHull - player.maxHull;
    player.maxHull = stats.maxHull;
    player.hull = Math.min(stats.maxHull, player.hull + Math.max(0, hullGain));
  }
  const juiceGain = stats.juiceMax - player.juiceMax;
  player.juiceMax = stats.juiceMax;
  player.juice = Math.min(stats.juiceMax, player.juice + Math.max(0, juiceGain));
  // a weapon the player no longer has (or never had) must not stay selected
  if (tierOf(player, player.weapon) === 0 && player.weapon !== defaultWeapon) {
    player.weapon = defaultWeapon;
  }
  return stats;
}

function makeCard(player: Player, entry: CatalogEntry) {
  const currentTier = tierOf(player, entry.id);
  const nextTier = Math.min(entry.maxTier, currentTier + 1);
  const isLocked = Boolean(entry.requires && tierOf(player, entry.requires) === 0);
  const isMaxed = currentTier >= entry.maxTier;

  const card = new Card();
  card.id = entry.id;
  card.kind = entry.kind;
  card.name = entry.name;
  card.blurb = entry.blurb(nextTier);
  card.tier = nextTier;
  card.maxTier = entry.maxTier;
  card.cost = costOf(entry, nextTier);
  card.locked = isLocked;
  card.maxed = isMaxed;
  if (entry.requires) {
    const parent = byId.get(entry.requires);
    card.requires = parent?.name ?? entry.requires;
  }
  return card;
}

/**
 * Rebuild the standing menu with ALL catalog items in a stable, consistent order.
 * Items not yet unlocked are marked card.locked = true so the client can grey them out.
 * Maxed items are marked card.maxed = true.
 */
export function refreshUpgrades(player: Player) {
  player.upgrades = new ArraySchema<Card>(...CATALOG.map((entry) => makeCard(player, entry)));
}

// Legacy drawOffer kept for backward compatibility if needed, but unused in continuous mode.
export function drawOffer(player: Player) {
  refreshUpgrades(player);
}

/**
 * Spend scrap on an upgrade or technology.
 * Validated entirely against replicated state.
 */
export function buy(player: Player, cardId: string, baseSettings?: BaseWorldSettings): string | null {
  const entry = byId.get(cardId);
  if (!entry) return 'unknown upgrade';
  if (entry.requires && tierOf(player, entry.requires) === 0) return 'prerequisite not unlocked';
  const tier = tierOf(player, cardId) + 1;
  if (tier > entry.maxTier) return 'already maxed';
  const cost = costOf(entry, tier);
  if (player.scrap < cost) return 'not enough scrap';

  player.scrap -= cost;
  player.tech.set(cardId, tier);

  // If player just unlocked a weapon, auto-equip it
  if (WEAPON_CARDS.some((w) => w.id === cardId && w.kind === 'tech')) {
    player.weapon = cardId;
  }

  applyStats(player, baseSettings);
  refreshUpgrades(player);
  return null;
}

/** Reset tech and upgrades on death (permadeath roguelike reset) */
export function resetPlayerProgression(player: Player, baseSettings?: BaseWorldSettings) {
  player.tech.clear();
  player.weapon = defaultWeapon;
  applyStats(player, baseSettings);
  refreshUpgrades(player);
}

export function skip(player: Player) {
  player.ready = true;
}
