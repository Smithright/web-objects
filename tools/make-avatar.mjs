#!/usr/bin/env node
// Author a VRM 1.0 avatar from scratch.
//
// Network egress is closed in this environment, so rather than mock a fixture
// this writes a real file: a GLB container with a humanoid skeleton, a skinned
// mesh, morph targets for blinks and visemes, PBR materials with an embedded
// texture, and the VRMC_vrm extension carrying the bone map, expressions, and
// licence. The importer reads it through exactly the same path it reads an
// avatar you exported from Blender or VRoid.
//
//   node tools/make-avatar.mjs [out.vrm]
//
// The result is CC0. Do what you like with it.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const OUT = resolve(process.argv[2] ?? 'assets/avatars/latticeborn-testbed.vrm');

// --- skeleton ---------------------------------------------------------------
//
// A 1.72 m humanoid in VRM 1.0 convention: Y up, +Z forward, origin between the
// feet. Positions are world-space here and converted to local at the end.

const SKELETON = [
  ['hips', null, [0, 0.94, 0]],
  ['spine', 'hips', [0, 1.06, 0]],
  ['chest', 'spine', [0, 1.19, 0]],
  ['upperChest', 'chest', [0, 1.31, 0]],
  ['neck', 'upperChest', [0, 1.44, 0]],
  ['head', 'neck', [0, 1.52, 0]],
  ['leftEye', 'head', [0.033, 1.635, 0.075]],
  ['rightEye', 'head', [-0.033, 1.635, 0.075]],
  ['jaw', 'head', [0, 1.575, 0.045]],

  ['leftShoulder', 'upperChest', [0.045, 1.395, 0]],
  ['leftUpperArm', 'leftShoulder', [0.165, 1.395, 0]],
  ['leftLowerArm', 'leftUpperArm', [0.165, 1.135, 0]],
  ['leftHand', 'leftLowerArm', [0.165, 0.885, 0]],
  ['rightShoulder', 'upperChest', [-0.045, 1.395, 0]],
  ['rightUpperArm', 'rightShoulder', [-0.165, 1.395, 0]],
  ['rightLowerArm', 'rightUpperArm', [-0.165, 1.135, 0]],
  ['rightHand', 'rightLowerArm', [-0.165, 0.885, 0]],

  ['leftUpperLeg', 'hips', [0.088, 0.905, 0]],
  ['leftLowerLeg', 'leftUpperLeg', [0.088, 0.495, 0]],
  ['leftFoot', 'leftLowerLeg', [0.088, 0.075, 0]],
  ['leftToes', 'leftFoot', [0.088, 0.025, 0.115]],
  ['rightUpperLeg', 'hips', [-0.088, 0.905, 0]],
  ['rightLowerLeg', 'rightUpperLeg', [-0.088, 0.495, 0]],
  ['rightFoot', 'rightLowerLeg', [-0.088, 0.075, 0]],
  ['rightToes', 'rightFoot', [-0.088, 0.025, 0.115]],
];

// One full finger chain per hand, so finger retargeting has something to chew on.
for (const [side, sign] of [['left', 1], ['right', -1]]) {
  const wrist = [sign * 0.165, 0.885, 0];
  const fingers = [
    ['Thumb', [sign * 0.035, -0.02, 0.035]],
    ['Index', [sign * 0.028, -0.05, 0.022]],
    ['Middle', [sign * 0.01, -0.055, 0.02]],
    ['Ring', [sign * -0.008, -0.052, 0.018]],
    ['Little', [sign * -0.026, -0.045, 0.014]],
  ];
  for (const [finger, offset] of fingers) {
    let parent = `${side}Hand`;
    let position = wrist;
    for (const [i, segment] of ['Proximal', 'Intermediate', 'Distal'].entries()) {
      position = [
        position[0] + offset[0] * (i === 0 ? 1 : 0.55),
        position[1] + offset[1] * (i === 0 ? 1 : 0.55),
        position[2] + offset[2] * (i === 0 ? 1 : 0.55),
      ];
      const name = `${side}${finger}${segment}`;
      SKELETON.push([name, parent, [...position]]);
      parent = name;
    }
  }
}

const boneIndex = new Map(SKELETON.map(([name], i) => [name, i]));
const worldPos = new Map(SKELETON.map(([name, , position]) => [name, position]));

// --- geometry ---------------------------------------------------------------

const positions = [];
const normals = [];
const uvs = [];
const joints = [];
const weights = [];
const primitives = [[], []]; // 0: skin, 1: outfit

