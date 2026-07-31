# Latticeborn

**The world is not the renderer.**

An open reality engine. The canonical world is a temporal record of identities,
components, fields, relationships, laws, and events. Renderers — a ray tracer, a
terminal, an agent's list of affordances — receive filtered *projections* of it.
None of them owns truth.

The default world is **Pandora**: a bioluminescent moon with no terrain file, no
scene graph, and no meshes. Every ridge, plant, and drifting seed is a pure
function of one seed and a coordinate. Nothing exists until somebody looks at
it — and the moment somebody does, that region starts keeping a history.

You wake up facing a mountain. It is 1.45 km of snow-capped relief four
kilometres away, it is in the same place on every machine that computes this
seed, and it is stored nowhere: it is a term in the height function.

```bash
npm run serve      # then open http://localhost:8080
npm run walk       # or walk the same world in your terminal
npm test           # 66 checks across the substrate, runtime, and world
```

---

## Pandora

Walk it with **WASD + mouse** or **any standard gamepad**. Third or first
person. Your avatar is customizable and its appearance is *world state*, not a
client setting — changing it submits a command that lands in the event log.

What "procedurally remembered" means, concretely:

| | |
| --- | --- |
| **Latent** | Nobody has been here. It occupies zero bytes and is not stored anywhere. It will resolve to the same terrain and the same plants the first time anyone looks. |
| **Resident** | Someone is here. Entities exist, systems run, and everything consequential is appended to this region's log. |
| **Remembered** | They left. The entities are gone, the state is gone, the log is not. Returning regenerates default reality from the causes and replays your divergence over it. |

So: your footfalls stay lit and fade on a deterministic curve. Plants remember
the first time you walked past them. A plant you take stays taken — walk a
kilometre away until the region unloads, come back, and the gap is still there.
A light you plant never fades at all. The HUD shows what it costs: a few KiB of
history where materialized state would have been megabytes.

**Controls** — `WASD`/arrows move, mouse look, `space` jump, `shift` sprint,
`E` take a plant, `Q` plant a light, `V` first/third person, `Tab` panel,
`Esc` release the pointer. Gamepad follows the W3C Standard Mapping: left stick
moves, right stick looks, `A` jumps, `L3`/right trigger sprints, `X` takes,
`Y` plants, `RB` switches view — with a radial deadzone and an expo response
curve, so fine aim is actually fine.

### The renderer

A WebGL2 fragment shader, one fullscreen triangle, no geometry of any kind, in
three passes: HDR scene → bloom → tone-mapped composite. The scene pass imports
[`src/core/terrain.js`](src/core/terrain.js) — the *same* height field the
simulation walks on, emitted as GLSL from the same file that defines the
JavaScript — and marches primary rays against it. Then it casts secondary rays:
soft shadows, water reflection, ambient occlusion, and volumetric shafts. Flora
light, footprint memory, and the avatar arrive as uniforms drawn from world
state.

That shared-terrain detail is the whole point. If the CPU and GPU each had their
own copy of the world they would drift apart by the third week, and the avatar
would walk on terrain nobody can see. Open `/parity.html` to watch both
evaluate the same 64 points and disagree only in float32 rounding.

Also in the frame: a gas giant with banded storms, aurora, a drifting cloud
deck, floating islands on a hash lattice, a snow line that wavers with the
terrain noise, and sparkle on the snow. Presets run `low` → `max`; `max` is
supersampled at 1.7× with every secondary ray enabled, and each of them can be
toggled individually. Resolution adapts to hold the frame budget.

It is real-time ray *marching* (sphere tracing) with secondary rays, not
hardware RTX.

### Importing avatars

Drag a `.vrm` or `.glb` onto the window and you are wearing it.

```bash
node tools/make-avatar.mjs      # authors a CC0 VRM 1.0 test avatar
```

The importer reads GLB and glTF 2.0 — accessors including sparse and
interleaved, skins, morph targets, materials, embedded textures — plus VRM 1.0
(`VRMC_vrm`) and VRM 0.x. It maps the rig two ways: believe the file when it
declares a humanoid, and otherwise infer one from node names, which is what
actually happens with an FBX exported out of Unity or Blender.
`mixamorig:LeftForeArm`, `upper_arm.L`, `J_Bip_L_UpperArm`, and `LeftLowerArm`
all land on the same canonical joint, and the result reports whether it was
*declared* or *inferred* — because an importer that silently guesses wrong
about `leftLowerArm` gives you an avatar whose elbow bends backwards.

