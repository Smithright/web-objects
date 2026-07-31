// Terrain: one definition, two languages.
//
// The CPU needs the height field to place the avatar's feet, resolve
// collisions, and decide what a region contains. The GPU needs the identical
// height field to ray-march it. If those two ever disagree the avatar walks on
// a world nobody can see, so this module is the single source of truth: the
// JavaScript below and the GLSL string it exports implement the same integer
// hash, the same value noise, the same domain-warped fBm, and the same
// landmark mountain, bit for bit.
//
// The hash is a 32-bit integer mix (Wang/Jenkins lineage). JavaScript reproduces
// it exactly with Math.imul and >>> 0; GLSL ES 3.00 `uint` arithmetic wraps the
// same way. Nothing here reads global state — any point of the world can be
// evaluated alone, at any time, on either processor.

export const TERRAIN_VERSION = 2;

/** Sea level in world units. Everything below is shallow ocean. */
export const SEA_LEVEL = 0;
export const TERRAIN_SCALE = 0.0075; // world units -> noise units
export const TERRAIN_AMPLITUDE = 78;

/**
 * The mountain.
 *
 * Every world gets exactly one, and it is enormous: a kilometre of vertical
 * relief with a snow line two thirds of the way up, spurs radiating off the
 * shoulders, and a summit visible from anywhere on the map. It is not placed in
 * a level file — it is a term in the height function, so it costs nothing to
 * store and it is in the same place on every machine that computes this seed.
 */
export const MOUNTAIN_RADIUS = 2400;
export const MOUNTAIN_HEIGHT = 1450;
export const SNOW_LINE = 430;
export const TREE_LINE = 250;

export function hash2i(x, y, seed) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2147483647)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash to [0, 1). */
export function hashUnit2(x, y, seed) {
  return hash2i(x, y, seed) / 4294967296;
}

function fade(t) {
  return t * t * (3 - 2 * t);
}

export function valueNoise(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = fade(x - xi);
  const ty = fade(y - yi);
  const a = hashUnit2(xi, yi, seed);
  const b = hashUnit2(xi + 1, yi, seed);
  const c = hashUnit2(xi, yi + 1, seed);
  const d = hashUnit2(xi + 1, yi + 1, seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

export function fbm(x, y, seed, octaves = 5) {
  let sum = 0;
  let amplitude = 0.5;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * valueNoise(fx, fy, seed + i * 131);
    norm += amplitude;
    amplitude *= 0.5;
    // Rotate between octaves so the lattice never lines up with itself.
    const nx = fx * 1.62 - fy * 1.18;
    const ny = fx * 1.18 + fy * 1.62;
    fx = nx;
    fy = ny;
  }
  return sum / norm;
}

/** Ridged noise: the inverted, sharpened absolute value that makes spines. */
export function ridged(x, y, seed, octaves = 4) {
  let sum = 0;
  let amplitude = 0.5;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise(fx, fy, seed + i * 977) * 2 - 1);
    sum += amplitude * n * n;
    norm += amplitude;
    amplitude *= 0.5;
    const nx = fx * 1.71 - fy * 1.13;
    const ny = fx * 1.13 + fy * 1.71;
    fx = nx;
    fy = ny;
  }
  return sum / norm;
}

/** Where this seed put its mountain. Deterministic, and never at the origin. */
export function mountainCenter(seed) {
  const angle = hashUnit2(11, 7, seed) * Math.PI * 2;
  const radius = 1300 + hashUnit2(13, 17, seed) * 700;
  return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
}

/** The mountain's contribution at a point, and its 0..1 influence mask. */
export function mountainAt(x, z, seed) {
  const center = mountainCenter(seed);
  const distance = Math.hypot(x - center.x, z - center.z);
  if (distance >= MOUNTAIN_RADIUS) return { mask: 0, height: 0 };
  const t = 1 - distance / MOUNTAIN_RADIUS;
  // A concave skirt flaring into steep shoulders and a rounded summit — the
  // profile a real massif has, and the reason it reads as huge rather than as
  // a cone somebody dropped on the map.
  const profile = Math.pow(fade(t), 2.15) * (0.82 + 0.18 * fade(t));
  // Spurs and gullies, in world space so there is no seam at any bearing.
  const spurs = ridged(x * 0.0022, z * 0.0022, seed + 5150, 4);
  const relief = 0.66 + spurs * 0.62;
  const detail = (fbm(x * 0.012, z * 0.012, seed + 733, 4) - 0.5) * 46 * t;
  return { mask: fade(t), height: profile * MOUNTAIN_HEIGHT * relief + detail };
}

