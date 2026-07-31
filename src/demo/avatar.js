// Importing an avatar.
//
// The import does not produce "an avatar object". It produces slots and
// components: one slot per node in the file, a renderer component on the ones
// that draw, mesh and material assets in the registry, and a tag on every bone
// saying which humanoid joint it is. Afterwards the avatar is not a special
// case — it is world state, and every tool that works on slots works on it.
//
// That is the whole difference between an engine that *loads* avatars and one
// you can take an avatar apart inside.

import { EventClass } from '../core/events.js';
import { buildRig, mapVisemes } from '../core/humanoid.js';
import { createSlot, descendantsOf, installScene, slotName } from '../core/scene.js';
import { fnv1a } from '../core/hash.js';
import { handleIndex } from '../core/ids.js';
import { readGltf } from '../core/gltf.js';

export const BONE_TAG = 'bone:';

/**
 * Turn a parsed glTF/VRM document into slots, components, and assets.
 *
 * Returns the instance record: root slot, bone handles, what was imported, and
 * whatever the file says about who is allowed to use it.
 */
export function importAvatar(world, doc, options = {}) {
  installScene(world);
  ensureAvatarComponents(world);

  const assets = world.store('assets');
  const scene = world.store('scene');
  const rig = buildRig(doc);
  const nodes = rig.nodes;
  const sourceKey = options.sourceKey ?? `${doc.name}:${doc.count('nodes')}:${doc.count('meshes')}`;

  // --- assets -------------------------------------------------------------
  const textureIds = (doc.json.textures ?? []).map((texture, index) => {
    const image = doc.image(texture.source);
    if (!image) return 0;
    return assets.add('texture', `${sourceKey}#tex${index}`, image, {
      name: image.name ?? `texture ${index}`,
      mimeType: image.mimeType,
      bytes: image.bytes?.length ?? 0,
    });
  });

  const materialIds = (doc.json.materials ?? []).map((material, index) => {
    const pbr = material.pbrMetallicRoughness ?? {};
    const value = {
      name: material.name ?? `material ${index}`,
      baseColor: pbr.baseColorFactor ?? [1, 1, 1, 1],
      baseColorTexture: pbr.baseColorTexture ? textureIds[pbr.baseColorTexture.index] ?? 0 : 0,
      metallic: pbr.metallicFactor ?? 1,
      roughness: pbr.roughnessFactor ?? 1,
      emissive: material.emissiveFactor ?? [0, 0, 0],
      doubleSided: Boolean(material.doubleSided),
      alphaMode: material.alphaMode ?? 'OPAQUE',
      alphaCutoff: material.alphaCutoff ?? 0.5,
      // Toon shading data rides along untouched; a renderer that understands
      // MToon can use it, and one that does not still has PBR to fall back on.
      mtoon: material.extensions?.VRMC_materials_mtoon ?? null,
      unlit: Boolean(material.extensions?.KHR_materials_unlit),
    };
    return assets.add('material', `${sourceKey}#mat${index}`, value, { name: value.name });
  });
  const defaultMaterial = assets.add('material', 'builtin:default', {
    name: 'default',
    baseColor: [0.8, 0.8, 0.85, 1],
    baseColorTexture: 0,
    metallic: 0,
    roughness: 0.8,
    emissive: [0, 0, 0],
    doubleSided: false,
    alphaMode: 'OPAQUE',
  }, { pinned: true });

  const meshIds = (doc.json.meshes ?? []).map((mesh, meshIndex) =>
    (mesh.primitives ?? []).map((primitive, primitiveIndex) => {
      const value = readPrimitive(doc, mesh, primitive);
      const id = assets.add('mesh', `${sourceKey}#mesh${meshIndex}.${primitiveIndex}`, value, {
        name: `${mesh.name ?? `mesh ${meshIndex}`}${(mesh.primitives.length > 1) ? `[${primitiveIndex}]` : ''}`,
        vertices: value.vertexCount,
        triangles: value.indices.length / 3,
        skinned: Boolean(value.joints),
        morphTargets: value.targets.length,
      });
      return { id, material: primitive.material !== undefined ? materialIds[primitive.material] : defaultMaterial };
    }),
  );

  // --- slots --------------------------------------------------------------
  const scale = resolveScale(rig, options);
  const position = options.position ?? [0, 0, 0];
  const rotation = options.rotation ?? [0, 0, 0, 1];
  const root = createSlot(world, {
    name: options.name ?? rig.vrm?.meta?.name ?? doc.name ?? 'Avatar',
    position,
    rotation,
    scale: [scale, scale, scale],
  });
  scene.tag(handleIndex(root), 'avatar');

  const boneOfNode = new Map();
  for (const [bone, node] of Object.entries(rig.bones)) boneOfNode.set(node, bone);

  const slots = new Map();
  const sceneRoots = doc.scene().nodes ?? [];
  const visit = (nodeIndex, parent) => {
    const node = nodes[nodeIndex];
    if (!node) return;
    const handle = createSlot(world, {
      name: node.name,
      parent,
      position: node.translation,
      rotation: node.rotation,
      scale: node.scale,
    });
    slots.set(nodeIndex, handle);
    const bone = boneOfNode.get(nodeIndex);
    if (bone) scene.tag(handleIndex(handle), `${BONE_TAG}${bone}`);

    if (node.mesh !== undefined && meshIds[node.mesh]) {
      for (const [primitiveIndex, entry] of meshIds[node.mesh].entries()) {
        const meshAsset = assets.get(entry.id);
        const skinned = meshAsset.value.joints && node.skin !== undefined;
        const child = meshIds[node.mesh].length === 1
          ? handle
          : createSlot(world, { name: `${node.name}[${primitiveIndex}]`, parent: handle });
        assets.retain(entry.id);
        assets.retain(entry.material);
        if (skinned) {
          world.ecs.add(child, 'SkinnedRenderer', {
            mesh: entry.id,
            material: entry.material,
            skin: node.skin,
            root: handleIndex(root),
            visible: 1,
          });
        } else {
          world.ecs.add(child, 'MeshRenderer', { mesh: entry.id, material: entry.material, layer: 0, visible: 1 });
        }
        scene.assetOf.set(handleIndex(child), entry.id);
      }
    }

    for (const child of node.children) visit(child, handle);
  };
  for (const nodeIndex of sceneRoots) visit(nodeIndex, root);

  // --- skins --------------------------------------------------------------
  // A skin is resolved to slot indices now, while the node -> slot map exists.
  // Entity indices are stable across checkpoints, so this survives a restore.
  const skinIds = (doc.json.skins ?? []).map((skin, index) => {
    const joints = skin.joints.map((nodeIndex) => {
      const handle = slots.get(nodeIndex);
      return handle === undefined ? -1 : handleIndex(handle);
    });
    const inverseBind = skin.inverseBindMatrices !== undefined
      ? doc.floats(skin.inverseBindMatrices)
      : identityBindMatrices(joints.length);
    return assets.add('skin', `${sourceKey}#skin${index}`, { joints, inverseBind }, {
      name: skin.name ?? `skin ${index}`,
      joints: joints.length,
      pinned: true,
    });
  });
  for (const chunk of world.ecs.query(['SkinnedRenderer'])) {
    const skinColumn = chunk.col('SkinnedRenderer', 'skin');
    const rootColumn = chunk.col('SkinnedRenderer', 'root');
    for (let i = 0; i < chunk.count; i++) {
      if (rootColumn[i] !== handleIndex(root)) continue;
      if (skinIds[skinColumn[i]] !== undefined) skinColumn[i] = skinIds[skinColumn[i]];
    }
  }

  // --- the rig ------------------------------------------------------------
  const boneHandles = {};
  for (const [bone, nodeIndex] of Object.entries(rig.bones)) {
    if (slots.has(nodeIndex)) boneHandles[bone] = slots.get(nodeIndex);
  }

  const morphNames = collectMorphNames(doc);
  const rigAsset = assets.add('rig', `${sourceKey}#rig`, {
    bones: rig.bones,
    source: rig.source,
    measurements: rig.measurements,
    expressions: rig.expressions,
    visemes: mapVisemes(rig, morphNames),
    morphNames,
    skins: (doc.json.skins ?? []).map((skin) => ({
      joints: skin.joints,
      inverseBindMatrices: skin.inverseBindMatrices !== undefined ? doc.floats(skin.inverseBindMatrices) : null,
      skeleton: skin.skeleton,
    })),
  }, { name: 'rig', pinned: true });

  world.ecs.add(root, 'AvatarRoot', {
    rig: rigAsset,
    height: rig.measurements.height ?? 1.7,
    eyeHeight: rig.measurements.eyeHeight ?? 1.6,
    scale,
    humanoid: rig.isHumanoid ? 1 : 0,
  });

  const licence = rig.vrm?.meta ?? null;
  const summary = {
    name: slotName(world, root),
    slots: slots.size + 1,
    bones: Object.keys(boneHandles).length,
    missingBones: rig.missing,
    confidence: rig.confidence,
    meshes: meshIds.flat().length,
    materials: materialIds.length,
    textures: textureIds.length,
    triangles: meshIds.flat().reduce((n, entry) => n + assets.get(entry.id).meta.triangles, 0),
    vertices: meshIds.flat().reduce((n, entry) => n + assets.get(entry.id).meta.vertices, 0),
    morphTargets: morphNames.length,
    visemes: Object.keys(mapVisemes(rig, morphNames)),
    measurements: rig.measurements,
    scale,
    licence,
  };

  world.emit({
    operation: 'avatar.import',
    class: EventClass.LIFECYCLE,
    target: `slot:${handleIndex(root)}`,
    payload: {
      name: summary.name,
      slots: summary.slots,
      bones: summary.bones,
      triangles: summary.triangles,
      confidence: summary.confidence,
      author: licence?.authors?.join(', ') ?? 'unknown',
      permission: licence?.avatarPermission ?? 'unstated',
    },
  });

  // The file's own terms, surfaced rather than buried. An engine that silently
  // ignores `avatarPermission: onlyAuthor` is training its users to ignore it.
  if (licence && licence.avatarPermission && licence.avatarPermission !== 'everyone') {
    world.emit({
      operation: 'avatar.licence',
      class: EventClass.NARRATIVE,
      target: `slot:${handleIndex(root)}`,
      payload: {
        text: `${licence.name} may be worn by: ${licence.avatarPermission}`,
        authors: licence.authors?.join(', ') ?? '',
        license: licence.license ?? '',
      },
    });
  }

  return { root, rig, rigAsset, boneHandles, slots, summary };
}

