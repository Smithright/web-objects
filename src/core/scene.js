// Slots, transforms, and assets.
//
// Everything the engine has done so far treats entities as a flat set of
// components, which is the right shape for simulation and the wrong shape for
// building. A world you can build in needs a hierarchy: you grab a chair and
// its cushions come with it, you scale a lamp and its bulb scales too, and you
// can open any of it and look at what it is made of.
//
// So: a Slot is an entity with a parent and a local transform. A Component is
// what this engine already had. Assets — meshes, materials, textures, rigs —
// live in a registry and are referenced by id, because a hundred chairs should
// not be a hundred copies of a chair.
//
// The transform system is the only thing here that runs every tick, and it is
// deliberately boring: sort by depth, compose parent with local, write world.

import { Backend, Domain } from './scheduler.js';
import { Digest } from './hash.js';
import { handleIndex } from './ids.js';

export const SlotFlags = {
  NONE: 0,
  STATIC: 1, // never moves; the transform system may skip it
  HIDDEN: 2,
  LOCKED: 4, // build tools refuse to grab it
  PERSISTENT: 8, // survives a region unload
};

/**
 * Names, and anything else about a slot that is text rather than number.
 *
 * The ECS stores scalars in typed arrays, which is why it is fast and why it
 * cannot hold a name. This store holds the strings, keyed by entity index, and
 * joins checkpoints like any other store.
 */
export class SceneStore {
  constructor() {
    this.names = new Map(); // entity index -> name
    this.tags = new Map(); // entity index -> Set<string>
    this.assetOf = new Map(); // entity index -> source asset id
  }

  name(index, value) {
    if (value === undefined) return this.names.get(index) ?? null;
    this.names.set(index, value);
    return value;
  }

  tag(index, value) {
    let set = this.tags.get(index);
    if (!set) this.tags.set(index, (set = new Set()));
    set.add(value);
    return set;
  }

  hasTag(index, value) {
    return this.tags.get(index)?.has(value) ?? false;
  }

  forget(index) {
    this.names.delete(index);
    this.tags.delete(index);
    this.assetOf.delete(index);
  }

  toJSON() {
    return {
      names: [...this.names],
      tags: [...this.tags].map(([index, set]) => [index, [...set]]),
      assetOf: [...this.assetOf],
    };
  }

  load(json) {
    this.names = new Map(json.names);
    this.tags = new Map((json.tags ?? []).map(([index, list]) => [index, new Set(list)]));
    this.assetOf = new Map(json.assetOf ?? []);
    return this;
  }

  digest() {
    const d = new Digest();
    for (const key of [...this.names.keys()].sort((a, b) => a - b)) {
      d.int(key).str(this.names.get(key));
    }
    return d.value;
  }
}

/**
 * The asset registry.
 *
 * Assets are content-addressed: importing the same file twice yields the same
 * ids and the same buffers. They are deliberately *not* written into
 * checkpoints — a checkpoint records which assets a world uses, and the bytes
 * come back from the source. A world save that inlines every mesh is a world
 * save nobody can diff.
 */
export class AssetRegistry {
  constructor() {
    this.assets = new Map(); // id -> record
    this.byKey = new Map(); // content key -> id
    this.nextId = 1;
    this.bytes = 0;
  }

  /** Register (or find) an asset. `key` is its content identity. */
  add(kind, key, value, meta = {}) {
    const contentKey = `${kind}:${key}`;
    if (this.byKey.has(contentKey)) return this.byKey.get(contentKey);
    const id = this.nextId++;
    const size = meta.bytes ?? estimateBytes(value);
    this.assets.set(id, { id, kind, key: contentKey, value, meta, bytes: size, refs: 0 });
    this.byKey.set(contentKey, id);
    this.bytes += size;
    return id;
  }

  get(id) {
    return this.assets.get(id) ?? null;
  }

  value(id) {
    return this.assets.get(id)?.value ?? null;
  }

  of(kind) {
    return [...this.assets.values()].filter((asset) => asset.kind === kind);
  }

  retain(id) {
    const asset = this.assets.get(id);
    if (asset) asset.refs++;
    return id;
  }

  release(id) {
    const asset = this.assets.get(id);
    if (!asset) return;
    asset.refs = Math.max(0, asset.refs - 1);
  }

