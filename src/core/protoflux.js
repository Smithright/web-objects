// Flux — visual scripting as a dataflow graph.
//
// A graph is nodes and wires. Value nodes are pulled: asking for an output
// evaluates whatever it depends on, once per tick, memoized. Impulse nodes are
// the roots that actually do something, and they are the only nodes allowed to
// touch the world — through the same capability sandbox that agent behavior
// runs in, so a script somebody handed you can move their own cube and cannot
// read your inventory.
//
// Cycles are detected rather than hung on, budgets are metered rather than
// trusted, and a graph that faults loses its turn rather than the tick. All of
// which the engine already had — this is the layer that makes it authorable.

import { BudgetError, Capabilities, CapabilityError } from './laws.js';

export const FluxType = {
  FLOAT: 'float',
  BOOL: 'bool',
  VEC3: 'vec3',
  COLOR: 'color',
  SLOT: 'slot',
  STRING: 'string',
};

/**
 * The node library.
 *
 * Each definition declares its inputs, its outputs, whether it is an impulse
 * (a root that runs every tick), and which capabilities it needs. The last part
 * is what lets a graph be checked before it is ever run.
 */
export const NODES = {};

function defineNode(name, spec) {
  NODES[name] = {
    name,
    category: spec.category ?? 'value',
    inputs: spec.inputs ?? {},
    outputs: spec.outputs ?? {},
    impulse: Boolean(spec.impulse),
    reads: spec.reads ?? [],
    writes: spec.writes ?? [],
    evaluate: spec.evaluate,
    doc: spec.doc ?? '',
  };
  return NODES[name];
}

// --- constants and maths ----------------------------------------------------

defineNode('Float', {
  category: 'constant',
  inputs: { value: { type: FluxType.FLOAT, default: 0 } },
  outputs: { value: FluxType.FLOAT },
  evaluate: (inputs) => ({ value: inputs.value }),
  doc: 'A number.',
});

defineNode('Vec3', {
  category: 'constant',
  inputs: {
    x: { type: FluxType.FLOAT, default: 0 },
    y: { type: FluxType.FLOAT, default: 0 },
    z: { type: FluxType.FLOAT, default: 0 },
  },
  outputs: { value: FluxType.VEC3 },
  evaluate: (inputs) => ({ value: [inputs.x, inputs.y, inputs.z] }),
});

for (const [name, fn] of [
  ['Add', (a, b) => a + b],
  ['Subtract', (a, b) => a - b],
  ['Multiply', (a, b) => a * b],
  ['Divide', (a, b) => (b === 0 ? 0 : a / b)],
  ['Min', Math.min],
  ['Max', Math.max],
  ['Power', (a, b) => a ** b],
]) {
  defineNode(name, {
    category: 'math',
    inputs: { a: { type: FluxType.FLOAT, default: 0 }, b: { type: FluxType.FLOAT, default: 0 } },
    outputs: { value: FluxType.FLOAT },
    evaluate: (inputs) => ({ value: fn(inputs.a, inputs.b) }),
  });
}

for (const [name, fn] of [['Sin', Math.sin], ['Cos', Math.cos], ['Abs', Math.abs], ['Floor', Math.floor], ['Sqrt', (v) => Math.sqrt(Math.max(0, v))]]) {
  defineNode(name, {
    category: 'math',
    inputs: { value: { type: FluxType.FLOAT, default: 0 } },
    outputs: { value: FluxType.FLOAT },
    evaluate: (inputs) => ({ value: fn(inputs.value) }),
  });
}

defineNode('Clamp', {
  category: 'math',
  inputs: {
    value: { type: FluxType.FLOAT, default: 0 },
    min: { type: FluxType.FLOAT, default: 0 },
    max: { type: FluxType.FLOAT, default: 1 },
  },
  outputs: { value: FluxType.FLOAT },
  evaluate: (i) => ({ value: Math.min(i.max, Math.max(i.min, i.value)) }),
});

defineNode('Lerp', {
  category: 'math',
  inputs: {
    a: { type: FluxType.FLOAT, default: 0 },
    b: { type: FluxType.FLOAT, default: 1 },
    t: { type: FluxType.FLOAT, default: 0 },
  },
  outputs: { value: FluxType.FLOAT },
  evaluate: (i) => ({ value: i.a + (i.b - i.a) * Math.min(1, Math.max(0, i.t)) }),
});

// --- logic ------------------------------------------------------------------

defineNode('GreaterThan', {
  category: 'logic',
  inputs: { a: { type: FluxType.FLOAT, default: 0 }, b: { type: FluxType.FLOAT, default: 0 } },
  outputs: { value: FluxType.BOOL },
  evaluate: (i) => ({ value: i.a > i.b }),
});