**On VRChat specifically:** `.vrca` files are proprietary Unity AssetBundles on
VRChat's CDN, and pulling them down breaks both their terms and, usually, the
creator's copyright. This engine imports the *authoring* formats — the same
ones Resonite takes — so any avatar you legitimately own loads.

An import does not produce "an avatar object". It produces **slots and
components**: one slot per node, a renderer component on the ones that draw,
mesh and material assets in the registry, and a tag on every bone naming its
humanoid joint. Afterwards the avatar is ordinary world state — inspectable,
re-parentable, checkpointed, and forkable like anything else.

```
latticeborn-testbed/Testbed/hips/spine/chest/upperChest/leftShoulder/leftUpperArm/leftLowerArm/leftHand
```

The file's own licence is surfaced, not buried: `avatarPermission`,
`commercialUsage`, and author land in the event log and on screen.

### Building

Press **B**. Everything you do is a command, so everything you do replays — and
undo is not a stack of inverse operations, it is the time layer already in the
engine: each edit checkpoints the world first, and undo restores it.

| | |
| --- | --- |
| `1`–`7` | box, sphere, cylinder, cone, plane, torus, capsule |
| click | place · **right-click** select · **G** grab or drop |
| wheel / `[` `]` | reach · size |
| `C` `X` | duplicate · delete |
| `F` | animate the selection with a Flux graph |
| `Z` `Y` | undo · redo |

A primitive is stored as its descriptor, not its vertices, so a thousand
identical boxes are one mesh and a saved item is a few hundred bytes of text.
Grabbing is a *state*, not a stream: `build.grab` says what you hold and how
far away, and a system moves it every tick — two commands per grab instead of
sixty a second, which keeps the recording of a build session legible.

Consequences are named apart from the commands that caused them —
`build.spawn` is somebody asking, `slot.spawned` is it having happened — because
a replay has to tell a refused intent from a carried-out one.

### Flux — visual scripting

A dataflow graph. Value nodes are pulled and memoized once per tick; **impulse**
nodes are the roots, and they are the only ones allowed to touch the world —
through the same capability sandbox agent behavior runs in.

```js
const graph = new FluxGraph('bob');
const time = graph.add('Time');
const wave = graph.add('Sin', { value: { node: time, output: 'seconds' } });
graph.add('SetSlotPosition', { slot: index, y: { node: wave, output: 'value' } });

attachGraph(world, graph, { slots: [index] });   // may move exactly one slot
```

The graph declares what it needs (`graph.capabilities()`), which the runtime
then *narrows*: a script that wants to move any slot is admitted with permission
to move one. Cycles are caught before it runs, node evaluations are metered, a
graph that oversteps is denied and eventually switched off, and it never wins a
tug-of-war with a person holding the object.

### The same world, other senses

```bash
node bin/latticeborn.js walk      # Pandora, ray-marched into characters
```

The terminal renderer imports the identical height field and marches identical
rays into a character grid. It exists to make the engine's central claim
falsifiable: if the world is really independent of the renderer, a terminal is
just a very low-bandwidth display.

---

## The Grove

A second world on the same engine, for the parts Pandora does not exercise:
dense agent simulation, the semantic graph, interest-managed replication, and
counterfactual branching.

```bash
node bin/latticeborn.js demo      # 1000 entities, ASCII, three observers
node bin/latticeborn.js verify    # the proofs, run live
```

Beacons radiate heat into a continuous field. Motes fall through their gravity.
Foragers run **capability-sandboxed** behavior — and roughly six percent of them
run a law that reaches for authority it was never granted, so you can watch the
host deny it, that agent lose its turn, and the tick continue. Open
`/grove` in the browser for the live version with a schedule view, a projection
bandwidth meter, a checkpoint rail, and a side-by-side counterfactual branch.

### What `verify` proves

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

Not assertions about intent — each one runs the engine and compares state hashes.
`npm test` adds 66 more, including that a *play session* replays: the same
inputs from the same checkpoint reproduce the same walk, hash for hash. Input
reaches the avatar only as commands, so a traversal is a recording, not a video.

---

## The source map

