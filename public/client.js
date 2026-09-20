import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  SHOT_FX, createBlast, disposeBlast, disposeFx, updateBlast,
} from './weapon-fx.js';

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
const WEAPON_ORDER = [
  { id: 'bolt', name: 'Bolt Cannon' },
  { id: 'rail', name: 'Railgun' },
  { id: 'flak', name: 'Flak Launcher' },
];

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;

  status.textContent = 'connecting...';
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

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return; // typing in a form, not flying
  if (e.key === ' ') {
    e.preventDefault(); // don't scroll the page or "click" a focused button
    // seq lets the server aim with exactly the orientation we predicted;
    // tick names the world we were looking at, for lag-compensated weapons
    if (!e.repeat) currentRoom?.send('fire', { seq: lookSeq, tick: Math.round(estimatedTick()) });
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
  if (TRACKED.has(key) && !held.has(key)) { held.add(key); sendInput(); }
});
window.addEventListener('keyup', (e) => {
  const key = e.key.toLowerCase();
  if (TRACKED.has(key)) { held.delete(key); sendInput(); }
});

// Mouse wheel dials the fuse distance for weapons that detonate at a set
// range. Tracked optimistically so the readout responds instantly; the server
// clamps and replicates the authoritative value back.
let fuse = 40;
const FUSE_STEP = 5;
window.addEventListener('wheel', (e) => {
  if (!currentRoom || document.pointerLockElement !== gameCanvas) return;
  e.preventDefault();
  fuse = Math.max(5, Math.min(200, fuse - Math.sign(e.deltaY) * FUSE_STEP));
  currentRoom.send('setFuse', fuse);
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
gameCanvas.addEventListener('click', () => {
  // only grab the pointer when there's actually flying to do — during the
  // shop the overlay needs real clicks
  if (currentRoom && !overlayVisible) gameCanvas.requestPointerLock();
});
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
setInterval(() => {
  const nowMs = performance.now();
  const dt = (nowMs - lastBatchTime) / 1000;
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
  if (lookHistory.length > 128) lookHistory.shift();
  currentRoom.send('look', batch);
}, LOOK_INTERVAL);

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
const BASE_FOV = 70;
const FOV_GAIN = 6;        // degrees of extra FOV at full speed
const SPEED_FX_LO = 10;    // units/s where the speed cue starts appearing
const SPEED_FX_HI = 55;    // ...and where it's fully applied
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
  if (lastJuice !== null && juice < lastJuice - 0.5) dashFx = 1;
  lastJuice = juice;
}

function renderSpeedFx(camera, canvas, speed, dt) {
  // smoothed: velocity is only patched in at the server's rate, and feeding
  // that to the FOV raw makes it judder
  const target = Math.min(1, Math.max(0, (speed - SPEED_FX_LO) / (SPEED_FX_HI - SPEED_FX_LO)));
  speedFx += (target - speedFx) * Math.min(1, dt * 6);
  const fov = BASE_FOV + FOV_GAIN * speedFx;
  if (Math.abs(fov - camera.fov) > 0.01) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
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
// units — centered, ~2.4 long, nose along -Z — so the OUTER group can wear
// the replicated quaternion/position directly.
const shipTemplatePromise = new GLTFLoader().loadAsync('/models/orion.glb')
  .then((gltf) => {
    const model = gltf.scene;
    // no backface culling: parts of the hull are modeled single-sided and
    // vanish from some viewing angles with culling on
    model.traverse((o) => { if (o.isMesh) o.material.side = THREE.DoubleSide; });
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    model.position.copy(center).multiplyScalar(-1);
    const norm = new THREE.Group();
    norm.rotation.y = Math.PI;
    norm.scale.setScalar(2.4 / size.z);
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

// Hardcoded so every client sees the identical rocks. r = approximate radius
// in units. DUPLICATED in src/game/tuning.ts, which collides ships against
// these same spheres — the two lists MUST stay in step or the server will
// stop you against a rock you can't see.
const ASTEROID_FIELD = [
  { p: [-40, 10, -80], r: 12, seed: 1 },
  { p: [25, -15, -50], r: 7, seed: 2 },
  { p: [-70, -20, 40], r: 16, seed: 3 },
  { p: [80, 30, 60], r: 9, seed: 4 },
  { p: [0, 42, -120], r: 14, seed: 5 },
  { p: [45, -35, -20], r: 6, seed: 6 },
];

function makeAsteroid(template, { p, r, seed }) {
  if (template) {
    const mesh = template.clone(true); // shares geometry/material
    mesh.scale.setScalar(r);
    mesh.position.set(p[0], p[1], p[2]);
    mesh.rotation.set(seed * 1.3, seed * 2.1, seed * 0.7); // varied resting pose
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
  mesh.position.set(p[0], p[1], p[2]);
  mesh.rotation.set(seed * 1.3, seed * 2.1, seed * 0.7); // varied resting pose
  return mesh;
}

function makePlanet() {
  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(50, 48, 32),
    new THREE.MeshBasicMaterial({ map: makeJupiterTexture() })
  );
  planet.position.set(60, 25, -160); // off to the side so nobody spawns inside it
  return planet;
}

// random points filling a spherical shell around the origin, so there's
// always something nearby drifting past to make our own motion visible
function makeStarfield(count = 2000, rMin = 20, rMax = 160) {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // uniform random direction on the sphere
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * 2 * Math.PI;
    const s = Math.sqrt(1 - u * u);
    // cube-root keeps density uniform through the shell's volume
    const r = Math.cbrt(rMin ** 3 + Math.random() * (rMax ** 3 - rMin ** 3));
    positions[i * 3] = r * s * Math.cos(theta);
    positions[i * 3 + 1] = r * u;
    positions[i * 3 + 2] = r * s * Math.sin(theta);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  // sizeAttenuation shrinks distant points — the resulting parallax is
  // what actually sells the sense of speed
  const material = new THREE.PointsMaterial({ color: 0x9fb4ff, size: 0.4, sizeAttenuation: true });
  return new THREE.Points(geometry, material);
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
};

// Gate for the canvas click handler: while any overlay is up, clicks belong
// to the UI, not to pointer lock.
let overlayVisible = true;

ui.startBtn.addEventListener('click', () => currentRoom?.send('startGame'));
ui.skipBtn.addEventListener('click', () => currentRoom?.send('skip'));

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
    button.addEventListener('click', () => currentRoom?.send('buy', { id: card.id }));

    el.append(kind, name, blurb, cost, button);
    ui.cards.appendChild(el);
  });
}

function renderScoreboard(players, myId) {
  const rows = [...players.entries()].sort((a, b) => b[1].kills - a[1].kills);
  ui.scoreboard.replaceChildren();
  const head = document.createElement('tr');
  for (const [label, cls] of [['ship', 'who'], ['kills', ''], ['deaths', ''], ['scrap earned', '']]) {
    const th = document.createElement('th');
    th.textContent = label;
    if (cls) th.className = cls;
    head.appendChild(th);
  }
  ui.scoreboard.appendChild(head);
  for (const [id, p] of rows) {
    const tr = document.createElement('tr');
    tr.className = id === myId ? 'me' : (p.isBot ? 'bot' : '');
    for (const [text, cls] of [[p.name, 'who'], [p.kills, ''], [p.deaths, ''], [Math.floor(p.roundScrap), '']]) {
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
    // bolt is owned from the start and never appears in `tech` as a purchase
    const owned = w.id === 'bolt' || (me.tech.get(w.id) ?? 0) > 0;
    if (!owned) return;
    const row = document.createElement('div');
    row.className = `w${me.weapon === w.id ? ' active' : ''}`;
    row.innerHTML = `<span class="key">${i + 1}</span> ${w.name}`;
    ui.weaponList.appendChild(row);
  });
  // the fuse readout is only meaningful to weapons that detonate at a range
  ui.fuseTag.classList.toggle('hidden', me.weapon !== 'flak');
  ui.fuseTag.textContent = `fuse ${Math.round(me.fuse)} · wheel to adjust`;
}

function renderHint(me) {
  const parts = [
    'click canvas to capture mouse',
    'mouse: yaw/pitch',
    'q/e: roll',
    'w/s: fwd/back',
  ];
  if ((me.tech.get('lateral') ?? 0) > 0) parts.push('a/d: strafe');
  if (me.juiceMax > 0) parts.push('shift: dash');
  parts.push('space: fire');
  if ((me.tech.get('rail') ?? 0) > 0 || (me.tech.get('flak') ?? 0) > 0) parts.push('1-3: weapon');
  parts.push('esc: release mouse');
  const text = parts.join('   ');
  if (ui.hint.textContent !== text) ui.hint.textContent = text;
}

/**
 * One pass over replicated state → DOM. Called on a ~10Hz timer rather than
 * per frame: none of this needs 60Hz, and rebuilding cards that often would
 * make them unclickable.
 */
function syncUi(room) {
  const state = room.state;
  const me = state.players?.get(room.sessionId);
  if (!me) return;
  const phase = state.phase;
  const inCombat = phase === 'combat';

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
      : 'Buy one, or skip and save toward something bigger.';
    ui.clock.textContent = mmss(remaining);
    ui.shopScrap.textContent = `${Math.floor(me.scrap)} scrap`;
    ui.skipBtn.disabled = me.ready;
    renderCards(me);
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
  for (const el of [ui.banner, ui.scrapTag, ui.hullWrap, ui.weaponStrip, reticleEl]) {
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
  ui.hullLabel.textContent = `hull ${Math.ceil(me.hull)}/${me.maxHull}`;
  ui.hullFill.style.width = `${(hullFrac * 100).toFixed(1)}%`;
  ui.hullFill.className = hullFrac > 0.5 ? '' : (hullFrac > 0.25 ? 'hurt' : 'critical');

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
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e1a);
  scene.add(new THREE.GridHelper(200, 100, 0x3a4470, 0x1a2040)); // spatial reference
  scene.add(makeStarfield());
  const planet = makePlanet();
  scene.add(planet);
  const asteroids = ASTEROID_FIELD.map((spec) => {
    const mesh = makeAsteroid(asteroidTemplate, spec);
    scene.add(mesh);
    return { mesh, spec };
  });

  // the ship GLB and asteroids use lit (Standard) materials — without lights
  // they render pure black. Hemisphere + a weak opposing fill keep every
  // viewing angle readable (a lone directional left ships in silhouette from
  // the shadowed side). Basic-material scenery (starfield, planet, shots)
  // ignores these.
  scene.add(new THREE.HemisphereLight(0xbdc9ff, 0x4a4038, 1.4));
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
  sun.position.set(60, 80, -40);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x99aaff, 0.7);
  fill.position.set(-50, -30, 60);
  scene.add(fill);

  const camera = new THREE.PerspectiveCamera(70, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);

  // --- one ship + one list entry per player ---
  const meshes = new Map(); // sessionId -> Object3D (ship clone or fallback cube)
  window.__game = { scene, meshes, room }; // debug hook for headless inspection
  const listItems = new Map(); // sessionId -> <li>
  const $ = Colyseus.getStateCallbacks(room);

  $(room.state).players.onAdd((player, sessionId) => {
    // clones share the template's geometry/materials — cheap per player
    const mesh = shipTemplate
      ? shipTemplate.clone(true)
      : new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshNormalMaterial());
    // first-person: our own hull stays in the scene graph (it carries the
    // authoritative position the camera and weapons read) but is never drawn
    if (sessionId === room.sessionId) mesh.visible = false;
    scene.add(mesh);
    meshes.set(sessionId, mesh);

    const li = document.createElement('li');
    li.textContent = player.name;
    playerList.appendChild(li);
    listItems.set(sessionId, li);
  });

  $(room.state).players.onRemove((_player, sessionId) => {
    const mesh = meshes.get(sessionId);
    // ship clones share the template's geometry (never dispose it); only the
    // fallback cube owns its own geometry
    if (mesh) { scene.remove(mesh); mesh.geometry?.dispose(); }
    meshes.delete(sessionId);
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
    const built = fx.create({
      origin: new THREE.Vector3(shot.ox, shot.oy, shot.oz),
      dir: new THREE.Vector3(shot.dx, shot.dy, shot.dz),
      param: shot.param,
      mine: shot.shooter === room.sessionId,
      viewQuat: predictedQuat,
    });
    scene.add(built.mesh);
    shots.set(id, {
      ...built, param: shot.param, kind: shot.kind, spawnTick: shot.spawnTick,
      mine: shot.shooter === room.sessionId,
    });
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

  $(room.state).blasts.onAdd((blast, id) => {
    const mesh = createBlast(blast.radius);
    mesh.position.set(blast.x, blast.y, blast.z);
    scene.add(mesh);
    blasts.set(id, { mesh, radius: blast.radius, spawnTick: blast.spawnTick });
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

  // a rejected purchase (raced someone to the last of your scrap, say) comes
  // back as a message rather than silently doing nothing
  room.onMessage('shopError', (reason) => { status.textContent = `can't buy that: ${reason}`; });

  let running = true; // render loop checks this before scheduling another frame
  room.onLeave(() => {
    running = false;
    currentRoom = null;
    held.clear();
    if (document.pointerLockElement) document.exitPointerLock();
    meshes.forEach((mesh) => { scene.remove(mesh); mesh.geometry?.dispose(); });
    meshes.clear();
    shots.forEach(({ mesh }) => scene.remove(mesh));
    shots.clear();
    blasts.forEach(({ mesh }) => { scene.remove(mesh); disposeBlast(mesh); });
    blasts.clear();
    disposeFx();
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
  function render() {
    if (!running) return;
    // state arrives shortly *after* joinOrCreate resolves — skip until synced
    room.state.players?.forEach((p, sessionId) => {
      const mesh = meshes.get(sessionId);
      if (!mesh) return;
      mesh.position.set(p.x, p.y, p.z);
      mesh.quaternion.set(p.qx, p.qy, p.qz, p.qw);
      // a destroyed ship stops being drawn even though it keeps drifting as a
      // wreck server-side — otherwise you'd keep shooting at a corpse
      if (sessionId !== room.sessionId) mesh.visible = p.alive;
    });

    const nowTick = estimatedTick();

    shots.forEach((entry) => {
      SHOT_FX[entry.kind]?.update(entry, Math.max(0, (nowTick - entry.spawnTick) * TICK_DT));
    });
    blasts.forEach((entry) => {
      updateBlast(entry.mesh, entry.radius, Math.max(0, (nowTick - entry.spawnTick) * TICK_DT));
    });

    // asteroids drift and tumble as pure functions of the shared tick, so
    // every client sees the identical field. Drift is sinusoidal (bounded —
    // rocks orbit their home position, never wander off), tumble is a slow
    // constant spin; both rates vary per rock via its seed.
    const tSec = nowTick * TICK_DT;
    asteroids.forEach(({ mesh, spec }) => {
      const { p, seed } = spec;
      mesh.position.set(
        p[0] + 3 * Math.sin(tSec * 0.05 + seed * 7),
        p[1] + 3 * Math.sin(tSec * 0.04 + seed * 13),
        p[2] + 3 * Math.sin(tSec * 0.06 + seed * 3)
      );
      mesh.rotation.set(
        seed * 1.3 + tSec * 0.03 * Math.sin(seed * 5),
        seed * 2.1 + tSec * 0.05 * Math.cos(seed * 9),
        seed * 0.7 + tSec * 0.02 * Math.sin(seed * 2)
      );
    });

    const frameNow = performance.now();
    const frameDt = Math.min(0.1, (frameNow - lastFrame) / 1000); // clamped: tab-out
    lastFrame = frameNow;

    const myState = room.state.players?.get(room.sessionId);
    let speed = 0;
    if (myState) {
      reconcileLook(myState);
      renderJuice(myState.juice);
      noteJuice(myState.juice);
      speed = Math.hypot(myState.vx, myState.vy, myState.vz);
      ui.hud.textContent = `speed ${speed.toFixed(1)}`;
      renderRoster(room.state.players, room.sessionId, listItems);
    }
    renderSpeedFx(camera, canvas, speed, frameDt);

    const me = meshes.get(room.sessionId);
    if (me) {
      // first-person: camera sits AT the ship, wearing the PREDICTED
      // orientation (position stays server-authoritative) so looking around
      // has zero latency; everyone else's mesh keeps the replicated quat
      me.quaternion.copy(predictedQuat);
      camera.position.copy(me.position);
      camera.quaternion.copy(predictedQuat);
    }

    planet.rotation.y += 0.0003; // slow spin, purely cosmetic

    renderer.render(scene, camera);
    requestAnimationFrame(render);
  }
  render();
}