function vertex(position, normal, uv, bonePairs) {
  const index = positions.length / 3;
  positions.push(...position);
  normals.push(...normal);
  uvs.push(...uv);
  const sorted = bonePairs.slice(0, 4);
  const total = sorted.reduce((sum, [, w]) => sum + w, 0) || 1;
  const j = [0, 0, 0, 0];
  const w = [0, 0, 0, 0];
  sorted.forEach(([bone, weight], slot) => {
    j[slot] = boneIndex.get(bone);
    w[slot] = weight / total;
  });
  joints.push(...j);
  weights.push(...w);
  return index;
}

function normalize(v) {
  const length = Math.hypot(...v) || 1;
  return v.map((x) => x / length);
}

/**
 * A tapered tube between two joints, skinned so weights blend across the seam.
 * This is the whole character: limbs are tubes, the torso is a chain of them,
 * the head is a sphere.
 */
function limb(target, fromBone, toBone, radiusFrom, radiusTo, sides = 10, rings = 5) {
  const a = worldPos.get(fromBone);
  const b = worldPos.get(toBone);
  const axis = normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
  // Any perpendicular will do for the ring basis.
  const helper = Math.abs(axis[1]) > 0.92 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(helper, axis));
  const v = cross(axis, u);

  const grid = [];
  for (let ring = 0; ring <= rings; ring++) {
    const t = ring / rings;
    const centre = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const radius = radiusFrom + (radiusTo - radiusFrom) * t;
    // Smooth weight handover so the elbow does not crease.
    const blend = smoothstep(0.25, 0.75, t);
    const row = [];
    for (let side = 0; side < sides; side++) {
      const angle = (side / sides) * Math.PI * 2;
      const dir = [
        u[0] * Math.cos(angle) + v[0] * Math.sin(angle),
        u[1] * Math.cos(angle) + v[1] * Math.sin(angle),
        u[2] * Math.cos(angle) + v[2] * Math.sin(angle),
      ];
      row.push(
        vertex(
          [centre[0] + dir[0] * radius, centre[1] + dir[1] * radius, centre[2] + dir[2] * radius],
          dir,
          [side / sides, t],
          [[fromBone, 1 - blend], [toBone, blend]],
        ),
      );
    }
    grid.push(row);
  }

  for (let ring = 0; ring < rings; ring++) {
    for (let side = 0; side < sides; side++) {
      const next = (side + 1) % sides;
      const a0 = grid[ring][side];
      const a1 = grid[ring][next];
      const b0 = grid[ring + 1][side];
      const b1 = grid[ring + 1][next];
      target.push(a0, b0, a1, a1, b0, b1);
    }
  }
  return grid;
}

function sphere(target, bone, centre, radius, rings = 12, segments = 16, squash = [1, 1.08, 1.02]) {
  const grid = [];
  for (let ring = 0; ring <= rings; ring++) {
    const phi = (ring / rings) * Math.PI;
    const row = [];
    for (let segment = 0; segment <= segments; segment++) {
      const theta = (segment / segments) * Math.PI * 2;
      const dir = [
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta),
      ];
      row.push(
        vertex(
          [
            centre[0] + dir[0] * radius * squash[0],
            centre[1] + dir[1] * radius * squash[1],
            centre[2] + dir[2] * radius * squash[2],
          ],
          normalize(dir),
          [segment / segments, ring / rings],
          [[bone, 1]],
        ),
      );
    }
    grid.push(row);
  }
  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const a = grid[ring][segment];
      const b = grid[ring + 1][segment];
      const c = grid[ring][segment + 1];
      const d = grid[ring + 1][segment + 1];
      target.push(a, b, c, c, b, d);
    }
  }
  return grid;
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const SKIN = primitives[0];
const OUTFIT = primitives[1];

// Head and face
const headStart = positions.length / 3;
sphere(SKIN, 'head', [0, 1.615, 0.01], 0.098);
const headEnd = positions.length / 3;
limb(SKIN, 'neck', 'head', 0.045, 0.052, 8, 2);

// Torso, as a chain so it tapers like a body rather than a barrel
limb(OUTFIT, 'hips', 'spine', 0.115, 0.108, 12, 2);
limb(OUTFIT, 'spine', 'chest', 0.108, 0.118, 12, 2);
limb(OUTFIT, 'chest', 'upperChest', 0.118, 0.122, 12, 2);
limb(OUTFIT, 'upperChest', 'neck', 0.122, 0.062, 12, 3);

