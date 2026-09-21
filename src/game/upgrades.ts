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

/**
 * Rebuild the standing menu of tier-ups: every 'upgrade' entry whose
 * prerequisite is owned and which isn't maxed out yet.
 *
 * This is the half of the shop you can buy from repeatedly. It's a full list
 * rather than a draw on purpose — depth is the thing a player should be able
 * to commit scrap to deliberately ("I want the third Bolt Cadence"), and a
 * random two-card deal turns that into a slot machine. The dealt cards keep
 * the roguelite draw where it belongs: on the UNLOCKS, which are the
 * decisions that change what your ship can do rather than how well.
 *
 * Costs come straight from costOf(), so tiering something up mid-shop
 * immediately reprices the next tier — that rising cost is what stops a
 * scrap-rich player from simply buying the whole column.
 */
export function refreshUpgrades(player: Player) {
  const entries = CATALOG.filter((entry) => entry.kind === 'upgrade' && available(player, entry));
  player.upgrades = new ArraySchema<Card>(...entries.map((entry) => makeCard(player, entry)));
}

// Deal this player's dealt cards: new TECHNOLOGY only, up to two of them.
//
// Tier-ups used to share this deal, one of each. They don't any more — every
// available tier-up is permanently on offer in refreshUpgrades() above, so
// dealing one here as well would be showing the same purchase twice and
// implying the dealt copy was somehow special. What's left is the genuine
// draw: which new capabilities the run is offering you this round.
//
// A late run that has unlocked everything falls back to upgrade cards rather
// than showing an empty deal.
//
// Unaffordable cards are still dealt on purpose: banking toward a big unlock
// is a legitimate play, and hiding the expensive option would remove that
// decision.
export function drawOffer(player: Player) {
  const pools = { tech: [] as CatalogEntry[], upgrade: [] as CatalogEntry[] };
  for (const entry of CATALOG) {
    if (available(player, entry)) pools[entry.kind].push(entry);
  }

  const chosen: CatalogEntry[] = [];
  // draw a DIFFERENT entry from `pool`, or do nothing if it's dry
  const takeFrom = (pool: CatalogEntry[]) => {
    const rest = pool.filter((e) => !chosen.includes(e));
    if (rest.length) chosen.push(pick(rest));
  };
  while (chosen.length < 2) {
    const before = chosen.length;
    takeFrom(pools.tech);
    if (chosen.length === before) takeFrom(pools.upgrade);
    if (chosen.length === before) break; // both pools dry
  }

  player.offer = new ArraySchema<Card>(...chosen.map((entry) => makeCard(player, entry)));
  refreshUpgrades(player);
  // nothing left to buy anywhere = already done
  player.ready = chosen.length === 0 && player.upgrades.length === 0;
}

/**
 * Spend scrap on a dealt card or a tier-up. Returns why it failed, or null on
 * success. Validated entirely against replicated state — the client sends an
 * id, never a price.
 *
 * Buying no longer ends your shop. You can keep spending until the clock runs
 * out, you run out of scrap, or you press Done; a dealt card is consumed when
 * taken (it was one of two, and taking both would remove the choice), while
 * the tier-up list simply reprices and stays open.
 */
export function buy(player: Player, cardId: string): string | null {
  if (player.ready) return 'already locked in';
  const dealt = player.offer.findIndex((c) => c.id === cardId);
  const onMenu = player.upgrades.some((c) => c.id === cardId);
  if (dealt === -1 && !onMenu) return 'not on offer';
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
  // Taking one of the two dealt cards spends the choice: the other stays, the
  // taken one goes. Unlocking a weapon also opens ITS tier-ups, which is why
  // the menu is rebuilt rather than left alone.
  if (dealt !== -1) player.offer.splice(dealt, 1);
  refreshUpgrades(player);
  return null;
}

/** Done shopping — lock in and bank whatever's left. */
export function skip(player: Player) {
  player.ready = true;
  player.offer.clear();
  player.upgrades.clear();
}
