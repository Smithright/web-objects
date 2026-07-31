// A ray-traced renderer for Pandora.
//
// There is no mesh, no vertex buffer, no scene graph, and no asset pipeline.
// The scene pass marches primary rays against the same height field the
// simulation walks on — imported verbatim from src/core/terrain.js — then casts
// secondary rays for shadows, water reflection, ambient occlusion, and
// volumetric shafts. Flora light, footprint memory, and the avatar arrive as
// uniforms drawn from world state. The renderer reads the world; it never
// writes to it.
//
// The pipeline is three passes:
//
//   scene      HDR radiance into a float target
//   bloom      bright-pass, downsample, separable blur
//   composite  tone map, grade, dither, present
//
// Technique credits, all open literature: sphere tracing (Hart, 1996); height
// field marching with binary refinement, analytic soft shadows, and
// domain-warped fBm (Inigo Quilez, iquilezles.org, MIT); the ACES filmic
// tone-mapping fit (Stephen Hill, MIT); the Henyey-Greenstein phase function
// (1941); Schlick's Fresnel approximation (1994).
//
// WebGL2 is the backend because it runs everywhere today. The shader is
// structured so a WGSL/WebGPU backend can replace it without the world, the
// uniforms, or the camera changing at all.

import { EYE_HEIGHT, SPECIES } from '../pandora.js';
import { SEA_LEVEL, TERRAIN_GLSL } from '../../core/terrain.js';

export const MAX_LIGHTS = 48;
export const MAX_MARKS = 48;

/**
 * Quality presets. `max` is deliberately extravagant — supersampled, every
 * secondary ray enabled, shafts and cloud shadows on — because the point of a
 * maximum setting is to show what the technique can do, not to be safe.
 */
export const QUALITY = {
  low: {
    scale: 0.4, steps: 96, shadowSteps: 12, reflection: 0, ao: 0,
    lights: 20, marks: 16, islands: 0, clouds: 0, godRays: 0, bloom: 0, bloomPasses: 0,
  },
  medium: {
    scale: 0.6, steps: 150, shadowSteps: 18, reflection: 1, ao: 4,
    lights: 32, marks: 28, islands: 1, clouds: 1, godRays: 0, bloom: 1, bloomPasses: 2,
  },
  high: {
    scale: 0.85, steps: 220, shadowSteps: 26, reflection: 1, ao: 5,
    lights: 48, marks: 48, islands: 1, clouds: 1, godRays: 12, bloom: 1, bloomPasses: 3,
  },
  ultra: {
    scale: 1, steps: 320, shadowSteps: 34, reflection: 1, ao: 6,
    lights: 48, marks: 48, islands: 1, clouds: 1, godRays: 20, bloom: 1, bloomPasses: 4,
  },
  max: {
    scale: 1.7, steps: 420, shadowSteps: 44, reflection: 1, ao: 6,
    lights: 48, marks: 48, islands: 1, clouds: 1, godRays: 28, bloom: 1, bloomPasses: 4,
  },
};

const FULLSCREEN_VERTEX = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  // One oversized triangle — no vertex buffer, no attributes, no geometry.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const SCENE_SHADER = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uResolution;
uniform float uTime;
uniform int uSeed;
uniform vec3 uCamPos;
uniform mat3 uCamBasis;
uniform float uFov;

uniform int uSteps;
uniform int uShadowSteps;
uniform int uReflection;
uniform int uAO;
uniform int uIslands;
uniform int uClouds;
uniform int uGodRays;
uniform float uFar;

uniform int uLightCount;
uniform vec4 uLightPos[${MAX_LIGHTS}];
uniform vec4 uLightColor[${MAX_LIGHTS}];

uniform int uMarkCount;
uniform vec4 uMarks[${MAX_MARKS}];

uniform vec3 uAvatarPos;
uniform float uAvatarYaw;
uniform float uAvatarPhase;
uniform float uAvatarSpeed;
uniform int uAvatarVisible;
uniform vec4 uAppearance;   // height, build, skinHue, glowHue
uniform vec4 uAppearance2;  // glowDensity, marking, queue, swimming

${TERRAIN_GLSL}

const float EYE_HEIGHT = ${EYE_HEIGHT.toFixed(2)};
const vec3 KEY_DIR = vec3(-0.5698, 0.6243, 0.5346);
const vec3 KEY_COLOR = vec3(0.44, 0.52, 0.86);
const float CLOUD_BASE = 2600.0;

