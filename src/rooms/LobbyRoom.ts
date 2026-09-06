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
}

export class LobbyState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  // linear drag: fraction of velocity shed per second; in state so every
  // client sees the live value (tunable via the 'setDrag' message)
  @type('number') drag: number = 0.15;
}

interface Input {
  thrust: number; // w/s  → -1..1
  roll: number;   // a/d  → -1..1
  pitch: number;  // j/k  → -1..1
}

const THRUST_ACCEL = 10; // units/s²
const TURN_ACCEL = 2.5;  // rad/s² fed into the angular velocity
const MAX_SPEED = 40;    // units/s
const MAX_SPIN = 40 * (Math.PI / 180); // total rotation rate, capped at 40°/s

const IDENTITY = new Quaternion();
const LOCAL_FORWARD = new Vector3(0, 0, -1); // three.js convention: -Z is "forward"
const LOCAL_RIGHT = new Vector3(1, 0, 0);

const clamp1 = (v: unknown) => Math.max(-1, Math.min(1, Number(v) || 0));

export class LobbyRoom extends Room<LobbyState> {
  private inputs = new Map<string, Input>();

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
      });
    });

    this.setSimulationInterval((dtMs) => this.update(dtMs / 1000));
  }

  update(dt: number) {
    this.state.players.forEach((p, sessionId) => {
      const input = this.inputs.get(sessionId) ?? { thrust: 0, roll: 0, pitch: 0 };

      const orientation = new Quaternion(p.qx, p.qy, p.qz, p.qw);
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

      // thrust accelerates along wherever the nose currently points
      if (input.thrust) {
        const forward = LOCAL_FORWARD.clone().applyQuaternion(orientation);
        p.vx += forward.x * input.thrust * THRUST_ACCEL * dt;
        p.vy += forward.y * input.thrust * THRUST_ACCEL * dt;
        p.vz += forward.z * input.thrust * THRUST_ACCEL * dt;
      }

      const damp = Math.max(0, 1 - this.state.drag * dt);
      p.vx *= damp; p.vy *= damp; p.vz *= damp;

      const speed = Math.hypot(p.vx, p.vy, p.vz);
      if (speed > MAX_SPEED) {
        const k = MAX_SPEED / speed;
        p.vx *= k; p.vy *= k; p.vz *= k;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      p.qx = orientation.x; p.qy = orientation.y; p.qz = orientation.z; p.qw = orientation.w;
      p.avx = angVel.x; p.avy = angVel.y; p.avz = angVel.z; p.avw = angVel.w;
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
  }
}
