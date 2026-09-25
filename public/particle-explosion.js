import * as THREE from 'three';

/**
 * Default explosion particle configuration.
 */
export const DEFAULT_EXPLOSION_CONFIG = {
  count: 900,
  lifespan: 0.85,          // mean lifespan in seconds
  lifespanVariance: 0.25,  // 0 to 1 fractional randomness
  speed: 90.0,             // initial explosive speed (units/s)
  speedVariance: 0.4,      // 0 to 1 fractional randomness
  drag: 1.2,               // velocity decay factor (damping)
  scale: 0.15,             // overall effect scale (multiplies spatial reach and particle size)
  // Size over lifespan (in px at 1 unit distance)
  sizeStart: 4.0,
  sizePeak: 22.0,
  sizeEnd: 0.5,
  sizePeakTime: 0.18,      // 0 to 1: when size reaches peak
  // Color gradient over lifespan
  colorStart: '#f0ffff',   // electric core flash
  colorMid: '#00ddff',     // cyan plasma burst
  colorEnd: '#7700ff',     // deep violet smoke/corona
  colorMidTime: 0.35,      // 0 to 1: when color transitions to mid
  // Opacity over lifespan
  opacityStart: 1.0,
  opacityPeak: 1.0,
  opacityEnd: 0.0,
  opacityPeakTime: 0.1,    // 0 to 1: when opacity reaches peak
  // Turbulence / Noise
  turbulence: 2.2,         // amplitude of chaotic displacement
  noiseFreq: 3.5,          // frequency of turbulence
  blending: 'additive',    // 'additive' or 'normal'
  loopInterval: 1.3,       // seconds between explosions
  timeScale: 1.0,          // playback speed multiplier
};

export const EXPLOSION_PRESETS = {
  shipkill: {
    name: 'Ship Demise (Default)',
    config: {
      count: 900,
      lifespan: 0.85,
      lifespanVariance: 0.25,
      speed: 90.0,
      speedVariance: 0.4,
      drag: 1.2,
      scale: 0.15,
      sizeStart: 4.0,
      sizePeak: 22.0,
      sizeEnd: 0.5,
      sizePeakTime: 0.18,
      colorStart: '#f0ffff',
      colorMid: '#00ddff',
      colorEnd: '#7700ff',
      colorMidTime: 0.35,
      opacityStart: 1.0,
      opacityPeak: 1.0,
      opacityEnd: 0.0,
      opacityPeakTime: 0.1,
      turbulence: 2.2,
      noiseFreq: 3.5,
      blending: 'additive',
      loopInterval: 1.3,
      timeScale: 1.0,
    },
  },
  fireball: {
    name: 'Nova Fireball',
    config: {
      count: 700,
      lifespan: 1.3,
      lifespanVariance: 0.35,
      speed: 36.0,
      speedVariance: 0.4,
      drag: 1.9,
      scale: 1.0,
      sizeStart: 3.0,
      sizePeak: 18.0,
      sizeEnd: 1.0,
      sizePeakTime: 0.25,
      colorStart: '#ffffff',
      colorMid: '#ff6600',
      colorEnd: '#2a0e05',
      colorMidTime: 0.3,
      opacityStart: 0.95,
      opacityPeak: 1.0,
      opacityEnd: 0.0,
      opacityPeakTime: 0.15,
      turbulence: 4.0,
      noiseFreq: 2.5,
      blending: 'additive',
      loopInterval: 1.7,
      timeScale: 1.0,
    },
  },
  plasma: {
    name: 'Plasma Shockwave',
    config: {
      count: 900,
      lifespan: 0.85,
      lifespanVariance: 0.25,
      speed: 68.0,
      speedVariance: 0.3,
      drag: 1.2,
      scale: 1.0,
      sizeStart: 4.0,
      sizePeak: 22.0,
      sizeEnd: 0.5,
      sizePeakTime: 0.18,
      colorStart: '#f0ffff',
      colorMid: '#00ddff',
      colorEnd: '#7700ff',
      colorMidTime: 0.35,
      opacityStart: 1.0,
      opacityPeak: 1.0,
      opacityEnd: 0.0,
      opacityPeakTime: 0.1,
      turbulence: 2.2,
      noiseFreq: 3.5,
      blending: 'additive',
      loopInterval: 1.3,
      timeScale: 1.0,
    },
  },
  shrapnel: {
    name: 'Sparks & Shrapnel',
    config: {
      count: 500,
      lifespan: 1.8,
      lifespanVariance: 0.5,
      speed: 55.0,
      speedVariance: 0.55,
      drag: 0.6,
      scale: 1.0,
      sizeStart: 2.5,
      sizePeak: 4.5,
      sizeEnd: 0.5,
      sizePeakTime: 0.1,
      colorStart: '#ffffff',
      colorMid: '#ffcc33',
      colorEnd: '#ff3300',
      colorMidTime: 0.45,
      opacityStart: 1.0,
      opacityPeak: 1.0,
      opacityEnd: 0.0,
      opacityPeakTime: 0.05,
      turbulence: 1.2,
      noiseFreq: 1.5,
      blending: 'additive',
      loopInterval: 2.1,
      timeScale: 1.0,
    },
  },
  smoke: {
    name: 'Dark Ash & Smoke',
    config: {
      count: 450,
      lifespan: 2.2,
      lifespanVariance: 0.4,
      speed: 24.0,
      speedVariance: 0.5,
      drag: 2.5,
      scale: 1.0,
      sizeStart: 2.0,
      sizePeak: 28.0,
      sizeEnd: 15.0,
      sizePeakTime: 0.35,
      colorStart: '#ffaa44',
      colorMid: '#554433',
      colorEnd: '#151515',
      colorMidTime: 0.22,
      opacityStart: 0.8,
      opacityPeak: 0.65,
      opacityEnd: 0.0,
      opacityPeakTime: 0.2,
      turbulence: 5.5,
      noiseFreq: 2.0,
      blending: 'normal',
      loopInterval: 2.5,
      timeScale: 1.0,
    },
  },
};

