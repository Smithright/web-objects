// Building.
//
// Every edit is a command. Spawning a box, grabbing it, scaling it, deleting
// it — all of it goes through the same queue as walking and igniting, lands in
// the event log, and replays. That is not tidiness for its own sake: it is what
// makes undo *time travel* rather than a parallel stack of inverse operations
// that has to be kept correct by hand.
//
// Held objects are a state, not a stream. `build.grab` says what you are
// holding and how far away; a system moves it every tick to follow your grip.
// Two commands per grab instead of sixty per second, and the recording of a
// build session stays legible afterwards.

import { Backend, Domain } from '../core/scheduler.js';
import { EventClass } from '../core/events.js';
import { PRIMITIVES, makePrimitive } from '../core/primitives.js';
import {
  childrenOf,
  createSlot,
  descendantsOf,
  destroySlot,
  installScene,
  slotName,
  transformMatrix,
} from '../core/scene.js';
import { handleIndex } from '../core/ids.js';

export const GRAB_MIN_DISTANCE = 0.8;
export const GRAB_MAX_DISTANCE = 24;
export const UNDO_DEPTH = 24;

const PALETTE = [
  [0.82, 0.84, 0.90, 1],
  [0.30, 0.78, 0.72, 1],
  [0.96, 0.72, 0.35, 1],
  [0.68, 0.55, 0.98, 1],
  [0.94, 0.45, 0.44, 1],
  [0.42, 0.62, 0.95, 1],
];

/**
 * The undo stack.
 *
 * Each entry is a whole-world checkpoint taken before an edit. The engine
 * already guarantees a checkpoint restores exactly, so undo inherits that for
 * free — including the parts of the world an edit touched indirectly.
 */
export class UndoStack {
  constructor(depth = UNDO_DEPTH) {
    this.depth = depth;
    this.past = [];
    this.future = [];
  }

  record(checkpoint, label) {
    this.past.push({ checkpoint, label, tick: checkpoint.tick });
    if (this.past.length > this.depth) this.past.shift();
    this.future.length = 0; // a new edit forks away from any undone future
  }

  undo(current) {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push({ checkpoint: current, label: entry.label, tick: current.tick });
    return entry;
  }

  redo(current) {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push({ checkpoint: current, label: entry.label, tick: current.tick });
    return entry;
  }

  get labels() {
    return { undo: this.past.at(-1)?.label ?? null, redo: this.future.at(-1)?.label ?? null };
  }

  // The stack is a tool's memory, not the world's: it is deliberately not part
  // of a checkpoint, or undoing would restore the stack that undid it.
  toJSON() {
    return { depth: this.depth };
  }

  load(json) {
    this.depth = json.depth ?? UNDO_DEPTH;
    return this;
  }
}

export function installBuild(world) {
  if (world.stores.has('undo')) return world;
  installScene(world);

  world.defineComponent('Held', {
    distance: 'f32',
    yaw: 'f32',
    pitch: 'f32',
    roll: 'f32',
    scale: 'f32',
    since: 'u32',
  });
  world.defineComponent('Spawned', { kind: 'u8', variant: 'u8', birth: 'u32' });

  world.registerStore('undo', new UndoStack());

  world.addSystem({
    name: 'HeldObjects',
    reads: ['Held', 'Avatar', 'Position'],
    writes: ['LocalTransform'],
    domain: Domain.SPATIAL,
    backend: Backend.CPU_SCALAR,
    run: runHeld,
  });

  installBuildCommands(world);
  return world;
}

/**
 * Move whatever is held so it stays in front of the grip.
 *
 * The grip is the avatar's eye and heading, which the simulation already owns —
 * so a held object is correct on a replayed frame without the client having to
 * have been there.
 */
