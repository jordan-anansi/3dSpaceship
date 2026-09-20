import type { CatalogEntry } from '../catalog';
import { bolt } from './bolt';
import { flak } from './flak';
import { railgun } from './railgun';
import type { WeaponDef } from './types';

// The weapon registry. Adding a gun is: write one file next to this one,
// export a WeaponDef, add it to DEFS. Its shop cards, cooldown, damage and
// hit resolution all come along with it — nothing else in the codebase needs
// to learn the new weapon's name.

/** Owned from the start; also the fallback whenever a selection is invalid. */
export const defaultWeapon = 'bolt';

const DEFS: WeaponDef[] = [bolt, railgun, flak];

export const WEAPONS = new Map(DEFS.map((def) => [def.id, def]));

/** Every weapon's unlocks and tiers, folded into the shop catalog. */
export const WEAPON_CARDS: CatalogEntry[] = DEFS.flatMap((def) => def.cards);

/** Never returns undefined — an unknown id falls back to the starting gun. */
export const weaponFor = (id: string) => WEAPONS.get(id) ?? bolt;

export { BOLT_SPEED } from './bolt';
export type { FireContext, Hit, StepContext, SweepOpts, WeaponDef } from './types';
