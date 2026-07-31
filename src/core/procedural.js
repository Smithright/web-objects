// Procedural genesis — store causes, regenerate consequences.
//
//   chunk = generate(world_seed, generator_version, chunk_coordinate,
//                    geological_context, climate_context)
//   final_chunk = apply_mutation_log(chunk, local_events)
//
// Default reality is a pure function of immutable causes, so it never needs to
// be stored. Only divergence — what someone or something actually changed — is
// persisted. Bumping the generator version is an explicit, diffable act.

import { seedFrom } from './rng.js';

export const GENERATOR_VERSION = 3;
export const CHUNK_SIZE = 32;

export const Biome = {
  0: 'ocean',
  1: 'shore',
  2: 'grass',
  3: 'forest',
  4: 'steppe',
  5: 'desert',
  6: 'rock',
  7: 'snow',
};

/** Value noise on an integer lattice — stateless, so any chunk can regenerate alone. */
function latticeNoise(seed, x, y) {
  return seedFrom(seed, x, y) / 4294967296;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function valueNoise(seed, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothstep(x - x0);
  const ty = smoothstep(y - y0);
  const c00 = latticeNoise(seed, x0, y0);
  const c10 = latticeNoise(seed, x0 + 1, y0);
  const c01 = latticeNoise(seed, x0, y0 + 1);
  const c11 = latticeNoise(seed, x0 + 1, y0 + 1);
  return (
    c00 * (1 - tx) * (1 - ty) + c10 * tx * (1 - ty) + c01 * (1 - tx) * ty + c11 * tx * ty
  );
}

export function fbm(seed, x, y, { octaves = 5, lacunarity = 2, gain = 0.5, frequency = 1 } = {}) {
  let amplitude = 1;
  let sum = 0;
  let norm = 0;
  let f = frequency;
  for (let o = 0; o < octaves; o++) {
    sum += amplitude * valueNoise(seed + o * 0x9e37, x * f, y * f);
    norm += amplitude;
    amplitude *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/**
 * Generate one chunk from causes alone. Identical inputs always produce an
 * identical chunk, on any machine, at any time — that is the whole contract.
 */
export function generateChunk(worldSeed, generatorVersion, cx, cy, context = {}) {
  const size = context.size ?? CHUNK_SIZE;
  const scale = context.scale ?? 0.08;
  const seaLevel = context.seaLevel ?? 0.42;
  const base = seedFrom(worldSeed, 'chunk', generatorVersion);
  const elevation = new Float64Array(size * size);
  const moisture = new Float64Array(size * size);
  const temperature = new Float64Array(size * size);
  const biome = new Uint8Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const wx = cx * size + x;
      const wy = cy * size + y;
      const i = y * size + x;
      // Geology first: continents modulated by ridged detail.
      const continent = fbm(base, wx * scale * 0.25, wy * scale * 0.25, { octaves: 3 });
      const detail = fbm(base + 1, wx * scale, wy * scale, { octaves: 5 });
      const e = continent * 0.65 + detail * 0.35;
      elevation[i] = e;
      // Climate follows geology: wetter near water, colder with altitude.
      const m = fbm(base + 2, wx * scale * 0.5, wy * scale * 0.5, { octaves: 4 });
      moisture[i] = Math.min(1, m * 0.7 + Math.max(0, seaLevel - e) * 1.4);
      const latitude = Math.abs(Math.sin((wy * scale) / 3));
      temperature[i] = Math.max(0, 1 - latitude * 0.6 - Math.max(0, e - seaLevel) * 1.2);
      biome[i] = classify(e, moisture[i], temperature[i], seaLevel);
    }
  }

  const chunk = {
    coordinate: { cx, cy },
    size,
    worldSeed,
    generatorVersion,
    elevation,
    moisture,
    temperature,
    biome,
    mutations: 0,
  };
  chunk.digest = chunkDigest(chunk);
  return chunk;
}

function classify(elevation, moisture, temperature, seaLevel) {
  if (elevation < seaLevel - 0.04) return 0; // ocean
  if (elevation < seaLevel) return 1; // shore
  if (temperature < 0.22) return 7; // snow
  if (elevation > 0.74) return 6; // rock
  if (moisture < 0.28) return 5; // desert
  if (moisture > 0.58) return 3; // forest
  if (temperature > 0.62) return 4; // steppe
  return 2; // grass
}

/**
 * Replay local divergence over regenerated default reality.
 * Mutations are ordered and idempotent per (tick, index).
 */
export function applyMutationLog(chunk, mutations = []) {
  const out = {
    ...chunk,
    elevation: Float64Array.from(chunk.elevation),
    moisture: Float64Array.from(chunk.moisture),
    temperature: Float64Array.from(chunk.temperature),
    biome: Uint8Array.from(chunk.biome),
  };
  const ordered = [...mutations].sort((a, b) => (a.tick - b.tick) || (a.index - b.index));
  for (const m of ordered) {
    if (m.index < 0 || m.index >= out.elevation.length) continue;
    switch (m.op) {
      case 'raise':
        out.elevation[m.index] = clamp01(out.elevation[m.index] + m.amount);
        break;
      case 'flood':
        out.moisture[m.index] = clamp01(out.moisture[m.index] + m.amount);
        break;
      case 'burn':
        out.moisture[m.index] = clamp01(out.moisture[m.index] - m.amount);
        out.biome[m.index] = 4;
        break;
      case 'paint':
        out.biome[m.index] = m.biome;
        break;
      default:
        continue;
    }
    out.mutations++;
  }
  for (let i = 0; i < out.biome.length; i++) {
    if (ordered.some((m) => m.index === i && m.op === 'paint')) continue;
    out.biome[i] = classify(out.elevation[i], out.moisture[i], out.temperature[i], 0.42);
  }
  out.digest = chunkDigest(out);
  return out;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function chunkDigest(chunk) {
  let h = seedFrom(chunk.worldSeed, chunk.generatorVersion, chunk.coordinate.cx, chunk.coordinate.cy);
  for (let i = 0; i < chunk.biome.length; i++) {
    h = (Math.imul(h ^ chunk.biome[i], 0x01000193) ^ Math.round(chunk.elevation[i] * 4096)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function biomeHistogram(chunk) {
  const counts = new Map();
  for (let i = 0; i < chunk.biome.length; i++) {
    const name = Biome[chunk.biome[i]];
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}
