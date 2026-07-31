// Spatial services.
//
// A uniform hash grid: rebuilt each tick from Position, queried by everything
// that cares about locality — neighbour search, interest management, and the
// LOD ladder that decides how much reality each region deserves right now.

export class SpatialHash {
  constructor(cellSize = 16) {
    this.cellSize = cellSize;
    this.cells = new Map(); // "cx,cy" -> handle[]
    this.positions = new Map(); // handle -> {x, y}
    this.count = 0;
  }

  clear() {
    this.cells.clear();
    this.positions.clear();
    this.count = 0;
  }

  key(cx, cy) {
    return `${cx},${cy}`;
  }

  cellOf(x, y) {
    return { cx: Math.floor(x / this.cellSize), cy: Math.floor(y / this.cellSize) };
  }

  insert(handle, x, y) {
    const { cx, cy } = this.cellOf(x, y);
    const key = this.key(cx, cy);
    let bucket = this.cells.get(key);
    if (!bucket) this.cells.set(key, (bucket = []));
    bucket.push(handle);
    this.positions.set(handle, { x, y });
    this.count++;
  }

  cell(cx, cy) {
    return this.cells.get(this.key(cx, cy)) ?? [];
  }

  /** Handles within `radius` of (x, y). Exact — the grid only narrows the search. */
  queryRadius(x, y, radius, out = []) {
    out.length = 0;
    const r2 = radius * radius;
    const min = this.cellOf(x - radius, y - radius);
    const max = this.cellOf(x + radius, y + radius);
    for (let cy = min.cy; cy <= max.cy; cy++) {
      for (let cx = min.cx; cx <= max.cx; cx++) {
        for (const handle of this.cell(cx, cy)) {
          const p = this.positions.get(handle);
          const dx = p.x - x;
          const dy = p.y - y;
          if (dx * dx + dy * dy <= r2) out.push(handle);
        }
      }
    }
    return out;
  }

  nearest(x, y, radius) {
    let best = null;
    let bestDist = Infinity;
    for (const handle of this.queryRadius(x, y, radius)) {
      const p = this.positions.get(handle);
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = handle;
      }
    }
    return best === null ? null : { handle: best, distance: Math.sqrt(bestDist) };
  }

  occupiedCells() {
    return this.cells.size;
  }

  /** Cell occupancy histogram — the density signal the LOD ladder reads. */
  density() {
    const out = [];
    for (const [key, bucket] of this.cells) {
      const [cx, cy] = key.split(',').map(Number);
      out.push({ cx, cy, count: bucket.length });
    }
    out.sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));
    return out;
  }
}

/**
 * The multi-resolution ladder:
 *
 *   L4 scientific · L3 detailed · L2 interactive · L1 coarse agents · L0 aggregate
 *
 * Distance is the default driver, but importance (ownership, mission relevance,
 * causal weight) can promote a region the observer is not standing in.
 */
export const LOD_BANDS = [
  { level: 4, label: 'scientific', maxDistance: 24 },
  { level: 3, label: 'detailed', maxDistance: 64 },
  { level: 2, label: 'interactive', maxDistance: 160 },
  { level: 1, label: 'coarse', maxDistance: 384 },
  { level: 0, label: 'aggregate', maxDistance: Infinity },
];

export function lodFor(distance, importance = 0) {
  const effective = distance / (1 + Math.max(0, importance));
  for (const band of LOD_BANDS) {
    if (effective <= band.maxDistance) return band;
  }
  return LOD_BANDS[LOD_BANDS.length - 1];
}

/** Simulation cost multiplier for a level — how much fidelity that band buys. */
export function lodCost(level) {
  return [0.02, 0.1, 1, 4, 16][level] ?? 1;
}
