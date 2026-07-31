// Pandora — the default world.
//
// A bioluminescent moon with no level file, no scene graph, and no authored
// terrain. Every ridge, every plant, and every drifting seed is a pure function
// of the world seed and a coordinate; nothing exists until somebody looks at
// it, and once somebody has, that region keeps its history forever.
//
// Walk somewhere and the ground remembers your footfalls. Pass a plant and it
// answers, and the first time it answers is written down. Pluck one and it
// stays plucked — leave, walk a kilometre, come back an hour later, and the
// gap is still there, because default reality was regenerated from causes and
// your divergence was replayed over it.
//
// The avatar is an entity like any other. Input reaches it only as commands,
// which means a session is a recording: the whole traversal replays from a
// checkpoint and a command log.

import { Backend, Domain, Mode } from '../core/scheduler.js';
import { Biome, MOUNTAIN_RADIUS, SEA_LEVEL, biomeAt, heightAt, mountainCenter, normalAt } from '../core/terrain.js';
import { DEFAULT_REGION_SIZE, RegionMemory, RegionState } from '../core/regions.js';
import { EventClass } from '../core/events.js';
import { Rng, seedFrom } from '../core/rng.js';
import { World } from '../core/world.js';

export const TICK_HZ = 60;
export const GRAVITY = -26;
export const WALK_SPEED = 7.4;
export const SPRINT_SPEED = 14.5;
export const SWIM_SPEED = 4.6;
export const JUMP_SPEED = 11.5;
export const EYE_HEIGHT = 2.6;

export const Kind = { AVATAR: 0, FLORA: 1, FAUNA: 2, BEACON: 3 };

/** Six plant species, each with its own light colour and response curve. */
export const SPECIES = [
  { name: 'helicoradian', hue: 0.52, radius: 7.5, height: 4.2, response: 1.0 },
  { name: 'nightpiper', hue: 0.72, radius: 5.0, height: 2.4, response: 1.5 },
  { name: 'anemonoid', hue: 0.86, radius: 9.0, height: 1.4, response: 0.7 },
  { name: 'lanternfern', hue: 0.35, radius: 4.2, height: 1.8, response: 1.8 },
  { name: 'spiralvine', hue: 0.62, radius: 6.4, height: 6.5, response: 0.9 },
  { name: 'emberfrond', hue: 0.08, radius: 5.6, height: 3.1, response: 1.2 },
];

export const DEFAULT_CONFIG = {
  seed: 1755205,
  universe: 'pandora',
  label: 'root',
  regionSize: DEFAULT_REGION_SIZE,
  viewRadius: 300, // regions within this distance of the avatar become resident
  keepRadius: 460, // ...and are released beyond this one
  floraPerRegion: 26,
  faunaPerRegion: 7,
};

// ---------------------------------------------------------------------------
// Schema, stores, systems, commands. Everything a fork must reinstall.
// ---------------------------------------------------------------------------

export function install(world) {
  const config = { ...DEFAULT_CONFIG, ...(world.options.config ?? {}) };
  world.config = config;

  world.defineComponent('Position', { x: 'f64', y: 'f64', z: 'f64' });
  world.defineComponent('Velocity', { x: 'f64', y: 'f64', z: 'f64' });
  world.defineComponent('Region', { cx: 'i32', cy: 'i32', slot: 'i32' });
  world.defineComponent('Renderable', { kind: 'u8', hue: 'f32', size: 'f32' });
  world.defineComponent('Avatar', {
    yaw: 'f64',
    pitch: 'f64',
    grounded: 'u8',
    swimming: 'u8',
    stamina: 'f64',
    stride: 'f64',
    distance: 'f64',
  });
  world.defineComponent('Appearance', {
    height: 'f32', // 1.0 = 2.6 m
    build: 'f32', // slender <-> broad
    skinHue: 'f32',
    glowHue: 'f32',
    glowDensity: 'f32',
    marking: 'u8',
    queue: 'f32',
  });
  world.defineComponent('Intent', {
    forward: 'f64',
    strafe: 'f64',
    jump: 'u8',
    sprint: 'u8',
    interact: 'u8',
  });
  world.defineComponent('Flora', {
    species: 'u8',
    charge: 'f32',
    bloomed: 'u8',
    phase: 'f32',
    scale: 'f32',
  });
  world.defineComponent('Fauna', { species: 'u8', phase: 'f32', drift: 'f32', bob: 'f32' });

  world.registerStore('regions', new RegionMemory({
    seed: world.seed,
    size: config.regionSize,
    generatorVersion: 1,
  }));

  installSystems(world, config);
  installCommands(world);
}

