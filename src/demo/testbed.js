// The Grove — a reference world that exercises every layer of the engine.
//
// Beacons radiate heat into a continuous field. Motes fall through the
// gravitational influence of those beacons. Foragers are agents whose behavior
// runs inside the capability sandbox: they read the heat gradient, steer toward
// warmth, metabolize it, reproduce, and starve. Ownership and lineage accrue in
// the semantic graph; every birth, death, and utterance lands in the event log.
//
// It is small enough to read in one sitting and complete enough that a
// checkpoint, a replay, and a counterfactual branch all mean something.

import { Backend, Domain, Mode } from '../core/scheduler.js';
import { Capabilities } from '../core/laws.js';
import { EventClass } from '../core/events.js';
import { ScalarField } from '../core/fields.js';
import { World } from '../core/world.js';
import { handleIndex } from '../core/ids.js';

export const WORLD_SIZE = 512;
export const TICK_HZ = 30;
export const MAX_AGENTS = 700;

export const Kind = { MOTE: 0, FORAGER: 1, BEACON: 2 };

export const DEFAULT_CONFIG = {
  seed: 20260731,
  universe: 'u0',
  label: 'root',
  motes: 800,
  foragers: 180,
  beacons: 6,
  rogueRatio: 0.06,
};

// ---------------------------------------------------------------------------
// Schema, fields, laws, systems. Everything a fork must reinstall — and nothing
// that belongs to a particular population of entities.
// ---------------------------------------------------------------------------

export function install(world) {
  world.defineComponent('Position', { x: 'f64', y: 'f64' }, { doc: 'World-space location' });
  world.defineComponent('Velocity', { x: 'f64', y: 'f64' });
  world.defineComponent('Force', { x: 'f64', y: 'f64' });
  world.defineComponent('Mass', { value: 'f64' });
  world.defineComponent('Steer', { x: 'f64', y: 'f64' });
  world.defineComponent('Health', { hp: 'f64' });
  world.defineComponent('Emitter', { rate: 'f64' });
  world.defineComponent('Attractor', { strength: 'f64' });
  world.defineComponent('Renderable', { kind: 'u8', hue: 'f32', size: 'f32' });
  world.defineComponent('Agent', {
    energy: 'f64',
    age: 'u32',
    generation: 'u16',
    disposition: 'u8', // 0 forager, 1 rogue — rogues overstep their grant
  });

  world.addField(
    new ScalarField({
      name: 'heat',
      width: 64,
      height: 64,
      cellSize: WORLD_SIZE / 64,
      // Diffusion is deliberately fast: the halo a beacon casts is the only
      // long-range signal an agent has, and a gradient it cannot sense is a
      // gradient it cannot follow.
      diffusion: 8,
      decay: 0.11,
      ambient: 0.015,
    }),
  );

  installLaws(world);
  installSystems(world);
  installCommands(world);
}

// ---------------------------------------------------------------------------
// Laws: sandboxed behavior with explicit, revocable grants.
// ---------------------------------------------------------------------------

