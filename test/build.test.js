import assert from 'node:assert/strict';
import test from 'node:test';

import { PRIMITIVES, makePrimitive } from '../src/core/primitives.js';
import {
  FluxGraph,
  NODES,
  attachGraph,
  evaluateGraph,
  installFlux,
  runFluxGraphs,
} from '../src/core/protoflux.js';
import {
  builtSlots,
  exportItem,
  heldSlots,
  importItem,
  installBuild,
  intersectAABB,
  raycastSlots,
  spawnPrimitive,
} from '../src/demo/build.js';
import { childrenOf, descendantsOf, slotName } from '../src/core/scene.js';
import { avatarState, createPandora } from '../src/demo/pandora.js';
import { handleIndex } from '../src/core/ids.js';

function buildWorld() {
  const world = createPandora({ seed: 11 });
  installBuild(world);
  return world;
}

function spawnInFront(world, kind = 'box', extra = {}) {
  const state = avatarState(world);
  return spawnPrimitive(world, {
    kind,
    position: [state.position.x + 2, state.position.y, state.position.z],
    ...extra,
  });
}

// --- primitives -------------------------------------------------------------

test('every primitive builds a sane mesh', () => {
  for (const kind of PRIMITIVES) {
    const mesh = makePrimitive(kind);
    assert.ok(mesh.vertexCount > 3, `${kind} has vertices`);
    assert.ok(mesh.indices.length % 3 === 0, `${kind} is triangles`);
    assert.ok(mesh.indices.length > 0, `${kind} has faces`);
    assert.equal(mesh.normals.length, mesh.positions.length, `${kind} normals match positions`);
    assert.equal(mesh.uvs.length / 2, mesh.vertexCount, `${kind} has a uv per vertex`);
    for (const index of mesh.indices) {
      assert.ok(index < mesh.vertexCount, `${kind} index ${index} is in range`);
    }
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const length = Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]);
      assert.ok(Math.abs(length - 1) < 1e-3, `${kind} normal ${i / 3} is unit length`);
    }
    assert.ok(mesh.bounds.max[0] >= mesh.bounds.min[0]);
  }
});

test('primitive parameters change the geometry, and the descriptor rides along', () => {
  const small = makePrimitive('box', { width: 1, height: 1, depth: 1 });
  const tall = makePrimitive('box', { width: 1, height: 4, depth: 1 });
  assert.equal(tall.bounds.max[1] - tall.bounds.min[1], 4);
  assert.equal(small.bounds.max[1] - small.bounds.min[1], 1);
  assert.equal(tall.primitive.kind, 'box');
  assert.equal(tall.primitive.height, 4);
  assert.throws(() => makePrimitive('dodecahedron'), /unknown primitive/);
});

test('a cone is a cylinder with nothing on top', () => {
  const cone = makePrimitive('cone', { radius: 1, height: 2 });
  const top = cone.bounds.max[1];
  let widthAtTop = 0;
  for (let i = 0; i < cone.positions.length; i += 3) {
    if (Math.abs(cone.positions[i + 1] - top) < 1e-4) {
      widthAtTop = Math.max(widthAtTop, Math.hypot(cone.positions[i], cone.positions[i + 2]));
    }
  }
  assert.ok(widthAtTop < 1e-3, `cone tip is a point, not a disc of ${widthAtTop}`);
});

// --- spawning and picking ---------------------------------------------------

test('spawning makes a slot with geometry, and shares the mesh', () => {
  const world = buildWorld();
  const a = spawnInFront(world, 'sphere');
  const b = spawnInFront(world, 'sphere');
  assert.equal(slotName(world, a), 'sphere');
  assert.ok(world.ecs.has(a, 'MeshRenderer'));
  assert.ok(world.ecs.has(a, 'Grabbable'));
  assert.equal(
    world.ecs.get(a, 'MeshRenderer').mesh,
    world.ecs.get(b, 'MeshRenderer').mesh,
    'identical primitives share one mesh asset',
  );
  assert.equal(builtSlots(world).length, 2);
  assert.equal(world.log.ofOperation('slot.spawned').length, 2);
});

