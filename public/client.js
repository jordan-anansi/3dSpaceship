import * as THREE from 'three';

// Which control scheme this client sends. MUST match CONTROL_SCHEME in
// src/rooms/LobbyRoom.ts — the two are set by hand, there's no shared module.
// 'flight' = thrust/roll/pitch torque model; 'strafe' = direct-look + strafe.
const CONTROL_SCHEME = 'strafe';

const form = document.getElementById('join-form');
const nameInput = document.getElementById('name-input');
const lobbyDiv = document.getElementById('lobby');
const playerList = document.getElementById('player-list');
const status = document.getElementById('status');

// Same host/port that served this page, so it works on localhost and LAN alike.
const client = new Colyseus.Client(`ws://${location.host}`);

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
    startGame(room);
    room.onLeave(() => { status.textContent = 'disconnected'; });
  } catch (err) {
    status.textContent = `failed to join: ${err.message}`;
  }
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

function startGame(room) {
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

  const camera = new THREE.PerspectiveCamera(70, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);

  // --- one cube + one list entry per player ---
  const meshes = new Map(); // sessionId -> Mesh
  const listItems = new Map(); // sessionId -> <li>
  const $ = Colyseus.getStateCallbacks(room);

  $(room.state).players.onAdd((player, sessionId) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshNormalMaterial());
    scene.add(mesh);
    meshes.set(sessionId, mesh);

    const li = document.createElement('li');
    li.textContent = sessionId === room.sessionId ? `${player.name} (you)` : player.name;
    playerList.appendChild(li);
    listItems.set(sessionId, li);
  });

  $(room.state).players.onRemove((_player, sessionId) => {
    const mesh = meshes.get(sessionId);
    if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); }
    meshes.delete(sessionId);
    listItems.get(sessionId)?.remove();
    listItems.delete(sessionId);
  });

  // --- input: send the scheme's fields whenever a relevant key changes ---
  const TRACKED = CONTROL_SCHEME === 'flight'
    ? new Set(['w', 's', 'a', 'd', 'i', 'k'])
    : new Set(['w', 's', 'a', 'd', 'i', 'k', 'j', 'l']);
  const held = new Set();
  const axis = (pos, neg) => (held.has(pos) ? 1 : 0) - (held.has(neg) ? 1 : 0);
  const sendInput = () => room.send('input', CONTROL_SCHEME === 'flight'
    ? {
        thrust: axis('i', 'k'), // i = accelerate, k = decelerate
        roll: axis('d', 'a'),
        pitch: axis('s', 'w'), // stick-style: w = nose down, s = nose up
      }
    : {
        moveZ: axis('w', 's'),     // forward/backward
        moveX: axis('d', 'a'),     // strafe right/left
        lookPitch: axis('i', 'k'), // look up/down
        lookYaw: axis('j', 'l'),   // look left/right (left = +rotation about local up)
      });
  document.getElementById('controls-hint').textContent = CONTROL_SCHEME === 'flight'
    ? 'i/k: accel/decel   w/s: pitch down/up   a/d: roll'
    : 'w/s: fwd/back   a/d: strafe   i/k: look up/down   j/l: look left/right';
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return; // typing in a form, not flying
    const key = e.key.toLowerCase();
    if (TRACKED.has(key) && !held.has(key)) { held.add(key); sendInput(); }
  });
  window.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    if (TRACKED.has(key)) { held.delete(key); sendInput(); }
  });

  // --- temporary drag tuner: server owns the value, we just display & send ---
  const dragCurrent = document.getElementById('drag-current');
  const dragInput = document.getElementById('drag-input');
  $(room.state).listen('drag', (value) => { dragCurrent.textContent = value.toFixed(2); });
  document.getElementById('drag-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = parseFloat(dragInput.value);
    if (Number.isFinite(value)) room.send('setDrag', value);
    dragInput.value = '';
    dragInput.blur(); // give the keyboard back to flight controls
  });

  // --- render loop: copy server state onto meshes, chase-cam our own ship ---
  const camOffset = new THREE.Vector3();
  function render() {
    // state arrives shortly *after* joinOrCreate resolves — skip until synced
    room.state.players?.forEach((p, sessionId) => {
      const mesh = meshes.get(sessionId);
      if (!mesh) return;
      mesh.position.set(p.x, p.y, p.z);
      mesh.quaternion.set(p.qx, p.qy, p.qz, p.qw);
    });

    const myState = room.state.players?.get(room.sessionId);
    if (myState) {
      const rates = spinRates(myState.avx, myState.avy, myState.avz, myState.avw);
      const speed = Math.hypot(myState.vx, myState.vy, myState.vz);
      hud.textContent =
        `roll ${(rates.roll * RAD2DEG).toFixed(0)}°/s   ` +
        `pitch ${(rates.pitch * RAD2DEG).toFixed(0)}°/s   ` +
        `speed ${speed.toFixed(1)}`;
    }

    const me = meshes.get(room.sessionId);
    if (me) {
      // sit above and behind our ship, sharing its full orientation so the
      // horizon rolls with us (it's a spaceship, not a car)
      camOffset.set(0, 1.5, 5).applyQuaternion(me.quaternion);
      camera.position.copy(me.position).add(camOffset);
      camera.quaternion.copy(me.quaternion);
    }

    planet.rotation.y += 0.0003; // slow spin, purely cosmetic

    renderer.render(scene, camera);
    requestAnimationFrame(render);
  }
  render();
}
