import { Room, Client } from '@colyseus/core';
import { Schema, MapSchema, type } from '@colyseus/schema';
import { Quaternion, Vector3 } from 'three';

export class Player extends Schema {
  @type('string') name: string = '';

  // position
  @type('number') x: number = 0;
  @type('number') y: number = 0;
  @type('number') z: number = 0;

  // linear velocity (world space)
  @type('number') vx: number = 0;
  @type('number') vy: number = 0;
  @type('number') vz: number = 0;

  // orientation quaternion
  @type('number') qx: number = 0;
  @type('number') qy: number = 0;
  @type('number') qz: number = 0;
  @type('number') qw: number = 1;

  // angular velocity quaternion: the rotation applied per second, in the
  // ship's local frame (identity = not spinning)
  @type('number') avx: number = 0;
  @type('number') avy: number = 0;
  @type('number') avz: number = 0;
  @type('number') avw: number = 1;

  // sequence number of the last look batch folded into the orientation
  // above. The client compares this against its own predicted fold to
  // reconcile ('mouse' scheme only).
  @type('number') lookSeq: number = 0;
}

// A bolt in flight. Only BIRTH state is replicated — the trajectory is a
// straight line, so clients (and the server's own hit tests) place it
// analytically on the shared tick timeline: origin + dir · BOLT_SPEED · age.
// No per-tick position patches: zero ongoing bandwidth, perfectly smooth.
export class Projectile extends Schema {
  @type('string') shooter: string = '';

  // spawn origin (the shooter's ship/eye — same point the reticle ray leaves)
  @type('number') ox: number = 0;
  @type('number') oy: number = 0;
  @type('number') oz: number = 0;

  // unit direction, from the shooter's seq-folded orientation
  @type('number') dx: number = 0;
  @type('number') dy: number = 0;
  @type('number') dz: number = 0;

  @type('number') spawnTick: number = 0;
}

export class LobbyState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Projectile }) projectiles = new MapSchema<Projectile>();
  // linear drag: fraction of velocity shed per second; in state so every
  // client sees the live value (tunable via the 'setDrag' message)
  @type('number') drag: number = 0.15;
  // simulation tick, incremented every update(). Clients echo the latest
  // tick they've seen when firing so hits can be lag-compensated against
  // the world they were actually looking at.
  @type('number') tick: number = 0;
}

// Which control scheme the server simulates. The client must send matching
// input — public/client.js currently implements only 'mouse'; the older
// keyboard clients ('flight', 'strafe') are archived in
// legacy/client-keyboard-controls.js.
// 'flight' = thrust/roll/pitch torque model; 'strafe' = direct-look + strafe;
// 'mouse' = pointer-look (yaw/pitch from mouse deltas) + direct roll + thrust.
const CONTROL_SCHEME: 'flight' | 'strafe' | 'mouse' = 'mouse';

interface Input {
  // 'flight' scheme
  thrust: number; // -1..1
  roll: number;   // -1..1
  pitch: number;  // -1..1
  // 'strafe' scheme
  moveZ: number;     // -1..1, +1 = forward
  moveX: number;     // -1..1, +1 = strafe right
  lookPitch: number; // -1..1, +1 = look up
  lookYaw: number;   // -1..1, +1 = look left (positive rotation about local up)
  boost?: boolean;   // afterburner boost to fly fast for testing
}

const THRUST_ACCEL = 40;     // base units/s²
const BOOST_MULTIPLIER = 25; // 25x acceleration during shift-boost (1,000 units/s²)
const TURN_ACCEL = 2.5;  // rad/s² fed into the angular velocity ('flight')
const LOOK_RATE = 90 * (Math.PI / 180); // direct look rotation, rad/s ('strafe')
const MOUSE_SENS = 0.002;               // rad of rotation per pixel of mouse delta
// MOUSE_SENS and the yaw→pitch→roll batch fold below are duplicated in
// public/client.js for prediction — client and server MUST integrate look
// batches identically or the client's predicted orientation drifts.
const MAX_SPIN = 40 * (Math.PI / 180); // total rotation rate, capped at 40°/s

const IDENTITY = new Quaternion();
const LOCAL_FORWARD = new Vector3(0, 0, -1); // three.js convention: -Z is "forward"
const LOCAL_RIGHT = new Vector3(1, 0, 0);
const LOCAL_UP = new Vector3(0, 1, 0);

const NO_INPUT: Input = { thrust: 0, roll: 0, pitch: 0, moveZ: 0, moveX: 0, lookPitch: 0, lookYaw: 0, boost: false };