/** Import from raw bytes — what a drag-and-drop or a file read hands you. */
export function importAvatarBytes(world, buffer, options = {}) {
  const doc = readGltf(buffer, { name: options.name ?? 'avatar' });
  const key = options.sourceKey ?? `sha:${fnv1a(String(buffer.byteLength))}:${options.name ?? 'avatar'}`;
  return importAvatar(world, doc, { ...options, sourceKey: key });
}

function identityBindMatrices(count) {
  const out = new Float32Array(count * 16);
  for (let i = 0; i < count; i++) {
    out[i * 16] = 1;
    out[i * 16 + 5] = 1;
    out[i * 16 + 10] = 1;
    out[i * 16 + 15] = 1;
  }
  return out;
}

function ensureAvatarComponents(world) {
  if (world.registry.has('AvatarRoot')) return;
  world.defineComponent('AvatarRoot', {
    rig: 'i32',
    height: 'f32',
    eyeHeight: 'f32',
    scale: 'f32',
    humanoid: 'u8',
  });
}

/**
 * Scale the avatar to the body it will drive.
 *
 * Eye height, not total height: the camera sits at the eyes, and matching
 * total height instead leaves a tall-headed avatar looking through its chin.
 */
function resolveScale(rig, options) {
  if (options.scale) return options.scale;
  const target = options.targetEyeHeight;
  const source = rig.measurements.eyeHeight;
  if (!target || !source) return 1;
  return target / source;
}