/**
 * Terrain height in world units at (x, z).
 *
 * A continent mask decides where land exists at all, domain-warped fBm gives it
 * body, ridged noise carves the spines the canopy grows along, and the mountain
 * is added on top with its own mask. The warp is why the coastline meanders
 * instead of looking like noise thresholded at a value — the trick is Inigo
 * Quilez's, and it is the cheapest way to buy terrain that looks eroded rather
 * than generated.
 */
export function heightAt(x, z, seed) {
  const u = x * TERRAIN_SCALE;
  const v = z * TERRAIN_SCALE;

  const warpX = fbm(u * 0.5 + 11.3, v * 0.5 - 4.7, seed + 7717, 3) - 0.5;
  const warpZ = fbm(u * 0.5 - 3.1, v * 0.5 + 9.2, seed + 3313, 3) - 0.5;
  const wu = u + warpX * 1.35;
  const wv = v + warpZ * 1.35;

  const continent = fbm(wu * 0.34, wv * 0.34, seed, 4);
  const land = smoothstep(0.36, 0.62, continent);
  const body = fbm(wu, wv, seed + 51, 5);
  const spine = ridged(wu * 1.7, wv * 1.7, seed + 907, 4);
  const base = (body * 0.62 + spine * spine * 0.72) * land * TERRAIN_AMPLITUDE - 9 * (1 - land);

  const mountain = mountainAt(x, z, seed);
  // The massif overrides the coastline it stands on rather than floating over it.
  return base * (1 - mountain.mask * 0.82) + mountain.height;
}

export function normalAt(x, z, seed, epsilon = 0.6) {
  const hx = heightAt(x + epsilon, z, seed) - heightAt(x - epsilon, z, seed);
  const hz = heightAt(x, z + epsilon, seed) - heightAt(x, z - epsilon, seed);
  const nx = -hx;
  const ny = 2 * epsilon;
  const nz = -hz;
  const length = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / length, y: ny / length, z: nz / length };
}

/** Steepness in [0,1] — what decides whether the avatar can stand there. */
export function slopeAt(x, z, seed) {
  return 1 - normalAt(x, z, seed).y;
}

export function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Biome classification, used by simulation (what grows here) and by the
 * renderer (how the ground is shaded). Both must agree, so it lives here.
 */
export const Biome = {
  SHALLOWS: 0,
  BEACH: 1,
  MEADOW: 2,
  CANOPY: 3,
  HIGHLAND: 4,
  SPIRE: 5,
  ALPINE: 6,
  SNOW: 7,
};

export function biomeAt(x, z, seed) {
  const h = heightAt(x, z, seed);
  if (h < SEA_LEVEL - 0.5) return Biome.SHALLOWS;
  if (h < 2.2) return Biome.BEACH;
  if (h > SNOW_LINE) return Biome.SNOW;
  if (h > TREE_LINE) return Biome.ALPINE;
  const slope = slopeAt(x, z, seed);
  if (h > 52) return Biome.SPIRE;
  if (h > 30) return Biome.HIGHLAND;
  const moisture = fbm(x * TERRAIN_SCALE * 1.9 + 40, z * TERRAIN_SCALE * 1.9 - 17, seed + 6101, 3);
  return moisture > 0.47 && slope < 0.55 ? Biome.CANOPY : Biome.MEADOW;
}

/**
 * The GLSL twin.
 *
 * Every function above appears here with the same name and the same maths. The
 * renderer includes this string verbatim, so there is exactly one terrain in
 * this engine — not a CPU one and a GPU one that drift apart in week three.
 */
