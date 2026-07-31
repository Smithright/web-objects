// glTF 2.0 and GLB, parsed from bytes.
//
// This is the import boundary for everything authored outside the engine:
// avatars, props, worlds. It reads the container, resolves accessors into typed
// arrays, and hands back a document that knows nothing about rendering — the
// same parse feeds the rasterizer, the collider builder, and the inspector.
//
// Deliberately dependency-free and deliberately strict about the spec: a file
// that disagrees with glTF 2.0 gets a clear error rather than a silent
// half-import, because the failure mode of a lenient importer is an avatar that
// looks fine and animates wrong.
//
// Supported: GLB and .gltf (external, embedded base64, and GLB-buffer),
// accessors including sparse and interleaved byteStride, meshes with morph
// targets, skins, materials (metallic-roughness, unlit, emissive), textures and
// samplers, node hierarchies, and animations. Not supported: Draco and
// meshopt compression, which need a decoder this engine does not ship.

export const GLB_MAGIC = 0x46546c67; // "glTF"
export const CHUNK_JSON = 0x4e4f534a;
export const CHUNK_BIN = 0x004e4942;

const COMPONENT_TYPES = {
  5120: { array: Int8Array, size: 1, name: 'BYTE' },
  5121: { array: Uint8Array, size: 1, name: 'UNSIGNED_BYTE' },
  5122: { array: Int16Array, size: 2, name: 'SHORT' },
  5123: { array: Uint16Array, size: 2, name: 'UNSIGNED_SHORT' },
  5125: { array: Uint32Array, size: 4, name: 'UNSIGNED_INT' },
  5126: { array: Float32Array, size: 4, name: 'FLOAT' },
};

const TYPE_COMPONENTS = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

export const UNSUPPORTED_EXTENSIONS = [
  'KHR_draco_mesh_compression',
  'EXT_meshopt_compression',
];

/** Split a GLB container into its JSON and binary chunks. */
export function parseGLB(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12) throw new Error('not a GLB: file is too short');
  const magic = view.getUint32(0, true);
  if (magic !== GLB_MAGIC) {
    throw new Error(`not a GLB: expected magic 0x${GLB_MAGIC.toString(16)}, saw 0x${magic.toString(16)}`);
  }
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`unsupported GLB version ${version} (this engine reads glTF 2.0)`);
  const total = view.getUint32(8, true);

  let offset = 12;
  let json = null;
  let binary = null;
  while (offset + 8 <= Math.min(total, buffer.byteLength)) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > buffer.byteLength) throw new Error('GLB chunk runs past the end of the file');
    if (type === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, length)));
    } else if (type === CHUNK_BIN) {
      binary = buffer.slice(start, start + length);
    }
    // Unknown chunk types are skipped, as the spec requires.
    offset = start + length + ((4 - (length % 4)) % 4);
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, binary };
}

