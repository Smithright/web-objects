// The projection layer — move meaning, not pixels.
//
// A client never sees the world; it sees the world it can perceive. Each
// observer declares a semantic and spatial horizon, and the server answers with
// entered/exited sets plus component deltas, ordered by priority:
//
//   P0 ownership, authority, immediate self state
//   P1 nearby dynamic entities and consequential events
//   P2 animation, sound, secondary motion
//   P3 distant or slowly changing objects
//   P4 cosmetic, procedural, reconstructible detail
//
// When the tick's budget runs out, low priority is dropped, not delayed —
// a renderer can always reconstruct P4; it can never invent P0.

import { entityKey } from './ids.js';
import { lodFor } from './spatial.js';

export const Priority = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };

/** Bytes a component update costs on the wire, approximated from its schema. */
function costOf(componentType) {
  return 2 + componentType.stride;
}

export class ClientView {
  constructor(id, options) {
    this.id = id;
    this.x = options.x ?? 0;
    this.y = options.y ?? 0;
    this.radius = options.radius ?? 128;
    this.interest = options.interest ?? null; // component allow-list, null = all replicable
    this.owns = new Set(options.owns ?? []);
    this.budgetBytes = options.budgetBytes ?? 4096;
    this.known = new Map(); // entityKey -> { [component]: {field: value} }
    this.lastAckTick = -1;
    this.stats = { sent: 0, dropped: 0, bytes: 0, snapshots: 0 };
  }

  move(x, y) {
    this.x = x;
    this.y = y;
  }
}

export class ProjectionServer {
  constructor(world, options = {}) {
    this.world = world;
    this.clients = new Map();
    // Only these components ever cross the boundary; everything else is
    // simulation-internal and stays server-side by construction.
    this.replicable = options.replicable ?? ['Position', 'Velocity', 'Renderable', 'Health', 'Agent'];
    this.quantum = options.quantum ?? 0.01; // deadband below which a change is not worth sending
  }

  connect(id, options = {}) {
    const view = new ClientView(id, options);
    this.clients.set(id, view);
    return view;
  }

  disconnect(id) {
    this.clients.delete(id);
  }

  get(id) {
    return this.clients.get(id) ?? null;
  }

  /**
   * Build one snapshot for one client. This is the only place the simulation
   * is allowed to be shaped by who is watching.
   */
  snapshot(clientId) {
    const view = this.clients.get(clientId);
    if (!view) throw new Error(`unknown client ${clientId}`);
    const world = this.world;
    const ecs = world.ecs;

    const candidates = world.spatial.queryRadius(view.x, view.y, view.radius);
    const updates = [];
    const seen = new Set();
    let considered = 0;

    for (const handle of candidates) {
      if (!ecs.alive(handle)) continue;
      considered++;
      const key = entityKey(world.universe, handle);
      seen.add(key);
      const pos = ecs.get(handle, 'Position');
      const distance = Math.hypot(pos.x - view.x, pos.y - view.y);
      const owned = view.owns.has(key);
      const lod = lodFor(distance, owned ? 8 : 0);
      const priority = priorityFor(distance, view.radius, owned);
      const known = view.known.get(key);
      const components = {};
      let bytes = 0;

      for (const name of this.replicable) {
        if (view.interest && !view.interest.includes(name)) continue;
        if (!ecs.has(handle, name)) continue;
        // Detail below the observer's level is reconstructed, not replicated.
        if (lod.level < 2 && name === 'Velocity') continue;
        if (lod.level < 1 && name !== 'Position') continue;
        const values = ecs.get(handle, name);
        const previous = known?.[name];
        if (previous && !changed(previous, values, this.quantum)) continue;
        components[name] = values;
        bytes += costOf(ecs.registry.get(name));
      }

      if (!known) {
        updates.push({ key, handle, kind: 'enter', priority, lod: lod.level, distance, components, bytes });
      } else if (bytes > 0) {
        updates.push({ key, handle, kind: 'delta', priority, lod: lod.level, distance, components, bytes });
      }
    }

    const exited = [];
    for (const key of view.known.keys()) {
      if (!seen.has(key)) exited.push(key);
    }
    for (const key of exited) view.known.delete(key);

    // Priority first, then proximity. The budget cuts from the bottom.
    updates.sort((a, b) => a.priority - b.priority || a.distance - b.distance);

    const sent = [];
    let bytes = exited.length * 4;
    let dropped = 0;
    for (const update of updates) {
      if (bytes + update.bytes > view.budgetBytes && update.priority > Priority.P1) {
        dropped++;
        continue;
      }
      bytes += update.bytes;
      sent.push(update);
      const record = view.known.get(update.key) ?? {};
      for (const [name, values] of Object.entries(update.components)) record[name] = { ...values };
      view.known.set(update.key, record);
    }

    const events = world.log
      .atTick(world.tick - 1)
      .filter((e) => this._audible(view, e))
      .slice(0, 32);

    view.stats.snapshots++;
    view.stats.sent += sent.length;
    view.stats.dropped += dropped;
    view.stats.bytes += bytes;
    view.lastAckTick = world.tick;

    return {
      universe: world.universe,
      tick: world.tick,
      origin: { x: view.x, y: view.y, radius: view.radius },
      entered: sent.filter((u) => u.kind === 'enter').map(strip),
      updates: sent.filter((u) => u.kind === 'delta').map(strip),
      exited,
      events,
      stats: {
        considered,
        sent: sent.length,
        dropped,
        bytes,
        budgetBytes: view.budgetBytes,
        tracked: view.known.size,
        // What full-state replication would have cost, for comparison.
        naiveBytes: considered * this.replicable.length * 18,
      },
    };
  }

  /** Events reach a client if they happened inside its horizon or concern it. */
  _audible(view, event) {
    if (event.actor && view.owns.has(event.actor)) return true;
    if (event.target && view.owns.has(event.target)) return true;
    const p = event.payload;
    if (p && typeof p.x === 'number' && typeof p.y === 'number') {
      return Math.hypot(p.x - view.x, p.y - view.y) <= view.radius * 1.5;
    }
    return event.class === 'lifecycle' || event.class === 'narrative';
  }

  /** Aggregate bandwidth across every observer — the projection layer's budget. */
  totals() {
    let bytes = 0;
    let sent = 0;
    let dropped = 0;
    for (const view of this.clients.values()) {
      bytes += view.stats.bytes;
      sent += view.stats.sent;
      dropped += view.stats.dropped;
    }
    return { clients: this.clients.size, bytes, sent, dropped };
  }
}

function priorityFor(distance, radius, owned) {
  if (owned) return Priority.P0;
  const ratio = distance / radius;
  if (ratio < 0.25) return Priority.P1;
  if (ratio < 0.5) return Priority.P2;
  if (ratio < 0.8) return Priority.P3;
  return Priority.P4;
}

function changed(previous, next, quantum) {
  for (const [field, value] of Object.entries(next)) {
    const before = previous[field];
    if (before === undefined) return true;
    if (Math.abs(before - value) > quantum) return true;
  }
  return false;
}

function strip(update) {
  return {
    key: update.key,
    entity: update.handle,
    priority: update.priority,
    lod: update.lod,
    components: update.components,
  };
}
