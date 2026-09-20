// Every tuning number the simulation reads, in one place.
//
// The movement block is lifted from Source's Accelerate()/Friction() pair and
// the comments explaining WHY each knob exists are load-bearing — they're the
// difference between tuning this model and accidentally replacing it with a
// speed cap. Read them before changing a value.
//
// Values here are BASE values. Upgrades scale them per-player (see
// upgrades.ts → statsFor), so nothing in the simulation should read these
// directly for a player that has a Stats object.

import { Quaternion, Vector3 } from 'three';

// --- movement: Source's Accelerate()/Friction() pair, lifted into 3D ---
//
// Thrust never rotates the velocity vector; it only ever ADDS along wishDir.
// Momentum is preserved by default, so drift, overshoot and carving are
// emergent rather than scripted.
//
// Two independent knobs, mirroring Source's Accelerate/AirAccelerate split:
//   WISH_SPEED — how hard you push. Feeds accelSpeed, i.e. the rate.
//   MAX_WISH   — how much you can REDIRECT: a cap on velocity's PROJECTION
//                onto wishDir, never on its magnitude. Lower = heavy and
//                committed; higher = twitchy. This one number is most of the
//                handling model.
// Speed perpendicular to your input is invisible to MAX_WISH, so turning is
// how you gain speed: straight-line flight settles at MAX_WISH, but a carved
// turn keeps the old component and adds a fresh one on a new axis.
export const WISH_SPEED = 40;     // units/s requested at full deflection
export const MAX_WISH = 40;       // units/s cap on the along-wishDir projection
export const THRUST_ACCEL = 0.25; // Source-style: accelSpeed = accel · wishSpeed · dt
export const MOUSE_SENS = 0.002;  // rad of rotation per pixel of mouse delta
// MOUSE_SENS and the yaw→pitch→roll batch fold in LobbyRoom.drainLook are
// duplicated in public/client.js for prediction — client and server MUST
// integrate look batches identically or the client's orientation drifts.

// Friction substitute. Without a bleed term the projection cap lets speed
// grow without bound as you carve, and the ship turns into a floaty rocket.
// Same uniform-scalar form as Source's Friction(): scale the WHOLE vector
// (never per-axis), with a stopspeed floor so drift actually terminates
// instead of decaying asymptotically.
//
// Terminal speeds that fall out of this, with drag at its default 0.15:
//   straight line — exactly MAX_WISH (40); the projection cap binds first
//   carved        — sqrt(THRUST_ACCEL · WISH_SPEED · MAX_WISH / drag) ≈ 52,
//                   because a push held just inside the cap contributes
//                   accel·wish·(MAX_WISH/v) per second, not accel·wish
// (WISH_SPEED · THRUST_ACCEL / drag ≈ 67 is the UNCAPPED figure — it only
// applies if MAX_WISH is raised above it.)
export const STOP_SPEED = 6;      // units/s below which the bleed goes constant

// Deadlock's bleed-off is a speed GOVERNOR, not a clamp: you're allowed past
// cruise speed, you just decay out of it fast, and every bit of momentum
// tech lives in that gap. Deadlock ramps air drag over 1.5x → 1.75x its top
// speed, spanning a 5x range (citadel_air_drag_min 0.2 → 1.0). It anchors
// that range at the TOP because ground friction is its real baseline; there
// is no ground here, so we anchor at the BOTTOM instead — `drag` stays the
// cruising value it's always been, and the governor multiplies up from it.
// It sits ABOVE the carving ceiling on purpose, so in normal play it's a
// backstop rather than an everyday mechanic — clamping carving itself would
// just be the magnitude cap again, wearing a hat.
//
// These are MULTIPLES of the player's effective maxWish, not absolutes, so
// an Overdrive upgrade moves the governor up with the ship instead of
// quietly turning into a hard ceiling at tier 3.
export const DRAG_RAMP_LO_MULT = 1.5;  // × maxWish: governor starts biting
export const DRAG_RAMP_HI_MULT = 1.75; // × maxWish: fully engaged at/above here
export const DRAG_GOVERNOR = 5;        // drag multiplier once fully engaged

// Absolute rail, NOT a gameplay cap — the governor is what bounds speed in
// play. It exists only because `drag` is live-tunable down to 0, which
// otherwise leaves nothing bounding the integrator at all.
export const SPEED_RAIL = 150;
export const SHIP_RADIUS = 1.0; // bounding sphere, same figure the shot tests assume

