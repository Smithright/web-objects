// The world — the canonical record.
//
//   World[t] + Commands[t] + Laws[v] -> World[t+1]
//
// A world owns the substrate (entities, fields, graph, spatial index), the
// runtime (scheduler, laws), and the durability layer (event log, checkpoints).
// It does not own a renderer, a scene, a camera, or a frame. Those are
// projections, and they can come and go while the world keeps evolving.

import { Digest } from './hash.js';
import { Ecs, Registry } from './ecs.js';
import { EventClass, EventLog } from './events.js';
import { SemanticGraph } from './graph.js';
import { Rng } from './rng.js';
import { Scheduler } from './scheduler.js';
import { SpatialHash } from './spatial.js';
import { entityKey, handleIndex } from './ids.js';
import { LawHost } from './laws.js';

export const CHECKPOINT_VERSION = 1;

export class World {
  constructor(options = {}) {
    this.options = options;
    this.universe = options.universe ?? 'u0';
    this.seed = options.seed ?? 1;
    this.tickHz = options.tickHz ?? 60;
    this.dt = 1 / this.tickHz;
    this.tick = 0;
    this.time = 0;

    this.registry = options.registry ?? new Registry();
    this.ecs = new Ecs(this.registry);
    this.graph = new SemanticGraph();
    this.spatial = new SpatialHash(options.cellSize ?? 24);
    this.scheduler = new Scheduler(this.tickHz);
    this.laws = new LawHost();
    this.log = new EventLog(this.universe, { retain: options.retainEvents ?? 20000 });
    this.rng = new Rng(this.seed);
    this.fields = new Map();

    this.lineage = { parent: null, forkTick: null, label: options.label ?? 'root' };
    this.pending = [];
    this.commandHandlers = new Map();
    this.subscribers = new Set();
    this.stats = { spawned: 0, despawned: 0, commands: 0, events: 0, lastTrace: [] };

    if (typeof options.install === 'function') options.install(this);
  }

  // ---- authoring surface -------------------------------------------------

  defineComponent(name, fields, options) {
    return this.registry.define(name, fields, options);
  }

  addField(field) {
    this.fields.set(field.name, field);
    return field;
  }

  field(name) {
    const f = this.fields.get(name);
    if (!f) throw new Error(`unknown field "${name}"`);
    return f;
  }

  addSystem(desc) {
    return this.scheduler.add(desc);
  }

  addLaw(desc) {
    return this.laws.register(desc);
  }

  onCommand(operation, handler) {
    this.commandHandlers.set(operation, handler);
    return this;
  }

  // ---- entities ----------------------------------------------------------

  spawn(components, meta = {}) {
    const handle = this.ecs.create(components);
    this.stats.spawned++;
    this.emit({
      operation: meta.operation ?? 'spawn',
      class: EventClass.LIFECYCLE,
      actor: meta.actor ?? null,
      target: this.key(handle),
      causal_parent: meta.cause ?? null,
      payload: {
        kind: meta.kind ?? 'entity',
        x: components?.Position?.x,
        y: components?.Position?.y,
      },
    });
    return handle;
  }

  despawn(handle, meta = {}) {
    if (!this.ecs.alive(handle)) return false;
    const key = this.key(handle);
    const position = this.ecs.get(handle, 'Position');
    this.ecs.destroy(handle);
    this.stats.despawned++;
    this.emit({
      operation: meta.operation ?? 'despawn',
      class: EventClass.LIFECYCLE,
      actor: meta.actor ?? null,
      target: key,
      causal_parent: meta.cause ?? null,
      payload: { reason: meta.reason ?? 'unspecified', x: position?.x, y: position?.y },
    });
    return true;
  }

  key(handle) {
    return entityKey(this.universe, handle);
  }

  /** Resolve an entity key back to a live handle in this universe. */
  resolve(key) {
    const [universe, index] = String(key).split('#');
    if (universe !== this.universe) return null;
    const i = Number(index);
    const handle = this.ecs._archOf[i] ? this.ecs._archOf[i].entities[this.ecs._rowOf[i]] : null;
    return handle && handleIndex(handle) === i ? handle : null;
  }

  // ---- events and commands -----------------------------------------------

