import assert from 'node:assert/strict';
import test from 'node:test';

import { Backend, Domain, Scheduler } from '../src/core/scheduler.js';
import { BudgetError, Capabilities, CapabilityError, LawHost } from '../src/core/laws.js';
import { ScalarField } from '../src/core/fields.js';
import { SemanticGraph } from '../src/core/graph.js';
import { SpatialHash, lodFor } from '../src/core/spatial.js';
import { Rng } from '../src/core/rng.js';

// --- scheduler -------------------------------------------------------------

function schedulerFixture() {
  const scheduler = new Scheduler(60);
  const order = [];
  const sys = (name, reads, writes, extra = {}) =>
    scheduler.add({ name, reads, writes, run: () => order.push(name), ...extra });
  sys('Index', ['Position'], ['spatial']);
  sys('Heat', ['Position'], ['field.heat']);
  sys('Gravity', ['Position', 'Mass'], ['Force']);
  sys('Intent', ['spatial', 'field.heat'], ['Steer'], { domain: Domain.AGENT, rateHz: 30 });
  sys('Steering', ['Steer'], ['Force']);
  sys('Integrate', ['Force'], ['Position', 'Velocity'], { backend: Backend.CPU_SIMD });
  return { scheduler, order };
}

test('the schedule is derived from declared hazards, not declaration order', () => {
  const { scheduler } = schedulerFixture();
  const plan = scheduler.compile();
  const waves = plan.waves.map((w) => w.map((s) => s.name));

  assert.deepEqual(waves[0], ['Index', 'Heat', 'Gravity'], 'independent systems share a wave');
  assert.deepEqual(waves[1], ['Intent'], 'Intent reads what Index and Heat write');
  assert.deepEqual(waves[2], ['Steering'], 'Steering reads Steer and also writes Force');
  assert.deepEqual(waves[3], ['Integrate']);
  assert.equal(plan.criticalPath, 4);
  assert.equal(plan.concurrency, 3);
});

test('hazard edges name the resource that caused them', () => {
  const { scheduler } = schedulerFixture();
  const plan = scheduler.compile();
  const steering = plan.edges.get('Steering');
  assert.deepEqual(steering.find((e) => e.from === 'Gravity').on, ['Force'], 'write-after-write');
  assert.deepEqual(steering.find((e) => e.from === 'Intent').on, ['Steer'], 'read-after-write');
});

test('rate-limited systems run on their own cadence', () => {
  const { scheduler, order } = schedulerFixture();
  for (let tick = 0; tick < 4; tick++) scheduler.run({}, tick);
  assert.equal(order.filter((n) => n === 'Index').length, 4);
  assert.equal(order.filter((n) => n === 'Intent').length, 2, '30 Hz inside a 60 Hz tick');
});

// --- capability sandbox ----------------------------------------------------

function lawFixture() {
  const host = new LawHost({
    'self.transform': () => ({ x: 1, y: 2 }),
    'local.weather': () => ({ heat: 0.5 }),
    'arbitrary_database': () => ({ everything: true }),
  });
  const capabilities = new Capabilities({
    read: ['self.transform', 'local.weather'],
    write: ['self.intent'],
    emit: ['speech'],
    deny: ['arbitrary_database'],
    budget: { ops: 5, events: 1 },
  });
  return { host, capabilities };
}

