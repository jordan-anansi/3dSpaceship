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
let activeTeardown = null;
let activeGrid = null;
let activeFireLaser = null;
let laserLingerFrames = 4; // Starts at 4 frames, adjustable via slider

const lingerSlider = document.getElementById('laser-linger-slider');
const lingerVal = document.getElementById('laser-linger-val');
function updateLingerDisplay(val) {
  laserLingerFrames = Math.max(1, Math.min(60, val));
  if (lingerSlider) lingerSlider.value = String(laserLingerFrames);
  if (lingerVal) lingerVal.textContent = String(laserLingerFrames);
}
lingerSlider?.addEventListener('input', (e) => {
  updateLingerDisplay(parseInt(e.target.value, 10) || 4);
});

const leaveBtn = document.getElementById('leave-btn');
leaveBtn?.addEventListener('click', () => {
  if (currentRoom) {
    const room = currentRoom;
    currentRoom = null;
    room.leave();
  }
  if (activeTeardown) {
    activeTeardown('returned to lobby');
  }
});

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
const TRACKED = new Set(['w', 's', 'a', 'd', 'q', 'e', 'shift']);
const held = new Set();
const axis = (pos, neg) => (held.has(pos) ? 1 : 0) - (held.has(neg) ? 1 : 0);
const sendInput = () => currentRoom?.send('input', {
  moveZ: axis('w', 's'), // forward/backward thrust
  moveX: axis('d', 'a'), // lateral strafe thrust
  boost: held.has('shift'), // afterburner boost (shift key)
});
document.getElementById('controls-hint').textContent =
  'click canvas: capture mouse   mouse: yaw/pitch   q/e: roll   w/s: fwd/back   a/d: strafe   shift: boost   space: fire laser   f: fullscreen   g: toggle grid   esc: release mouse';

function toggleFullscreen() {
  const wrap = document.getElementById('game-wrap');
  if (!wrap) return;
  if (!document.fullscreenElement) {
    wrap.requestFullscreen().catch((err) => {
      console.warn('Fullscreen request failed:', err);
    });
  } else {
    document.exitFullscreen().catch((err) => {
      console.warn('Exit fullscreen failed:', err);
    });
  }
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return; // typing in a form, not flying
  if (e.key === ' ') {
    e.preventDefault(); // don't scroll the page or "click" a focused button
    if (!e.repeat && currentRoom) {
      currentRoom.send('fire', { seq: lookSeq });
      if (activeFireLaser) activeFireLaser();
    }
    return;
  }
  const key = e.key.toLowerCase();
  if (key === 'f') {
    toggleFullscreen();
    return;
  }
  if (key === 'g') {
    if (activeGrid) activeGrid.visible = !activeGrid.visible;
    return;
  }
  if (key === '[') {
    updateLingerDisplay(laserLingerFrames - 1);
    return;
  }
  if (key === ']') {
    updateLingerDisplay(laserLingerFrames + 1);
    return;
  }
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

// Deterministic 100-asteroid field so every client generates identical scenery.
function createDeterministicAsteroidField(count = 100) {
  let s = 987654321;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };

  const field = [];
  for (let i = 0; i < count; i++) {
    // Radius: 5m (10m across) to 500m (1km across)
    // Power-law distribution: many 10m-40m boulders, dozens of 50m-200m rocks, and several 200m-1km monoliths
    const r = 5 + Math.pow(rnd(), 3.5) * 495;

    // Distribute in a broad asteroid belt around the arena
    // Push larger asteroids further out so they don't engulf the central spawn zone
    const angle = rnd() * Math.PI * 2;
    const baseDist = 120 + r * 1.6;
    const dist = baseDist + rnd() * 2600;
    const height = (rnd() - 0.5) * (500 + r * 0.8);
    const p0 = [
      Math.cos(angle) * dist,
      height,
      Math.sin(angle) * dist,
    ];

    // Inertia: larger asteroids have larger mass, moving and tumbling with slower periods
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
    const driftPhase = [
      rnd() * Math.PI * 2,
      rnd() * Math.PI * 2,
      rnd() * Math.PI * 2,
    ];

    // Rotational velocities: massive monoliths tumble very gently (0.01-0.03 rad/s),
    // smaller 10m rocks tumble at 0.06-0.2 rad/s
    const rot0 = [
      rnd() * Math.PI * 2,
      rnd() * Math.PI * 2,
      rnd() * Math.PI * 2,
    ];
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

const ASTEROID_FIELD = createDeterministicAsteroidField(100);

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

// Constant direction to the sun in world space.
// Aligned so it illuminates the asteroids and the visible face of the planet.
const SUN_DIR = new THREE.Vector3(0.6, 0.45, -0.65).normalize();
const SUN_DISTANCE = 14000000; // 14,000 km away
const SUN_CORE_RADIUS = 500000; // 500 km radius
const SUN_CORONA_RADIUS = 680000; // 680 km radius

function makeSun() {
  const group = new THREE.Group();

  // Core radiant sphere (unlit with warm golden-white starlight)
  const coreGeom = new THREE.SphereGeometry(SUN_CORE_RADIUS, 32, 32);
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xfff6e8 });
  group.add(new THREE.Mesh(coreGeom, coreMat));

  // Outer corona glow halo (warm amber)
  const coronaGeom = new THREE.SphereGeometry(SUN_CORONA_RADIUS, 32, 32);
  const coronaMat = new THREE.MeshBasicMaterial({
    color: 0xffba55,
    transparent: true,
    opacity: 0.38,
    side: THREE.BackSide,
  });
  group.add(new THREE.Mesh(coronaGeom, coronaMat));

  return group;
}

