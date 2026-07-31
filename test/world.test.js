import assert from 'node:assert/strict';
import test from 'node:test';

import { World, createTestbed, testbedOptions } from '../src/index.js';
import { COUNTERFACTUAL, SCRIPT, driveScript } from '../src/demo/scenario.js';

const SEED = 4242;

function advance(world, ticks) {
  for (let t = 0; t < ticks; t++) {
    driveScript(world, SCRIPT);
    world.step();
  }
  return world;
}

test('same causes produce the same world, computed independently', () => {
  const a = advance(createTestbed({ seed: SEED }), 400);
  const b = advance(createTestbed({ seed: SEED }), 400);
  assert.equal(a.hash(), b.hash());
  assert.equal(a.ecs.entityCount, b.ecs.entityCount);
  assert.equal(a.log.digest, b.log.digest, 'the event history is identical too');
});

test('different seeds produce different worlds', () => {
  const a = advance(createTestbed({ seed: SEED }), 200);
  const b = advance(createTestbed({ seed: SEED + 1 }), 200);
  assert.notEqual(a.hash(), b.hash());
});

test('a checkpoint plus recorded commands reconstructs the present', () => {
  const live = createTestbed({ seed: SEED });
  let checkpoint = null;
  for (let t = 0; t < 500; t++) {
    driveScript(live, SCRIPT);
    live.step();
    if (live.tick === 150) checkpoint = live.checkpoint();
  }

  const commands = live.log.between(150, 500).filter((e) => e.class === 'command');
  const replayed = World.replay({ checkpoint, commands, toTick: 500, options: testbedOptions({ seed: SEED }) });

  assert.equal(replayed.tick, live.tick);
  assert.equal(replayed.hash(), live.hash());
});

test('checkpoints stop tracking the world once taken', () => {
  const world = createTestbed({ seed: SEED });
  advance(world, 100);
  const checkpoint = world.checkpoint();
  const capturedTick = checkpoint.tick;
  const capturedHash = checkpoint.hash;
  const capturedEdges = checkpoint.graph.edges.length;

  advance(world, 200);
  assert.equal(checkpoint.tick, capturedTick);
  assert.equal(checkpoint.graph.edges.length, capturedEdges);

  const restored = createTestbed({ seed: SEED });
  restored.load(checkpoint);
  assert.equal(restored.hash(), capturedHash);
});

test('rollback: rewind, resimulate, converge', () => {
  const live = createTestbed({ seed: SEED });
  let checkpoint = null;
  for (let t = 0; t < 400; t++) {
    driveScript(live, SCRIPT);
    live.step();
    if (live.tick === 120) checkpoint = live.checkpoint();
  }
  const rolled = createTestbed({ seed: SEED });
  rolled.load(checkpoint);
  for (let t = 120; t < 400; t++) {
    driveScript(rolled, SCRIPT);
    rolled.step();
  }
  assert.equal(rolled.hash(), live.hash());
});

test('a fork diverges without touching its parent', () => {
  const parent = advance(createTestbed({ seed: SEED }), 300);
  const parentHash = parent.hash();

  const branch = parent.fork('u1', { label: 'counterfactual' });
  assert.equal(parent.hash(), parentHash, 'forking is an observation of the parent');
  assert.equal(branch.lineage.parent.universe, 'u0');
  assert.equal(branch.lineage.forkTick, 300);
  assert.equal(branch.universe, 'u1');

  for (const entry of COUNTERFACTUAL) branch.submit({ op: entry.op, actor: 'operator', payload: entry.payload });
  for (let t = 0; t < 120; t++) {
    branch.step();
    driveScript(parent, SCRIPT);
    parent.step();
  }
  assert.notEqual(branch.hash(), parent.hash());

  // The branch owns its own identities: no entity key leaks across universes.
  for (const edge of branch.graph.edges) {
    assert.equal(edge.s.startsWith('u0#'), false);
    assert.equal(edge.o.startsWith('u0#'), false);
  }
});

test('a fork with no divergent input evolves exactly like its parent', () => {
  const parent = advance(createTestbed({ seed: SEED }), 200);
  const twin = parent.fork('u2', { label: 'twin' });
  for (let t = 0; t < 100; t++) {
    twin.step();
    parent.step();
  }
  // Identical state, different universes — so only the universe id differs.
  assert.equal(twin.ecs.digest(), parent.ecs.digest());
  assert.equal(twin.field('heat').digest(), parent.field('heat').digest());
});

test('the event log seals its own history', () => {
  const world = advance(createTestbed({ seed: SEED }), 200);
  assert.equal(world.log.verify().ok, true);

  world.log.events[10].payload = { tampered: true };
  assert.equal(world.log.verify().ok, false);
});

test('events carry causality that can be walked backwards', () => {
  const world = advance(createTestbed({ seed: SEED }), 700);
  const birth = world.log.ofOperation('agent.begat')[0];
  assert.ok(birth, 'the grove reproduces');
  assert.ok(birth.actor && birth.target);
  assert.equal(world.graph.query({ s: birth.actor, p: 'BEGAT', o: birth.target }).length, 1);
});

test('a checkpoint cannot be loaded into a world with a different schema', () => {
  const world = advance(createTestbed({ seed: SEED }), 50);
  const checkpoint = world.checkpoint();
  const alien = createTestbed({ seed: SEED });
  alien.registry.define('Ghost', { presence: 'f64' });
  assert.throws(() => alien.load(checkpoint), /schema/);
});

test('commands are inert until a tick applies them', () => {
  const world = createTestbed({ seed: SEED });
  advance(world, 10);
  const before = world.hash();
  world.submit({ op: 'world.ignite', payload: { x: 100, y: 100, radius: 40, amount: 30 } });
  assert.equal(world.hash(), before, 'submitting is not applying');
  world.step();
  assert.notEqual(world.hash(), before);
  assert.equal(world.log.ofOperation('world.ignite').length, 1);
});