defineNode('And', {
  category: 'logic',
  inputs: { a: { type: FluxType.BOOL, default: false }, b: { type: FluxType.BOOL, default: false } },
  outputs: { value: FluxType.BOOL },
  evaluate: (i) => ({ value: Boolean(i.a) && Boolean(i.b) }),
});

defineNode('Not', {
  category: 'logic',
  inputs: { value: { type: FluxType.BOOL, default: false } },
  outputs: { value: FluxType.BOOL },
  evaluate: (i) => ({ value: !i.value }),
});

defineNode('Select', {
  category: 'logic',
  inputs: {
    condition: { type: FluxType.BOOL, default: false },
    ifTrue: { type: FluxType.FLOAT, default: 1 },
    ifFalse: { type: FluxType.FLOAT, default: 0 },
  },
  outputs: { value: FluxType.FLOAT },
  evaluate: (i) => ({ value: i.condition ? i.ifTrue : i.ifFalse }),
});

// --- the world, read through capabilities ----------------------------------

defineNode('Time', {
  category: 'world',
  outputs: { seconds: FluxType.FLOAT, tick: FluxType.FLOAT },
  reads: ['world.time'],
  evaluate: (inputs, view) => {
    const time = view.read('world.time');
    return { seconds: time.seconds, tick: time.tick };
  },
  doc: 'World time. The only clock a graph is allowed to see.',
});

defineNode('SlotPosition', {
  category: 'world',
  inputs: { slot: { type: FluxType.SLOT, default: -1 } },
  outputs: { position: FluxType.VEC3, x: FluxType.FLOAT, y: FluxType.FLOAT, z: FluxType.FLOAT },
  reads: ['slot.transform'],
  evaluate: (inputs, view) => {
    const t = view.read('slot.transform')(inputs.slot);
    return { position: [t.x, t.y, t.z], x: t.x, y: t.y, z: t.z };
  },
});

defineNode('DistanceToObserver', {
  category: 'world',
  inputs: { slot: { type: FluxType.SLOT, default: -1 } },
  outputs: { distance: FluxType.FLOAT },
  reads: ['slot.transform', 'observer.transform'],
  evaluate: (inputs, view) => {
    const slot = view.read('slot.transform')(inputs.slot);
    const observer = view.read('observer.transform');
    return { distance: Math.hypot(slot.x - observer.x, slot.y - observer.y, slot.z - observer.z) };
  },
});

// --- impulses: the only nodes that change anything --------------------------

defineNode('SetSlotPosition', {
  category: 'impulse',
  impulse: true,
  inputs: {
    slot: { type: FluxType.SLOT, default: -1 },
    x: { type: FluxType.FLOAT, default: 0 },
    y: { type: FluxType.FLOAT, default: 0 },
    z: { type: FluxType.FLOAT, default: 0 },
  },
  writes: ['slot.position'],
  evaluate: (inputs, view) => {
    view.write('slot.position', { slot: inputs.slot, x: inputs.x, y: inputs.y, z: inputs.z });
  },
});

defineNode('SetSlotScale', {
  category: 'impulse',
  impulse: true,
  inputs: { slot: { type: FluxType.SLOT, default: -1 }, scale: { type: FluxType.FLOAT, default: 1 } },
  writes: ['slot.scale'],
  evaluate: (inputs, view) => {
    view.write('slot.scale', { slot: inputs.slot, scale: inputs.scale });
  },
});

defineNode('SetSlotSpin', {
  category: 'impulse',
  impulse: true,
  inputs: { slot: { type: FluxType.SLOT, default: -1 }, angle: { type: FluxType.FLOAT, default: 0 } },
  writes: ['slot.rotation'],
  evaluate: (inputs, view) => {
    view.write('slot.rotation', { slot: inputs.slot, yaw: inputs.angle });
  },
});

defineNode('Say', {
  category: 'impulse',
  impulse: true,
  inputs: { text: { type: FluxType.STRING, default: '' }, when: { type: FluxType.BOOL, default: true } },
  writes: [],
  evaluate: (inputs, view) => {
    if (inputs.when) view.emit('speech', { text: String(inputs.text).slice(0, 120) });
  },
});

// ---------------------------------------------------------------------------

let nextGraphId = 1;

export class FluxGraph {
  constructor(name = 'graph') {
    this.id = nextGraphId++;
    this.name = name;
    this.nodes = [];
    this.faults = [];
    this.stats = { evaluations: 0, ticks: 0, faults: 0 };
  }

