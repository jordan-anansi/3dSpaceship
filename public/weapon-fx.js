import * as THREE from 'three';

// How each weapon's shots LOOK. The simulation lives on the server
// (src/game/weapons/); this is purely presentation, keyed by the same `kind`
// string the server puts on the replicated Shot.
//
// The contract, per entry in SHOT_FX:
//
//   create(spec) -> { mesh, origin, dir }
//       Build the Object3D. `spec` is { origin, dir, param, mine, viewQuat }:
//         origin   THREE.Vector3, where the server says the shot was born
//         dir      THREE.Vector3, unit, the server's flight direction
//         param    number, the weapon-specific field off the Shot schema
//         mine     true if the local player fired it
//         viewQuat THREE.Quaternion, the local player's predicted orientation
//                  at spawn (only meaningful when `mine`)
//       Return the origin/dir that update() should use — normally the ones
//       you were handed, but a weapon may offset them for presentation (see
//       the bolt's muzzle convergence). The SERVER still hit-tests the true
//       line, so any offset must converge back onto it.
//
//   update(entry, age)
//       Place the mesh. `entry` is { mesh, origin, dir, param, mine } and
//       `age` is seconds since spawn on the shared tick timeline. Called
//       every frame. Shots fly analytically (origin + dir · speed · age)
//       rather than being integrated, so there's nothing to accumulate and
//       no drift.
//
//   expire(entry, scene)   [optional]
//       The server deleted the shot — it hit something, or timed out. Add
//       any transient effect to `scene` yourself, and be responsible for
//       removing and disposing it. The mesh itself is already gone.
//
// Speeds MUST match the server's. Anything duplicated across the wire is
// marked at both ends; if the two drift, clients render hits the server
// disagrees with.

const LOCAL_FORWARD = new THREE.Vector3(0, 0, -1);

// --- shared impact flash, used by several weapons -------------------------
const flashGeometry = new THREE.SphereGeometry(0.35, 8, 6);
const flashMaterial = new THREE.MeshBasicMaterial({ color: 0xccffdd });

/** Brief spark at a point. Cleans itself up. */
export function popFlash(scene, position, color) {
  const material = color ? flashMaterial.clone() : flashMaterial;
  if (color) material.color.setHex(color);
  const flash = new THREE.Mesh(flashGeometry, material);
  flash.position.copy(position);
  scene.add(flash);
  setTimeout(() => {
    scene.remove(flash);
    if (color) material.dispose();
  }, 120);
}

// --- bolt: the starting gun ----------------------------------------------
// Travel-time projectile. BOLT_SPEED must match src/game/weapons/bolt.ts.
const BOLT_SPEED = 160;
const boltGeometry = new THREE.BoxGeometry(0.08, 0.08, 1.4); // long axis = flight axis
const boltMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff66 });
// OUR bolts render from a muzzle below-right of the camera, converging back
// onto the true flight line — a bolt launched exactly at the eye would sit
// frozen at the reticle as a single dot.
const MUZZLE_OFFSET = new THREE.Vector3(0.4, -0.35, -0.5);
const MUZZLE_CONVERGE_DIST = 40; // rejoin the true line this far out

const bolt = {
  create({ origin, dir, mine, viewQuat }) {
    let o = origin.clone();
    let d = dir.clone();
    if (mine) {
      const rejoin = o.clone().addScaledVector(d, MUZZLE_CONVERGE_DIST);
      o = o.add(MUZZLE_OFFSET.clone().applyQuaternion(viewQuat));
      d = rejoin.sub(o).normalize();
    }
    const mesh = new THREE.Mesh(boltGeometry, boltMaterial);
    mesh.quaternion.setFromUnitVectors(LOCAL_FORWARD, d);
    mesh.position.copy(o);
    return { mesh, origin: o, dir: d };
  },

  update(entry, age) {
    const dist = Math.max(0, age * BOLT_SPEED);
    entry.mesh.position.copy(entry.origin).addScaledVector(entry.dir, dist);
  },

  expire(entry, scene) {
    popFlash(scene, entry.mesh.position);
  },
};