test('a law reaches only what it was granted', () => {
  const { host, capabilities } = lawFixture();
  host.register({
    name: 'lawful',
    capabilities,
    run: (view) => view.write('self.intent', view.read('self.transform')),
  });
  const result = host.invoke('lawful', {}, { tick: 0, rng: new Rng(1) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.intents['self.intent'], { x: 1, y: 2 });
});

test('a denied read costs the law its turn, not the tick', () => {
  const { host, capabilities } = lawFixture();
  host.register({
    name: 'overreaching',
    capabilities,
    run: (view) => {
      view.write('self.intent', { x: 0, y: 0 });
      view.read('arbitrary_database'); // never granted — and a provider exists
      view.write('self.intent', { x: 99, y: 99 });
    },
  });
  const result = host.invoke('overreaching', {}, { tick: 0, rng: new Rng(1) });
  assert.equal(result.ok, false);
  assert.deepEqual(result.intents, {}, 'a faulted law is rolled back whole');
  assert.equal(host.get('overreaching').stats.violations, 1);
  assert.equal(host.violations.at(-1).error.includes('arbitrary_database'), true);
});

test('capabilities are checked before providers are consulted', () => {
  const { capabilities } = lawFixture();
  assert.throws(() => capabilities.check('read', 'filesystem'), CapabilityError);
  assert.throws(() => capabilities.check('write', 'self.transform'), CapabilityError);
  assert.throws(() => capabilities.check('emit', 'trade_offer'), CapabilityError);
});

test('wildcards grant a subtree, not the world', () => {
  const capabilities = new Capabilities({ read: ['nearby.*'], deny: ['nearby.secrets'] });
  capabilities.check('read', 'nearby.transforms');
  assert.throws(() => capabilities.check('read', 'nearby.secrets'), CapabilityError);
  assert.throws(() => capabilities.check('read', 'faraway.transforms'), CapabilityError);
});

test('budgets are enforced, not advisory', () => {
  const { host, capabilities } = lawFixture();
  host.register({
    name: 'greedy',
    capabilities,
    run: (view) => {
      for (let i = 0; i < 50; i++) view.read('local.weather');
    },
  });
  const result = host.invoke('greedy', {}, { tick: 0, rng: new Rng(1) });
  assert.equal(result.ok, false);
  assert.equal(host.get('greedy').stats.budgetFaults, 1);

  host.register({
    name: 'loud',
    capabilities,
    run: (view) => {
      view.emit('speech', { text: 'one' });
      view.emit('speech', { text: 'two' });
    },
  });
  assert.equal(host.invoke('loud', {}, { tick: 0, rng: new Rng(1) }).ok, false);
  assert.equal(host.get('loud').stats.budgetFaults, 1);
});

test('a cached read costs a fresh op but not a fresh provider call', () => {
  let calls = 0;
  const host = new LawHost({ 'local.weather': () => (calls++, { heat: 1 }) });
  host.register({
    name: 'reader',
    capabilities: new Capabilities({ read: ['local.weather'], write: ['self.intent'], budget: { ops: 8 } }),
    run: (view) => {
      for (let i = 0; i < 4; i++) view.read('local.weather');
    },
  });
  assert.equal(host.invoke('reader', {}, { tick: 0, rng: new Rng(1) }).ok, true);
  assert.equal(calls, 1, 'one materialization per invocation');
});

// --- fields ----------------------------------------------------------------

test('diffusion spreads a field without inventing or losing much of it', () => {
  const field = new ScalarField({ name: 'heat', width: 32, height: 32, cellSize: 1, diffusion: 4, decay: 0 });
  field.set(16, 16, 100);
  const before = field.total();
  for (let i = 0; i < 60; i++) field.step(1 / 30);
  assert.ok(Math.abs(field.total() - before) < 1e-6, 'diffusion conserves the quantity');
  assert.ok(field.get(16, 16) < 100, 'the peak spreads');
  assert.ok(field.get(18, 16) > 0, 'the neighbourhood warms');
});

test('decay pulls a field back toward ambient', () => {
  const field = new ScalarField({ name: 'heat', width: 8, height: 8, cellSize: 1, diffusion: 0, decay: 2, ambient: 0.5 });
  field.set(4, 4, 10);
  for (let i = 0; i < 400; i++) field.step(1 / 30);
  assert.ok(Math.abs(field.get(4, 4) - 0.5) < 0.01);
});

test('gradients point uphill in world coordinates', () => {
  const field = new ScalarField({ name: 'heat', width: 32, height: 32, cellSize: 4, diffusion: 4, decay: 0 });
  field.deposit(64, 64, 100);
  for (let i = 0; i < 40; i++) field.step(1 / 30);
  const gradient = field.gradient(40, 64);
  assert.ok(gradient.x > 0, 'warmth is to the east of a point west of the source');
  assert.ok(Math.abs(gradient.y) < Math.abs(gradient.x));
});

// --- semantic graph --------------------------------------------------------

test('relationships are queryable from either end', () => {
  const graph = new SemanticGraph();
  graph.add('alice', 'OWNS', 'ship-7', { tick: 4 });
  graph.add('bob', 'OWNS', 'ship-9', { tick: 5 });
  graph.add('ship-7', 'DOCKED_AT', 'station-1', { tick: 6 });

  assert.equal(graph.query({ s: 'alice' }).length, 1);
  assert.equal(graph.query({ p: 'OWNS' }).length, 2);
  assert.equal(graph.query({ o: 'ship-7' }).length, 1);
  assert.equal(graph.one('alice', 'OWNS'), 'ship-7');
  assert.equal(graph.reach('alice', { depth: 2 }).length, 2, 'alice reaches the station through her ship');
});

test('reassignment keeps the old edge as history', () => {
  const graph = new SemanticGraph();
  graph.add('alice', 'OWNS', 'ship-7', { tick: 4 });
  const { previous } = graph.reassign('alice', 'OWNS', 'ship-8', { tick: 40 });
  assert.equal(previous.o, 'ship-7');
  assert.equal(graph.one('alice', 'OWNS'), 'ship-8');
  assert.equal(graph.size, 1, 'only one relationship is live');
  assert.equal(graph.edges.length, 2, 'both are remembered');
});

test('the graph survives serialization with its indices intact', () => {
  const graph = new SemanticGraph();
  graph.add('a', 'KNOWS', 'b', { tick: 1 });
  graph.add('b', 'KNOWS', 'c', { tick: 2 });
  graph.remove('a', 'KNOWS', 'b');
  const restored = SemanticGraph.fromJSON(graph.toJSON());
  assert.equal(restored.size, graph.size);
  assert.equal(restored.digest(), graph.digest());
  assert.equal(restored.query({ s: 'b' }).length, 1);
});

// --- spatial ---------------------------------------------------------------

test('radius queries are exact, not merely cell-aligned', () => {
  const grid = new SpatialHash(10);
  grid.insert(1, 0, 0);
  grid.insert(2, 9, 0);
  grid.insert(3, 11, 0);
  grid.insert(4, 100, 100);
  const found = grid.queryRadius(0, 0, 10).sort();
  assert.deepEqual(found, [1, 2]);
  assert.equal(grid.nearest(12, 0, 30).handle, 3);
});

test('level of detail falls off with distance and rises with importance', () => {
  assert.equal(lodFor(10).label, 'scientific');
  assert.equal(lodFor(100).label, 'interactive');
  assert.equal(lodFor(1000).label, 'aggregate');
  assert.equal(lodFor(1000, 40).level > 0, true, 'importance promotes a distant region');
});

// --- rng -------------------------------------------------------------------

test('named sub-streams are independent and reproducible', () => {
  const a = new Rng(7);
  const b = new Rng(7);
  assert.equal(a.fork('agents').next(), b.fork('agents').next());
  assert.notEqual(a.fork('agents').next(), a.fork('weather').next());
  assert.equal(a.state, b.state, 'forking does not disturb the parent stream');
});
