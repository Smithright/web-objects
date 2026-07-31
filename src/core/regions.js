// Procedural memory — regions that are remembered because they were witnessed.
//
// A region has three states:
//
//   LATENT      Nobody has been here. It occupies zero bytes. It is not
//               "empty" — it is a pure function of the world seed, the
//               generator version, and its coordinate, and it will resolve to
//               the same terrain, the same flora, and the same creatures the
//               first time anyone looks.
//
//   RESIDENT    Someone is here. Entities exist, systems run, and everything
//               consequential that happens is appended to this region's log.
//
//   REMEMBERED  They left. The entities are gone and the state is gone, but
//               the log is not. Coming back regenerates default reality from
//               the causes and replays the divergence over it.
//
// This is the whole "store causes, regenerate consequences" argument made
// operational: the cost of a world is not its size, it is its history — and
// history is only written where someone was looking.

import { Digest } from './hash.js';

export const RegionState = {
  LATENT: 'latent',
  RESIDENT: 'resident',
  REMEMBERED: 'remembered',
};

export const DEFAULT_REGION_SIZE = 160;

/** How long a mark stays legible. Memory fades; the record does not. */
export const TRAIL_HALF_LIFE = 2400; // ticks

export class RegionMemory {
  constructor({ seed, size = DEFAULT_REGION_SIZE, generatorVersion = 1, capacity = 512 } = {}) {
    this.seed = seed;
    this.size = size;
    this.generatorVersion = generatorVersion;
    this.capacity = capacity; // remembered regions retained before the oldest is forgotten
    this.regions = new Map();
    this.stats = { observed: 0, released: 0, forgotten: 0, mutations: 0 };
  }

  static key(cx, cy) {
    return `${cx},${cy}`;
  }

  coordOf(x, z) {
    return { cx: Math.floor(x / this.size), cy: Math.floor(z / this.size) };
  }

  centerOf(cx, cy) {
    return { x: (cx + 0.5) * this.size, z: (cy + 0.5) * this.size };
  }

  get(cx, cy) {
    return this.regions.get(RegionMemory.key(cx, cy)) ?? null;
  }

  stateOf(cx, cy) {
    return this.get(cx, cy)?.state ?? RegionState.LATENT;
  }

  /**
   * Witness a region. This is the moment a piece of the world stops being a
   * formula and starts being a place with a past.
   */
  observe(cx, cy, tick) {
    const key = RegionMemory.key(cx, cy);
    let region = this.regions.get(key);
    if (!region) {
      region = {
        cx,
        cy,
        state: RegionState.RESIDENT,
        firstObserved: tick,
        lastObserved: tick,
        observations: 0,
        mutations: [],
        summary: { trail: 0, blooms: 0, harvests: 0 },
      };
      this.regions.set(key, region);
    }
    const returning = region.state === RegionState.REMEMBERED;
    region.state = RegionState.RESIDENT;
    region.lastObserved = tick;
    region.observations++;
    this.stats.observed++;
    return { region, returning };
  }

  /** Stop simulating a region. Its log survives; its entities do not. */
  release(cx, cy, tick) {
    const region = this.get(cx, cy);
    if (!region || region.state !== RegionState.RESIDENT) return null;
    region.state = RegionState.REMEMBERED;
    region.lastObserved = tick;
    this.stats.released++;
    this._evict();
    return region;
  }

  /**
   * Append divergence. Only what actually happened is stored — the terrain,
   * the flora positions, and the creature routes all remain formulas.
   */
  record(cx, cy, mutation) {
    const region = this.get(cx, cy);
    if (!region) return null;
    const entry = { tick: mutation.tick ?? 0, op: mutation.op, ...mutation };
    region.mutations.push(entry);
    this.stats.mutations++;
    if (entry.op === 'trail') region.summary.trail++;
    else if (entry.op === 'bloom') region.summary.blooms++;
    else if (entry.op === 'harvest') region.summary.harvests++;
    // A region's log is bounded; the oldest marks decay out of legibility
    // long before this matters, and the summary keeps the count honest.
    if (region.mutations.length > 4096) region.mutations.splice(0, region.mutations.length - 4096);
    return entry;
  }

