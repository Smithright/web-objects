// Archetype entity-component storage.
//
//   Position:    [P0][P1][P2][P3]...
//   Velocity:    [V0][V1][V2][V3]...
//   Temperature: [T0][T1][T2][T3]...
//
// Every component field is its own typed array. Entities sharing the same set
// of components live in the same archetype table, so a system that reads
// {Position, Mass} walks contiguous memory instead of chasing objects. The
// object-shaped accessors (`get`, `set`) exist for tools and authoring; hot
// systems use `query`, which hands out the raw columns.

import { Digest, commutativeMix } from './hash.js';
import { MAX_ENTITIES, handleGeneration, handleIndex, makeHandle } from './ids.js';

const ARRAY_TYPES = {
  f64: Float64Array,
  f32: Float32Array,
  i32: Int32Array,
  u32: Uint32Array,
  u16: Uint16Array,
  u8: Uint8Array,
};

export class ComponentType {
  constructor(id, name, fields, options = {}) {
    this.id = id;
    this.name = name;
    this.fields = Object.entries(fields).map(([fname, type]) => {
      if (!ARRAY_TYPES[type]) throw new Error(`unknown field type "${type}" on ${name}.${fname}`);
      return { name: fname, type };
    });
    this.isTag = this.fields.length === 0;
    this.schemaVersion = options.schemaVersion ?? 1;
    this.doc = options.doc ?? '';
    /** Bytes per entity — what the profiler reports as component density. */
    this.stride = this.fields.reduce((n, f) => n + ARRAY_TYPES[f.type].BYTES_PER_ELEMENT, 0);
  }
}

/**
 * The schema registry is a Phase 0 contract: component names, field types, and
 * versions are agreed before anything simulates, so storage, replication, and
 * persistence all describe the same facts.
 */
export class Registry {
  constructor() {
    this.types = [];
    this.byName = new Map();
  }

  define(name, fields = {}, options = {}) {
    if (this.byName.has(name)) return this.byName.get(name);
    const type = new ComponentType(this.types.length, name, fields, options);
    this.types.push(type);
    this.byName.set(name, type);
    return type;
  }

  get(name) {
    const t = this.byName.get(name);
    if (!t) throw new Error(`unknown component "${name}" — declare it in the registry first`);
    return t;
  }

  has(name) {
    return this.byName.has(name);
  }

  /** Stable identity of the whole schema, part of every checkpoint header. */
  get digest() {
    const d = new Digest();
    for (const t of this.types) {
      d.str(t.name).int(t.schemaVersion);
      for (const f of t.fields) d.str(f.name).str(f.type);
    }
    return d.hex;
  }
}

class Archetype {
  constructor(key, types, capacity = 32) {
    this.key = key;
    this.types = types; // ComponentType[], sorted by id
    this.capacity = capacity;
    this.count = 0;
    this.entities = new Float64Array(capacity);
    this.columns = new Map(); // componentName -> { fieldName -> TypedArray }
    for (const t of types) {
      const cols = {};
      for (const f of t.fields) cols[f.name] = new ARRAY_TYPES[f.type](capacity);
      this.columns.set(t.name, cols);
    }
  }

  has(name) {
    return this.columns.has(name);
  }

  col(component, field) {
    const c = this.columns.get(component);
    if (!c) throw new Error(`archetype ${this.key} has no component ${component}`);
    return c[field];
  }

  entity(row) {
    return this.entities[row];
  }

  _grow() {
    const next = this.capacity * 2;
    const entities = new Float64Array(next);
    entities.set(this.entities);
    this.entities = entities;
    for (const t of this.types) {
      const cols = this.columns.get(t.name);
      for (const f of t.fields) {
        const grown = new ARRAY_TYPES[f.type](next);
        grown.set(cols[f.name]);
        cols[f.name] = grown;
      }
    }
    this.capacity = next;
  }

