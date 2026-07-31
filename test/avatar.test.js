import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { GltfDocument, decomposeMatrix, parseGLB, readGltf } from '../src/core/gltf.js';
import {
  HUMANOID_BONES,
  REQUIRED_BONES,
  boneSide,
  buildRig,
  classifyBoneName,
  inferHumanoid,
  mapVisemes,
  normalizeBoneName,
} from '../src/core/humanoid.js';
import { childrenOf, descendantsOf, inspectSlot, installScene, slotPath } from '../src/core/scene.js';
import { findBones, importAvatarBytes, poseWalk } from '../src/demo/avatar.js';
import { createPandora } from '../src/demo/pandora.js';

const AVATAR = new URL('../assets/avatars/latticeborn-testbed.vrm', import.meta.url);

async function loadAvatarBytes() {
  const file = await readFile(AVATAR);
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
}

// --- container --------------------------------------------------------------

test('a GLB is rejected clearly when it is not one', () => {
  assert.throws(() => parseGLB(new ArrayBuffer(4)), /too short/);
  const notGlb = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).buffer;
  assert.throws(() => parseGLB(notGlb), /not a GLB/);
  assert.throws(() => readGltf(new TextEncoder().encode('hello').buffer), /not a glTF/);
});

test('a file that needs a decompressor we do not ship says so', () => {
  assert.throws(
    () => new GltfDocument({ asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'] }),
    /re-export without compression/,
  );
});

test('the test avatar is a well-formed GLB', async () => {
  const { json, binary } = parseGLB(await loadAvatarBytes());
  assert.equal(json.asset.version, '2.0');
  assert.ok(binary.byteLength > 1000, 'has a binary chunk');
  assert.ok(json.extensions.VRMC_vrm, 'declares VRM 1.0');
});

test('accessors decode, including interleaved and sparse', () => {
  // Two vec3s interleaved with padding, plus a sparse override of the second.
  const data = new Float32Array([1, 2, 3, 99, 4, 5, 6, 99]);
  const indices = new Uint16Array([1]);
  const values = new Float32Array([7, 8, 9]);
  const buffer = new ArrayBuffer(data.byteLength + 4 + values.byteLength);
  new Uint8Array(buffer).set(new Uint8Array(data.buffer), 0);
  new Uint8Array(buffer).set(new Uint8Array(indices.buffer), data.byteLength);
  new Uint8Array(buffer).set(new Uint8Array(values.buffer), data.byteLength + 4);

  const doc = new GltfDocument(
    {
      asset: { version: '2.0' },
      buffers: [{ byteLength: buffer.byteLength }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: data.byteLength, byteStride: 16 },
        { buffer: 0, byteOffset: data.byteLength, byteLength: 2 },
        { buffer: 0, byteOffset: data.byteLength + 4, byteLength: values.byteLength },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 2, type: 'VEC3' },
        {
          bufferView: 0,
          componentType: 5126,
          count: 2,
          type: 'VEC3',
          sparse: {
            count: 1,
            indices: { bufferView: 1, componentType: 5123 },
            values: { bufferView: 2 },
          },
        },
      ],
    },
    { binary: buffer },
  );

  assert.deepEqual([...doc.accessor(0).data], [1, 2, 3, 4, 5, 6], 'stride skips the padding');
  assert.deepEqual([...doc.accessor(1).data], [1, 2, 3, 7, 8, 9], 'sparse overrides one element');
});