// --- railgun: hitscan -----------------------------------------------------
// Implemented alongside the server weapon in src/game/weapons/railgun.ts.
//
// Nothing here moves. The server resolved the hit on the tick the trigger was
// pulled and spawned an inert tracer purely so this can be drawn; `param` is
// the beam's true length, i.e. where it stopped — ship, rock or max range.
//
// RAIL_TRACER_LIFE is duplicated from src/game/weapons/railgun.ts
// (RAIL_TRACER_LIFE_TICKS). The fade has to land on the same instant the
// server deletes the tracer, or the beam either pops out mid-fade or hangs
// there solid.
const RAIL_TRACER_LIFE = 12 / 60; // seconds — 12 ticks at 60Hz

// Two concentric cylinders rather than one box. A single solid bar reads as a
// thrown object; a bright hot core inside a wider translucent glow reads as
// something that was never matter. Both additive, so overlapping beams and
// the core-through-glow both brighten instead of muddying.
//
// Cylinders are authored along Y, so each is rotated once at module scope to
// put its long axis on Z — matching LOCAL_FORWARD and letting instances scale
// z to the beam length.
const railGlowGeometry = new THREE.CylinderGeometry(0.08, 0.08, 1, 8);
railGlowGeometry.rotateX(Math.PI / 2);
const railCoreGeometry = new THREE.CylinderGeometry(0.028, 0.028, 1, 8);
railCoreGeometry.rotateX(Math.PI / 2);

// Pale blue-white, NOT the green cp_1 used: the bolt is green (0x00ff66), and
// two guns that flash the same colour are two guns you can't tell apart in a
// fight. The core stays white so the beam has a hot centre regardless.
const RAIL_GLOW_COLOR = 0xbfe6ff;
const RAIL_CORE_COLOR = 0xffffff;

const rail = {
  create({ origin, dir, param, mine, viewQuat }) {
    // Same offset muzzle as the bolt, and the problem is worse here: a beam
    // starting exactly at the eye is a line seen end-on, which draws as a
    // single dot at the reticle. No convergence DISTANCE is needed though —
    // the server told us exactly where the beam ends, so aiming the drawn
    // beam at that endpoint converges by construction.
    const end = origin.clone().addScaledVector(dir, param);
    const start = mine
      ? origin.clone().add(MUZZLE_OFFSET.clone().applyQuaternion(viewQuat))
      : origin.clone();
    const along = end.sub(start);
    const len = Math.max(0.01, along.length()); // a point-blank beam still needs an axis
    const d = along.divideScalar(len);

    // The per-instance materials in this file: the whole effect IS the fade,
    // opacity lives on the material, and beams overlap at different ages — so
    // these can't be shared singletons like the bolt's. expire() disposes
    // them. The impact node shares the core's material, hence two disposes
    // for three meshes.
    const shared = {
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    };
    const glowMaterial = new THREE.MeshBasicMaterial({ color: RAIL_GLOW_COLOR, ...shared });
    const coreMaterial = new THREE.MeshBasicMaterial({ color: RAIL_CORE_COLOR, ...shared });

    // Group local space: -Z is the beam axis (matching LOCAL_FORWARD), so the
    // beam spans z ∈ [0, -len] and the impact node sits on its far end.
    // Child order is load-bearing — update() and expire() index into it.
    const group = new THREE.Group();
    const glow = new THREE.Mesh(railGlowGeometry, glowMaterial);
    glow.scale.set(1, 1, len);
    glow.position.z = -len / 2;
    const core = new THREE.Mesh(railCoreGeometry, coreMaterial);
    core.scale.set(1, 1, len);
    core.position.z = -len / 2;
    const impact = new THREE.Mesh(flashGeometry, coreMaterial);
    impact.position.z = -len;
    group.add(glow, core, impact);
    group.quaternion.setFromUnitVectors(LOCAL_FORWARD, d);
    group.position.copy(start);
    return { mesh: group, origin: start, dir: d };
  },

  update(entry, age) {
    // Bright, then gone. Squared falloff spends most of the tracer's life
    // already dim, which is what makes it read as a crack rather than a slow
    // tracer drifting away; thinning as it goes sells the "it was never
    // really a physical thing" of a hitscan weapon.
    const k = (1 - Math.min(1, age / RAIL_TRACER_LIFE)) ** 2;
    const [glow, core, impact] = entry.mesh.children;
    // The glow collapses faster than the core, so the beam necks down to a
    // bright filament before it goes rather than fading out as a fat bar.
    glow.material.opacity = 0.85 * k;
    glow.scale.set(0.3 + 0.7 * k, 0.3 + 0.7 * k, glow.scale.z); // z holds the length
    core.material.opacity = 0.95 * Math.sqrt(k); // hangs on longer than the glow
    core.scale.set(0.5 + 0.5 * k, 0.5 + 0.5 * k, core.scale.z);
    // the impact end pops outward as it dies, so a hit reads as a hit even
    // when the beam itself is already dim
    impact.scale.setScalar(Math.max(0.001, k * (1.6 - 0.6 * k)));
  },

  expire(entry) {
    // No impact flash here on purpose: the hit happened at spawn, a fifth of
    // a second before the tracer is deleted, so a flash now would fire at the
    // wrong moment. The impact node in create() is the hit marker.
    const [glow, core] = entry.mesh.children;
    glow.material.dispose();
    core.material.dispose(); // also the impact node's material
  },
};