const clamp1 = (v: unknown) => Math.max(-1, Math.min(1, Number(v) || 0));

// Instantaneous speed-of-light lasers: raycast hitscan resolved the millisecond
// the trigger is pulled, with full 5km range and zero travel delay.
const FIRE_COOLDOWN_MS = 200;
const LASER_RANGE = 5000;     // 5 km speed-of-light instantaneous reach
const LASER_HIT_RADIUS = 1.4; // ship bounding sphere radius
const TICK_DT = 1 / 60;       // analytic seconds-per-tick (setSimulationInterval default)

// look batches ('mouse'): one accumulated chunk of client input. dx/dy in
// pixels, roll already integrated to radians by the client (it knows its own
// frame timing). seq is client-authored and strictly increasing.
interface LookBatch { seq: number; dx: number; dy: number; roll: number }
const MAX_LOOK_PX = 1000;     // per-batch pixel clamp (≈2 rad of turn)
const MAX_BATCH_ROLL = 0.25;  // per-batch roll clamp, rad (~90°/s at 33ms batches)

// ring buffer of everyone's positions per tick. Projectiles deliberately do
// NOT use it — travel-time weapons are dodgeable by design, and rewinding
// targets on top of that double-compensates ("dodged, died anyway"). Kept
// (and still recorded each tick) for any future hitscan weapon.
const HISTORY_TICKS = 32;

export class LobbyRoom extends Room<LobbyState> {
  private inputs = new Map<string, Input>();
  private lastFireTime = new Map<string, number>();
  // ordered queue of look batches per session, drained into the orientation
  // by update() each tick — or early by fire(), so a shot's aim includes
  // every batch the shooter had applied locally when they pulled the trigger
  private pendingLook = new Map<string, LookBatch[]>();
  // position snapshots for the last HISTORY_TICKS ticks (lag compensation)
  private history: { tick: number; positions: Map<string, Vector3> }[] = [];
  private boltCounter = 0;

  onCreate() {
    this.setState(new LobbyState());

    this.onMessage('setDrag', (_client, value: unknown) => {
      const drag = Number(value);
      if (Number.isFinite(drag)) {
        this.state.drag = Math.max(0, Math.min(5, drag));
        console.log(`[lobby] drag set to ${this.state.drag}`);
      }
    });

    this.onMessage('input', (client, msg: Partial<Input>) => {
      this.inputs.set(client.sessionId, {
        thrust: clamp1(msg?.thrust),
        roll: clamp1(msg?.roll),
        pitch: clamp1(msg?.pitch),
        moveZ: clamp1(msg?.moveZ),
        moveX: clamp1(msg?.moveX),
        lookPitch: clamp1(msg?.lookPitch),
        lookYaw: clamp1(msg?.lookYaw),
        boost: Boolean(msg?.boost),
      });
    });

    this.onMessage('look', (client, msg: Partial<LookBatch>) => {
      const clampPx = (v: unknown) => Math.max(-MAX_LOOK_PX, Math.min(MAX_LOOK_PX, Number(v) || 0));
      const seq = Math.floor(Number(msg?.seq) || 0);
      const queue = this.pendingLook.get(client.sessionId) ?? [];
      // seq must strictly increase past everything queued AND everything
      // already folded — replays/reorders are dropped, not applied twice
      const player = this.state.players.get(client.sessionId);
      const lastSeq = queue.length ? queue[queue.length - 1].seq : (player?.lookSeq ?? 0);
      if (seq <= lastSeq) return;
      queue.push({
        seq,
        dx: clampPx(msg?.dx),
        dy: clampPx(msg?.dy),
        roll: Math.max(-MAX_BATCH_ROLL, Math.min(MAX_BATCH_ROLL, Number(msg?.roll) || 0)),
      });
      this.pendingLook.set(client.sessionId, queue);
    });

    this.onMessage('fire', (client, msg: { seq?: number }) =>
      this.fire(client, Math.floor(Number(msg?.seq) || 0)));

    this.setSimulationInterval((dtMs) => this.update(dtMs / 1000));
  }