function readPrimitive(doc, mesh, primitive) {
  const attributes = primitive.attributes ?? {};
  const positions = doc.floats(attributes.POSITION);
  if (!positions) throw new Error(`primitive in ${mesh.name ?? 'mesh'} has no POSITION`);
  const vertexCount = positions.length / 3;

  let indices;
  if (primitive.indices !== undefined) {
    const accessor = doc.accessor(primitive.indices);
    indices = accessor.data instanceof Uint32Array ? accessor.data : Uint32Array.from(accessor.data);
  } else {
    indices = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) indices[i] = i;
  }

  const normals = attributes.NORMAL !== undefined ? doc.floats(attributes.NORMAL) : deriveNormals(positions, indices);
  const uvs = attributes.TEXCOORD_0 !== undefined ? doc.floats(attributes.TEXCOORD_0) : new Float32Array(vertexCount * 2);
  const joints = attributes.JOINTS_0 !== undefined ? Uint16Array.from(doc.accessor(attributes.JOINTS_0).data) : null;
  const weights = attributes.WEIGHTS_0 !== undefined ? doc.floats(attributes.WEIGHTS_0) : null;
  const colors = attributes.COLOR_0 !== undefined ? doc.floats(attributes.COLOR_0) : null;

  const targetNames = mesh.extras?.targetNames ?? [];
  const targets = (primitive.targets ?? []).map((target, index) => ({
    name: targetNames[index] ?? `target ${index}`,
    positions: target.POSITION !== undefined ? doc.floats(target.POSITION) : null,
    normals: target.NORMAL !== undefined ? doc.floats(target.NORMAL) : null,
  }));

  const bounds = boundsOf(positions);
  return { positions, normals, uvs, joints, weights, colors, indices, targets, vertexCount, bounds, mode: primitive.mode ?? 4 };
}

