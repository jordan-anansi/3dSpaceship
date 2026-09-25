import { Schema, MapSchema, ArraySchema, type } from '@colyseus/schema';
import { BASE_HULL, BOT_TARGET_COMBATANTS, DASH_IMPULSE, MAX_WISH, RESPAWN_DELAY_SEC, STARTING_SCRAP, THRUST_ACCEL } from './tuning';

// One offered upgrade card. Name and blurb are replicated rather than looked
// up client-side: the catalog lives in upgrades.ts (server TS), and shipping
// two short strings twice per shop is cheaper than duplicating the catalog
// into public/ and keeping the two in step.
export class Card extends Schema {
  @type('string') id: string = '';    // catalog entry id
  @type('string') kind: string = '';  // 'tech' (new unlock) | 'upgrade' (tier-up)
  @type('string') name: string = '';
  @type('string') blurb: string = '';
  @type('number') tier: number = 1;   // the tier this card would take you TO
  @type('number') maxTier: number = 1;
  @type('number') cost: number = 0;
  @type('boolean') locked: boolean = false;
  @type('boolean') maxed: boolean = false;
  @type('string') requires: string = '';
}

export class Player extends Schema {
  @type('string') name: string = '';
  // Bots share this map with humans so the client renders them through the
  // exact same path — a bot is just a Player nobody is connected to.
  @type('boolean') isBot: boolean = false;

  // position
  @type('number') x: number = 0;
  @type('number') y: number = 0;
  @type('number') z: number = 0;

  // linear velocity (world space)
  @type('number') vx: number = 0;
  @type('number') vy: number = 0;
  @type('number') vz: number = 0;

  // orientation quaternion
  @type('number') qx: number = 0;
  @type('number') qy: number = 0;
  @type('number') qz: number = 0;
  @type('number') qw: number = 1;

  // angular velocity quaternion: the rotation applied per second, in the
  // ship's local frame (identity = not spinning). Unused by the 'mouse'
  // scheme, kept for the archived keyboard schemes and the HUD's rate readout.
  @type('number') avx: number = 0;
  @type('number') avy: number = 0;
  @type('number') avz: number = 0;
  @type('number') avw: number = 1;

  // sequence number of the last look batch folded into the orientation
  // above. The client compares this against its own predicted fold to
  // reconcile ('mouse' scheme only).
  @type('number') lookSeq: number = 0;

  // --- combat ---
  @type('boolean') alive: boolean = true;
  @type('number') hull: number = BASE_HULL;
  @type('number') maxHull: number = BASE_HULL;
  // Testing mode: near-infinite hull, immune to destruction
  @type('boolean') godMode: boolean = false;
  // tick this player respawns on (0 = not waiting)
  @type('number') respawnTick: number = 0;
  // dash charges remaining, fractional so the HUD can draw the one that's
  // part-way through regenerating. 0/0 until Juice Capacitor is bought.
  @type('number') juice: number = 0;
  @type('number') juiceMax: number = 0;
  // active weapon id; always a weapon this player owns. Duplicated from
  // defaultWeapon in src/game/weapons/index.ts — this module is a leaf on
  // purpose (catalog.ts imports it, and weapons/ imports catalog.ts), so
  // importing the real constant here would close a require cycle.
  @type('string') weapon: string = 'rail';
  // Fuse distance in units, set by the mouse wheel. Only weapons that
  // detonate at a chosen range read it (the flak launcher); everything else
  // ignores it. Replicated so the HUD can show what you've dialled in.
  @type('number') fuse: number = 40;

  // --- progression ---
  @type('number') scrap: number = STARTING_SCRAP;
  // catalog id → tier owned. Absent key = not owned. Derived stats come from
  // running this map through upgrades.ts → statsFor().
  @type({ map: 'number' }) tech = new MapSchema<number>();
  // the two cards on offer this shop phase, and whether they've decided yet
  @type([Card]) offer = new ArraySchema<Card>();
  // Every tier-up currently available to this player, refreshed after each
  // purchase. The offer is the two DEALT cards — going wider, one decision,
  // take it or leave it. This is the standing menu of depth, and unlike the
  // offer it can be bought from as many times as the scrap lasts. Replicated
  // as Cards so the client renders both through the same path.
  @type([Card]) upgrades = new ArraySchema<Card>();
  @type('boolean') ready: boolean = false;