// ---------------------------------------------------------------------------
// Region residency — the LOD ladder made literal.
// ---------------------------------------------------------------------------

/** Deterministic contents of a region: positions are causes, never storage. */
export function regionContents(world, cx, cy) {
  const config = world.config;
  const size = config.regionSize;
  const rng = new Rng(seedFrom(world.seed, 'region', cx, cy));
  const flora = [];
  const fauna = [];

  for (let i = 0; i < config.floraPerRegion; i++) {
    const x = (cx + rng.next()) * size;
    const z = (cy + rng.next()) * size;
    const y = heightAt(x, z, world.seed);
    if (y < SEA_LEVEL + 0.4) continue; // nothing takes root in the shallows
    const normal = normalAt(x, z, world.seed);
    if (normal.y < 0.62) continue; // nor on a cliff face
    const biome = biomeAt(x, z, world.seed);
    const species = pickSpecies(biome, rng);
    if (species < 0) continue;
    flora.push({ slot: i, x, y, z, species, scale: 0.7 + rng.next() * 0.9, phase: rng.next() });
  }

  for (let i = 0; i < config.faunaPerRegion; i++) {
    const x = (cx + rng.next()) * size;
    const z = (cy + rng.next()) * size;
    const ground = heightAt(x, z, world.seed);
    if (ground < SEA_LEVEL) continue;
    fauna.push({
      slot: 1000 + i,
      x,
      y: ground + 3 + rng.next() * 12,
      z,
      species: rng.int(2),
      phase: rng.next(),
      drift: 0.4 + rng.next() * 0.8,
    });
  }

  return { flora, fauna };
}

function pickSpecies(biome, rng) {
  switch (biome) {
    case Biome.BEACH:
      return rng.next() < 0.45 ? 2 : -1;
    case Biome.MEADOW:
      return rng.pick([1, 3, 3, 2]);
    case Biome.CANOPY:
      return rng.pick([0, 0, 4, 1, 3]);
    case Biome.HIGHLAND:
      return rng.next() < 0.6 ? 5 : 4;
    case Biome.SPIRE:
      return rng.next() < 0.35 ? 5 : -1;
    default:
      return -1;
  }
}

function materialize(world, region) {
  const memory = world.store('regions');
  const contents = regionContents(world, region.cx, region.cy);

  // Divergence: what this place remembers about itself.
  const harvested = new Set();
  const bloomed = new Set();
  for (const mutation of memory.resolve(region.cx, region.cy, world.tick)) {
    if (mutation.op === 'harvest') harvested.add(mutation.slot);
    else if (mutation.op === 'bloom') bloomed.add(mutation.slot);
  }

  for (const plant of contents.flora) {
    if (harvested.has(plant.slot)) continue; // plucked once, plucked forever
    world.spawn(
      {
        Position: { x: plant.x, y: plant.y, z: plant.z },
        Region: { cx: region.cx, cy: region.cy, slot: plant.slot },
        Flora: {
          species: plant.species,
          charge: bloomed.has(plant.slot) ? 0.35 : 0,
          bloomed: bloomed.has(plant.slot) ? 1 : 0,
          phase: plant.phase,
          scale: plant.scale,
        },
        Renderable: { kind: Kind.FLORA, hue: SPECIES[plant.species].hue, size: SPECIES[plant.species].height },
      },
      { kind: 'flora', operation: 'flora.emerge' },
    );
  }

  for (const creature of contents.fauna) {
    world.spawn(
      {
        Position: { x: creature.x, y: creature.y, z: creature.z },
        Velocity: { x: 0, y: 0, z: 0 },
        Region: { cx: region.cx, cy: region.cy, slot: creature.slot },
        Fauna: { species: creature.species, phase: creature.phase, drift: creature.drift, bob: 0 },
        Renderable: { kind: Kind.FAUNA, hue: 0.55, size: 0.5 },
      },
      { kind: 'fauna', operation: 'fauna.arrive' },
    );
  }
}

