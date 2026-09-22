// Every sound in the game, synthesised in the browser. There are no audio
// assets in this repo and this file is why: a handful of oscillators and one
// noise buffer covers everything a space shooter needs, and it keeps the
// whole sound design readable and tunable as numbers rather than as a folder
// of .ogg files nobody can diff.
//
// The vocabulary is deliberately narrow, because the mix has to stay legible
// in a firefight:
//   - PITCH says what happened. Your own guns are mid, hits are high and
//     short, deaths are low and long.
//   - LENGTH says how much it mattered. Nothing routine lasts past ~200ms.
//   - Distant events are quieter AND duller (see `distance`), because in a
//     fight the thing you most need to know is whether a sound was aimed at
//     you, and a lowpass answers that faster than volume alone.
//
// An AudioContext can't start before a user gesture, so nothing here builds
// anything until init() is called from the join handler.

let ctx = null;
let master = null;
let noiseBuffer = null;
let muted = false;

const audioBuffers = {};
let engineSource = null;
let engineGain = null;
let engineWanted = false;
const ENGINE_VOLUME = 0.28;

async function loadSample(name, url) {
  if (!ctx) return;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    audioBuffers[name] = await ctx.decodeAudioData(arrayBuffer);
    if (name === 'engine' && engineWanted && !engineSource && !muted) {
      startEngineLoop();
    }
  } catch (err) {
    console.warn(`Could not load audio sample "${name}" from ${url}:`, err);
  }
}

export function startEngineLoop() {
  engineWanted = true;
  if (!ctx || muted) return;
  if (engineSource) return; // already active
  if (!audioBuffers['engine']) return; // will trigger on decode completion

  try {
    engineSource = ctx.createBufferSource();
    engineSource.buffer = audioBuffers['engine'];
    engineSource.loop = true;
    engineGain = ctx.createGain();
    engineGain.gain.setValueAtTime(0.0001, ctx.currentTime);
    engineGain.gain.linearRampToValueAtTime(ENGINE_VOLUME, ctx.currentTime + 0.3);
    engineSource.connect(engineGain).connect(master);
    engineSource.start(0);
  } catch (err) {
    console.warn('Error starting engine loop:', err);
  }
}

export function stopEngineLoop() {
  engineWanted = false;
  if (!engineSource) return;
  const src = engineSource;
  const gain = engineGain;
  engineSource = null;
  engineGain = null;
  try {
    if (ctx && gain) {
      gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
      setTimeout(() => {
        try {
          src.stop();
          src.disconnect();
          gain.disconnect();
        } catch (e) {}
      }, 350);
    } else {
      src.stop();
      src.disconnect();
    }
  } catch (err) {
    console.warn('Error stopping engine loop:', err);
  }
}

/** Roughly how far away a sound is still worth hearing at all. */
const MAX_AUDIBLE = 420;
/** Distance at which a sound is already down to half volume. */
const HALF_VOLUME_AT = 90;

export function initAudio() {
  if (ctx) {
    // Browsers suspend the context when the tab loses focus, and a suspended
    // context silently swallows everything scheduled on it.
    if (ctx.state === 'suspended') ctx.resume();
    return;
  }
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return; // no audio in this browser; every play() below no-ops
  ctx = new AudioCtx();
  master = ctx.createGain();
  master.gain.value = 0.55;
  master.connect(ctx.destination);

  // One second of white noise, generated once and reused as the source for
  // every explosion, thruster and impact. Re-randomising per sound would be
  // pure waste — a different offset into the same buffer is already
  // indistinguishable.
  noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  // Pre-load external audio clips
  loadSample('rail', '/audio/railgun.wav');
  loadSample('engine', '/audio/engineLoop.wav');
}

export function toggleMute() {
  muted = !muted;
  if (master) master.gain.value = muted ? 0 : 0.55;
  if (!muted && engineWanted && !engineSource) {
    startEngineLoop();
  }
  return muted;
}

export const isMuted = () => muted;

/**
 * Volume and brightness for something `distance` units away. Returns null
 * when it's too far to bother scheduling nodes for at all — in a busy round
 * that's most of the shots being fired.
 */
