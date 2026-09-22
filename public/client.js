import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  SHOT_FX, createBlast, disposeBlast, disposeFx, updateBlast,
} from './weapon-fx.js';
import { initAudio, play as playSound, toggleMute, startEngineLoop, stopEngineLoop } from './audio.js';
import {
  getActiveExplosionConfig,
  spawnOneShotExplosion,
} from './particle-explosion.js';

// This client implements the 'mouse' control scheme, the only one the server
// simulates. The older keyboard schemes ('flight', 'strafe') are archived in
// legacy/client-keyboard-controls.js.

const form = document.getElementById('join-form');
const nameInput = document.getElementById('name-input');
const lobbyDiv = document.getElementById('lobby');
const playerList = document.getElementById('player-list');
const status = document.getElementById('status');

// Same host/port that served this page, so it works on localhost and LAN alike.
// Match the page's scheme too: an https page (e.g. behind a Cloudflare tunnel)
// can't open an insecure ws:// socket — the browser blocks it as mixed content.
const WS_PROTO = location.protocol === 'https:' ? 'wss' : 'ws';
const client = new Colyseus.Client(`${WS_PROTO}://${location.host}`);

// The room we're currently in (null between sessions). Input listeners are
// registered ONCE at module level and route through this reference, so
// rejoining never double-registers handlers.
let currentRoom = null;

// TICK_DT must match src/game/tuning.ts — it's how wall-clock time is
// converted into the shared tick timeline that shots and phase clocks live on.
const TICK_DT = 1 / 60;

// Estimated server tick between patches. state.tick only advances at patch
// granularity (~50ms), so anything placed on the raw value stutters —
// extrapolate locally against wall-clock time since the last patch.
let tickBase = { tick: 0, at: performance.now() };
const estimatedTick = () => tickBase.tick + (performance.now() - tickBase.at) / (1000 * TICK_DT);

// Mirrors the WeaponDef ids and names in src/game/weapons/. The hotkey is the
// index in THIS list, not in the list of weapons you happen to own, so a gun
// keeps the same key all run — muscle memory shouldn't shuffle when you buy
// something.
// Railgun is key 1 because it's the gun you start with (see
// src/game/weapons/index.ts → defaultWeapon).
const WEAPON_ORDER = [
  { id: 'rail', name: 'Railgun' },
  { id: 'bolt', name: 'Bolt Cannon' },
  { id: 'flak', name: 'Flak Launcher' },
  { id: 'ram', name: 'Battering Ram' },
];

// Duplicated from RAM_COOLDOWN_MS in src/game/weapons/ram.ts. Only the HUD
// bar reads it — the server owns the actual gate — so a drift here shows up
// as a bar that finishes early or late, not as a desynced simulation.
const RAM_COOLDOWN_SEC = 5;

// The reference grid, so `g` can toggle it from the module-level key handler.
// Null between sessions; startGame owns the lifetime.
let activeGrid = null;

function toggleFullscreen() {
  const wrap = document.getElementById('game-wrap');
  if (!wrap) return;
  // the WRAPPER, not the canvas — the vignette, speedlines, reticle and HUD
  // are siblings of the canvas, and fullscreening the canvas alone would drop
  // every one of them
  const request = document.fullscreenElement
    ? document.exitFullscreen()
    : wrap.requestFullscreen();
  request?.catch((err) => console.warn('fullscreen toggle failed:', err));
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;

  status.textContent = 'connecting...';
  // A submit IS the user gesture an AudioContext needs, and it's the last one
  // guaranteed to happen before the shooting starts — after this the pointer
  // is locked and there may never be another ordinary click.
  initAudio();
  try {
    const room = await client.joinOrCreate('lobby', { name });
    form.classList.add('hidden');
    lobbyDiv.classList.remove('hidden');
    status.textContent = `connected as ${name} (session ${room.sessionId})`;
    await startGame(room);
  } catch (err) {
    status.textContent = `failed to join: ${err.message}`;
  }
});

// --- keyboard input: thrust goes to the server as {moveZ, moveX}; roll is
// folded into look batches below so the whole orientation stays predictable ---
const TRACKED = new Set(['w', 's', 'a', 'd', 'q', 'e']);
const held = new Set();
const axis = (pos, neg) => (held.has(pos) ? 1 : 0) - (held.has(neg) ? 1 : 0);
const sendInput = () => currentRoom?.send('input', {
  moveZ: axis('w', 's'), // forward/backward thrust
  moveX: axis('d', 'a'), // lateral strafe — inert until Lateral Thrusters
});

// --- the trigger ----------------------------------------------------------
// Two inputs pull it (left mouse and space) and either may be held, so the
// held state is a SET of which ones are down rather than a boolean: letting
// go of space while still holding the mouse must not stop the gun.
//
// Repeats are sent faster than any weapon's cooldown and the server drops the
// extras. That's deliberate — the alternative is teaching the client every
// weapon's cadence, which is a second source of truth that goes stale the
// first time a cooldown upgrade lands.
const TRIGGER_REPEAT_MS = 60;
const triggersDown = new Set();
let triggerTimer = null;

const sendFire = () => {
  if (typeof flushLookBatch === 'function') flushLookBatch(performance.now());
  currentRoom?.send('fire', {
    // seq lets the server aim with exactly the orientation we predicted;
    // tick names the world we were looking at, for lag-compensated weapons
    seq: lookSeq,
    tick: Math.round(estimatedTick()),
  });
};

function pullTrigger(source) {
  if (triggersDown.has(source)) return;
  const wasIdle = triggersDown.size === 0;
  triggersDown.add(source);
  if (!wasIdle) return;
  sendFire();
  triggerTimer = setInterval(() => {
    if (!currentRoom || triggersDown.size === 0) { releaseTrigger(); return; }
    sendFire();
  }, TRIGGER_REPEAT_MS);
}

function releaseTrigger(source) {
  if (source === undefined) triggersDown.clear();
  else triggersDown.delete(source);
  if (triggersDown.size > 0) return;
  clearInterval(triggerTimer);
  triggerTimer = null;
}

// Losing the pointer (esc, alt-tab, the shop overlay appearing) has to drop
// the trigger too, or the gun keeps firing at nothing until the next click.
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === gameCanvas;
  document.body.classList.toggle('pointer-locked', locked);
  if (!locked) releaseTrigger();
});
window.addEventListener('blur', () => { releaseTrigger(); held.clear(); sendInput(); });

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return; // typing in a form, not flying
  if (e.key === ' ') {
    e.preventDefault(); // don't scroll the page or "click" a focused button
    if (!e.repeat) pullTrigger('key');
    return;
  }
  if (e.key === 'Shift') {
    // the server reads the dash direction off the w/a/s/d state it already
    // holds — the socket is ordered, so the keydown that set it got there
    // first. seq pins the orientation, exactly as firing does.
    if (!e.repeat) currentRoom?.send('dash', { seq: lookSeq });
    return;
  }
  // weapon hotkeys. The server rejects a weapon you don't own, so there's no
  // need to check ownership here.
  if (e.key >= '1' && e.key <= '9') {
    const pick = WEAPON_ORDER[Number(e.key) - 1];
    if (pick) currentRoom?.send('setWeapon', { id: pick.id });
    return;
  }
  const key = e.key.toLowerCase();
  // view toggles: local-only, nothing to tell the server about
  if (key === 'f') { toggleFullscreen(); return; }
  if (key === 'm') { toggleMute(); return; }
  if (key === 'g') {
    if (activeGrid) activeGrid.visible = !activeGrid.visible;
    return;
  }
  if (key === 'x') {
    openExplosionLabTab();
    return;
  }
  if (key === 'o' || key === '`') {
    openSettingsTab();
    return;
  }
  if (key === 'b') {
    const current = currentRoom?.state?.botCount ?? 0;
    const next = current > 0 ? 0 : 4;
    currentRoom?.send('setBotCount', next);
    return;
  }
  if (key === 't') {
    const me = currentRoom?.state?.players?.get(currentRoom?.sessionId);
    const next = !(me?.godMode);
    currentRoom?.send('setGodMode', next);
    return;
  }
  if (TRACKED.has(key) && !held.has(key)) { held.add(key); sendInput(); }
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') { releaseTrigger('key'); return; }
  const key = e.key.toLowerCase();
  if (TRACKED.has(key)) { held.delete(key); sendInput(); }
});

// Camera FOV zoom (45° to 85°): scrolled with mouse wheel when pointer locked.
const BASE_FOV = 70;
const MIN_FOV = 45;
const MAX_FOV = 85;
const FOV_STEP = 5;
let targetFov = BASE_FOV;
let currentBaseFov = BASE_FOV;

// Weapons that detonate at a set range (e.g. flak) can dial fuse with Alt+wheel or Ctrl+wheel.
let fuse = 40;
const FUSE_STEP = 5;
window.addEventListener('wheel', (e) => {
  if (!currentRoom || document.pointerLockElement !== gameCanvas) return;
  e.preventDefault();

  const me = currentRoom.state?.players?.get(currentRoom.sessionId);
  if ((e.altKey || e.ctrlKey) && me?.weapon === 'flak') {
    fuse = Math.max(5, Math.min(200, fuse - Math.sign(e.deltaY) * FUSE_STEP));
    currentRoom.send('setFuse', fuse);
    return;
  }

  // Scroll up (deltaY < 0): zoom in -> smaller FOV (down to 45°)
  // Scroll down (deltaY > 0): zoom out -> wider FOV (up to 85°)
  const delta = Math.abs(e.deltaY) >= 50
    ? Math.sign(e.deltaY) * FOV_STEP
    : (e.deltaY / 100) * FOV_STEP;
  targetFov = Math.max(MIN_FOV, Math.min(MAX_FOV, targetFov + delta));
}, { passive: false });


// --- optimistic look: our own orientation, applied locally the instant the
// input happens and reproduced by the server from the same batches ---
//
// Every LOOK_INTERVAL ms the accumulated mouse deltas plus dt's worth of held
// roll become one sequence-numbered batch. We fold it into predictedQuat
// immediately (zero-latency camera) and send the identical batch to the
// server, which folds it identically — orientation is a deterministic fold
// of the batch stream, so prediction shouldn't ever miss. The batch history
// is kept so that if server and prediction do disagree at the same seq
// (dropped state, a respawn, a bug), we rebase onto the server quat and replay.
//
// MOUSE_SENS / ROLL_RATE and the yaw→pitch→roll order MUST match
// src/game/tuning.ts and LobbyRoom.drainLook.
const MOUSE_SENS = 0.002;
const ROLL_RATE = 90 * (Math.PI / 180);
const LOOK_INTERVAL = 33;
// Roll eases in rather than snapping to ROLL_RATE: the rate scales linearly
// from 0 to full over ROLL_RAMP seconds of holding q/e. Not momentum —
// releasing (or reversing) drops the rate straight back to zero.
let rollRamp = 0.6; // seconds to reach full rate; live-tuned by the slider
const LOCAL_FORWARD = new THREE.Vector3(0, 0, -1);
const LOCAL_RIGHT = new THREE.Vector3(1, 0, 0);
const LOCAL_UP = new THREE.Vector3(0, 1, 0);

const predictedQuat = new THREE.Quaternion();
let lookSeq = 0;
let lookHistory = []; // [{seq, dx, dy, roll, q}] — q = predicted quat AFTER the batch