  /**
   * Add a node. Inputs are literals, or `{ node, output }` to wire one in.
   */
  add(type, inputs = {}) {
    const definition = NODES[type];
    if (!definition) throw new Error(`unknown node type "${type}"`);
    const node = { index: this.nodes.length, type, definition, inputs: { ...inputs } };
    this.nodes.push(node);
    return node.index;
  }

  connect(fromNode, output, toNode, input) {
    const target = this.nodes[toNode];
    if (!target) throw new Error(`no node ${toNode}`);
    if (!NODES[this.nodes[fromNode]?.type]?.outputs[output]) {
      throw new Error(`node ${fromNode} has no output "${output}"`);
    }
    target.inputs[input] = { node: fromNode, output };
    return this;
  }

  /** Everything this graph needs permission to do. */
  capabilities() {
    const reads = new Set();
    const writes = new Set();
    const emits = new Set();
    for (const node of this.nodes) {
      for (const path of node.definition.reads) reads.add(path);
      for (const path of node.definition.writes) writes.add(path);
      if (node.type === 'Say') emits.add('speech');
    }
    return { read: [...reads], write: [...writes], emit: [...emits] };
  }

  /** Cycle detection, before anything runs. */
  validate() {
    const problems = [];
    const state = new Array(this.nodes.length).fill(0); // 0 unvisited, 1 in progress, 2 done
    const visit = (index, trail) => {
      if (state[index] === 1) {
        problems.push({ kind: 'cycle', nodes: [...trail, index] });
        return;
      }
      if (state[index] === 2) return;
      state[index] = 1;
      const node = this.nodes[index];
      for (const [name, value] of Object.entries(node.inputs)) {
        if (!value || typeof value !== 'object' || value.node === undefined) continue;
        if (!this.nodes[value.node]) {
          problems.push({ kind: 'dangling', node: index, input: name });
          continue;
        }
        visit(value.node, [...trail, index]);
      }
      state[index] = 2;
    };
    for (let i = 0; i < this.nodes.length; i++) visit(i, []);
    return { ok: problems.length === 0, problems };
  }

  get impulses() {
    return this.nodes.filter((node) => node.definition.impulse).map((node) => node.index);
  }

  toJSON() {
    return {
      format: 'latticeborn.flux',
      version: 1,
      name: this.name,
      nodes: this.nodes.map((node) => ({ type: node.type, inputs: node.inputs })),
    };
  }

  static fromJSON(json) {
    if (json?.format !== 'latticeborn.flux') throw new Error('not a flux graph');
    const graph = new FluxGraph(json.name);
    for (const node of json.nodes) graph.add(node.type, node.inputs);
    return graph;
  }
}

/**
 * Evaluate a graph for one tick.
 *
 * `view` is the capability-checked host object from LawHost, so every read and
 * write a node performs is charged against the graph's budget and refused if
 * the grant does not cover it.
 */
export function evaluateGraph(graph, view, options = {}) {
  const memo = new Map();
  const budget = options.maxEvaluations ?? 512;
  let evaluations = 0;

  const resolve = (index, depth = 0) => {
    if (memo.has(index)) return memo.get(index);
    if (depth > 64) throw new Error('flux graph is too deep');
    if (++evaluations > budget) throw new BudgetError('node evaluations', budget);

    const node = graph.nodes[index];
    const inputs = {};
    for (const [name, spec] of Object.entries(node.definition.inputs)) {
      const wired = node.inputs[name];
      if (wired && typeof wired === 'object' && wired.node !== undefined) {
        const upstream = resolve(wired.node, depth + 1);
        inputs[name] = upstream?.[wired.output];
        if (inputs[name] === undefined) inputs[name] = spec.default;
      } else {
        inputs[name] = wired !== undefined ? wired : spec.default;
      }
    }
    const outputs = node.definition.evaluate(inputs, view) ?? {};
    memo.set(index, outputs);
    return outputs;
  };

  const results = [];
  for (const index of graph.impulses) results.push(resolve(index));
  graph.stats.evaluations += evaluations;
  graph.stats.ticks++;
  return { evaluations, results };
}

// ---------------------------------------------------------------------------
// Running graphs against a world
// ---------------------------------------------------------------------------

/**
 * Install the Flux runtime.
 *
 * The providers below are the entire surface a graph can see. Adding a node
 * type that needs something new means adding a provider here — which is the
 * point: the list of things scripts can do is a list you can read.
 */