  /**
   * Rows are kept sorted by entity index — always, not just at checkpoint time.
   *
   * Row order decides the order floating-point accumulations happen in, so a
   * canonical order is what makes replay bit-exact and, just as importantly,
   * makes observing a world (checkpointing it, forking it, snapshotting it for
   * a client) incapable of perturbing it. Insert and delete are memmoves; the
   * structural churn that pays for them is a few dozen rows per tick.
   */
  insertRow(handle) {
    if (this.count === this.capacity) this._grow();
    const index = handleIndex(handle);
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (handleIndex(this.entities[mid]) < index) lo = mid + 1;
      else hi = mid;
    }
    const row = lo;
    if (row < this.count) {
      this.entities.copyWithin(row + 1, row, this.count);
      for (const t of this.types) {
        const cols = this.columns.get(t.name);
        for (const f of t.fields) cols[f.name].copyWithin(row + 1, row, this.count);
      }
    }
    this.count++;
    this.entities[row] = handle;
    for (const t of this.types) {
      const cols = this.columns.get(t.name);
      for (const f of t.fields) cols[f.name][row] = 0;
    }
    return row;
  }

  /** Remove a row, closing the gap. Rows after `row` shift down by one. */
  deleteRow(row) {
    this.entities.copyWithin(row, row + 1, this.count);
    for (const t of this.types) {
      const cols = this.columns.get(t.name);
      for (const f of t.fields) cols[f.name].copyWithin(row, row + 1, this.count);
    }
    this.count--;
    this.entities[this.count] = 0;
    return row;
  }
}

export class Ecs {
  constructor(registry) {
    this.registry = registry;
    this.archetypes = new Map(); // key -> Archetype
    this._generations = new Int32Array(1024);
    this._archOf = new Array(1024).fill(null);
    this._rowOf = new Int32Array(1024).fill(-1);
    this._free = [];
    this._nextIndex = 1; // index 0 is reserved for NULL_ENTITY
    this._alive = 0;
    this._queryCache = new Map();
  }

  get entityCount() {
    return this._alive;
  }

  get archetypeCount() {
    return this.archetypes.size;
  }

  _ensureCapacity(index) {
    if (index < this._generations.length) return;
    const next = Math.max(index + 1, this._generations.length * 2);
    const gens = new Int32Array(next);
    gens.set(this._generations);
    this._generations = gens;
    const rows = new Int32Array(next).fill(-1);
    rows.set(this._rowOf);
    this._rowOf = rows;
    this._archOf.length = next;
  }

  _archetypeFor(types) {
    const sorted = [...types].sort((a, b) => a.id - b.id);
    const key = sorted.map((t) => t.name).join('|') || '(empty)';
    let arch = this.archetypes.get(key);
    if (!arch) {
      arch = new Archetype(key, sorted);
      this.archetypes.set(key, arch);
      this._queryCache.clear();
    }
    return arch;
  }

  /** Create an entity, optionally with initial components: {Position: {x, y}}. */
  create(components = null) {
    const index = this._free.length ? this._free.pop() : this._nextIndex++;
    if (index >= MAX_ENTITIES) throw new Error('entity index space exhausted for this universe');
    this._ensureCapacity(index);
    const handle = makeHandle(index, this._generations[index]);
    const types = components ? Object.keys(components).map((n) => this.registry.get(n)) : [];
    const arch = this._archetypeFor(types);
    const row = arch.insertRow(handle);
    this._archOf[index] = arch;
    this._alive++;
    this._reindexFrom(arch, row);
    if (components) {
      for (const [name, values] of Object.entries(components)) this.set(handle, name, values);
    }
    return handle;
  }

  alive(handle) {
    const index = handleIndex(handle);
    return (
      index > 0 &&
      index < this._generations.length &&
      this._generations[index] === handleGeneration(handle) &&
      this._rowOf[index] >= 0
    );
  }