// --- flak: detonates at a set distance ------------------------------------
// Implemented alongside the server weapon in src/game/weapons/flak.ts.
//
// FLAK_SPEED is duplicated from that file. It matters more than any other
// shared constant: the player sets the fuse by eye, off where they can SEE
// the shell, so drawing it at a speed the server doesn't simulate means
// aiming a different gun from the one being fired.
const FLAK_SPEED = 110;
const flakGeometry = new THREE.IcosahedronGeometry(0.3, 0); // faceted: reads as a shell, not a bolt
const flakMaterial = new THREE.MeshBasicMaterial({ color: 0xffb347 });
const FLAK_SPIN = 6; // rad/s — tumbling gives the shell a legible size at distance

const flak = {
  create({ origin, dir, param, mine, viewQuat }) {
    let o = origin.clone();
    let d = dir.clone();
    if (mine) {
      // Same muzzle offset as the bolt, but rejoin the true line at the BURST
      // point when that's nearer than the usual convergence distance — a
      // short-fused shell would otherwise still be off-axis when it pops,
      // next to a server blast drawn on the true line.
      const rejoin = o.clone().addScaledVector(d, Math.min(MUZZLE_CONVERGE_DIST, param));
      o = o.add(MUZZLE_OFFSET.clone().applyQuaternion(viewQuat));
      d = rejoin.sub(o).normalize();
    }
    const mesh = new THREE.Mesh(flakGeometry, flakMaterial);
    mesh.position.copy(o);
    return { mesh, origin: o, dir: d };
  },

  update(entry, age) {
    const dist = Math.max(0, age * FLAK_SPEED);
    entry.mesh.position.copy(entry.origin).addScaledVector(entry.dir, dist);
    entry.mesh.rotation.set(age * FLAK_SPIN * 0.6, age * FLAK_SPIN, 0);
    // Fuse tell: the shell pulses, and the pulse quickens as it closes on the
    // distance the shooter dialled in. Reading range is the whole skill of
    // this weapon, so how close the shell is to bursting has to be legible
    // from behind it — where you have no parallax to judge distance with.
    const toBurst = entry.param > 0 ? Math.min(1, dist / entry.param) : 1;
    entry.mesh.scale.setScalar(1 + 0.25 * Math.sin(age * (12 + 38 * toBurst)));
  },

  expire(entry, scene) {
    // The expanding sphere at the true damage radius comes free from the
    // server's Blast (see createBlast); this is only the hot core, at the
    // shell itself, to mark the exact point the fuse went off.
    popFlash(scene, entry.mesh.position, 0xffd27f);
  },
};