function attenuate(distance) {
  if (distance === undefined) return { gain: 1, cutoff: 20000 };
  if (distance > MAX_AUDIBLE) return null;
  const gain = 1 / (1 + distance / HALF_VOLUME_AT);
  // air doesn't do this in vacuum, but the cue is worth more than the physics
  const cutoff = 800 + 19200 * Math.max(0, 1 - distance / MAX_AUDIBLE) ** 2;
  return { gain, cutoff };
}

/** A gain → lowpass chain into the master bus, pre-scaled for distance. */
function voice(level, atten) {
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = atten.cutoff;
  gain.connect(filter).connect(master);
  return { gain, filter, level: level * atten.gain };
}

function noiseSource() {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  // a random offset so two simultaneous explosions aren't phase-identical
  src.start(0, Math.random() * 0.9);
  return src;
}

/** Percussive envelope: near-instant attack, exponential tail. */
function hit(param, level, at, decay) {
  param.setValueAtTime(0.0001, at);
  param.exponentialRampToValueAtTime(Math.max(0.0001, level), at + 0.006);
  param.exponentialRampToValueAtTime(0.0001, at + decay);
}

const SOUNDS = {
  // Hitscan. A hard crack with a pitch collapse under it — the drop is what
  // makes it read as discharge rather than as a beep.
  rail(now, atten) {
    if (audioBuffers['rail']) {
      const src = ctx.createBufferSource();
      src.buffer = audioBuffers['rail'];
      const v = voice(0.75, atten);
      src.connect(v.gain);
      v.gain.gain.setValueAtTime(v.level, now);
      src.start(now);
      src.onended = () => {
        try {
          src.disconnect();
          v.gain.disconnect();
          v.filter.disconnect();
        } catch (e) {}
      };
      return;
    }

    const v = voice(0.5, atten);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(1500, now);
    osc.frequency.exponentialRampToValueAtTime(110, now + 0.22);
    osc.connect(v.gain);
    hit(v.gain.gain, v.level, now, 0.3);
    osc.start(now);
    osc.stop(now + 0.32);

    const crack = noiseSource();
    const cv = voice(0.35, atten);
    cv.filter.type = 'highpass';
    cv.filter.frequency.value = 1800;
    crack.connect(cv.gain);
    hit(cv.gain.gain, cv.level, now, 0.06);
    crack.stop(now + 0.08);
  },

  // Repeater. Short, dry and a little nasal, so a stream of them stays
  // countable instead of turning into a wash.
  bolt(now, atten) {
    const v = voice(0.3, atten);
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(640, now);
    osc.frequency.exponentialRampToValueAtTime(220, now + 0.08);
    osc.connect(v.gain);
    hit(v.gain.gain, v.level, now, 0.1);
    osc.start(now);
    osc.stop(now + 0.12);
  },

  // Launch, not detonation: a mortar thump. The burst is a separate sound
  // that arrives when the shell actually goes off.
  flak(now, atten) {
    const v = voice(0.45, atten);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(48, now + 0.16);
    osc.connect(v.gain);
    hit(v.gain.gain, v.level, now, 0.2);
    osc.start(now);
    osc.stop(now + 0.22);
  },

  // Ram activation. Rising, so it reads as something spooling UP — the one
  // sound in the game that warns you before it matters.
  ram(now, atten) {
    const v = voice(0.5, atten);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(90, now);
    osc.frequency.exponentialRampToValueAtTime(680, now + 0.18);
    osc.connect(v.gain);
    v.gain.gain.setValueAtTime(0.0001, now);
    v.gain.gain.exponentialRampToValueAtTime(v.level, now + 0.14);
    v.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
    osc.start(now);
    osc.stop(now + 0.62);

    const shimmer = noiseSource();
    const sv = voice(0.3, atten);
    sv.filter.type = 'bandpass';
    sv.filter.Q.value = 3;
    sv.filter.frequency.setValueAtTime(400, now);
    sv.filter.frequency.exponentialRampToValueAtTime(3600, now + 0.35);
    shimmer.connect(sv.gain);
    sv.gain.gain.setValueAtTime(0.0001, now);
    sv.gain.gain.exponentialRampToValueAtTime(sv.level, now + 0.1);
    sv.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
    shimmer.stop(now + 0.92);
  },

  // Ordnance going off. Noise through a collapsing lowpass is the whole
  // trick: the sweep downward is what the ear reads as "big".
  blast(now, atten) {
    const src = noiseSource();
    const v = voice(0.7, atten);
    v.filter.frequency.setValueAtTime(Math.min(4200, atten.cutoff), now);
    v.filter.frequency.exponentialRampToValueAtTime(120, now + 0.5);
    src.connect(v.gain);
    hit(v.gain.gain, v.level, now, 0.55);
    src.stop(now + 0.6);

    const thump = ctx.createOscillator();
    const tv = voice(0.6, atten);
    thump.type = 'sine';
    thump.frequency.setValueAtTime(140, now);
    thump.frequency.exponentialRampToValueAtTime(38, now + 0.3);
    thump.connect(tv.gain);
    hit(tv.gain.gain, tv.level, now, 0.4);
    thump.start(now);
    thump.stop(now + 0.45);
  },

  // A ship coming apart. Same shape as `blast`, longer and lower, with a
  // tail of debris so it doesn't just stop.
  death(now, atten) {
    SOUNDS.blast(now, atten);
    const src = noiseSource();
    const v = voice(0.4, atten);
    v.filter.frequency.setValueAtTime(Math.min(1800, atten.cutoff), now);
    v.filter.frequency.exponentialRampToValueAtTime(90, now + 1.1);
    src.connect(v.gain);
    v.gain.gain.setValueAtTime(0.0001, now + 0.05);
    v.gain.gain.exponentialRampToValueAtTime(v.level, now + 0.14);
    v.gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
    src.stop(now + 1.25);
  },

  // Hitmarker. Never attenuated — this one is about YOUR shot connecting, so
  // it belongs at the front of the mix regardless of how far away it landed.
  // Two cycles of a high square is about as short as a sound can be and
  // still be heard over a railgun.
  hitmark(now, atten) {
    const v = voice(0.34, atten);
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(2100, now);
    osc.connect(v.gain);
    hit(v.gain.gain, v.level, now, 0.045);
    osc.start(now);
    osc.stop(now + 0.06);
  },

  // Kill confirmation: the hitmarker's note plus a fifth above it, so it's
  // recognisably the same event escalated rather than a different sound.
  killmark(now, atten) {
    for (const [freq, delay] of [[1760, 0], [2640, 0.055]]) {
      const v = voice(0.34, atten);
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, now + delay);
      osc.connect(v.gain);
      hit(v.gain.gain, v.level, now + delay, 0.11);
      osc.start(now + delay);
      osc.stop(now + delay + 0.14);
    }
  },

  // Dash. Pure filtered noise sweeping up then away — no pitched component,
  // so it never competes with a weapon for attention.
  dash(now, atten) {
    const src = noiseSource();
    const v = voice(0.4, atten);
    v.filter.type = 'bandpass';
    v.filter.Q.value = 1.2;
    v.filter.frequency.setValueAtTime(320, now);
    v.filter.frequency.exponentialRampToValueAtTime(2600, now + 0.14);
    v.filter.frequency.exponentialRampToValueAtTime(500, now + 0.4);
    src.connect(v.gain);
    hit(v.gain.gain, v.level, now, 0.42);
    src.stop(now + 0.45);
  },

  // Shop click. Short and soft; it plays a lot.
  buy(now, atten) {
    const v = voice(0.3, atten);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(1320, now + 0.08);
    osc.connect(v.gain);
    hit(v.gain.gain, v.level, now, 0.13);
    osc.start(now);
    osc.stop(now + 0.16);
  },
};

/**
 * Play one cue. `distance` in world units attenuates and dulls it; omit it
 * for anything that happened to YOU (your own trigger pull, your hitmarker),
 * which should always sit at the front of the mix.
 *
 * Silently does nothing before init(), after a failed init, or when the
 * source is out of earshot — callers are hot paths and shouldn't have to
 * check any of that.
 */
export function play(name, distance) {
  if (!ctx || muted) return;
  const make = SOUNDS[name];
  if (!make) return;
  const atten = attenuate(distance);
  if (!atten) return;
  // A tab that has been backgrounded comes back suspended; scheduling into a
  // suspended context queues sounds that all fire at once on resume.
  if (ctx.state === 'suspended') { ctx.resume(); return; }
  make(ctx.currentTime, atten);
}