  /** Drop everything nothing references. The build tools call this on undo. */
  collect() {
    let freed = 0;
    for (const [id, asset] of [...this.assets]) {
      if (asset.refs > 0 || asset.meta.pinned) continue;
      this.assets.delete(id);
      this.byKey.delete(asset.key);
      this.bytes -= asset.bytes;
      freed++;
    }
    return freed;
  }

  totals() {
    const kinds = {};
    for (const asset of this.assets.values()) {
      kinds[asset.kind] = (kinds[asset.kind] ?? 0) + 1;
    }
    return { count: this.assets.size, bytes: this.bytes, kinds };
  }

  /** Checkpoints carry the manifest, not the megabytes. */
  toJSON() {
    return {
      nextId: this.nextId,
      manifest: [...this.assets.values()].map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        key: asset.key,
        bytes: asset.bytes,
        meta: asset.meta,
      })),
    };
  }

  load(json) {
    this.nextId = json.nextId;
    // Records whose bytes are gone are kept as placeholders so a restored world
    // can say "this slot wants mesh 7" instead of silently rendering nothing.
    for (const record of json.manifest ?? []) {
      if (this.assets.has(record.id)) continue;
      this.assets.set(record.id, { ...record, value: null, refs: 0, missing: true });
      this.byKey.set(record.key, record.id);
    }
    return this;
  }

  digest() {
    const d = new Digest();
    for (const id of [...this.assets.keys()].sort((a, b) => a - b)) {
      d.int(id).str(this.assets.get(id).key);
    }
    return d.value;
  }
}

function estimateBytes(value) {
  if (!value || typeof value !== 'object') return 0;
  let total = 0;
  for (const item of Object.values(value)) {
    if (ArrayBuffer.isView(item)) total += item.byteLength;
    else if (item instanceof ArrayBuffer) total += item.byteLength;
    else if (Array.isArray(item)) total += item.length * 8;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Installing the scene graph into a world
// ---------------------------------------------------------------------------

export function installScene(world) {
  if (world.stores.has('scene')) return world;

  world.defineComponent('Slot', { parent: 'i32', depth: 'i32', flags: 'u8', order: 'i32' });
  world.defineComponent('LocalTransform', {
    px: 'f64', py: 'f64', pz: 'f64',
    rx: 'f64', ry: 'f64', rz: 'f64', rw: 'f64',
    sx: 'f64', sy: 'f64', sz: 'f64',
  });
  world.defineComponent('WorldTransform', {
    px: 'f64', py: 'f64', pz: 'f64',
    rx: 'f64', ry: 'f64', rz: 'f64', rw: 'f64',
    sx: 'f64', sy: 'f64', sz: 'f64',
  });
  world.defineComponent('MeshRenderer', { mesh: 'i32', material: 'i32', layer: 'u8', visible: 'u8' });
  world.defineComponent('SkinnedRenderer', { mesh: 'i32', material: 'i32', skin: 'i32', root: 'i32', visible: 'u8' });
  world.defineComponent('Grabbable', { mass: 'f32', held: 'u8', locked: 'u8' });

  world.registerStore('scene', new SceneStore());
  world.registerStore('assets', new AssetRegistry());

  world.addSystem({
    name: 'Transforms',
    reads: ['Slot', 'LocalTransform'],
    writes: ['WorldTransform'],
    domain: Domain.SPATIAL,
    backend: Backend.CPU_SIMD,
    run: runTransforms,
  });

  return world;
}

/**
 * Compose world transforms.
 *
 * Slots are visited in depth order so a parent is always finished before its
 * children. Depth is maintained by `setParent`, which is the only thing that
 * can change it, so this never has to walk the tree.
 */
function runTransforms(world) {
  const ecs = world.ecs;
  const order = [];
  for (const chunk of ecs.query(['Slot', 'LocalTransform', 'WorldTransform'])) {
    const depth = chunk.col('Slot', 'depth');
    for (let i = 0; i < chunk.count; i++) order.push([depth[i], chunk.entity(i)]);
  }
  // Stable: equal depths keep entity-index order, so the pass is deterministic.
  order.sort((a, b) => a[0] - b[0] || handleIndex(a[1]) - handleIndex(b[1]));

  const local = { p: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] };
  const parent = { p: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] };

  for (const [, handle] of order) {
    readTransform(ecs, handle, 'LocalTransform', local);
    const slotParent = ecs.get(handle, 'Slot').parent;
    if (slotParent < 0 || !ecs.alive(indexToHandle(ecs, slotParent))) {
      writeTransform(ecs, handle, 'WorldTransform', local);
      continue;
    }
    readTransform(ecs, indexToHandle(ecs, slotParent), 'WorldTransform', parent);
    writeTransform(ecs, handle, 'WorldTransform', composeTransforms(parent, local));
  }
}