test('a ray finds the nearest thing it points at', () => {
  const world = buildWorld();
  const near = spawnPrimitive(world, { kind: 'box', position: [0, 100, 5], scale: 1 });
  const far = spawnPrimitive(world, { kind: 'box', position: [0, 100, 20], scale: 1 });
  world.step();

  const hit = raycastSlots(world, { x: 0, y: 100, z: 0 }, { x: 0, y: 0, z: 1 });
  assert.ok(hit, 'the ray hit something');
  assert.equal(hit.handle, near, 'and it was the near box');
  assert.ok(hit.distance > 4 && hit.distance < 5.1, `entry distance ${hit.distance}`);

  const ignoring = raycastSlots(world, { x: 0, y: 100, z: 0 }, { x: 0, y: 0, z: 1 }, { ignore: [near] });
  assert.equal(ignoring.handle, far);

  assert.equal(raycastSlots(world, { x: 0, y: 100, z: 0 }, { x: 0, y: 1, z: 0 }), null, 'nothing above');
});

test('the slab test agrees with itself', () => {
  const min = [-1, -1, -1];
  const max = [1, 1, 1];
  assert.equal(intersectAABB([0, 0, -5], [0, 0, 1], min, max), 4);
  assert.equal(intersectAABB([0, 0, 5], [0, 0, 1], min, max), null, 'facing away');
  assert.equal(intersectAABB([5, 5, 5], [0, 0, -1], min, max), null, 'misses');
  assert.equal(intersectAABB([0, 0, 0], [0, 0, 1], min, max), 0, 'starting inside');
});

// --- grabbing ---------------------------------------------------------------

test('a held object follows the grip and stops when released', () => {
  const world = buildWorld();
  const box = spawnInFront(world);
  world.submit({ op: 'build.grab', payload: { slot: handleIndex(box), distance: 3 } });
  world.step();

  assert.equal(heldSlots(world).length, 1);
  const state = avatarState(world);
  const held = world.ecs.get(box, 'LocalTransform');
  const distance = Math.hypot(held.px - state.position.x, held.py - state.position.y, held.pz - state.position.z);
  assert.ok(Math.abs(distance - 3) < 0.2, `held at ${distance} m`);

  // Walk, and it comes with you.
  for (let i = 0; i < 30; i++) {
    world.submit({ op: 'avatar.intent', payload: { forward: 1, yaw: 0.3 } });
    world.step();
  }
  const moved = world.ecs.get(box, 'LocalTransform');
  assert.notEqual(moved.px, held.px);

  world.submit({ op: 'build.release', payload: {} });
  world.step();
  assert.equal(heldSlots(world).length, 0);
  const dropped = world.ecs.get(box, 'LocalTransform');
  for (let i = 0; i < 30; i++) {
    world.submit({ op: 'avatar.intent', payload: { forward: 1, yaw: 0.3 } });
    world.step();
  }
  assert.equal(world.ecs.get(box, 'LocalTransform').px, dropped.px, 'a released object stays put');
});

test('adjusting a held object changes distance and scale within limits', () => {
  const world = buildWorld();
  const box = spawnInFront(world);
  world.submit({ op: 'build.grab', payload: { slot: handleIndex(box), distance: 3 } });
  world.step();
  world.submit({ op: 'build.adjust', payload: { distance: 4, scale: 2 } });
  world.step();
  const held = world.ecs.get(box, 'Held');
  assert.equal(held.distance, 7);
  assert.equal(held.scale, 2);

  world.submit({ op: 'build.adjust', payload: { distance: 1000, scale: 1000 } });
  world.step();
  const clamped = world.ecs.get(box, 'Held');
  assert.ok(clamped.distance <= 24, 'reach is bounded');
  assert.ok(clamped.scale <= 60, 'scale is bounded');
});

test('a locked slot refuses to be grabbed or deleted', () => {
  const world = buildWorld();
  const box = spawnInFront(world);
  world.ecs.set(box, 'Grabbable', { locked: 1 });
  world.submit({ op: 'build.grab', payload: { slot: handleIndex(box), distance: 3 } });
  world.step();
  assert.equal(heldSlots(world).length, 0);
  world.submit({ op: 'build.delete', payload: { slot: handleIndex(box) } });
  world.step();
  assert.equal(world.ecs.alive(box), true);
});