function applyLookBatch(q, batch) {
  if (batch.dx) q.multiply(new THREE.Quaternion().setFromAxisAngle(LOCAL_UP, -batch.dx * MOUSE_SENS));
  if (batch.dy) q.multiply(new THREE.Quaternion().setFromAxisAngle(LOCAL_RIGHT, -batch.dy * MOUSE_SENS));
  if (batch.roll) q.multiply(new THREE.Quaternion().setFromAxisAngle(LOCAL_FORWARD, batch.roll));
  q.normalize();
}

const gameCanvas = document.getElementById('game');
// Left click both captures the pointer and, once captured, fires. The two
// have to be the same button and they can't both happen on one press: the
// click that grabs the mouse is the player saying "let me in", not "shoot" —
// firing on it would put a shot downrange before they'd even seen the frame.
gameCanvas.addEventListener('mousedown', (e) => {
  if (e.button === 1) {
    // Middle click resets zoom to default 70°
    e.preventDefault();
    targetFov = BASE_FOV;
    return;
  }
  if (e.button !== 0) return;
  if (!currentRoom) return;
  const phase = currentRoom.state?.phase;
  // During shop or intermission the overlay needs real clicks, so there's nothing to grab
  if (phase === 'shop' || phase === 'intermission') return;
  if (document.pointerLockElement !== gameCanvas) {
    gameCanvas.requestPointerLock();
    return;
  }
  e.preventDefault();
  pullTrigger('mouse');
});
window.addEventListener('auxclick', (e) => {
  if (e.button === 1) e.preventDefault();
});
window.addEventListener('mouseup', (e) => { if (e.button === 0) releaseTrigger('mouse'); });
let lookDX = 0, lookDY = 0;
window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === gameCanvas) {
    lookDX += e.movementX;
    lookDY += e.movementY;
  }
});
let lastBatchTime = performance.now();
let rollDir = 0;    // direction of the roll currently ramping (-1, 0, +1)
let rollScale = 0;  // 0..1 fraction of ROLL_RATE reached so far

// Flushes accumulated mouse deltas and roll input into predictedQuat and sends
// the batch to the server. Runs on every requestAnimationFrame render so mouse
// look operates at the monitor's native refresh rate (60Hz, 120Hz, 144Hz, 240Hz)
// with zero timer jitter.
function flushLookBatch(nowMs) {
  const dt = Math.min(0.1, (nowMs - lastBatchTime) / 1000);
  lastBatchTime = nowMs;
  if (!currentRoom) { lookDX = 0; lookDY = 0; return; }

  // Ramp: restart from zero whenever the roll direction changes (including
  // to/from no-input), otherwise climb toward 1 at 1/rollRamp per second.
  // The batch's angle uses the ramp's midpoint over dt so the integrated
  // rotation matches the intended rate curve regardless of batch timing.
  const dir = axis('e', 'q');
  const prevScale = dir === rollDir ? rollScale : 0;
  rollDir = dir;
  if (dir === 0) rollScale = 0;
  else if (rollRamp > 0) rollScale = Math.min(1, prevScale + dt / rollRamp);
  else rollScale = 1;
  const avgScale = rollRamp > 0 ? (prevScale + rollScale) / 2 : rollScale;
  const roll = dir * ROLL_RATE * avgScale * dt;

  if (!lookDX && !lookDY && !roll) return;
  const batch = { seq: ++lookSeq, dx: lookDX, dy: lookDY, roll };
  lookDX = 0;
  lookDY = 0;
  applyLookBatch(predictedQuat, batch);
  lookHistory.push({ ...batch, q: predictedQuat.clone() });
  if (lookHistory.length > 256) lookHistory.shift();
  currentRoom.send('look', batch);
}

// Called each frame with our replicated Player state. The server's quat
// corresponds to lookSeq = p.lookSeq; compare it against what we predicted
// at that same seq. Match (the normal case) → discard confirmed history.
// Mismatch → rebase on the server quat and replay the unconfirmed batches.
// A respawn is the one routine case where this fires: the server points the
// ship somewhere new and drops our queued batches, so we snap to its answer.
function reconcileLook(p) {
  const idx = lookHistory.findIndex((h) => h.seq === p.lookSeq);
  if (idx === -1) {
    // nothing in flight: any gap between us and the server is drift, not
    // pending input — adopt the server's answer if it's measurably different
    if (lookHistory.length === 0 && p.lookSeq === lookSeq) {
      const dot = Math.abs(p.qx * predictedQuat.x + p.qy * predictedQuat.y + p.qz * predictedQuat.z + p.qw * predictedQuat.w);
      if (dot < 0.999999) predictedQuat.set(p.qx, p.qy, p.qz, p.qw);
    }
    return;
  }
  const h = lookHistory[idx];
  const dot = Math.abs(p.qx * h.q.x + p.qy * h.q.y + p.qz * h.q.z + p.qw * h.q.w);
  const pending = lookHistory.slice(idx + 1);
  if (dot < 0.999999) {
    predictedQuat.set(p.qx, p.qy, p.qz, p.qw);
    pending.forEach((batch) => applyLookBatch(predictedQuat, batch));
  }
  lookHistory = pending; // everything ≤ p.lookSeq is confirmed
}

// --- temporary drag tuner: server owns the value, we just display & send ---
const dragInput = document.getElementById('drag-input');
document.getElementById('drag-set').addEventListener('click', () => {
  const value = parseFloat(dragInput.value);
  if (Number.isFinite(value)) currentRoom?.send('setDrag', value);
  dragInput.value = '';
  dragInput.blur(); // give the keyboard back to flight controls
});

// --- roll ramp-up tuner: purely client-side (the server only ever sees the
// already-integrated per-batch angle, so scaling it here needs no handshake) ---
const rollRampInput = document.getElementById('roll-ramp-input');
const rollRampCurrent = document.getElementById('roll-ramp-current');
rollRampInput.value = String(rollRamp);
rollRampInput.addEventListener('input', () => {
  rollRamp = parseFloat(rollRampInput.value);
  rollRampCurrent.textContent = rollRamp > 0 ? `${rollRamp.toFixed(2)}s` : 'instant';
});
// a focused range input swallows w/a/s/d as arrow-key nudges, so hand focus back
rollRampInput.addEventListener('change', () => rollRampInput.blur());

// --- bot count tuner: server owns the value, we display & send ---
const botsInput = document.getElementById('bots-input');
const sendBotCount = () => {
  const value = parseInt(botsInput.value, 10);
  if (Number.isFinite(value)) currentRoom?.send('setBotCount', value);
  botsInput.blur();
};
document.getElementById('bots-set')?.addEventListener('click', sendBotCount);
botsInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendBotCount();
});

// --- hull and test mode tuner: set arbitrary hull or toggle infinite hull ---
const hullInput = document.getElementById('hull-input');
const godToggle = document.getElementById('god-toggle');
const sendHull = () => {
  const value = parseInt(hullInput.value, 10);
  if (Number.isFinite(value)) currentRoom?.send('setHull', value);
  hullInput.blur();
};
document.getElementById('hull-set')?.addEventListener('click', sendHull);
hullInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendHull();
});
godToggle?.addEventListener('change', () => {
  currentRoom?.send('setGodMode', godToggle.checked);
  godToggle.blur();
});

// --- juice meter: arc segments in a shallow arc under the reticle, sharing
// one pool. Rebuilt whenever the player's capacity changes (buying Juice
// Capacity adds a segment); per frame we only move stroke-dashoffset, so a
// partially-regenerated charge fills its own segment left-to-right. ---
const juiceSvg = document.getElementById('juice');
const reticleEl = document.getElementById('reticle');
const JUICE_R = 52; // arc radius, in viewBox units (1:1 with px)
// Deadlock's element_charges clip table. The arc stays ~90° whatever the
// segment count — segments get thinner rather than the ring getting wider,
// so a full meter always occupies the same screen space.
const JUICE_TABLE = {
  1: { sweep: 90, gap: 0 },
  2: { sweep: 42, gap: 7 },
  3: { sweep: 26, gap: 5 },
  4: { sweep: 20, gap: 3 },
};
let juiceFills = [];   // [{ path, len }] in left-to-right order
let juiceBuiltFor = -1;

function buildJuice(segments) {
  if (segments === juiceBuiltFor) return;
  juiceBuiltFor = segments;
  juiceSvg.replaceChildren();
  juiceFills = [];
  // visibility is syncUi's call (it also hides the arc outside combat); this
  // only owns what's drawn inside it
  if (segments < 1) return; // no Juice Capacitor yet — nothing to draw

  const NS = 'http://www.w3.org/2000/svg';
  const cx = 66, cy = 66;
  const { sweep: segDeg, gap } = JUICE_TABLE[Math.min(4, segments)];
  const span = segDeg * segments + gap * (segments - 1);
  // exact circular arc length — the SVG may live in a display:none subtree,
  // so getTotalLength() isn't dependable here
  const segLen = JUICE_R * segDeg * (Math.PI / 180);
  // angle measured from straight down, growing clockwise on screen
  const point = (deg) => {
    const a = (deg * Math.PI) / 180;
    return [cx + JUICE_R * Math.sin(a), cy + JUICE_R * Math.cos(a)];
  };
  for (let i = 0; i < segments; i++) {
    const a0 = -span / 2 + i * (segDeg + gap);
    const [x0, y0] = point(a0);
    const [x1, y1] = point(a0 + segDeg);
    // sweep-flag 0: our angle grows clockwise from straight-down, which runs
    // counter-clockwise through SVG's arc parameterisation at the bottom of
    // the circle
    const d = `M ${x0} ${y0} A ${JUICE_R} ${JUICE_R} 0 0 0 ${x1} ${y1}`;
    for (const cls of ['track', 'fill']) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', cls);
      juiceSvg.appendChild(path);
      if (cls === 'fill') {
        path.style.strokeDasharray = String(segLen);
        path.style.strokeDashoffset = String(segLen); // starts empty
        juiceFills.push({ path, len: segLen });
      }
    }
  }
}

function renderJuice(juice) {
  for (let i = 0; i < juiceFills.length; i++) {
    const { path, len } = juiceFills[i];
    const frac = Math.max(0, Math.min(1, juice - i));
    path.style.strokeDashoffset = String(len * (1 - frac));
    // the one part-way segment is the one actively refilling
    path.classList.toggle('charging', frac > 0 && frac < 1);
  }
}

// --- speed & dash feedback ---
// Two separate cues. Continuous: FOV creeps open and the corners darken with
// speed. Triggered: a dash adds a brief contrast lift plus edge streaks.
// Everything here is deliberately faint — it should be felt at the edge of
// vision, not looked at.
const vignetteEl = document.getElementById('vignette');
const speedlinesEl = document.getElementById('speedlines');
// Continuous: corners darken with speed. Triggered: a dash adds a brief contrast lift plus edge streaks.
const SPEED_FX_LO = 20;    // units/s where the speed cue starts appearing
const SPEED_FX_HI = 110;   // ...and where it's fully applied
const VIGNETTE_MAX = 0.3;
const DASH_FX_TIME = 0.5;  // seconds for the dash flash to fade out
const DASH_CONTRAST = 0.07;
const DASH_LINES_MAX = 0.22;
let speedFx = 0;      // smoothed 0..1 speed factor
let dashFx = 0;       // 1 at the instant of a dash, easing to 0
let lastJuice = null; // previous frame's juice, for spend detection