/** Slots store parents by entity index, which survives handle regeneration. */
function indexToHandle(ecs, index) {
  const arch = ecs._archOf[index];
  if (!arch) return 0;
  return arch.entities[ecs._rowOf[index]];
}

function readTransform(ecs, handle, component, out) {
  const t = ecs.get(handle, component);
  out.p[0] = t.px;
  out.p[1] = t.py;
  out.p[2] = t.pz;
  out.r[0] = t.rx;
  out.r[1] = t.ry;
  out.r[2] = t.rz;
  out.r[3] = t.rw;
  out.s[0] = t.sx;
  out.s[1] = t.sy;
  out.s[2] = t.sz;
  return out;
}

function writeTransform(ecs, handle, component, t) {
  ecs.set(handle, component, {
    px: t.p[0], py: t.p[1], pz: t.p[2],
    rx: t.r[0], ry: t.r[1], rz: t.r[2], rw: t.r[3],
    sx: t.s[0], sy: t.s[1], sz: t.s[2],
  });
}

/** parent ∘ local, for translation-rotation-scale without shear. */
export function composeTransforms(parent, local) {
  const scaled = [local.p[0] * parent.s[0], local.p[1] * parent.s[1], local.p[2] * parent.s[2]];
  const rotated = rotateVector(parent.r, scaled);
  return {
    p: [parent.p[0] + rotated[0], parent.p[1] + rotated[1], parent.p[2] + rotated[2]],
    r: multiplyQuaternions(parent.r, local.r),
    s: [parent.s[0] * local.s[0], parent.s[1] * local.s[1], parent.s[2] * local.s[2]],
  };
}