function decodeDataUri(uri) {
  const comma = uri.indexOf(',');
  if (comma < 0) throw new Error('malformed data URI');
  const meta = uri.slice(5, comma);
  const data = uri.slice(comma + 1);
  if (!meta.endsWith(';base64')) {
    const text = new TextEncoder().encode(decodeURIComponent(data));
    return text.buffer;
  }
  const binary = typeof atob === 'function'
    ? atob(data)
    : Buffer.from(data, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * A parsed glTF document.
 *
 * Accessor reads are memoized: an avatar's skin weights are asked for by the
 * mesh builder, the collider builder, and the inspector, and decoding them
 * three times is three times the garbage.
 */
export class GltfDocument {
  constructor(json, { binary = null, resolveBuffer = null, name = 'model' } = {}) {
    this.json = json;
    this.name = name;
    this.binaryChunk = binary;
    this._accessorCache = new Map();

    const asset = json.asset ?? {};
    this.generator = asset.generator ?? 'unknown';
    this.version = asset.version ?? '2.0';
    if (!String(this.version).startsWith('2')) {
      throw new Error(`glTF ${this.version} is not supported (this engine reads 2.0)`);
    }

    const required = json.extensionsRequired ?? [];
    const missing = required.filter((ext) => UNSUPPORTED_EXTENSIONS.includes(ext));
    if (missing.length) {
      throw new Error(
        `this file requires ${missing.join(', ')}, which needs a mesh decompressor this engine does not ship — ` +
          're-export without compression',
      );
    }

    this.buffers = (json.buffers ?? []).map((buffer, index) => {
      if (buffer.uri === undefined) {
        if (!binary) throw new Error(`buffer ${index} has no URI and the file has no binary chunk`);
        return binary;
      }
      if (buffer.uri.startsWith('data:')) return decodeDataUri(buffer.uri);
      if (!resolveBuffer) throw new Error(`buffer ${index} is external (${buffer.uri}) and no resolver was given`);
      return resolveBuffer(buffer.uri, index);
    });
  }

  get extensions() {
    return this.json.extensions ?? {};
  }

  has(extension) {
    return Boolean(this.json.extensions?.[extension]);
  }

  count(collection) {
    return (this.json[collection] ?? []).length;
  }

  /**
   * Read an accessor into a flat typed array of `count * components` values.
   * Interleaving and sparse substitution are resolved here so callers never
   * have to think about byteStride again.
   */
  accessor(index) {
    if (index === undefined || index === null) return null;
    if (this._accessorCache.has(index)) return this._accessorCache.get(index);

    const spec = this.json.accessors?.[index];
    if (!spec) throw new Error(`no accessor ${index}`);
    const component = COMPONENT_TYPES[spec.componentType];
    if (!component) throw new Error(`unknown componentType ${spec.componentType}`);
    const components = TYPE_COMPONENTS[spec.type];
    if (!components) throw new Error(`unknown accessor type ${spec.type}`);

    const out = new component.array(spec.count * components);

    if (spec.bufferView !== undefined) {
      const view = this.json.bufferViews[spec.bufferView];
      const buffer = this.buffers[view.buffer];
      const base = (view.byteOffset ?? 0) + (spec.byteOffset ?? 0);
      const elementBytes = component.size * components;
      const stride = view.byteStride ?? elementBytes;

      if (stride === elementBytes) {
        // Tightly packed: one copy, no per-element work.
        const source = new component.array(buffer, base, spec.count * components);
        out.set(source);
      } else {
        const bytes = new Uint8Array(buffer);
        const scratch = new Uint8Array(out.buffer);
        for (let i = 0; i < spec.count; i++) {
          const from = base + i * stride;
          scratch.set(bytes.subarray(from, from + elementBytes), i * elementBytes);
        }
      }
    }

    // Sparse accessors overwrite a subset after the dense read (or fill zeros).
    if (spec.sparse) {
      const { count, indices, values } = spec.sparse;
      const indexComponent = COMPONENT_TYPES[indices.componentType];
      const indexView = this.json.bufferViews[indices.bufferView];
      const sparseIndices = new indexComponent.array(
        this.buffers[indexView.buffer],
        (indexView.byteOffset ?? 0) + (indices.byteOffset ?? 0),
        count,
      );
      const valueView = this.json.bufferViews[values.bufferView];
      const sparseValues = new component.array(
        this.buffers[valueView.buffer],
        (valueView.byteOffset ?? 0) + (values.byteOffset ?? 0),
        count * components,
      );
      for (let i = 0; i < count; i++) {
        const target = sparseIndices[i] * components;
        for (let c = 0; c < components; c++) out[target + c] = sparseValues[i * components + c];
      }
    }

    const result = { data: out, count: spec.count, components, normalized: Boolean(spec.normalized), type: spec.type };
    this._accessorCache.set(index, result);
    return result;
  }

  /** Accessor values as Float32Array, applying the spec's normalization rules. */
  floats(index) {
    const accessor = this.accessor(index);
    if (!accessor) return null;
    if (accessor.data instanceof Float32Array) return accessor.data;
    const out = new Float32Array(accessor.data.length);
    if (!accessor.normalized) {
      out.set(accessor.data);
      return out;
    }
    const scale = {
      Int8Array: 127,
      Uint8Array: 255,
      Int16Array: 32767,
      Uint16Array: 65535,
    }[accessor.data.constructor.name];
    const signed = accessor.data instanceof Int8Array || accessor.data instanceof Int16Array;
    for (let i = 0; i < accessor.data.length; i++) {
      out[i] = signed ? Math.max(accessor.data[i] / scale, -1) : accessor.data[i] / scale;
    }
    return out;
  }

  /** Raw bytes of an image, plus its declared mime type. */
  image(index) {
    const spec = this.json.images?.[index];
    if (!spec) return null;
    if (spec.bufferView !== undefined) {
      const view = this.json.bufferViews[spec.bufferView];
      const bytes = new Uint8Array(this.buffers[view.buffer], view.byteOffset ?? 0, view.byteLength);
      return { bytes, mimeType: spec.mimeType ?? 'image/png', name: spec.name };
    }
    if (spec.uri?.startsWith('data:')) {
      const buffer = decodeDataUri(spec.uri);
      const mime = /^data:([^;,]+)/.exec(spec.uri)?.[1] ?? 'image/png';
      return { bytes: new Uint8Array(buffer), mimeType: mime, name: spec.name };
    }
    return { uri: spec.uri, mimeType: spec.mimeType, name: spec.name };
  }

  /** The node hierarchy, with parents resolved and local transforms normalized. */
  nodes() {
    const nodes = (this.json.nodes ?? []).map((node, index) => ({
      index,
      name: node.name ?? `node_${index}`,
      children: node.children ?? [],
      parent: -1,
      mesh: node.mesh,
      skin: node.skin,
      camera: node.camera,
      extensions: node.extensions ?? {},
      ...decomposeNode(node),
    }));
    for (const node of nodes) {
      for (const child of node.children) {
        if (nodes[child]) nodes[child].parent = node.index;
      }
    }
    return nodes;
  }

  scene() {
    const index = this.json.scene ?? 0;
    return this.json.scenes?.[index] ?? { nodes: (this.json.nodes ?? []).map((_, i) => i) };
  }

  /** Everything the inspector wants to show about a file before importing it. */
  summary() {
    const meshes = this.json.meshes ?? [];
    let triangles = 0;
    let vertices = 0;
    let morphTargets = 0;
    for (const mesh of meshes) {
      for (const primitive of mesh.primitives ?? []) {
        const position = this.json.accessors?.[primitive.attributes?.POSITION];
        if (position) vertices += position.count;
        const indices = this.json.accessors?.[primitive.indices];
        triangles += Math.floor((indices ? indices.count : (position?.count ?? 0)) / 3);
        morphTargets = Math.max(morphTargets, (primitive.targets ?? []).length);
      }
    }
    return {
      name: this.name,
      generator: this.generator,
      nodes: this.count('nodes'),
      meshes: meshes.length,
      materials: this.count('materials'),
      textures: this.count('textures'),
      skins: this.count('skins'),
      animations: this.count('animations'),
      vertices,
      triangles,
      morphTargets,
      extensions: Object.keys(this.json.extensions ?? {}),
      extensionsUsed: this.json.extensionsUsed ?? [],
    };
  }
}

/** Local transform as translation / rotation quaternion / scale. */
function decomposeNode(node) {
  if (node.matrix) {
    return decomposeMatrix(node.matrix);
  }
  return {
    translation: node.translation ? [...node.translation] : [0, 0, 0],
    rotation: node.rotation ? [...node.rotation] : [0, 0, 0, 1],
    scale: node.scale ? [...node.scale] : [1, 1, 1],
  };
}

/** Column-major TRS decomposition, as glTF stores matrices. */
export function decomposeMatrix(m) {
  const translation = [m[12], m[13], m[14]];
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  // A negative determinant means one axis is mirrored; glTF puts it on X.
  const determinant =
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[1] * (m[4] * m[10] - m[6] * m[8]) +
    m[2] * (m[4] * m[9] - m[5] * m[8]);
  if (determinant < 0) sx = -sx;

  const r = [
    m[0] / sx, m[1] / sx, m[2] / sx,
    m[4] / sy, m[5] / sy, m[6] / sy,
    m[8] / sz, m[9] / sz, m[10] / sz,
  ];
  const trace = r[0] + r[4] + r[8];
  let rotation;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    rotation = [(r[5] - r[7]) / s, (r[6] - r[2]) / s, (r[1] - r[3]) / s, s / 4];
  } else if (r[0] > r[4] && r[0] > r[8]) {
    const s = Math.sqrt(1 + r[0] - r[4] - r[8]) * 2;
    rotation = [s / 4, (r[3] + r[1]) / s, (r[6] + r[2]) / s, (r[5] - r[7]) / s];
  } else if (r[4] > r[8]) {
    const s = Math.sqrt(1 + r[4] - r[0] - r[8]) * 2;
    rotation = [(r[3] + r[1]) / s, s / 4, (r[7] + r[5]) / s, (r[6] - r[2]) / s];
  } else {
    const s = Math.sqrt(1 + r[8] - r[0] - r[4]) * 2;
    rotation = [(r[6] + r[2]) / s, (r[7] + r[5]) / s, s / 4, (r[1] - r[3]) / s];
  }
  return { translation, rotation, scale: [sx, sy, sz] };
}

/** Parse bytes that may be GLB or JSON glTF. */
export function readGltf(buffer, options = {}) {
  const bytes = new Uint8Array(buffer);
  const looksBinary = bytes.length >= 4 && new DataView(buffer).getUint32(0, true) === GLB_MAGIC;
  if (looksBinary) {
    const { json, binary } = parseGLB(buffer);
    return new GltfDocument(json, { ...options, binary });
  }
  const text = new TextDecoder().decode(bytes).trim();
  if (!text.startsWith('{')) throw new Error('not a glTF file: neither GLB magic nor JSON');
  return new GltfDocument(JSON.parse(text), options);
}