test('normalized integer accessors come back as unit floats', () => {
  const bytes = new Uint8Array([255, 128, 0, 255]);
  const doc = new GltfDocument(
    {
      asset: { version: '2.0' },
      buffers: [{ byteLength: 4 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
      accessors: [{ bufferView: 0, componentType: 5121, count: 1, type: 'VEC4', normalized: true }],
    },
    { binary: bytes.buffer },
  );
  const floats = doc.floats(0);
  assert.ok(Math.abs(floats[0] - 1) < 1e-6);
  assert.ok(Math.abs(floats[2] - 0) < 1e-6);
});

test('a node matrix decomposes back to the TRS that made it', () => {
  const matrix = [0, 2, 0, 0, -3, 0, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1];
  const { translation, scale } = decomposeMatrix(matrix);
  assert.deepEqual(translation, [5, 6, 7]);
  assert.ok(Math.abs(scale[0] - 2) < 1e-6 && Math.abs(scale[1] - 3) < 1e-6 && Math.abs(scale[2] - 4) < 1e-6);
});

// --- rig --------------------------------------------------------------------

test('bone names normalize across every exporter convention', () => {
  assert.equal(normalizeBoneName('mixamorig:LeftForeArm'), 'leftforearm');
  assert.equal(normalizeBoneName('J_Bip_L_UpperArm'), 'l_upperarm'.replace('_', ''));
  assert.equal(normalizeBoneName('upper_arm.L'), 'upperarml');
  assert.equal(boneSide('LeftHand'), 'left');
  assert.equal(boneSide('hand.R'), 'right');
  assert.equal(boneSide('Spine'), null);
});

test('the same joint is recognized however it was named', () => {
  const cases = [
    ['mixamorig:LeftForeArm', 'leftLowerArm'],
    ['LeftLowerArm', 'leftLowerArm'],
    ['forearm.L', 'leftLowerArm'],
    ['RightUpperLeg', 'rightUpperLeg'],
    ['thigh.R', 'rightUpperLeg'],
    ['mixamorig:Hips', 'hips'],
    ['Spine2', 'chest'],
    ['Head', 'head'],
    ['LeftHandIndex1', 'leftIndexProximal'],
  ];
  for (const [name, expected] of cases) {
    assert.equal(classifyBoneName(name), expected, `${name} should be ${expected}`);
  }
});

test('a rig with no declaration is inferred from names, root joint winning', () => {
  const nodes = [
    { index: 0, name: 'Armature', parent: -1 },
    { index: 1, name: 'mixamorig:Hips', parent: 0 },
    { index: 2, name: 'mixamorig:LeftArm', parent: 1 },
    { index: 3, name: 'mixamorig:LeftArmTwist', parent: 2 },
    { index: 4, name: 'mixamorig:LeftForeArm', parent: 2 },
  ];
  const bones = inferHumanoid(nodes);
  assert.equal(bones.hips, 1);
  assert.equal(bones.leftUpperArm, 2, 'the twist helper does not steal the joint');
  assert.equal(bones.leftLowerArm, 4);
});

test('the test avatar declares a complete humanoid rig', async () => {
  const doc = readGltf(await loadAvatarBytes(), { name: 'testbed' });
  const rig = buildRig(doc);
  assert.equal(rig.confidence, 'declared');
  assert.deepEqual(rig.missing, []);
  assert.equal(rig.isHumanoid, true);
  for (const bone of REQUIRED_BONES) assert.ok(rig.bones[bone] !== undefined, `missing ${bone}`);
  assert.equal(Object.keys(rig.bones).length, HUMANOID_BONES.length, 'every canonical bone is present');
});

test('measurements are plausible for a human body', async () => {
  const doc = readGltf(await loadAvatarBytes(), { name: 'testbed' });
  const { measurements } = buildRig(doc);
  assert.ok(measurements.height > 1.5 && measurements.height < 2.0, `height ${measurements.height}`);
  assert.ok(measurements.eyeHeight < measurements.height, 'eyes are below the top of the head');
  assert.ok(measurements.eyeHeight > measurements.height * 0.9);
  // Arm span is measured along the chain, so an A-pose avatar still reports
  // roughly its height rather than the distance between its hands.
  assert.ok(measurements.armSpan > measurements.height * 0.7, `arm span ${measurements.armSpan}`);
  assert.ok(measurements.hipRatio > 0.45 && measurements.hipRatio < 0.62);
});

test('VRM metadata, expressions, and licence survive the parse', async () => {
  const doc = readGltf(await loadAvatarBytes(), { name: 'testbed' });
  const rig = buildRig(doc);
  assert.equal(rig.vrm.version, '1.0');
  assert.equal(rig.vrm.meta.name, 'Latticeborn Testbed');
  assert.equal(rig.vrm.meta.avatarPermission, 'everyone');
  assert.ok(rig.vrm.meta.license.includes('creativecommons'));
  assert.ok(rig.expressions.blink, 'blink is declared');
  const visemes = mapVisemes(rig, ['blink', 'aa', 'ih', 'ou', 'E', 'oh', 'happy']);
  for (const viseme of ['aa', 'ih', 'ou', 'E', 'oh']) {
    assert.ok(visemes[viseme], `viseme ${viseme} did not map`);
  }
});

// --- import into a world ----------------------------------------------------

test('importing produces slots and components, not an opaque asset', async () => {
  const world = createPandora({ seed: 5 });
  const instance = importAvatarBytes(world, await loadAvatarBytes(), { name: 'testbed' });

  assert.ok(instance.summary.slots > 50);
  assert.equal(instance.summary.confidence, 'declared');
  assert.equal(instance.summary.missingBones.length, 0);

  // Every bone is a slot in the hierarchy, reachable by path.
  const hand = instance.boneHandles.leftHand;
  assert.ok(hand, 'the hand is a slot');
  const path = slotPath(world, hand);
  assert.ok(path.includes('leftLowerArm/leftHand'), path);
  assert.ok(descendantsOf(world, instance.root).length >= 55);

  // And it is inspectable like anything else in the world.
  const inspected = inspectSlot(world, hand);
  assert.equal(inspected.name, 'leftHand');
  assert.ok(inspected.components.some((c) => c.name === 'LocalTransform'));
});

test('bones are recoverable from the world alone, without the importer', async () => {
  const world = createPandora({ seed: 5 });
  const instance = importAvatarBytes(world, await loadAvatarBytes(), { name: 'testbed' });
  const recovered = findBones(world, instance.root);
  assert.equal(Object.keys(recovered).length, Object.keys(instance.boneHandles).length);
  assert.equal(recovered.head, instance.boneHandles.head);
});

test('the transform system composes the skeleton', async () => {
  const world = createPandora({ seed: 5 });
  const instance = importAvatarBytes(world, await loadAvatarBytes(), {
    name: 'testbed',
    position: [10, 5, -3],
  });
  world.step();

  const head = world.ecs.get(instance.boneHandles.head, 'WorldTransform');
  const hips = world.ecs.get(instance.boneHandles.hips, 'WorldTransform');
  assert.ok(head.py > hips.py, 'the head is above the hips');
  assert.ok(Math.abs(head.px - 10) < 0.5, `head follows the root: ${head.px}`);
  assert.ok(Math.abs(head.pz + 3) < 0.5);

  // Moving the root moves everything under it.
  world.ecs.set(instance.root, 'LocalTransform', { px: 40 });
  world.step();
  assert.ok(Math.abs(world.ecs.get(instance.boneHandles.head, 'WorldTransform').px - 40) < 0.5);
});

test('scaling to a target eye height uses the eyes, not the scalp', async () => {
  const world = createPandora({ seed: 5 });
  const bytes = await loadAvatarBytes();
  const plain = importAvatarBytes(world, bytes, { name: 'a' });
  const scaled = importAvatarBytes(world, bytes, { name: 'b', targetEyeHeight: 2.6 });
  assert.ok(Math.abs(plain.summary.scale - 1) < 1e-9);
  const expected = 2.6 / plain.summary.measurements.eyeHeight;
  assert.ok(Math.abs(scaled.summary.scale - expected) < 1e-9);
});

test('a skinned mesh resolves its joints to slots at import time', async () => {
  const world = createPandora({ seed: 5 });
  const instance = importAvatarBytes(world, await loadAvatarBytes(), { name: 'testbed' });
  const assets = world.store('assets');
  let skinned = 0;
  for (const chunk of world.ecs.query(['SkinnedRenderer'])) {
    const skin = chunk.col('SkinnedRenderer', 'skin');
    const mesh = chunk.col('SkinnedRenderer', 'mesh');
    for (let i = 0; i < chunk.count; i++) {
      skinned++;
      const skinAsset = assets.get(skin[i]);
      assert.equal(skinAsset.kind, 'skin');
      assert.equal(skinAsset.value.joints.length, 55);
      assert.ok(skinAsset.value.joints.every((index) => index >= 0), 'every joint resolved');
      assert.equal(skinAsset.value.inverseBind.length, 55 * 16);
      const meshAsset = assets.get(mesh[i]);
      assert.ok(meshAsset.value.joints && meshAsset.value.weights, 'geometry carries skin attributes');
    }
  }
  assert.equal(skinned, 2, 'both primitives are skinned');
});

test('assets are shared, not duplicated, when the same file is imported twice', async () => {
  const world = createPandora({ seed: 5 });
  const bytes = await loadAvatarBytes();
  importAvatarBytes(world, bytes, { name: 'twin', sourceKey: 'same' });
  const after = world.store('assets').totals().count;
  importAvatarBytes(world, bytes, { name: 'twin', sourceKey: 'same' });
  assert.equal(world.store('assets').totals().count, after, 'the second import reuses every asset');
});

test('the import lands in the event log with its provenance', async () => {
  const world = createPandora({ seed: 5 });
  importAvatarBytes(world, await loadAvatarBytes(), { name: 'testbed' });
  const [event] = world.log.ofOperation('avatar.import');
  assert.ok(event);
  assert.equal(event.payload.bones, 55);
  assert.equal(event.payload.confidence, 'declared');
  assert.equal(event.payload.author, 'Latticeborn');
  assert.equal(event.payload.permission, 'everyone');
});

test('posing writes to bone transforms and nothing else', async () => {
  const world = createPandora({ seed: 5 });
  const instance = importAvatarBytes(world, await loadAvatarBytes(), { name: 'testbed' });
  const bones = findBones(world, instance.root);
  const before = world.ecs.get(bones.leftUpperLeg, 'LocalTransform');
  poseWalk(world, bones, { phase: 1.2, speed: 7, grounded: 1 });
  const after = world.ecs.get(bones.leftUpperLeg, 'LocalTransform');
  assert.notEqual(after.rx, before.rx, 'the leg rotated');
  assert.equal(after.px, before.px, 'the leg did not move off its joint');
});

test('the scene graph is checkpointed with the world', async () => {
  const world = createPandora({ seed: 5 });
  const instance = importAvatarBytes(world, await loadAvatarBytes(), { name: 'testbed' });
  world.step();
  const checkpoint = world.checkpoint();
  const hash = world.hash();
  const path = slotPath(world, instance.boneHandles.leftHand);

  world.ecs.set(instance.root, 'LocalTransform', { px: 999 });
  world.step();
  assert.notEqual(world.hash(), hash);

  world.load(checkpoint);
  assert.equal(world.hash(), hash);
  assert.equal(slotPath(world, instance.boneHandles.leftHand), path, 'slot names survived');
  assert.equal(Object.keys(findBones(world, instance.root)).length, 55, 'bone tags survived');
});

test('installing the scene graph twice is a no-op', () => {
  const world = createPandora({ seed: 5 });
  installScene(world);
  const before = world.scheduler.systems.length;
  installScene(world);
  assert.equal(world.scheduler.systems.length, before);
});

test('a slot tree can be walked and counted', async () => {
  const world = createPandora({ seed: 5 });
  const instance = importAvatarBytes(world, await loadAvatarBytes(), { name: 'testbed' });
  const top = childrenOf(world, instance.root);
  assert.equal(top.length, 1, 'the file has one scene root');
  assert.ok(childrenOf(world, top[0]).length >= 2, 'which holds the skeleton and the body');
});
