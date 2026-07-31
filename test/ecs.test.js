import assert from 'node:assert/strict';
import test from 'node:test';

import { Ecs, Registry } from '../src/core/ecs.js';
import { handleIndex } from '../src/core/ids.js';

function fixture() {
  const registry = new Registry();
  registry.define('Position', { x: 'f64', y: 'f64' });
  registry.define('Velocity', { x: 'f64', y: 'f64' });
  registry.define('Tag', {});
  return { registry, ecs: new Ecs(registry) };
}

test('entities carry identity independent of their components', () => {
  const { ecs } = fixture();
  const e = ecs.create({ Position: { x: 1, y: 2 } });
  assert.equal(ecs.alive(e), true);
  assert.deepEqual(ecs.get(e, 'Position'), { x: 1, y: 2 });

  ecs.add(e, 'Velocity', { x: 3, y: 4 });
  assert.deepEqual(ecs.get(e, 'Position'), { x: 1, y: 2 }, 'archetype move preserves existing data');
  assert.deepEqual(ecs.componentsOf(e).sort(), ['Position', 'Velocity']);

  ecs.remove(e, 'Position');
  assert.equal(ecs.get(e, 'Position'), null);
  assert.deepEqual(ecs.get(e, 'Velocity'), { x: 3, y: 4 });
});

test('a recycled index never resolves through a stale handle', () => {
  const { ecs } = fixture();
  const first = ecs.create({ Position: { x: 1, y: 1 } });
  ecs.destroy(first);
  const second = ecs.create({ Position: { x: 9, y: 9 } });
  assert.equal(handleIndex(first), handleIndex(second), 'the index is reused');
  assert.notEqual(first, second, 'the generation is not');
  assert.equal(ecs.alive(first), false);
  assert.equal(ecs.alive(second), true);
});

test('queries only visit archetypes that carry every requested component', () => {
  const { ecs } = fixture();
  ecs.create({ Position: { x: 0, y: 0 } });
  const moving = ecs.create({ Position: { x: 5, y: 5 }, Velocity: { x: 1, y: 0 } });
  ecs.create({ Velocity: { x: 2, y: 2 } });

  const seen = [];
  ecs.each(['Position', 'Velocity'], (handle) => seen.push(handle));
  assert.deepEqual(seen, [moving]);

  let positions = 0;
  for (const chunk of ecs.query(['Position'])) positions += chunk.count;
  assert.equal(positions, 2);
});

test('tag components store no data but still partition archetypes', () => {
  const { ecs } = fixture();
  const tagged = ecs.create({ Position: { x: 0, y: 0 }, Tag: {} });
  ecs.create({ Position: { x: 1, y: 1 } });
  assert.deepEqual(ecs.get(tagged, 'Tag'), {});
  let count = 0;
  ecs.each(['Tag'], () => count++);
  assert.equal(count, 1);
});

test('rows stay sorted by entity index so iteration order is canonical', () => {
  const { ecs } = fixture();
  const handles = [];
  for (let i = 0; i < 64; i++) handles.push(ecs.create({ Position: { x: i, y: 0 } }));
  // Churn hard: destroy scattered entities, then refill from the free list.
  for (let i = 0; i < 64; i += 3) ecs.destroy(handles[i]);
  for (let i = 0; i < 12; i++) ecs.create({ Position: { x: -i, y: 0 } });
  for (let i = 1; i < 64; i += 7) ecs.destroy(handles[i]);
  assert.equal(ecs.isCanonical(), true);

  const order = [];
  ecs.each(['Position'], (handle) => order.push(handleIndex(handle)));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('snapshot round-trips exactly and does not perturb the source world', () => {
  const { registry, ecs } = fixture();
  const handles = [];
  for (let i = 0; i < 40; i++) handles.push(ecs.create({ Position: { x: i, y: i * 2 } }));
  for (let i = 0; i < 40; i += 4) ecs.destroy(handles[i]);
  for (let i = 1; i < 40; i += 4) ecs.add(handles[i], 'Velocity', { x: i, y: -i });

  const before = ecs.digest();
  const snapshot = ecs.snapshot();
  assert.equal(ecs.digest(), before, 'snapshotting is an observation, not a mutation');

  const restored = Ecs.restore(registry, snapshot);
  assert.equal(restored.digest(), before);
  assert.equal(restored.entityCount, ecs.entityCount);
  assert.equal(restored.isCanonical(), true);

  // The restored world must allocate the same identities the original would.
  const a = ecs.create({ Position: { x: 0, y: 0 } });
  const b = restored.create({ Position: { x: 0, y: 0 } });
  assert.equal(a, b);
});

test('a checkpoint is a photograph, not a window', () => {
  const { registry, ecs } = fixture();
  ecs.create({ Position: { x: 1, y: 1 } });
  const snapshot = ecs.snapshot();
  const digestAtCapture = Ecs.restore(registry, snapshot).digest();
  ecs.create({ Position: { x: 2, y: 2 } });
  assert.equal(Ecs.restore(registry, snapshot).digest(), digestAtCapture);
});

test('the registry refuses unknown components and unknown fields', () => {
  const { ecs } = fixture();
  const e = ecs.create({ Position: { x: 0, y: 0 } });
  assert.throws(() => ecs.add(e, 'Nonexistent'), /unknown component/);
  assert.throws(() => ecs.set(e, 'Position', { z: 1 }), /no field/);
});