// --- dash ---
// A one-shot impulse (Deadlock's air dash is an impulse, not a sustained
// push), governed by TWO separate clamps. Keeping them separate is the whole
// design; collapsing them back into one reintroduces a hard overwrite.
//
//   DASH_CEIL_MULT — the Source projection cap: how fast the dash is willing
//                    to make you ALONG its own axis, as a multiple of cruise
//                    speed. Above 1 so a dash genuinely overspeeds you for a
//                    moment instead of no-op'ing when you're already moving.
//   DASH_IMPULSE   — a cap on the DELTA: the most velocity any single dash
//                    may add, full stop. Source gets this for free from its
//                    per-tick rate limit; an instant impulse does not, and
//                    without it a dash fired against your motion computes
//                    addSpeed = CEIL + yourSpeed and hard-overwrites the axis
//                    (dash backward at cruise 40 → you end up at -24). This
//                    clamp is what keeps a reversal a REDIRECT.
//
// The two together produce the asymmetry we want: dashing along your heading
// is limited by the ceiling (small — you're already near it), while dashing
// across or against it is limited only by the impulse (the full amount). So
// changing direction is where the dash pays out, without ever cancelling the
// motion you had.
export const DASH_CEIL_MULT = 1.3;  // × maxWish — brief overspeed is allowed
export const DASH_IMPULSE = 16;     // units/s, the hard limit on one dash's delta
// Overspeed has to leave quickly or the dash stops being a burst. Elevated
// drag for the falloff window does that, and it self-corrects: thrust can
// pull you back up to maxWish against it, but nothing can hold you above
// the cap, so the excess (and only the excess) is what actually decays.
export const DASH_FALLOFF_TIME = 0.5; // seconds
export const DASH_FALLOFF_DRAG = 3.5; // drag multiplier during that window

// --- juice ---
// A small pool of discrete charges, all spent by the same mechanic, refilling
// continuously rather than on a per-charge cooldown. JUICE_MAX is duplicated
// as JUICE_SEGMENTS in public/client.js — the HUD draws one arc segment per
// charge, so the two MUST agree on the CEILING (the client sizes its table up
// to 4; upgrades move a player's own max within that range).
export const JUICE_MAX = 1;         // charges granted by the base Juice Capacitor
export const JUICE_MAX_CEILING = 4; // the client's arc table stops here
export const JUICE_REGEN_SEC = 6.5; // seconds to recover one charge

// --- combat ---
export const BASE_HULL = 100;
export const RESPAWN_DELAY_SEC = 3;
export const SPAWN_RADIUS = 60;    // respawn somewhere on this sphere
export const TICK_DT = 1 / 60;     // analytic seconds-per-tick (setSimulationInterval default)
// ring buffer of everyone's positions per tick, for lag-compensated rewind.
// Travel-time weapons deliberately do NOT use it — they're dodgeable by
// design, and rewinding targets on top of that double-compensates ("dodged,
// died anyway"). The hitscan railgun is exactly what it's for.
export const HISTORY_TICKS = 32;

// --- round structure ---
// Phase lengths in seconds. shop ends early once everyone has locked in.
export const SHOP_SECONDS = 30;
export const COMBAT_SECONDS = 90;
export const INTERMISSION_SECONDS = 6;

// --- scrap ---
export const STARTING_SCRAP = 100;   // so the round-1 shop is never a dead screen
export const SCRAP_PER_DAMAGE = 0.1; // 1 scrap per 10 damage — engaging always pays
export const SCRAP_PER_PLAYER_KILL = 50;
export const SCRAP_PER_BOT_KILL = 20;
export const ROUND_STIPEND_BASE = 40;
export const ROUND_STIPEND_PER_ROUND = 10;

// --- bots ---
export const BOT_TARGET_COMBATANTS = 4; // bots top the field up to this many ships
export const BOT_MAX = 5;
// Bots fire on the same weapon cooldowns players do, multiplied by this.
// Above 1 = slower. A solo player faces three of them at once, so matching a
// player's cadence three times over isn't "hard", it's a wall of bolts with
// no gap to push into. The gap is what makes a fight readable.
export const BOT_FIRE_COOLDOWN_MULT = 1.7;

// --- shared vectors / constants ---
export const IDENTITY = new Quaternion();
export const LOCAL_FORWARD = new Vector3(0, 0, -1); // three.js convention: -Z is "forward"
export const LOCAL_RIGHT = new Vector3(1, 0, 0);
export const LOCAL_UP = new Vector3(0, 1, 0);

// The asteroid field, duplicated from public/client.js — both sides MUST
// agree or the server will stop ships against rocks the client draws
// elsewhere. Drift is a pure function of the shared tick, so no replication
// is needed beyond state.tick.
export const ASTEROID_FIELD = [
  { p: [-40, 10, -80], r: 12, seed: 1 },
  { p: [25, -15, -50], r: 7, seed: 2 },
  { p: [-70, -20, 40], r: 16, seed: 3 },
  { p: [80, 30, 60], r: 9, seed: 4 },
  { p: [0, 42, -120], r: 14, seed: 5 },
  { p: [45, -35, -20], r: 6, seed: 6 },
];

export const asteroidCenter = (rock: typeof ASTEROID_FIELD[number], tSec: number) => new Vector3(
  rock.p[0] + 3 * Math.sin(tSec * 0.05 + rock.seed * 7),
  rock.p[1] + 3 * Math.sin(tSec * 0.04 + rock.seed * 13),
  rock.p[2] + 3 * Math.sin(tSec * 0.06 + rock.seed * 3),
);