  // Fold queued look batches (up to and including upToSeq) into the player's
  // orientation. Per batch: yaw, then pitch, then roll, about local axes —
  // the exact fold the client runs for prediction, so given the same batches
  // both sides compute the same quaternion.
  private drainLook(p: Player, sessionId: string, upToSeq = Infinity) {
    const queue = this.pendingLook.get(sessionId);
    if (!queue?.length) return;
    const orientation = new Quaternion(p.qx, p.qy, p.qz, p.qw);
    while (queue.length && queue[0].seq <= upToSeq) {
      const batch = queue.shift()!;
      if (batch.dx) orientation.multiply(new Quaternion().setFromAxisAngle(LOCAL_UP, -batch.dx * MOUSE_SENS));
      if (batch.dy) orientation.multiply(new Quaternion().setFromAxisAngle(LOCAL_RIGHT, -batch.dy * MOUSE_SENS));
      if (batch.roll) orientation.multiply(new Quaternion().setFromAxisAngle(LOCAL_FORWARD, batch.roll));
      orientation.normalize();
      p.lookSeq = batch.seq;
    }
    p.qx = orientation.x; p.qy = orientation.y; p.qz = orientation.z; p.qw = orientation.w;
  }

  update(dt: number) {
    this.state.tick++;
    this.state.players.forEach((p, sessionId) => {
      const input = this.inputs.get(sessionId) ?? NO_INPUT;

      const orientation = new Quaternion(p.qx, p.qy, p.qz, p.qw);

      if (CONTROL_SCHEME === 'flight') {
        const angVel = new Quaternion(p.avx, p.avy, p.avz, p.avw);

        // inputs torque the angular velocity about the ship's LOCAL axes:
        // roll spins around the nose (forward axis), pitch around the wings
        if (input.roll) {
          angVel.multiply(new Quaternion().setFromAxisAngle(LOCAL_FORWARD, input.roll * TURN_ACCEL * dt));
        }
        if (input.pitch) {
          angVel.multiply(new Quaternion().setFromAxisAngle(LOCAL_RIGHT, input.pitch * TURN_ACCEL * dt));
        }
        // drag bleeds off spin the same way it bleeds off velocity below
        angVel.slerp(IDENTITY, Math.min(1, this.state.drag * dt)).normalize();

        // cap total spin: shrink the per-second rotation back to MAX_SPIN
        const spinAngle = 2 * Math.acos(Math.min(1, Math.abs(angVel.w)));
        if (spinAngle > MAX_SPIN) {
          angVel.copy(new Quaternion().slerpQuaternions(IDENTITY, angVel.clone(), MAX_SPIN / spinAngle));
        }

        // integrate orientation: apply dt's worth of the per-second spin.
        // right-multiplying (orientation ⊗ step) rotates in the ship's own
        // frame — this is what makes roll follow the player's orientation
        // with no extra state.
        const step = new Quaternion().slerpQuaternions(IDENTITY, angVel, dt);
        orientation.multiply(step).normalize();

        const accelMag = THRUST_ACCEL * (input.boost ? BOOST_MULTIPLIER : 1);

        // thrust accelerates along wherever the nose currently points
        if (input.thrust) {
          const forward = LOCAL_FORWARD.clone().applyQuaternion(orientation);
          p.vx += forward.x * input.thrust * accelMag * dt;
          p.vy += forward.y * input.thrust * accelMag * dt;
          p.vz += forward.z * input.thrust * accelMag * dt;
        }

        p.avx = angVel.x; p.avy = angVel.y; p.avz = angVel.z; p.avw = angVel.w;
      } else if (CONTROL_SCHEME === 'strafe') {
        // 'strafe': look inputs rotate the orientation DIRECTLY (no angular
        // velocity, no inertia) about the ship's local axes; releasing the
        // key stops rotation instantly. Angular-velocity quat stays identity.
        if (input.lookPitch) {
          orientation.multiply(new Quaternion().setFromAxisAngle(LOCAL_RIGHT, input.lookPitch * LOOK_RATE * dt));
        }
        if (input.lookYaw) {
          orientation.multiply(new Quaternion().setFromAxisAngle(LOCAL_UP, input.lookYaw * LOOK_RATE * dt));
        }
        orientation.normalize();

        // movement is still acceleration: forward/back plus strafe, in the
        // ship's current local frame
        const accelMag = THRUST_ACCEL * (input.boost ? BOOST_MULTIPLIER : 1);
        if (input.moveZ || input.moveX) {
          const accel = new Vector3()
            .addScaledVector(LOCAL_FORWARD, input.moveZ)
            .addScaledVector(LOCAL_RIGHT, input.moveX)
            .applyQuaternion(orientation)
            .multiplyScalar(accelMag * dt);
          p.vx += accel.x; p.vy += accel.y; p.vz += accel.z;
        }
      } else {
        // 'mouse': pointer deltas yaw/pitch the ship directly (mouse right =
        // yaw right, mouse up = nose up); roll arrives pre-integrated inside
        // the same batches. All rotation is momentum-free — nothing persists
        // on release. drainLook writes p.q* directly; re-read it so thrust
        // pushes along the freshly turned nose.
        this.drainLook(p, sessionId);
        orientation.set(p.qx, p.qy, p.qz, p.qw);

        // w/s: accelerate along the nose; a/d: strafe along the wings
        const accelMag = THRUST_ACCEL * (input.boost ? BOOST_MULTIPLIER : 1);
        if (input.moveZ || input.moveX) {
          const accel = new Vector3()
            .addScaledVector(LOCAL_FORWARD, input.moveZ)
            .addScaledVector(LOCAL_RIGHT, input.moveX)
            .applyQuaternion(orientation)
            .multiplyScalar(accelMag * dt);
          p.vx += accel.x; p.vy += accel.y; p.vz += accel.z;
        }
      }

      // Bypass drag during boost so afterburners can rapidly reach high testing speeds
      const effectiveDrag = input.boost ? 0 : this.state.drag;
      const damp = Math.max(0, 1 - effectiveDrag * dt);
      p.vx *= damp; p.vy *= damp; p.vz *= damp;

      // Speed cap removed so players can fly as fast as they want for testing

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      p.qx = orientation.x; p.qy = orientation.y; p.qz = orientation.z; p.qw = orientation.w;
    });

    // snapshot everyone's position for lag-compensated rewind. Slots recycle
    // every HISTORY_TICKS ticks; each stores its tick so a stale slot can
    // never be mistaken for the requested one.
    const positions = new Map<string, Vector3>();
    this.state.players.forEach((p, sessionId) => positions.set(sessionId, new Vector3(p.x, p.y, p.z)));
    this.history[this.state.tick % HISTORY_TICKS] = { tick: this.state.tick, positions };
  }

