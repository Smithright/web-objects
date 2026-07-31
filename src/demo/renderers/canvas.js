// A 2D canvas renderer.
//
// It keeps its own local projection state, resolves component values to visual
// facts, and builds its frame however it likes. The world never learns that it
// happened. Nothing here writes to the simulation — the only channel back is a
// command, submitted like any other intent.

import { Kind, WORLD_SIZE } from '../testbed.js';

/** Field colour ramp: cold void → teal → amber → incandescent. */
const RAMP = buildRamp([
  [0.0, [10, 18, 32]],
  [0.18, [16, 46, 62]],
  [0.42, [22, 108, 112]],
  [0.66, [188, 132, 48]],
  [0.85, [238, 186, 92]],
  [1.0, [255, 244, 214]],
]);

function buildRamp(stops, steps = 256) {
  const table = new Uint8ClampedArray(steps * 3);
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    let a = stops[0];
    let b = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (t >= stops[s][0] && t <= stops[s + 1][0]) {
        a = stops[s];
        b = stops[s + 1];
        break;
      }
    }
    const span = b[0] - a[0] || 1;
    const k = (t - a[0]) / span;
    for (let c = 0; c < 3; c++) table[i * 3 + c] = a[1][c] + (b[1][c] - a[1][c]) * k;
  }
  return table;
}

export function createCanvasRenderer(canvas, options = {}) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const fieldName = options.field ?? 'heat';
  let fieldImage = null;
  let scratch = null;

  function ensureFieldBuffer(width, height) {
    if (fieldImage && fieldImage.width === width && fieldImage.height === height) return;
    scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;
    fieldImage = scratch.getContext('2d').createImageData(width, height);
  }

  function draw(world, view = {}) {
    const size = view.size ?? WORLD_SIZE;
    const scale = canvas.width / size;
    const horizon = view.horizon ?? null;
    const dim = view.dimOutsideHorizon ?? true;

    // 1. The field, drawn as an image and let the GPU smooth it.
    const field = world.fields.get(fieldName);
    if (field) {
      ensureFieldBuffer(field.width, field.height);
      const pixels = fieldImage.data;
      const gain = view.fieldGain ?? 1.15;
      for (let i = 0; i < field.data.length; i++) {
        // Soft saturation: a beacon core is thousands of times hotter than the
        // halo an agent actually steers on, and the halo is the interesting part.
        const level = Math.round(255 * (1 - Math.exp(-Math.max(0, field.data[i]) * gain)));
        pixels[i * 4] = RAMP[level * 3];
        pixels[i * 4 + 1] = RAMP[level * 3 + 1];
        pixels[i * 4 + 2] = RAMP[level * 3 + 2];
        pixels[i * 4 + 3] = 255;
      }
      scratch.getContext('2d').putImageData(fieldImage, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(scratch, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = '#0a1220';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // 2. Entities, batched by kind so the whole population is a few paths.
    const motes = [];
    const foragers = [];
    const rogues = [];
    const beacons = [];
    for (const chunk of world.ecs.query(['Position', 'Renderable'])) {
      const px = chunk.col('Position', 'x');
      const py = chunk.col('Position', 'y');
      const kind = chunk.col('Renderable', 'kind');
      const hue = chunk.col('Renderable', 'hue');
      for (let i = 0; i < chunk.count; i++) {
        const bucket =
          kind[i] === Kind.BEACON ? beacons : kind[i] === Kind.MOTE ? motes : hue[i] < 0.2 ? rogues : foragers;
        bucket.push(px[i] * scale, py[i] * scale);
      }
    }

    if (horizon && dim) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, canvas.width, canvas.height);
      ctx.clip();
    }

    paintPoints(ctx, motes, 1.1 * scale, 'rgba(150, 196, 255, 0.75)');
    paintPoints(ctx, foragers, 2.4 * scale, 'rgba(120, 246, 200, 0.95)');
    paintPoints(ctx, rogues, 2.4 * scale, 'rgba(255, 122, 118, 0.95)');
    paintBeacons(ctx, beacons, scale);

    if (horizon && dim) ctx.restore();

    // 3. The observer's horizon — what the projection layer is actually sending.
    if (horizon) {
      ctx.save();
      ctx.strokeStyle = 'rgba(140, 214, 255, 0.85)';
      ctx.lineWidth = 1.25;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.arc(horizon.x * scale, horizon.y * scale, horizon.radius * scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(140, 214, 255, 0.06)';
      ctx.fill();
      ctx.restore();
    }

    return { motes: motes.length / 2, foragers: foragers.length / 2, rogues: rogues.length / 2 };
  }

  return { draw, canvas, ctx };
}

function paintPoints(ctx, coords, radius, style) {
  if (!coords.length) return;
  ctx.fillStyle = style;
  ctx.beginPath();
  for (let i = 0; i < coords.length; i += 2) {
    ctx.moveTo(coords[i] + radius, coords[i + 1]);
    ctx.arc(coords[i], coords[i + 1], radius, 0, Math.PI * 2);
  }
  ctx.fill();
}

function paintBeacons(ctx, coords, scale) {
  for (let i = 0; i < coords.length; i += 2) {
    const x = coords[i];
    const y = coords[i + 1];
    const glow = ctx.createRadialGradient(x, y, 0, x, y, 16 * scale);
    glow.addColorStop(0, 'rgba(255, 226, 150, 0.9)');
    glow.addColorStop(1, 'rgba(255, 196, 90, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, 16 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff3d0';
    ctx.beginPath();
    ctx.arc(x, y, 3 * scale, 0, Math.PI * 2);
    ctx.fill();
  }
}