function installLaws(world) {
  const heat = () => world.field('heat');

  world.laws
    .provide('self.transform', (subject) => ({
      x: subject.x,
      y: subject.y,
      vx: subject.vx,
      vy: subject.vy,
    }))
    .provide('self.state', (subject) => ({
      energy: subject.energy,
      age: subject.age,
      generation: subject.generation,
    }))
    .provide('local.weather', (subject) => ({ heat: heat().sample(subject.x, subject.y) }))
    .provide('local.gradient', (subject) => heat().gradient(subject.x, subject.y, { x: 0, y: 0 }))
    .provide('nearby.transforms', (subject, ctx) => {
      const found = ctx.world.spatial.queryRadius(subject.x, subject.y, 26);
      const out = [];
      for (const handle of found) {
        if (handle === subject.handle) continue;
        const p = ctx.world.spatial.positions.get(handle);
        out.push({ x: p.x, y: p.y });
        if (out.length >= 6) break;
      }
      return out;
    });

  const capabilities = new Capabilities({
    read: ['self.transform', 'self.state', 'local.weather', 'local.gradient', 'nearby.transforms'],
    write: ['self.intent'],
    emit: ['speech', 'movement_request'],
    deny: ['filesystem', 'raw_network', 'arbitrary_database'],
    budget: { ops: 24, events: 2, memory_mb: 8, cpu_ms: 1 },
  });

  world.addLaw({
    name: 'forage',
    version: 2,
    capabilities,
    run(view) {
      const self = view.read('self.transform');
      const state = view.read('self.state');
      const gradient = view.read('local.gradient');
      const weather = view.read('local.weather');

      // Climb the heat gradient; the hungrier the agent, the harder it climbs.
      const hunger = clamp(1 - state.energy / 8, 0.15, 1);
      let sx = gradient.x * 160 * hunger;
      let sy = gradient.y * 160 * hunger;

      // Separate from neighbours so a warm cell does not collapse into a point.
      for (const other of view.read('nearby.transforms')) {
        const dx = self.x - other.x;
        const dy = self.y - other.y;
        const d2 = dx * dx + dy * dy + 1;
        sx += (dx / d2) * 26;
        sy += (dy / d2) * 26;
      }

      // Sated agents wander, which is what keeps the grove from starving later.
      if (state.energy > 6) {
        sx += (view.rng.next() - 0.5) * 1.6;
        sy += (view.rng.next() - 0.5) * 1.6;
      }

      view.write('self.intent', normalize(sx, sy));

      if (weather.heat > 0.8 && state.energy > 7 && view.rng.next() < 0.02) {
        view.emit('speech', { text: 'warmth here', heat: round(weather.heat) });
      }
    },
  });

  // The same behavior, but it reaches for authority it was never granted.
  // The host denies the read, the agent loses its turn, and the tick continues.
  world.addLaw({
    name: 'forage.rogue',
    version: 1,
    capabilities,
    run(view) {
      const self = view.read('self.transform');
      const gradient = view.read('local.gradient');
      view.write('self.intent', normalize(gradient.x * 120 + self.vx * 0.1, gradient.y * 120 + self.vy * 0.1));
      // Not in the grant. Everything after this line never runs.
      const roster = view.read('arbitrary_database');
      view.write('self.intent', normalize(roster.x, roster.y));
    },
  });
}

// ---------------------------------------------------------------------------
// Systems. Read/write declarations are the only scheduling input.
// ---------------------------------------------------------------------------