export function installFlux(world, options = {}) {
  if (world.fluxGraphs) return world;
  world.fluxGraphs = [];

  const slotTransform = (index) => {
    const arch = world.ecs._archOf[index];
    if (!arch) return { x: 0, y: 0, z: 0 };
    const handle = arch.entities[world.ecs._rowOf[index]];
    if (!handle || !world.ecs.has(handle, 'WorldTransform')) return { x: 0, y: 0, z: 0 };
    const t = world.ecs.get(handle, 'WorldTransform');
    return { x: t.px, y: t.py, z: t.pz };
  };

  world.laws
    .provide('world.time', () => ({ seconds: world.time, tick: world.tick }))
    .provide('slot.transform', () => slotTransform)
    .provide('observer.transform', () => {
      for (const chunk of world.ecs.query(['Avatar', 'Position'])) {
        if (chunk.count === 0) continue;
        const p = world.ecs.get(chunk.entity(0), 'Position');
        return { x: p.x, y: p.y, z: p.z };
      }
      return { x: 0, y: 0, z: 0 };
    });

  world.addSystem({
    name: 'Flux',
    reads: ['WorldTransform', 'flux'],
    writes: ['LocalTransform', 'flux'],
    domain: 'AGENT',
    rateHz: options.rateHz ?? 30,
    run: (w) => runFluxGraphs(w),
  });

  return world;
}

/**
 * Attach a graph to the world, sandboxed.
 *
 * The grant is derived from the graph itself and then *narrowed* by whatever
 * the caller allows — so a graph that wants to move any slot can be admitted
 * with permission to move exactly one.
 */
export function attachGraph(world, graph, options = {}) {
  installFlux(world);
  const validation = graph.validate();
  if (!validation.ok) {
    throw new Error(`flux graph "${graph.name}" is invalid: ${JSON.stringify(validation.problems)}`);
  }

  const wanted = graph.capabilities();
  const allowedSlots = options.slots ? new Set(options.slots) : null;
  const capabilities = new Capabilities({
    read: options.read ?? wanted.read,
    write: options.write ?? wanted.write,
    emit: options.emit ?? wanted.emit,
    deny: options.deny ?? ['filesystem', 'raw_network', 'arbitrary_database'],
    budget: { ops: options.ops ?? 256, events: options.events ?? 4 },
  });

  const law = world.addLaw({
    name: `flux:${graph.name}#${graph.id}`,
    version: 1,
    capabilities,
    run(view) {
      evaluateGraph(graph, view, { maxEvaluations: options.maxEvaluations ?? 512 });
    },
  });

  const record = { graph, law, allowedSlots, intents: {}, enabled: true, faults: 0 };
  world.fluxGraphs.push(record);
  return record;
}

/** Run every attached graph and apply what they asked for. */
export function runFluxGraphs(world) {
  if (!world.fluxGraphs?.length) return;
  const ctx = { world, tick: world.tick, rng: world.rng.fork(`flux:${world.tick}`) };

  for (const record of world.fluxGraphs) {
    if (!record.enabled) continue;
    const result = world.laws.invoke(record.law.name, record, ctx);
    if (!result.ok) {
      record.faults++;
      record.graph.stats.faults++;
      // A graph that oversteps is switched off rather than left to spam the
      // fault log every tick. It stays in the world so it can be inspected.
      if (record.faults > 8) record.enabled = false;
      continue;
    }
    applyIntents(world, record, result.intents);
  }
}

function applyIntents(world, record, intents) {
  for (const [path, value] of Object.entries(intents)) {
    if (!value || value.slot === undefined) continue;
    if (record.allowedSlots && !record.allowedSlots.has(value.slot)) continue;
    const arch = world.ecs._archOf[value.slot];
    if (!arch) continue;
    const handle = arch.entities[world.ecs._rowOf[value.slot]];
    if (!handle || !world.ecs.alive(handle) || !world.ecs.has(handle, 'LocalTransform')) continue;
    // A held object is being driven by a person; a script does not get to fight
    // them for it.
    if (world.ecs.has(handle, 'Held')) continue;

    if (path === 'slot.position') {
      world.ecs.set(handle, 'LocalTransform', { px: value.x, py: value.y, pz: value.z });
    } else if (path === 'slot.scale') {
      const scale = Math.min(60, Math.max(0.02, value.scale));
      world.ecs.set(handle, 'LocalTransform', { sx: scale, sy: scale, sz: scale });
    } else if (path === 'slot.rotation') {
      const half = value.yaw * 0.5;
      world.ecs.set(handle, 'LocalTransform', { rx: 0, ry: Math.sin(half), rz: 0, rw: Math.cos(half) });
    }
  }
}

export { CapabilityError, BudgetError };