function dematerialize(world, cx, cy) {
  const doomed = [];
  for (const chunk of world.ecs.query(['Region'])) {
    const rx = chunk.col('Region', 'cx');
    const rz = chunk.col('Region', 'cy');
    for (let i = 0; i < chunk.count; i++) {
      if (rx[i] === cx && rz[i] === cy) doomed.push(chunk.entity(i));
    }
  }
  for (const handle of doomed) world.ecs.destroy(handle);
  return doomed.length;
}

// ---------------------------------------------------------------------------
// Systems
// ---------------------------------------------------------------------------

function installSystems(world, config) {
  world.addSystem({
    name: 'Residency',
    reads: ['Position', 'Avatar'],
    writes: ['regions', 'lifecycle'],
    domain: Domain.SPATIAL,
    rateHz: 4,
    backend: Backend.CPU_SCALAR,
    run(w) {
      const avatar = avatarHandle(w);
      if (avatar === null) return;
      const memory = w.store('regions');
      const p = w.ecs.get(avatar, 'Position');
      const size = memory.size;
      const span = Math.ceil(config.viewRadius / size);
      const here = memory.coordOf(p.x, p.z);

      for (let dz = -span; dz <= span; dz++) {
        for (let dx = -span; dx <= span; dx++) {
          const cx = here.cx + dx;
          const cy = here.cy + dz;
          const center = memory.centerOf(cx, cy);
          if (Math.hypot(center.x - p.x, center.z - p.z) > config.viewRadius) continue;
          if (memory.stateOf(cx, cy) === RegionState.RESIDENT) continue;
          const { region, returning } = memory.observe(cx, cy, w.tick);
          materialize(w, region);
          w.emit({
            operation: returning ? 'region.recall' : 'region.witness',
            class: EventClass.LIFECYCLE,
            target: `region:${cx},${cy}`,
            payload: {
              cx,
              cy,
              x: center.x,
              y: center.z,
              remembered: region.mutations.length,
              observations: region.observations,
            },
          });
        }
      }

      for (const region of memory.residents()) {
        const center = memory.centerOf(region.cx, region.cy);
        if (Math.hypot(center.x - p.x, center.z - p.z) <= config.keepRadius) continue;
        const removed = dematerialize(w, region.cx, region.cy);
        memory.release(region.cx, region.cy, w.tick);
        w.emit({
          operation: 'region.release',
          class: EventClass.LIFECYCLE,
          target: `region:${region.cx},${region.cy}`,
          payload: { cx: region.cx, cy: region.cy, entities: removed, remembered: region.mutations.length },
        });
      }
    },
  });

  world.addSystem({
    name: 'AvatarMotion',
    reads: ['Intent', 'Appearance'],
    writes: ['Position', 'Velocity', 'Avatar'],
    domain: Domain.AGENT,
    backend: Backend.CPU_SCALAR,
    mode: Mode.DETERMINISTIC,
    run(w) {
      const dt = w.dt;
      for (const chunk of w.ecs.query(['Position', 'Velocity', 'Avatar', 'Intent', 'Appearance'])) {
        const px = chunk.col('Position', 'x');
        const py = chunk.col('Position', 'y');
        const pz = chunk.col('Position', 'z');
        const vx = chunk.col('Velocity', 'x');
        const vy = chunk.col('Velocity', 'y');
        const vz = chunk.col('Velocity', 'z');
        const yaw = chunk.col('Avatar', 'yaw');
        const grounded = chunk.col('Avatar', 'grounded');
        const swimming = chunk.col('Avatar', 'swimming');
        const stamina = chunk.col('Avatar', 'stamina');
        const distance = chunk.col('Avatar', 'distance');
        const forward = chunk.col('Intent', 'forward');
        const strafe = chunk.col('Intent', 'strafe');
        const jump = chunk.col('Intent', 'jump');
        const sprint = chunk.col('Intent', 'sprint');
        const heightScale = chunk.col('Appearance', 'height');

        for (let i = 0; i < chunk.count; i++) {
          const eye = EYE_HEIGHT * heightScale[i];
          const ground = heightAt(px[i], pz[i], w.seed);
          const inWater = py[i] < SEA_LEVEL + eye * 0.55 && ground < SEA_LEVEL;
          swimming[i] = inWater ? 1 : 0;

          // Intent is expressed in the avatar's frame; the world only ever sees
          // the resulting velocity.
          const sin = Math.sin(yaw[i]);
          const cos = Math.cos(yaw[i]);
          let dirX = forward[i] * sin + strafe[i] * cos;
          let dirZ = forward[i] * cos - strafe[i] * sin;
          const magnitude = Math.hypot(dirX, dirZ);
          if (magnitude > 1) {
            dirX /= magnitude;
            dirZ /= magnitude;
          }

          const wants = sprint[i] === 1 && stamina[i] > 0.05 && !inWater;
          const speed = inWater ? SWIM_SPEED : wants ? SPRINT_SPEED : WALK_SPEED;
          stamina[i] = clamp(stamina[i] + (wants && magnitude > 0.1 ? -0.32 : 0.22) * dt, 0, 1);

          // Slope resistance: a steep face costs you, it does not stop you.
          const normal = normalAt(px[i], pz[i], w.seed, 1.2);
          const climb = clamp(1 - (1 - normal.y) * 1.35, 0.25, 1);
          const control = grounded[i] === 1 ? 12 : 2.4;
          vx[i] += (dirX * speed * climb - vx[i]) * Math.min(1, control * dt);
          vz[i] += (dirZ * speed * climb - vz[i]) * Math.min(1, control * dt);

          if (inWater) {
            const submersion = clamp((SEA_LEVEL - py[i] + eye) / eye, 0, 1);
            vy[i] += (GRAVITY * 0.18 + submersion * 34) * dt;
            vy[i] *= 0.86;
            if (jump[i] === 1) vy[i] += 9 * dt * 30;
          } else {
            vy[i] += GRAVITY * dt;
            if (jump[i] === 1 && grounded[i] === 1) {
              vy[i] = JUMP_SPEED;
              grounded[i] = 0;
            }
          }

          px[i] += vx[i] * dt;
          py[i] += vy[i] * dt;
          pz[i] += vz[i] * dt;

          const floor = Math.max(heightAt(px[i], pz[i], w.seed), inWater ? -1e9 : SEA_LEVEL - 3) + eye;
          if (py[i] <= floor) {
            py[i] = floor;
            if (vy[i] < 0) vy[i] = 0;
            grounded[i] = 1;
          } else if (py[i] > floor + 0.12) {
            grounded[i] = 0;
          }

          distance[i] += Math.hypot(vx[i], vz[i]) * dt;
        }
      }
    },
  });

  world.addSystem({
    name: 'TrailMemory',
    reads: ['Position', 'Avatar'],
    writes: ['regions'],
    domain: Domain.GLOBAL,
    rateHz: 12,
    backend: Backend.CPU_SCALAR,
    run(w) {
      const avatar = avatarHandle(w);
      if (avatar === null) return;
      const state = w.ecs.get(avatar, 'Avatar');
      if (state.grounded !== 1) return;
      if (state.distance - state.stride < 2.6) return;

      const memory = w.store('regions');
      const p = w.ecs.get(avatar, 'Position');
      const { cx, cy } = memory.coordOf(p.x, p.z);
      if (memory.stateOf(cx, cy) === RegionState.LATENT) return;

      w.ecs.set(avatar, 'Avatar', { stride: state.distance });
      memory.record(cx, cy, {
        tick: w.tick,
        op: 'trail',
        x: round(p.x, 2),
        z: round(p.z, 2),
        y: round(heightAt(p.x, p.z, w.seed), 2),
        intensity: state.swimming ? 0.45 : 1,
      });
    },
  });

  world.addSystem({
    name: 'FloraResponse',
    reads: ['Position', 'Avatar'],
    writes: ['Flora', 'regions'],
    domain: Domain.FIELD,
    rateHz: 15,
    backend: Backend.CPU_SIMD,
    run(w, system) {
      const dt = w.scheduler.interval(system) / w.tickHz;
      const avatar = avatarHandle(w);
      // Plants answer to feet, not to eyes: measure from where the avatar
      // actually touches the world.
      let p = null;
      if (avatar !== null) {
        const eye = w.ecs.get(avatar, 'Position');
        const scale = w.ecs.get(avatar, 'Appearance').height;
        p = { x: eye.x, y: eye.y - EYE_HEIGHT * scale, z: eye.z };
      }
      const memory = w.store('regions');
      const blooms = [];

      for (const chunk of w.ecs.query(['Position', 'Flora', 'Region'])) {
        const px = chunk.col('Position', 'x');
        const py = chunk.col('Position', 'y');
        const pz = chunk.col('Position', 'z');
        const species = chunk.col('Flora', 'species');
        const charge = chunk.col('Flora', 'charge');
        const bloomed = chunk.col('Flora', 'bloomed');
        const rx = chunk.col('Region', 'cx');
        const rz = chunk.col('Region', 'cy');
        const slot = chunk.col('Region', 'slot');

        for (let i = 0; i < chunk.count; i++) {
          let excitation = 0;
          if (p) {
            // Height matters less than proximity — a plant notices you walking
            // past it, not you standing on a ledge above it.
            const distance = Math.hypot(px[i] - p.x, (py[i] - p.y) * 0.5, pz[i] - p.z);
            const radius = SPECIES[species[i]].radius;
            if (distance < radius) {
              excitation = (1 - distance / radius) * SPECIES[species[i]].response;
            }
          }
          const target = Math.min(1, excitation);
          const rate = target > charge[i] ? 3.4 : 0.55;
          charge[i] += (target - charge[i]) * Math.min(1, rate * dt);
          if (bloomed[i] === 0 && charge[i] > 0.82) {
            bloomed[i] = 1;
            blooms.push({ cx: rx[i], cy: rz[i], slot: slot[i], x: px[i], z: pz[i], species: species[i] });
          }
        }
      }

      // First contact is a fact about the world, so it is written down.
      for (const bloom of blooms) {
        memory.record(bloom.cx, bloom.cy, { tick: w.tick, op: 'bloom', slot: bloom.slot, intensity: 1 });
        w.emit({
          operation: 'flora.bloom',
          class: EventClass.CONSEQUENCE,
          target: `region:${bloom.cx},${bloom.cy}`,
          payload: { species: SPECIES[bloom.species].name, x: round(bloom.x), y: round(bloom.z), slot: bloom.slot },
        });
      }
    },
  });

  world.addSystem({
    name: 'FaunaDrift',
    reads: ['Fauna'],
    writes: ['Position', 'Velocity'],
    domain: Domain.SPATIAL,
    backend: Backend.CPU_SIMD | Backend.GPU_COMPUTE,
    run(w) {
      const dt = w.dt;
      const time = w.time;
      const avatar = avatarHandle(w);
      const p = avatar === null ? null : w.ecs.get(avatar, 'Position');
      for (const chunk of w.ecs.query(['Position', 'Velocity', 'Fauna'])) {
        const px = chunk.col('Position', 'x');
        const py = chunk.col('Position', 'y');
        const pz = chunk.col('Position', 'z');
        const vx = chunk.col('Velocity', 'x');
        const vy = chunk.col('Velocity', 'y');
        const vz = chunk.col('Velocity', 'z');
        const phase = chunk.col('Fauna', 'phase');
        const drift = chunk.col('Fauna', 'drift');
        const bob = chunk.col('Fauna', 'bob');

        for (let i = 0; i < chunk.count; i++) {
          const t = time * drift[i] + phase[i] * 6.28318;
          vx[i] += (Math.sin(t * 0.7) * 1.6 - vx[i]) * 0.9 * dt;
          vz[i] += (Math.cos(t * 0.53) * 1.6 - vz[i]) * 0.9 * dt;
          bob[i] = Math.sin(t * 1.7);

          // Seeds drift toward someone standing still, and away from someone
          // crashing through the undergrowth.
          if (p) {
            const dx = p.x - px[i];
            const dz = p.z - pz[i];
            const dy = p.y + 1.5 - py[i];
            const distance = Math.hypot(dx, dy, dz);
            if (distance < 26 && distance > 0.5) {
              const pull = (1 - distance / 26) * 2.2;
              vx[i] += (dx / distance) * pull * dt;
              vy[i] += (dy / distance) * pull * dt;
              vz[i] += (dz / distance) * pull * dt;
            }
          }

          px[i] += vx[i] * dt;
          py[i] += (vy[i] + bob[i] * 0.5) * dt;
          pz[i] += vz[i] * dt;

          const floor = heightAt(px[i], pz[i], w.seed) + 2.2;
          if (py[i] < floor) {
            py[i] = floor;
            vy[i] = Math.abs(vy[i]) * 0.4;
          }
          const ceiling = floor + 26;
          if (py[i] > ceiling) {
            py[i] = ceiling;
            vy[i] = -Math.abs(vy[i]) * 0.4;
          }
          vy[i] *= 0.985;
        }
      }
    },
  });

  world.addSystem({
    name: 'SpatialIndex',
    reads: ['Position'],
    writes: ['spatial'],
    domain: Domain.SPATIAL,
    backend: Backend.CPU_SCALAR,
    run(w) {
      w.spatial.clear();
      for (const chunk of w.ecs.query(['Position'])) {
        const px = chunk.col('Position', 'x');
        const pz = chunk.col('Position', 'z');
        for (let i = 0; i < chunk.count; i++) w.spatial.insert(chunk.entity(i), px[i], pz[i]);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Commands — including every frame of input.
// ---------------------------------------------------------------------------

function installCommands(world) {
  world.onCommand('avatar.intent', (w, payload) => {
    const avatar = avatarHandle(w);
    if (avatar === null) return;
    w.ecs.set(avatar, 'Intent', {
      forward: clamp(payload.forward ?? 0, -1, 1),
      strafe: clamp(payload.strafe ?? 0, -1, 1),
      jump: payload.jump ? 1 : 0,
      sprint: payload.sprint ? 1 : 0,
      interact: payload.interact ? 1 : 0,
    });
    if (payload.yaw !== undefined || payload.pitch !== undefined) {
      const state = w.ecs.get(avatar, 'Avatar');
      w.ecs.set(avatar, 'Avatar', {
        yaw: payload.yaw ?? state.yaw,
        pitch: clamp(payload.pitch ?? state.pitch, -1.35, 1.2),
      });
    }
  });

  world.onCommand('avatar.customize', (w, payload) => {
    const avatar = avatarHandle(w);
    if (avatar === null) return;
    const current = w.ecs.get(avatar, 'Appearance');
    w.ecs.set(avatar, 'Appearance', {
      height: clamp(payload.height ?? current.height, 0.75, 1.35),
      build: clamp(payload.build ?? current.build, 0, 1),
      skinHue: payload.skinHue ?? current.skinHue,
      glowHue: payload.glowHue ?? current.glowHue,
      glowDensity: clamp(payload.glowDensity ?? current.glowDensity, 0, 1),
      marking: payload.marking ?? current.marking,
      queue: clamp(payload.queue ?? current.queue, 0, 1),
    });
  });

  /** Take a plant. The region remembers the gap for as long as it is remembered. */
  world.onCommand('world.harvest', (w, payload) => {
    const memory = w.store('regions');
    const found = w.spatial.queryRadius(payload.x, payload.z, payload.radius ?? 6);
    let best = null;
    let bestDistance = Infinity;
    for (const handle of found) {
      if (!w.ecs.has(handle, 'Flora')) continue;
      const p = w.ecs.get(handle, 'Position');
      const distance = Math.hypot(p.x - payload.x, p.z - payload.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = handle;
      }
    }
    if (best === null) return;
    const region = w.ecs.get(best, 'Region');
    const position = w.ecs.get(best, 'Position');
    const flora = w.ecs.get(best, 'Flora');
    memory.record(region.cx, region.cy, { tick: w.tick, op: 'harvest', slot: region.slot, intensity: 1 });
    w.despawn(best, { reason: 'harvested', operation: 'flora.harvest' });
    w.emit({
      operation: 'memory.write',
      class: EventClass.CONSEQUENCE,
      target: `region:${region.cx},${region.cy}`,
      payload: { what: 'harvest', species: SPECIES[flora.species].name, x: round(position.x), y: round(position.z) },
    });
  });

  /** Plant a light. Unlike a footprint, a beacon does not fade. */
  world.onCommand('world.beacon', (w, payload) => {
    const memory = w.store('regions');
    const { cx, cy } = memory.coordOf(payload.x, payload.z);
    if (memory.stateOf(cx, cy) === RegionState.LATENT) memory.observe(cx, cy, w.tick);
    const y = heightAt(payload.x, payload.z, w.seed);
    memory.record(cx, cy, {
      tick: w.tick,
      op: 'beacon',
      x: round(payload.x, 2),
      z: round(payload.z, 2),
      y: round(y, 2),
      hue: payload.hue ?? 0.55,
      intensity: 1,
    });
    w.emit({
      operation: 'memory.write',
      class: EventClass.CONSEQUENCE,
      target: `region:${cx},${cy}`,
      payload: { what: 'beacon', x: round(payload.x), y: round(payload.z) },
    });
  });
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function pandoraOptions(overrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  return {
    universe: config.universe,
    seed: config.seed,
    tickHz: TICK_HZ,
    cellSize: 32,
    label: config.label,
    config,
    install,
  };
}

/**
 * Find a spot worth waking up on.
 *
 * Dry land, a gentle slope, a little local relief — and, above all, a view of
 * the mountain. Somewhere far enough out that the whole massif fits in the sky,
 * because the first thing you should see is the thing that tells you how big
 * this place is.
 */
export function findLanding(seed, config = DEFAULT_CONFIG) {
  const rng = new Rng(seedFrom(seed, 'landing'));
  const summit = mountainCenter(seed);
  let best = { x: 0, z: 0, score: -Infinity };

  for (let i = 0; i < 2400; i++) {
    // Sample on a ring around the mountain rather than uniformly on the map.
    const angle = rng.range(0, Math.PI * 2);
    const radius = rng.range(MOUNTAIN_RADIUS * 1.3, MOUNTAIN_RADIUS * 1.65);
    const x = summit.x + Math.cos(angle) * radius;
    const z = summit.z + Math.sin(angle) * radius;
    const y = heightAt(x, z, seed);
    if (y < 4 || y > 90) continue;
    const normal = normalAt(x, z, seed);
    if (normal.y < 0.86) continue;

    // A little prominence, so the foreground reads and the horizon is not a wall.
    let relief = 0;
    for (let a = 0; a < 6; a++) {
      const ring = (a / 6) * Math.PI * 2;
      relief += y - heightAt(x + Math.cos(ring) * 90, z + Math.sin(ring) * 90, seed);
    }

    // Nothing between here and the summit may subtend a larger angle than the
    // summit does — otherwise the mountain is behind a hill and you spawn
    // looking at a bump.
    const toSummit = Math.hypot(summit.x - x, summit.z - z);
    const summitAngle = (heightAt(summit.x, summit.z, seed) - y) / toSummit;
    let clear = 1;
    for (let s = 0.06; s < 0.92; s += 0.05) {
      const sample = heightAt(x + (summit.x - x) * s, z + (summit.z - z) * s, seed);
      if ((sample - y) / (toSummit * s) > summitAngle * 0.72) {
        clear = 0;
        break;
      }
    }

    const score = relief / 6 + normal.y * 14 - Math.abs(y - 26) * 0.35 + clear * 120 - toSummit * 0.004;
    if (score > best.score) best = { x, z, score, y };
  }

  if (best.score === -Infinity) return { x: 0, z: 0, y: Math.max(heightAt(0, 0, seed), SEA_LEVEL) };
  return best;
}

export const DEFAULT_APPEARANCE = {
  height: 1,
  build: 0.42,
  skinHue: 0.58,
  glowHue: 0.52,
  glowDensity: 0.6,
  marking: 1,
  queue: 0.6,
};

export function createPandora(overrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const world = new World(pandoraOptions(config));

  const landing = findLanding(config.seed, config);
  const eye = EYE_HEIGHT * (overrides.appearance?.height ?? DEFAULT_APPEARANCE.height);
  // Wake up facing the mountain.
  const summit = mountainCenter(config.seed);
  const yaw = Math.atan2(summit.x - landing.x, summit.z - landing.z);
  world.avatar = world.spawn(
    {
      Position: { x: landing.x, y: heightAt(landing.x, landing.z, config.seed) + eye, z: landing.z },
      Velocity: { x: 0, y: 0, z: 0 },
      Avatar: { yaw, pitch: 0.02, grounded: 1, swimming: 0, stamina: 1, stride: 0, distance: 0 },
      Appearance: { ...DEFAULT_APPEARANCE, ...(overrides.appearance ?? {}) },
      Intent: { forward: 0, strafe: 0, jump: 0, sprint: 0, interact: 0 },
      Renderable: { kind: Kind.AVATAR, hue: 0.58, size: 2.6 },
    },
    { kind: 'avatar', operation: 'avatar.wake' },
  );

  world.step(); // one tick so the first regions are witnessed before anyone looks
  return world;
}

/**
 * The avatar is an entity, not a singleton — but there is exactly one per
 * world, and residency, trails, and flora response all need to find it every
 * tick. The handle is cached on the world and revalidated, so a fork or a
 * checkpoint restore rediscovers it without special-casing.
 */
export function avatarHandle(world) {
  if (world.avatar !== undefined && world.ecs.alive(world.avatar)) return world.avatar;
  for (const chunk of world.ecs.query(['Avatar'])) {
    if (chunk.count > 0) {
      world.avatar = chunk.entity(0);
      return world.avatar;
    }
  }
  return null;
}

export function avatarState(world) {
  const handle = avatarHandle(world);
  if (handle === null) return null;
  const position = world.ecs.get(handle, 'Position');
  const velocity = world.ecs.get(handle, 'Velocity');
  const avatar = world.ecs.get(handle, 'Avatar');
  const appearance = world.ecs.get(handle, 'Appearance');
  const memory = world.store('regions');
  const region = memory.coordOf(position.x, position.z);
  return {
    handle,
    position,
    velocity,
    ...avatar,
    appearance,
    speed: Math.hypot(velocity.x, velocity.z),
    ground: heightAt(position.x, position.z, world.seed),
    biome: biomeAt(position.x, position.z, world.seed),
    region,
    regionState: memory.stateOf(region.cx, region.cy),
  };
}

export const BIOME_NAMES = ['shallows', 'beach', 'meadow', 'canopy', 'highland', 'spire'];

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