// --- duplicate, delete, undo ------------------------------------------------

test('duplicating copies the subtree and shares the assets', () => {
  const world = buildWorld();
  const parent = spawnInFront(world, 'box');
  const child = spawnPrimitive(world, { kind: 'sphere', position: [0, 1, 0] });
  world.ecs.set(child, 'Slot', { parent: handleIndex(parent), depth: 1 });

  world.submit({ op: 'build.duplicate', payload: { slot: handleIndex(parent) } });
  world.step();

  const copies = builtSlots(world).filter((handle) => slotName(world, handle).includes('copy'));
  assert.equal(copies.length, 1);
  const copy = copies[0];
  assert.equal(childrenOf(world, copy).length, 1, 'the child came too');
  assert.equal(
    world.ecs.get(copy, 'MeshRenderer').mesh,
    world.ecs.get(parent, 'MeshRenderer').mesh,
    'the copy shares the original mesh',
  );
});

test('deleting removes the subtree', () => {
  const world = buildWorld();
  const parent = spawnInFront(world);
  const child = spawnPrimitive(world, { kind: 'sphere' });
  world.ecs.set(child, 'Slot', { parent: handleIndex(parent), depth: 1 });
  const before = world.ecs.entityCount;

  world.submit({ op: 'build.delete', payload: { slot: handleIndex(parent) } });
  world.step();
  assert.equal(world.ecs.alive(parent), false);
  assert.equal(world.ecs.alive(child), false);
  assert.equal(world.ecs.entityCount, before - 2);
});

test('undo is time travel, and redo goes back forward', () => {
  const world = buildWorld();
  const before = world.hash();
  const beforeCount = world.ecs.entityCount;

  world.submit({ op: 'build.spawn', payload: { kind: 'box', position: [0, 100, 0] } });
  world.step();
  assert.equal(world.ecs.entityCount, beforeCount + 1);
  assert.notEqual(world.hash(), before);

  world.submit({ op: 'build.undo', payload: {} });
  world.step();
  assert.equal(world.ecs.entityCount, beforeCount, 'the box is gone');

  world.submit({ op: 'build.redo', payload: {} });
  world.step();
  assert.equal(world.ecs.entityCount, beforeCount + 1, 'and back again');
});

test('undo restores everything an edit touched, not just what it named', () => {
  const world = buildWorld();
  const box = spawnInFront(world);
  world.step();
  const restingPlace = { ...world.ecs.get(box, 'LocalTransform') };
  const avatarBefore = { ...avatarState(world).position };

  world.submit({ op: 'build.grab', payload: { slot: handleIndex(box), distance: 5 } });
  for (let i = 0; i < 20; i++) {
    world.submit({ op: 'avatar.intent', payload: { forward: 1, yaw: 1 } });
    world.step();
  }
  assert.ok(Math.hypot(world.ecs.get(box, 'LocalTransform').px - restingPlace.px) > 0.5, 'it moved');

  world.submit({ op: 'build.undo', payload: {} });
  world.step();

  // The grab is gone, the box is back, and so is the avatar that carried it —
  // nothing had to know that walking was part of the edit.
  assert.equal(heldSlots(world).length, 0, 'no longer held');
  const after = world.ecs.get(box, 'LocalTransform');
  assert.ok(Math.abs(after.px - restingPlace.px) < 0.01, `back at ${after.px} vs ${restingPlace.px}`);
  assert.ok(Math.abs(after.pz - restingPlace.pz) < 0.01);
  const avatarAfter = avatarState(world).position;
  // One tick of simulation runs after the restore, so allow a single step of drift.
  assert.ok(Math.hypot(avatarAfter.x - avatarBefore.x, avatarAfter.z - avatarBefore.z) < 0.3, 'the walk was undone too');
});

