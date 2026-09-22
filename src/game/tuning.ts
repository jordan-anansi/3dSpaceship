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
// Doubled from 40 when the arena grew: the belt runs from 207 to ~2,400
// units out, and at the old cruise speed crossing it was a minute of holding
// W. Both moved together on purpose — WISH_SPEED is the push and MAX_WISH is
// the ceiling, so raising only the ceiling would have kept the same
// acceleration and just made it take twice as long to get there.
export const WISH_SPEED = 80;     // units/s requested at full deflection
export const MAX_WISH = 80;       // units/s cap on the along-wishDir projection
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
//   straight line — exactly MAX_WISH (80); the projection cap binds first
//   carved        — sqrt(THRUST_ACCEL · WISH_SPEED · MAX_WISH / drag) ≈ 103,
//                   because a push held just inside the cap contributes
//                   accel·wish·(MAX_WISH/v) per second, not accel·wish
// (WISH_SPEED · THRUST_ACCEL / drag ≈ 133 is the UNCAPPED figure — it only
// applies if MAX_WISH is raised above it.)
export const STOP_SPEED = 12;     // units/s below which the bleed goes constant

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
//
// Has to move with MAX_WISH or it stops being a rail and starts being a cap:
// the governor is fully engaged at 1.75 · maxWish (140), so leaving this at
// 150 would have left 10 units/s of gap and turned the integrator backstop
// into an everyday clamp — exactly the magnitude cap this model exists to
// avoid. 300 keeps the original ~3.75x headroom over cruise.
export const SPEED_RAIL = 300;
// Bounding sphere. Every weapon's hit radius is derived from this rather than
// hardcoded, so widening the target widens it for all of them at once —
// otherwise "bigger hitboxes" silently means "bigger for the railgun only".
//
// 2.2 is deliberately GENEROUS against a hull that's about 2.4 units long,
// i.e. a true radius near 1.2. Ships cross at a combined 160 units/s in an
// arena 2,400 units across, and at those closing speeds a physically honest
// sphere means most well-aimed shots register as misses. The hull model is
// scaled up to match in public/client.js (SHIP_BOUND_RADIUS and the GLB
// normalizer) so what you shoot at is what you see.
export const SHIP_RADIUS = 2.2;
// Cosmetic shell drawn where a ship died. No damage — see Blast.kind.
export const DEATH_BLAST_RADIUS = 12;

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
// Absolute, so it doubled with cruise speed. Left at 16 it would still have
// "worked", just as 20% of cruise instead of 40% — a dash you can barely feel.
export const DASH_IMPULSE = 32;     // units/s, the hard limit on one dash's delta
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
// Both zero = no bots at all. sync() removes any already in the field, so
// this switches them off live rather than only for new rooms. Put these back
// to 4 / 5 to bring them back.
export const BOT_TARGET_COMBATANTS = 0; // bots top the field up to this many ships
export const BOT_MAX = 0;
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
// elsewhere. Rather than a hand-written list, both sides run the IDENTICAL
// LCG below from the same seed, so the two can only drift if someone edits
// one copy of the generator. Drift is a pure function of the shared tick, so
// nothing here needs replicating beyond state.tick.
//
// The multiply stays exact in a double: s < 2^32 and 1664525 < 2^21, so the
// product is under 2^53. That exactness is what makes JS and TS agree.
export interface Rock {
  p0: [number, number, number];
  r: number;
  driftAmp: [number, number, number];
  driftFreq: [number, number, number];
  driftPhase: [number, number, number];
  rot0: [number, number, number];
  rotV: [number, number, number];
  seed: number;
}

// The belt IS the play space — there are no walls, so how far out the rocks
// go is the whole extent of the arena. This shrinks it without deleting any
// rocks: the count stays at 100 and only the volume they're spread through
// moves, which is what makes the field busier rather than emptier.
//
// Crowding is a DENSITY figure — rocks you meet per unit of flight path —
// so "50% more crowded" is volume × 1/1.5, NOT extent × 1/1.5. Scaling the
// extent to two-thirds would have tripled the density, not raised it by half.
// The belt is an annular shell, V ≈ π(Rout² − Rin²)·H, so scaling the radial
// span and the height together by 0.87 lands on two-thirds of the volume:
//   Rout 2,720 → 2,382, H 592 → 515, V → 0.667·V_old, density → 1.50×
//
// It multiplies the RANDOM span only, never the 120 + 1.6r inner offset —
// that offset is what keeps a monolith off the spawn sphere (see below), and
// scaling it would pull the giants inward toward spawn, which is the one
// place the field must stay clear.
export const BELT_SCALE = 0.87;

