import assert from 'node:assert/strict';
import test from 'node:test';

import { RegionMemory, RegionState, TRAIL_HALF_LIFE } from '../src/core/regions.js';
import { SEA_LEVEL, TERRAIN_GLSL, biomeAt, heightAt, normalAt } from '../src/core/terrain.js';
import { avatarState, createPandora, findLanding, regionContents } from '../src/demo/pandora.js';

const SEED = 771;

/**
 * Walk the avatar along a bearing, veering away from deep water and then
 * settling back onto course. Without the correction the avoidance alone turns
 * it in slow circles and it never actually gets anywhere.
 */
function walk(world, ticks, bearing = 0.6, options = {}) {
  let yaw = bearing;
  for (let t = 0; t < ticks; t++) {
    const state = avatarState(world);
    if (state.ground < 1.5) yaw += 0.08;
    else yaw += (bearing - yaw) * 0.04;
    world.submit({ op: 'avatar.intent', actor: 'test', payload: { forward: 1, yaw, sprint: options.sprint ?? false } });
    world.step();
  }
  return avatarState(world);
}

// --- terrain ---------------------------------------------------------------

test('terrain is a pure function of position and seed', () => {
  assert.equal(heightAt(120.5, -80.25, SEED), heightAt(120.5, -80.25, SEED));
  assert.notEqual(heightAt(120.5, -80.25, SEED), heightAt(120.5, -80.25, SEED + 1));
  assert.notEqual(heightAt(120.5, -80.25, SEED), heightAt(121.5, -80.25, SEED));
});

test('terrain is continuous — no cliffs between adjacent samples', () => {
  let worst = 0;
  for (let i = 0; i < 400; i++) {
    const x = i * 3.7 - 700;
    const z = Math.sin(i) * 300;
    worst = Math.max(worst, Math.abs(heightAt(x, z, SEED) - heightAt(x + 0.5, z, SEED)));
  }
  assert.ok(worst < 4, `worst 0.5m step was ${worst.toFixed(2)}m`);
});

test('normals agree with the height field they came from', () => {
  for (const [x, z] of [[10, 10], [-320, 88], [1200, -900]]) {
    const n = normalAt(x, z, SEED);
    assert.ok(Math.abs(Math.hypot(n.x, n.y, n.z) - 1) < 1e-9, 'unit length');
    assert.ok(n.y > 0, 'a height field never overhangs');
    // Walking uphill along -gradient must actually gain height.
    const step = 0.5;
    const uphill = heightAt(x - n.x * step, z - n.z * step, SEED);
    if (Math.hypot(n.x, n.z) > 0.02) assert.ok(uphill >= heightAt(x, z, SEED) - 1e-6);
  }
});

test('the GLSL twin declares the same functions as the JavaScript', () => {
  for (const name of ['hash2i', 'hashUnit2', 'valueNoise', 'fbm', 'ridged', 'heightAt', 'normalAt']) {
    assert.ok(TERRAIN_GLSL.includes(`${name}(`), `GLSL is missing ${name}`);
  }
  // The constants the shader bakes in must be the ones the simulation uses.
  assert.ok(TERRAIN_GLSL.includes(`const float SEA_LEVEL = ${SEA_LEVEL.toFixed(1)};`));
});

test('biomes follow altitude and slope', () => {
  const found = new Set();
  for (let i = 0; i < 4000; i++) {
    const x = (i % 100) * 31 - 1500;
    const z = Math.floor(i / 100) * 41 - 800;
    found.add(biomeAt(x, z, SEED));
  }
  assert.ok(found.size >= 4, `only found biomes ${[...found].join(',')}`);
});

// --- region memory ---------------------------------------------------------

test('an unwitnessed region costs nothing', () => {
  const memory = new RegionMemory({ seed: SEED, size: 100 });
  assert.equal(memory.stateOf(4, 4), RegionState.LATENT);
  assert.equal(memory.get(4, 4), null);
  assert.equal(memory.totals().known, 0);
  assert.deepEqual(memory.resolve(4, 4, 0), []);
});

test('witnessing a region starts its history; leaving keeps it', () => {
  const memory = new RegionMemory({ seed: SEED, size: 100 });
  const { returning } = memory.observe(2, 3, 10);
  assert.equal(returning, false);
  assert.equal(memory.stateOf(2, 3), RegionState.RESIDENT);

  memory.record(2, 3, { tick: 12, op: 'trail', x: 250, z: 350, intensity: 1 });
  memory.record(2, 3, { tick: 14, op: 'harvest', slot: 7 });
  memory.release(2, 3, 20);
  assert.equal(memory.stateOf(2, 3), RegionState.REMEMBERED);
  assert.equal(memory.resolve(2, 3, 20).length, 2, 'the log survives the release');

  const second = memory.observe(2, 3, 900);
  assert.equal(second.returning, true);
  assert.equal(second.region.observations, 2);
  assert.equal(second.region.firstObserved, 10, 'first contact is not overwritten');
});

