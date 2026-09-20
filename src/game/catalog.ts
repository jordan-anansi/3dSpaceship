import { Player } from './schema';

// Leaf module: the shape of a buyable thing, plus the two helpers everyone
// needs to read one. It deliberately imports nothing but the schema.
//
// This exists to break a require cycle. Weapons declare their own shop cards
// and read their own upgrade tiers, while upgrades.ts collects every
// weapon's cards into the catalog — so if both the type and tierOf lived in
// upgrades.ts, weapons would require upgrades and upgrades would require
// weapons. Under CommonJS that resolves fine in one load order and throws in
// the other (CATALOG spreading an undefined WEAPON_CARDS). Keeping the
// shared vocabulary down here means the dependency only ever points one way:
//   catalog  ←  weapons/*  ←  upgrades

/**
 * One buyable thing. Two flavours, and the distinction drives the whole shop:
 *   'tech'    — a capability you don't have yet. One-time unlock, maxTier 1.
 *   'upgrade' — another tier on something you already own. Repeatable.
 * Every shop offers exactly one of each (see upgrades.drawOffer), so a run is
 * always a choice between going wider and going deeper.
 */
export interface CatalogEntry {
  id: string;
  name: string;
  kind: 'tech' | 'upgrade';
  /** shown on the card. Gets the tier it would take you TO. */
  blurb: (tier: number) => string;
  maxTier: number;
  baseCost: number;
  /** cost = round(baseCost · costMult^(tier-1)) — tiers get pricier */
  costMult: number;
  /** catalog id that must already be owned before this can be offered */
  requires?: string;
}

/** Tier owned, 0 if not owned at all. */
export const tierOf = (player: Player, id: string) => player.tech.get(id) ?? 0;

export function costOf(entry: CatalogEntry, tier: number) {
  return Math.round(entry.baseCost * Math.pow(entry.costMult, tier - 1));
}