export function rotateVector(q, v) {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

export function multiplyQuaternions(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** 4x4 column-major matrix for a slot's world transform, for the renderer. */
export function transformMatrix(t, out = new Float32Array(16)) {
  const [x, y, z, w] = t.r;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  out[0] = (1 - (yy + zz)) * t.s[0];
  out[1] = (xy + wz) * t.s[0];
  out[2] = (xz - wy) * t.s[0];
  out[3] = 0;
  out[4] = (xy - wz) * t.s[1];
  out[5] = (1 - (xx + zz)) * t.s[1];
  out[6] = (yz + wx) * t.s[1];
  out[7] = 0;
  out[8] = (xz + wy) * t.s[2];
  out[9] = (yz - wx) * t.s[2];
  out[10] = (1 - (xx + yy)) * t.s[2];
  out[11] = 0;
  out[12] = t.p[0];
  out[13] = t.p[1];
  out[14] = t.p[2];
  out[15] = 1;
  return out;
}

// ---------------------------------------------------------------------------
// Slot API — what the build tools and the importer both use
// ---------------------------------------------------------------------------

export function createSlot(world, options = {}) {
  const parent = options.parent ?? null;
  const parentIndex = parent === null ? -1 : handleIndex(parent);
  const depth = parent === null ? 0 : world.ecs.get(parent, 'Slot').depth + 1;
  const position = options.position ?? [0, 0, 0];
  const rotation = options.rotation ?? [0, 0, 0, 1];
  const scale = options.scale ?? [1, 1, 1];

  const handle = world.ecs.create({
    Slot: { parent: parentIndex, depth, flags: options.flags ?? SlotFlags.NONE, order: options.order ?? 0 },
    LocalTransform: {
      px: position[0], py: position[1], pz: position[2],
      rx: rotation[0], ry: rotation[1], rz: rotation[2], rw: rotation[3],
      sx: scale[0], sy: scale[1], sz: scale[2],
    },
    WorldTransform: {
      px: position[0], py: position[1], pz: position[2],
      rx: rotation[0], ry: rotation[1], rz: rotation[2], rw: rotation[3],
      sx: scale[0], sy: scale[1], sz: scale[2],
    },
  });
  world.store('scene').name(handleIndex(handle), options.name ?? `Slot ${handleIndex(handle)}`);
  return handle;
}

export function setParent(world, child, parent) {
  const slot = world.ecs.get(child, 'Slot');
  const parentIndex = parent === null ? -1 : handleIndex(parent);
  const depth = parent === null ? 0 : world.ecs.get(parent, 'Slot').depth + 1;
  world.ecs.set(child, 'Slot', { parent: parentIndex, depth });
  // Depth is cached, so a re-parent has to fix every descendant.
  const stack = [child];
  while (stack.length) {
    const current = stack.pop();
    const currentDepth = world.ecs.get(current, 'Slot').depth;
    for (const kid of childrenOf(world, current)) {
      world.ecs.set(kid, 'Slot', { depth: currentDepth + 1 });
      stack.push(kid);
    }
  }
  return child;
}

export function childrenOf(world, handle) {
  const index = handleIndex(handle);
  const out = [];
  for (const chunk of world.ecs.query(['Slot'])) {
    const parent = chunk.col('Slot', 'parent');
    for (let i = 0; i < chunk.count; i++) {
      if (parent[i] === index) out.push(chunk.entity(i));
    }
  }
  return out;
}

export function descendantsOf(world, handle, out = []) {
  for (const child of childrenOf(world, handle)) {
    out.push(child);
    descendantsOf(world, child, out);
  }
  return out;
}

export function slotName(world, handle) {
  return world.store('scene').name(handleIndex(handle)) ?? `Slot ${handleIndex(handle)}`;
}

export function slotPath(world, handle) {
  const parts = [];
  let current = handle;
  let guard = 0;
  while (current && world.ecs.alive(current) && guard++ < 64) {
    parts.unshift(slotName(world, current));
    const parent = world.ecs.get(current, 'Slot').parent;
    if (parent < 0) break;
    current = indexToHandle(world.ecs, parent);
  }
  return parts.join('/');
}

/** Destroy a slot and everything under it. */
export function destroySlot(world, handle) {
  const doomed = [handle, ...descendantsOf(world, handle)];
  const scene = world.store('scene');
  const assets = world.store('assets');
  for (const entity of doomed) {
    for (const component of ['MeshRenderer', 'SkinnedRenderer']) {
      if (!world.ecs.has(entity, component)) continue;
      const renderer = world.ecs.get(entity, component);
      assets.release(renderer.mesh);
      assets.release(renderer.material);
    }
    scene.forget(handleIndex(entity));
    world.ecs.destroy(entity);
  }
  return doomed.length;
}

/**
 * The inspector's view of one slot: what it is, where it is, what it is made
 * of. Everything a build tool needs to show a user, and nothing it does not.
 */
export function inspectSlot(world, handle) {
  if (!world.ecs.alive(handle)) return null;
  const ecs = world.ecs;
  const assets = world.store('assets');
  const slot = ecs.get(handle, 'Slot');
  const local = ecs.get(handle, 'LocalTransform');
  const worldTransform = ecs.get(handle, 'WorldTransform');
  const components = ecs.componentsOf(handle).filter((name) => name !== 'Slot');

  return {
    handle,
    index: handleIndex(handle),
    name: slotName(world, handle),
    path: slotPath(world, handle),
    parent: slot.parent,
    depth: slot.depth,
    flags: slot.flags,
    children: childrenOf(world, handle).length,
    components: components.map((name) => ({ name, values: ecs.get(handle, name) })),
    local: { position: [local.px, local.py, local.pz], rotation: [local.rx, local.ry, local.rz, local.rw], scale: [local.sx, local.sy, local.sz] },
    world: { position: [worldTransform.px, worldTransform.py, worldTransform.pz] },
    assets: components
      .filter((name) => name === 'MeshRenderer' || name === 'SkinnedRenderer')
      .flatMap((name) => {
        const renderer = ecs.get(handle, name);
        return [assets.get(renderer.mesh), assets.get(renderer.material)].filter(Boolean).map((asset) => ({
          id: asset.id,
          kind: asset.kind,
          bytes: asset.bytes,
          meta: asset.meta,
        }));
      }),
  };
}