for (const side of ['left', 'right']) {
  limb(OUTFIT, `${side}Shoulder`, `${side}UpperArm`, 0.055, 0.046, 8, 2);
  limb(SKIN, `${side}UpperArm`, `${side}LowerArm`, 0.046, 0.036, 8, 3);
  limb(SKIN, `${side}LowerArm`, `${side}Hand`, 0.036, 0.026, 8, 3);
  sphere(SKIN, `${side}Hand`, [...worldPos.get(`${side}Hand`)], 0.032, 6, 8, [1, 1.3, 0.7]);
  for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
    limb(SKIN, `${side}Hand`, `${side}${finger}Proximal`, 0.014, 0.011, 4, 1);
    limb(SKIN, `${side}${finger}Proximal`, `${side}${finger}Intermediate`, 0.011, 0.009, 4, 1);
    limb(SKIN, `${side}${finger}Intermediate`, `${side}${finger}Distal`, 0.009, 0.007, 4, 1);
  }
  limb(OUTFIT, `${side}UpperLeg`, `${side}LowerLeg`, 0.072, 0.055, 10, 3);
  limb(OUTFIT, `${side}LowerLeg`, `${side}Foot`, 0.055, 0.04, 10, 3);
  limb(OUTFIT, `${side}Foot`, `${side}Toes`, 0.045, 0.036, 8, 2);
}

// --- morph targets ----------------------------------------------------------
//
// Displacement fields over the head vertices: a falloff around a point, pushed
// along a direction. Crude, but they are real morph targets with real deltas,
// which is what the importer has to handle.

function morph(centre, radius, offset, only = null) {
  const deltas = new Float32Array(positions.length);
  for (let i = headStart; i < headEnd; i++) {
    const p = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    if (only && !only(p)) continue;
    const distance = Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]);
    if (distance > radius) continue;
    const falloff = 1 - smoothstep(0, radius, distance);
    deltas[i * 3] += offset[0] * falloff;
    deltas[i * 3 + 1] += offset[1] * falloff;
    deltas[i * 3 + 2] += offset[2] * falloff;
  }
  return deltas;
}

const front = (p) => p[2] > 0.0;
const MOUTH = [0, 1.565, 0.085];
const MORPHS = [
  ['blink', morph([0.033, 1.638, 0.082], 0.045, [0, -0.016, 0.004], front)
    .map((v, i) => v)],
  ['aa', morph(MOUTH, 0.05, [0, -0.022, 0.012], front)],
  ['ih', morph(MOUTH, 0.05, [0, -0.006, 0.004], front)],
  ['ou', morph(MOUTH, 0.042, [0, -0.008, 0.026], front)],
  ['E', morph(MOUTH, 0.055, [0, -0.012, 0.002], front)],
  ['oh', morph(MOUTH, 0.05, [0, -0.02, 0.018], front)],
  ['happy', morph([0, 1.585, 0.08], 0.07, [0, 0.012, 0.006], front)],
];
// Blink covers both eyes.
MORPHS[0][1] = Float32Array.from(MORPHS[0][1]);
{
  const right = morph([-0.033, 1.638, 0.082], 0.045, [0, -0.016, 0.004], front);
  for (let i = 0; i < right.length; i++) MORPHS[0][1][i] += right[i];
}

// --- a small embedded texture ----------------------------------------------

function crc32(bytes) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** A PNG with stored (uncompressed) deflate blocks — no compressor needed. */
function encodePng(width, height, rgba) {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const blocks = [];
  for (let offset = 0; offset < raw.length; offset += 65535) {
    const chunk = raw.subarray(offset, Math.min(offset + 65535, raw.length));
    const last = offset + 65535 >= raw.length ? 1 : 0;
    const header = new Uint8Array(5);
    header[0] = last;
    header[1] = chunk.length & 0xff;
    header[2] = chunk.length >> 8;
    header[3] = ~chunk.length & 0xff;
    header[4] = (~chunk.length >> 8) & 0xff;
    blocks.push(header, chunk);
  }
  const deflate = concat([new Uint8Array([0x78, 0x01]), ...blocks, u32be(adler32(raw))]);

  const chunk = (type, data) => {
    const typeBytes = new TextEncoder().encode(type);
    const body = concat([typeBytes, data]);
    return concat([u32be(data.length), body, u32be(crc32(body))]);
  };
  const ihdr = concat([u32be(width), u32be(height), new Uint8Array([8, 6, 0, 0, 0])]);
  return concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflate),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

