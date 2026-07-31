// The semantic graph — meaning and relationships.
//
//   Alice OWNS Ship-7
//
// Components say what an entity physically is right now. The graph says what it
// means, to whom, and since when. Edges carry provenance (the tick and the
// event that created them) so any relationship can be traced back to its cause.

import { Digest, commutativeMix } from './hash.js';

export class SemanticGraph {
  constructor() {
    this.edges = [];
    this._bySubject = new Map();
    this._byObject = new Map();
    this._byPredicate = new Map();
    this._live = 0;
  }

  get size() {
    return this._live;
  }

  add(subject, predicate, object, meta = {}) {
    const edge = {
      id: this.edges.length,
      s: String(subject),
      p: String(predicate),
      o: String(object),
      since: meta.tick ?? 0,
      cause: meta.cause ?? null,
      weight: meta.weight ?? 1,
      dead: false,
    };
    this.edges.push(edge);
    index(this._bySubject, edge.s, edge.id);
    index(this._byObject, edge.o, edge.id);
    index(this._byPredicate, edge.p, edge.id);
    this._live++;
    return edge;
  }

  /** Tombstone rather than splice: history stays inspectable. */
  remove(subject, predicate, object) {
    let removed = 0;
    for (const edge of this.query({ s: subject, p: predicate, o: object })) {
      edge.dead = true;
      this._live--;
      removed++;
    }
    return removed;
  }

  /** Replace the object of a functional relationship (ownership, location, ...). */
  reassign(subject, predicate, object, meta = {}) {
    const previous = this.query({ s: subject, p: predicate })[0] ?? null;
    if (previous) {
      previous.dead = true;
      this._live--;
    }
    const edge = this.add(subject, predicate, object, meta);
    edge.replaces = previous ? previous.id : null;
    return { edge, previous };
  }

  query({ s, p, o } = {}) {
    let candidates = null;
    if (s !== undefined) candidates = narrow(candidates, this._bySubject.get(String(s)));
    if (o !== undefined) candidates = narrow(candidates, this._byObject.get(String(o)));
    if (p !== undefined) candidates = narrow(candidates, this._byPredicate.get(String(p)));
    const ids = candidates ?? this.edges.map((e) => e.id);
    const out = [];
    for (const id of ids) {
      const edge = this.edges[id];
      if (edge.dead) continue;
      if (s !== undefined && edge.s !== String(s)) continue;
      if (p !== undefined && edge.p !== String(p)) continue;
      if (o !== undefined && edge.o !== String(o)) continue;
      out.push(edge);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  /** First object of (subject, predicate), or null. */
  one(subject, predicate) {
    const hit = this.query({ s: subject, p: predicate })[0];
    return hit ? hit.o : null;
  }

  out(subject) {
    return this.query({ s: subject });
  }

  in(object) {
    return this.query({ o: object });
  }

  /** Breadth-first walk over outgoing edges, optionally filtered by predicate. */
  reach(subject, { depth = 2, predicates = null } = {}) {
    const seen = new Set([String(subject)]);
    let frontier = [String(subject)];
    const found = [];
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const node of frontier) {
        for (const edge of this.out(node)) {
          if (predicates && !predicates.includes(edge.p)) continue;
          found.push({ ...edge, depth: d + 1 });
          if (!seen.has(edge.o)) {
            seen.add(edge.o);
            next.push(edge.o);
          }
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    return found;
  }

  predicates() {
    const counts = new Map();
    for (const edge of this.edges) {
      if (edge.dead) continue;
      counts.set(edge.p, (counts.get(edge.p) ?? 0) + 1);
    }
    return counts;
  }

  /** Drop tombstones for entities that no longer exist anywhere. */
  prune(isLive) {
    for (const edge of this.edges) {
      if (edge.dead) continue;
      if (!isLive(edge.s) || !isLive(edge.o)) {
        edge.dead = true;
        this._live--;
      }
    }
  }

  /** Deep copy: a checkpoint must be a photograph, not a window. */
  toJSON() {
    return { edges: this.edges.map((edge) => ({ ...edge })) };
  }

  static fromJSON(json) {
    const graph = new SemanticGraph();
    for (const edge of json.edges) {
      graph.edges.push({ ...edge });
      index(graph._bySubject, edge.s, edge.id);
      index(graph._byObject, edge.o, edge.id);
      index(graph._byPredicate, edge.p, edge.id);
      if (!edge.dead) graph._live++;
    }
    return graph;
  }

  digest() {
    const parts = [];
    for (const edge of this.edges) {
      if (edge.dead) continue;
      parts.push(new Digest().str(edge.s).str(edge.p).str(edge.o).int(edge.since).value);
    }
    return commutativeMix(parts);
  }
}

function index(map, key, id) {
  let bucket = map.get(key);
  if (!bucket) map.set(key, (bucket = []));
  bucket.push(id);
}

function narrow(current, incoming) {
  if (!incoming) return [];
  if (!current) return incoming;
  const set = new Set(incoming);
  return current.filter((id) => set.has(id));
}