vec3 hueToRgb(float h) {
  vec3 k = fract(vec3(h) + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0));
  return clamp(abs(k * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}

/** Henyey-Greenstein: forward-scattering haze, which is why shafts read. */
float phaseHG(float cosTheta, float g) {
  float gg = g * g;
  return (1.0 - gg) / (12.566370614 * pow(1.0 + gg - 2.0 * g * cosTheta, 1.5));
}

// --- sky -------------------------------------------------------------------

vec3 skyGradient(vec3 dir) {
  float up = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  return mix(vec3(0.075, 0.125, 0.205), vec3(0.010, 0.024, 0.062), pow(up, 0.85));
}

vec3 skyColor(vec3 dir) {
  vec3 sky = skyGradient(dir);

  // Stars on a stable lattice, so they do not swim as the camera turns.
  if (dir.y > 0.02) {
    vec2 cell = mod(floor(dir.xz * 260.0 / max(0.02, dir.y)), 4096.0);
    float star = hashUnit2(int(cell.x), int(cell.y), uSeed + 991);
    if (star > 0.9962) {
      float twinkle = 0.7 + 0.3 * sin(uTime * 2.0 + star * 90.0);
      sky += vec3(0.75, 0.85, 1.0) * (star - 0.9962) * 260.0 * twinkle;
    }
  }

  // Polyphemus: the gas giant this moon orbits, and the reason it is never
  // truly dark down here.
  vec3 giantDir = normalize(vec3(0.42, 0.30, -0.85));
  float d = dot(dir, giantDir);
  float disc = smoothstep(0.9950, 0.9968, d);
  if (disc > 0.0) {
    vec3 local = normalize(dir - giantDir * d);
    float band = fbm(vec2(local.y * 26.0, local.x * 4.0), uSeed + 61, 4);
    float storm = fbm(vec2(local.x * 9.0, local.y * 9.0), uSeed + 67, 3);
    vec3 body = mix(vec3(0.32, 0.26, 0.40), vec3(0.66, 0.50, 0.40), band);
    body = mix(body, vec3(0.72, 0.44, 0.34), smoothstep(0.72, 0.95, storm) * 0.6);
    float phase = clamp(dot(local, KEY_DIR) * 0.5 + 0.55, 0.0, 1.0);
    sky = mix(sky, body * (0.18 + phase * 1.05), disc);
  }
  sky += vec3(0.30, 0.26, 0.40) * pow(clamp(d, 0.0, 1.0), 380.0) * 0.6;

  // Aurora, low on the sky, from the same noise as everything else.
  float aurora = smoothstep(0.02, 0.30, dir.y) * (1.0 - smoothstep(0.30, 0.74, dir.y));
  float curtain = fbm(vec2(atan(dir.z, dir.x) * 2.4 + uTime * 0.035, dir.y * 7.0), uSeed + 401, 4);
  sky += vec3(0.10, 0.44, 0.34) * aurora * pow(curtain, 3.0) * 1.1;
  sky += vec3(0.30, 0.14, 0.40) * aurora * pow(curtain, 6.0) * 0.5;

  return sky;
}

/**
 * A single high cloud deck, intersected analytically and shaded by how much of
 * it is between the sample and the key light. Two octaves of drift give it
 * motion without a second noise field.
 */
vec3 cloudLayer(vec3 ro, vec3 rd, vec3 sky) {
  if (uClouds == 0 || rd.y <= 0.012) return sky;
  float t = (CLOUD_BASE - ro.y) / rd.y;
  if (t <= 0.0 || t > 90000.0) return sky;
  vec2 p = (ro + rd * t).xz;

  vec2 drift = vec2(uTime * 5.5, uTime * 2.2);
  float coverage = fbm((p + drift) * 0.00035, uSeed + 1201, 4);
  float detail = fbm((p + drift * 1.7) * 0.0014, uSeed + 1207, 3);
  float density = smoothstep(0.60, 0.90, coverage * 0.78 + detail * 0.30);
  if (density <= 0.001) return sky;

  // Self-shadowing: sample the field again a step toward the light.
  float toward = fbm((p + drift + KEY_DIR.xz * 900.0) * 0.00035, uSeed + 1201, 3);
  float lit = clamp(1.0 - smoothstep(0.42, 0.80, toward) * 0.85, 0.12, 1.0);

  vec3 cloud = mix(vec3(0.055, 0.075, 0.125), vec3(0.30, 0.36, 0.52), lit);
  cloud += KEY_COLOR * pow(max(0.0, dot(rd, KEY_DIR)), 12.0) * lit * 0.5;
  // Thin edges catch the giant's light from behind.
  cloud += vec3(0.34, 0.30, 0.42) * (1.0 - density) * 0.35;

  float horizon = smoothstep(0.012, 0.13, rd.y);
  return mix(sky, cloud, density * horizon * 0.78);
}

// --- floating islands ------------------------------------------------------

const float ISLAND_CELL = 1150.0;

vec4 islandAt(int cx, int cy) {
  float rr = hashUnit2(cx, cy, uSeed + 57);
  if (rr < 0.70) return vec4(0.0);
  float rx = hashUnit2(cx, cy, uSeed + 17);
  float rz = hashUnit2(cx, cy, uSeed + 29);
  float ry = hashUnit2(cx, cy, uSeed + 43);
  vec3 center = vec3((float(cx) + rx) * ISLAND_CELL, 420.0 + ry * 520.0, (float(cy) + rz) * ISLAND_CELL);
  return vec4(center, 46.0 + rr * 70.0);
}

float islandSDF(vec3 p, vec4 island) {
  if (island.w <= 0.0) return 1e9;
  vec3 q = p - island.xyz;
  float base = length(vec3(q.x, q.y * 1.45, q.z)) - island.w;
  float coarse = fbm(q.xz * 0.006 + q.y * 0.004, uSeed + 71, 4) - 0.5;
  float fine = ridged(q.xz * 0.021, uSeed + 73, 3) - 0.5;
  float root = smoothstep(0.0, 1.0, -q.y / island.w);
  return base - coarse * island.w * 0.62 - fine * island.w * 0.22 - root * root * island.w * 0.55;
}

float islandsSDF(vec3 p, out vec4 hit) {
  int cx = int(floor(p.x / ISLAND_CELL));
  int cy = int(floor(p.z / ISLAND_CELL));
  float best = 1e9;
  hit = vec4(0.0);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec4 island = islandAt(cx + dx, cy + dy);
      float d = islandSDF(p, island);
      if (d < best) { best = d; hit = island; }
    }
  }
  return best;
}

// --- the avatar ------------------------------------------------------------

float sdCapsule(vec3 p, vec3 a, vec3 b, float ra, float rb) {
  vec3 pa = p - a;
  vec3 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - mix(ra, rb, h);
}

/** Na'vi proportions: tall, narrow, long-limbed, queue and tail. In metres. */
float avatarSDF(vec3 world, out float glowMask) {
  float scale = uAppearance.x;
  float build = uAppearance.y;
  float phase = uAvatarPhase;
  float stride = clamp(uAvatarSpeed / 9.0, 0.0, 1.4);

  vec3 p = world - (uAvatarPos - vec3(0.0, EYE_HEIGHT * scale, 0.0));
  float c = cos(-uAvatarYaw);
  float sn = sin(-uAvatarYaw);
  p = vec3(p.x * c - p.z * sn, p.y, p.x * sn + p.z * c) / scale;

  float bob = sin(phase * 2.0) * 0.07 * stride;
  float swing = sin(phase) * 0.5 * stride;
  float thickness = mix(0.125, 0.205, build);

  float torso = sdCapsule(p, vec3(0.0, 1.22 + bob, 0.0), vec3(0.0, 2.14 + bob, 0.04), thickness * 1.5, thickness * 1.15);
  float head = length(p - vec3(0.0, 2.36 + bob, 0.06)) - 0.21;
  float legL = sdCapsule(p, vec3(-0.11, 1.26 + bob, 0.0), vec3(-0.13, 0.04, swing * 0.55), thickness, thickness * 0.5);
  float legR = sdCapsule(p, vec3(0.11, 1.26 + bob, 0.0), vec3(0.13, 0.04, -swing * 0.55), thickness, thickness * 0.5);
  float armL = sdCapsule(p, vec3(-0.20, 2.04 + bob, 0.0), vec3(-0.26, 1.24, -swing * 0.5), thickness * 0.7, thickness * 0.36);
  float armR = sdCapsule(p, vec3(0.20, 2.04 + bob, 0.0), vec3(0.26, 1.24, swing * 0.5), thickness * 0.7, thickness * 0.36);
  float tail = sdCapsule(p, vec3(0.0, 1.30 + bob, -0.08), vec3(sin(phase * 0.7) * 0.30, 0.55, -0.95), thickness * 0.5, 0.022);
  float queue = sdCapsule(p, vec3(0.0, 2.50 + bob, -0.04),
    vec3(sin(phase * 0.5) * 0.12, 2.50 - uAppearance2.z * 1.15, -0.22), 0.036, 0.020);

  float d = min(min(torso, head), min(min(legL, legR), min(armL, armR)));
  d = min(d, min(tail, queue));

  // Markings are stripes, not static: a band that wraps the body, wavered by
  // noise. Stripes survive being twenty pixels tall; speckle does not.
  float around = atan(p.x, p.z);
  float waver = valueNoise(vec2(p.y * 1.6, around * 1.1), uSeed + 313) - 0.5;
  float bands = sin(p.y * (5.0 + uAppearance2.y * 5.0) + waver * 5.0 + around * 0.6);
  glowMask = smoothstep(0.52, 0.95, bands) * (0.30 + uAppearance2.x * 0.45);
  return d * scale;
}