function runHeld(world) {
  const avatar = findAvatar(world);
  if (!avatar) return;
  const eye = world.ecs.get(avatar, 'Position');
  const look = world.ecs.get(avatar, 'Avatar');
  const forward = {
    x: Math.sin(look.yaw) * Math.cos(look.pitch),
    y: Math.sin(look.pitch),
    z: Math.cos(look.yaw) * Math.cos(look.pitch),
  };

  for (const chunk of world.ecs.query(['Held', 'LocalTransform'])) {
    const distance = chunk.col('Held', 'distance');
    const yaw = chunk.col('Held', 'yaw');
    const pitch = chunk.col('Held', 'pitch');
    const roll = chunk.col('Held', 'roll');
    const scale = chunk.col('Held', 'scale');
    const px = chunk.col('LocalTransform', 'px');
    const py = chunk.col('LocalTransform', 'py');
    const pz = chunk.col('LocalTransform', 'pz');
    const rx = chunk.col('LocalTransform', 'rx');
    const ry = chunk.col('LocalTransform', 'ry');
    const rz = chunk.col('LocalTransform', 'rz');
    const rw = chunk.col('LocalTransform', 'rw');
    const sx = chunk.col('LocalTransform', 'sx');
    const sy = chunk.col('LocalTransform', 'sy');
    const sz = chunk.col('LocalTransform', 'sz');

    for (let i = 0; i < chunk.count; i++) {
      px[i] = eye.x + forward.x * distance[i];
      py[i] = eye.y + forward.y * distance[i];
      pz[i] = eye.z + forward.z * distance[i];
      // The object keeps the orientation you gave it, in the grip's frame.
      const q = quaternionFromEuler(pitch[i], look.yaw + yaw[i], roll[i]);
      rx[i] = q[0];
      ry[i] = q[1];
      rz[i] = q[2];
      rw[i] = q[3];
      sx[i] = scale[i];
      sy[i] = scale[i];
      sz[i] = scale[i];
    }
  }
}

