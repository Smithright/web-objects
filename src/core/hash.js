// Deterministic, allocation-light hashing.
//
// The engine needs a cheap way to answer "are these two worlds the same world?"
// across a replay, a fork, or a wire round-trip. Everything here is FNV-1a over
// a canonical byte order so the same logical state always folds to the same
// 32-bit digest.

const OFFSET_BASIS = 0x811c9dc5;
const PRIME = 0x01000193;

export function fnv1a(str, seed = OFFSET_BASIS) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, PRIME) >>> 0;
    h ^= (str.charCodeAt(i) >>> 8) & 0xff;
    h = Math.imul(h, PRIME) >>> 0;
  }
  return h >>> 0;
}

/** Streaming digest over strings, integers, floats, and typed arrays. */
export class Digest {
  constructor(seed = OFFSET_BASIS) {
    this.h = seed >>> 0;
    this._buf = new ArrayBuffer(8);
    this._view = new DataView(this._buf);
  }

  str(s) {
    this.h = fnv1a(String(s), this.h);
    return this;
  }

  int(n) {
    let v = n | 0;
    for (let i = 0; i < 4; i++) {
      this.h ^= v & 0xff;
      this.h = Math.imul(this.h, PRIME) >>> 0;
      v >>>= 8;
    }
    return this;
  }

  /** Floats are hashed by bit pattern, with -0 folded to +0 and NaN canonical. */
  num(n) {
    let v = n;
    if (v === 0) v = 0;
    else if (Number.isNaN(v)) v = NaN;
    this._view.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) {
      this.h ^= this._view.getUint8(i);
      this.h = Math.imul(this.h, PRIME) >>> 0;
    }
    return this;
  }

  array(values, count = values.length) {
    for (let i = 0; i < count; i++) this.num(values[i]);
    return this;
  }

  /** Fold in a sub-digest without imposing an ordering on the caller. */
  mix(other) {
    return this.int(typeof other === 'number' ? other : other.value);
  }

  get value() {
    return this.h >>> 0;
  }

  get hex() {
    return (this.h >>> 0).toString(16).padStart(8, '0');
  }
}

export function digestOf(fn) {
  const d = new Digest();
  fn(d);
  return d.hex;
}

/**
 * Order-independent combination. Used where a set of per-item digests must fold
 * to one value regardless of the order the items happened to be visited in.
 */
export function commutativeMix(values) {
  let sum = 0;
  let xor = 0;
  for (const v of values) {
    sum = (sum + (v >>> 0)) >>> 0;
    xor ^= v >>> 0;
  }
  return (Math.imul(sum, PRIME) ^ xor) >>> 0;
}