test('memory fades on a deterministic curve, identically for every observer', () => {
  const memory = new RegionMemory({ seed: SEED, size: 100 });
  memory.observe(0, 0, 0);
  memory.record(0, 0, { tick: 0, op: 'trail', x: 1, z: 1, intensity: 1 });

  const fresh = memory.resolve(0, 0, 0)[0].intensity;
  const halved = memory.resolve(0, 0, TRAIL_HALF_LIFE)[0].intensity;
  assert.ok(Math.abs(fresh - 1) < 1e-9);
  assert.ok(Math.abs(halved - 0.5) < 1e-9);
  assert.equal(memory.resolve(0, 0, TRAIL_HALF_LIFE * 8).length, 0, 'illegible marks drop out');
  assert.equal(memory.resolve(0, 0, 500)[0].intensity, memory.resolve(0, 0, 500)[0].intensity);
});

test('finite memory forgets the least recently witnessed region', () => {
  const memory = new RegionMemory({ seed: SEED, size: 100, capacity: 3 });
  for (let i = 0; i < 6; i++) {
    memory.observe(i, 0, i * 10);
    memory.record(i, 0, { tick: i * 10, op: 'trail', x: i, z: 0 });
    memory.release(i, 0, i * 10 + 1);
  }
  assert.equal(memory.remembered().length, 3);
  assert.equal(memory.stats.forgotten, 3);
  assert.equal(memory.stateOf(0, 0), RegionState.LATENT, 'the oldest is gone entirely');
  assert.equal(memory.stateOf(5, 0), RegionState.REMEMBERED);
});

test('region memory round-trips through a checkpoint', () => {
  const memory = new RegionMemory({ seed: SEED, size: 100 });
  memory.observe(1, 1, 5);
  memory.record(1, 1, { tick: 6, op: 'bloom', slot: 3 });
  memory.release(1, 1, 9);
  const restored = RegionMemory.fromJSON(memory.toJSON());
  assert.equal(restored.digest(), memory.digest());
  assert.equal(restored.stateOf(1, 1), RegionState.REMEMBERED);
});

// --- the world -------------------------------------------------------------

test('the avatar wakes somewhere it can stand', () => {
  const landing = findLanding(SEED);
  assert.ok(landing.y > SEA_LEVEL, 'above water');
  assert.ok(normalAt(landing.x, landing.z, SEED).y > 0.8, 'not on a cliff');

  const world = createPandora({ seed: SEED });
  const state = avatarState(world);
  assert.ok(Math.abs(state.position.y - state.ground - 2.6) < 0.3, 'feet on the ground');
  assert.equal(state.grounded, 1);
});

test('a region resolves to the same contents every time it is witnessed', () => {
  const world = createPandora({ seed: SEED });
  const a = regionContents(world, 3, -2);
  const b = regionContents(world, 3, -2);
  assert.deepEqual(a.flora, b.flora);
  assert.deepEqual(a.fauna, b.fauna);
  assert.ok(a.flora.length > 0);
  for (const plant of a.flora) {
    assert.ok(heightAt(plant.x, plant.z, world.seed) >= SEA_LEVEL, 'nothing roots in the sea');
  }
});

test('walking witnesses regions and lays down a trail', () => {
  const world = createPandora({ seed: SEED });
  const memory = world.store('regions');
  const before = memory.totals();
  walk(world, 900);
  const after = memory.totals();

  assert.ok(after.known > before.known, 'new ground was witnessed');
  assert.ok(after.trail > 10, `expected footfalls, got ${after.trail}`);
  assert.ok(world.log.ofOperation('region.witness').length > 0);
  assert.ok(
    after.bytesRemembered < after.bytesIfMaterialized / 100,
    'history is orders of magnitude smaller than state',
  );
});