const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  uniform float uTime;
  uniform float uDrag;
  uniform float uTurbulence;
  uniform float uNoiseFreq;
  uniform float uSizeStart;
  uniform float uSizePeak;
  uniform float uSizeEnd;
  uniform float uSizePeakTime;
  uniform float uScale;
  uniform vec3 uVelocity;

  attribute vec3 aVelocity;
  attribute float aLifespan;
  attribute vec3 aSeed;
  attribute float aDelay;

  varying float vProgress;
  varying float vActive;

  void main() {
    float age = uTime - aDelay;
    if (age < 0.0 || age >= aLifespan) {
      vActive = 0.0;
      gl_PointSize = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off-screen
      return;
    }
    vActive = 1.0;
    float p = clamp(age / aLifespan, 0.0, 1.0);
    vProgress = p;

    // Ballistic displacement with drag:
    // d(t) = v0 * (1 - exp(-drag * t)) / drag
    float disp = (uDrag > 0.001) ? (1.0 - exp(-uDrag * age)) / uDrag : age;
    vec3 localPos = aVelocity * disp;

    // Organic 3D turbulence (pseudo-curl sinusoidal noise)
    vec3 noise = vec3(
      sin(aSeed.x * 12.3 + age * uNoiseFreq) * cos(aSeed.y * 7.1 + age * uNoiseFreq * 0.7),
      cos(aSeed.y * 11.7 + age * uNoiseFreq * 1.1) * sin(aSeed.z * 8.4 + age * uNoiseFreq * 0.6),
      sin(aSeed.z * 13.1 + age * uNoiseFreq * 0.9) * cos(aSeed.x * 9.5 + age * uNoiseFreq * 0.8)
    );
    localPos += noise * (uTurbulence * p);

    // Apply overall effect scale to 3D local positions
    localPos *= uScale;

    // Inherit downed ship's velocity at moment of destruction
    vec3 pos = localPos + uVelocity * disp;

    // 3-point size curve (start -> peak -> end)
    float sz;
    if (p < uSizePeakTime) {
      sz = mix(uSizeStart, uSizePeak, p / max(0.001, uSizePeakTime));
    } else {
      sz = mix(uSizePeak, uSizeEnd, (p - uSizePeakTime) / max(0.001, 1.0 - uSizePeakTime));
    }
    // Apply overall effect scale to particle screen/world size
    sz *= uScale;

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    // Perspective point size attenuation
    gl_PointSize = sz * (320.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;

    #include <logdepthbuf_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform vec3 uColorStart;
  uniform vec3 uColorMid;
  uniform vec3 uColorEnd;
  uniform float uColorMidTime;
  uniform float uOpacityStart;
  uniform float uOpacityPeak;
  uniform float uOpacityEnd;
  uniform float uOpacityPeakTime;

  varying float vProgress;
  varying float vActive;

  void main() {
    if (vActive < 0.5) discard;

    // Soft circular radial falloff
    vec2 coord = gl_PointCoord - vec2(0.5);
    float dist = length(coord);
    if (dist > 0.5) discard;
    float soft = smoothstep(0.5, 0.05, dist);

    // 3-point color gradient
    vec3 col;
    if (vProgress < uColorMidTime) {
      col = mix(uColorStart, uColorMid, vProgress / max(0.001, uColorMidTime));
    } else {
      col = mix(uColorMid, uColorEnd, (vProgress - uColorMidTime) / max(0.001, 1.0 - uColorMidTime));
    }

    // 3-point opacity curve
    float alpha;
    if (vProgress < uOpacityPeakTime) {
      alpha = mix(uOpacityStart, uOpacityPeak, vProgress / max(0.001, uOpacityPeakTime));
    } else {
      alpha = mix(uOpacityPeak, uOpacityEnd, (vProgress - uOpacityPeakTime) / max(0.001, 1.0 - uOpacityPeakTime));
    }

    gl_FragColor = vec4(col, alpha * soft);

    #include <logdepthbuf_fragment>
  }
`;

/**
 * Generate randomized particle attributes for an explosion burst.
 */
function buildParticleGeometry(count, config) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3); // initial anchor is 0
  const velocities = new Float32Array(count * 3);
  const lifespans = new Float32Array(count);
  const seeds = new Float32Array(count * 3);
  const delays = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // Uniform spherical direction
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * Math.PI * 2;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    const dirX = s * Math.cos(theta);
    const dirY = u;
    const dirZ = s * Math.sin(theta);

    // Randomized speed with variance
    const speedRandom = 1 + (Math.random() * 2 - 1) * config.speedVariance;
    const speed = Math.max(1, config.speed * speedRandom);

    velocities[i * 3] = dirX * speed;
    velocities[i * 3 + 1] = dirY * speed;
    velocities[i * 3 + 2] = dirZ * speed;

    // Lifespan with variance
    const lifeRandom = 1 + (Math.random() * 2 - 1) * config.lifespanVariance;
    lifespans[i] = Math.max(0.1, config.lifespan * lifeRandom);

    // Micro-delay on ignition (first 0.05s) for a natural burst volume
    delays[i] = Math.random() * 0.05;

    // Random seed for noise / turbulence
    seeds[i * 3] = Math.random();
    seeds[i * 3 + 1] = Math.random();
    seeds[i * 3 + 2] = Math.random();
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aVelocity', new THREE.BufferAttribute(velocities, 3));
  geometry.setAttribute('aLifespan', new THREE.BufferAttribute(lifespans, 1));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
  geometry.setAttribute('aDelay', new THREE.BufferAttribute(delays, 1));

  return geometry;
}

/**
 * Creates an explosion particle system in the Three.js scene.
 */
export function createExplosionSystem(options = {}) {
  const config = { ...DEFAULT_EXPLOSION_CONFIG, ...options };
  const geometry = buildParticleGeometry(config.count, config);

  const uniforms = {
    uTime: { value: 0.0 },
    uDrag: { value: config.drag },
    uTurbulence: { value: config.turbulence },
    uNoiseFreq: { value: config.noiseFreq },
    uSizeStart: { value: config.sizeStart },
    uSizePeak: { value: config.sizePeak },
    uSizeEnd: { value: config.sizeEnd },
    uSizePeakTime: { value: config.sizePeakTime },
    uColorStart: { value: new THREE.Color(config.colorStart) },
    uColorMid: { value: new THREE.Color(config.colorMid) },
    uColorEnd: { value: new THREE.Color(config.colorEnd) },
    uColorMidTime: { value: config.colorMidTime },
    uOpacityStart: { value: config.opacityStart },
    uOpacityPeak: { value: config.opacityPeak },
    uOpacityEnd: { value: config.opacityEnd },
    uOpacityPeakTime: { value: config.opacityPeakTime },
    uScale: { value: config.scale ?? 1.0 },
    uVelocity: {
      value: options.velocity
        ? new THREE.Vector3(options.velocity.x || 0, options.velocity.y || 0, options.velocity.z || 0)
        : new THREE.Vector3(0, 0, 0),
    },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: config.blending === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  const system = {
    points,
    material,
    geometry,
    config,
    time: 0.0,
    playing: true,
    autoLoop: true,

    trigger() {
      system.time = 0.0;
      system.material.uniforms.uTime.value = 0.0;
    },

    rebuild(newConfig) {
      Object.assign(system.config, newConfig);
      const oldGeom = system.points.geometry;
      system.geometry = buildParticleGeometry(system.config.count, system.config);
      system.points.geometry = system.geometry;
      oldGeom.dispose();
      system.updateUniforms();
      system.trigger();
    },

    updateUniforms(newConfig) {
      if (newConfig) Object.assign(system.config, newConfig);
      const c = system.config;
      const u = system.material.uniforms;

      u.uDrag.value = c.drag;
      u.uTurbulence.value = c.turbulence;
      u.uNoiseFreq.value = c.noiseFreq;
      u.uSizeStart.value = c.sizeStart;
      u.uSizePeak.value = c.sizePeak;
      u.uSizeEnd.value = c.sizeEnd;
      u.uSizePeakTime.value = c.sizePeakTime;
      u.uScale.value = c.scale ?? 1.0;
      u.uColorStart.value.set(c.colorStart);
      u.uColorMid.value.set(c.colorMid);
      u.uColorEnd.value.set(c.colorEnd);
      u.uColorMidTime.value = c.colorMidTime;
      u.uOpacityStart.value = c.opacityStart;
      u.uOpacityPeak.value = c.opacityPeak;
      u.uOpacityEnd.value = c.opacityEnd;
      u.uOpacityPeakTime.value = c.opacityPeakTime;
      if (c.velocity) {
        u.uVelocity.value.set(c.velocity.x || 0, c.velocity.y || 0, c.velocity.z || 0);
      }

      system.material.blending = c.blending === 'normal'
        ? THREE.NormalBlending
        : THREE.AdditiveBlending;
      system.material.needsUpdate = true;
    },

    step(dt) {
      if (!system.playing) return;
      const effectiveDt = dt * (system.config.timeScale ?? 1.0);
      system.time += effectiveDt;

      // Auto-loop check
      if (system.autoLoop && system.time >= system.config.loopInterval) {
        system.time = 0.0;
      }

      system.material.uniforms.uTime.value = system.time;
    },

    dispose() {
      system.geometry.dispose();
      system.material.dispose();
    },
  };

  return system;
}

const USER_PRESETS_KEY = '3dspaceship_explosion_user_presets';

export function loadUserPresets() {
  try {
    const raw = localStorage.getItem(USER_PRESETS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveUserPreset(name, config) {
  const presets = loadUserPresets();
  presets[name] = {
    name,
    config: { ...config },
    custom: true,
  };
  try {
    localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(presets));
  } catch (err) {
    console.warn('Failed to save preset to localStorage', err);
  }
  return presets;
}

export function deleteUserPreset(name) {
  const presets = loadUserPresets();
  delete presets[name];
  try {
    localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(presets));
  } catch (err) {
    console.warn('Failed to delete preset from localStorage', err);
  }
  return presets;
}

export function getAllPresets() {
  const user = loadUserPresets();
  return { ...EXPLOSION_PRESETS, ...user };
}

export const ACTIVE_CONFIG_KEY = '3dspaceship_active_explosion_config';

export function getActiveExplosionConfig() {
  try {
    const raw = localStorage.getItem(ACTIVE_CONFIG_KEY);
    if (raw) return JSON.parse(raw);
  } catch (err) {
    console.warn('Failed to load active explosion config from localStorage', err);
  }
  return { ...DEFAULT_EXPLOSION_CONFIG };
}

export function setActiveExplosionConfig(config) {
  try {
    localStorage.setItem(ACTIVE_CONFIG_KEY, JSON.stringify(config));
  } catch (err) {
    console.warn('Failed to save active explosion config to localStorage', err);
  }
}

/**
 * Spawns a one-shot explosion at a specified world position (e.g. for in-game ship deaths).
 * An optional velocity vector (e.g. from the downed ship) will be inherited by the particles.
 */
export function spawnOneShotExplosion(scene, position, config, velocity) {
  const system = createExplosionSystem({ ...config, autoLoop: false, velocity });
  system.points.position.copy(position);
  scene.add(system.points);
  system.trigger();

  const maxLife = ((config.lifespan || 1.2) * (1 + (config.lifespanVariance || 0.35))) / (config.timeScale || 1.0) + 0.2;
  let elapsed = 0;

  return {
    step(dt) {
      elapsed += dt;
      system.step(dt);
      if (elapsed >= maxLife) {
        scene.remove(system.points);
        system.dispose();
        return false; // completed
      }
      return true; // still alive
    },
    dispose() {
      scene.remove(system.points);
      system.dispose();
    },
  };
}