export function generateAsteroidField(count = 100): Rock[] {
  let s = 987654321;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };

  const field: Rock[] = [];
  for (let i = 0; i < count; i++) {
    // Power-law radii: many 5-40u boulders, dozens of mid rocks, a few
    // 200-500u monoliths. Cubing the uniform is what keeps giants rare.
    const r = 5 + Math.pow(rnd(), 3.5) * 495;

    // A belt around the arena, with bigger rocks pushed further out so a
    // monolith can never engulf the spawn sphere (SPAWN_RADIUS = 60, and the
    // nearest possible rock surface sits at 120 + 1.6r - r > 120).
    const angle = rnd() * Math.PI * 2;
    const dist = 120 + r * 1.6 + rnd() * 2600 * BELT_SCALE;
    const height = (rnd() - 0.5) * (500 + r * 0.8) * BELT_SCALE;
    const p0: [number, number, number] = [
      Math.cos(angle) * dist,
      height,
      Math.sin(angle) * dist,
    ];

    // Mass stands in for inertia: the bigger the rock, the slower it drifts
    // and the lazier it tumbles.
    const speedFactor = Math.max(0.18, 1 - r / 520);
    const driftAmp: [number, number, number] = [
      (6 + rnd() * 18) * (0.6 + 0.4 * speedFactor),
      (4 + rnd() * 14) * (0.6 + 0.4 * speedFactor),
      (6 + rnd() * 18) * (0.6 + 0.4 * speedFactor),
    ];
    const driftFreq: [number, number, number] = [
      (0.015 + rnd() * 0.03) * speedFactor,
      (0.012 + rnd() * 0.025) * speedFactor,
      (0.015 + rnd() * 0.03) * speedFactor,
    ];
    const driftPhase: [number, number, number] = [
      rnd() * Math.PI * 2,
      rnd() * Math.PI * 2,
      rnd() * Math.PI * 2,
    ];
    const rot0: [number, number, number] = [
      rnd() * Math.PI * 2,
      rnd() * Math.PI * 2,
      rnd() * Math.PI * 2,
    ];
    const maxRot = 0.03 + 0.18 * speedFactor;
    const rotV: [number, number, number] = [
      (rnd() - 0.5) * maxRot,
      (rnd() - 0.5) * maxRot,
      (rnd() - 0.5) * maxRot,
    ];

    field.push({ p0, r, driftAmp, driftFreq, driftPhase, rot0, rotV, seed: i + 1 });
  }
  return field;
}

export const ASTEROID_FIELD = generateAsteroidField(100);

// Where every rock is at an instant, as a flat [x,y,z, x,y,z, ...] buffer.
//
// This is the hottest loop on the server: shots sweep the field every tick,
// every ship collides against it every tick, and every bot paths around it
// every tick. At six rocks, letting each caller recompute the sines cost
// nothing. At a hundred it is ~600k sin calls and ~400k Vector3 allocations a
// second, all of it recomputing the same numbers. So the field is evaluated
// ONCE per distinct instant into a reused buffer and every caller reads that.
//
// Callers MUST treat the returned buffer as read-only — it is shared, and it
// is overwritten on the next tick.
const centerBuffer = new Float64Array(ASTEROID_FIELD.length * 3);
let centerBufferAt = NaN;

export function asteroidCenters(tSec: number): Float64Array {
  if (tSec === centerBufferAt) return centerBuffer;
  for (let i = 0; i < ASTEROID_FIELD.length; i++) {
    const { p0, driftAmp: a, driftFreq: f, driftPhase: ph } = ASTEROID_FIELD[i];
    centerBuffer[i * 3] = p0[0] + a[0] * Math.sin(tSec * f[0] + ph[0]);
    centerBuffer[i * 3 + 1] = p0[1] + a[1] * Math.sin(tSec * f[1] + ph[1]);
    centerBuffer[i * 3 + 2] = p0[2] + a[2] * Math.cos(tSec * f[2] + ph[2]);
  }
  centerBufferAt = tSec;
  return centerBuffer;
}

/** One rock's centre, by index. Convenience wrapper — hot loops read the
 *  buffer directly rather than allocating a Vector3 per rock. */
export const asteroidCenter = (index: number, tSec: number) => {
  const c = asteroidCenters(tSec);
  return new Vector3(c[index * 3], c[index * 3 + 1], c[index * 3 + 2]);
};
