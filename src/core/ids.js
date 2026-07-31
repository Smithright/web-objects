// Entity identity.
//
//   typedef struct { uint64_t universe; uint64_t entity; } EntityId;
//
// In memory an entity is a packed handle — an index into archetype storage plus
// a generation counter so a stale handle can never silently address a recycled
// slot. On the wire and in the graph it is the pair (universe, index), which
// stays stable while every component around it changes.

export const INDEX_BITS = 22;
export const MAX_ENTITIES = 1 << INDEX_BITS; // 4,194,304 per universe
export const NULL_ENTITY = 0;

export function makeHandle(index, generation) {
  return generation * MAX_ENTITIES + index;
}

export function handleIndex(handle) {
  return handle % MAX_ENTITIES;
}

export function handleGeneration(handle) {
  return Math.floor(handle / MAX_ENTITIES);
}

/** Canonical cross-universe identity, stable for the entity's whole life. */
export function entityKey(universe, handle) {
  return `${universe}#${handleIndex(handle)}`;
}

export function parseEntityKey(key) {
  const [universe, index] = String(key).split('#');
  return { universe, index: Number(index) };
}

/** Wire form: a real 64-bit pair, for ABI compatibility with the C17 core. */
export function packEntityId(universe, handle) {
  return (BigInt(universe) << 64n) | BigInt(handleIndex(handle));
}