// --- ray marching ----------------------------------------------------------

bool marchTerrain(vec3 ro, vec3 rd, float tMin, float tMax, int steps, out float tHit) {
  float t = tMin;
  float lastT = tMin;
  for (int i = 0; i < 640; i++) {
    if (i >= steps || t > tMax) break;
    vec3 p = ro + rd * t;
    float h = p.y - heightAt(p.xz, uSeed);
    if (h < 0.0) {
      float a = lastT;
      float b = t;
      for (int k = 0; k < 9; k++) {
        float m = (a + b) * 0.5;
        vec3 pm = ro + rd * m;
        if (pm.y - heightAt(pm.xz, uSeed) < 0.0) b = m; else a = m;
      }
      tHit = (a + b) * 0.5;
      return true;
    }
    lastT = t;
    // Step by the clearance to the surface — huge strides across a valley,
    // small ones near the ground — with a floor that grows with distance so a
    // grazing ray still reaches the horizon inside the step budget.
    t += max(h * 0.5, 0.3 + t * 0.012);
  }
  tHit = tMax;
  return false;
}

bool marchIslands(vec3 ro, vec3 rd, float tMin, float tMax, out float tHit, out vec4 island) {
  tHit = tMax;
  island = vec4(0.0);
  if (uIslands == 0) return false;
  float t = tMin;
  for (int i = 0; i < 80; i++) {
    if (t > tMax) break;
    vec4 candidate;
    float d = islandsSDF(ro + rd * t, candidate);
    if (d < 0.4) { tHit = t; island = candidate; return true; }
    t += max(d * 0.85, 0.6);
  }
  return false;
}

bool marchAvatar(vec3 ro, vec3 rd, float tMin, float tMax, out float tHit, out float glow) {
  tHit = tMax;
  glow = 0.0;
  if (uAvatarVisible == 0) return false;
  vec3 oc = ro - uAvatarPos;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - 12.0;
  float disc = b * b - c;
  if (disc < 0.0) return false;
  float root = sqrt(disc);
  float enter = max(tMin, -b - root);
  float exit = min(tMax, -b + root);
  if (enter > exit) return false;

  float t = enter;
  for (int i = 0; i < 72; i++) {
    if (t > exit) break;
    float g;
    float d = avatarSDF(ro + rd * t, g);
    if (d < 0.004) { tHit = t; glow = g; return true; }
    t += max(d, 0.004);
  }
  return false;
}

/**
 * The plants themselves: each light the CPU sent is also a body. Analytic
 * ray-sphere intersection, so several dozen visible plants cost a few dozen dot
 * products rather than a second distance field.
 */
bool marchFlora(vec3 ro, vec3 rd, float tMax, out float tHit, out vec3 emissive, out vec3 normal) {
  tHit = tMax;
  emissive = vec3(0.0);
  normal = vec3(0.0, 1.0, 0.0);
  bool found = false;
  // Slot 0 is the avatar's own glow — a light with no body, so start at 1.
  for (int i = 1; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    vec3 center = uLightPos[i].xyz;
    float radius = 0.22 + uLightPos[i].w * 0.075;
    vec3 oc = center - ro;
    float b = dot(oc, rd);
    if (b < 0.0) continue;
    float d2 = dot(oc, oc) - b * b;
    if (d2 > radius * radius) continue;
    float t = b - sqrt(max(0.0, radius * radius - d2));
    if (t <= 0.02 || t >= tHit) continue;
    tHit = t;
    normal = normalize((ro + rd * t) - center);
    emissive = uLightColor[i].rgb * (0.35 + uLightColor[i].a * 1.35);
    found = true;
  }
  return found;
}

/** Soft shadow against the height field — IQ's penumbra estimate. */
float terrainShadow(vec3 origin, vec3 dir, float maxDist, int steps) {
  float shadow = 1.0;
  float t = 0.8;
  for (int i = 0; i < 64; i++) {
    if (i >= steps || t > maxDist) break;
    vec3 p = origin + dir * t;
    float h = p.y - heightAt(p.xz, uSeed);
    if (h < 0.04) return 0.0;
    shadow = min(shadow, 12.0 * h / t);
    t += clamp(h * 0.9, 1.2, 26.0);
  }
  return clamp(shadow, 0.0, 1.0);
}

float ambientOcclusion(vec3 p, vec3 n) {
  if (uAO == 0) return 1.0;
  float occ = 0.0;
  float scale = 1.0;
  for (int i = 1; i <= 6; i++) {
    if (i > uAO) break;
    float d = 0.8 * float(i);
    vec3 q = p + n * d;
    occ += clamp(d - (q.y - heightAt(q.xz, uSeed)), 0.0, 1.0) * scale;
    scale *= 0.62;
  }
  return clamp(1.0 - occ * 0.55, 0.0, 1.0);
}

// --- shading ---------------------------------------------------------------

/**
 * Ground albedo, including the snow that starts at the tree line and thickens
 * with altitude. Snow accumulates on flats and slides off anything steep, which
 * is what makes a mountain read as rock-and-snow rather than as an iced cake.
 */
vec3 groundAlbedo(vec3 p, vec3 n, out float snowAmount) {
  float slope = 1.0 - n.y;
  float moss = fbm(p.xz * 0.06, uSeed + 211, 3);
  vec3 albedo = mix(vec3(0.045, 0.062, 0.045), vec3(0.035, 0.085, 0.062), smoothstep(0.35, 0.75, moss));
  albedo = mix(albedo, vec3(0.19, 0.17, 0.14), smoothstep(2.4, 0.2, p.y));
  albedo = mix(albedo, vec3(0.075, 0.072, 0.082), smoothstep(0.32, 0.72, slope));
  albedo = mix(albedo, vec3(0.10, 0.10, 0.13), smoothstep(TREE_LINE * 0.55, TREE_LINE, p.y));

  // The snow line wavers with the terrain noise instead of ruling a contour.
  float waver = (fbm(p.xz * 0.0016, uSeed + 1301, 3) - 0.5) * 120.0;
  float altitude = smoothstep(SNOW_LINE + waver - 130.0, SNOW_LINE + waver + 90.0, p.y);
  snowAmount = altitude * smoothstep(0.88, 0.30, slope);
  vec3 snow = vec3(0.90, 0.94, 1.05);
  // Sparkle: a per-metre hash, so it holds still on the surface as you move.
  vec2 grain = floor(p.xz * 3.0);
  float glint = hashUnit2(int(mod(grain.x, 8192.0)), int(mod(grain.y, 8192.0)), uSeed + 1409);
  snow += vec3(0.9, 0.95, 1.0) * smoothstep(0.9975, 1.0, glint) * 4.0;
  return mix(albedo, snow, snowAmount);
}

