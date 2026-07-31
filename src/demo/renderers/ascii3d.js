// The same ray march, in a terminal.
//
// This renderer imports the identical height field the WebGL2 shader compiles
// and the simulation walks on, marches the identical rays, and resolves them to
// characters instead of pixels. It exists to make the engine's central claim
// falsifiable rather than rhetorical: if the world really is independent of the
// renderer, then a terminal is just a very low-bandwidth display, and swapping
// one for a GPU should require nothing of the world at all.

import { SEA_LEVEL, heightAt, normalAt } from '../../core/terrain.js';
import { SPECIES } from '../pandora.js';

const RAMP = ' .:-=+*#%@';
const KEY = normalize(-0.42, 0.46, 0.35);

export function renderAscii3d(world, camera, options = {}) {
  const width = options.width ?? 100;
  const height = options.height ?? 30;
  const color = options.color ?? true;
  const far = options.far ?? 900;
  const steps = options.steps ?? 72;
  const aspect = options.aspect ?? 2.1; // terminal cells are twice as tall as wide

  const lights = gatherLights(world, camera, options.lights ?? 24);
  const marks = gatherMarks(world, camera);
  const lines = [];

  for (let row = 0; row < height; row++) {
    let line = '';
    let lastColor = -1;
    for (let col = 0; col < width; col++) {
      const u = ((col + 0.5) / width) * 2 - 1;
      const v = 1 - ((row + 0.5) / height) * 2;
      const dir = normalize(
        camera.basis[0] * u * camera.fov * (width / height / aspect) + camera.basis[3] * v * camera.fov + camera.basis[6],
        camera.basis[1] * u * camera.fov * (width / height / aspect) + camera.basis[4] * v * camera.fov + camera.basis[7],
        camera.basis[2] * u * camera.fov * (width / height / aspect) + camera.basis[5] * v * camera.fov + camera.basis[8],
      );

      const cell = shade(world, camera.position, dir, { far, steps, lights, marks });
      if (color && cell.color !== lastColor) {
        line += `[38;5;${cell.color}m`;
        lastColor = cell.color;
      }
      line += cell.char;
    }
    lines.push(color ? `${line}[0m` : line);
  }
  return lines.join('\n');
}

function shade(world, origin, dir, { far, steps, lights, marks }) {
  // Primary ray: the same height field march the shader performs.
  let t = 0.5;
  let hit = -1;
  let lastT = t;
  for (let i = 0; i < steps && t < far; i++) {
    const px = origin.x + dir.x * t;
    const py = origin.y + dir.y * t;
    const pz = origin.z + dir.z * t;
    const h = py - heightAt(px, pz, world.seed);
    if (h < 0) {
      let a = lastT;
      let b = t;
      for (let k = 0; k < 5; k++) {
        const m = (a + b) * 0.5;
        const my = origin.y + dir.y * m;
        if (my - heightAt(origin.x + dir.x * m, origin.z + dir.z * m, world.seed) < 0) b = m;
        else a = m;
      }
      hit = (a + b) * 0.5;
      break;
    }
    lastT = t;
    t += Math.max(0.6, h * 0.5) + t * 0.02;
  }

  // Emissive bodies in front of whatever the terrain did.
  const bound = hit > 0 ? hit : far;
  let nearestLight = null;
  let nearestT = bound;
  for (const light of lights) {
    const ocx = light.x - origin.x;
    const ocy = light.y - origin.y;
    const ocz = light.z - origin.z;
    const b = ocx * dir.x + ocy * dir.y + ocz * dir.z;
    if (b <= 0) continue;
    const d2 = ocx * ocx + ocy * ocy + ocz * ocz - b * b;
    const radius = 0.5 + light.radius * 0.09;
    if (d2 > radius * radius) continue;
    const candidate = b - Math.sqrt(radius * radius - d2);
    if (candidate > 0 && candidate < nearestT) {
      nearestT = candidate;
      nearestLight = light;
    }
  }
  if (nearestLight) {
    return { char: '@', color: hueTo256(nearestLight.hue, 1) };
  }

  if (hit < 0) return sky(dir);

  const px = origin.x + dir.x * hit;
  const py = origin.y + dir.y * hit;
  const pz = origin.z + dir.z * hit;

  if (py < SEA_LEVEL + 0.05) {
    const shimmer = ((Math.floor(px * 0.4) + Math.floor(pz * 0.4)) & 1) === 0;
    return { char: shimmer ? '~' : '-', color: 24 };
  }

  const n = normalAt(px, pz, world.seed, 0.8);
  let luminance = 0.06 + 0.55 * Math.max(0, n.x * KEY.x + n.y * KEY.y + n.z * KEY.z) * shadow(world, px, py, pz);

  // Bioluminescence reaching the ground, and remembered footfalls.
  let tint = null;
  for (const light of lights) {
    const d = Math.hypot(light.x - px, light.y - py, light.z - pz);
    if (d > light.radius * 2.4) continue;
    const contribution = light.intensity / (1 + (d * d) / (light.radius * light.radius));
    if (contribution > 0.09) {
      luminance += contribution * 0.42;
      if (!tint || contribution > tint.weight) tint = { hue: light.hue, weight: contribution };
    }
  }
  for (const mark of marks) {
    const d = Math.hypot(mark.x - px, mark.z - pz);
    if (d > 3.2) continue;
    const glow = mark.intensity * (1 - d / 3.2);
    luminance += glow * 0.4;
    if (!tint || glow > tint.weight) tint = { hue: 0.52, weight: glow };
  }

  luminance *= Math.exp(-hit * 0.0016);
  // Gamma before quantizing: ten characters is not much dynamic range, and
  // linear luminance spends most of them on the brightest quarter of the image.
  const shaped = Math.pow(Math.max(0, Math.min(1, luminance)), 0.75);
  const index = Math.max(0, Math.min(RAMP.length - 1, Math.round(shaped * (RAMP.length - 1))));
  return {
    char: RAMP[index],
    color: tint ? hueTo256(tint.hue, Math.min(1, tint.weight)) : terrainColor(py, luminance),
  };
}

