import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// This client implements the 'mouse' control scheme — CONTROL_SCHEME in
// src/rooms/LobbyRoom.ts must be set to 'mouse'. The older keyboard schemes
// ('flight', 'strafe') are archived in legacy/client-keyboard-controls.js.

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
// rejoining after being shot down never double-registers handlers.
let currentRoom = null;

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

// --- keyboard input: thrust goes to the server as {moveZ}; roll is folded
// into look batches below so the whole orientation stays predictable ---
const TRACKED = new Set(['w', 's', 'a', 'd', 'q', 'e']);
const held = new Set();
const axis = (pos, neg) => (held.has(pos) ? 1 : 0) - (held.has(neg) ? 1 : 0);
const sendInput = () => currentRoom?.send('input', {
  moveZ: axis('w', 's'), // forward/backward thrust
  moveX: axis('d', 'a'), // lateral strafe thrust
});
document.getElementById('controls-hint').textContent =
  'click canvas to capture mouse   mouse: yaw/pitch   q/e: roll   w/s: fwd/back   a/d: strafe   space: fire   esc: release mouse';
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return; // typing in a form, not flying
  if (e.key === ' ') {
    e.preventDefault(); // don't scroll the page or "click" a focused button
    // seq lets the server aim with exactly the orientation we predicted
    if (!e.repeat) currentRoom?.send('fire', { seq: lookSeq });
    return;
  }
  const key = e.key.toLowerCase();
  if (TRACKED.has(key) && !held.has(key)) { held.add(key); sendInput(); }
});
window.addEventListener('keyup', (e) => {
  const key = e.key.toLowerCase();
  if (TRACKED.has(key)) { held.delete(key); sendInput(); }
});

// --- optimistic look: our own orientation, applied locally the instant the
// input happens and reproduced by the server from the same batches ---
//
// Every LOOK_INTERVAL ms the accumulated mouse deltas plus dt's worth of held
// roll become one sequence-numbered batch. We fold it into predictedQuat
// immediately (zero-latency camera) and send the identical batch to the
// server, which folds it identically — orientation is a deterministic fold
// of the batch stream, so prediction shouldn't ever miss. The batch history
// is kept so that if server and prediction do disagree at the same seq
// (dropped state, a bug), we rebase onto the server quat and replay.
//
// MOUSE_SENS / ROLL_RATE and the yaw→pitch→roll order MUST match
// src/rooms/LobbyRoom.ts.
const MOUSE_SENS = 0.002;
const ROLL_RATE = 90 * (Math.PI / 180);
const LOOK_INTERVAL = 33;
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
  if (currentRoom) gameCanvas.requestPointerLock();
});
let lookDX = 0, lookDY = 0;
window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === gameCanvas) {
    lookDX += e.movementX;
    lookDY += e.movementY;
  }
});
let lastBatchTime = performance.now();
setInterval(() => {
  const nowMs = performance.now();
  const dt = (nowMs - lastBatchTime) / 1000;
  lastBatchTime = nowMs;
  if (!currentRoom) { lookDX = 0; lookDY = 0; return; }
  const roll = axis('e', 'q') * ROLL_RATE * dt;
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
document.getElementById('drag-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = parseFloat(dragInput.value);
  if (Number.isFinite(value)) currentRoom?.send('setDrag', value);
  dragInput.value = '';
  dragInput.blur(); // give the keyboard back to flight controls
});

// Decode the angular-velocity quaternion (a local-frame rotation per second)
// into roll/pitch rates in rad/s. Axis-angle form gives the spin vector ω;
// projecting ω onto the ship's local forward/right axes — the same axes the
// inputs torque — recovers the individual rates.
function spinRates(x, y, z, w) {
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; } // same rotation, canonical sign
  const s = Math.sqrt(Math.max(0, 1 - w * w));   // = sin(angle/2)
  if (s < 1e-6) return { roll: 0, pitch: 0 };
  const angle = 2 * Math.acos(Math.min(1, w));   // rad/s
  // axis = (x,y,z)/s; roll is about local forward (0,0,-1), pitch about local right (1,0,0)
  return { roll: (-z / s) * angle, pitch: (x / s) * angle };
}
const RAD2DEG = 180 / Math.PI;

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