/** Footprint memory: pools of light where somebody walked. */
vec3 markGlow(vec3 p) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < ${MAX_MARKS}; i++) {
    if (i >= uMarkCount) break;
    vec4 mark = uMarks[i];
    vec2 d = p.xz - mark.xz;
    float dy = p.y - mark.y;
    float falloff = exp(-(dot(d, d) + dy * dy * 0.35) * 0.22);
    sum += vec3(0.25, 0.85, 1.0) * falloff * mark.w;
  }
  return sum * 1.5;
}

vec3 lightSurface(vec3 p, vec3 n, vec3 albedo, int shadowSteps, float gloss, int firstLight) {
  float shade = max(0.0, dot(n, KEY_DIR));
  if (shadowSteps > 0) shade *= terrainShadow(p, KEY_DIR, 520.0, shadowSteps);
  vec3 key = KEY_COLOR * shade * 0.42;
  vec3 ambient = mix(vec3(0.024, 0.036, 0.062), vec3(0.038, 0.055, 0.090), n.y * 0.5 + 0.5);
  vec3 color = albedo * (key + ambient * ambientOcclusion(p, n));

  // Specular on snow and wet rock, which is most of what sells altitude.
  if (gloss > 0.001) {
    vec3 view = normalize(uCamPos - p);
    vec3 halfway = normalize(view + KEY_DIR);
    color += KEY_COLOR * pow(max(0.0, dot(n, halfway)), 48.0) * gloss * shade * 1.6;
  }

  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    if (i < firstLight) continue;
    vec3 delta = uLightPos[i].xyz - p;
    float dist = length(delta);
    float radius = uLightPos[i].w;
    if (dist > radius * 3.5) continue;
    float attenuation = uLightColor[i].a / (1.0 + (dist * dist) / (radius * radius));
    color += albedo * uLightColor[i].rgb * max(0.0, dot(n, delta / max(dist, 1e-4))) * attenuation * 2.6;
  }

  color += albedo * markGlow(p) * 0.55;
  return color;
}

/** Volumetric term: the glow of every light the ray passes near. */
vec3 lightHaze(vec3 ro, vec3 rd, float tMax) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    vec3 oc = uLightPos[i].xyz - ro;
    float proj = clamp(dot(oc, rd), 0.0, tMax);
    float d2 = max(0.0, dot(oc, oc) - proj * proj);
    float radius = uLightPos[i].w;
    sum += uLightColor[i].rgb * uLightColor[i].a * (radius * radius / (d2 + radius * radius * 0.32)) * 0.011;
  }
  return sum;
}

/**
 * Volumetric shafts.
 *
 * March the primary ray again, testing each sample against the same shadow
 * function the surfaces use. Expensive, and the single biggest difference
 * between "a nice render" and "a place with air in it".
 */
vec3 godRays(vec3 ro, vec3 rd, float tMax, float dither) {
  if (uGodRays == 0) return vec3(0.0);
  int samples = uGodRays;
  float far = min(tMax, 620.0);
  float stride = far / float(samples);
  float phase = phaseHG(dot(rd, KEY_DIR), 0.62);
  vec3 sum = vec3(0.0);
  float t = stride * (0.35 + dither * 0.65);
  for (int i = 0; i < 32; i++) {
    if (i >= samples || t > far) break;
    vec3 p = ro + rd * t;
    float lit = terrainShadow(p, KEY_DIR, 300.0, 10);
    float density = exp(-max(0.0, p.y - SEA_LEVEL) * 0.010) * 0.020;
    sum += KEY_COLOR * lit * density * phase * stride;
    t += stride;
  }
  return sum;
}

/** Aerial perspective: distance turns the world the colour of the air. */
vec3 applyFog(vec3 color, float dist, vec3 rd, vec3 p) {
  // Air thins with altitude, so the optical depth is integrated against the
  // height of the thing being looked at, not just the distance to it.
  float lowLying = exp(-max(0.0, p.y - SEA_LEVEL) * 0.0022);
  float density = 1.0 - exp(-dist * 0.00042 * (0.35 + lowLying * 0.65));
  vec3 fogColor = mix(vec3(0.026, 0.046, 0.082), vec3(0.048, 0.076, 0.106), lowLying);
  // Scattering peaks looking toward the light, as it does in real air.
  fogColor += KEY_COLOR * pow(max(0.0, dot(rd, KEY_DIR)), 6.0) * 0.20;
  return mix(color, fogColor, clamp(density, 0.0, 0.88));
}

vec3 shadeReflection(vec3 ro, vec3 rd) {
  float t;
  if (!marchTerrain(ro, rd, 0.2, uFar * 0.4, uSteps / 3, t)) {
    return cloudLayer(ro, rd, skyColor(rd)) + lightHaze(ro, rd, uFar * 0.4) * 0.6;
  }
  vec3 p = ro + rd * t;
  vec3 n = normalAt(p.xz, uSeed, max(0.5, t * 0.006));
  float snow;
  vec3 color = lightSurface(p, n, groundAlbedo(p, n, snow), 0, snow * 0.35, 0) + lightHaze(ro, rd, t) * 0.6;
  return applyFog(color, t, rd, p);
}

vec3 shadeWater(vec3 p, vec3 rd) {
  float detail = clamp(1.0 - length(p - uCamPos) * 0.006, 0.0, 1.0);
  vec2 ripple = p.xz * 0.10 + vec2(uTime * 0.06, -uTime * 0.045);
  float wave = fbm(ripple, uSeed + 811, 3) - 0.5;
  float wave2 = fbm(ripple * 2.7 + 13.0, uSeed + 812, 2) - 0.5;
  vec3 n = normalize(vec3(wave * 0.30 * detail, 1.0, wave2 * 0.30 * detail));
  vec3 reflected = reflect(rd, n);
  vec3 color = cloudLayer(p, reflected, skyColor(reflected)) * 0.9;
  if (uReflection > 0) color = mix(color, shadeReflection(p + reflected * 0.3, reflected), 0.6);
  float fresnel = pow(1.0 - max(0.0, dot(-rd, n)), 5.0);
  color = mix(vec3(0.012, 0.045, 0.062), color, clamp(0.18 + fresnel * 0.9, 0.0, 1.0));
  // Glint: the key light scattering off the chop.
  color += KEY_COLOR * pow(max(0.0, dot(reflected, KEY_DIR)), 220.0) * 3.5;
  color += vec3(0.06, 0.28, 0.34) * markGlow(p).g * 0.25;
  return color + lightHaze(p, -rd, 24.0) * 0.4;
}