function shadow(world, x, y, z) {
  let t = 1.2;
  for (let i = 0; i < 14 && t < 220; i++) {
    const h = y + KEY.y * t - heightAt(x + KEY.x * t, z + KEY.z * t, world.seed);
    if (h < 0.05) return 0.15;
    t += Math.max(2, h * 1.2);
  }
  return 1;
}

function sky(dir) {
  if (dir.y > 0.62) return { char: ' ', color: 17 };
  if (dir.y > 0.24) return { char: '.', color: 23 };
  return { char: ':', color: 30 };
}

function terrainColor(height, luminance) {
  if (height < 2) return luminance > 0.35 ? 137 : 94;
  if (height > 48) return luminance > 0.4 ? 145 : 240;
  return luminance > 0.45 ? 71 : luminance > 0.2 ? 29 : 22;
}

/** 256-colour approximation of a hue at a given intensity. */
function hueTo256(hue, intensity) {
  const table = [196, 208, 226, 118, 46, 49, 51, 39, 27, 93, 129, 201];
  const base = table[Math.floor(((hue % 1) + 1) % 1 * table.length) % table.length];
  return intensity > 0.35 ? base : 240;
}

function gatherLights(world, camera, limit) {
  const lights = [];
  for (const chunk of world.ecs.query(['Position', 'Flora'])) {
    const px = chunk.col('Position', 'x');
    const py = chunk.col('Position', 'y');
    const pz = chunk.col('Position', 'z');
    const species = chunk.col('Flora', 'species');
    const charge = chunk.col('Flora', 'charge');
    const bloomed = chunk.col('Flora', 'bloomed');
    for (let i = 0; i < chunk.count; i++) {
      const distance = Math.hypot(px[i] - camera.position.x, pz[i] - camera.position.z);
      if (distance > 220) continue;
      lights.push({
        x: px[i],
        y: py[i] + SPECIES[species[i]].height * 0.5,
        z: pz[i],
        radius: SPECIES[species[i]].radius,
        hue: SPECIES[species[i]].hue,
        intensity: 0.2 + (bloomed[i] ? 0.15 : 0) + charge[i] * 1.4,
        distance,
      });
    }
  }
  lights.sort((a, b) => b.intensity / (1 + b.distance * 0.02) - a.intensity / (1 + a.distance * 0.02));
  return lights.slice(0, limit);
}

function gatherMarks(world, camera) {
  const memory = world.stores.get('regions');
  if (!memory) return [];
  const here = memory.coordOf(camera.position.x, camera.position.z);
  const out = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (const mark of memory.resolve(here.cx + dx, here.cy + dz, world.tick)) {
        if (mark.op !== 'trail' && mark.op !== 'beacon') continue;
        if (Math.hypot(mark.x - camera.position.x, mark.z - camera.position.z) > 140) continue;
        out.push(mark);
      }
    }
  }
  return out.slice(0, 64);
}

function normalize(x, y, z) {
  const length = Math.hypot(x, y, z) || 1;
  return { x: x / length, y: y / length, z: z / length };
}