function findAvatar(world) {
  for (const chunk of world.ecs.query(['Avatar', 'Position'])) {
    if (chunk.count > 0) return chunk.entity(0);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Consequences are named differently from the commands that caused them —
 * `build.spawn` is somebody asking, `slot.spawned` is it having happened. The
 * log has to be able to tell those apart, or a replay cannot distinguish an
 * intent that was refused from one that was carried out.
 */
function installBuildCommands(world) {
  /** Take a checkpoint first, so any edit is one undo away from not having happened. */
  const remember = (label) => {
    world.store('undo').record(world.checkpoint(), label);
  };

  world.onCommand('build.spawn', (w, payload) => {
    remember(`spawn ${payload.kind ?? 'box'}`);
    spawnPrimitive(w, payload);
  });

  world.onCommand('build.grab', (w, payload) => {
    const handle = resolveSlot(w, payload.slot);
    if (!handle) return;
    if (w.ecs.has(handle, 'Grabbable') && w.ecs.get(handle, 'Grabbable').locked) return;
    remember(`grab ${slotName(w, handle)}`);
    const local = w.ecs.get(handle, 'LocalTransform');
    w.ecs.add(handle, 'Held', {
      distance: clamp(payload.distance ?? 3, GRAB_MIN_DISTANCE, GRAB_MAX_DISTANCE),
      yaw: payload.yaw ?? 0,
      pitch: 0,
      roll: 0,
      scale: local.sx,
      since: w.tick,
    });
    if (w.ecs.has(handle, 'Grabbable')) w.ecs.set(handle, 'Grabbable', { held: 1 });
    w.emit({
      operation: 'slot.grabbed',
      class: EventClass.CONSEQUENCE,
      target: `slot:${handleIndex(handle)}`,
      payload: { name: slotName(w, handle) },
    });
  });

  world.onCommand('build.release', (w, payload) => {
    for (const handle of heldSlots(w)) {
      if (payload.slot !== undefined && handleIndex(handle) !== payload.slot) continue;
      w.ecs.remove(handle, 'Held');
      if (w.ecs.has(handle, 'Grabbable')) w.ecs.set(handle, 'Grabbable', { held: 0 });
      w.emit({
        operation: 'slot.released',
        class: EventClass.CONSEQUENCE,
        target: `slot:${handleIndex(handle)}`,
        payload: { name: slotName(w, handle) },
      });
    }
  });

  /** Adjust what you are holding without letting go. */
  world.onCommand('build.adjust', (w, payload) => {
    for (const handle of heldSlots(w)) {
      const held = w.ecs.get(handle, 'Held');
      w.ecs.set(handle, 'Held', {
        distance: clamp(held.distance + (payload.distance ?? 0), GRAB_MIN_DISTANCE, GRAB_MAX_DISTANCE),
        yaw: held.yaw + (payload.yaw ?? 0),
        pitch: held.pitch + (payload.pitch ?? 0),
        roll: held.roll + (payload.roll ?? 0),
        scale: clamp(held.scale * (payload.scale ?? 1), 0.02, 60),
      });
    }
  });

  world.onCommand('build.duplicate', (w, payload) => {
    const handle = resolveSlot(w, payload.slot);
    if (!handle) return;
    remember(`duplicate ${slotName(w, handle)}`);
    const copy = duplicateSlot(w, handle, payload.offset ?? [0.6, 0, 0]);
    w.emit({
      operation: 'slot.duplicated',
      class: EventClass.LIFECYCLE,
      target: `slot:${handleIndex(copy)}`,
      payload: { from: slotName(w, handle), slots: descendantsOf(w, copy).length + 1 },
    });
  });

  world.onCommand('build.delete', (w, payload) => {
    const handle = resolveSlot(w, payload.slot);
    if (!handle) return;
    if (w.ecs.has(handle, 'Grabbable') && w.ecs.get(handle, 'Grabbable').locked) return;
    const name = slotName(w, handle);
    remember(`delete ${name}`);
    const count = destroySlot(w, handle);
    w.emit({
      operation: 'slot.deleted',
      class: EventClass.LIFECYCLE,
      target: `slot:${payload.slot}`,
      payload: { name, slots: count },
    });
  });

  world.onCommand('build.rename', (w, payload) => {
    const handle = resolveSlot(w, payload.slot);
    if (!handle) return;
    w.store('scene').name(handleIndex(handle), String(payload.name ?? '').slice(0, 64) || 'Slot');
  });

  world.onCommand('build.material', (w, payload) => {
    const handle = resolveSlot(w, payload.slot);
    if (!handle || !w.ecs.has(handle, 'MeshRenderer')) return;
    remember(`recolour ${slotName(w, handle)}`);
    const assets = w.store('assets');
    const colour = payload.color ?? PALETTE[(payload.index ?? 0) % PALETTE.length];
    const id = assets.add('material', `built:${colour.map((c) => c.toFixed(3)).join(',')}`, {
      name: 'built',
      baseColor: colour,
      baseColorTexture: 0,
      metallic: payload.metallic ?? 0.05,
      roughness: payload.roughness ?? 0.55,
      emissive: payload.emissive ?? [colour[0] * 0.05, colour[1] * 0.05, colour[2] * 0.05],
      doubleSided: false,
      alphaMode: 'OPAQUE',
    });
    assets.retain(id);
    assets.release(w.ecs.get(handle, 'MeshRenderer').material);
    w.ecs.set(handle, 'MeshRenderer', { material: id });
  });

  // Undo and redo are the time layer, borrowed. Nothing here inverts an edit;
  // it restores the world from before one.
  //
  // Note the world does not stop for it: the restore happens at the top of a
  // tick and that tick then completes, so the world resumes one step after the
  // checkpoint rather than freezing on it. That is the right behaviour for a
  // place other people are standing in.
  world.onCommand('build.undo', (w) => {
    const stack = w.store('undo');
    const entry = stack.undo(w.checkpoint());
    if (!entry) return;
    w.load(entry.checkpoint);
    w.emit({
      operation: 'world.undone',
      class: EventClass.LIFECYCLE,
      payload: { label: entry.label, tick: entry.tick },
    });
  });

  world.onCommand('build.redo', (w) => {
    const stack = w.store('undo');
    const entry = stack.redo(w.checkpoint());
    if (!entry) return;
    w.load(entry.checkpoint);
    w.emit({
      operation: 'world.redone',
      class: EventClass.LIFECYCLE,
      payload: { label: entry.label, tick: entry.tick },
    });
  });

  world.onCommand('build.paste', (w, payload) => {
    remember('paste item');
    const root = importItem(w, payload.item, payload.transform ?? {});
    w.emit({
      operation: 'item.pasted',
      class: EventClass.LIFECYCLE,
      target: `slot:${handleIndex(root)}`,
      payload: { name: payload.item?.name ?? 'item', slots: descendantsOf(w, root).length + 1 },
    });
  });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export function spawnPrimitive(world, options = {}) {
  installBuild(world);
  const assets = world.store('assets');
  const kind = PRIMITIVES.includes(options.kind) ? options.kind : 'box';
  const params = options.params ?? {};
  const key = `primitive:${kind}:${JSON.stringify(params)}`;

  // The mesh is a function of the descriptor, so a thousand identical boxes are
  // one mesh — and a saved item stores four numbers instead of a vertex buffer.
  const meshId = assets.add('mesh', key, makePrimitive(kind, params), {
    name: kind,
    primitive: { kind, params },
    triangles: 0,
  });
  const mesh = assets.get(meshId);
  mesh.meta.triangles = mesh.value.indices.length / 3;
  mesh.meta.vertices = mesh.value.vertexCount;

  const colour = options.color ?? PALETTE[(options.palette ?? 0) % PALETTE.length];
  const materialId = assets.add('material', `built:${colour.map((c) => c.toFixed(3)).join(',')}`, {
    name: 'built',
    baseColor: colour,
    baseColorTexture: 0,
    metallic: 0.05,
    roughness: 0.55,
    emissive: [colour[0] * 0.06, colour[1] * 0.06, colour[2] * 0.06],
    doubleSided: false,
    alphaMode: 'OPAQUE',
  });

  const scale = options.scale ?? 1;
  const handle = createSlot(world, {
    name: options.name ?? kind,
    position: options.position ?? [0, 0, 0],
    rotation: options.rotation ?? [0, 0, 0, 1],
    scale: [scale, scale, scale],
  });
  assets.retain(meshId);
  assets.retain(materialId);
  world.ecs.add(handle, 'MeshRenderer', { mesh: meshId, material: materialId, layer: 0, visible: 1 });
  world.ecs.add(handle, 'Grabbable', { mass: options.mass ?? 1, held: 0, locked: 0 });
  world.ecs.add(handle, 'Spawned', {
    kind: PRIMITIVES.indexOf(kind),
    variant: options.palette ?? 0,
    birth: world.tick,
  });
  world.store('scene').tag(handleIndex(handle), 'built');

  world.emit({
    operation: 'slot.spawned',
    class: EventClass.LIFECYCLE,
    target: `slot:${handleIndex(handle)}`,
    payload: {
      kind,
      x: round(options.position?.[0] ?? 0),
      y: round(options.position?.[2] ?? 0),
      triangles: mesh.meta.triangles,
    },
  });
  return handle;
}

/** Deep-copy a slot and everything under it. */
export function duplicateSlot(world, handle, offset = [0, 0, 0]) {
  const ecs = world.ecs;
  const scene = world.store('scene');
  const assets = world.store('assets');

  const copyOne = (source, parent, shift) => {
    const local = ecs.get(source, 'LocalTransform');
    const copy = createSlot(world, {
      name: `${scene.name(handleIndex(source)) ?? 'Slot'}${parent === null ? ' copy' : ''}`,
      parent,
      position: [local.px + shift[0], local.py + shift[1], local.pz + shift[2]],
      rotation: [local.rx, local.ry, local.rz, local.rw],
      scale: [local.sx, local.sy, local.sz],
    });
    for (const component of ecs.componentsOf(source)) {
      if (['Slot', 'LocalTransform', 'WorldTransform', 'Held'].includes(component)) continue;
      const values = ecs.get(source, component);
      ecs.add(copy, component, values);
      if (component === 'MeshRenderer' || component === 'SkinnedRenderer') {
        assets.retain(values.mesh);
        assets.retain(values.material);
      }
    }
    for (const tag of scene.tags.get(handleIndex(source)) ?? []) scene.tag(handleIndex(copy), tag);
    for (const child of childrenOf(world, source)) copyOne(child, copy, [0, 0, 0]);
    return copy;
  };

  return copyOne(handle, null, offset);
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

/**
 * The nearest slot a ray hits.
 *
 * World-space bounding boxes, not triangles: a build tool needs to feel
 * immediate more than it needs to be exact, and an oriented box around a chair
 * is what a user is pointing at anyway.
 */
export function raycastSlots(world, origin, direction, options = {}) {
  const maxDistance = options.maxDistance ?? 40;
  const assets = world.store('assets');
  const ecs = world.ecs;
  let best = null;
  const scratch = { p: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] };
  const matrix = new Float32Array(16);

  for (const component of ['MeshRenderer', 'SkinnedRenderer']) {
    for (const chunk of ecs.query([component, 'WorldTransform'])) {
      const mesh = chunk.col(component, 'mesh');
      const visible = chunk.col(component, 'visible');
      for (let i = 0; i < chunk.count; i++) {
        if (!visible[i]) continue;
        const handle = chunk.entity(i);
        if (options.ignore?.includes(handle)) continue;
        const asset = assets.get(mesh[i]);
        if (!asset?.value?.bounds) continue;

        const t = ecs.get(handle, 'WorldTransform');
        scratch.p[0] = t.px; scratch.p[1] = t.py; scratch.p[2] = t.pz;
        scratch.r[0] = t.rx; scratch.r[1] = t.ry; scratch.r[2] = t.rz; scratch.r[3] = t.rw;
        scratch.s[0] = t.sx; scratch.s[1] = t.sy; scratch.s[2] = t.sz;
        transformMatrix(scratch, matrix);

        const world_ = transformBounds(asset.value.bounds, matrix);
        const hit = intersectAABB(origin, direction, world_.min, world_.max);
        if (hit === null || hit > maxDistance) continue;
        if (!best || hit < best.distance) {
          best = { handle, distance: hit, bounds: world_, component };
        }
      }
    }
  }
  return best;
}

function transformBounds(bounds, matrix) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? bounds.max[0] : bounds.min[0];
    const y = corner & 2 ? bounds.max[1] : bounds.min[1];
    const z = corner & 4 ? bounds.max[2] : bounds.min[2];
    const wx = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    const wy = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    const wz = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    min[0] = Math.min(min[0], wx); max[0] = Math.max(max[0], wx);
    min[1] = Math.min(min[1], wy); max[1] = Math.max(max[1], wy);
    min[2] = Math.min(min[2], wz); max[2] = Math.max(max[2], wz);
  }
  return { min, max };
}

/** Slab test. Returns the entry distance, or null. */
export function intersectAABB(origin, direction, min, max) {
  let near = -Infinity;
  let far = Infinity;
  const o = [origin.x ?? origin[0], origin.y ?? origin[1], origin.z ?? origin[2]];
  const d = [direction.x ?? direction[0], direction.y ?? direction[1], direction.z ?? direction[2]];
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(d[axis]) < 1e-9) {
      if (o[axis] < min[axis] || o[axis] > max[axis]) return null;
      continue;
    }
    const inverse = 1 / d[axis];
    let t0 = (min[axis] - o[axis]) * inverse;
    let t1 = (max[axis] - o[axis]) * inverse;
    if (t0 > t1) [t0, t1] = [t1, t0];
    near = Math.max(near, t0);
    far = Math.min(far, t1);
    if (near > far) return null;
  }
  return far < 0 ? null : Math.max(0, near);
}