// --- battering ram: a dome welded to the bow ------------------------------
// Implemented alongside the server weapon in src/game/weapons/ram.ts.
//
// The one shot in the game that does NOT fly. It has no trajectory to place
// analytically — it rides the ship — so this entry sets `attach: true` and
// client.js re-seats the mesh on the shooter's hull every frame instead of
// stepping it along a line. The radius arrives in `param`; the server tests
// the same hemisphere against the same live transform, so what's drawn is
// exactly what kills.
//
// RAM_DURATION is duplicated from RAM_DURATION_TICKS in that file — the
// dome has to finish its collapse on the tick the server deletes it, or it
// either pops out mid-animation or lingers after the field is gone.
const RAM_DURATION = 60 / 60; // seconds
// Authored opening along +Y, turned to face -Z (LOCAL_FORWARD) once here at
// module scope rather than per instance.
const ramGeometry = new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2);
ramGeometry.rotateX(-Math.PI / 2);
const RAM_SHELL_COLOR = 0x7fd4ff;
const RAM_EDGE_COLOR = 0xeaf8ff;

const ram = {
  // read by client.js's render loop — see the `attach` branch there
  attach: true,

  create({ param }) {
    const shared = {
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    };
    // Per-instance materials, like the rail's: the whole effect is the
    // opacity curve, and two domes can be live at once at different ages.
    const shellMaterial = new THREE.MeshBasicMaterial({ color: RAM_SHELL_COLOR, ...shared });
    const edgeMaterial = new THREE.MeshBasicMaterial({
      color: RAM_EDGE_COLOR, wireframe: true, ...shared,
    });

    // Child order is load-bearing: update() and expire() index into it.
    const group = new THREE.Group();
    const shell = new THREE.Mesh(ramGeometry, shellMaterial);
    const edge = new THREE.Mesh(ramGeometry, edgeMaterial);
    // Fractionally proud of the shell so the wireframe reads as a lattice ON
    // the surface rather than z-fighting through it.
    edge.scale.setScalar(1.005);
    group.add(shell, edge);
    group.scale.setScalar(param);
    group.userData.radius = param;
    return { mesh: group, origin: new THREE.Vector3(), dir: LOCAL_FORWARD.clone() };
  },

  update(entry, age) {
    const t = Math.min(1, Math.max(0, age / RAM_DURATION));
    const radius = entry.mesh.userData.radius;
    // Snap out over the first eighth of a second, then hold at full size for
    // the rest of the window. The dome is lethal for its whole second, so it
    // must not spend that second visibly growing — a player has to be able to
    // read its true extent immediately, or the weapon is unfair to fly near.
    const punch = Math.min(1, age / 0.12);
    entry.mesh.scale.setScalar(radius * (0.35 + 0.65 * (1 - (1 - punch) ** 3)));

    const [shell, edge] = entry.mesh.children;
    // Bright on contact, then bleeding away — plus a fast flicker so it reads
    // as energised rather than as a pane of glass.
    const flicker = 0.85 + 0.15 * Math.sin(age * 42);
    shell.material.opacity = 0.16 * (1 - t) * flicker;
    edge.material.opacity = 0.5 * (1 - t * t) * flicker;
  },

  expire(entry) {
    const [shell, edge] = entry.mesh.children;
    shell.material.dispose();
    edge.material.dispose();
  },
};

export const SHOT_FX = { bolt, rail, flak, ram };

// --- blasts ---------------------------------------------------------------
// A replicated detonation, purely cosmetic — the server already applied the
// damage on the tick it spawned (or, for a 'death' blast, there was never any
// damage to apply). Two looks, keyed off Blast.kind:
//
//   'burst' — ordnance. An expanding, fading shell at the weapon's TRUE
//             damage radius, so players can see how big the AoE actually was
//             and learn to judge it. The size is information; don't inflate it.
//   'death' — a ship coming apart. Here the size means nothing, so it's free
//             to be theatrical: a hot flash, a shockwave that outruns it, and
//             debris thrown outward on straight lines.
const blastGeometry = new THREE.SphereGeometry(1, 16, 12);
const BLAST_GROW_TIME = 0.25; // seconds to reach full radius
const BLAST_FADE_TIME = 0.45; // ...and to fade out entirely

const DEATH_LIFE = 0.9;       // seconds of debris flight
const DEATH_SHARDS = 14;
const deathShardGeometry = new THREE.TetrahedronGeometry(0.5);