function installSystems(world) {
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
        const py = chunk.col('Position', 'y');
        for (let i = 0; i < chunk.count; i++) w.spatial.insert(chunk.entity(i), px[i], py[i]);
      }
    },
  });

  world.addSystem({
    name: 'ThermalField',
    reads: ['Position', 'Emitter'],
    writes: ['field.heat'],
    domain: Domain.FIELD,
    backend: Backend.CPU_SIMD | Backend.GPU_COMPUTE,
    run(w) {
      const heat = w.field('heat');
      for (const chunk of w.ecs.query(['Position', 'Emitter'])) {
        const px = chunk.col('Position', 'x');
        const py = chunk.col('Position', 'y');
        const rate = chunk.col('Emitter', 'rate');
        for (let i = 0; i < chunk.count; i++) heat.deposit(px[i], py[i], rate[i] * w.dt);
      }
      heat.step(w.dt);
    },
  });

  world.addSystem({
    name: 'Gravity',
    reads: ['Position', 'Mass', 'Attractor'],
    writes: ['Force'],
    domain: Domain.SPATIAL,
    backend: Backend.CPU_SIMD | Backend.GPU_COMPUTE,
    mode: Mode.DETERMINISTIC,
    run(w) {
      const wells = attractors(w);
      for (const chunk of w.ecs.query(['Position', 'Mass', 'Force'])) {
        const px = chunk.col('Position', 'x');
        const py = chunk.col('Position', 'y');
        const m = chunk.col('Mass', 'value');
        const fx = chunk.col('Force', 'x');
        const fy = chunk.col('Force', 'y');
        for (let i = 0; i < chunk.count; i++) {
          let ax = 0;
          let ay = 0;
          for (const well of wells) {
            const dx = well.x - px[i];
            const dy = well.y - py[i];
            const d2 = dx * dx + dy * dy + 64;
            const f = (well.strength * 900) / d2;
            const d = Math.sqrt(d2);
            ax += (dx / d) * f;
            ay += (dy / d) * f;
          }
          fx[i] = ax * m[i];
          fy[i] = ay * m[i];
        }
      }
    },
  });

  world.addSystem({
    name: 'AgentIntent',
    reads: ['Position', 'Velocity', 'Agent', 'field.heat', 'spatial'],
    writes: ['Steer', 'law.stats'],
    domain: Domain.AGENT,
    rateHz: 10,
    backend: Backend.CPU_SCALAR,
    run(w) {
      const subject = { handle: 0, x: 0, y: 0, vx: 0, vy: 0, energy: 0, age: 0, generation: 0 };
      const ctx = { world: w, tick: w.tick, rng: null };
      for (const chunk of w.ecs.query(['Position', 'Velocity', 'Agent', 'Steer'])) {
        const px = chunk.col('Position', 'x');
        const py = chunk.col('Position', 'y');
        const vx = chunk.col('Velocity', 'x');
        const vy = chunk.col('Velocity', 'y');
        const energy = chunk.col('Agent', 'energy');
        const age = chunk.col('Agent', 'age');
        const generation = chunk.col('Agent', 'generation');
        const disposition = chunk.col('Agent', 'disposition');
        const sx = chunk.col('Steer', 'x');
        const sy = chunk.col('Steer', 'y');
        for (let i = 0; i < chunk.count; i++) {
          const handle = chunk.entity(i);
          subject.handle = handle;
          subject.x = px[i];
          subject.y = py[i];
          subject.vx = vx[i];
          subject.vy = vy[i];
          subject.energy = energy[i];
          subject.age = age[i];
          subject.generation = generation[i];
          ctx.tick = w.tick;
          ctx.rng = w.rng.fork(`${handleIndex(handle)}:${w.tick}`);

          const law = disposition[i] === 1 ? 'forage.rogue' : 'forage';
          const result = w.laws.invoke(law, subject, ctx);
          const intent = result.intents['self.intent'];
          if (intent) {
            sx[i] = intent.x;
            sy[i] = intent.y;
          } else {
            // A denied or over-budget agent simply does not act this turn.
            sx[i] = 0;
            sy[i] = 0;
          }
          for (const emission of result.emissions) {
            if (emission.kind !== 'speech') continue;
            w.emit({
              operation: 'agent.speech',
              class: EventClass.NARRATIVE,
              actor: w.key(handle),
              payload: { ...emission.payload, x: round(px[i]), y: round(py[i]) },
            });
          }
        }
      }
    },
  });

  world.addSystem({
    name: 'Steering',
    reads: ['Steer', 'Agent'],
    writes: ['Force'],
    domain: Domain.AGENT,
    backend: Backend.CPU_SIMD,
    run(w) {
      for (const chunk of w.ecs.query(['Steer', 'Force', 'Mass', 'Agent'])) {
        const sx = chunk.col('Steer', 'x');
        const sy = chunk.col('Steer', 'y');
        const fx = chunk.col('Force', 'x');
        const fy = chunk.col('Force', 'y');
        const m = chunk.col('Mass', 'value');
        for (let i = 0; i < chunk.count; i++) {
          fx[i] += sx[i] * 240 * m[i];
          fy[i] += sy[i] * 240 * m[i];
        }
      }
    },
  });

  world.addSystem({
    name: 'Integrate',
    reads: ['Force', 'Mass'],
    writes: ['Position', 'Velocity', 'Force'],
    domain: Domain.SPATIAL,
    backend: Backend.CPU_SIMD | Backend.GPU_COMPUTE,
    run(w) {
      const dt = w.dt;
      for (const chunk of w.ecs.query(['Position', 'Velocity', 'Force', 'Mass'])) {
        const px = chunk.col('Position', 'x');
        const py = chunk.col('Position', 'y');
        const vx = chunk.col('Velocity', 'x');
        const vy = chunk.col('Velocity', 'y');
        const fx = chunk.col('Force', 'x');
        const fy = chunk.col('Force', 'y');
        const m = chunk.col('Mass', 'value');
        for (let i = 0; i < chunk.count; i++) {
          vx[i] = (vx[i] + (fx[i] / m[i]) * dt) * 0.985;
          vy[i] = (vy[i] + (fy[i] / m[i]) * dt) * 0.985;
          const speed = Math.hypot(vx[i], vy[i]);
          if (speed > 90) {
            vx[i] = (vx[i] / speed) * 90;
            vy[i] = (vy[i] / speed) * 90;
          }
          px[i] += vx[i] * dt;
          py[i] += vy[i] * dt;
          if (px[i] < 2) {
            px[i] = 2;
            vx[i] = Math.abs(vx[i]) * 0.6;
          } else if (px[i] > WORLD_SIZE - 2) {
            px[i] = WORLD_SIZE - 2;
            vx[i] = -Math.abs(vx[i]) * 0.6;
          }
          if (py[i] < 2) {
            py[i] = 2;
            vy[i] = Math.abs(vy[i]) * 0.6;
          } else if (py[i] > WORLD_SIZE - 2) {
            py[i] = WORLD_SIZE - 2;
            vy[i] = -Math.abs(vy[i]) * 0.6;
          }
          fx[i] = 0;
          fy[i] = 0;
        }
      }
    },
  });

  world.addSystem({
    name: 'Metabolism',
    reads: ['Position', 'field.heat'],
    writes: ['Agent', 'Health', 'field.heat'],
    domain: Domain.AGENT,
    rateHz: 6,
    backend: Backend.CPU_SIMD,
    run(w, system) {
      const dt = w.scheduler.interval(system) / w.tickHz;
      const heat = w.field('heat');
      for (const chunk of w.ecs.query(['Position', 'Agent', 'Health'])) {
        const px = chunk.col('Position', 'x');
        const py = chunk.col('Position', 'y');
        const energy = chunk.col('Agent', 'energy');
        const age = chunk.col('Agent', 'age');
        const hp = chunk.col('Health', 'hp');
        for (let i = 0; i < chunk.count; i++) {
          const local = heat.sample(px[i], py[i]);
          const eaten = Math.min(local, 0.9) * 0.55 * dt;
          heat.deposit(px[i], py[i], -eaten * 2.4);
          energy[i] = Math.min(10, energy[i] + eaten * 5.2 - 0.78 * dt);
          age[i] += 1;
          if (energy[i] < 0) {
            energy[i] = 0;
            hp[i] -= 26 * dt;
          } else {
            hp[i] = Math.min(100, hp[i] + 9 * dt);
          }
        }
      }
    },
  });

  world.addSystem({
    name: 'Consequences',
    reads: ['Agent', 'Health', 'Position'],
    writes: ['lifecycle', 'graph'],
    domain: Domain.GLOBAL,
    rateHz: 6,
    backend: Backend.CPU_SCALAR,
    run(w) {
      const deaths = [];
      const births = [];
      let population = 0;
      for (const chunk of w.ecs.query(['Agent', 'Health', 'Position'])) {
        const hp = chunk.col('Health', 'hp');
        const energy = chunk.col('Agent', 'energy');
        const age = chunk.col('Agent', 'age');
        const generation = chunk.col('Agent', 'generation');
        const disposition = chunk.col('Agent', 'disposition');
        const px = chunk.col('Position', 'x');
        const py = chunk.col('Position', 'y');
        for (let i = 0; i < chunk.count; i++) {
          population++;
          if (hp[i] <= 0) {
            deaths.push({ handle: chunk.entity(i), x: px[i], y: py[i], age: age[i] });
          } else if (energy[i] > 8.5 && age[i] > 40) {
            births.push({
              parent: chunk.entity(i),
              x: px[i],
              y: py[i],
              generation: generation[i] + 1,
              disposition: disposition[i],
              row: i,
              chunk,
            });
          }
        }
      }

      for (const death of deaths) {
        const key = w.key(death.handle);
        w.despawn(death.handle, { reason: 'starvation', operation: 'agent.perish' });
        w.graph.remove(key, 'OCCUPIES', undefined);
      }

      for (const birth of births) {
        if (w.ecs.entityCount >= MAX_AGENTS + 900) break;
        const jitter = w.rng.fork(`birth:${handleIndex(birth.parent)}:${w.tick}`);
        const parentKey = w.key(birth.parent);
        const child = spawnForager(w, {
          x: clamp(birth.x + jitter.range(-6, 6), 4, WORLD_SIZE - 4),
          y: clamp(birth.y + jitter.range(-6, 6), 4, WORLD_SIZE - 4),
          energy: 3,
          generation: birth.generation,
          // Disposition is heritable, with a small chance of drift.
          disposition: jitter.next() < 0.04 ? 1 - birth.disposition : birth.disposition,
          cause: null,
        });
        birth.chunk.col('Agent', 'energy')[birth.row] = 3.5;
        w.graph.add(parentKey, 'BEGAT', w.key(child), { tick: w.tick });
        w.emit({
          operation: 'agent.begat',
          class: EventClass.CONSEQUENCE,
          actor: parentKey,
          target: w.key(child),
          payload: { generation: birth.generation, x: round(birth.x), y: round(birth.y) },
        });
      }

      // Territory: who is currently nearest to which beacon. Ownership is a
      // relationship, not a component — it belongs in the graph.
      if (w.tick % 60 === 0) updateTerritory(w);
      w.stats.population = population;
    },
  });
}