// The asteroid field is scenery only (no server collision) and hardcoded so
// every client sees the identical rocks. r = approximate radius in units.
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
  const hud = document.getElementById('hud');
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
  // the shadowed side). Basic-material scenery (starfield, planet, bolts)
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
    // authoritative position the camera and lasers read) but is never drawn
    if (sessionId === room.sessionId) mesh.visible = false;
    scene.add(mesh);
    meshes.set(sessionId, mesh);

    const li = document.createElement('li');
    li.textContent = sessionId === room.sessionId ? `${player.name} (you)` : player.name;
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

  // --- projectiles: the schema replicates only BIRTH state (origin, dir,
  // spawnTick); each frame we place every bolt analytically on the shared
  // tick timeline, so motion is perfectly smooth with zero ongoing patches.
  // BOLT_SPEED / TICK_DT must match src/rooms/LobbyRoom.ts.
  const BOLT_SPEED = 80;
  const TICK_DT = 1 / 60;
  const boltGeometry = new THREE.BoxGeometry(0.08, 0.08, 1.4); // long axis = flight axis
  const boltMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff66 });
  // OUR bolts render from a muzzle below-right of the camera, converging back
  // onto the true flight line — a bolt launched exactly at the eye would sit
  // frozen at the reticle as a dot. The server still hit-tests the true line.
  const MUZZLE_OFFSET = new THREE.Vector3(0.4, -0.35, -0.5);
  const MUZZLE_CONVERGE_DIST = 40; // rejoin the true line this far out
  const bolts = new Map(); // id -> {mesh, origin, dir, spawnTick}

  // estimated server tick between patches: state.tick only advances at patch
  // granularity (~50ms), so bolts placed on raw state.tick would stutter —
  // extrapolate it locally against wall-clock time since the last patch
  let tickBase = { tick: 0, at: performance.now() };
  $(room.state).listen('tick', (tick) => { tickBase = { tick, at: performance.now() }; });
  const estimatedTick = () => tickBase.tick + (performance.now() - tickBase.at) / (1000 * TICK_DT);

  $(room.state).projectiles.onAdd((bolt, id) => {
    let origin = new THREE.Vector3(bolt.ox, bolt.oy, bolt.oz);
    let dir = new THREE.Vector3(bolt.dx, bolt.dy, bolt.dz);
    if (bolt.shooter === room.sessionId) {
      const rejoin = origin.clone().addScaledVector(dir, MUZZLE_CONVERGE_DIST);
      origin = origin.add(MUZZLE_OFFSET.clone().applyQuaternion(predictedQuat));
      dir = rejoin.sub(origin).normalize();
    }
    const mesh = new THREE.Mesh(boltGeometry, boltMaterial);
    mesh.quaternion.setFromUnitVectors(LOCAL_FORWARD, dir);
    mesh.position.copy(origin);
    scene.add(mesh);
    bolts.set(id, { mesh, origin, dir, spawnTick: bolt.spawnTick });
  });

  $(room.state).projectiles.onRemove((_bolt, id) => {
    const entry = bolts.get(id);
    if (!entry) return;
    bolts.delete(id);
    scene.remove(entry.mesh);
    // brief flash where the bolt died (impact or end-of-life)
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.35, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xccffdd })
    );
    flash.position.copy(entry.mesh.position);
    scene.add(flash);
    setTimeout(() => {
      scene.remove(flash);
      flash.geometry.dispose();
      flash.material.dispose();
    }, 120);
  });

  // --- temporary drag tuner display: server owns the value ---
  const dragCurrent = document.getElementById('drag-current');
  $(room.state).listen('drag', (value) => { dragCurrent.textContent = value.toFixed(2); });

  // --- getting shot down (code 4000) returns us to the name screen cleanly ---
  let running = true; // render loop checks this before scheduling another frame
  room.onLeave((code) => {
    if (code === 4000) {
      // teardown: stop rendering, drop all per-session UI/scene bookkeeping
      running = false;
      currentRoom = null;
      held.clear();
      document.exitPointerLock();
      meshes.forEach((mesh) => { scene.remove(mesh); mesh.geometry?.dispose(); });
      meshes.clear();
      bolts.forEach(({ mesh }) => scene.remove(mesh));
      bolts.clear();
      boltGeometry.dispose();
      boltMaterial.dispose();
      listItems.clear();
      playerList.innerHTML = '';
      renderer.dispose();
      lobbyDiv.classList.add('hidden');
      form.classList.remove('hidden');
      status.textContent = 'you were shot down — enter a name to rejoin';
    } else {
      status.textContent = 'disconnected';
    }
  });

  // --- render loop: copy server state onto meshes, first-person camera ---
  function render() {
    if (!running) return;
    // state arrives shortly *after* joinOrCreate resolves — skip until synced
    room.state.players?.forEach((p, sessionId) => {
      const mesh = meshes.get(sessionId);
      if (!mesh) return;
      mesh.position.set(p.x, p.y, p.z);
      mesh.quaternion.set(p.qx, p.qy, p.qz, p.qw);
    });

    // bolts fly analytically: distance = speed × ticks since spawn
    const nowTick = estimatedTick();
    bolts.forEach(({ mesh, origin, dir, spawnTick }) => {
      const dist = Math.max(0, (nowTick - spawnTick) * TICK_DT * BOLT_SPEED);
      mesh.position.copy(origin).addScaledVector(dir, dist);
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

    const myState = room.state.players?.get(room.sessionId);
    if (myState) {
      reconcileLook(myState);
      const rates = spinRates(myState.avx, myState.avy, myState.avz, myState.avw);
      const speed = Math.hypot(myState.vx, myState.vy, myState.vz);
      hud.textContent =
        `roll ${(rates.roll * RAD2DEG).toFixed(0)}°/s   ` +
        `pitch ${(rates.pitch * RAD2DEG).toFixed(0)}°/s   ` +
        `speed ${speed.toFixed(1)}`;
    }

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
