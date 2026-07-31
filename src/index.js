// Latticeborn — public surface.
//
// The world is not the renderer. Everything below the projection layer is
// canonical; everything above it is a view.

export { Digest, fnv1a, commutativeMix } from './core/hash.js';
export { Rng, seedFrom, hashUnit } from './core/rng.js';
export {
  MAX_ENTITIES,
  NULL_ENTITY,
  entityKey,
  handleGeneration,
  handleIndex,
  makeHandle,
  packEntityId,
  parseEntityKey,
} from './core/ids.js';
export { ComponentType, Ecs, Registry } from './core/ecs.js';
export { EventClass, EventLog, SCHEMA_VERSION, canonicalJson, hashEvent } from './core/events.js';
export { Backend, Domain, Mode, Scheduler, System } from './core/scheduler.js';
export { SemanticGraph } from './core/graph.js';
export { ScalarField } from './core/fields.js';
export { LOD_BANDS, SpatialHash, lodCost, lodFor } from './core/spatial.js';
export { BudgetError, Capabilities, CapabilityError, Law, LawHost } from './core/laws.js';
export {
  Biome,
  CHUNK_SIZE,
  GENERATOR_VERSION,
  applyMutationLog,
  biomeHistogram,
  chunkDigest,
  fbm,
  generateChunk,
} from './core/procedural.js';
export { ClientView, Priority, ProjectionServer } from './core/projection.js';
export { CHECKPOINT_VERSION, World } from './core/world.js';
export {
  Biome as TerrainBiome,
  SEA_LEVEL,
  TERRAIN_AMPLITUDE,
  TERRAIN_GLSL,
  TERRAIN_SCALE,
  TERRAIN_VERSION,
  biomeAt,
  fbm as terrainFbm,
  heightAt,
  normalAt,
  ridged,
  slopeAt,
} from './core/terrain.js';
export { DEFAULT_REGION_SIZE, RegionMemory, RegionState, TRAIL_HALF_LIFE } from './core/regions.js';

export {
  DEFAULT_CONFIG,
  Kind,
  MAX_AGENTS,
  TICK_HZ,
  WORLD_SIZE,
  createTestbed,
  install as installTestbed,
  populate,
  spawnBeacon,
  spawnForager,
  spawnMote,
  testbedOptions,
} from './demo/testbed.js';
export {
  BIOME_NAMES,
  DEFAULT_APPEARANCE,
  DEFAULT_CONFIG as PANDORA_CONFIG,
  EYE_HEIGHT,
  Kind as PandoraKind,
  SPECIES,
  avatarHandle,
  avatarState,
  createPandora,
  findLanding,
  install as installPandora,
  pandoraOptions,
  regionContents,
} from './demo/pandora.js';
export { renderAscii, renderLegend } from './demo/renderers/ascii.js';
export { renderAscii3d } from './demo/renderers/ascii3d.js';
export { renderSemantic } from './demo/renderers/semantic.js';
