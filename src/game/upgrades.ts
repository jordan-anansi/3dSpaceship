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
    id: 'lateral',
    name: 'Lateral Thrusters',
    kind: 'tech',
    blurb: () => 'a/d strafe. Sideways thrust at 55% of forward power.',
    maxTier: 1,
    baseCost: 120,
    costMult: 1,
  },
  {
    id: 'juice',
    name: 'Juice Capacitor',
    kind: 'tech',
    blurb: () => 'shift dashes. One charge, refilling continuously.',
    maxTier: 1,
    baseCost: 150,
    costMult: 1,
  },

  // --- upgrades ---
  {
    id: 'overdrive',
    name: 'Overdrive',
    kind: 'upgrade',
    // Worth spelling out on the card: this is a cap on the projection of
    // velocity onto your input, so it raises the carving ceiling too, not
    // just the straight line.
    blurb: (t) => `Cruise speed ${MAX_WISH + 6 * (t - 1)} → ${MAX_WISH + 6 * t}. Carving ceiling rises with it.`,
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
  {
    id: 'plating',
    name: 'Hull Plating',
    kind: 'upgrade',
    blurb: (t) => `Max hull ${BASE_HULL + 30 * (t - 1)} → ${BASE_HULL + 30 * t}.`,
    maxTier: 4,
    baseCost: 90,
    costMult: 1.6,
  },
  {
    id: 'lateralPower',
    name: 'Lateral Power',
    kind: 'upgrade',
    blurb: (t) => `Strafe thrust ${Math.round((0.55 + 0.225 * (t - 1)) * 100)}% → ${Math.round((0.55 + 0.225 * t) * 100)}% of forward.`,
    maxTier: 2,
    baseCost: 120,
    costMult: 1.5,
    requires: 'lateral',
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
];

// Weapons contribute their own unlocks and tiers (see weapons.ts) so adding a
// gun is one file, not an edit here as well.
export const CATALOG: CatalogEntry[] = [...SHIP_CARDS, ...WEAPON_CARDS];

const byId = new Map(CATALOG.map((entry) => [entry.id, entry]));

export const entryFor = (id: string) => byId.get(id);

/** Collapse owned tiers into the numbers the simulation actually reads. */
export function statsFor(player: Player): Stats {
  const lateral = tierOf(player, 'lateral');
  const juice = tierOf(player, 'juice');
  return {
    wishSpeed: WISH_SPEED,
    maxWish: MAX_WISH + 6 * tierOf(player, 'overdrive'),
    thrustAccel: THRUST_ACCEL + 0.06 * tierOf(player, 'reactor'),
    maxHull: BASE_HULL + 30 * tierOf(player, 'plating'),
    juiceMax: juice ? JUICE_MAX + tierOf(player, 'juiceCap') : 0,
    juiceRegenSec: Math.max(1.5, JUICE_REGEN_SEC - 1.2 * tierOf(player, 'juiceRegen')),
    strafeScale: lateral ? Math.min(1, 0.55 + 0.225 * tierOf(player, 'lateralPower')) : 0,
  };
}

// Push derived stats onto the replicated Player. Called after every purchase
// and on join, so `maxHull` / `juiceMax` on the wire are always current.
// Buying capacity tops you up by the amount gained rather than refilling —
// a mid-run Hull Plating shouldn't double as a free repair.
export function applyStats(player: Player) {
  const stats = statsFor(player);
  const hullGain = stats.maxHull - player.maxHull;
  player.maxHull = stats.maxHull;
  player.hull = Math.min(stats.maxHull, player.hull + Math.max(0, hullGain));
  const juiceGain = stats.juiceMax - player.juiceMax;
  player.juiceMax = stats.juiceMax;
  player.juice = Math.min(stats.juiceMax, player.juice + Math.max(0, juiceGain));
  // a weapon the player no longer has (or never had) must not stay selected
  if (tierOf(player, player.weapon) === 0 && player.weapon !== defaultWeapon) {
    player.weapon = defaultWeapon;
  }
  return stats;
}

const available = (player: Player, entry: CatalogEntry) => {
  if (entry.requires && tierOf(player, entry.requires) === 0) return false;
  return tierOf(player, entry.id) < entry.maxTier;
};

function makeCard(player: Player, entry: CatalogEntry) {
  const tier = tierOf(player, entry.id) + 1;
  const card = new Card();
  card.id = entry.id;
  card.kind = entry.kind;
  card.name = entry.name;
  card.blurb = entry.blurb(tier);
  card.tier = tier;
  card.maxTier = entry.maxTier;
  card.cost = costOf(entry, tier);
  return card;
}

const pick = <T>(pool: T[]) => pool[Math.floor(Math.random() * pool.length)];

// Deal this player's two cards.
//
// The intended shape is one new technology beside one tier-up on something
// they already own — going wider vs. going deeper. When a pool is empty
// (round 1 owns nothing upgradeable; a late run may have unlocked
// everything) we fall back to two from whichever pool still has entries,
// rather than showing a single card.
//
// Unaffordable cards are still dealt on purpose: skipping to bank toward a
// big unlock is a legitimate play, and hiding the expensive option would
// remove that decision.
export function drawOffer(player: Player) {
  const pools = { tech: [] as CatalogEntry[], upgrade: [] as CatalogEntry[] };
  for (const entry of CATALOG) {
    if (available(player, entry)) pools[entry.kind].push(entry);
  }

  const chosen: CatalogEntry[] = [];
  if (pools.tech.length) chosen.push(pick(pools.tech));
  if (pools.upgrade.length) chosen.push(pick(pools.upgrade));
  // top up from whichever pool can still supply a DIFFERENT entry
  while (chosen.length < 2) {
    const rest = [...pools.tech, ...pools.upgrade].filter((e) => !chosen.includes(e));
    if (!rest.length) break;
    chosen.push(pick(rest));
  }

  player.offer = new ArraySchema<Card>(...chosen.map((entry) => makeCard(player, entry)));
  player.ready = chosen.length === 0; // nothing left to buy = already done
}

/**
 * Spend scrap on one of the two offered cards. Returns why it failed, or null
 * on success. Validated entirely against replicated state — the client sends
 * an id, never a price.
 */
export function buy(player: Player, cardId: string): string | null {
  const card = player.offer.find((c) => c.id === cardId);
  if (!card) return 'not on offer';
  if (player.ready) return 'already decided';
  const entry = byId.get(cardId);
  if (!entry) return 'unknown upgrade';
  // re-derive rather than trusting card.cost, which is only a display copy
  const tier = tierOf(player, cardId) + 1;
  if (tier > entry.maxTier) return 'already maxed';
  const cost = costOf(entry, tier);
  if (player.scrap < cost) return 'not enough scrap';

  player.scrap -= cost;
  player.tech.set(cardId, tier);
  applyStats(player);
  player.ready = true;
  player.offer.clear();
  return null;
}

/** Decline both cards and keep the scrap. */
export function skip(player: Player) {
  player.ready = true;
  player.offer.clear();
}