// ---------------------------------------------------------------------------
// Items — a slot subtree you can keep
// ---------------------------------------------------------------------------

/**
 * Serialize a slot subtree.
 *
 * Primitives are stored as their descriptor, so an item is a few hundred bytes
 * rather than a vertex buffer. Imported meshes are stored by asset key: the
 * item says which mesh it wants, and re-importing the source brings it back.
 */
export function exportItem(world, root) {
  const ecs = world.ecs;
  const scene = world.store('scene');
  const assets = world.store('assets');
  const order = [root, ...descendantsOf(world, root)];
  const indexOf = new Map(order.map((handle, i) => [handleIndex(handle), i]));

  const slots = order.map((handle) => {
    const local = ecs.get(handle, 'LocalTransform');
    const slot = ecs.get(handle, 'Slot');
    const components = {};
    for (const name of ecs.componentsOf(handle)) {
      if (['Slot', 'LocalTransform', 'WorldTransform', 'Held'].includes(name)) continue;
      components[name] = ecs.get(handle, name);
    }
    const renderer = components.MeshRenderer ?? components.SkinnedRenderer;
    return {
      name: scene.name(handleIndex(handle)),
      parent: indexOf.get(slot.parent) ?? -1,
      position: [local.px, local.py, local.pz],
      rotation: [local.rx, local.ry, local.rz, local.rw],
      scale: [local.sx, local.sy, local.sz],
      tags: [...(scene.tags.get(handleIndex(handle)) ?? [])],
      components,
      mesh: renderer ? describeAsset(assets, renderer.mesh) : null,
      material: renderer ? describeAsset(assets, renderer.material) : null,
    };
  });

  return {
    format: 'latticeborn.item',
    version: 1,
    name: slotName(world, root),
    slots,
  };
}