export const TERRAIN_GLSL = /* glsl */ `
const float SEA_LEVEL = ${SEA_LEVEL.toFixed(1)};
const float TERRAIN_SCALE = ${TERRAIN_SCALE};
const float TERRAIN_AMPLITUDE = ${TERRAIN_AMPLITUDE.toFixed(1)};
const float MOUNTAIN_RADIUS = ${MOUNTAIN_RADIUS.toFixed(1)};
const float MOUNTAIN_HEIGHT = ${MOUNTAIN_HEIGHT.toFixed(1)};
const float SNOW_LINE = ${SNOW_LINE.toFixed(1)};
const float TREE_LINE = ${TREE_LINE.toFixed(1)};

uint hash2i(int x, int y, int seed) {
  uint h = uint(x) * 374761393u + uint(y) * 668265263u + uint(seed) * 2147483647u;
  h = (h ^ (h >> 13)) * 1274126177u;
  return h ^ (h >> 16);
}

float hashUnit2(int x, int y, int seed) {
  return float(hash2i(x, y, seed)) / 4294967296.0;
}

float fadeCurve(float t) { return t * t * (3.0 - 2.0 * t); }

float valueNoise(vec2 p, int seed) {
  vec2 i = floor(p);
  vec2 f = p - i;
  int xi = int(i.x);
  int yi = int(i.y);
  float tx = fadeCurve(f.x);
  float ty = fadeCurve(f.y);
  float a = hashUnit2(xi, yi, seed);
  float b = hashUnit2(xi + 1, yi, seed);
  float c = hashUnit2(xi, yi + 1, seed);
  float d = hashUnit2(xi + 1, yi + 1, seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

float fbm(vec2 p, int seed, int octaves) {
  float sum = 0.0;
  float amplitude = 0.5;
  float norm = 0.0;
  vec2 q = p;
  for (int i = 0; i < octaves; i++) {
    sum += amplitude * valueNoise(q, seed + i * 131);
    norm += amplitude;
    amplitude *= 0.5;
    q = vec2(q.x * 1.62 - q.y * 1.18, q.x * 1.18 + q.y * 1.62);
  }
  return sum / norm;
}

float ridged(vec2 p, int seed, int octaves) {
  float sum = 0.0;
  float amplitude = 0.5;
  float norm = 0.0;
  vec2 q = p;
  for (int i = 0; i < octaves; i++) {
    float n = 1.0 - abs(valueNoise(q, seed + i * 977) * 2.0 - 1.0);
    sum += amplitude * n * n;
    norm += amplitude;
    amplitude *= 0.5;
    q = vec2(q.x * 1.71 - q.y * 1.13, q.x * 1.13 + q.y * 1.71);
  }
  return sum / norm;
}

vec2 mountainCenter(int seed) {
  float angle = hashUnit2(11, 7, seed) * 6.28318530718;
  float radius = 1300.0 + hashUnit2(13, 17, seed) * 700.0;
  return vec2(cos(angle) * radius, sin(angle) * radius);
}

vec2 mountainAt(vec2 world, int seed) {
  vec2 center = mountainCenter(seed);
  float distance = length(world - center);
  if (distance >= MOUNTAIN_RADIUS) return vec2(0.0);
  float t = 1.0 - distance / MOUNTAIN_RADIUS;
  float shaped = fadeCurve(t);
  float profile = pow(shaped, 2.15) * (0.82 + 0.18 * shaped);
  float spurs = ridged(world * 0.0022, seed + 5150, 4);
  float relief = 0.66 + spurs * 0.62;
  float detail = (fbm(world * 0.012, seed + 733, 4) - 0.5) * 46.0 * t;
  return vec2(shaped, profile * MOUNTAIN_HEIGHT * relief + detail);
}

float heightAt(vec2 world, int seed) {
  vec2 uv = world * TERRAIN_SCALE;
  float warpX = fbm(uv * 0.5 + vec2(11.3, -4.7), seed + 7717, 3) - 0.5;
  float warpZ = fbm(uv * 0.5 + vec2(-3.1, 9.2), seed + 3313, 3) - 0.5;
  vec2 w = uv + vec2(warpX, warpZ) * 1.35;
  float continent = fbm(w * 0.34, seed, 4);
  float land = smoothstep(0.36, 0.62, continent);
  float body = fbm(w, seed + 51, 5);
  float spine = ridged(w * 1.7, seed + 907, 4);
  float base = (body * 0.62 + spine * spine * 0.72) * land * TERRAIN_AMPLITUDE - 9.0 * (1.0 - land);
  vec2 mountain = mountainAt(world, seed);
  return base * (1.0 - mountain.x * 0.82) + mountain.y;
}

vec3 normalAt(vec2 world, int seed, float eps) {
  float hx = heightAt(world + vec2(eps, 0.0), seed) - heightAt(world - vec2(eps, 0.0), seed);
  float hz = heightAt(world + vec2(0.0, eps), seed) - heightAt(world - vec2(0.0, eps), seed);
  return normalize(vec3(-hx, 2.0 * eps, -hz));
}
`;
