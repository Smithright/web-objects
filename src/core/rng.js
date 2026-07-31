// Deterministic pseudo-randomness.
//
// Simulation randomness must be reproducible across replay, rollback, and
// branch: same seed and same call order produce the same stream. `fork` derives
// an independent, named sub-stream so a system can draw numbers without
// disturbing the sequence any other system observes.

import { fnv1a } from './hash.js';

export function seedFrom(...parts) {
  let h = 0x9e3779b9;
  for (const p of parts) h = fnv1a(String(p), h);
  return h >>> 0 || 1;
}

export class Rng {
  constructor(seed = 1) {
    this.state = (typeof seed === 'string' ? seedFrom(seed) : seed >>> 0) || 1;
  }

  /** xorshift32 — small, fast, and adequate for world generation and jitter. */
  nextUint() {
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x || 1;
    return this.state;
  }

  /** [0, 1) */
  next() {
    return this.nextUint() / 4294967296;
  }

  /** [min, max) */
  range(min, max) {
    return min + this.next() * (max - min);
  }

  /** [0, n) integer */
  int(n) {
    return Math.floor(this.next() * n);
  }

  bool(p = 0.5) {
    return this.next() < p;
  }

  pick(array) {
    return array[this.int(array.length)];
  }

  /** Approximately normal via the sum of twelve uniforms, mean 0 stddev 1. */
  gauss() {
    let s = 0;
    for (let i = 0; i < 12; i++) s += this.next();
    return s - 6;
  }

  /** Named, independent sub-stream. Deterministic in the parent's current state. */
  fork(label) {
    return new Rng(fnv1a(String(label), this.state));
  }

  snapshot() {
    return this.state;
  }

  restore(state) {
    this.state = (state >>> 0) || 1;
  }
}

/** Stateless hash-to-unit-float, for procedural lattices that must not carry state. */
export function hashUnit(...parts) {
  return seedFrom(...parts) / 4294967296;
}
