import assert from 'node:assert/strict';
import test from 'node:test';

import { GENERATOR_VERSION, Priority, ProjectionServer, applyMutationLog, chunkDigest, createTestbed, generateChunk } from '../src/index.js';

function primed(ticks = 60) {
  const world = createTestbed({ seed: 99, motes: 300, foragers: 60 });
  world.run(ticks);
  return world;
}

test('an observer receives only what falls inside its horizon', () => {
  const world = primed();
  const projection = new ProjectionServer(world);
  projection.connect('near', { x: 256, y: 256, radius: 40, budgetBytes: 1 << 20 });
  const snapshot = projection.snapshot('near');

  assert.ok(snapshot.entered.length > 0);
  for (const update of snapshot.entered) {
    const position = update.components.Position;
    // Interest is resolved against the spatial index, which is rebuilt at the
    // top of a tick — so an entity may have moved up to one tick's travel past
    // the horizon by the time the snapshot is cut. Nothing further gets in.
    assert.ok(Math.hypot(position.x - 256, position.y - 256) <= 40 + 90 / 30);
  }
  assert.equal(snapshot.stats.considered, snapshot.entered.length + snapshot.stats.dropped);
});

test('the second snapshot carries deltas, not the world again', () => {
  const world = primed();
  const projection = new ProjectionServer(world);
  projection.connect('client', { x: 256, y: 256, radius: 120, budgetBytes: 1 << 20 });

  const first = projection.snapshot('client');
  assert.ok(first.entered.length > 0);
  assert.equal(first.updates.length, 0);

  const second = projection.snapshot('client');
  assert.equal(second.entered.length, 0, 'nothing entered — nothing moved into the horizon');
  assert.ok(second.stats.bytes < first.stats.bytes, 'a delta costs less than a full state');

  world.run(30);
  const third = projection.snapshot('client');
  assert.ok(third.updates.length > 0, 'movement produces deltas');
  assert.ok(third.stats.bytes < third.stats.naiveBytes / 2, 'still far below full replication');
});

test('a static world costs almost nothing to replicate', () => {
  const world = primed();
  const projection = new ProjectionServer(world);
  projection.connect('client', { x: 256, y: 256, radius: 120, budgetBytes: 1 << 20 });
  projection.snapshot('client');
  const quiet = projection.snapshot('client');
  assert.equal(quiet.updates.length, 0);
  assert.ok(quiet.stats.bytes < 64);
});

test('owned entities are P0 and survive a starved budget', () => {
  const world = primed();
  const projection = new ProjectionServer(world);
  let owned = null;
  world.ecs.each(['Agent', 'Position'], (handle) => {
    if (owned) return;
    const p = world.ecs.get(handle, 'Position');
    if (Math.hypot(p.x - 256, p.y - 256) < 200) owned = { key: world.key(handle), p };
  });
  assert.ok(owned, 'the grove has an agent to own');

  const view = projection.connect('player', {
    x: owned.p.x,
    y: owned.p.y,
    radius: 220,
    budgetBytes: 64, // deliberately far too small
    owns: [owned.key],
  });
  const snapshot = projection.snapshot('player');
  const mine = snapshot.entered.find((u) => u.key === owned.key);
  assert.ok(mine, 'authority state is never dropped');
  assert.equal(mine.priority, Priority.P0);
  assert.ok(snapshot.stats.dropped > 0, 'cosmetic detail is dropped instead');
  assert.equal(view.stats.snapshots, 1);
});

test('distance lowers priority and thins what is replicated', () => {
  const world = primed();
  const projection = new ProjectionServer(world);
  projection.connect('wide', { x: 256, y: 256, radius: 300, budgetBytes: 1 << 20 });
  const snapshot = projection.snapshot('wide');

  const byPriority = new Map();
  for (const update of snapshot.entered) {
    byPriority.set(update.priority, (byPriority.get(update.priority) ?? 0) + 1);
  }
  assert.ok(byPriority.size > 1, 'the horizon spans more than one priority band');

  const far = snapshot.entered.filter((u) => u.lod <= 1);
  for (const update of far) {
    assert.equal(update.components.Velocity, undefined, 'distant motion is reconstructed, not sent');
  }
});

test('interest can be narrowed to specific components', () => {
  const world = primed();
  const projection = new ProjectionServer(world);
  projection.connect('archivist', { x: 256, y: 256, radius: 200, interest: ['Position'], budgetBytes: 1 << 20 });
  const snapshot = projection.snapshot('archivist');
  for (const update of snapshot.entered) {
    assert.deepEqual(Object.keys(update.components), ['Position']);
  }
});

test('entities that leave the horizon are explicitly exited', () => {
  const world = primed();
  const projection = new ProjectionServer(world);
  const view = projection.connect('client', { x: 100, y: 100, radius: 60, budgetBytes: 1 << 20 });
  projection.snapshot('client');
  const tracked = view.known.size;
  assert.ok(tracked > 0);

  view.move(450, 450);
  const snapshot = projection.snapshot('client');
  assert.equal(snapshot.exited.length, tracked);
  assert.equal(view.known.size, snapshot.entered.length);
});

// --- procedural genesis ----------------------------------------------------

test('a chunk is a pure function of its causes', () => {
  const a = generateChunk(1234, GENERATOR_VERSION, 5, -3);
  const b = generateChunk(1234, GENERATOR_VERSION, 5, -3);
  assert.equal(a.digest, b.digest);
  assert.deepEqual(Array.from(a.biome), Array.from(b.biome));
});

test('changing any cause changes the consequence', () => {
  const base = generateChunk(1234, GENERATOR_VERSION, 5, -3);
  assert.notEqual(generateChunk(1235, GENERATOR_VERSION, 5, -3).digest, base.digest, 'seed');
  assert.notEqual(generateChunk(1234, GENERATOR_VERSION + 1, 5, -3).digest, base.digest, 'generator version');
  assert.notEqual(generateChunk(1234, GENERATOR_VERSION, 6, -3).digest, base.digest, 'coordinate');
});

test('neighbouring chunks agree along their shared edge', () => {
  const left = generateChunk(77, GENERATOR_VERSION, 0, 0);
  const right = generateChunk(77, GENERATOR_VERSION, 1, 0);
  const size = left.size;
  // The lattice is global, so the right edge of one chunk continues into the next.
  const leftEdge = left.elevation[0 * size + (size - 1)];
  const rightEdge = right.elevation[0 * size + 0];
  assert.ok(Math.abs(leftEdge - rightEdge) < 0.2, 'no seam');
});

test('only divergence is persisted', () => {
  const chunk = generateChunk(77, GENERATOR_VERSION, 2, 2);
  const mutations = [
    { tick: 5, index: 100, op: 'raise', amount: 0.4 },
    { tick: 9, index: 101, op: 'flood', amount: 0.5 },
    { tick: 12, index: 102, op: 'paint', biome: 7 },
  ];
  const mutated = applyMutationLog(chunk, mutations);
  assert.equal(mutated.mutations, 3);
  assert.notEqual(mutated.digest, chunk.digest);
  assert.equal(mutated.biome[102], 7, 'an explicit paint survives reclassification');
  assert.equal(chunkDigest(chunk), chunk.digest, 'the generated chunk is untouched');

  // Order of application is by (tick, index), not by array order.
  const shuffled = applyMutationLog(chunk, [...mutations].reverse());
  assert.equal(shuffled.digest, mutated.digest);
});
