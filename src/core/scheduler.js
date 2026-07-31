// The scheduler.
//
//   SYSTEM(Gravity) {
//     .reads   = { Position, Mass },
//     .writes  = { Force },
//     .domain  = SPATIAL,
//     .rate_hz = 60,
//     .backend = CPU_SIMD | GPU_COMPUTE,
//     .mode    = DETERMINISTIC
//   };
//
// Systems declare their hazards; the scheduler derives the dependency DAG from
// those declarations, assigns each system to the earliest wave where nothing it
// conflicts with is still running, and reports which systems could run
// concurrently. Execution here is single-threaded — the point is that the
// *schedule* is a first-class artifact a profiler, a thread pool, or a GPU
// dispatcher can consume without changing a single system.

export const Domain = {
  GLOBAL: 'GLOBAL',
  SPATIAL: 'SPATIAL',
  FIELD: 'FIELD',
  GRAPH: 'GRAPH',
  AGENT: 'AGENT',
};

export const Backend = {
  CPU_SCALAR: 1,
  CPU_SIMD: 2,
  GPU_COMPUTE: 4,
  FPGA: 8,
};

export const Mode = {
  DETERMINISTIC: 'DETERMINISTIC',
  RELAXED: 'RELAXED',
};

export class System {
  constructor(desc) {
    if (!desc.name) throw new Error('a system must be named');
    if (typeof desc.run !== 'function') throw new Error(`system ${desc.name} has no run()`);
    this.name = desc.name;
    this.reads = desc.reads ?? [];
    this.writes = desc.writes ?? [];
    this.domain = desc.domain ?? Domain.GLOBAL;
    this.rateHz = desc.rateHz ?? null; // null = every tick
    this.backend = desc.backend ?? Backend.CPU_SCALAR;
    this.mode = desc.mode ?? Mode.DETERMINISTIC;
    this.run = desc.run;
    this.enabled = desc.enabled ?? true;
    // Runtime profile, filled in by the scheduler.
    this.stats = { calls: 0, totalMs: 0, lastMs: 0, entities: 0 };
  }

  get backendNames() {
    return Object.entries(Backend)
      .filter(([, bit]) => (this.backend & bit) !== 0)
      .map(([name]) => name);
  }
}

export class Scheduler {
  constructor(tickHz = 60) {
    this.tickHz = tickHz;
    this.systems = [];
    this._compiled = null;
  }

  add(desc) {
    const system = desc instanceof System ? desc : new System(desc);
    this.systems.push(system);
    this._compiled = null;
    return system;
  }

  get(name) {
    return this.systems.find((s) => s.name === name) ?? null;
  }

  /**
   * Build the hazard DAG and group systems into waves.
   *
   * A later-declared system depends on an earlier one when they conflict:
   * write-after-read, read-after-write, or write-after-write on the same
   * resource. Declaration order breaks ties, which keeps the schedule — and
   * therefore the simulation — deterministic.
   */
  compile() {
    if (this._compiled) return this._compiled;
    const active = this.systems.filter((s) => s.enabled);
    const edges = new Map(active.map((s) => [s.name, []]));
    const level = new Map(active.map((s) => [s.name, 0]));

    for (let i = 0; i < active.length; i++) {
      for (let j = 0; j < i; j++) {
        const later = active[i];
        const earlier = active[j];
        const conflict =
          intersects(earlier.writes, later.reads) ||
          intersects(earlier.writes, later.writes) ||
          intersects(earlier.reads, later.writes);
        if (!conflict) continue;
        edges.get(later.name).push({
          from: earlier.name,
          on: [
            ...intersection(earlier.writes, later.reads),
            ...intersection(earlier.writes, later.writes),
            ...intersection(earlier.reads, later.writes),
          ].filter(unique),
        });
        level.set(later.name, Math.max(level.get(later.name), level.get(earlier.name) + 1));
      }
    }

    const waves = [];
    for (const system of active) {
      const l = level.get(system.name);
      (waves[l] ??= []).push(system);
    }

    this._compiled = {
      waves: waves.map((w) => w ?? []),
      edges,
      level,
      criticalPath: waves.length,
      concurrency: waves.reduce((max, w) => Math.max(max, w.length), 0),
    };
    return this._compiled;
  }

  /** Ticks between runs for a rate-limited system. */
  interval(system) {
    if (!system.rateHz) return 1;
    return Math.max(1, Math.round(this.tickHz / system.rateHz));
  }

  shouldRun(system, tick) {
    return tick % this.interval(system) === 0;
  }

  /** Execute one tick. Waves run in order; systems inside a wave are independent. */
  run(ctx, tick) {
    const plan = this.compile();
    const trace = [];
    for (let w = 0; w < plan.waves.length; w++) {
      for (const system of plan.waves[w]) {
        if (!this.shouldRun(system, tick)) continue;
        const started = now();
        system.run(ctx, system);
        const ms = now() - started;
        system.stats.calls++;
        system.stats.lastMs = ms;
        system.stats.totalMs += ms;
        trace.push({ wave: w, system: system.name, ms });
      }
    }
    return trace;
  }

  /** Human- and tool-readable schedule, used by the profiler and the demo UI. */
  describe() {
    const plan = this.compile();
    return {
      tickHz: this.tickHz,
      waves: plan.waves.map((wave, i) => ({
        index: i,
        systems: wave.map((s) => ({
          name: s.name,
          reads: s.reads,
          writes: s.writes,
          domain: s.domain,
          rateHz: s.rateHz ?? this.tickHz,
          backends: s.backendNames,
          mode: s.mode,
          dependsOn: plan.edges.get(s.name),
          stats: { ...s.stats, avgMs: s.stats.calls ? s.stats.totalMs / s.stats.calls : 0 },
        })),
      })),
      criticalPath: plan.criticalPath,
      maxConcurrency: plan.concurrency,
    };
  }
}

function intersects(a, b) {
  return a.some((x) => b.includes(x));
}

function intersection(a, b) {
  return a.filter((x) => b.includes(x));
}

function unique(value, index, array) {
  return array.indexOf(value) === index;
}

const now =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Number(process.hrtime.bigint() / 1000n) / 1000;