// Astronomical Moon: radius 1,737.4 km, placed 5,500 km away
const MOON_RADIUS = 1737400; // 1,737.4 km in meters
const MOON_DISTANCE = 5500000; // 5,500 km away
const MOON_DIR = new THREE.Vector3(0.35, 0.18, -0.91).normalize();

function makePlanet() {
  const group = new THREE.Group();
  const planetCenter = MOON_DIR.clone().multiplyScalar(MOON_DISTANCE);

  // Solid planet sphere with procedural surface
  const planetMesh = new THREE.Mesh(
    new THREE.SphereGeometry(MOON_RADIUS, 64, 48),
    new THREE.MeshStandardMaterial({
      map: makeJupiterTexture(),
      roughness: 0.88,
      metalness: 0.05,
    })
  );
  group.add(planetMesh);

  // Atmospheric inner horizon haze (front-side Fresnel rim on planet's surface)
  const innerAtmosphereGeom = new THREE.SphereGeometry(MOON_RADIUS * 1.012, 64, 48);
  const innerAtmosphereMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xffcb78) }, // Warm golden-amber atmospheric glow
      uSunDir: { value: SUN_DIR },
      uPlanetCenter: { value: planetCenter },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPos.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
        #include <logdepthbuf_vertex>
      }
    `,
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
        float VdotN = max(0.0, dot(viewDir, worldNormal));
        float rim = pow(1.0 - VdotN, 2.8);

        float sunDot = dot(worldNormal, uSunDir);
        float sunFactor = clamp((sunDot + 0.25) / 1.25, 0.0, 1.0);

        // Warm twilight copper to luminous golden sunlight
        vec3 atmoColor = mix(vec3(0.68, 0.36, 0.16), uColor, 0.3 + 0.7 * sunFactor);
        float alpha = rim * (0.2 + 0.8 * sunFactor) * 0.85;
        gl_FragColor = vec4(atmoColor, alpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  group.add(new THREE.Mesh(innerAtmosphereGeom, innerAtmosphereMat));

  // Atmospheric outer halo (back-side shell extending into vacuum around the silhouette)
  const outerAtmosphereGeom = new THREE.SphereGeometry(MOON_RADIUS * 1.045, 64, 48);
  const outerAtmosphereMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xffad54) }, // Warm radiant amber halo
      uSunDir: { value: SUN_DIR },
      uPlanetCenter: { value: planetCenter },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPos.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
        #include <logdepthbuf_vertex>
      }
    `,
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

        // Path-length normalization: dot(-viewDir, worldNormal) ranges from 0 (outer shell edge)
        // to sqrt(1 - (Rp / Ro)^2) ≈ 0.2908 at the planet's silhouette limb.
        float maxD = 0.2908;
        float rim = clamp(dot(-viewDir, worldNormal) / maxD, 0.0, 1.0);
        float halo = pow(rim, 2.0);

        float sunDot = dot(worldNormal, uSunDir);
        float sunFactor = clamp((sunDot + 0.25) / 1.25, 0.0, 1.0);

        // Warm amber glow in vacuum around planet
        vec3 atmoColor = mix(vec3(0.62, 0.32, 0.14), uColor, 0.35 + 0.65 * sunFactor);
        float alpha = halo * (0.2 + 0.8 * sunFactor) * 0.9;
        gl_FragColor = vec4(atmoColor, alpha);
      }
    `,
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  group.add(new THREE.Mesh(outerAtmosphereGeom, outerAtmosphereMat));

  group.position.copy(planetCenter);
  return group;
}

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

// Emissive distant stars on the celestial sphere (positioned behind celestial bodies)
function makeDistantStars(count = 3500, radius = 16000000) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  const starColors = [
    new THREE.Color(1.0, 1.0, 1.0),       // Pure brilliant white
    new THREE.Color(0.85, 0.93, 1.0),     // Pale blue-white
    new THREE.Color(0.72, 0.85, 1.0),     // Azure
    new THREE.Color(1.0, 0.95, 0.82),     // Warm yellow
    new THREE.Color(1.0, 0.80, 0.65),     // Amber giant
  ];

  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * 2 * Math.PI;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    const r = radius + (Math.random() - 0.5) * 60;

    positions[i * 3] = r * s * Math.cos(theta);
    positions[i * 3 + 1] = r * u;
    positions[i * 3 + 2] = r * s * Math.sin(theta);

    const base = starColors[Math.floor(Math.random() * starColors.length)];
    const lum = 0.45 + 0.55 * Math.pow(Math.random(), 2);
    colors[i * 3] = base.r * lum;
    colors[i * 3 + 1] = base.g * lum;
    colors[i * 3 + 2] = base.b * lum;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 3.5,
    map: makeStarTexture(),
    vertexColors: true,
    sizeAttenuation: false,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

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
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000); // pure black space
  const gridHelper = new THREE.GridHelper(3000, 100, 0x3a4470, 0x1a2040); // 3km spatial reference grid
  scene.add(gridHelper);
  activeGrid = gridHelper;

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

  // Ambient base light (0.02) to softly illuminate all space bodies
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.02);
  scene.add(ambientLight);

  // The Sun is the primary directional light: warm golden-white starlight
  const SUN_INTENSITY = 2.8;
  const sunLight = new THREE.DirectionalLight(0xffeed6, SUN_INTENSITY);
  sunLight.position.copy(SUN_DIR);
  sunLight.target.position.set(0, 0, 0);
  scene.add(sunLight);
  scene.add(sunLight.target);

  // Opposing fill light: opposite the sun at 1/50th intensity with cool blue starlight/nebula tone
  // Prevents dark sides from falling to pitch black while contrasting against warm sunlight.
  const OPPOSITE_SUN_DIR = SUN_DIR.clone().negate();
  const opposingLight = new THREE.DirectionalLight(0x8ab4f8, SUN_INTENSITY / 50);
  opposingLight.position.copy(OPPOSITE_SUN_DIR);
  opposingLight.target.position.set(0, 0, 0);
  scene.add(opposingLight);
  scene.add(opposingLight.target);

  // Camera near 0.1m, far 25,000 km to encompass the Moon (5,500km) and stars (16,000km)
  const camera = new THREE.PerspectiveCamera(70, canvas.clientWidth / canvas.clientHeight, 0.1, 25000000);

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

  // --- Instantaneous speed-of-light lasers ---
  // Reusable unit cylinders oriented along Z (rotateX 90°)
  const laserBeamGeom = new THREE.CylinderGeometry(0.08, 0.08, 1, 8);
  laserBeamGeom.rotateX(Math.PI / 2);
  const laserCoreGeom = new THREE.CylinderGeometry(0.028, 0.028, 1, 8);
  laserCoreGeom.rotateX(Math.PI / 2);

  const activeLasers = [];
  const activeFlashes = [];
  const MUZZLE_OFFSET = new THREE.Vector3(0.4, -0.35, -0.5);

  function spawnLaserBeam(start, dir, length, isHit) {
    const end = start.clone().addScaledVector(dir, length);
    const mid = start.clone().addScaledVector(dir, length * 0.5);

    // Outer vibrant green laser glow
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x00ff88,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const glowMesh = new THREE.Mesh(laserBeamGeom, glowMat);
    glowMesh.position.copy(mid);
    glowMesh.scale.set(1, 1, length);
    glowMesh.lookAt(end);
    scene.add(glowMesh);

    // Inner bright white/lime energy core
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const coreMesh = new THREE.Mesh(laserCoreGeom, coreMat);
    coreMesh.position.copy(mid);
    coreMesh.scale.set(1, 1, length);
    coreMesh.lookAt(end);
    scene.add(coreMesh);

    activeLasers.push({
      glowMesh,
      coreMesh,
      totalFrames: laserLingerFrames,
      framesRemaining: laserLingerFrames,
    });

    // Impact / endpoint flash
    const flashGeom = new THREE.SphereGeometry(isHit ? 1.5 : 0.45, 8, 8);
    const flashMat = new THREE.MeshBasicMaterial({
      color: isHit ? 0xffffff : 0x88ffaa,
      transparent: true,
      opacity: 1.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const flashMesh = new THREE.Mesh(flashGeom, flashMat);
    flashMesh.position.copy(end);
    scene.add(flashMesh);
    const flashFrames = isHit ? Math.max(laserLingerFrames * 2, 6) : Math.max(laserLingerFrames, 3);
    activeFlashes.push({
      mesh: flashMesh,
      totalFrames: flashFrames,
      framesRemaining: flashFrames,
    });
  }

  function fireLocalLaser() {
    const origin = camera.position.clone();
    const dir = LOCAL_FORWARD.clone().applyQuaternion(predictedQuat).normalize();
    let hitDist = 5000;
    let isHit = false;

    // Fast local raycast against other ships for immediate impact prediction
    meshes.forEach((mesh, id) => {
      if (id === room.sessionId) return;
      const toShip = mesh.position.clone().sub(origin);
      const b = toShip.dot(dir);
      if (b > 0 && b < hitDist) {
        const d2 = toShip.lengthSq() - b * b;
        if (d2 <= 1.96) { // 1.4m hit radius
          hitDist = Math.max(0, b - Math.sqrt(Math.max(0, 1.96 - d2)));
          isHit = true;
        }
      }
    });

    // Fire from wing/cannon muzzle converging to crosshairs aim point
    const muzzle = origin.clone().add(MUZZLE_OFFSET.clone().applyQuaternion(predictedQuat));
    const target = origin.clone().addScaledVector(dir, hitDist);
    const beamDir = target.clone().sub(muzzle).normalize();
    const beamLen = target.distanceTo(muzzle);
    spawnLaserBeam(muzzle, beamDir, beamLen, isHit);
  }

  activeFireLaser = fireLocalLaser;

  // Server broadcast: other players' laser beams
  room.onMessage('laser', (data) => {
    if (data.shooter === room.sessionId) return; // local player already predicted
    const origin = new THREE.Vector3(data.ox, data.oy, data.oz);
    const dir = new THREE.Vector3(data.dx, data.dy, data.dz);
    spawnLaserBeam(origin, dir, data.dist, data.hit);
  });

  // Handle dynamic window and fullscreen resizing
  function handleResize() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width > 0 && height > 0) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
  }
  window.addEventListener('resize', handleResize);
  document.addEventListener('fullscreenchange', handleResize);
  handleResize();

  // estimated server tick between patches: extrapolate against wall-clock time
  const TICK_DT = 1 / 60;
  let tickBase = { tick: 0, at: performance.now() };
  $(room.state).listen('tick', (tick) => { tickBase = { tick, at: performance.now() }; });
  const estimatedTick = () => tickBase.tick + (performance.now() - tickBase.at) / (1000 * TICK_DT);

  // --- temporary drag tuner display: server owns the value ---
  const dragCurrent = document.getElementById('drag-current');
  $(room.state).listen('drag', (value) => { dragCurrent.textContent = value.toFixed(2); });

  // --- teardown and return to lobby ---
  let running = true; // render loop checks this before scheduling another frame

  function teardownSession(statusMsg) {
    if (!running) return;
    running = false;
    currentRoom = null;
    activeTeardown = null;
    activeGrid = null;
    activeFireLaser = null;
    window.removeEventListener('resize', handleResize);
    document.removeEventListener('fullscreenchange', handleResize);
    held.clear();
    document.exitPointerLock();
    meshes.forEach((mesh) => { scene.remove(mesh); mesh.geometry?.dispose(); });
    meshes.clear();
    activeLasers.forEach((item) => {
      scene.remove(item.glowMesh);
      scene.remove(item.coreMesh);
      item.glowMesh.material.dispose();
      item.coreMesh.material.dispose();
    });
    activeLasers.length = 0;
    activeFlashes.forEach((item) => {
      scene.remove(item.mesh);
      item.mesh.geometry.dispose();
      item.mesh.material.dispose();
    });
    activeFlashes.length = 0;
    laserBeamGeom.dispose();
    laserCoreGeom.dispose();
    listItems.clear();
    playerList.innerHTML = '';
    renderer.dispose();
    lobbyDiv.classList.add('hidden');
    form.classList.remove('hidden');
    status.textContent = statusMsg;
  }

  activeTeardown = teardownSession;

  room.onLeave((code) => {
    if (code === 4000) {
      teardownSession('you were shot down — enter a name to rejoin');
    } else {
      teardownSession('returned to lobby');
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

    const nowTick = estimatedTick();

    // Linger and clean up active instantaneous lasers and flashes by frame count
    for (let i = activeLasers.length - 1; i >= 0; i--) {
      const item = activeLasers[i];
      item.framesRemaining--;
      if (item.framesRemaining <= 0) {
        scene.remove(item.glowMesh);
        scene.remove(item.coreMesh);
        item.glowMesh.material.dispose();
        item.coreMesh.material.dispose();
        activeLasers.splice(i, 1);
      } else {
        const factor = item.framesRemaining / item.totalFrames;
        item.glowMesh.material.opacity = (0.35 + 0.65 * factor) * 0.85;
        item.coreMesh.material.opacity = (0.4 + 0.6 * factor) * 0.95;
      }
    }

    for (let i = activeFlashes.length - 1; i >= 0; i--) {
      const item = activeFlashes[i];
      item.framesRemaining--;
      if (item.framesRemaining <= 0) {
        scene.remove(item.mesh);
        item.mesh.geometry.dispose();
        item.mesh.material.dispose();
        activeFlashes.splice(i, 1);
      } else {
        const factor = item.framesRemaining / item.totalFrames;
        item.mesh.material.opacity = factor;
        const scale = 1 + (1 - factor) * 0.6;
        item.mesh.scale.set(scale, scale, scale);
      }
    }

    // asteroids drift and tumble as pure functions of the shared tick, so
    // every client sees the identical field. Drift is sinusoidal (bounded —
    // rocks orbit their home position, never wander off), tumble is a slow
    // Asteroids gently drift and tumble: small velocities and rotational velocities
    const tSec = nowTick * TICK_DT;
    asteroids.forEach(({ mesh, spec }) => {
      const { p0, driftAmp, driftFreq, driftPhase, rot0, rotV } = spec;
      mesh.position.set(
        p0[0] + driftAmp[0] * Math.sin(tSec * driftFreq[0] + driftPhase[0]),
        p0[1] + driftAmp[1] * Math.sin(tSec * driftFreq[1] + driftPhase[1]),
        p0[2] + driftAmp[2] * Math.cos(tSec * driftFreq[2] + driftPhase[2])
      );
      mesh.rotation.set(
        rot0[0] + tSec * rotV[0],
        rot0[1] + tSec * rotV[1],
        rot0[2] + tSec * rotV[2]
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

    // Distant stars & Sun are effectively infinitely far away: track camera position
    // so distance and angular size never change as the player flies through space
    distantStars.position.copy(camera.position);
    sunMesh.position.copy(camera.position).addScaledVector(SUN_DIR, SUN_DISTANCE);

    renderer.render(scene, camera);
    requestAnimationFrame(render);
  }
  render();
}