/** Flat normals when a file ships none, so nothing renders unlit black. */
function deriveNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i] * 3, indices[i + 1] * 3, indices[i + 2] * 3];
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const offset of [a, b, c]) {
      normals[offset] += nx;
      normals[offset + 1] += ny;
      normals[offset + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= length;
    normals[i + 1] /= length;
    normals[i + 2] /= length;
  }
  return normals;
}

function boundsOf(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], positions[i + c]);
      max[c] = Math.max(max[c], positions[i + c]);
    }
  }
  return { min, max };
}

function collectMorphNames(doc) {
  const names = [];
  for (const mesh of doc.json.meshes ?? []) {
    const targetNames = mesh.extras?.targetNames ?? [];
    const count = mesh.primitives?.[0]?.targets?.length ?? 0;
    for (let i = 0; i < count; i++) names.push(targetNames[i] ?? `target ${i}`);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Using an imported avatar
// ---------------------------------------------------------------------------

/**
 * Recover the bone map from the world alone.
 *
 * Bones are tagged when they are imported, and tags are in the scene store,
 * which is checkpointed — so an avatar survives a save, a restore, and a fork
 * without the importer having to run again.
 */
export function findBones(world, root) {
  const scene = world.store('scene');
  const bones = {};
  for (const handle of [root, ...descendantsOf(world, root)]) {
    const tags = scene.tags.get(handleIndex(handle));
    if (!tags) continue;
    for (const tag of tags) {
      if (tag.startsWith(BONE_TAG)) bones[tag.slice(BONE_TAG.length)] = handle;
    }
  }
  return bones;
}

/** Set a bone's local rotation. Poses are just transforms; there is no pose type. */
export function poseBone(world, handle, quaternion) {
  world.ecs.set(handle, 'LocalTransform', {
    rx: quaternion[0], ry: quaternion[1], rz: quaternion[2], rw: quaternion[3],
  });
}

export function quaternionFromEuler(x, y, z) {
  const [cx, cy, cz] = [Math.cos(x / 2), Math.cos(y / 2), Math.cos(z / 2)];
  const [sx, sy, sz] = [Math.sin(x / 2), Math.sin(y / 2), Math.sin(z / 2)];
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}

/**
 * A walk cycle, driven by the same speed the simulation already tracks.
 *
 * Not an animation clip — a function of phase. It exists so an imported avatar
 * visibly *is* the thing you are driving, rather than a statue that slides.
 */
export function poseWalk(world, bones, { phase = 0, speed = 0, grounded = 1 } = {}) {
  const stride = Math.min(1.3, speed / 8);
  const swing = Math.sin(phase) * 0.55 * stride;
  const counter = Math.sin(phase + Math.PI) * 0.55 * stride;
  const bounce = Math.abs(Math.sin(phase)) * 0.04 * stride;

  const set = (bone, euler) => {
    if (bones[bone]) poseBone(world, bones[bone], quaternionFromEuler(...euler));
  };

  set('leftUpperLeg', [swing, 0, 0]);
  set('rightUpperLeg', [counter, 0, 0]);
  set('leftLowerLeg', [Math.max(0, -swing) * 1.1, 0, 0]);
  set('rightLowerLeg', [Math.max(0, -counter) * 1.1, 0, 0]);
  set('leftUpperArm', [counter * 0.6, 0, 0.14]);
  set('rightUpperArm', [swing * 0.6, 0, -0.14]);
  set('leftLowerArm', [-Math.abs(counter) * 0.4, 0, 0]);
  set('rightLowerArm', [-Math.abs(swing) * 0.4, 0, 0]);
  set('spine', [stride * 0.05, Math.sin(phase) * 0.05 * stride, 0]);
  if (!grounded) {
    set('leftUpperLeg', [0.35, 0, 0]);
    set('rightUpperLeg', [-0.2, 0, 0]);
  }

  if (bones.hips) {
    const hips = world.ecs.get(bones.hips, 'LocalTransform');
    world.ecs.set(bones.hips, 'LocalTransform', { py: hips.py, px: hips.px, pz: hips.pz });
  }
  return bounce;
}