function updateTerritory(w) {
  const wells = attractors(w);
  if (!wells.length) return;
  for (const chunk of w.ecs.query(['Agent', 'Position'])) {
    const px = chunk.col('Position', 'x');
    const py = chunk.col('Position', 'y');
    for (let i = 0; i < chunk.count; i++) {
      let best = wells[0];
      let bestD = Infinity;
      for (const well of wells) {
        const d = (well.x - px[i]) ** 2 + (well.y - py[i]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = well;
        }
      }
      const key = w.key(chunk.entity(i));
      const current = w.graph.one(key, 'OCCUPIES');
      const territory = `beacon:${handleIndex(best.handle)}`;
      if (current !== territory) w.graph.reassign(key, 'OCCUPIES', territory, { tick: w.tick });
    }
  }
}

function attractors(w) {
  const wells = [];
  for (const chunk of w.ecs.query(['Position', 'Attractor'])) {
    const px = chunk.col('Position', 'x');
    const py = chunk.col('Position', 'y');
    const strength = chunk.col('Attractor', 'strength');
    for (let i = 0; i < chunk.count; i++) {
      wells.push({ handle: chunk.entity(i), x: px[i], y: py[i], strength: strength[i] });
    }
  }
  wells.sort((a, b) => handleIndex(a.handle) - handleIndex(b.handle));
  return wells;
}

