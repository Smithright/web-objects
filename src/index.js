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
export { renderAscii, renderLegend } from './demo/renderers/ascii.js';
export { renderSemantic } from './demo/renderers/semantic.js';
