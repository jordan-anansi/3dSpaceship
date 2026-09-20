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
const BOLT_SPEED = 80;
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
const railGeometry = new THREE.BoxGeometry(0.07, 0.07, 1); // unit length; scaled to the beam
const RAIL_COLOR = 0xbfe6ff; // pale blue-white, so a beam never reads as a bolt

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

    // The one per-instance material in this file: the whole effect IS the
    // fade, opacity lives on the material, and beams overlap at different
    // ages — so it can't be a shared singleton like the bolt's. expire()
    // disposes it. Both children share the one instance, hence one dispose.
    const material = new THREE.MeshBasicMaterial({
      color: RAIL_COLOR, transparent: true, depthWrite: false,
    });

    // Group local space: -Z is the beam axis (matching LOCAL_FORWARD), so the
    // beam spans z ∈ [0, -len] and the impact node sits on its far end.
    const group = new THREE.Group();
    const beam = new THREE.Mesh(railGeometry, material);
    beam.scale.set(1, 1, len);
    beam.position.z = -len / 2;
    const impact = new THREE.Mesh(flashGeometry, material);
    impact.position.z = -len;
    group.add(beam, impact);
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
    const [beam, impact] = entry.mesh.children;
    beam.material.opacity = k;
    beam.scale.set(0.3 + 0.7 * k, 0.3 + 0.7 * k, beam.scale.z); // z holds the beam length
    impact.scale.setScalar(Math.max(0.001, k));
  },

  expire(entry) {
    // No impact flash here on purpose: the hit happened at spawn, a fifth of
    // a second before the tracer is deleted, so a flash now would fire at the
    // wrong moment. The impact node in create() is the hit marker.
    entry.mesh.children[0].material.dispose();
  },
};

// --- flak: detonates at a set distance ------------------------------------
// Implemented alongside the server weapon in src/game/weapons/flak.ts.
//
// FLAK_SPEED is duplicated from that file. It matters more than any other
// shared constant: the player sets the fuse by eye, off where they can SEE
// the shell, so drawing it at a speed the server doesn't simulate means
// aiming a different gun from the one being fired.
const FLAK_SPEED = 55;
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

export const SHOT_FX = { bolt, rail, flak };

// --- blasts ---------------------------------------------------------------
// A replicated detonation, purely cosmetic — the server already applied the
// damage on the tick it spawned. Default look is an expanding, fading shell
// at the weapon's true damage radius, so players can SEE how big the AoE
// actually was and learn to judge it.
const blastGeometry = new THREE.SphereGeometry(1, 16, 12);
const BLAST_GROW_TIME = 0.25; // seconds to reach full radius
const BLAST_FADE_TIME = 0.45; // ...and to fade out entirely

export function createBlast(radius) {
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

export function updateBlast(mesh, radius, age) {
  const grow = Math.min(1, age / BLAST_GROW_TIME);
  // ease-out: fast expansion that settles, rather than a linear balloon
  mesh.scale.setScalar(radius * (0.2 + 0.8 * (1 - (1 - grow) ** 3)));
  mesh.material.opacity = 0.5 * Math.max(0, 1 - age / BLAST_FADE_TIME);
}

export function disposeBlast(mesh) {
  mesh.material.dispose();
}

/** Release the module-level geometry/material singletons on teardown. */
export function disposeFx() {
  flashGeometry.dispose();
  flashMaterial.dispose();
  boltGeometry.dispose();
  boltMaterial.dispose();
  railGeometry.dispose(); // rail MATERIALS are per-beam; rail.expire() owns those
  flakGeometry.dispose();
  flakMaterial.dispose();
  blastGeometry.dispose();
}