vec3 shadeScene(vec3 ro, vec3 rd, float dither) {
  float tTerrain;
  bool hitTerrain = marchTerrain(ro, rd, 0.05, uFar, uSteps, tTerrain);
  float tBound = hitTerrain ? tTerrain : uFar;

  float tWater = 1e9;
  if (rd.y < -0.0005 && ro.y > SEA_LEVEL) {
    float candidate = (SEA_LEVEL - ro.y) / rd.y;
    if (candidate > 0.0 && candidate < tBound) tWater = candidate;
  }

  float tIsland;
  vec4 island;
  bool hitIsland = marchIslands(ro, rd, 0.05, min(tBound, tWater), tIsland, island);

  float tAvatar;
  float avatarGlow;
  float avatarLimit = min(min(tBound, tWater), hitIsland ? tIsland : uFar);
  bool hitAvatar = marchAvatar(ro, rd, 0.05, avatarLimit, tAvatar, avatarGlow);

  float tFlora;
  vec3 floraEmissive;
  vec3 floraNormal;
  bool hitFlora = marchFlora(ro, rd, hitAvatar ? tAvatar : avatarLimit, tFlora, floraEmissive, floraNormal);

  vec3 color;
  float dist;
  vec3 hitPoint;

  if (hitFlora) {
    dist = tFlora;
    hitPoint = ro + rd * tFlora;
    float facing = max(0.0, dot(floraNormal, -rd));
    color = floraEmissive * (0.55 + 0.45 * facing) + floraEmissive * pow(1.0 - facing, 3.0) * 0.8;
  } else if (hitAvatar) {
    dist = tAvatar;
    hitPoint = ro + rd * tAvatar;
    float g;
    vec2 e = vec2(0.006, 0.0);
    vec3 n = normalize(vec3(
      avatarSDF(hitPoint + e.xyy, g) - avatarSDF(hitPoint - e.xyy, g),
      avatarSDF(hitPoint + e.yxy, g) - avatarSDF(hitPoint - e.yxy, g),
      avatarSDF(hitPoint + e.yyx, g) - avatarSDF(hitPoint - e.yyx, g)
    ));
    vec3 skin = mix(vec3(0.10, 0.14, 0.27), hueToRgb(uAppearance.z) * 0.42, 0.5);
    // firstLight = 1: the avatar is not lit by the light it is.
    vec3 lit = lightSurface(hitPoint, n, skin, uShadowSteps / 2, 0.10, 1);
    float rim = pow(1.0 - max(0.0, dot(n, -rd)), 3.0);
    color = lit
      + skin * max(0.0, dot(n, -rd)) * 0.16
      + hueToRgb(uAppearance.w) * avatarGlow * (0.05 + uAppearance2.x * 0.22)
      + hueToRgb(uAppearance.w) * rim * 0.16;
  } else if (hitIsland && tIsland < min(tWater, tBound)) {
    dist = tIsland;
    hitPoint = ro + rd * tIsland;
    vec4 dummy;
    vec2 e = vec2(0.4, 0.0);
    vec3 n = normalize(vec3(
      islandsSDF(hitPoint + e.xyy, dummy) - islandsSDF(hitPoint - e.xyy, dummy),
      islandsSDF(hitPoint + e.yxy, dummy) - islandsSDF(hitPoint - e.yxy, dummy),
      islandsSDF(hitPoint + e.yyx, dummy) - islandsSDF(hitPoint - e.yyx, dummy)
    ));
    vec3 rock = mix(vec3(0.055, 0.055, 0.07), vec3(0.03, 0.075, 0.055), clamp(n.y, 0.0, 1.0));
    color = rock * (KEY_COLOR * max(0.0, dot(n, KEY_DIR)) * 0.55 + vec3(0.03, 0.045, 0.08));
    color += vec3(0.02, 0.12, 0.08) * smoothstep(0.35, 0.9, n.y);
    color += vec3(0.10, 0.35, 0.55) * pow(clamp(-n.y, 0.0, 1.0), 2.0) * 0.35;
  } else if (tWater < tBound) {
    dist = tWater;
    hitPoint = ro + rd * tWater;
    color = shadeWater(hitPoint, rd);
  } else if (hitTerrain) {
    dist = tTerrain;
    hitPoint = ro + rd * tTerrain;
    vec3 n = normalAt(hitPoint.xz, uSeed, max(0.35, dist * 0.004));
    float detail = clamp(1.0 - dist / 160.0, 0.0, 1.0);
    if (detail > 0.01) {
      float e = 0.35;
      vec2 g = vec2(
        fbm(hitPoint.xz * 0.55 + vec2(e, 0.0), uSeed + 1511, 3) - fbm(hitPoint.xz * 0.55 - vec2(e, 0.0), uSeed + 1511, 3),
        fbm(hitPoint.xz * 0.55 + vec2(0.0, e), uSeed + 1511, 3) - fbm(hitPoint.xz * 0.55 - vec2(0.0, e), uSeed + 1511, 3)
      );
      n = normalize(n + vec3(-g.x, 0.0, -g.y) * detail * 2.4);
    }
    float snow;
    vec3 albedo = groundAlbedo(hitPoint, n, snow);
    color = lightSurface(hitPoint, n, albedo, uShadowSteps, snow * 0.55, 0);
    // Snow scatters the whole sky, not just the key — this is most of why a
    // snowfield reads as bright at night.
    color += albedo * snow * vec3(0.10, 0.13, 0.22) * (0.4 + 0.6 * n.y);
    // And the giant puts a cold rim on every ridge that faces it.
    vec3 giantDir = normalize(vec3(0.42, 0.30, -0.85));
    color += vec3(0.16, 0.15, 0.24) * max(0.0, dot(n, giantDir)) * (0.25 + snow * 0.9);
  } else {
    color = cloudLayer(ro, rd, skyColor(rd));
    return color + lightHaze(ro, rd, uFar) + godRays(ro, rd, uFar, dither);
  }

  color = applyFog(color, dist, rd, hitPoint);
  return color + lightHaze(ro, rd, dist) + godRays(ro, rd, dist, dither);
}