function u32be(value) {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A 32×32 gradient with a subtle grid, so UVs are visibly correct or not. */
function makeTexture() {
  const size = 32;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const grid = x % 8 === 0 || y % 8 === 0 ? 0.82 : 1;
      rgba[i] = Math.round(196 * grid);
      rgba[i + 1] = Math.round((150 + (y / size) * 70) * grid);
      rgba[i + 2] = Math.round((190 + (x / size) * 55) * grid);
      rgba[i + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

// --- assemble the glTF ------------------------------------------------------

const chunks = [];
let byteLength = 0;
function push(data, target = null) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const padding = (4 - (bytes.length % 4)) % 4;
  const view = {
    buffer: 0,
    byteOffset: byteLength,
    byteLength: bytes.length,
  };
  if (target) view.target = target;
  chunks.push(bytes);
  if (padding) chunks.push(new Uint8Array(padding));
  byteLength += bytes.length + padding;
  bufferViews.push(view);
  return bufferViews.length - 1;
}

const bufferViews = [];
const accessors = [];

function accessor(data, type, componentType, options = {}) {
  const view = push(data, options.target);
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
  const count = data.length / components;
  const spec = { bufferView: view, componentType, count, type };
  if (options.minMax) {
    const min = new Array(components).fill(Infinity);
    const max = new Array(components).fill(-Infinity);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < components; c++) {
        min[c] = Math.min(min[c], data[i * components + c]);
        max[c] = Math.max(max[c], data[i * components + c]);
      }
    }
    spec.min = min;
    spec.max = max;
  }
  accessors.push(spec);
  return accessors.length - 1;
}

const positionAccessor = accessor(Float32Array.from(positions), 'VEC3', 5126, { minMax: true, target: 34962 });
const normalAccessor = accessor(Float32Array.from(normals), 'VEC3', 5126, { target: 34962 });
const uvAccessor = accessor(Float32Array.from(uvs), 'VEC2', 5126, { target: 34962 });
const jointAccessor = accessor(Uint16Array.from(joints), 'VEC4', 5123, { target: 34962 });
const weightAccessor = accessor(Float32Array.from(weights), 'VEC4', 5126, { target: 34962 });
const morphAccessors = MORPHS.map(([, deltas]) =>
  accessor(Float32Array.from(deltas), 'VEC3', 5126, { minMax: true }),
);

// Inverse bind matrices: the skeleton is authored in world space, so the bind
// matrix is a pure inverse translation.
const ibm = new Float32Array(SKELETON.length * 16);
SKELETON.forEach(([name], i) => {
  const p = worldPos.get(name);
  ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1], i * 16);
});
const ibmAccessor = accessor(ibm, 'MAT4', 5126);

const meshPrimitives = primitives.map((indices, material) => {
  const array = positions.length / 3 > 65535 ? Uint32Array.from(indices) : Uint16Array.from(indices);
  const indexAccessor = accessor(array, 'SCALAR', array.BYTES_PER_ELEMENT === 4 ? 5125 : 5123, { target: 34963 });
  return {
    attributes: {
      POSITION: positionAccessor,
      NORMAL: normalAccessor,
      TEXCOORD_0: uvAccessor,
      JOINTS_0: jointAccessor,
      WEIGHTS_0: weightAccessor,
    },
    indices: indexAccessor,
    material,
    targets: morphAccessors.map((index) => ({ POSITION: index })),
  };
});

const textureView = push(makeTexture());

// Nodes: the skeleton, plus one node carrying the skinned mesh.
const nodes = SKELETON.map(([name, parent, position]) => {
  const parentPosition = parent ? worldPos.get(parent) : [0, 0, 0];
  return {
    name,
    translation: [
      position[0] - parentPosition[0],
      position[1] - parentPosition[1],
      position[2] - parentPosition[2],
    ],
    children: [],
  };
});
SKELETON.forEach(([name, parent], index) => {
  if (parent) nodes[boneIndex.get(parent)].children.push(index);
});
for (const node of nodes) if (!node.children.length) delete node.children;

const meshNodeIndex = nodes.length;
nodes.push({ name: 'Body', mesh: 0, skin: 0 });
const rootNodeIndex = nodes.length;
nodes.push({ name: 'Testbed', children: [boneIndex.get('hips'), meshNodeIndex] });