// A spend is the only thing that can drop juice mid-life (regen only adds),
// so a sizeable decrease means a dash actually landed server-side — better
// than firing on keypress, which would flash even when we're out of juice.
// Respawn refills rather than drains, so it can't false-positive.
function noteJuice(juice) {
  if (lastJuice !== null && juice < lastJuice - 0.5) { dashFx = 1; playSound('dash'); }
  lastJuice = juice;
}

function renderSpeedFx(camera, canvas, speed, dt) {
  // Smoothly interpolate currentBaseFov towards targetFov strictly driven by thumbwheel zoom
  currentBaseFov += (targetFov - currentBaseFov) * Math.min(1, dt * 20);
  if (Math.abs(currentBaseFov - camera.fov) > 0.01) {
    camera.fov = currentBaseFov;
    camera.updateProjectionMatrix();
  }

  // Speed cues: vignette and dash feedback only (no FOV distortion on acceleration)
  const target = Math.min(1, Math.max(0, (speed - SPEED_FX_LO) / (SPEED_FX_HI - SPEED_FX_LO)));
  speedFx += (target - speedFx) * Math.min(1, dt * 6);
  vignetteEl.style.opacity = (VIGNETTE_MAX * speedFx).toFixed(3);

  if (dashFx > 0) {
    dashFx = Math.max(0, dashFx - dt / DASH_FX_TIME);
    const k = dashFx * dashFx; // quadratic falloff — reads as a blink, not a fade
    speedlinesEl.style.opacity = (DASH_LINES_MAX * k).toFixed(3);
    // cleared rather than left at contrast(1) so the canvas doesn't keep a
    // compositing layer alive between dashes
    canvas.style.filter = dashFx > 0 ? `contrast(${1 + DASH_CONTRAST * k})` : '';
  }
}

// Jupiter-ish procedural texture: horizontal bands from a warm palette,
// wobbled by layered sine "turbulence", plus per-pixel noise and a red spot.
function makeJupiterTexture(w = 512, h = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const palette = [
    [201, 144, 94], [224, 185, 145], [168, 110, 72],
    [233, 207, 171], [190, 130, 90], [214, 168, 128],
  ];
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const v = y / h;
    for (let x = 0; x < w; x++) {
      const u = x / w;
      // wobble the band coordinate so edges swirl instead of ruling straight
      const wobble =
        0.030 * Math.sin(u * Math.PI * 6 + v * 40) +
        0.015 * Math.sin(u * Math.PI * 14 + v * 90 + 2) +
        0.008 * Math.sin(u * Math.PI * 30 + v * 23 + 5);
      const band = Math.abs(Math.floor((v + wobble) * 14)) % palette.length;
      const [r, g, b] = palette[band];
      // cheap hash noise for grain
      const n = Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
      const shade = 0.94 + 0.12 * n;
      const i = (y * w + x) * 4;
      img.data[i] = r * shade;
      img.data[i + 1] = g * shade;
      img.data[i + 2] = b * shade;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // the great red spot
  ctx.filter = 'blur(3px)';
  ctx.fillStyle = 'rgba(184, 92, 60, 0.9)';
  ctx.beginPath();
  ctx.ellipse(w * 0.7, h * 0.63, w * 0.055, h * 0.055, 0, 0, 2 * Math.PI);
  ctx.fill();
  ctx.filter = 'none';
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Preload the ship model once; per-player ships are cheap clones sharing the
// template's geometry and materials. Resolves to null on failure, in which
// case players fall back to the old cube.
//
// The GLB (converted from orion/nave_orion.obj) is authored at ~277 units
// long with the nose toward +Z; the inner group normalizes it to our game
// units — centered, SHIP_LENGTH long, nose along -Z — so the OUTER group can
// wear the replicated quaternion/position directly.
//
// SHIP_LENGTH must track SHIP_RADIUS in src/game/tuning.ts: the hitbox is a
// 2.2-unit sphere, and a 2.4-long hull inside it means half the shots that
// register land visibly off the model. Drawing the ship at the size it is
// actually hit at is also most of "make ships more visible" — at 2.4 units
// in a 2,700-unit arena an enemy is a speck almost everywhere.
const SHIP_LENGTH = 4.4;
const shipTemplatePromise = new GLTFLoader().loadAsync('/models/orion.glb')
  .then((gltf) => {
    const model = gltf.scene;
    model.traverse((o) => {
      if (!o.isMesh) return;
      // no backface culling: parts of the hull are modeled single-sided and
      // vanish from some viewing angles with culling on
      o.material.side = THREE.DoubleSide;
      // Ship hull is lit purely by the scene's three asteroid lights (ambient,
      // directional sun key, and opposing fill) with no artificial emissive floor.
      if (o.material.emissive) {
        o.material.emissive = new THREE.Color(0x000000);
        o.material.emissiveIntensity = 0;
      }
    });
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    model.position.copy(center).multiplyScalar(-1);
    const norm = new THREE.Group();
    norm.rotation.y = Math.PI;
    norm.scale.setScalar(SHIP_LENGTH / size.z);
    norm.add(model);
    const template = new THREE.Group();
    template.add(norm);
    return template;
  })
  .catch((err) => {
    console.warn('ship model failed to load, falling back to cubes', err);
    return null;
  });

// Asteroid model (converted from Rocky_Asteroid_5.obj) dressed in its PBR
// texture set (1K variants from Textures_Rocky_Asteroid_5.rar). flipY must
// be false: the GLB's UVs use the glTF convention, not TextureLoader's
// default. Resolves to null on failure → procedural stand-in rocks.
const asteroidTemplatePromise = new GLTFLoader().loadAsync('/models/asteroid.glb')
  .then((gltf) => {
    const model = gltf.scene;
    const texLoader = new THREE.TextureLoader();
    const loadTex = (url, colorSpace) => {
      const tex = texLoader.load(url);
      tex.flipY = false;
      if (colorSpace) tex.colorSpace = colorSpace;
      return tex;
    };
    const material = new THREE.MeshStandardMaterial({
      map: loadTex('/textures/asteroid_diffuse.png', THREE.SRGBColorSpace),
      normalMap: loadTex('/textures/asteroid_normal.png'),
      roughnessMap: loadTex('/textures/asteroid_roughness.png'),
      roughness: 1.4,
      metalness: 0.0,
    });
    model.traverse((o) => { if (o.isMesh) o.material = material; });
    // normalize so an instance scale of N gives a rock of radius ~N
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    model.position.copy(center).multiplyScalar(-1);
    const norm = new THREE.Group();
    norm.scale.setScalar(2 / Math.max(size.x, size.y, size.z));
    norm.add(model);
    const template = new THREE.Group();
    template.add(norm);
    return template;
  })
  .catch((err) => {
    console.warn('asteroid model failed to load, falling back to procedural rocks', err);
    return null;
  });

// Every client generates the identical rocks by running the identical LCG
// from the identical seed. DUPLICATED in src/game/tuning.ts, which collides
// ships and shots against these same spheres — the two generators MUST stay
// in step or the server will stop you against a rock you can't see.
//
// The multiply stays exact in a double: s < 2^32 and 1664525 < 2^21, so the
// product is under 2^53. That exactness is what makes both sides agree.
function generateAsteroidField(count = 100) {
  let s = 987654321;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };

  const field = [];
  for (let i = 0; i < count; i++) {
    // Power-law radii: many 5-40u boulders, dozens of mid rocks, a few
    // 200-500u monoliths. Cubing the uniform is what keeps giants rare.
    const r = 5 + Math.pow(rnd(), 3.5) * 495;

    // A belt around the arena, with bigger rocks pushed further out so a
    // monolith can never engulf the spawn sphere (SPAWN_RADIUS = 60, and the
    // nearest possible rock surface sits at 120 + 1.6r - r > 120).
    const angle = rnd() * Math.PI * 2;
    const dist = 120 + r * 1.6 + rnd() * 2600;
    const height = (rnd() - 0.5) * (500 + r * 0.8);
    const p0 = [Math.cos(angle) * dist, height, Math.sin(angle) * dist];

    // Mass stands in for inertia: the bigger the rock, the slower it drifts
    // and the lazier it tumbles.
    const speedFactor = Math.max(0.18, 1 - r / 520);
    const driftAmp = [
      (6 + rnd() * 18) * (0.6 + 0.4 * speedFactor),
      (4 + rnd() * 14) * (0.6 + 0.4 * speedFactor),
      (6 + rnd() * 18) * (0.6 + 0.4 * speedFactor),
    ];
    const driftFreq = [
      (0.015 + rnd() * 0.03) * speedFactor,
      (0.012 + rnd() * 0.025) * speedFactor,
      (0.015 + rnd() * 0.03) * speedFactor,
    ];
    const driftPhase = [rnd() * Math.PI * 2, rnd() * Math.PI * 2, rnd() * Math.PI * 2];
    const rot0 = [rnd() * Math.PI * 2, rnd() * Math.PI * 2, rnd() * Math.PI * 2];
    const maxRot = 0.03 + 0.18 * speedFactor;
    const rotV = [
      (rnd() - 0.5) * maxRot,
      (rnd() - 0.5) * maxRot,
      (rnd() - 0.5) * maxRot,
    ];

    field.push({ p0, r, driftAmp, driftFreq, driftPhase, rot0, rotV, seed: i + 1 });
  }
  return field;
}

// Engine glow. At a ~2.7:1 key-to-fill ratio a hull's unlit side is nearly
// black, so from most angles the only thing separating an enemy from the
// starfield is a sliver of lit edge. An additive sprite on the tail is light
// the ship EMITS: it survives being in shadow, it reads from any angle, and
// it costs one quad. The material is shared across every ship — they all
// have the same engines — so this allocates once and clones cheaply.
let engineGlowMaterial = null;
function makeEngineGlow() {
  if (!engineGlowMaterial) {
    engineGlowMaterial = new THREE.SpriteMaterial({
      map: makeStarTexture(), // the same soft radial falloff the stars use
      color: 0x74d2ff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }
  const sprite = new THREE.Sprite(engineGlowMaterial);
  sprite.scale.setScalar(SHIP_LENGTH * 0.8);
  sprite.position.z = SHIP_LENGTH * 0.42; // the tail — the nose is -Z
  return sprite;
}

const ASTEROID_FIELD = generateAsteroidField(100);

function makeAsteroid(template, { p0, r, rot0, seed }) {
  if (template) {
    const mesh = template.clone(true); // shares geometry/material
    mesh.scale.setScalar(r);
    mesh.position.set(p0[0], p0[1], p0[2]);
    mesh.rotation.set(rot0[0], rot0[1], rot0[2]);
    return mesh;
  }
  // procedural fallback rock
  const geometry = new THREE.IcosahedronGeometry(r, 2);
  // displace vertices with cheap position-hashed noise; displacement is a
  // pure function of position, so shared corners stay welded (no cracks)
  const pos = geometry.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n =
      Math.sin(seed + v.x * 5.1) *
      Math.sin(seed * 1.7 + v.y * 4.3) *
      Math.sin(seed * 2.3 + v.z * 3.7);
    v.multiplyScalar(1 + 0.35 * n);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: 0x8a7a68, roughness: 0.95, flatShading: true })
  );
  mesh.position.set(p0[0], p0[1], p0[2]);
  mesh.rotation.set(rot0[0], rot0[1], rot0[2]);
  return mesh;
}