test('the undo stack is bounded and forgets its future after a new edit', () => {
  const world = buildWorld();
  const stack = world.store('undo');
  for (let i = 0; i < 40; i++) {
    world.submit({ op: 'build.spawn', payload: { kind: 'box', position: [i, 100, 0] } });
    world.step();
  }
  assert.ok(stack.past.length <= 24, `stack held ${stack.past.length}`);

  world.submit({ op: 'build.undo', payload: {} });
  world.step();
  assert.equal(stack.future.length, 1);
  world.submit({ op: 'build.spawn', payload: { kind: 'sphere', position: [0, 100, 0] } });
  world.step();
  assert.equal(stack.future.length, 0, 'a new edit forks away from the undone future');
});

// --- items ------------------------------------------------------------------

test('an item round-trips through export and import', () => {
  const world = buildWorld();
  const parent = spawnPrimitive(world, { kind: 'box', position: [0, 100, 0], scale: 2, palette: 2 });
  const child = spawnPrimitive(world, { kind: 'torus', position: [0, 1.5, 0] });
  world.ecs.set(child, 'Slot', { parent: handleIndex(parent), depth: 1 });
  world.store('scene').name(handleIndex(parent), 'lamp');

  const item = exportItem(world, parent);
  assert.equal(item.format, 'latticeborn.item');
  assert.equal(item.slots.length, 2);
  assert.equal(item.name, 'lamp');
  // Primitives travel as descriptors, so an item is small.
  assert.equal(item.slots[0].mesh.kind, 'primitive');
  assert.equal(item.slots[0].mesh.shape, 'box');
  assert.ok(JSON.stringify(item).length < 4000, 'an item is text, not a vertex buffer');

  const fresh = buildWorld();
  const root = importItem(fresh, item, { position: [5, 200, 5] });
  fresh.step();
  assert.equal(slotName(fresh, root), 'lamp');
  assert.equal(descendantsOf(fresh, root).length, 1);
  assert.ok(fresh.ecs.has(root, 'MeshRenderer'));
  const placed = fresh.ecs.get(root, 'WorldTransform');
  assert.equal(placed.px, 5);
  assert.equal(placed.py, 200);
  assert.equal(fresh.ecs.get(root, 'LocalTransform').sx, 2, 'scale survived');
});

test('pasting an item is a command like any other', () => {
  const world = buildWorld();
  const source = spawnPrimitive(world, { kind: 'capsule', position: [0, 100, 0] });
  const item = exportItem(world, source);
  world.submit({ op: 'build.paste', payload: { item, transform: { position: [9, 100, 9] } } });
  world.step();
  // The command is logged too; this is the consequence.
  const [event] = world.log.ofOperation('item.pasted');
  assert.ok(event);
  assert.equal(event.payload.slots, 1);
});

test('importing something that is not an item is refused', () => {
  const world = buildWorld();
  assert.throws(() => importItem(world, { format: 'something else' }), /not a latticeborn item/);
});

// --- flux -------------------------------------------------------------------

test('a graph evaluates its dataflow once per node', () => {
  const graph = new FluxGraph('maths');
  const four = graph.add('Float', { value: 4 });
  const doubled = graph.add('Multiply', { a: { node: four, output: 'value' }, b: 3 });
  graph.add('SetSlotPosition', { slot: 7, y: { node: doubled, output: 'value' } });

  const writes = [];
  const view = { read: () => ({}), write: (path, value) => writes.push([path, value]), emit: () => {} };
  const { evaluations } = evaluateGraph(graph, view);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1].y, 12);
  assert.equal(evaluations, 3);
});

test('a cycle is caught before it runs', () => {
  const graph = new FluxGraph('loop');
  const a = graph.add('Add', { a: 1 });
  const b = graph.add('Add', { a: { node: a, output: 'value' } });
  graph.connect(b, 'value', a, 'b');
  const validation = graph.validate();
  assert.equal(validation.ok, false);
  assert.equal(validation.problems[0].kind, 'cycle');
});

test('a graph declares the capabilities it needs', () => {
  const graph = new FluxGraph('spin');
  const time = graph.add('Time');
  graph.add('SetSlotSpin', { slot: 3, angle: { node: time, output: 'seconds' } });
  const capabilities = graph.capabilities();
  assert.deepEqual(capabilities.read, ['world.time']);
  assert.deepEqual(capabilities.write, ['slot.rotation']);
});