function describeAsset(assets, id) {
  const asset = assets.get(id);
  if (!asset) return null;
  if (asset.kind === 'mesh' && asset.meta.primitive) {
    return { kind: 'primitive', shape: asset.meta.primitive.kind, params: asset.meta.primitive.params ?? {} };
  }
  if (asset.kind === 'material') {
    return { kind: 'material', ...asset.value };
  }
  return { kind: 'reference', key: asset.key };
}

/** Rebuild an exported item. Anything it cannot resolve becomes an empty slot. */
export function importItem(world, item, transform = {}) {
  installBuild(world);
  if (item?.format !== 'latticeborn.item') throw new Error('not a latticeborn item');
  const assets = world.store('assets');
  const scene = world.store('scene');
  const handles = [];

  for (const [index, spec] of item.slots.entries()) {
    const isRoot = spec.parent < 0;
    const position = isRoot
      ? (transform.position ?? spec.position)
      : spec.position;
    const scale = isRoot && transform.scale ? [transform.scale, transform.scale, transform.scale] : spec.scale;
    const handle = createSlot(world, {
      name: spec.name,
      parent: isRoot ? null : handles[spec.parent],
      position,
      rotation: isRoot ? (transform.rotation ?? spec.rotation) : spec.rotation,
      scale,
    });
    handles[index] = handle;
    for (const tag of spec.tags ?? []) scene.tag(handleIndex(handle), tag);

    if (spec.mesh?.kind === 'primitive') {
      const params = spec.mesh.params ?? {};
      const meshId = assets.add('mesh', `primitive:${spec.mesh.shape}:${JSON.stringify(params)}`,
        makePrimitive(spec.mesh.shape, params), { name: spec.mesh.shape, primitive: { kind: spec.mesh.shape, params } });
      const meshAsset = assets.get(meshId);
      meshAsset.meta.triangles = meshAsset.value.indices.length / 3;
      meshAsset.meta.vertices = meshAsset.value.vertexCount;
      const materialId = spec.material?.kind === 'material'
        ? assets.add('material', `built:${(spec.material.baseColor ?? []).map((c) => c.toFixed(3)).join(',')}`, spec.material, { name: 'built' })
        : assets.add('material', 'builtin:default', { name: 'default', baseColor: [0.8, 0.8, 0.85, 1], baseColorTexture: 0, metallic: 0, roughness: 0.8, emissive: [0, 0, 0] }, { pinned: true });
      assets.retain(meshId);
      assets.retain(materialId);
      world.ecs.add(handle, 'MeshRenderer', { mesh: meshId, material: materialId, layer: 0, visible: 1 });
    }

    for (const [name, values] of Object.entries(spec.components ?? {})) {
      if (name === 'MeshRenderer' || name === 'SkinnedRenderer') continue;
      if (!world.registry.has(name)) continue;
      world.ecs.add(handle, name, values);
    }
  }
  return handles[0];
}

// ---------------------------------------------------------------------------

export function heldSlots(world) {
  const out = [];
  for (const chunk of world.ecs.query(['Held'])) {
    for (let i = 0; i < chunk.count; i++) out.push(chunk.entity(i));
  }
  return out;
}

/** Slots that were built rather than imported or generated. */
export function builtSlots(world) {
  const out = [];
  for (const chunk of world.ecs.query(['Spawned'])) {
    for (let i = 0; i < chunk.count; i++) out.push(chunk.entity(i));
  }
  return out;
}

function resolveSlot(world, index) {
  if (index === undefined || index === null || index < 0) return null;
  const arch = world.ecs._archOf[index];
  if (!arch) return null;
  const handle = arch.entities[world.ecs._rowOf[index]];
  return handle && world.ecs.alive(handle) && world.ecs.has(handle, 'Slot') ? handle : null;
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

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function round(value) {
  return Math.round(value * 10) / 10;
}