| Layer | File | What it is |
| --- | --- | --- |
| Identity | [`core/ids.js`](src/core/ids.js) | Packed handles with generations; stable cross-universe keys |
| Substrate | [`core/ecs.js`](src/core/ecs.js) | Archetype tables, one typed array per component field |
| | [`core/terrain.js`](src/core/terrain.js) | The height field, in JavaScript and in GLSL, from one definition |
| | [`core/fields.js`](src/core/fields.js) | Continuous scalar fields: diffusion, decay, sampling, gradients |
| | [`core/graph.js`](src/core/graph.js) | Semantic graph with provenance and tombstoned history |
| | [`core/spatial.js`](src/core/spatial.js) | Uniform hash grid and the LOD ladder |
| Runtime | [`core/scheduler.js`](src/core/scheduler.js) | Hazard DAG derived from declared reads/writes; waves; rate limits |
| | [`core/laws.js`](src/core/laws.js) | Capability-secured behavior with metered budgets |
| | [`core/world.js`](src/core/world.js) | Commands, ticks, checkpoints, replay, forking, state hashing |
| Durability | [`core/events.js`](src/core/events.js) | Append-only log, causal parents, seal chain |
| | [`core/regions.js`](src/core/regions.js) | Procedural memory: latent → resident → remembered |
| | [`core/procedural.js`](src/core/procedural.js) | Chunks as pure functions of immutable causes |
| Projection | [`core/projection.js`](src/core/projection.js) | Interest horizons, deltas, P0–P4 priority, bandwidth budget |
| Views | [`demo/renderers/raymarch.js`](src/demo/renderers/raymarch.js) | Ray-traced pixels (WebGL2) |
| | [`demo/renderers/ascii3d.js`](src/demo/renderers/ascii3d.js) | Ray-traced characters (terminal) |
| | [`demo/renderers/canvas.js`](src/demo/renderers/canvas.js) | 2D pixels |
| | [`demo/renderers/semantic.js`](src/demo/renderers/semantic.js) | Affordances, relations, causal history — no pixels |
| Worlds | [`demo/pandora.js`](src/demo/pandora.js) | The default world |
| | [`demo/testbed.js`](src/demo/testbed.js) | The Grove |
| Input | [`demo/input.js`](src/demo/input.js) | Keyboard, mouse, gamepad → one intent → one command |

---

## Four design decisions worth reading the code for

**One terrain, two languages.** `terrain.js` defines an integer hash, value
noise, and domain-warped fBm in JavaScript, and exports the GLSL twin as a
string the shader includes verbatim. The CPU places the avatar's feet with it;
the GPU shades with it; a test asserts they declare the same functions.

**Canonical row order.** Archetype rows stay sorted by entity index at all times
— insert and delete are memmoves, not swap-removes. Row order decides the order
floating-point accumulations happen in, so making it canonical is what makes
replay bit-exact *and* makes observing a world (checkpointing, forking,
snapshotting) incapable of perturbing it.

**Denial is the default.** A law reaches the world only through paths its grant
names, and only paths with a registered provider exist at all. A capability
fault rolls the whole invocation back — a half-applied intent is worse than none.

**Projections are lossy on purpose.** When a client's tick budget runs out, low
priority is *dropped*, not queued. A renderer can always reconstruct cosmetic
detail; it can never invent authority state.

---

## Scope, honestly

Implemented: schema registry and component ABI, archetype ECS, hazard scheduler,
sealed event log, checkpoints, replay, rollback, universe branching, region
memory, continuous fields, semantic graph, spatial index and LOD, capability
sandbox, procedural genesis with mutation logs, interest-managed projection, a
ray-traced renderer, three other renderers, and full keyboard/mouse/gamepad
input.

Not implemented, and described in the [publication draft](web/index.html) as
future work: the C17 core ABI and Rust services, Jolt physics, the
NATS/JetStream fabric, PostgreSQL and Apache AGE persistence, real WebAssembly
law components under Wasmtime, region migration and distribution, and the O3DE,
Godot, and WebGPU clients. The reference core is JavaScript so one
implementation runs in a terminal and a browser without a toolchain. It is the
spine, not the skin.

## Credits

No third-party code is bundled — there are no dependencies at all — but the
renderer stands on well-known open technique:

- **Inigo Quilez** ([iquilezles.org](https://iquilezles.org), MIT): height field
  marching with binary refinement, analytic soft shadows, domain-warped fBm, and
  the SDF primitives the avatar is built from.
- **John C. Hart**, *Sphere Tracing* (1996): the distance-field marching the
  floating islands and the avatar use.
- **Stephen Hill** (MIT): the ACES filmic tone-mapping curve fit.
- **Christophe Schlick** (1994): the Fresnel approximation on the water.
- **W3C Gamepad API** Standard Mapping: the controller layout.

Pandora, the Na'vi, and the Hallelujah Mountains are creations of James Cameron
and 20th Century Studios. This is an unaffiliated technical demonstration that
takes visual inspiration from them; it ships no assets from those films, and
every pixel here is generated from noise functions in this repository.

---

Apache-2.0. See [LICENSE](LICENSE).
