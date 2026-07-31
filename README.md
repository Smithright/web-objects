# Latticeborn

**The world is not the renderer.**

An open reality engine: the canonical world is a temporal record of identities,
components, fields, relationships, laws, and events. Renderers — a browser
canvas, a terminal, an agent's affordance list — receive filtered *projections*
of that world. None of them owns truth.

This repository contains the [publication draft](web/index.html) of the
architecture and a **working reference implementation** of its spine: Phase 0
(contracts) and Phase 1 (single-node world), plus the projection layer and a
live browser client from Phase 2.

Zero dependencies. No build step. Runs unmodified in Node and in a browser.

---

## Run it

```bash
node bin/latticeborn.js demo      # the reference world, rendered as ASCII
node bin/latticeborn.js verify    # determinism, replay, rollback, branching — proven
node bin/latticeborn.js inspect   # one entity, rendered with no pixels at all
node bin/latticeborn.js bench     # entity-ticks per second across populations
node bin/latticeborn.js chunk     # terrain regenerated from causes alone

npm test                          # 48 checks across substrate and runtime
npm run serve                     # publication + live world on localhost:8080
```

`npm run serve` then open <http://localhost:8080/demo> — the browser client
imports the engine straight out of `src/` as ES modules. Nothing is compiled,
minified, or transpiled between the source you read and the world that runs.

`node tools/bundle.mjs` folds that same client into one self-contained HTML
file for environments that cannot fetch modules from disk.

---

## What `verify` proves

```
✓ determinism          two independent runs of 600 ticks agree at ad7e0389
✓ replay               checkpoint at t200 + 3 recorded commands reproduced t600 exactly
✓ rollback             state rewound to t200 and resimulated forward converges
✓ branching            u1 forked at t600 diverged while u0 continued, matching a control run
✓ event integrity      1194 events verify against their seal chain
✓ capability sandbox   3332 denied reads from 3332 rogue invocations, simulation never interrupted
✓ procedural genesis   chunk (3,-2) regenerates from causes alone
✓ schema guard         a checkpoint cannot be loaded into a world with a different schema
```

These are not assertions about intent. Each one runs the engine and compares
state hashes.

---

## The source map

| Layer | File | What it is |
| --- | --- | --- |
| Identity | [`src/core/ids.js`](src/core/ids.js) | Packed handles with generations; stable cross-universe keys |
| Substrate | [`src/core/ecs.js`](src/core/ecs.js) | Archetype tables, one typed array per component field |
| | [`src/core/fields.js`](src/core/fields.js) | Continuous scalar fields: diffusion, decay, sampling, gradients |
| | [`src/core/graph.js`](src/core/graph.js) | Semantic graph with provenance and tombstoned history |
| | [`src/core/spatial.js`](src/core/spatial.js) | Uniform hash grid and the LOD ladder |
| Runtime | [`src/core/scheduler.js`](src/core/scheduler.js) | Hazard DAG derived from declared reads/writes; waves; rate limits |
| | [`src/core/laws.js`](src/core/laws.js) | Capability-secured behavior with metered budgets |
| | [`src/core/world.js`](src/core/world.js) | Commands, ticks, checkpoints, replay, forking, state hashing |
| Durability | [`src/core/events.js`](src/core/events.js) | Append-only log, causal parents, seal chain |
| | [`src/core/procedural.js`](src/core/procedural.js) | Chunks as pure functions of immutable causes |
| Projection | [`src/core/projection.js`](src/core/projection.js) | Interest horizons, deltas, P0–P4 priority, bandwidth budget |
| Views | [`src/demo/renderers/canvas.js`](src/demo/renderers/canvas.js) | Pixels |
| | [`src/demo/renderers/ascii.js`](src/demo/renderers/ascii.js) | Glyphs |
| | [`src/demo/renderers/semantic.js`](src/demo/renderers/semantic.js) | Affordances, relations, causal history — no pixels |
| World | [`src/demo/testbed.js`](src/demo/testbed.js) | "The Grove": the reference world every command above runs |

---

## The Grove

Six beacons radiate heat into a continuous field. Eight hundred motes fall
through their gravity. Two hundred foragers run sandboxed behavior: they read
the heat gradient, steer toward warmth, metabolize it, reproduce, and starve.
Lineage and territory accrue in the semantic graph. Every birth, death,
utterance, and operator command lands in the event log.

Roughly six percent of foragers run `forage.rogue` — the same behavior, but it
reaches for a capability it was never granted. The host denies the read, that
agent loses its turn, and the tick continues. You can watch the denial counter
climb in both clients.

Population is not scripted. It crashes to about a third of its starting size as
the initial heat is eaten, then recovers to a carrying capacity set by how fast
the beacons can radiate.

---

## Three design decisions worth reading the code for

**Canonical row order.** Archetype rows are kept sorted by entity index at all
times — insert and delete are memmoves, not swap-removes. Row order determines
the order floating-point accumulations happen in, so making it canonical is
what makes replay bit-exact *and* makes observing a world (checkpointing,
forking, snapshotting) incapable of perturbing it. See `Archetype.insertRow`.

**Denial is the default.** A law reaches the world only through paths its grant
names, and only paths with a registered provider exist at all. A capability
fault rolls the whole invocation back — a half-applied intent is worse than no
intent. See `LawHost.invoke`.

**Projections are lossy on purpose.** When a client's tick budget runs out, low
priority is *dropped*, not queued. A renderer can always reconstruct cosmetic
detail; it can never invent authority state. Typical observers in the demo
receive 70–95% less than full replication would cost. See `ProjectionServer.snapshot`.

---

## Scope

Implemented: schema registry and component ABI, archetype ECS, hazard
scheduler, sealed event log, checkpoints, replay, rollback, universe branching,
continuous fields, semantic graph, spatial index and LOD, capability sandbox,
procedural genesis with mutation logs, projection with interest management, and
three renderers.

Not implemented, and described in the publication as future work: the C17 core
ABI and Rust services, Jolt physics, the NATS/JetStream fabric, PostgreSQL and
Apache AGE persistence, real WebAssembly law components under Wasmtime, region
migration and distribution, and the O3DE, Godot, and WebGPU clients. The
reference core is JavaScript so that one implementation can run in a terminal
and a browser without a toolchain — it is the spine, not the skin.

---

Apache-2.0. See [LICENSE](LICENSE).