// ---------------------------------------------------------------------------
// Commands — the only way anything outside the simulation touches it.
// ---------------------------------------------------------------------------

function installCommands(world) {
  world.onCommand('world.ignite', (w, payload) => {
    const heat = w.field('heat');
    const radius = payload.radius ?? 24;
    const steps = Math.max(1, Math.round(radius / heat.cellSize));
    for (let dy = -steps; dy <= steps; dy++) {
      for (let dx = -steps; dx <= steps; dx++) {
        const d = Math.hypot(dx, dy) / (steps + 0.0001);
        if (d > 1) continue;
        heat.deposit(payload.x + dx * heat.cellSize, payload.y + dy * heat.cellSize, (payload.amount ?? 8) * (1 - d));
      }
    }
  });

  world.onCommand('world.impulse', (w, payload) => {
    const radius = payload.radius ?? 48;
    for (const handle of w.spatial.queryRadius(payload.x, payload.y, radius)) {
      if (!w.ecs.has(handle, 'Velocity')) continue;
      const p = w.ecs.get(handle, 'Position');
      const dx = p.x - payload.x;
      const dy = p.y - payload.y;
      const d = Math.hypot(dx, dy) + 0.001;
      const falloff = 1 - d / radius;
      const v = w.ecs.get(handle, 'Velocity');
      w.ecs.set(handle, 'Velocity', {
        x: v.x + (dx / d) * (payload.strength ?? 60) * falloff,
        y: v.y + (dy / d) * (payload.strength ?? 60) * falloff,
      });
    }
  });

  world.onCommand('world.seed_forager', (w, payload, event) => {
    spawnForager(w, {
      x: payload.x,
      y: payload.y,
      energy: payload.energy ?? 5,
      generation: 0,
      disposition: payload.disposition ?? 0,
      cause: event.event_id,
    });
  });

  world.onCommand('world.cull', (w, payload) => {
    const radius = payload.radius ?? 40;
    for (const handle of w.spatial.queryRadius(payload.x, payload.y, radius)) {
      if (w.ecs.has(handle, 'Agent')) w.despawn(handle, { reason: 'culled', operation: 'agent.perish' });
    }
  });

  world.onCommand('world.kindle_beacon', (w, payload, event) => {
    spawnBeacon(w, { x: payload.x, y: payload.y, rate: payload.rate ?? 26, strength: payload.strength ?? 1 }, event.event_id);
  });
}