  destroy(handle) {
    if (!this.alive(handle)) return false;
    const index = handleIndex(handle);
    const arch = this._archOf[index];
    const row = this._rowOf[index];
    arch.deleteRow(row);
    this._archOf[index] = null;
    this._rowOf[index] = -1;
    this._generations[index]++;
    this._free.push(index);
    this._free.sort((a, b) => a - b); // index recycling stays canonical too
    this._alive--;
    this._reindexFrom(arch, row);
    return true;
  }

  /** Refresh the location map for every row from `from` onward. */
  _reindexFrom(arch, from) {
    for (let row = from; row < arch.count; row++) {
      this._rowOf[handleIndex(arch.entities[row])] = row;
    }
  }

  has(handle, component) {
    if (!this.alive(handle)) return false;
    return this._archOf[handleIndex(handle)].has(component);
  }

  _move(handle, nextTypes) {
    const index = handleIndex(handle);
    const from = this._archOf[index];
    const fromRow = this._rowOf[index];
    const to = this._archetypeFor(nextTypes);
    const toRow = to.insertRow(handle);
    for (const t of to.types) {
      if (!from.has(t.name)) continue;
      const src = from.columns.get(t.name);
      const dst = to.columns.get(t.name);
      for (const f of t.fields) dst[f.name][toRow] = src[f.name][fromRow];
    }
    from.deleteRow(fromRow);
    this._archOf[index] = to;
    this._reindexFrom(to, toRow);
    this._reindexFrom(from, fromRow);
  }

  add(handle, component, values = null) {
    if (!this.alive(handle)) throw new Error('add on dead entity');
    const type = this.registry.get(component);
    const arch = this._archOf[handleIndex(handle)];
    if (!arch.has(component)) this._move(handle, [...arch.types, type]);
    if (values) this.set(handle, component, values);
    return handle;
  }

  remove(handle, component) {
    if (!this.alive(handle)) return false;
    const arch = this._archOf[handleIndex(handle)];
    if (!arch.has(component)) return false;
    this._move(
      handle,
      arch.types.filter((t) => t.name !== component),
    );
    return true;
  }

  set(handle, component, values) {
    if (!this.alive(handle)) throw new Error('set on dead entity');
    const index = handleIndex(handle);
    const arch = this._archOf[index];
    if (!arch.has(component)) this.add(handle, component);
    const cols = this._archOf[index].columns.get(component);
    const row = this._rowOf[index];
    for (const [field, value] of Object.entries(values)) {
      if (cols[field] === undefined) {
        throw new Error(`component ${component} has no field "${field}"`);
      }
      cols[field][row] = value;
    }
    return handle;
  }

  /** Object view of one component — for tools, authoring, and serialization. */
  get(handle, component) {
    if (!this.alive(handle)) return null;
    const index = handleIndex(handle);
    const arch = this._archOf[index];
    if (!arch.has(component)) return null;
    const cols = arch.columns.get(component);
    const row = this._rowOf[index];
    const out = {};
    for (const key of Object.keys(cols)) out[key] = cols[key][row];
    return out;
  }

  componentsOf(handle) {
    if (!this.alive(handle)) return [];
    return this._archOf[handleIndex(handle)].types.map((t) => t.name);
  }

  /** Archetypes carrying every named component (and none of `without`). */
  matching(components, without = []) {
    const cacheKey = `${components.join(',')}!${without.join(',')}`;
    let list = this._queryCache.get(cacheKey);
    if (!list) {
      list = [];
      for (const arch of this.archetypes.values()) {
        if (components.every((c) => arch.has(c)) && !without.some((c) => arch.has(c))) list.push(arch);
      }
      this._queryCache.set(cacheKey, list);
    }
    return list;
  }

  /**
   * Iterate matching archetype chunks:
   *   for (const chunk of ecs.query(['Position', 'Velocity'])) {
   *     const px = chunk.col('Position', 'x');
   *     for (let i = 0; i < chunk.count; i++) ...
   *   }
   */
  *query(components, without = []) {
    for (const arch of this.matching(components, without)) {
      if (arch.count > 0) yield arch;
    }
  }