  emit(event) {
    const record = this.log.append({ tick: this.tick, ...event });
    this.stats.events++;
    for (const fn of this.subscribers) fn(record);
    return record;
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Queue an intent. It becomes authoritative only when the next tick applies it. */
  submit(command) {
    this.pending.push(command);
    return this;
  }

  _applyCommands() {
    if (!this.pending.length) return;
    const commands = this.pending;
    this.pending = [];
    for (const command of commands) {
      const event = this.emit({
        operation: command.op,
        class: EventClass.COMMAND,
        actor: command.actor ?? null,
        target: command.target ?? null,
        payload: command.payload ?? {},
        causal_parent: command.cause ?? null,
      });
      this.stats.commands++;
      const handler = this.commandHandlers.get(command.op);
      if (handler) handler(this, command.payload ?? {}, event);
    }
  }

  // ---- the tick ----------------------------------------------------------

  step() {
    this._applyCommands();
    const trace = this.scheduler.run(this, this.tick);
    this.stats.lastTrace = trace;
    this.tick++;
    this.time += this.dt;
    return trace;
  }

  run(ticks) {
    for (let i = 0; i < ticks; i++) this.step();
    return this;
  }

  // ---- identity ----------------------------------------------------------

  /**
   * A single value standing for the entire canonical state. Two worlds with the
   * same hash are the same world — that is what makes replay, rollback, and
   * distributed consensus checkable rather than hopeful.
   */
  hash() {
    const d = new Digest();
    d.str(this.universe).int(this.tick).int(this.rng.state).int(this.ecs.digest()).int(this.graph.digest());
    for (const name of [...this.fields.keys()].sort()) d.str(name).int(this.fields.get(name).digest());
    return d.hex;
  }

  // ---- durability --------------------------------------------------------

  checkpoint() {
    const fields = {};
    for (const [name, field] of this.fields) fields[name] = field.toJSON();
    return {
      version: CHECKPOINT_VERSION,
      universe: this.universe,
      label: this.lineage.label,
      lineage: { ...this.lineage },
      tick: this.tick,
      time: this.time,
      seed: this.seed,
      tickHz: this.tickHz,
      rng: this.rng.snapshot(),
      schema: this.registry.digest,
      ecs: this.ecs.snapshot(),
      graph: this.graph.toJSON(),
      fields,
      log: { seq: this.log.seq, digest: this.log.digest },
      stats: { ...this.stats, lastTrace: [] },
      hash: this.hash(),
    };
  }

  /** Overwrite this world's state from a checkpoint. Systems and laws stay put. */
  load(checkpoint) {
    if (checkpoint.version !== CHECKPOINT_VERSION) {
      throw new Error(`checkpoint version ${checkpoint.version} not supported`);
    }
    this.tick = checkpoint.tick;
    this.time = checkpoint.time;
    this.rng.restore(checkpoint.rng);
    this.ecs = Ecs.restore(this.registry, checkpoint.ecs);
    this.graph = SemanticGraph.fromJSON(checkpoint.graph);
    for (const [name, json] of Object.entries(checkpoint.fields)) {
      const field = this.fields.get(name);
      if (!field) throw new Error(`checkpoint has field "${name}" this world does not define`);
      field.data.set(json.data);
    }
    this.log.seq = checkpoint.log.seq;
    this.log.digest = checkpoint.log.digest;
    this.stats = { ...checkpoint.stats, lastTrace: [] };
    this.pending = [];
    this._reindex();
    return this;
  }

  /** Rebuild derived, non-authoritative structures after a load. */
  _reindex() {
    this.spatial.clear();
    for (const chunk of this.ecs.query(['Position'])) {
      const px = chunk.col('Position', 'x');
      const py = chunk.col('Position', 'y');
      for (let i = 0; i < chunk.count; i++) this.spatial.insert(chunk.entity(i), px[i], py[i]);
    }
  }

  // ---- time travel -------------------------------------------------------

  /**
   * Fork a counterfactual universe. The child references its parent and the
   * fork tick; it does not duplicate history, only present state.
   */
  fork(universeId, { label = 'branch' } = {}) {
    const child = new World({ ...this.options, universe: universeId, registry: new Registry(), label });
    child.load(rekeyCheckpoint(this.checkpoint(), universeId));
    child.lineage = { parent: { universe: this.universe, tick: this.tick }, forkTick: this.tick, label };
    child.log.seq = 0;
    child.log.digest = 0x811c9dc5;
    child.emit({
      operation: 'universe.fork',
      class: EventClass.LIFECYCLE,
      payload: { parent: this.universe, forkTick: this.tick, label },
    });
    return child;
  }

  /**
   * Rebuild a world at `toTick` from a checkpoint plus the command events that
   * followed it. Consequences are not replayed — they are re-derived, which is
   * exactly the property that makes the history executable rather than merely
   * recorded.
   */
  static replay({ checkpoint, commands = [], toTick, options = {} }) {
    const world = new World({ ...options, universe: checkpoint.universe, seed: checkpoint.seed });
    world.load(checkpoint);
    const byTick = new Map();
    for (const event of commands) {
      if (event.class !== EventClass.COMMAND) continue;
      if (!byTick.has(event.tick)) byTick.set(event.tick, []);
      byTick.get(event.tick).push(event);
    }
    const target = toTick ?? checkpoint.tick;
    while (world.tick < target) {
      for (const event of byTick.get(world.tick) ?? []) {
        world.submit({
          op: event.operation,
          actor: event.actor,
          target: event.target,
          payload: event.payload,
          cause: event.causal_parent,
        });
      }
      world.step();
    }
    return world;
  }

  // ---- introspection -----------------------------------------------------

  describe() {
    const counts = this.log.counts();
    return {
      universe: this.universe,
      label: this.lineage.label,
      lineage: this.lineage,
      tick: this.tick,
      time: Number(this.time.toFixed(3)),
      hash: this.hash(),
      entities: this.ecs.entityCount,
      archetypes: this.ecs.archetypeCount,
      memoryBytes: this.ecs.memoryFootprint(),
      graphEdges: this.graph.size,
      fields: [...this.fields.keys()],
      events: this.log.length,
      eventKinds: Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1])),
      occupiedCells: this.spatial.occupiedCells(),
      schedule: this.scheduler.describe(),
      laws: this.laws.describe(),
    };
  }
}

/** Rewrite entity keys inside a checkpoint so a fork owns its own identities. */
function rekeyCheckpoint(checkpoint, universe) {
  const from = `${checkpoint.universe}#`;
  const to = `${universe}#`;
  const graph = {
    edges: checkpoint.graph.edges.map((edge) => ({
      ...edge,
      s: edge.s.startsWith(from) ? to + edge.s.slice(from.length) : edge.s,
      o: edge.o.startsWith(from) ? to + edge.o.slice(from.length) : edge.o,
    })),
  };
  return { ...checkpoint, universe, graph };
}