// ---------------------------------------------------------------------------
// Population
// ---------------------------------------------------------------------------

export function spawnForager(world, { x, y, energy = 4, generation = 0, disposition = 0, cause = null }) {
  return world.spawn(
    {
      Position: { x, y },
      Velocity: { x: 0, y: 0 },
      Force: { x: 0, y: 0 },
      Steer: { x: 0, y: 0 },
      Mass: { value: 1 },
      Health: { hp: 100 },
      Agent: { energy, age: 0, generation, disposition },
      Renderable: { kind: Kind.FORAGER, hue: disposition === 1 ? 0.02 : 0.42, size: 3 },
    },
    { kind: 'forager', operation: 'agent.spawn', cause },
  );
}

export function spawnBeacon(world, { x, y, rate = 26, strength = 1 }, cause = null) {
  return world.spawn(
    {
      Position: { x, y },
      Emitter: { rate },
      Attractor: { strength },
      Renderable: { kind: Kind.BEACON, hue: 0.11, size: 7 },
    },
    { kind: 'beacon', operation: 'beacon.kindle', cause },
  );
}

export function spawnMote(world, { x, y, vx, vy, mass }) {
  return world.spawn(
    {
      Position: { x, y },
      Velocity: { x: vx, y: vy },
      Force: { x: 0, y: 0 },
      Mass: { value: mass },
      Renderable: { kind: Kind.MOTE, hue: 0.58, size: 1.5 },
    },
    { kind: 'mote', operation: 'mote.condense' },
  );
}

export function populate(world, config) {
  const rng = world.rng.fork('genesis');
  const ring = rng.fork('beacons');
  for (let i = 0; i < config.beacons; i++) {
    const angle = (i / config.beacons) * Math.PI * 2 + ring.range(-0.2, 0.2);
    const radius = ring.range(90, 190);
    spawnBeacon(world, {
      x: WORLD_SIZE / 2 + Math.cos(angle) * radius,
      y: WORLD_SIZE / 2 + Math.sin(angle) * radius,
      rate: ring.range(20, 34),
      strength: ring.range(0.7, 1.5),
    });
  }

  const motes = rng.fork('motes');
  for (let i = 0; i < config.motes; i++) {
    const angle = motes.range(0, Math.PI * 2);
    const radius = motes.range(20, 240);
    const speed = motes.range(8, 26);
    spawnMote(world, {
      x: WORLD_SIZE / 2 + Math.cos(angle) * radius,
      y: WORLD_SIZE / 2 + Math.sin(angle) * radius,
      vx: -Math.sin(angle) * speed,
      vy: Math.cos(angle) * speed,
      mass: motes.range(0.4, 1.8),
    });
  }

  const agents = rng.fork('foragers');
  for (let i = 0; i < config.foragers; i++) {
    spawnForager(world, {
      x: agents.range(20, WORLD_SIZE - 20),
      y: agents.range(20, WORLD_SIZE - 20),
      energy: agents.range(3, 7),
      disposition: agents.next() < config.rogueRatio ? 1 : 0,
    });
  }
  return world;
}

// ---------------------------------------------------------------------------

export function testbedOptions(overrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  return {
    universe: config.universe,
    seed: config.seed,
    tickHz: TICK_HZ,
    cellSize: 24,
    label: config.label,
    install,
  };
}

export function createTestbed(overrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const world = new World(testbedOptions(config));
  populate(world, config);
  world.config = config;
  return world;
}

// ---------------------------------------------------------------------------

function normalize(x, y) {
  const length = Math.hypot(x, y);
  if (length < 1e-9) return { x: 0, y: 0 };
  return { x: x / length, y: y / length };
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