  // --- scoreboard, reset each round ---
  @type('number') kills: number = 0;
  @type('number') deaths: number = 0;
  @type('number') roundScrap: number = 0;
  @type('number') damageDealt: number = 0;
  // Trigger pulls that actually produced a shot, and how many of those shots
  // touched something. Counted per SHOT, not per damage event — one flak
  // shell catching three ships is one hit, or accuracy would read over 100%.
  @type('number') shotsFired: number = 0;
  @type('number') shotsHit: number = 0;

  // Tick the battering ram comes off cooldown (0 = ready). The other weapons'
  // cooldowns live in a server-side wall-clock map and are short enough to
  // learn by feel; the ram's is five seconds, long enough that not showing it
  // would just be withholding information the player needs to time a push.
  @type('number') ramReadyTick: number = 0;
}

// A shot in flight. Only BIRTH state is replicated — every weapon's
// trajectory is a straight line, so clients (and the server's own hit tests)
// place it analytically on the shared tick timeline:
//   origin + dir · speed · age
// No per-tick position patches: zero ongoing bandwidth, perfectly smooth.
//
// `kind` names the weapon that fired it; weapons.ts owns what the kind means,
// including how `param` is interpreted. Hitscan weapons put a one-frame
// tracer in here too — it never moves, `param` is just its length.
export class Shot extends Schema {
  @type('string') kind: string = 'bolt';
  @type('string') shooter: string = '';

  // spawn origin (the shooter's ship/eye — same point the reticle ray leaves)
  @type('number') ox: number = 0;
  @type('number') oy: number = 0;
  @type('number') oz: number = 0;

  // unit direction, from the shooter's seq-folded orientation
  @type('number') dx: number = 0;
  @type('number') dy: number = 0;
  @type('number') dz: number = 0;

  @type('number') spawnTick: number = 0;
  // kind-specific. flak: fuse distance. rail: beam length. bolt: unused.
  @type('number') param: number = 0;
}

// A detonation. Purely cosmetic replication — damage was already applied
// server-side on the tick it spawned. Clients draw an expanding shell of
// `radius` and drop it when the server deletes it.
export class Blast extends Schema {
  // 'burst' — ordnance going off, drawn at its true damage radius.
  // 'death' — a ship coming apart. Carries no damage of its own; it rides in
  //           this map purely so the death explosion inherits the existing
  //           lifetime, replication and cleanup rather than needing a fourth
  //           entity type. The client branches on this to draw debris.
  @type('string') kind: string = 'burst';
  @type('number') x: number = 0;
  @type('number') y: number = 0;
  @type('number') z: number = 0;
  @type('number') radius: number = 0;
  @type('number') spawnTick: number = 0;
  // velocity of the exploding ship at moment of destruction
  @type('number') vx: number = 0;
  @type('number') vy: number = 0;
  @type('number') vz: number = 0;
}

export class LobbyState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Shot }) shots = new MapSchema<Shot>();
  @type({ map: Blast }) blasts = new MapSchema<Blast>();

  // linear drag: fraction of velocity shed per second; in state so every
  // client sees the live value (tunable via the 'setDrag' message)
  @type('number') drag: number = 0.15;
  // simulation tick, incremented every update(). Clients echo the latest
  // tick they've seen when firing so hits can be lag-compensated against
  // the world they were actually looking at.
  @type('number') tick: number = 0;

  // --- fundamental live server & world settings ---
  @type('number') maxSpeed: number = MAX_WISH;
  @type('number') thrustAccel: number = THRUST_ACCEL;
  @type('number') dashImpulse: number = DASH_IMPULSE;
  @type('number') baseHull: number = BASE_HULL;

  // --- hot-swappable gameplay & presentation settings ---
  @type('boolean') enemyFireSounds: boolean = false;
  @type('string') reticleCoolingColor: string = '#6ec387';
  @type('string') reticleReadyColor: string = '#00ff66';
  @type('boolean') explosionInheritVelocity: boolean = true;
  @type('number') respawnDelaySec: number = RESPAWN_DELAY_SEC;
  @type('number') passiveScrapPerSecond: number = 2;

  // --- round structure ---
  // 'lobby'        — free flight, waiting for someone to press Start
  // 'shop'         — everyone picks one of two cards
  // 'combat'       — the round proper: PvP + bots, respawns on
  // 'intermission' — scoreboard, stipend paid, then back to shop
  @type('string') phase: string = 'combat';
  @type('number') round: number = 1;
  // tick the current phase ends on (0 = phase has no timer, i.e. lobby)
  @type('number') phaseEndTick: number = 0;
  // target number of combatants topped up by bots (replicated so clients stay in sync)
  @type('number') botCount: number = BOT_TARGET_COMBATANTS;
}