// ---------------------------------------------------------------------------
// The sky. Everything below is drawn at astronomical distance and never
// collides with anything — it exists to give the arena a legible up, a
// direction for the light to come from, and a sense of being somewhere.
//
// Two of these bodies TRACK THE CAMERA (see the render loop): the sun and the
// star sphere are redrawn centred on the player every frame, so they hold
// constant angular size and never parallax. That's what makes them read as
// infinitely far away instead of as very large nearby props you can outrun.
// The moon deliberately does NOT track — at 5,500 km it barely shifts at ship
// speeds, and the shift it does have is the only cue that you moved at all.
//
// Distances are in metres so the numbers stay recognisable; the arena's
// "units" are the same thing at a different scale, which is why the far plane
// has to go to 25,000 km and the depth buffer has to go logarithmic.
// ---------------------------------------------------------------------------

// Where the light comes from. Fixed in world space, so shadows and the lit
// limb of the moon agree with where the sun is actually drawn.
const SUN_DIR = new THREE.Vector3(0.6, 0.45, -0.65).normalize();
const SUN_DISTANCE = 14000000;    // 14,000 km
const SUN_CORE_RADIUS = 500000;   // 500 km
const SUN_CORONA_RADIUS = 680000; // 680 km

function makeSun() {
  const group = new THREE.Group();
  // unlit core: it IS the light source, so shading it would be backwards
  group.add(new THREE.Mesh(
    new THREE.SphereGeometry(SUN_CORE_RADIUS, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0xfff6e8 })
  ));
  // corona, drawn back-faces-only so the core shows through the middle of it
  group.add(new THREE.Mesh(
    new THREE.SphereGeometry(SUN_CORONA_RADIUS, 32, 32),
    new THREE.MeshBasicMaterial({
      color: 0xffba55, transparent: true, opacity: 0.38, side: THREE.BackSide,
    })
  ));
  return group;
}

const MOON_RADIUS = 1737400;   // 1,737.4 km — the actual Moon
const MOON_DISTANCE = 5500000; // 5,500 km
const MOON_DIR = new THREE.Vector3(0.35, 0.18, -0.91).normalize();

// Shared by both atmosphere shells. The logdepthbuf chunks are NOT optional:
// the renderer runs with logarithmicDepthBuffer on, and a custom shader that
// doesn't opt in writes linear depth into a logarithmic buffer — the shells
// then z-fight with the planet surface they're supposed to wrap.
const ATMOSPHERE_VERT = `
  varying vec3 vWorldPosition;
  #include <common>
  #include <logdepthbuf_pars_vertex>
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
    #include <logdepthbuf_vertex>
  }
`;

