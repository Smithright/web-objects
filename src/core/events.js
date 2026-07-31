// The event log — causality as data.
//
//   World[t] + Commands[t] + Laws[v] -> World[t+1]
//
// Every consequential transition is appended here with its causal parent, so a
// world can be replayed from a checkpoint, forked at any tick, or audited after
// the fact. The log is append-only; a segment is sealed by the running digest
// of everything before it, which is what makes tampering detectable.

export const SCHEMA_VERSION = 1;

export const EventClass = {
  COMMAND: 'command', // an intent submitted from outside the simulation
  CONSEQUENCE: 'consequence', // something the laws decided
  LIFECYCLE: 'lifecycle', // spawn, destroy, migrate
  NARRATIVE: 'narrative', // agent speech, observations, annotations
};

export class EventLog {
  constructor(universeId, options = {}) {
    this.universeId = universeId;
    this.events = [];
    this.seq = options.startSeq ?? 0;
    this.digest = options.startDigest ?? 0x811c9dc5;
    this.segmentSize = options.segmentSize ?? 4096;
    this.retain = options.retain ?? Infinity; // events kept resident in memory
    this.pruned = 0;
  }

  get length() {
    return this.events.length + this.pruned;
  }

  append(event) {
    const record = {
      universe_id: this.universeId,
      tick: event.tick ?? 0,
      event_id: `${this.universeId}:${this.seq++}`,
      causal_parent: event.causal_parent ?? null,
      actor: event.actor ?? null,
      target: event.target ?? null,
      operation: event.operation,
      payload: event.payload ?? {},
      class: event.class ?? EventClass.CONSEQUENCE,
      schema_version: event.schema_version ?? SCHEMA_VERSION,
    };
    this.digest = hashEvent(record, this.digest);
    record.seal = this.digest >>> 0;
    this.events.push(record);
    if (this.events.length > this.retain) {
      this.pruned += this.events.length - this.retain;
      this.events.splice(0, this.events.length - this.retain);
    }
    return record;
  }

  /** Events at or after `tick`, in causal order. */
  since(tick) {
    return this.events.filter((e) => e.tick >= tick);
  }

  between(fromTick, toTick) {
    return this.events.filter((e) => e.tick >= fromTick && e.tick < toTick);
  }

  atTick(tick) {
    return this.events.filter((e) => e.tick === tick);
  }

  ofOperation(operation) {
    return this.events.filter((e) => e.operation === operation);
  }

  byId(eventId) {
    return this.events.find((e) => e.event_id === eventId) ?? null;
  }

  /** Walk causal_parent links back to a root cause. */
  ancestry(eventId, limit = 32) {
    const chain = [];
    let current = this.byId(eventId);
    while (current && chain.length < limit) {
      chain.push(current);
      current = current.causal_parent ? this.byId(current.causal_parent) : null;
    }
    return chain;
  }

  tail(n = 20) {
    return this.events.slice(-n);
  }

  counts() {
    const out = new Map();
    for (const e of this.events) out.set(e.operation, (out.get(e.operation) ?? 0) + 1);
    return out;
  }

  /** Verify the seal chain from a known-good starting digest. */
  verify(startDigest = 0x811c9dc5) {
    let d = startDigest >>> 0;
    for (const e of this.events) {
      d = hashEvent(e, d);
      if ((e.seal >>> 0) !== (d >>> 0)) return { ok: false, at: e.event_id };
    }
    return { ok: true, digest: d >>> 0 };
  }

  toJSON() {
    return {
      universe_id: this.universeId,
      seq: this.seq,
      digest: this.digest,
      pruned: this.pruned,
      events: this.events.map((event) => ({ ...event })),
    };
  }

  static fromJSON(json) {
    const log = new EventLog(json.universe_id, { startSeq: json.seq, startDigest: json.digest });
    log.events = json.events.map((e) => ({ ...e }));
    log.pruned = json.pruned ?? 0;
    return log;
  }
}

const PRIME = 0x01000193;

function hashString(str, h) {
  let x = h >>> 0;
  for (let i = 0; i < str.length; i++) {
    x ^= str.charCodeAt(i) & 0xff;
    x = Math.imul(x, PRIME) >>> 0;
  }
  return x >>> 0;
}

/** Hash of an event's identity-bearing fields, excluding the seal itself. */
export function hashEvent(event, seed) {
  let h = seed >>> 0;
  h = hashString(String(event.universe_id), h);
  h = hashString(String(event.tick), h);
  h = hashString(event.event_id, h);
  h = hashString(String(event.causal_parent ?? ''), h);
  h = hashString(String(event.actor ?? ''), h);
  h = hashString(String(event.target ?? ''), h);
  h = hashString(String(event.operation), h);
  h = hashString(canonicalJson(event.payload), h);
  return h >>> 0;
}

/** Key-sorted JSON so payload hashing does not depend on insertion order. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