  /**
   * Everything remembered about a region, with age applied.
   *
   * `intensity` is a deterministic function of elapsed ticks, so two observers
   * asking at the same tick see the same fading — memory is part of the world
   * state, not a per-client animation.
   */
  resolve(cx, cy, tick, filter = null) {
    const region = this.get(cx, cy);
    if (!region) return [];
    const out = [];
    for (const mutation of region.mutations) {
      if (filter && mutation.op !== filter) continue;
      const age = Math.max(0, tick - mutation.tick);
      const intensity = (mutation.intensity ?? 1) * Math.pow(0.5, age / TRAIL_HALF_LIFE);
      if (intensity < 0.02) continue;
      out.push({ ...mutation, age, intensity });
    }
    return out;
  }

  residents() {
    return [...this.regions.values()].filter((r) => r.state === RegionState.RESIDENT);
  }

  remembered() {
    return [...this.regions.values()].filter((r) => r.state === RegionState.REMEMBERED);
  }

  /** Regions ordered for display: nearest first, resident before remembered. */
  atlas(originX, originZ, limit = 64) {
    const list = [...this.regions.values()].map((region) => {
      const center = this.centerOf(region.cx, region.cy);
      return { ...region, distance: Math.hypot(center.x - originX, center.z - originZ) };
    });
    list.sort((a, b) => a.distance - b.distance);
    return list.slice(0, limit);
  }

  /** Finite memory, honestly: the least recently witnessed region is forgotten. */
  _evict() {
    const remembered = this.remembered();
    if (remembered.length <= this.capacity) return;
    remembered.sort((a, b) => a.lastObserved - b.lastObserved);
    for (const region of remembered.slice(0, remembered.length - this.capacity)) {
      this.regions.delete(RegionMemory.key(region.cx, region.cy));
      this.stats.forgotten++;
    }
  }

  totals() {
    let mutations = 0;
    let trail = 0;
    for (const region of this.regions.values()) {
      mutations += region.mutations.length;
      trail += region.summary.trail;
    }
    return {
      known: this.regions.size,
      resident: this.residents().length,
      remembered: this.remembered().length,
      mutations,
      trail,
      forgotten: this.stats.forgotten,
      // What it would cost to store these regions as state instead of history.
      bytesRemembered: mutations * 24,
      bytesIfMaterialized: this.regions.size * this.size * this.size * 4,
    };
  }

  toJSON() {
    return {
      seed: this.seed,
      size: this.size,
      generatorVersion: this.generatorVersion,
      capacity: this.capacity,
      stats: { ...this.stats },
      regions: [...this.regions.values()].map((region) => ({
        ...region,
        summary: { ...region.summary },
        mutations: region.mutations.map((m) => ({ ...m })),
      })),
    };
  }

  /** Overwrite this store from a checkpoint. */
  load(json) {
    this.seed = json.seed;
    this.size = json.size;
    this.generatorVersion = json.generatorVersion;
    this.capacity = json.capacity;
    this.stats = { ...json.stats };
    this.regions = new Map();
    for (const region of json.regions) {
      this.regions.set(RegionMemory.key(region.cx, region.cy), {
        ...region,
        summary: { ...region.summary },
        mutations: region.mutations.map((m) => ({ ...m })),
      });
    }
    return this;
  }

  static fromJSON(json) {
    return new RegionMemory(json).load(json);
  }

  digest() {
    const d = new Digest().int(this.seed).int(this.size).int(this.generatorVersion);
    const keys = [...this.regions.keys()].sort();
    for (const key of keys) {
      const region = this.regions.get(key);
      d.str(key).str(region.state).int(region.firstObserved).int(region.mutations.length);
      for (const mutation of region.mutations) {
        d.int(mutation.tick).str(mutation.op).num(mutation.x ?? 0).num(mutation.z ?? 0).num(mutation.intensity ?? 1);
      }
    }
    return d.value;
  }
}
