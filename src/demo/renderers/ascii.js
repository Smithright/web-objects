// A terminal renderer.
//
// It holds no authority over the world: it takes a projection, resolves it to
// glyphs, and draws. Swapping it for O3DE, Godot, or WebGPU changes nothing on
// the simulation side — which is the entire claim the engine is making.

import { Kind } from '../testbed.js';
import { WORLD_SIZE } from '../testbed.js';

const HEAT_RAMP = [' ', '.', ':', '-', '=', '+', '*', '#', '%', '@'];
const HEAT_COLORS = [237, 238, 240, 242, 130, 166, 202, 208, 214, 220];

export function renderAscii(world, options = {}) {
  const width = options.width ?? 78;
  const height = options.height ?? 30;
  const color = options.color ?? true;
  const view = options.view ?? { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2, radius: WORLD_SIZE / 2 };

  const left = view.x - view.radius;
  const top = view.y - view.radius;
  const spanX = view.radius * 2;
  const spanY = view.radius * 2;

  const glyphs = new Array(width * height).fill(null);
  const heat = world.field('heat');

  // Background: the continuous field, sampled at cell centres.
  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      const wx = left + ((cx + 0.5) / width) * spanX;
      const wy = top + ((cy + 0.5) / height) * spanY;
      const value = heat.sample(wx, wy);
      const level = Math.max(0, Math.min(HEAT_RAMP.length - 1, Math.floor(value * 7)));
      glyphs[cy * width + cx] = { char: HEAT_RAMP[level], color: HEAT_COLORS[level], weight: 0 };
    }
  }

  // Foreground: entities, highest priority last.
  for (const chunk of world.ecs.query(['Position', 'Renderable'])) {
    const px = chunk.col('Position', 'x');
    const py = chunk.col('Position', 'y');
    const kind = chunk.col('Renderable', 'kind');
    const hue = chunk.col('Renderable', 'hue');
    for (let i = 0; i < chunk.count; i++) {
      const cx = Math.floor(((px[i] - left) / spanX) * width);
      const cy = Math.floor(((py[i] - top) / spanY) * height);
      if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
      const slot = cy * width + cx;
      const style = styleFor(kind[i], hue[i]);
      if (style.weight >= glyphs[slot].weight) glyphs[slot] = style;
    }
  }

  const lines = [];
  for (let cy = 0; cy < height; cy++) {
    let line = '';
    let current = -1;
    for (let cx = 0; cx < width; cx++) {
      const cell = glyphs[cy * width + cx];
      if (color && cell.color !== current) {
        line += `[38;5;${cell.color}m`;
        current = cell.color;
      }
      line += cell.char;
    }
    lines.push(color ? `${line}[0m` : line);
  }
  return lines.join('\n');
}

function styleFor(kind, hue) {
  switch (kind) {
    case Kind.BEACON:
      return { char: '@', color: 220, weight: 3 };
    case Kind.FORAGER:
      return hue < 0.2
        ? { char: 'x', color: 203, weight: 2 } // rogue: runs the law that oversteps
        : { char: 'o', color: 84, weight: 2 };
    case Kind.MOTE:
    default:
      return { char: '·', color: 75, weight: 1 };
  }
}

export function renderLegend(color = true) {
  const items = [
    ['@', 'beacon', 220],
    ['o', 'forager', 84],
    ['x', 'rogue agent', 203],
    ['·', 'mote', 75],
    ['░▒▓', 'heat field', 208],
  ];
  return items
    .map(([glyph, label, c]) => (color ? `[38;5;${c}m${glyph}[0m ${label}` : `${glyph} ${label}`))
    .join('   ');
}
