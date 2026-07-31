// Continuous fields — temperature(x, y, t) and friends.
//
// Not every quantity belongs to an entity. Heat, moisture, pressure, and
// nutrient density are properties of space itself, and they are cheaper and
// more faithful to solve on a grid than to scatter across a million components.
// Entities deposit into fields and sample from them; the field evolves under
// its own law.

import { Digest } from './hash.js';

export class ScalarField {
  constructor({
    name,
    width,
    height,
    cellSize = 1,
    origin = { x: 0, y: 0 },
    diffusion = 0.1,
    decay = 0,
    ambient = 0,
  }) {
    this.name = name;
    this.width = width;
    this.height = height;
    this.cellSize = cellSize;
    this.origin = origin;
    this.diffusion = diffusion;
    this.decay = decay;
    this.ambient = ambient;
    this.data = new Float64Array(width * height);
    this._scratch = new Float64Array(width * height);
  }

  index(cx, cy) {
    return cy * this.width + cx;
  }

  inBounds(cx, cy) {
    return cx >= 0 && cy >= 0 && cx < this.width && cy < this.height;
  }

  cellOf(x, y) {
    return {
      cx: Math.floor((x - this.origin.x) / this.cellSize),
      cy: Math.floor((y - this.origin.y) / this.cellSize),
    };
  }

  get(cx, cy) {
    if (!this.inBounds(cx, cy)) return this.ambient;
    return this.data[this.index(cx, cy)];
  }

  set(cx, cy, value) {
    if (!this.inBounds(cx, cy)) return;
    this.data[this.index(cx, cy)] = value;
  }

  /** Bilinear sample in world coordinates. */
  sample(x, y) {
    const fx = (x - this.origin.x) / this.cellSize - 0.5;
    const fy = (y - this.origin.y) / this.cellSize - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const c00 = this.get(x0, y0);
    const c10 = this.get(x0 + 1, y0);
    const c01 = this.get(x0, y0 + 1);
    const c11 = this.get(x0 + 1, y0 + 1);
    return c00 * (1 - tx) * (1 - ty) + c10 * tx * (1 - ty) + c01 * (1 - tx) * ty + c11 * tx * ty;
  }

  /** Central-difference gradient — what a heat-seeking agent actually steers on. */
  gradient(x, y, out = { x: 0, y: 0 }) {
    const h = this.cellSize;
    out.x = (this.sample(x + h, y) - this.sample(x - h, y)) / (2 * h);
    out.y = (this.sample(x, y + h) - this.sample(x, y - h)) / (2 * h);
    return out;
  }

  deposit(x, y, amount) {
    const { cx, cy } = this.cellOf(x, y);
    if (!this.inBounds(cx, cy)) return false;
    this.data[this.index(cx, cy)] += amount;
    return true;
  }

  /** Explicit diffusion with a 5-point Laplacian, plus decay toward ambient. */
  step(dt) {
    const { width: w, height: h, data, _scratch: next } = this;
    // Stability limit for the explicit scheme: D * dt / dx^2 <= 0.25 in 2D.
    const alpha = Math.min(0.24, this.diffusion * dt);
    const keep = Math.max(0, 1 - this.decay * dt);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const c = data[i];
        const l = x > 0 ? data[i - 1] : c;
        const r = x < w - 1 ? data[i + 1] : c;
        const u = y > 0 ? data[i - w] : c;
        const d = y < h - 1 ? data[i + w] : c;
        const laplacian = l + r + u + d - 4 * c;
        next[i] = this.ambient + (c + alpha * laplacian - this.ambient) * keep;
      }
    }
    this.data.set(next);
  }

  total() {
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) sum += this.data[i];
    return sum;
  }

  max() {
    let m = -Infinity;
    for (let i = 0; i < this.data.length; i++) m = Math.max(m, this.data[i]);
    return m;
  }

  /** Coarse tile used by the projection layer: fields replicate at LOD too. */
  downsample(factor) {
    const w = Math.max(1, Math.floor(this.width / factor));
    const h = Math.max(1, Math.floor(this.height / factor));
    const out = new Float64Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let n = 0;
        for (let dy = 0; dy < factor; dy++) {
          for (let dx = 0; dx < factor; dx++) {
            const sx = x * factor + dx;
            const sy = y * factor + dy;
            if (!this.inBounds(sx, sy)) continue;
            sum += this.data[this.index(sx, sy)];
            n++;
          }
        }
        out[y * w + x] = n ? sum / n : 0;
      }
    }
    return { width: w, height: h, data: out };
  }

  toJSON() {
    return {
      name: this.name,
      width: this.width,
      height: this.height,
      cellSize: this.cellSize,
      origin: this.origin,
      diffusion: this.diffusion,
      decay: this.decay,
      ambient: this.ambient,
      data: Array.from(this.data),
    };
  }

  static fromJSON(json) {
    const field = new ScalarField(json);
    field.data.set(json.data);
    return field;
  }

  digest() {
    const d = new Digest().str(this.name).int(this.width).int(this.height);
    return d.array(this.data).value;
  }
}