  // Instantaneous speed-of-light laser fire: aim is derived from the shooter's
  // input stream. Ray-sphere hitscan is computed immediately on fire — zero delay.
  fire(client: Client, seq: number) {
    const now = Date.now();
    const last = this.lastFireTime.get(client.sessionId);
    if (last !== undefined && now - last < FIRE_COOLDOWN_MS) return;

    const shooter = this.state.players.get(client.sessionId);
    if (!shooter) return;
    this.lastFireTime.set(client.sessionId, now);

    this.drainLook(shooter, client.sessionId, seq);

    const aim = new Quaternion(shooter.qx, shooter.qy, shooter.qz, shooter.qw);
    const dir = LOCAL_FORWARD.clone().applyQuaternion(aim).normalize();
    const origin = new Vector3(shooter.x, shooter.y, shooter.z);

    // Instantaneous ray-sphere intersection against all other players
    let hitDist = LASER_RANGE;
    let victim: string | null = null;
    const r2 = LASER_HIT_RADIUS * LASER_HIT_RADIUS;

    this.state.players.forEach((target, targetId) => {
      if (targetId === client.sessionId) return;
      const toTarget = new Vector3(target.x, target.y, target.z).sub(origin);
      const b = toTarget.dot(dir);
      if (b <= 0) return; // behind shooter
      if (b >= hitDist) return; // further than existing closer hit
      const d2 = toTarget.lengthSq() - b * b;
      if (d2 <= r2) {
        const t = b - Math.sqrt(Math.max(0, r2 - d2));
        if (t < hitDist) {
          hitDist = Math.max(0, t);
          victim = targetId;
        }
      }
    });

    if (victim) {
      console.log(`[lobby] ${client.sessionId} instantly lasered ${victim} at ${hitDist.toFixed(1)}m`);
      this.clients.find((c) => c.sessionId === victim)?.leave(4000);
    }

    // Broadcast instantaneous laser beam to all clients
    this.broadcast('laser', {
      shooter: client.sessionId,
      ox: origin.x,
      oy: origin.y,
      oz: origin.z,
      dx: dir.x,
      dy: dir.y,
      dz: dir.z,
      dist: hitDist,
      hit: Boolean(victim),
    });
  }

  onJoin(client: Client, options: { name?: string }) {
    const player = new Player();
    player.name = (options.name || 'anonymous').slice(0, 24);
    this.state.players.set(client.sessionId, player);
    console.log(`[lobby] ${player.name} joined (${client.sessionId})`);
  }

  onLeave(client: Client) {
    const player = this.state.players.get(client.sessionId);
    console.log(`[lobby] ${player?.name} left (${client.sessionId})`);
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.lastFireTime.delete(client.sessionId);
    this.pendingLook.delete(client.sessionId);
  }
}