const gltf = {
  asset: { version: '2.0', generator: 'latticeborn tools/make-avatar.mjs' },
  extensionsUsed: ['VRMC_vrm', 'VRMC_materials_mtoon'],
  scene: 0,
  scenes: [{ nodes: [rootNodeIndex] }],
  nodes,
  meshes: [
    {
      name: 'Body',
      primitives: meshPrimitives,
      weights: MORPHS.map(() => 0),
      extras: { targetNames: MORPHS.map(([name]) => name) },
    },
  ],
  skins: [
    {
      name: 'Armature',
      inverseBindMatrices: ibmAccessor,
      skeleton: boneIndex.get('hips'),
      joints: SKELETON.map((_, index) => index),
    },
  ],
  materials: [
    {
      name: 'Skin',
      pbrMetallicRoughness: {
        baseColorTexture: { index: 0 },
        baseColorFactor: [0.62, 0.78, 0.95, 1],
        metallicFactor: 0,
        roughnessFactor: 0.72,
      },
      emissiveFactor: [0.02, 0.09, 0.14],
      // MToon data rides along to prove extensions survive the import.
      extensions: {
        VRMC_materials_mtoon: {
          specVersion: '1.0',
          shadeColorFactor: [0.32, 0.42, 0.6],
          shadingShiftFactor: -0.05,
          shadingToonyFactor: 0.9,
        },
      },
    },
    {
      name: 'Outfit',
      pbrMetallicRoughness: {
        baseColorFactor: [0.14, 0.19, 0.3, 1],
        metallicFactor: 0.1,
        roughnessFactor: 0.55,
      },
      emissiveFactor: [0.05, 0.16, 0.2],
    },
  ],
  textures: [{ source: 0, sampler: 0 }],
  images: [{ name: 'skin', bufferView: textureView, mimeType: 'image/png' }],
  samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
  accessors,
  bufferViews,
  buffers: [{ byteLength }],
  extensions: {
    VRMC_vrm: {
      specVersion: '1.0',
      meta: {
        name: 'Latticeborn Testbed',
        version: '1.0.0',
        authors: ['Latticeborn'],
        licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
        avatarPermission: 'everyone',
        commercialUsage: 'corporation',
        modification: 'allowModificationRedistribution',
        allowRedistribution: true,
        allowExcessivelyViolentUsage: false,
        allowExcessivelySexualUsage: false,
        allowPoliticalOrReligiousUsage: false,
        allowAntisocialOrHateUsage: false,
        creditNotation: 'unnecessary',
      },
      humanoid: {
        humanBones: Object.fromEntries(SKELETON.map(([name], index) => [name, { node: index }])),
      },
      firstPerson: {
        meshAnnotations: [{ node: meshNodeIndex, type: 'auto' }],
      },
      lookAt: {
        offsetFromHeadBone: [0, 0.115, 0.065],
        type: 'bone',
        rangeMapHorizontalInner: { inputMaxValue: 90, outputScale: 10 },
        rangeMapHorizontalOuter: { inputMaxValue: 90, outputScale: 10 },
        rangeMapVerticalDown: { inputMaxValue: 90, outputScale: 10 },
        rangeMapVerticalUp: { inputMaxValue: 90, outputScale: 10 },
      },
      expressions: {
        preset: Object.fromEntries(
          MORPHS.map(([name], index) => [
            name === 'happy' ? 'happy' : name,
            {
              morphTargetBinds: [{ node: meshNodeIndex, index, weight: 1 }],
              isBinary: name === 'blink',
              overrideBlink: 'none',
              overrideLookAt: 'none',
              overrideMouth: 'none',
            },
          ]),
        ),
      },
    },
  },
};

// --- write the GLB ----------------------------------------------------------

const json = new TextEncoder().encode(JSON.stringify(gltf));
const jsonPadding = (4 - (json.length % 4)) % 4;
const binary = concat(chunks);
const binaryPadding = (4 - (binary.length % 4)) % 4;

const header = new Uint8Array(12);
const headerView = new DataView(header.buffer);
headerView.setUint32(0, 0x46546c67, true);
headerView.setUint32(4, 2, true);
headerView.setUint32(
  8,
  12 + 8 + json.length + jsonPadding + 8 + binary.length + binaryPadding,
  true,
);

const jsonHeader = new Uint8Array(8);
new DataView(jsonHeader.buffer).setUint32(0, json.length + jsonPadding, true);
new DataView(jsonHeader.buffer).setUint32(4, 0x4e4f534a, true);

const binHeader = new Uint8Array(8);
new DataView(binHeader.buffer).setUint32(0, binary.length + binaryPadding, true);
new DataView(binHeader.buffer).setUint32(4, 0x004e4942, true);

const glb = concat([
  header,
  jsonHeader,
  json,
  new Uint8Array(jsonPadding).fill(0x20),
  binHeader,
  binary,
  new Uint8Array(binaryPadding),
]);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, glb);

console.log(`wrote ${OUT}`);
console.log(`  ${(glb.length / 1024).toFixed(1)} KiB · ${SKELETON.length} bones · ${positions.length / 3} vertices · ` +
  `${primitives.reduce((n, p) => n + p.length / 3, 0)} triangles · ${MORPHS.length} morph targets`);