/** A wreck coming apart: core flash, shockwave shell, and tumbling debris. */
function createDeathBlast(radius) {
  const group = new THREE.Group();
  const shared = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };

  const core = new THREE.Mesh(
    blastGeometry,
    new THREE.MeshBasicMaterial({ color: 0xfff1cc, ...shared })
  );
  const wave = new THREE.Mesh(
    blastGeometry,
    new THREE.MeshBasicMaterial({ color: 0xff9a3c, side: THREE.BackSide, ...shared })
  );
  group.add(core, wave);

  // Debris directions are rolled once, here, and then flown analytically off
  // `age` in updateDeathBlast — same discipline as the shots, so nothing has
  // to be integrated per frame and a dropped frame can't accumulate drift.
  const shardMaterial = new THREE.MeshBasicMaterial({ color: 0xffc98a, transparent: true });
  for (let i = 0; i < DEATH_SHARDS; i++) {
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    const shard = new THREE.Mesh(deathShardGeometry, shardMaterial);
    shard.userData.velocity = new THREE.Vector3(s * Math.cos(theta), u, s * Math.sin(theta))
      .multiplyScalar(radius * (0.6 + Math.random() * 1.1));
    shard.userData.spin = new THREE.Vector3(
      (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9
    );
    shard.scale.setScalar(0.35 + Math.random() * 0.75);
    group.add(shard);
  }
  group.userData.shardMaterial = shardMaterial;
  return group;
}

function updateDeathBlast(group, radius, age) {
  const t = Math.min(1, age / DEATH_LIFE);
  const [core, wave] = group.children;

  // The core is brief and bright; the wave outruns it and keeps going. The
  // two separating is what sells an explosion rather than a flash.
  const coreK = Math.max(0, 1 - age / 0.28);
  core.scale.setScalar(radius * (0.25 + 0.5 * (1 - coreK)));
  core.material.opacity = 0.9 * coreK * coreK;

  const waveK = 1 - (1 - t) ** 3;
  wave.scale.setScalar(radius * (0.2 + 1.5 * waveK));
  wave.material.opacity = 0.45 * (1 - t) ** 2;

  for (let i = 2; i < group.children.length; i++) {
    const shard = group.children[i];
    const { velocity, spin } = shard.userData;
    shard.position.copy(velocity).multiplyScalar(age);
    shard.rotation.set(spin.x * age, spin.y * age, spin.z * age);
  }
  group.userData.shardMaterial.opacity = Math.max(0, 1 - t) ** 1.5;
}

export function createBlast(radius, kind) {
  if (kind === 'death') return createDeathBlast(radius);
  const mesh = new THREE.Mesh(
    blastGeometry,
    new THREE.MeshBasicMaterial({
      color: 0xffb060, transparent: true, opacity: 0.5,
      depthWrite: false, side: THREE.DoubleSide,
    })
  );
  mesh.scale.setScalar(radius * 0.2);
  return mesh;
}

export function updateBlast(mesh, radius, age, kind) {
  if (kind === 'death') { updateDeathBlast(mesh, radius, age); return; }
  const grow = Math.min(1, age / BLAST_GROW_TIME);
  // ease-out: fast expansion that settles, rather than a linear balloon
  mesh.scale.setScalar(radius * (0.2 + 0.8 * (1 - (1 - grow) ** 3)));
  mesh.material.opacity = 0.5 * Math.max(0, 1 - age / BLAST_FADE_TIME);
}

export function disposeBlast(mesh) {
  // A death blast is a group whose children share two per-instance materials
  // plus one shared shard material; a burst is a single mesh owning one.
  if (mesh.isGroup) {
    mesh.children[0].material.dispose();
    mesh.children[1].material.dispose();
    mesh.userData.shardMaterial.dispose();
    return;
  }
  mesh.material.dispose();
}

/** Release the module-level geometry/material singletons on teardown. */
export function disposeFx() {
  flashGeometry.dispose();
  flashMaterial.dispose();
  boltGeometry.dispose();
  boltMaterial.dispose();
  // rail MATERIALS are per-beam; rail.expire() owns those
  railGlowGeometry.dispose();
  railCoreGeometry.dispose();
  flakGeometry.dispose();
  flakMaterial.dispose();
  // ram MATERIALS are per-dome; ram.expire() owns those
  ramGeometry.dispose();
  blastGeometry.dispose();
  deathShardGeometry.dispose();
}