void main() {
  vec2 uv = (vUv * 2.0 - 1.0) * vec2(uResolution.x / uResolution.y, 1.0);
  vec3 rd = normalize(uCamBasis * vec3(uv * uFov, 1.0));
  vec2 fc = mod(gl_FragCoord.xy, 2048.0);
  float dither = hashUnit2(int(fc.x), int(fc.y), uSeed + int(uTime * 60.0));
  fragColor = vec4(shadeScene(uCamPos, rd, dither), 1.0);
}`;

const BRIGHT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uScene;
uniform vec2 uTexel;
uniform float uThreshold;
void main() {
  // Four-tap box downsample, then a soft knee so nothing pops in or out.
  vec3 sum = texture(uScene, vUv + vec2(-uTexel.x, -uTexel.y)).rgb
           + texture(uScene, vUv + vec2( uTexel.x, -uTexel.y)).rgb
           + texture(uScene, vUv + vec2(-uTexel.x,  uTexel.y)).rgb
           + texture(uScene, vUv + vec2( uTexel.x,  uTexel.y)).rgb;
  vec3 color = sum * 0.25;
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float knee = smoothstep(uThreshold, uThreshold * 2.2, luma);
  fragColor = vec4(color * knee, 1.0);
}`;

const BLUR_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSource;
uniform vec2 uDirection;
void main() {
  // Nine-tap gaussian, five fetches, linear-sampled offsets.
  vec3 color = texture(uSource, vUv).rgb * 0.2270270270;
  color += texture(uSource, vUv + uDirection * 1.3846153846).rgb * 0.3162162162;
  color += texture(uSource, vUv - uDirection * 1.3846153846).rgb * 0.3162162162;
  color += texture(uSource, vUv + uDirection * 3.2307692308).rgb * 0.0702702703;
  color += texture(uSource, vUv - uDirection * 3.2307692308).rgb * 0.0702702703;
  fragColor = vec4(color, 1.0);
}`;

const COMPOSITE_SHADER = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uExposure;
uniform float uVignette;
uniform float uTime;
uniform int uSeed;
uniform vec2 uResolution;

uint hash2i(int x, int y, int seed) {
  uint h = uint(x) * 374761393u + uint(y) * 668265263u + uint(seed) * 2147483647u;
  h = (h ^ (h >> 13)) * 1274126177u;
  return h ^ (h >> 16);
}

// ACES filmic tone mapping — Stephen Hill's fit (MIT).
vec3 acesToneMap(vec3 x) {
  mat3 inputMat = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  mat3 outputMat = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  vec3 v = inputMat * x;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(outputMat * (a / b), 0.0, 1.0);
}

void main() {
  vec3 color = texture(uScene, vUv).rgb;
  color += texture(uBloom, vUv).rgb * uBloomStrength;
  color = acesToneMap(color * uExposure);

  // A cool shadow lift and a warm highlight roll, the whole colour grade.
  color = mix(color, color * vec3(0.92, 1.0, 1.10), 0.35);
  color = pow(color, vec3(1.0 / 2.2));

  float d = length(vUv - 0.5);
  color *= 1.0 - smoothstep(0.35, 0.92, d) * uVignette;

  vec2 fc = mod(gl_FragCoord.xy, 2048.0);
  float dither = float(hash2i(int(fc.x), int(fc.y), uSeed + int(uTime * 60.0))) / 4294967296.0;
  fragColor = vec4(color + (dither - 0.5) / 255.0, 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    const line = Number(/ERROR:\s*\d+:(\d+)/.exec(log ?? '')?.[1] ?? 0);
    const lines = source.split('\n');
    const context = lines
      .slice(Math.max(0, line - 4), line + 3)
      .map((text, i) => `${String(Math.max(1, line - 3) + i).padStart(4)} ${text}`)
      .join('\n');
    gl.deleteShader(shader);
    throw new Error(`shader compile failed:\n${log}\n${context}`);
  }
  return shader;
}

function link(gl, fragmentSource, uniformNames) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, FULLSCREEN_VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  const uniforms = {};
  for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
  return { program, uniforms };
}

export function createRaymarchRenderer(canvas, options = {}) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
  });
  if (!gl) throw new Error('WebGL2 is required for the ray-traced renderer');

  // Float render targets keep the bloom honest; without them everything above
  // white is clipped before the bright pass ever sees it.
  const hdr = gl.getExtension('EXT_color_buffer_float');
  const linearFloat = gl.getExtension('OES_texture_float_linear');
  const internalFormat = hdr ? gl.RGBA16F : gl.RGBA8;
  const textureType = hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

  const scene = link(gl, SCENE_SHADER, [
    'uResolution', 'uTime', 'uSeed', 'uCamPos', 'uCamBasis', 'uFov',
    'uSteps', 'uShadowSteps', 'uReflection', 'uAO', 'uIslands', 'uClouds', 'uGodRays', 'uFar',
    'uLightCount', 'uLightPos', 'uLightColor', 'uMarkCount', 'uMarks',
    'uAvatarPos', 'uAvatarYaw', 'uAvatarPhase', 'uAvatarSpeed', 'uAvatarVisible',
    'uAppearance', 'uAppearance2',
  ]);
  const bright = link(gl, BRIGHT_SHADER, ['uScene', 'uTexel', 'uThreshold']);
  const blur = link(gl, BLUR_SHADER, ['uSource', 'uDirection']);
  const composite = link(gl, COMPOSITE_SHADER, [
    'uScene', 'uBloom', 'uBloomStrength', 'uExposure', 'uVignette', 'uTime', 'uSeed', 'uResolution',
  ]);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const lightPos = new Float32Array(MAX_LIGHTS * 4);
  const lightColor = new Float32Array(MAX_LIGHTS * 4);
  const marks = new Float32Array(MAX_MARKS * 4);

  let quality = QUALITY[options.quality ?? 'medium'];
  let qualityName = options.quality ?? 'medium';
  let renderScale = quality.scale;
  const overrides = {}; // per-feature user overrides, applied over the preset
  const state = { width: 0, height: 0, frames: 0, lastMs: 0, avgMs: 16 };

  const targets = { scene: null, bloomA: null, bloomB: null };

  function makeTarget(width, height) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, gl.RGBA, textureType, null);
    const filter = hdr && !linearFloat ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture, framebuffer, width, height };
  }

  function disposeTarget(target) {
    if (!target) return;
    gl.deleteTexture(target.texture);
    gl.deleteFramebuffer(target.framebuffer);
  }

  function resize(cssWidth, cssHeight) {
    const width = Math.max(64, Math.round(cssWidth * renderScale));
    const height = Math.max(64, Math.round(cssHeight * renderScale));
    if (width === state.width && height === state.height) return;
    canvas.width = width;
    canvas.height = height;
    state.width = width;
    state.height = height;

    for (const key of Object.keys(targets)) disposeTarget(targets[key]);
    targets.scene = makeTarget(width, height);
    const bw = Math.max(16, width >> 2);
    const bh = Math.max(16, height >> 2);
    targets.bloomA = makeTarget(bw, bh);
    targets.bloomB = makeTarget(bw, bh);
  }

  function setting(name) {
    return overrides[name] ?? quality[name];
  }

  function setQuality(name) {
    if (!QUALITY[name]) return;
    quality = QUALITY[name];
    qualityName = name;
    renderScale = overrides.scale ?? quality.scale;
    state.width = 0; // force a resize on the next frame
  }

  /** Individual graphics options, layered over the preset. */
  function setOption(name, value) {
    if (value === null || value === undefined) delete overrides[name];
    else overrides[name] = value;
    if (name === 'scale') {
      renderScale = overrides.scale ?? quality.scale;
      state.width = 0;
    }
  }

  function setRenderScale(scale) {
    renderScale = Math.max(0.2, Math.min(2, scale));
    state.width = 0;
  }

  /**
   * Choose this frame's lights: the nearest flora weighted by how awake they
   * are. This is interest management again — same idea as the projection layer,
   * different currency.
   */
  function gatherLights(world, camera) {
    const candidates = [];
    for (const chunk of world.ecs.query(['Position', 'Flora'])) {
      const px = chunk.col('Position', 'x');
      const py = chunk.col('Position', 'y');
      const pz = chunk.col('Position', 'z');
      const species = chunk.col('Flora', 'species');
      const charge = chunk.col('Flora', 'charge');
      const bloomed = chunk.col('Flora', 'bloomed');
      const scale = chunk.col('Flora', 'scale');
      for (let i = 0; i < chunk.count; i++) {
        const intensity = 0.18 + (bloomed[i] ? 0.18 : 0) + charge[i] * 1.6;
        const distance = Math.hypot(px[i] - camera.position.x, py[i] - camera.position.y, pz[i] - camera.position.z);
        if (distance > 260) continue;
        candidates.push({
          x: px[i],
          y: py[i] + SPECIES[species[i]].height * 0.5 * scale[i],
          z: pz[i],
          radius: SPECIES[species[i]].radius * (0.8 + scale[i] * 0.5),
          hue: SPECIES[species[i]].hue,
          intensity,
          score: intensity / (1 + distance * 0.012),
        });
      }
    }

    // The avatar is a light. It is covered in bioluminescence, it is standing
    // in the dark, and without it the foreground has nothing lighting it at all.
    // It goes in slot 0, which the flora pass skips: it lights the world but has
    // no body of its own, because the avatar already has one.
    candidates.sort((a, b) => b.score - a.score);
    const count = Math.min(setting('lights'), candidates.length + 1, MAX_LIGHTS);
    if (camera.avatar) {
      const look = camera.avatar.appearance;
      const rgb = hueToRgb(look.glowHue);
      lightPos.set([
        camera.avatar.position.x,
        camera.avatar.position.y - 0.6,
        camera.avatar.position.z,
        4.5 + look.glowDensity * 3.5,
      ], 0);
      lightColor.set([rgb[0], rgb[1], rgb[2], 0.14 + look.glowDensity * 0.22], 0);
    }
    const offset = camera.avatar ? 1 : 0;
    for (let i = offset; i < count; i++) {
      const light = candidates[i - offset];
      lightPos.set([light.x, light.y, light.z, light.radius], i * 4);
      const rgb = hueToRgb(light.hue);
      lightColor.set([rgb[0], rgb[1], rgb[2], light.intensity], i * 4);
    }
    return count;
  }

  /** The remembered marks near enough to still be legible. */
  function gatherMarks(world, camera) {
    const memory = world.stores.get('regions');
    if (!memory) return 0;
    const here = memory.coordOf(camera.position.x, camera.position.z);
    const found = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const mark of memory.resolve(here.cx + dx, here.cy + dz, world.tick)) {
          if (mark.op !== 'trail' && mark.op !== 'beacon') continue;
          const distance = Math.hypot(mark.x - camera.position.x, mark.z - camera.position.z);
          if (distance > 190) continue;
          found.push({ mark, weight: mark.intensity / (1 + distance * 0.02) });
        }
      }
    }
    found.sort((a, b) => b.weight - a.weight);
    const count = Math.min(setting('marks'), found.length, MAX_MARKS);
    for (let i = 0; i < count; i++) {
      const { mark } = found[i];
      marks.set([mark.x, (mark.y ?? 0) + 0.15, mark.z, mark.intensity * (mark.op === 'beacon' ? 3 : 1)], i * 4);
    }
    return count;
  }

  function drawTo(target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
    gl.viewport(0, 0, target ? target.width : state.width, target ? target.height : state.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function render(world, camera, frame = {}) {
    const started = performance.now();
    camera.avatar = frame.firstPerson ? null : frame.avatar;
    gl.bindVertexArray(vao);

    // --- scene pass ---------------------------------------------------------
    gl.useProgram(scene.program);
    const u = scene.uniforms;
    gl.uniform2f(u.uResolution, state.width, state.height);
    gl.uniform1f(u.uTime, world.time);
    gl.uniform1i(u.uSeed, world.seed | 0);
    gl.uniform3f(u.uCamPos, camera.position.x, camera.position.y, camera.position.z);
    gl.uniformMatrix3fv(u.uCamBasis, false, camera.basis);
    gl.uniform1f(u.uFov, camera.fov ?? 1.0);
    gl.uniform1i(u.uSteps, setting('steps'));
    gl.uniform1i(u.uShadowSteps, setting('shadowSteps'));
    gl.uniform1i(u.uReflection, setting('reflection'));
    gl.uniform1i(u.uAO, setting('ao'));
    gl.uniform1i(u.uIslands, setting('islands'));
    gl.uniform1i(u.uClouds, setting('clouds'));
    gl.uniform1i(u.uGodRays, setting('godRays'));
    gl.uniform1f(u.uFar, frame.far ?? 12000);

    const lightCount = gatherLights(world, camera);
    gl.uniform1i(u.uLightCount, lightCount);
    gl.uniform4fv(u.uLightPos, lightPos);
    gl.uniform4fv(u.uLightColor, lightColor);

    const markCount = gatherMarks(world, camera);
    gl.uniform1i(u.uMarkCount, markCount);
    gl.uniform4fv(u.uMarks, marks);

    const avatar = frame.avatar;
    if (avatar) {
      gl.uniform3f(u.uAvatarPos, avatar.position.x, avatar.position.y, avatar.position.z);
      gl.uniform1f(u.uAvatarYaw, avatar.yaw);
      gl.uniform1f(u.uAvatarPhase, avatar.phase ?? 0);
      gl.uniform1f(u.uAvatarSpeed, avatar.speed ?? 0);
      gl.uniform1i(u.uAvatarVisible, frame.firstPerson ? 0 : 1);
      const look = avatar.appearance;
      gl.uniform4f(u.uAppearance, look.height, look.build, look.skinHue, look.glowHue);
      gl.uniform4f(u.uAppearance2, look.glowDensity, look.marking, look.queue, avatar.swimming ?? 0);
    } else {
      gl.uniform1i(u.uAvatarVisible, 0);
    }
    drawTo(targets.scene);

    // --- bloom --------------------------------------------------------------
    const bloomOn = setting('bloom') > 0;
    if (bloomOn) {
      gl.useProgram(bright.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, targets.scene.texture);
      gl.uniform1i(bright.uniforms.uScene, 0);
      gl.uniform2f(bright.uniforms.uTexel, 1 / state.width, 1 / state.height);
      gl.uniform1f(bright.uniforms.uThreshold, frame.bloomThreshold ?? 0.55);
      drawTo(targets.bloomA);

      gl.useProgram(blur.program);
      const passes = setting('bloomPasses');
      for (let i = 0; i < passes; i++) {
        const radius = 1 + i * 1.35;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, targets.bloomA.texture);
        gl.uniform1i(blur.uniforms.uSource, 0);
        gl.uniform2f(blur.uniforms.uDirection, radius / targets.bloomA.width, 0);
        drawTo(targets.bloomB);

        gl.bindTexture(gl.TEXTURE_2D, targets.bloomB.texture);
        gl.uniform2f(blur.uniforms.uDirection, 0, radius / targets.bloomA.height);
        drawTo(targets.bloomA);
      }
    }

    // --- composite ----------------------------------------------------------
    gl.useProgram(composite.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targets.scene.texture);
    gl.uniform1i(composite.uniforms.uScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, (bloomOn ? targets.bloomA : targets.scene).texture);
    gl.uniform1i(composite.uniforms.uBloom, 1);
    gl.uniform1f(composite.uniforms.uBloomStrength, bloomOn ? (frame.bloomStrength ?? 0.85) : 0);
    gl.uniform1f(composite.uniforms.uExposure, frame.exposure ?? 1.5);
    gl.uniform1f(composite.uniforms.uVignette, frame.vignette ?? 0.34);
    gl.uniform1f(composite.uniforms.uTime, world.time);
    gl.uniform1i(composite.uniforms.uSeed, world.seed | 0);
    gl.uniform2f(composite.uniforms.uResolution, state.width, state.height);
    drawTo(null);

    const ms = performance.now() - started;
    state.frames++;
    state.lastMs = ms;
    state.avgMs = state.avgMs * 0.9 + ms * 0.1;
    return {
      ms,
      lights: lightCount,
      marks: markCount,
      width: state.width,
      height: state.height,
      bloom: bloomOn,
      godRays: setting('godRays'),
      hdr: Boolean(hdr),
    };
  }

  return {
    gl,
    render,
    resize,
    setQuality,
    setOption,
    setRenderScale,
    get quality() {
      return qualityName;
    },
    settings() {
      return {
        steps: setting('steps'),
        shadowSteps: setting('shadowSteps'),
        reflection: setting('reflection'),
        ao: setting('ao'),
        clouds: setting('clouds'),
        godRays: setting('godRays'),
        bloom: setting('bloom'),
        lights: setting('lights'),
        scale: renderScale,
        hdr: Boolean(hdr),
      };
    },
    get stats() {
      return { ...state, renderScale, quality: qualityName };
    },
    dispose() {
      for (const key of Object.keys(targets)) disposeTarget(targets[key]);
      for (const { program } of [scene, bright, blur, composite]) gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
    },
  };
}

function hueToRgb(h) {
  return [0, 2 / 3, 1 / 3].map((offset) => {
    const k = (h + offset) % 1;
    return Math.max(0, Math.min(1, Math.abs(k * 6 - 3) - 1));
  });
}

/**
 * Third-person orbit camera with terrain clearance, or first person at eye
 * height. Returns the basis the shader needs. Nothing here touches the world.
 */
export function buildCamera(avatar, options = {}) {
  const distance = options.distance ?? 7.2;
  const firstPerson = options.firstPerson ?? false;
  const { yaw, pitch } = avatar;
  const height = avatar.appearance.height;

  const forward = {
    x: Math.sin(yaw) * Math.cos(pitch),
    y: Math.sin(pitch),
    z: Math.cos(yaw) * Math.cos(pitch),
  };

  let position;
  if (firstPerson) {
    position = {
      x: avatar.position.x + forward.x * 0.4,
      y: avatar.position.y + 0.1 * height,
      z: avatar.position.z + forward.z * 0.4,
    };
  } else {
    // Over the shoulder: the body frames the view instead of blocking it.
    const shoulder = options.shoulder ?? 0.95;
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    position = {
      x: avatar.position.x - forward.x * distance + rightX * shoulder,
      y: avatar.position.y - forward.y * distance + 1.5 * height,
      z: avatar.position.z - forward.z * distance + rightZ * shoulder,
    };
    const clearance = (options.groundAt?.(position.x, position.z) ?? SEA_LEVEL) + 1.6;
    if (position.y < clearance) position.y = clearance;
  }

  const target = {
    x: avatar.position.x + forward.x * 8,
    y: avatar.position.y + forward.y * 8 + (firstPerson ? 0 : 0.9),
    z: avatar.position.z + forward.z * 8,
  };
  // fov is the tangent of the vertical half-angle: 0.58 is a ~60° vertical,
  // ~91° horizontal frame on 16:9. The default of 1.0 this started with was a
  // 121° fisheye, which is why the mountain looked like a hill.
  return { position, basis: lookAt(position, target), fov: options.fov ?? 0.58 };
}

function lookAt(from, to) {
  const fx = to.x - from.x;
  const fy = to.y - from.y;
  const fz = to.z - from.z;
  const flen = Math.hypot(fx, fy, fz) || 1;
  const f = [fx / flen, fy / flen, fz / flen];
  // right = normalize(cross(worldUp, forward))
  let rx = f[2];
  let ry = 0;
  let rz = -f[0];
  const rlen = Math.hypot(rx, ry, rz) || 1;
  rx /= rlen;
  ry /= rlen;
  rz /= rlen;
  // up = cross(forward, right)
  const ux = f[1] * rz - f[2] * ry;
  const uy = f[2] * rx - f[0] * rz;
  const uz = f[0] * ry - f[1] * rx;
  // Column-major 3x3 for GLSL: columns are right, up, forward.
  return new Float32Array([rx, ry, rz, ux, uy, uz, f[0], f[1], f[2]]);
}