test('a region that scrolls out of range is released but not forgotten', () => {
  // Tighter horizons so the test does not depend on how far a walk gets before
  // it meets a coastline. The mechanism under test is residency, not stamina.
  const world = createPandora({ seed: SEED, viewRadius: 120, keepRadius: 190 });
  const memory = world.store('regions');
  const home = memory.coordOf(avatarState(world).position.x, avatarState(world).position.z);
  walk(world, 300);
  const firstMarks = memory.get(home.cx, home.cy).mutations.map((m) => `${m.tick}:${m.op}`);
  const firstObserved = memory.get(home.cx, home.cy).firstObserved;
  assert.ok(firstMarks.length > 0, 'the avatar left marks at home');

  const away = walk(world, 3000, 2.4, { sprint: true });
  const center = memory.centerOf(home.cx, home.cy);
  assert.ok(
    Math.hypot(away.position.x - center.x, away.position.z - center.z) > world.config.keepRadius,
    'the avatar actually left',
  );
  assert.equal(memory.stateOf(home.cx, home.cy), RegionState.REMEMBERED);
  assert.ok(world.log.ofOperation('region.release').length > 0);
  // The log is append-only: everything written before the departure is still
  // there afterwards, alongside whatever the walk out added.
  const afterMarks = memory.get(home.cx, home.cy).mutations.map((m) => `${m.tick}:${m.op}`);
  for (const mark of firstMarks) assert.ok(afterMarks.includes(mark), `lost ${mark}`);
  assert.equal(memory.get(home.cx, home.cy).firstObserved, firstObserved);

  // Nothing from a released region is still simulated.
  for (const chunk of world.ecs.query(['Region'])) {
    const cx = chunk.col('Region', 'cx');
    const cy = chunk.col('Region', 'cy');
    for (let i = 0; i < chunk.count; i++) {
      assert.ok(cx[i] !== home.cx || cy[i] !== home.cy, 'released regions leave no entities behind');
    }
  }
});

test('what you take stays taken, across a release and a recall', () => {
  const world = createPandora({ seed: SEED });
  const memory = world.store('regions');
  walk(world, 600);

  const state = avatarState(world);
  world.submit({ op: 'world.harvest', actor: 'test', payload: { x: state.position.x, z: state.position.z, radius: 60 } });
  world.step();

  assert.equal(world.log.ofOperation('flora.harvest').length, 1, 'a plant was taken');
  // The plant belongs to its own region, which need not be the one the avatar
  // is standing in — so ask every resident region who wrote it down.
  const written = memory
    .residents()
    .flatMap((r) => memory.resolve(r.cx, r.cy, world.tick, 'harvest').map((m) => ({ ...m, cx: r.cx, cy: r.cy })));
  assert.equal(written.length, 1, 'exactly one region wrote it down');
  const gap = written[0];

  // Release and re-materialize that region: the gap must survive the round trip.
  memory.release(gap.cx, gap.cy, world.tick);
  const { region } = memory.observe(gap.cx, gap.cy, world.tick);
  const contents = regionContents(world, gap.cx, gap.cy);
  assert.ok(contents.flora.some((plant) => plant.slot === gap.slot), 'default reality still contains it');
  const harvested = new Set(
    memory.resolve(region.cx, region.cy, world.tick, 'harvest').map((m) => m.slot),
  );
  assert.ok(harvested.has(gap.slot), 'and the divergence still says it is gone');
});

test('the whole world — region memory included — survives a checkpoint', () => {
  const world = createPandora({ seed: SEED });
  walk(world, 500);
  world.submit({ op: 'world.beacon', actor: 'test', payload: { x: avatarState(world).position.x, z: avatarState(world).position.z } });
  world.step();

  const checkpoint = world.checkpoint();
  const hash = world.hash();
  const remembered = world.store('regions').totals();

  walk(world, 300);
  assert.notEqual(world.hash(), hash);

  world.load(checkpoint);
  assert.equal(world.hash(), hash);
  assert.deepEqual(world.store('regions').totals(), remembered);
});

test('a play session replays from a checkpoint and its commands', () => {
  const world = createPandora({ seed: SEED });
  walk(world, 120);
  const checkpoint = world.checkpoint();
  const from = world.tick;
  walk(world, 300, 1.1);
  const expected = world.hash();

  const commands = world.log.between(from, world.tick).filter((e) => e.class === 'command');
  const replay = createPandora({ seed: SEED });
  replay.load(checkpoint);
  const byTick = new Map();
  for (const event of commands) {
    if (!byTick.has(event.tick)) byTick.set(event.tick, []);
    byTick.get(event.tick).push(event);
  }
  while (replay.tick < world.tick) {
    for (const event of byTick.get(replay.tick) ?? []) {
      replay.submit({ op: event.operation, actor: event.actor, payload: event.payload });
    }
    replay.step();
  }
  assert.equal(replay.hash(), expected, 'the same inputs reproduce the same walk');
});

test('appearance is world state, not a client setting', () => {
  const world = createPandora({ seed: SEED });
  const before = world.hash();
  world.submit({ op: 'avatar.customize', actor: 'test', payload: { height: 1.2, glowHue: 0.9 } });
  world.step();
  const state = avatarState(world);
  assert.ok(Math.abs(state.appearance.height - 1.2) < 1e-6);
  assert.notEqual(world.hash(), before);
  assert.equal(world.log.ofOperation('avatar.customize').length, 1);
});