  /** Convenience per-entity iteration. Slower; fine for tools and cold paths. */
  each(components, fn) {
    for (const chunk of this.query(components)) {
      for (let i = 0; i < chunk.count; i++) fn(chunk.entity(i), chunk, i);
    }
  }

  entities() {
    const out = [];
    for (const arch of this.archetypes.values()) {
      for (let i = 0; i < arch.count; i++) out.push(arch.entities[i]);
    }
    out.sort((a, b) => handleIndex(a) - handleIndex(b));
    return out;
  }

  /** Debug assertion: the canonical row order invariant actually holds. */
  isCanonical() {
    for (const arch of this.archetypes.values()) {
      for (let row = 1; row < arch.count; row++) {
        if (handleIndex(arch.entities[row - 1]) >= handleIndex(arch.entities[row])) return false;
      }
      for (let row = 0; row < arch.count; row++) {
        if (this._rowOf[handleIndex(arch.entities[row])] !== row) return false;
      }
    }
    return true;
  }

  /** Pure: a snapshot never perturbs the world it describes. */
  snapshot() {
    const tables = [];
    for (const arch of this.archetypes.values()) {
      if (arch.count === 0) continue;
      const columns = {};
      for (const t of arch.types) {
        const cols = arch.columns.get(t.name);
        columns[t.name] = {};
        for (const f of t.fields) columns[t.name][f.name] = Array.from(cols[f.name].subarray(0, arch.count));
      }
      tables.push({
        types: arch.types.map((t) => t.name),
        entities: Array.from(arch.entities.subarray(0, arch.count)),
        columns,
      });
    }
    return {
      schema: this.registry.digest,
      nextIndex: this._nextIndex,
      free: [...this._free],
      generations: Array.from(this._generations.subarray(0, this._nextIndex)),
      tables,
    };
  }

  static restore(registry, snapshot) {
    const ecs = new Ecs(registry);
    if (snapshot.schema !== registry.digest) {
      throw new Error('schema digest mismatch — migrate the checkpoint before restoring');
    }
    ecs._nextIndex = snapshot.nextIndex;
    ecs._free = [...snapshot.free];
    ecs._ensureCapacity(snapshot.nextIndex);
    for (let i = 0; i < snapshot.generations.length; i++) ecs._generations[i] = snapshot.generations[i];
    for (const table of snapshot.tables) {
      const arch = ecs._archetypeFor(table.types.map((n) => registry.get(n)));
      for (let row = 0; row < table.entities.length; row++) {
        const handle = table.entities[row];
        const r = arch.insertRow(handle);
        for (const [component, fields] of Object.entries(table.columns)) {
          const cols = arch.columns.get(component);
          for (const [field, values] of Object.entries(fields)) cols[field][r] = values[row];
        }
        ecs._archOf[handleIndex(handle)] = arch;
        ecs._rowOf[handleIndex(handle)] = r;
        ecs._alive++;
      }
    }
    return ecs;
  }

  /** Order-independent digest of all component state. */
  digest() {
    const perEntity = [];
    for (const arch of this.archetypes.values()) {
      for (let row = 0; row < arch.count; row++) {
        const d = new Digest();
        d.int(handleIndex(arch.entities[row]));
        for (const t of arch.types) {
          const cols = arch.columns.get(t.name);
          d.str(t.name);
          for (const f of t.fields) d.num(cols[f.name][row]);
        }
        perEntity.push(d.value);
      }
    }
    return commutativeMix(perEntity);
  }

  /** Bytes actually occupied by component columns — the profiler's raw input. */
  memoryFootprint() {
    let bytes = 0;
    for (const arch of this.archetypes.values()) {
      bytes += arch.capacity * 8;
      for (const t of arch.types) bytes += arch.capacity * t.stride;
    }
    return bytes;
  }
}