function makePlanet() {
  const group = new THREE.Group();
  const planetCenter = MOON_DIR.clone().multiplyScalar(MOON_DISTANCE);

  group.add(new THREE.Mesh(
    new THREE.SphereGeometry(MOON_RADIUS, 64, 48),
    new THREE.MeshStandardMaterial({
      map: makeJupiterTexture(), roughness: 0.88, metalness: 0.05,
    })
  ));

  // Inner haze: a Fresnel rim ON the planet's own surface, brightest where
  // we're looking along the limb and dimmest dead centre.
  group.add(new THREE.Mesh(
    new THREE.SphereGeometry(MOON_RADIUS * 1.012, 64, 48),
    new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0xffcb78) },
        uSunDir: { value: SUN_DIR },
        uPlanetCenter: { value: planetCenter },
      },
      vertexShader: ATMOSPHERE_VERT,
      fragmentShader: `
        uniform vec3 uColor;
        uniform vec3 uSunDir;
        uniform vec3 uPlanetCenter;
        varying vec3 vWorldPosition;
        #include <common>
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          vec3 worldNormal = normalize(vWorldPosition - uPlanetCenter);
          vec3 viewDir = normalize(cameraPosition - vWorldPosition);
          float rim = pow(1.0 - max(0.0, dot(viewDir, worldNormal)), 2.8);
          // the terminator is soft, not a hard line: remap dot from [-0.25,1]
          // so twilight has somewhere to live
          float sunFactor = clamp((dot(worldNormal, uSunDir) + 0.25) / 1.25, 0.0, 1.0);
          vec3 atmoColor = mix(vec3(0.68, 0.36, 0.16), uColor, 0.3 + 0.7 * sunFactor);
          gl_FragColor = vec4(atmoColor, rim * (0.2 + 0.8 * sunFactor) * 0.85);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  ));

  // Outer halo: a back-faces-only shell so the glow extends into empty space
  // AROUND the silhouette rather than sitting on the disc.
  group.add(new THREE.Mesh(
    new THREE.SphereGeometry(MOON_RADIUS * 1.045, 64, 48),
    new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0xffad54) },
        uSunDir: { value: SUN_DIR },
        uPlanetCenter: { value: planetCenter },
      },
      vertexShader: ATMOSPHERE_VERT,
      fragmentShader: `
        uniform vec3 uColor;
        uniform vec3 uSunDir;
        uniform vec3 uPlanetCenter;
        varying vec3 vWorldPosition;
        #include <common>
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          vec3 worldNormal = normalize(vWorldPosition - uPlanetCenter);
          vec3 viewDir = normalize(cameraPosition - vWorldPosition);
          // Path-length normalisation. dot(-viewDir, normal) runs 0 at the
          // outer shell's edge up to sqrt(1 - (Rp/Ro)^2) = 0.2908 at the
          // planet's silhouette limb; dividing by that maps the shell's full
          // thickness to [0,1] so the halo peaks exactly at the limb.
          float rim = clamp(dot(-viewDir, worldNormal) / 0.2908, 0.0, 1.0);
          float sunFactor = clamp((dot(worldNormal, uSunDir) + 0.25) / 1.25, 0.0, 1.0);
          vec3 atmoColor = mix(vec3(0.62, 0.32, 0.14), uColor, 0.35 + 0.65 * sunFactor);
          gl_FragColor = vec4(atmoColor, pow(rim, 2.0) * (0.2 + 0.8 * sunFactor) * 0.9);
        }
      `,
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  ));

  group.position.copy(planetCenter);
  return group;
}

// A soft round falloff, so a star is a point of light rather than a square.
function makeStarTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.25, 'rgba(255, 255, 255, 0.9)');
  gradient.addColorStop(0.6, 'rgba(220, 235, 255, 0.35)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 16, 16);
  return new THREE.CanvasTexture(canvas);
}

// Stars on the celestial sphere, behind every other body. sizeAttenuation is
// OFF on purpose: these are 16,000 km out, so perspective scaling would
// shrink them to nothing — a fixed pixel size is both correct and cheaper.
// These are pure BACKDROP: they ride the camera, so they contribute no
// parallax and therefore no sense of speed. That job belongs to the grid and
// the rocks — see the grid in startGame.
function makeDistantStars(count = 3500, radius = 16000000) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  // a rough main sequence — enough spread that the field doesn't read as one
  // flat grey wash
  const starColors = [
    new THREE.Color(1.0, 1.0, 1.0),   // white
    new THREE.Color(0.85, 0.93, 1.0), // blue-white
    new THREE.Color(0.72, 0.85, 1.0), // azure
    new THREE.Color(1.0, 0.95, 0.82), // warm yellow
    new THREE.Color(1.0, 0.80, 0.65), // amber giant
  ];

  for (let i = 0; i < count; i++) {
    // uniform random direction on the sphere
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * 2 * Math.PI;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    const r = radius + (Math.random() - 0.5) * 60;

    positions[i * 3] = r * s * Math.cos(theta);
    positions[i * 3 + 1] = r * u;
    positions[i * 3 + 2] = r * s * Math.sin(theta);

    // squared so most stars are dim and a few are bright, which is what makes
    // constellations resolve out of the noise
    const base = starColors[Math.floor(Math.random() * starColors.length)];
    const lum = 0.45 + 0.55 * Math.random() ** 2;
    colors[i * 3] = base.r * lum;
    colors[i * 3 + 1] = base.g * lum;
    colors[i * 3 + 2] = base.b * lum;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  return new THREE.Points(geometry, new THREE.PointsMaterial({
    size: 3.5,
    map: makeStarTexture(),
    vertexColors: true,
    sizeAttenuation: false,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
}

// ---------------------------------------------------------------------------
// UI layer. Everything below reads replicated state and writes DOM; it never
// decides anything. The server owns the phase, the offers and the prices —
// a card's displayed cost is a copy, and pressing Buy sends only an id.
// ---------------------------------------------------------------------------

const ui = {
  overlay: document.getElementById('overlay'),
  title: document.getElementById('overlay-title'),
  sub: document.getElementById('overlay-sub'),
  clock: document.getElementById('overlay-clock'),
  lobby: document.getElementById('overlay-lobby'),
  shop: document.getElementById('overlay-shop'),
  scores: document.getElementById('overlay-scores'),
  cards: document.getElementById('cards'),
  shopScrap: document.getElementById('shop-scrap'),
  skipBtn: document.getElementById('skip-btn'),
  readyLine: document.getElementById('ready-line'),
  scoreboard: document.getElementById('scoreboard'),
  startBtn: document.getElementById('start-btn'),
  botSelect: document.getElementById('bot-select'),
  banner: document.getElementById('round-banner'),
  bannerRound: document.querySelector('#round-banner .round'),
  bannerPhase: document.querySelector('#round-banner .phase'),
  bannerClock: document.querySelector('#round-banner .clock'),
  scrapTag: document.getElementById('scrap-tag'),
  hullWrap: document.getElementById('hull-wrap'),
  hullLabel: document.getElementById('hull-label'),
  hullFill: document.getElementById('hull-fill'),
  weaponStrip: document.getElementById('weapon-strip'),
  weaponList: document.getElementById('weapon-list'),
  fuseTag: document.getElementById('fuse-tag'),
  respawn: document.getElementById('respawn-notice'),
  respawnSub: document.querySelector('#respawn-notice .sub'),
  hint: document.getElementById('controls-hint'),
  hud: document.getElementById('hud'),
  targetBoxes: document.getElementById('target-boxes'),
  nametags: document.getElementById('nametags'),
  edgeArrows: document.getElementById('edge-arrows'),
  hitmarker: document.getElementById('hitmarker'),
  killfeed: document.getElementById('killfeed'),
  upgradeMenu: document.getElementById('upgrade-menu'),
  ramTag: document.getElementById('ram-tag'),
  ramLabel: document.getElementById('ram-label'),
  ramFill: document.getElementById('ram-fill'),
  fpsTag: document.getElementById('fps-tag'),
  openSettingsBtn: document.getElementById('open-settings-btn'),
  openExpLabBtn: document.getElementById('open-exp-lab-btn'),
  openAttribBtn: document.getElementById('open-attrib-btn'),
  joinAttribBtn: document.getElementById('join-attrib-btn'),
  overlaySettingsBtn: document.getElementById('overlay-settings-btn'),
  overlayLabBtn: document.getElementById('overlay-lab-btn'),
  overlayAttribBtn: document.getElementById('overlay-attrib-btn'),
};

// --- hit confirmation -----------------------------------------------------
// The one piece of feedback the server has to tell us about: a shot's
// outcome is resolved entirely server-side (lag compensation means the world
// it resolved against isn't even the one we drew), so there is nothing the
// client could infer this from on its own.
function flashHitmarker(killed) {
  const el = ui.hitmarker;
  // Restarting a CSS animation needs the class off, a forced reflow, and the
  // class back on. Without the reflow the browser coalesces both style
  // changes into one and the animation never retriggers — which means every
  // hit after the first shows nothing, exactly when it matters most.
  el.classList.remove('show');
  el.classList.toggle('kill', !!killed);
  void el.offsetWidth;
  el.classList.add('show');
}

// Color the red HUD box around a hit ship green for 0.33 seconds
function flashHitBox(box) {
  if (!box) return;
  box.classList.add('hit');
  if (box._hitTimer) clearTimeout(box._hitTimer);
  box._hitTimer = setTimeout(() => {
    box.classList.remove('hit');
    box._hitTimer = null;
  }, 330);
}

// --- killfeed -------------------------------------------------------------
// Rows age out on a timer rather than being capped alone: a cap keeps the
// list short but leaves the last few kills on screen forever in a quiet
// stretch, which makes stale information look current.
const KILLFEED_LIFE_MS = 6000;
const KILLFEED_FADE_MS = 400;
const KILLFEED_MAX = 5;

function pushKillfeed(event, myId) {
  const row = document.createElement('div');
  row.className = 'kill-row';
  if (event.byId === myId) row.classList.add('mine');
  if (event.victimId === myId) row.classList.add('victim-me');

  const by = document.createElement('span');
  by.className = 'by';
  // A ship can die with nobody credited — an instant-kill dome whose owner
  // left, say — and "  destroyed X" reads as a rendering bug.
  by.textContent = event.by || 'something';

  const weapon = document.createElement('span');
  weapon.className = 'weapon';
  weapon.textContent = event.weapon ? ` — ${event.weapon} → ` : ' destroyed ';

  const victim = document.createElement('span');
  victim.className = 'victim';
  victim.textContent = event.victim;

  row.append(by, weapon, victim);
  ui.killfeed.prepend(row);
  while (ui.killfeed.children.length > KILLFEED_MAX) ui.killfeed.lastChild.remove();

  setTimeout(() => {
    row.classList.add('fading');
    setTimeout(() => row.remove(), KILLFEED_FADE_MS);
  }, KILLFEED_LIFE_MS);
}

// Gate for the canvas click handler: while any overlay is up, clicks belong
// to the UI, not to pointer lock.
let overlayVisible = true;

ui.startBtn.addEventListener('click', () => currentRoom?.send('startGame'));
ui.skipBtn.addEventListener('click', () => currentRoom?.send('skip'));
ui.botSelect?.addEventListener('change', () => {
  const value = parseInt(ui.botSelect.value, 10);
  if (Number.isFinite(value)) currentRoom?.send('setBotCount', value);
  ui.botSelect.blur();
});

// --- External Tabs (Server Settings & Explosion Lab) ---
function openSettingsTab() {
  if (document.pointerLockElement) {
    document.exitPointerLock?.();
  }
  window.open('/settings.html', '_blank');
}

function openExplosionLabTab() {
  if (document.pointerLockElement) {
    document.exitPointerLock?.();
  }
  window.open('/explosion-lab.html', '_blank');
}

function openAttributionsTab() {
  if (document.pointerLockElement) {
    document.exitPointerLock?.();
  }
  window.open('/attributions.html', '_blank');
}

ui.openSettingsBtn?.addEventListener('click', openSettingsTab);
ui.openExpLabBtn?.addEventListener('click', openExplosionLabTab);
ui.openAttribBtn?.addEventListener('click', openAttributionsTab);
ui.joinAttribBtn?.addEventListener('click', openAttributionsTab);
ui.overlaySettingsBtn?.addEventListener('click', openSettingsTab);
ui.overlayLabBtn?.addEventListener('click', openExplosionLabTab);
ui.overlayAttribBtn?.addEventListener('click', openAttributionsTab);

const mmss = (seconds) => {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Rebuild the two shop cards. Diffed against a signature so the DOM isn't
// thrashed at the UI tick rate — and so an in-progress hover/focus survives.
let cardSignature = '';
function renderCards(me) {
  const signature = `${me.scrap | 0}|${me.ready}|` +
    me.offer.map((c) => `${c.id}:${c.tier}:${c.cost}`).join(',');
  if (signature === cardSignature) return;
  cardSignature = signature;

  ui.cards.replaceChildren();
  me.offer.forEach((card) => {
    const affordable = me.scrap >= card.cost;
    const el = document.createElement('div');
    el.className = `card ${card.kind}${affordable ? ' affordable' : ''}`;

    const kind = document.createElement('div');
    kind.className = 'kind';
    kind.textContent = card.kind === 'tech'
      ? 'New technology'
      : `Upgrade · tier ${card.tier} of ${card.maxTier}`;

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = card.name;

    const blurb = document.createElement('div');
    blurb.className = 'blurb';
    blurb.textContent = card.blurb;

    const cost = document.createElement('div');
    cost.className = `cost${affordable ? '' : ' cant'}`;
    cost.textContent = `${card.cost} scrap`;

    const button = document.createElement('button');
    button.textContent = affordable ? 'Buy' : 'Too expensive';
    button.disabled = !affordable || me.ready;
    button.addEventListener('click', () => {
      currentRoom?.send('buy', { id: card.id });
      playSound('buy');
    });

    el.append(kind, name, blurb, cost, button);
    ui.cards.appendChild(el);
  });
}

// The right-hand column: every tier-up currently available, buyable as many
// times as the scrap lasts. Diffed against a signature for the same reason
// the cards are — this rebuilds at the UI tick rate otherwise, and a row
// that gets replaced mid-click never fires its handler.
//
// Costs come off the replicated card, which the server reprices after every
// purchase, so buying tier 2 immediately shows tier 3 at its higher price.
let upgradeSignature = '';
function renderUpgradeMenu(me) {
  const signature = `${me.scrap | 0}|${me.ready}|` +
    me.upgrades.map((c) => `${c.id}:${c.tier}:${c.cost}`).join(',');
  if (signature === upgradeSignature) return;
  upgradeSignature = signature;

  ui.upgradeMenu.replaceChildren();
  if (me.upgrades.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Nothing to tier up yet — take a technology first.';
    ui.upgradeMenu.appendChild(empty);
    return;
  }

  me.upgrades.forEach((card) => {
    const affordable = me.scrap >= card.cost;
    const row = document.createElement('div');
    row.className = `up-row${affordable ? ' affordable' : ''}`;

    const label = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'up-name';
    name.textContent = card.name;
    const tier = document.createElement('div');
    tier.className = 'up-tier';
    tier.textContent = `tier ${card.tier} of ${card.maxTier}`;
    label.append(name, tier);
    label.title = card.blurb; // the full text, without a row tall enough for it

    const cost = document.createElement('div');
    cost.className = `up-cost${affordable ? '' : ' cant'}`;
    cost.textContent = String(card.cost);

    const button = document.createElement('button');
    button.textContent = 'Buy';
    button.disabled = !affordable || me.ready;
    button.addEventListener('click', () => {
      currentRoom?.send('buy', { id: card.id });
      playSound('buy');
    });

    row.append(label, cost, button);
    ui.upgradeMenu.appendChild(row);
  });
}

// Accuracy is only meaningful once you've actually pulled the trigger; a
// player who spent the round running shows a dash rather than a proud 0%.
const accuracyOf = (p) =>
  (p.shotsFired > 0 ? `${Math.round((100 * p.shotsHit) / p.shotsFired)}%` : '—');

function renderScoreboard(players, myId) {
  const rows = [...players.entries()].sort((a, b) => b[1].kills - a[1].kills);
  ui.scoreboard.replaceChildren();
  const head = document.createElement('tr');
  const columns = [
    ['ship', 'who'], ['kills', ''], ['deaths', ''],
    ['damage', ''], ['accuracy', ''], ['scrap earned', ''],
  ];
  for (const [label, cls] of columns) {
    const th = document.createElement('th');
    th.textContent = label;
    if (cls) th.className = cls;
    head.appendChild(th);
  }
  ui.scoreboard.appendChild(head);
  for (const [id, p] of rows) {
    const tr = document.createElement('tr');
    tr.className = id === myId ? 'me' : (p.isBot ? 'bot' : '');
    const cells = [
      [p.name, 'who'], [p.kills, ''], [p.deaths, ''],
      [Math.round(p.damageDealt), ''], [accuracyOf(p), ''], [Math.floor(p.roundScrap), ''],
    ];
    for (const [text, cls] of cells) {
      const td = document.createElement('td');
      td.textContent = String(text);
      if (cls) td.className = cls;
      tr.appendChild(td);
    }
    ui.scoreboard.appendChild(tr);
  }
}

function renderWeapons(me) {
  ui.weaponList.replaceChildren();
  WEAPON_ORDER.forEach((w, i) => {
    // the railgun is owned from the start and never appears in `tech` as a
    // purchase — keep this in step with defaultWeapon in src/game/weapons/
    const owned = w.id === 'rail' || (me.tech.get(w.id) ?? 0) > 0;
    if (!owned) return;
    const row = document.createElement('div');
    row.className = `w${me.weapon === w.id ? ' active' : ''}`;
    row.innerHTML = `<span class="key">${i + 1}</span> ${w.name}`;
    ui.weaponList.appendChild(row);
  });
  // the fuse readout is only meaningful to weapons that detonate at a range
  ui.fuseTag.classList.toggle('hidden', me.weapon !== 'flak');
  ui.fuseTag.textContent = `fuse ${Math.round(me.fuse)} · alt+wheel to adjust`;

  // Ram cooldown. Shown whenever you OWN the ram, not only while it's
  // selected: the whole point of a five-second lockout is planning around
  // it, and you can't plan around a number that's hidden until you switch.
  const ownsRam = (me.tech.get('ram') ?? 0) > 0;
  ui.ramTag.classList.toggle('hidden', !ownsRam);
  if (ownsRam) {
    const left = Math.max(0, (me.ramReadyTick - estimatedTick()) * TICK_DT);
    ui.ramFill.style.width = `${((1 - Math.min(1, left / RAM_COOLDOWN_SEC)) * 100).toFixed(1)}%`;
    ui.ramTag.classList.toggle('ready', left <= 0);
    ui.ramLabel.textContent = left > 0 ? `ram ${left.toFixed(1)}s` : 'ram ready';
  }
}

function renderHint(me) {
  const parts = [
    'click canvas to capture mouse',
    'mouse: yaw/pitch',
    'wheel: zoom',
    'middle click: reset zoom',
    'q/e: roll',
    'wasd: move',
  ];
  if (me.juiceMax > 0) parts.push('shift: dash');
  parts.push('click/space: fire');
  // only worth showing once there's more than the starting railgun to switch to
  const extraGuns = WEAPON_ORDER.filter((w) => w.id !== 'rail' && (me.tech.get(w.id) ?? 0) > 0);
  if (extraGuns.length) parts.push(`1-${WEAPON_ORDER.length}: weapon`);
  parts.push('o: server settings', 'x: explosion lab', 'f: fullscreen', 'g: grid', 'm: mute', 'b: bots', 'esc: release mouse');
  const text = parts.join('   ');
  if (ui.hint.textContent !== text) ui.hint.textContent = text;
}

/**
 * One pass over replicated state → DOM. Called on a ~10Hz timer rather than
 * per frame: none of this needs 60Hz, and rebuilding cards that often would
 * make them unclickable.
 */
let lastAudioPhase = null;
function syncUi(room) {
  const state = room.state;
  const me = state.players?.get(room.sessionId);
  if (!me) return;
  const phase = state.phase;
  const inCombat = phase === 'combat';

  // Engine sound runs only when movement is allowed in the 3D world (combat phase),
  // and stops when the round ends (intermission / shop / lobby).
  if (phase !== lastAudioPhase) {
    if (phase === 'combat') {
      startEngineLoop();
    } else {
      stopEngineLoop();
    }
    lastAudioPhase = phase;
  }

  // --- overlay ---
  const showOverlay = !inCombat;
  if (showOverlay !== overlayVisible) {
    overlayVisible = showOverlay;
    ui.overlay.classList.toggle('hidden', !showOverlay);
    // an overlay that appears while the pointer is captured would be
    // unclickable, so hand the cursor back the moment combat ends
    if (showOverlay && document.pointerLockElement) document.exitPointerLock();
  }

  ui.lobby.classList.toggle('hidden', phase !== 'lobby');
  ui.shop.classList.toggle('hidden', phase !== 'shop');
  ui.scores.classList.toggle('hidden', phase !== 'intermission');

  const remaining = state.phaseEndTick > 0
    ? (state.phaseEndTick - estimatedTick()) * TICK_DT
    : 0;



  if (phase === 'lobby') {
    ui.title.textContent = 'Ready when you are';
    ui.sub.textContent = 'Rounds of ship-to-ship combat. Shop between each one. Fly around while you wait.';
    ui.clock.textContent = '';
  } else if (phase === 'shop') {
    ui.title.textContent = `Round ${state.round} — outfitting`;
    ui.sub.textContent = me.ready
      ? 'Locked in. Waiting for the others.'
      : 'Take one from the draw, tier up as much as you like, or bank it all.';
    ui.clock.textContent = mmss(remaining);
    ui.shopScrap.textContent = `${Math.floor(me.scrap)} scrap`;
    ui.skipBtn.disabled = me.ready;
    renderCards(me);
    renderUpgradeMenu(me);
    const humans = [...state.players.values()].filter((p) => !p.isBot);
    const ready = humans.filter((p) => p.ready).length;
    ui.readyLine.textContent = humans.length > 1
      ? `${ready} of ${humans.length} ready`
      : '';
  } else if (phase === 'intermission') {
    ui.title.textContent = `Round ${state.round} complete`;
    ui.sub.textContent = 'Stipend paid. Next shop opens shortly.';
    ui.clock.textContent = mmss(remaining);
    renderScoreboard(state.players, room.sessionId);
  }

  // --- in-flight HUD ---
  // Hidden outside combat rather than left underneath the overlay: at 0.92
  // alpha it ghosts through as unreadable smudge, and every number on it
  // (round, clock, scrap) is already on the overlay itself. The reticle and
  // juice arc go with it — a crosshair over a shop screen is just noise.
  for (const el of [ui.banner, ui.scrapTag, ui.hullWrap, ui.weaponStrip, ui.killfeed, reticleEl]) {
    el.classList.toggle('hidden', !inCombat);
  }
  // the juice arc has a second reason to be hidden — no Juice Capacitor yet —
  // so it can't just ride along with the rest
  juiceSvg.classList.toggle('hidden', !inCombat || me.juiceMax < 1);
  ui.bannerRound.textContent = state.round > 0 ? `Round ${state.round}` : 'Lobby';
  ui.bannerPhase.textContent = phase;
  ui.bannerClock.textContent = state.phaseEndTick > 0 ? mmss(remaining) : '';
  ui.scrapTag.textContent = `${Math.floor(me.scrap)} scrap`;

  const hullFrac = me.maxHull > 0 ? me.hull / me.maxHull : 0;
  ui.hullLabel.textContent = me.godMode
    ? `hull ${Math.ceil(me.hull)}/${me.maxHull} [TEST MODE]`
    : `hull ${Math.ceil(me.hull)}/${me.maxHull}`;
  ui.hullFill.style.width = `${(hullFrac * 100).toFixed(1)}%`;
  ui.hullFill.className = hullFrac > 0.5 ? '' : (hullFrac > 0.25 ? 'hurt' : 'critical');

  const hullCurrent = document.getElementById('hull-current');
  if (hullCurrent) hullCurrent.textContent = String(Math.ceil(me.hull));
  if (godToggle && godToggle !== document.activeElement) godToggle.checked = Boolean(me.godMode);

  renderWeapons(me);
  renderHint(me);

  const dead = !me.alive && inCombat;
  ui.respawn.classList.toggle('hidden', !dead);
  if (dead) {
    const secs = Math.max(0, (me.respawnTick - estimatedTick()) * TICK_DT);
    ui.respawnSub.textContent = `respawning in ${Math.ceil(secs)}s`;
  }

  buildJuice(me.juiceMax);
}

function renderRoster(players, myId, listItems) {
  players.forEach((p, id) => {
    const li = listItems.get(id);
    if (!li) return;
    li.className = `${id === myId ? 'me' : ''} ${p.isBot ? 'bot' : ''} ${p.alive ? '' : 'dead'}`.trim();
    const label = id === myId ? `${p.name} (you)` : p.name;
    const text = `${label} ${p.kills}/${p.deaths}`;
    if (li.dataset.text !== text) {
      li.dataset.text = text;
      li.replaceChildren();
      const who = document.createElement('span');
      who.textContent = label;
      const score = document.createElement('span');
      score.className = 'score';
      score.textContent = `${p.kills}/${p.deaths}`;
      li.append(who, score);
    }
  });
}

// --- target boxes ----------------------------------------------------------
// A screen-space rectangle around every opponent, drawn as DOM over the
// canvas rather than as geometry inside it. Three reasons it isn't a sprite:
//
//   1. It must be visible when the SHIP isn't — through rocks, through the
//      moon, at any range. Anything in the scene graph gets depth-tested
//      against that geometry; a sibling of the canvas simply can't be
//      occluded by it.
//   2. Screen-space means screen-space. A billboard still shears and scales
//      with perspective at the edges of a 70° frustum; a div is axis-aligned
//      to the viewport by construction.
//   3. A 1px border stays 1px at any resolution, where a textured quad goes
//      soft the moment it's scaled up.
//
// A ship is ~2.4 units long in an arena 2,700 units across, so past a couple
// hundred units it's sub-pixel. The box is sized from the hull's true
// projected size with a pixel floor, so it tracks the ship when close and
// degrades into a findable marker when far.

// Must track SHIP_RADIUS in src/game/tuning.ts and SHIP_LENGTH above: the
// circle outlines what you actually have to hit.
const SHIP_BOUND_RADIUS = 2.2;
const WIDE_BORE_RADIUS_PER_TIER = 0.5;
const NAMETAG_GAP = 4;           // px between the top of the circle and the name
// How near an opponent has to be before an off-screen arrow appears for them.
// Not "every enemy, always": in a full room that's a permanent ring of
// arrows, which is the same as no arrows. This is roughly the range at which
// someone can reach you before you could turn and react.
const EDGE_ARROW_RANGE = 550;
const EDGE_ARROW_INSET = 26;     // px in from the frame edge

// Reused per frame rather than allocated per ship per frame.
const _toShip = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _ndc = new THREE.Vector3();
// One projection result, overwritten per ship per frame. Every overlay for a
// given ship is placed from it before the next ship is projected.
const _placed = { dist: 0, onScreen: false, x: 0, y: 0, half: 0, sx: 0, sy: 0 };

/**
 * Where one ship is, in everything the overlays need: screen position and
 * projected size when it's in frame, and a screen-space DIRECTION toward it
 * either way.
 *
 * The behind-camera case is why this returns a direction rather than just a
 * position. project() on a point behind the eye returns a mirrored on-screen
 * position, so anything that trusted it would paint a confident marker in
 * front of you while the real ship is at your back. The camera-space x/y
 * components, though, point the correct way whether the target is ahead or
 * behind — turn that way and you'll find it — which is exactly the question
 * an edge arrow answers.
 */
function projectTarget(worldPos, camera, w, h, hitRadius = SHIP_BOUND_RADIUS) {
  _toShip.copy(worldPos).sub(camera.position);
  _camFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
  _camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);

  _placed.dist = _toShip.length();
  _placed.sx = _toShip.dot(_camRight);
  _placed.sy = _toShip.dot(_camUp);

  const depth = _toShip.dot(_camFwd);
  if (depth <= 0) {
    _placed.onScreen = false;
    return _placed;
  }

  _ndc.copy(worldPos).project(camera);
  _placed.onScreen = Math.abs(_ndc.x) <= 1 && Math.abs(_ndc.y) <= 1;
  // Radius in pixels of a sphere of hitRadius at this depth.
  // Uses `depth` (the along-view distance), not the straight-line distance —
  // perspective divides by the view-space z, so using the hypotenuse would
  // undersize circles toward the edges of the frame.
  const halfFov = (camera.fov * Math.PI) / 360; // fov is vertical, in degrees
  const projected = (hitRadius / depth / Math.tan(halfFov)) * (h / 2);
  _placed.half = Math.max(1, projected);
  _placed.x = (_ndc.x * 0.5 + 0.5) * w;
  _placed.y = (-_ndc.y * 0.5 + 0.5) * h;
  return _placed;
}

function placeTargetBox(el, p) {
  el.style.width = `${p.half * 2}px`;
  el.style.height = `${p.half * 2}px`;
  el.style.transform = `translate(${p.x - p.half}px, ${p.y - p.half}px)`;
}

function placeNametag(el, p) {
  // sits on top of the box; the -50% centres the label on the ship, and has
  // to come after the pixel translate or it would be measured against the
  // viewport instead of the element
  el.style.transform =
    `translate(${p.x}px, ${p.y - p.half - NAMETAG_GAP}px) translate(-50%, -100%)`;
}

/**
 * Pin an arrow to the edge of the frame, pointing at something you can't see.
 *
 * Walks out from screen centre along the target's screen-space direction
 * until it meets the inset rectangle, which is what keeps the arrow ON the
 * border rather than on an ellipse inside it — corners are exactly where a
 * target that's behind-and-to-the-side ends up, and rounding them off puts
 * the arrow somewhere the enemy isn't.
 */
function placeEdgeArrow(entry, p, w, h) {
  let dx = p.sx;
  let dy = -p.sy; // world up is screen down
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) { dx = 0; dy = -1; } else { dx /= len; dy /= len; }

  const halfW = Math.max(1, w / 2 - EDGE_ARROW_INSET);
  const halfH = Math.max(1, h / 2 - EDGE_ARROW_INSET);
  const t = Math.min(halfW / Math.max(1e-6, Math.abs(dx)), halfH / Math.max(1e-6, Math.abs(dy)));
  const x = w / 2 + dx * t;
  const y = h / 2 + dy * t;

  entry.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  // The CSS triangle points up (screen -y), which is atan2(-1, 0) = -90deg,
  // so +90 brings the measured angle back into the triangle's frame.
  entry.tip.style.transform = `rotate(${(Math.atan2(dy, dx) * 180) / Math.PI + 90}deg)`;
}

// ---------------------------------------------------------------------------

async function startGame(room) {
  currentRoom = room;
  // null → cube / procedural-rock fallbacks
  const [shipTemplate, asteroidTemplate] = await Promise.all([shipTemplatePromise, asteroidTemplatePromise]);

  // fresh session: our predicted orientation starts at identity, same as the
  // server-side Player it's about to mirror
  predictedQuat.identity();
  lookSeq = 0;
  lookHistory = [];
  lookDX = 0;
  lookDY = 0;
  lastBatchTime = performance.now();

  // --- scene ---
  const canvas = document.getElementById('game');
  // logarithmicDepthBuffer is mandatory, not a nicety: the scene spans 0.1
  // units (a ship's nose) to 25,000 km (the star sphere), and a linear 24-bit
  // buffer over that range puts essentially all of its precision in the first
  // few metres — everything past the cockpit z-fights into confetti.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000); // real space is black; the stars do the work
  // Two grids, because one can't do both jobs. Toggled together with `g`.
  //
  // The FINE grid is the speed cue. Cell size is what you actually read
  // motion off — cells per second, not units per second — so it's sized
  // against cruise speed (maxWish) to land near 20 cells/s, the same rate the
  // original 2-unit grid gave at the original cruise of 40. A single 3 km
  // grid at 100 divisions is 30 units per cell, which is why flying felt like
  // standing still: 1.3 cells a second.
  //
  // The COARSE grid is the scale cue, and only that: it reaches out toward
  // the belt so the world doesn't visibly stop 200 units from spawn. Dropped
  // slightly below the fine grid so the two don't z-fight where they cross.
  const gridGroup = new THREE.Group();
  const fineGrid = new THREE.GridHelper(400, 100, 0x3a4470, 0x1a2040); // 4 units/cell
  const coarseGrid = new THREE.GridHelper(3000, 60, 0x2a3260, 0x151c38); // 50 units/cell
  coarseGrid.position.y = -0.05;
  gridGroup.add(fineGrid, coarseGrid);
  gridGroup.visible = false; // Turned off by default; press 'g' to toggle on
  scene.add(gridGroup);
  activeGrid = gridGroup;

  const distantStars = makeDistantStars();
  scene.add(distantStars);
  const planet = makePlanet();
  scene.add(planet);
  const sunMesh = makeSun();
  scene.add(sunMesh);

  const asteroids = ASTEROID_FIELD.map((spec) => {
    const mesh = makeAsteroid(asteroidTemplate, spec);
    scene.add(mesh);
    return { mesh, spec };
  });

  // The ship GLB and the asteroids use lit (Standard) materials — without
  // lights they render pure black. There is now a sun actually drawn in the
  // sky, so the key light has to point along SUN_DIR or the lit limb of every
  // rock disagrees with where the light visibly comes from.
  //
  // Ambient is deliberately almost nothing (0.02). Space has no sky bounce,
  // and the previous hemisphere light at 1.4 was what made everything read as
  // evenly-lit clay. The opposing fill at 1/50th of key is the entire budget
  // for "don't let the dark side go pure black" — cool blue against the warm
  // key, so a silhouetted ship still separates from the starfield.
  scene.add(new THREE.AmbientLight(0xffffff, 0.023)); // 0.02 +15%
  const SUN_INTENSITY = 2.8;
  const sunLight = new THREE.DirectionalLight(0xffeed6, SUN_INTENSITY);
  sunLight.position.copy(SUN_DIR);
  sunLight.target.position.set(0, 0, 0);
  scene.add(sunLight, sunLight.target);
  // /8, not the /50 this started at. Three.js applies a Lambertian 1/π to
  // diffuse (unconditional since r155), so these intensities are all worth
  // about a third of what they read as: the hull's lit side lands at ~123/255
  // and, at /50, its shadow side landed at ~17/255 — effectively black. The
  // hemisphere light this replaced was carrying the entire shadow side at
  // ~70-90/255, and dropping it cut that by ~18x.
  //
  // /8 puts the shadow side near 45/255: a ~2.7:1 key-to-fill ratio, so hulls
  // stay readable in silhouette without going back to the evenly-lit clay
  // look the hemisphere light gave. Lower the divisor for more drama, raise
  // it for more readability.
  const fill = new THREE.DirectionalLight(0x8ab4f8, SUN_INTENSITY / 8);
  fill.position.copy(SUN_DIR).negate();
  fill.target.position.set(0, 0, 0);
  scene.add(fill, fill.target);

  // far plane has to clear the star sphere at 16,000 km; the log buffer above
  // is what makes a range this wide survivable
  const camera = new THREE.PerspectiveCamera(BASE_FOV, canvas.clientWidth / canvas.clientHeight, 0.1, 25000000);

  // Canvas size changes on window resize AND on entering/leaving fullscreen;
  // without this the projection keeps the old aspect and everything stretches.
  // Cached CSS-pixel size of the canvas. The target-box loop needs it every
  // frame, and reading clientWidth/Height there would force a layout flush
  // per frame right before writing styles to those same boxes — the classic
  // read/write thrash. It only changes on resize, so it's cached here.
  const viewport = { w: 0, h: 0 };

  function handleResize() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return;
    viewport.w = width;
    viewport.h = height;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', handleResize);
  document.addEventListener('fullscreenchange', handleResize);
  handleResize();



  // --- one ship + one list entry per player ---
  const meshes = new Map(); // sessionId -> Object3D (ship clone or fallback cube)
  window.__game = { scene, meshes, room }; // debug hook for headless inspection
  const listItems = new Map(); // sessionId -> <li>
  // sessionId -> the three screen-space overlays for one opponent. They're
  // created together and placed together (exactly one of box+tag or arrow is
  // shown per frame), so they live in one entry rather than three maps.
  const overlays = new Map();
  const $ = Colyseus.getStateCallbacks(room);

  $(room.state).players.onAdd((player, sessionId) => {
    // clones share the template's geometry/materials — cheap per player
    const mesh = shipTemplate
      ? shipTemplate.clone(true)
      : new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshNormalMaterial());
    mesh.add(makeEngineGlow());
    // first-person: our own hull stays in the scene graph (it carries the
    // authoritative position the camera and weapons read) but is never drawn
    if (sessionId === room.sessionId) mesh.visible = false;
    scene.add(mesh);
    meshes.set(sessionId, mesh);

    // one set of overlays per opponent; never for ourselves
    if (sessionId !== room.sessionId) {
      const box = document.createElement('div');
      box.className = 'target-box hidden';
      ui.targetBoxes.appendChild(box);

      const tag = document.createElement('div');
      tag.className = 'nametag hidden';
      tag.textContent = player.name;
      ui.nametags.appendChild(tag);

      const arrow = document.createElement('div');
      arrow.className = 'edge-arrow hidden';
      const tip = document.createElement('div');
      tip.className = 'tip';
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = player.name;
      arrow.append(tip, who);
      ui.edgeArrows.appendChild(arrow);

      overlays.set(sessionId, { box, tag, el: arrow, tip });
    }

    const li = document.createElement('li');
    li.textContent = player.name;
    playerList.appendChild(li);
    listItems.set(sessionId, li);
  });

  $(room.state).players.onRemove((_player, sessionId) => {
    const mesh = meshes.get(sessionId);
    // ship clones share the template's geometry (never dispose it); only the
    // fallback cube owns its own geometry. The engine glow's material is
    // shared across every ship, so it outlives any one of them too.
    if (mesh) { scene.remove(mesh); mesh.geometry?.dispose(); }
    meshes.delete(sessionId);
    const overlay = overlays.get(sessionId);
    if (overlay) {
      if (overlay.box._hitTimer) clearTimeout(overlay.box._hitTimer);
      overlay.box.remove();
      overlay.tag.remove();
      overlay.el.remove();
    }
    overlays.delete(sessionId);
    listItems.get(sessionId)?.remove();
    listItems.delete(sessionId);
  });

  // --- shots: the schema replicates only BIRTH state (kind, origin, dir,
  // spawnTick, param); each frame we hand the age to the weapon's FX module,
  // which places it analytically on the shared tick timeline. Zero ongoing
  // patches, perfectly smooth. See public/weapon-fx.js for the contract.
  const shots = new Map(); // id -> { mesh, origin, dir, param, mine, kind }

  $(room.state).shots.onAdd((shot, id) => {
    const fx = SHOT_FX[shot.kind];
    if (!fx) return; // a weapon whose FX aren't implemented yet
    const mine = shot.shooter === room.sessionId;
    const origin = new THREE.Vector3(shot.ox, shot.oy, shot.oz);
    const built = fx.create({
      origin,
      dir: new THREE.Vector3(shot.dx, shot.dy, shot.dz),
      param: shot.param,
      mine,
      viewQuat: predictedQuat,
    });
    scene.add(built.mesh);
    shots.set(id, {
      ...built, param: shot.param, kind: shot.kind, spawnTick: shot.spawnTick,
      mine, shooter: shot.shooter, attach: fx.attach === true,
    });
    // Fired off the replicated shot rather than off our own trigger press:
    // the server may have dropped the pull for cooldown, and a gun that
    // clicks when it didn't actually shoot teaches the wrong cadence. Our
    // own shots skip attenuation so they stay at the front of the mix.
    playSound(shot.kind, mine ? undefined : camera.position.distanceTo(origin));
  });

  $(room.state).shots.onRemove((_shot, id) => {
    const entry = shots.get(id);
    if (!entry) return;
    shots.delete(id);
    scene.remove(entry.mesh);
    SHOT_FX[entry.kind]?.expire?.(entry, scene);
  });

  // --- blasts: cosmetic only. Damage was applied server-side on the tick
  // this spawned; the shell is drawn at the true radius so players can learn
  // to judge the area.
  const blasts = new Map(); // id -> { mesh, radius, spawnTick }
  const activeOneShots = new Set();

  $(room.state).blasts.onAdd((blast, id) => {
    const blastPos = new THREE.Vector3(blast.x, blast.y, blast.z);
    playSound(
      blast.kind === 'death' ? 'death' : 'blast',
      camera.position.distanceTo(blastPos)
    );

    if (blast.kind === 'death') {
      const config = getActiveExplosionConfig();
      const oneShot = spawnOneShotExplosion(scene, blastPos, config);
      activeOneShots.add(oneShot);
      return;
    }

    const mesh = createBlast(blast.radius, blast.kind);
    mesh.position.copy(blastPos);
    scene.add(mesh);
    blasts.set(id, {
      mesh, radius: blast.radius, kind: blast.kind, spawnTick: blast.spawnTick,
    });
  });

  $(room.state).blasts.onRemove((_blast, id) => {
    const entry = blasts.get(id);
    if (!entry) return;
    blasts.delete(id);
    scene.remove(entry.mesh);
    disposeBlast(entry.mesh);
  });

  $(room.state).listen('tick', (tick) => { tickBase = { tick, at: performance.now() }; });

  // --- temporary drag tuner display: server owns the value ---
  const dragCurrent = document.getElementById('drag-current');
  $(room.state).listen('drag', (value) => { dragCurrent.textContent = value.toFixed(2); });

  // --- bot count tuner display: server owns the value ---
  const botsCurrent = document.getElementById('bots-current');
  const updateBotUi = (val) => {
    if (botsCurrent) botsCurrent.textContent = String(val);
    if (ui.botSelect && ui.botSelect.value !== String(val)) ui.botSelect.value = String(val);
    if (botsInput && document.activeElement !== botsInput) botsInput.value = String(val);
  };
  if (room.state.botCount !== undefined) updateBotUi(room.state.botCount);
  $(room.state).listen('botCount', (value) => { updateBotUi(value); });

  // a rejected purchase (raced someone to the last of your scrap, say) comes
  // back as a message rather than silently doing nothing
  room.onMessage('shopError', (reason) => { status.textContent = `can't buy that: ${reason}`; });

  // One per point of damage WE dealt. Not inferrable client-side: the server
  // resolves hits against a lag-compensated rewind of the world, which by
  // definition isn't the world this client drew.
  room.onMessage('hit', (msg) => {
    flashHitmarker(msg.killed);
    playSound(msg.killed ? 'killmark' : 'hitmark');

    // Temporarily color the red HUD box around the hit ship green for 0.33s
    let target = msg?.victimId ? overlays.get(msg.victimId) : null;
    if (!target && msg?.victim) {
      for (const [id, ov] of overlays) {
        const p = room.state.players?.get(id);
        if (p?.name === msg.victim) {
          target = ov;
          break;
        }
      }
    }
    if (target?.box) flashHitBox(target.box);
  });

  room.onMessage('kill', (msg) => pushKillfeed(msg, room.sessionId));

  let running = true; // render loop checks this before scheduling another frame
  room.onLeave(() => {
    running = false;
    currentRoom = null;
    activeGrid = null;
    stopEngineLoop();
    held.clear();
    releaseTrigger();
    // registered per session in startGame, so they have to come back off or
    // every rejoin stacks another pair onto a renderer that no longer exists
    window.removeEventListener('resize', handleResize);
    document.removeEventListener('fullscreenchange', handleResize);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (document.pointerLockElement) document.exitPointerLock();
    meshes.forEach((mesh) => { scene.remove(mesh); mesh.geometry?.dispose(); });
    meshes.clear();
    shots.forEach(({ mesh }) => scene.remove(mesh));
    shots.clear();
    blasts.forEach(({ mesh }) => { scene.remove(mesh); disposeBlast(mesh); });
    blasts.clear();
    disposeFx();
    activeOneShots.forEach((oneShot) => oneShot.dispose());
    activeOneShots.clear();
    overlays.clear();
    ui.targetBoxes.replaceChildren();
    ui.nametags.replaceChildren();
    ui.edgeArrows.replaceChildren();
    ui.killfeed.replaceChildren();
    listItems.clear();
    playerList.innerHTML = '';
    renderer.dispose();
    lobbyDiv.classList.add('hidden');
    form.classList.remove('hidden');
    status.textContent = 'disconnected — enter a name to rejoin';
  });

  // UI runs on its own slow timer. Nothing in it benefits from 60Hz, and
  // rebuilding shop cards every frame would make them impossible to click.
  const uiTimer = setInterval(() => {
    if (!running) { clearInterval(uiTimer); return; }
    if (room.state.players) syncUi(room);
  }, 100);

  // --- render loop: copy server state onto meshes, first-person camera ---
  let lastFrame = performance.now();
  let fpsFrames = 0;
  let lastFpsTime = performance.now();
  let currentFps = 60;

  function render() {
    if (!running) return;
    const frameNow = performance.now();
    const frameDt = Math.min(0.1, (frameNow - lastFrame) / 1000); // clamped: tab-out
    lastFrame = frameNow;

    // Track FPS over a rolling 250ms window so readout is steady and readable
    fpsFrames++;
    if (frameNow - lastFpsTime >= 250) {
      currentFps = Math.round((fpsFrames * 1000) / (frameNow - lastFpsTime));
      fpsFrames = 0;
      lastFpsTime = frameNow;
      if (ui.fpsTag) ui.fpsTag.textContent = `${currentFps} FPS`;
    }

    // Flush mouse look and roll directly on this frame so camera rotation runs
    // at the display's native refresh rate (60Hz, 120Hz, 144Hz, 240Hz) with zero timer jitter.
    flushLookBatch(frameNow);

    // Extrapolate positions since the latest server patch so ships and camera
    // glide smoothly at the display's native refresh rate instead of teleporting
    // at the network tick rate.
    const patchAge = Math.max(0, Math.min(0.1, (frameNow - tickBase.at) / 1000));
    room.state.players?.forEach((p, sessionId) => {
      const mesh = meshes.get(sessionId);
      if (!mesh) return;
      mesh.position.set(
        p.x + p.vx * patchAge,
        p.y + p.vy * patchAge,
        p.z + p.vz * patchAge
      );
      mesh.quaternion.set(p.qx, p.qy, p.qz, p.qw);
      // a destroyed ship stops being drawn even though it keeps drifting as a
      // wreck server-side — otherwise you'd keep shooting at a corpse
      if (sessionId !== room.sessionId) mesh.visible = p.alive;
    });

    const nowTick = estimatedTick();

    blasts.forEach((entry) => {
      updateBlast(
        entry.mesh, entry.radius,
        Math.max(0, (nowTick - entry.spawnTick) * TICK_DT), entry.kind
      );
    });

    // Active one-shot explosions (e.g. ship deaths)
    activeOneShots.forEach((oneShot) => {
      if (!oneShot.step(frameDt)) {
        activeOneShots.delete(oneShot);
      }
    });

    // Asteroids drift and tumble as pure functions of the shared tick, so
    // every client sees the identical field with nothing replicated. Drift is
    // sinusoidal (bounded — rocks orbit their home position, never wander
    // off), tumble is a constant spin; both slow down as the rock gets bigger.
    // MUST match asteroidCenters() in src/game/tuning.ts, which is what the
    // server collides ships and shots against.
    const tSec = nowTick * TICK_DT;
    asteroids.forEach(({ mesh, spec }) => {
      const { p0, driftAmp: a, driftFreq: f, driftPhase: ph, rot0, rotV } = spec;
      mesh.position.set(
        p0[0] + a[0] * Math.sin(tSec * f[0] + ph[0]),
        p0[1] + a[1] * Math.sin(tSec * f[1] + ph[1]),
        p0[2] + a[2] * Math.cos(tSec * f[2] + ph[2])
      );
      mesh.rotation.set(
        rot0[0] + tSec * rotV[0],
        rot0[1] + tSec * rotV[1],
        rot0[2] + tSec * rotV[2]
      );
    });

    const myState = room.state.players?.get(room.sessionId);
    let speed = 0;
    if (myState) {
      reconcileLook(myState);
      renderJuice(myState.juice);
      noteJuice(myState.juice);
      speed = Math.hypot(myState.vx, myState.vy, myState.vz);
      ui.hud.textContent = `speed ${speed.toFixed(1)} · ${currentFps} FPS`;
      renderRoster(room.state.players, room.sessionId, listItems);
    } else {
      ui.hud.textContent = `speed 0.0 · ${currentFps} FPS`;
    }
    renderSpeedFx(camera, canvas, speed, frameDt);

    const me = meshes.get(room.sessionId);
    if (me) {
      // first-person: camera sits AT the ship, wearing the PREDICTED
      // orientation (position smoothly extrapolated from velocity) so looking around
      // has zero latency; everyone else's mesh keeps the replicated quat
      me.quaternion.copy(predictedQuat);
      camera.position.copy(me.position);
      camera.quaternion.copy(predictedQuat);
    }

    // Shots are stepped AFTER the hulls are placed, because an attached shot
    // (the ram dome) is welded to one of them — updating it first would hang
    // the dome a frame behind the ship it's supposed to be part of, which at
    // these speeds is a visible gap between the field and the bow. Free-flying
    // shots don't care either way; they're placed analytically off `age`.
    shots.forEach((entry) => {
      if (entry.attach) {
        const host = meshes.get(entry.shooter);
        // the shooter can leave while their dome is still up; the server
        // drops it on the next tick, and until then it just stops tracking
        if (host) {
          entry.mesh.position.copy(host.position);
          entry.mesh.quaternion.copy(host.quaternion);
        }
      }
      SHOT_FX[entry.kind]?.update(entry, Math.max(0, (nowTick - entry.spawnTick) * TICK_DT));
    });

    // Target boxes, projected against the camera that was just placed above.
    // Doing this before the camera moves would leave every box a frame behind
    // its ship, which at these speeds reads as the box lagging on a string.
    // canvas.clientWidth/Height rather than the renderer's buffer size, since
    // these are CSS pixels laid over the canvas — the two differ under
    // devicePixelRatio and in fullscreen.
    if (overlays.size > 0) {
      // project() reads camera.matrixWorldInverse, which the renderer only
      // refreshes inside render(). Without this the boxes would be projected
      // against LAST frame's camera — precisely the one-frame lag on a string
      // that placing them here is meant to avoid.
      camera.updateMatrixWorld();
      const { w, h } = viewport;
      const myState = room.state.players?.get(room.sessionId);
      const boreTier = myState?.tech?.get ? (myState.tech.get('railBore') ?? 0) : 0;
      const hitRadius = SHIP_BOUND_RADIUS + WIDE_BORE_RADIUS_PER_TIER * boreTier;

      overlays.forEach((overlay, sessionId) => {
        const mesh = meshes.get(sessionId);
        // mesh.visible already encodes "alive" for opponents, so a wreck
        // stops being marked without a second aliveness check here
        if (!mesh?.visible) {
          overlay.box.classList.add('hidden');
          overlay.tag.classList.add('hidden');
          overlay.el.classList.add('hidden');
          return;
        }

        const placed = projectTarget(mesh.position, camera, w, h, hitRadius);
        // Exactly one of the two treatments, never both: a box and an arrow
        // for the same ship at the same time is two answers to one question.
        const boxed = placed.onScreen;
        const arrowed = !boxed && placed.dist <= EDGE_ARROW_RANGE;

        if (boxed) {
          placeTargetBox(overlay.box, placed);
          placeNametag(overlay.tag, placed);
        } else if (arrowed) {
          placeEdgeArrow(overlay, placed, w, h);
        }
        overlay.box.classList.toggle('hidden', !boxed);
        overlay.tag.classList.toggle('hidden', !boxed);
        overlay.el.classList.toggle('hidden', !arrowed);
      });
    }

    planet.rotation.y += 0.0003; // slow spin, purely cosmetic

    // The sun and the star sphere are meant to be infinitely far away, so they
    // ride the camera: re-centring them every frame holds their angular size
    // and kills all parallax, which is exactly how something at 14,000 km
    // behaves. Do this AFTER the camera has been placed, or they lag a frame.
    // The moon is deliberately left alone — the sliver of parallax it does
    // have at 5,500 km is the only long-range cue that you're moving at all.
    distantStars.position.copy(camera.position);
    sunMesh.position.copy(camera.position).addScaledVector(SUN_DIR, SUN_DISTANCE);

    renderer.render(scene, camera);
    requestAnimationFrame(render);
  }
  render();
}