test('a graph drives a slot in a live world', () => {
  const world = buildWorld();
  installFlux(world);
  const box = spawnPrimitive(world, { kind: 'box', position: [0, 100, 0] });
  const index = handleIndex(box);

  const graph = new FluxGraph('bob');
  const time = graph.add('Time');
  const wave = graph.add('Sin', { value: { node: time, output: 'seconds' } });
  const height = graph.add('Add', { a: { node: wave, output: 'value' }, b: 100 });
  graph.add('SetSlotPosition', { slot: index, x: 0, y: { node: height, output: 'value' }, z: 0 });

  attachGraph(world, graph, { slots: [index] });
  const before = world.ecs.get(box, 'LocalTransform').py;
  for (let i = 0; i < 60; i++) world.step();
  const after = world.ecs.get(box, 'LocalTransform').py;
  assert.notEqual(after, before, 'the box moved');
  assert.ok(Math.abs(after - 100) <= 1.001, `and stayed within the sine's range: ${after}`);
});

test('a graph cannot touch a slot it was not given', () => {
  const world = buildWorld();
  installFlux(world);
  const mine = spawnPrimitive(world, { kind: 'box', position: [0, 100, 0] });
  const yours = spawnPrimitive(world, { kind: 'box', position: [5, 100, 0] });

  const graph = new FluxGraph('reach');
  graph.add('SetSlotPosition', { slot: handleIndex(yours), x: 0, y: 0, z: 0 });
  attachGraph(world, graph, { slots: [handleIndex(mine)] });

  const before = world.ecs.get(yours, 'LocalTransform').py;
  for (let i = 0; i < 20; i++) world.step();
  assert.equal(world.ecs.get(yours, 'LocalTransform').py, before, 'the other box never moved');
});

test('a graph that oversteps its grant is denied and eventually switched off', () => {
  const world = buildWorld();
  installFlux(world);
  const box = spawnPrimitive(world, { kind: 'box', position: [0, 100, 0] });

  const graph = new FluxGraph('nosy');
  const time = graph.add('Time');
  graph.add('SetSlotPosition', { slot: handleIndex(box), y: { node: time, output: 'seconds' } });
  // Admitted with permission to write, but not to read the clock it needs.
  const record = attachGraph(world, graph, { read: [], slots: [handleIndex(box)] });

  for (let i = 0; i < 60; i++) world.step();
  assert.ok(world.laws.violations.length > 0, 'the denial was recorded');
  assert.equal(record.enabled, false, 'and the graph stopped being invited');
});

test('a graph does not fight a person for a held object', () => {
  const world = buildWorld();
  installFlux(world);
  const box = spawnInFront(world);
  const index = handleIndex(box);
  const graph = new FluxGraph('grabby');
  graph.add('SetSlotPosition', { slot: index, x: 0, y: 500, z: 0 });
  attachGraph(world, graph, { slots: [index] });

  world.submit({ op: 'build.grab', payload: { slot: index, distance: 3 } });
  for (let i = 0; i < 20; i++) world.step();
  assert.ok(world.ecs.get(box, 'LocalTransform').py < 400, 'the person kept hold of it');
});

test('graphs serialize and come back', () => {
  const graph = new FluxGraph('saved');
  const time = graph.add('Time');
  graph.add('SetSlotScale', { slot: 4, scale: { node: time, output: 'seconds' } });
  const restored = FluxGraph.fromJSON(JSON.parse(JSON.stringify(graph.toJSON())));
  assert.equal(restored.nodes.length, 2);
  assert.deepEqual(restored.capabilities(), graph.capabilities());
  assert.throws(() => FluxGraph.fromJSON({ format: 'nope' }), /not a flux graph/);
});

test('the node library is coherent', () => {
  for (const [name, node] of Object.entries(NODES)) {
    assert.equal(node.name, name);
    assert.equal(typeof node.evaluate, 'function');
    if (node.impulse) assert.ok(node.writes.length > 0 || name === 'Say', `${name} impulse does something`);
    for (const spec of Object.values(node.inputs)) {
      assert.ok(spec.type, `${name} input has a type`);
    }
  }
});
