#!/usr/bin/env node
// Latticeborn — terminal client.
//
//   latticeborn walk      traverse Pandora, ray-marched into the terminal
//   latticeborn demo      run the Grove reference world and render it as text
//   latticeborn verify    prove determinism, replay, branching, and sandboxing
//   latticeborn bench     measure the substrate
//   latticeborn chunk     regenerate procedural terrain from causes alone
//   latticeborn inspect   render one entity semantically, with no pixels

import process from 'node:process';
import {
  Biome,
  GENERATOR_VERSION,
  ProjectionServer,
  World,
  applyMutationLog,
  biomeHistogram,
  createTestbed,
  generateChunk,
  renderAscii,
  renderLegend,
  renderSemantic,
  testbedOptions,
} from '../src/index.js';
import { COUNTERFACTUAL, SCRIPT, driveScript } from '../src/demo/scenario.js';
import { BIOME_NAMES, avatarState, createPandora } from '../src/demo/pandora.js';
import { buildCamera } from '../src/demo/renderers/raymarch.js';
import { renderAscii3d } from '../src/demo/renderers/ascii3d.js';
import { heightAt } from '../src/core/terrain.js';

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? 'walk';
const useColor = args.color !== false && process.stdout.isTTY !== false && !args['no-color'];

const C = {
  dim: (s) => paint(s, '2'),
  bold: (s) => paint(s, '1'),
  cyan: (s) => paint(s, '38;5;80'),
  amber: (s) => paint(s, '38;5;214'),
  green: (s) => paint(s, '38;5;84'),
  red: (s) => paint(s, '38;5;203'),
  violet: (s) => paint(s, '38;5;141'),
};

function paint(s, code) {
  return useColor ? `[${code}m${s}[0m` : String(s);
}

const BIOME_GLYPHS = { ocean: ['~', 25], shore: ['.', 179], grass: ['"', 71], forest: ['♠', 29], steppe: [';', 143], desert: ['·', 222], rock: ['^', 246], snow: ['*', 255] };

const commands = { walk, demo, verify, bench, chunk, inspect, help };
await (commands[command] ?? help)();

// ---------------------------------------------------------------------------

/**
 * Pandora, in a terminal.
 *
 * The same height field the GPU shader marches, marched here into characters.
 * Nothing about the world changes to accommodate the display — which is the
 * only way to find out whether that was ever true.
 */
async function walk() {
  const seed = args.seed ? Number(args.seed) : undefined;
  const world = createPandora(seed === undefined ? {} : { seed });
  const frames = Number(args.frames ?? 60);
  const perFrame = Number(args.step ?? 10);
  const animate = args.animate !== false && process.stdout.isTTY && !args.plain;
  const width = Number(args.width ?? 100);
  const height = Number(args.height ?? 28);

  header(`PANDORA — seed ${world.seed}, ray-marched into ${width}x${height} characters`);
  const started = Date.now();
  let bearing = Number(args.bearing ?? 0.7);
  let renderMs = 0;

  for (let frame = 0; frame < frames; frame++) {
    for (let i = 0; i < perFrame; i++) {
      const here = avatarState(world);
      // A walker with exactly one instinct: do not drown.
      if (here.ground < 1.5) bearing += 0.09;
      world.submit({
        op: 'avatar.intent',
        actor: 'walker',
        payload: { forward: 1, yaw: bearing, sprint: frame % 7 === 3 },
      });
      world.step();
    }

    const state = avatarState(world);
    const camera = buildCamera(state, { distance: 8, groundAt: (x, z) => heightAt(x, z, world.seed) });
    const renderStarted = Date.now();
    const canvas = renderAscii3d(world, camera, { width, height, color: useColor, steps: Number(args.steps ?? 72) });
    renderMs = Date.now() - renderStarted;

    const totals = world.store('regions').totals();
    const lines = [
      canvas,
      `  ${C.dim('tick')} ${String(world.tick).padStart(5)}  ${C.dim('at')} ${String(Math.round(state.position.x)).padStart(5)},${String(Math.round(state.position.z)).padStart(5)}  ` +
        `${C.dim('biome')} ${C.green(BIOME_NAMES[state.biome].padEnd(9))} ${C.dim('walked')} ${String(Math.round(state.distance)).padStart(4)}m  ${C.dim('hash')} ${C.violet(world.hash())}`,
      `  ${C.dim('regions')} ${C.cyan(String(totals.resident))} resident · ${C.violet(String(totals.remembered))} remembered · ` +
        `${totals.mutations} marks in ${(totals.bytesRemembered / 1024).toFixed(1)} KiB ` +
        `${C.dim(`(as state: ${(totals.bytesIfMaterialized / 1048576).toFixed(1)} MiB)`)}`,
      `  ${C.dim('entities')} ${String(world.ecs.entityCount).padStart(4)} live · ${C.dim('render')} ${renderMs}ms/frame`,
    ];

    if (animate) {
      process.stdout.write('\u001b[H\u001b[2J' + lines.join('\n'));
    } else if (frame === frames - 1 || frame % Math.ceil(frames / 3) === 0) {
      console.log(lines.join('\n'));
      console.log('');
    }
  }

  const elapsed = (Date.now() - started) / 1000;
  const state = avatarState(world);
  const memory = world.store('regions');
  const totals = memory.totals();
  const home = memory.coordOf(state.position.x, state.position.z);
  const region = memory.get(home.cx, home.cy);

  console.log('');
  header('WHAT THIS PLACE NOW REMEMBERS');
  row('region', `${home.cx}, ${home.cy} — ${memory.stateOf(home.cx, home.cy)}`);
  if (region) {
    row('first witnessed', `tick ${region.firstObserved}`);
    row('visits', String(region.observations));
    row('footfalls', String(region.summary.trail));
    row('first contacts', String(region.summary.blooms));
  }
  row('regions known', `${totals.known} (${totals.resident} resident, ${totals.remembered} remembered)`);
  row('history', `${totals.mutations} marks · ${(totals.bytesRemembered / 1024).toFixed(1)} KiB stored`);
  row('as state', `${(totals.bytesIfMaterialized / 1048576).toFixed(1)} MiB, had these regions been kept as data`);
  row('simulated', `${world.tick} ticks in ${elapsed.toFixed(1)}s wall clock`);
  row('state hash', C.violet(world.hash()));
  console.log('');
  console.log(C.dim('  Every ridge above was regenerated from one seed and a coordinate. Nothing was'));
  console.log(C.dim('  stored except what happened, and only where somebody was there to see it.'));
  console.log(C.dim('  Open web/world.html for the same world with secondary rays and a controller.'));
}

async function demo() {
  const frames = Number(args.frames ?? 90);
  const perFrame = Number(args.step ?? 12);
  const animate = args.animate !== false && process.stdout.isTTY && !args.plain;
  const world = createTestbed({ seed: Number(args.seed ?? 20260731), foragers: Number(args.foragers ?? 180) });
  const projection = new ProjectionServer(world);

  // Three observers of one world: a close-up player, a regional camera, and an
  // agent that never renders a pixel.
  const player = projection.connect('player', { x: 256, y: 256, radius: 90, budgetBytes: 3072 });
  projection.connect('overwatch', { x: 256, y: 256, radius: 260, budgetBytes: 8192 });
  projection.connect('archivist', { x: 120, y: 380, radius: 140, budgetBytes: 1536, interest: ['Position', 'Agent'] });

  const narrative = [];
  world.subscribe((event) => {
    if (event.class === 'narrative' || event.operation === 'beacon.kindle' || event.operation === 'universe.fork') {
      narrative.push(`t${event.tick} ${event.operation} ${event.payload?.text ?? ''}`.trim());
      if (narrative.length > 4) narrative.shift();
    }
  });

  header('THE GROVE — reference world, three observers, one truth');
  const started = Date.now();
  let snapshot = null;

  for (let frame = 0; frame < frames; frame++) {
    for (let i = 0; i < perFrame; i++) {
      driveScript(world, SCRIPT);
      world.step();
    }
    // The player drifts; interest management follows it.
    player.move(256 + Math.cos(world.tick / 240) * 150, 256 + Math.sin(world.tick / 190) * 150);
    snapshot = projection.snapshot('player');

    const view = { x: player.x, y: player.y, radius: args.wide ? 256 : 150 };
    const canvas = renderAscii(world, {
      width: Number(args.width ?? 78),
      height: Number(args.height ?? 26),
      color: useColor,
      view: args.wide ? { x: 256, y: 256, radius: 256 } : view,
    });

    const lines = [
      canvas,
      '',
      `  ${C.dim('tick')} ${String(world.tick).padStart(5)}  ${C.dim('entities')} ${String(world.ecs.entityCount).padStart(4)}  ` +
        `${C.dim('agents')} ${String(world.stats.population ?? 0).padStart(4)}  ${C.dim('events')} ${String(world.log.length).padStart(5)}  ` +
        `${C.dim('graph')} ${String(world.graph.size).padStart(4)}  ${C.dim('hash')} ${C.violet(world.hash())}`,
      `  ${C.dim('projection')} sent ${snapshot.stats.sent} of ${snapshot.stats.considered} considered · ` +
        `${snapshot.stats.bytes}B of ${snapshot.stats.budgetBytes}B budget · dropped ${snapshot.stats.dropped} · ` +
        `${C.green(`${(100 - (snapshot.stats.bytes / Math.max(1, snapshot.stats.naiveBytes)) * 100).toFixed(0)}% under full replication`)}`,
      `  ${C.dim('sandbox')} ${lawSummary(world)}`,
      narrative.length ? `  ${C.dim('heard')} ${narrative.join(' · ')}` : '',
      `  ${renderLegend(useColor)}`,
    ];

    if (animate) {
      process.stdout.write('[H[2J' + lines.join('\n'));
      await sleep(Number(args.fps ? 1000 / Number(args.fps) : 60));
    } else if (frame === frames - 1 || frame % Math.ceil(frames / 4) === 0) {
      console.log(lines.join('\n'));
      console.log('');
    }
  }

  const elapsed = (Date.now() - started) / 1000;
  console.log('');
  header('WHAT THE WORLD KNOWS ABOUT ITSELF');
  const described = world.describe();
  row('universe', `${described.universe} (${described.label})`);
  row('simulated', `${described.tick} ticks of ${world.tickHz} Hz = ${described.time}s world time in ${elapsed.toFixed(2)}s wall clock`);
  row('throughput', `${((described.tick * described.entities) / elapsed / 1000).toFixed(0)}k entity-ticks/s`);
  row('state hash', C.violet(described.hash));
  row('entities', `${described.entities} across ${described.archetypes} archetypes · ${(described.memoryBytes / 1024).toFixed(0)} KiB of component columns`);
  row('graph', `${described.graphEdges} live edges · ${[...world.graph.predicates().entries()].map(([p, n]) => `${p}×${n}`).join(', ')}`);
  row('history', `${described.events} events · ${Object.entries(described.eventKinds).slice(0, 5).map(([k, n]) => `${k}×${n}`).join(', ')}`);

  console.log('');
  header('THE SCHEDULE THE ENGINE DERIVED (nobody wrote this order down)');
  for (const wave of described.schedule.waves) {
    const names = wave.systems
      .map((s) => `${C.cyan(s.name)}${s.rateHz !== world.tickHz ? C.dim(`@${s.rateHz}Hz`) : ''}`)
      .join(C.dim(' ∥ '));
    console.log(`  wave ${wave.index}  ${names}`);
    for (const system of wave.systems) {
      const deps = system.dependsOn.map((d) => `${d.from}(${d.on.join(',')})`).join(', ');
      console.log(
        `          ${C.dim('reads')} ${system.reads.join(', ') || '—'}  ${C.dim('writes')} ${system.writes.join(', ') || '—'}` +
          `  ${C.dim('avg')} ${system.stats.avgMs.toFixed(3)}ms${deps ? `  ${C.dim('after')} ${deps}` : ''}`,
      );
    }
  }
  console.log(`  ${C.dim('critical path')} ${described.schedule.criticalPath} waves · ${C.dim('max concurrency')} ${described.schedule.maxConcurrency} systems`);

  console.log('');
  header('THE SAME WORLD, RENDERED WITHOUT PIXELS');
  const subject = pickAgent(world);
  if (subject) console.log(indent(renderSemantic(world, subject), '  '));

  console.log('');
  header('PROJECTION — WHAT EACH OBSERVER ACTUALLY RECEIVED');
  for (const id of ['player', 'overwatch', 'archivist']) {
    const snap = projection.snapshot(id);
    row(
      id,
      `tracking ${snap.stats.tracked} entities · ${snap.stats.sent} updates · ${snap.stats.bytes}B this tick ` +
        `(full replication would be ${snap.stats.naiveBytes}B) · dropped ${snap.stats.dropped} low-priority`,
    );
  }

  console.log('');
  console.log(C.dim(`  run "latticeborn verify" to see determinism, replay, and branching proven on this same world.`));
}

// ---------------------------------------------------------------------------

async function verify() {
  const seed = Number(args.seed ?? 20260731);
  const ticks = Number(args.ticks ?? 600);
  const results = [];
  header('LATTICEBORN — VERIFICATION');

  // 1. Determinism: same causes, same world, independently computed.
  const a = createTestbed({ seed });
  const b = createTestbed({ seed });
  for (let t = 0; t < ticks; t++) {
    driveScript(a, SCRIPT);
    a.step();
    driveScript(b, SCRIPT);
    b.step();
  }
  results.push(check('determinism', a.hash() === b.hash(), `two independent runs of ${ticks} ticks agree at ${C.violet(a.hash())}`));

  // 2. Replay: checkpoint plus recorded commands reconstructs the present.
  const live = createTestbed({ seed });
  const checkpointAt = Math.floor(ticks / 3);
  let checkpoint = null;
  for (let t = 0; t < ticks; t++) {
    driveScript(live, SCRIPT);
    live.step();
    if (live.tick === checkpointAt) checkpoint = live.checkpoint();
  }
  const commands = live.log.between(checkpointAt, ticks).filter((e) => e.class === 'command');
  const replayed = World.replay({
    checkpoint,
    commands,
    toTick: ticks,
    options: testbedOptions({ seed }),
  });
  results.push(
    check(
      'replay',
      replayed.hash() === live.hash(),
      `checkpoint at t${checkpointAt} + ${commands.length} recorded commands reproduced t${ticks} exactly (${C.violet(live.hash())})`,
    ),
  );

  // 3. Rollback: restore an old checkpoint, resimulate, arrive at the same place.
  const rolled = createTestbed({ seed });
  rolled.load(checkpoint);
  for (let t = checkpointAt; t < ticks; t++) {
    driveScript(rolled, SCRIPT);
    rolled.step();
  }
  results.push(check('rollback', rolled.hash() === live.hash(), `state rewound to t${checkpointAt} and resimulated forward converges`));

  // 4. Branching: a fork diverges without disturbing its parent.
  const parentHashBefore = live.hash();
  const branch = live.fork('u1', { label: 'counterfactual' });
  for (const entry of COUNTERFACTUAL) branch.submit({ op: entry.op, actor: 'operator', payload: entry.payload });
  const control = createTestbed({ seed });
  control.load(checkpoint);
  for (let t = checkpointAt; t < ticks; t++) {
    driveScript(control, SCRIPT);
    control.step();
  }
  for (let t = 0; t < 200; t++) {
    branch.step(); // diverges: it received the counterfactual commands
    driveScript(control, SCRIPT);
    control.step();
    driveScript(live, SCRIPT);
    live.step();
  }
  results.push(
    check(
      'branching',
      branch.hash() !== live.hash() && live.hash() === control.hash(),
      `u1 forked at t${branch.lineage.forkTick} diverged to ${C.violet(branch.hash())} while u0 continued to ${C.violet(live.hash())}, ` +
        `matching an unforked control run`,
    ),
  );

  // 5. The event log's seal chain is intact.
  const sealed = a.log.verify();
  results.push(check('event integrity', sealed.ok, `${a.log.length} events verify against their seal chain`));

  // 6. Capability enforcement is real, and containment holds.
  const laws = a.laws.describe();
  const rogue = laws.find((l) => l.name === 'forage.rogue');
  const honest = laws.find((l) => l.name === 'forage');
  results.push(
    check(
      'capability sandbox',
      rogue.stats.violations > 0 && honest.stats.violations === 0 && a.ecs.entityCount > 0,
      `${rogue.stats.violations} denied reads from ${rogue.stats.invocations} rogue invocations, ` +
        `${honest.stats.invocations} lawful invocations unaffected, simulation never interrupted`,
    ),
  );
  if (a.laws.violations.length) {
    console.log(`         ${C.dim('last fault:')} ${a.laws.violations[a.laws.violations.length - 1].error}`);
  }

  // 7. Procedural genesis: causes reconstruct consequences.
  const c1 = generateChunk(seed, GENERATOR_VERSION, 3, -2);
  const c2 = generateChunk(seed, GENERATOR_VERSION, 3, -2);
  const c3 = generateChunk(seed, GENERATOR_VERSION + 1, 3, -2);
  const mutated = applyMutationLog(c1, [{ tick: 10, index: 40, op: 'raise', amount: 0.3 }]);
  results.push(
    check(
      'procedural genesis',
      c1.digest === c2.digest && c1.digest !== c3.digest && mutated.digest !== c1.digest,
      `chunk (3,-2) regenerates to ${c1.digest} from causes alone; a generator bump and a mutation log both change it`,
    ),
  );

  // 8. Schema migration guard.
  let guarded = false;
  try {
    const alien = createTestbed({ seed });
    alien.registry.define('Ghost', { presence: 'f64' });
    alien.load(checkpoint);
  } catch {
    guarded = true;
  }
  results.push(check('schema guard', guarded, 'a checkpoint cannot be loaded into a world with a different schema digest'));

  console.log('');
  const failed = results.filter((r) => !r).length;
  console.log(failed ? C.red(`  ${failed} check(s) failed`) : C.green('  all checks passed'));
  if (args.json) console.log(JSON.stringify({ passed: results.length - failed, failed }, null, 2));
  process.exitCode = failed ? 1 : 0;
}

// ---------------------------------------------------------------------------

async function bench() {
  header('SUBSTRATE BENCHMARK');
  for (const motes of [500, 2000, 8000, 32000]) {
    const world = createTestbed({ motes, foragers: Math.min(400, Math.round(motes / 12)) });
    world.run(20); // warm the archetypes and the field
    const ticks = 120;
    const started = process.hrtime.bigint();
    world.run(ticks);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const entities = world.ecs.entityCount;
    row(
      `${entities} entities`,
      `${(ms / ticks).toFixed(3)} ms/tick · ${((entities * ticks) / (ms / 1000) / 1e6).toFixed(2)}M entity-ticks/s · ` +
        `${(world.ecs.memoryFootprint() / 1024 / 1024).toFixed(2)} MiB columns · ${world.ecs.archetypeCount} archetypes`,
    );
  }
  console.log('');
  console.log(C.dim('  Single-threaded JavaScript over typed-array columns. The C17 core exists'));
  console.log(C.dim('  to make this same schedule wide: SIMD lanes, worker threads, GPU compute.'));
}

// ---------------------------------------------------------------------------

async function chunk() {
  const cx = Number(args.x ?? 0);
  const cy = Number(args.y ?? 0);
  const seed = Number(args.seed ?? 20260731);
  const version = Number(args.version ?? GENERATOR_VERSION);
  const generated = generateChunk(seed, version, cx, cy);
  header(`PROCEDURAL GENESIS — chunk (${cx}, ${cy}) from seed ${seed}, generator v${version}`);
  console.log(renderChunk(generated));
  console.log('');
  row('digest', generated.digest);
  row('biomes', [...biomeHistogram(generated).entries()].map(([b, n]) => `${b}×${n}`).join(' '));
  console.log('');
  console.log(C.dim('  Nothing above was stored. It was regenerated from four immutable causes:'));
  console.log(C.dim('  world seed, generator version, chunk coordinate, and context. Only divergence persists.'));
}

function renderChunk(chunk) {
  const lines = [];
  for (let y = 0; y < chunk.size; y++) {
    let line = '  ';
    for (let x = 0; x < chunk.size; x++) {
      const [glyph, color] = BIOME_GLYPHS[Biome[chunk.biome[y * chunk.size + x]]];
      line += useColor ? `[38;5;${color}m${glyph}[0m` : glyph;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

async function inspect() {
  const world = createTestbed({ seed: Number(args.seed ?? 20260731) });
  const ticks = Number(args.ticks ?? 400);
  for (let t = 0; t < ticks; t++) {
    driveScript(world, SCRIPT);
    world.step();
  }
  header(`WORLD INSPECTOR — ${world.universe} at t${world.tick}`);
  console.log(JSON.stringify(world.describe(), null, 2));
  const subject = pickAgent(world);
  if (subject) {
    console.log('');
    header('SEMANTIC PROJECTION');
    console.log(indent(renderSemantic(world, subject), '  '));
    console.log('');
    header('CAUSAL ANCESTRY');
    const key = world.key(subject);
    const birth = world.log.events.filter((e) => e.target === key).pop();
    if (birth) {
      for (const event of world.log.ancestry(birth.event_id, 6)) {
        console.log(`  ${C.dim(`t${event.tick}`)} ${event.operation} ${C.dim(event.event_id)} ${JSON.stringify(event.payload)}`);
      }
    }
  }
}

async function help() {
  console.log(`
${C.bold('latticeborn')} — an open reality engine

  ${C.cyan('walk')}     [--frames N] [--step N] [--width N] [--height N] [--seed N] [--plain]
           (default) Traverse Pandora — the ray-marched, procedurally
           remembered world — rendered into characters from the same height
           field the GPU shader compiles.

  ${C.cyan('demo')}     [--frames N] [--step N] [--width N] [--height N] [--wide] [--plain] [--fps N]
           Run the Grove reference world and render it in the terminal.

  ${C.cyan('verify')}   [--ticks N] [--seed N]
           Prove determinism, replay, rollback, branching, log integrity,
           capability enforcement, and procedural regeneration.

  ${C.cyan('bench')}    Measure entity-ticks per second across population sizes.

  ${C.cyan('chunk')}    [--x N] [--y N] [--version N]
           Regenerate one chunk of terrain from its causes.

  ${C.cyan('inspect')}  [--ticks N]
           Dump what the world knows about itself, then render one agent
           semantically — the same universe, with no pixels at all.

  Global: --no-color, --seed N
`);
}

// ---------------------------------------------------------------------------

function pickAgent(world) {
  let best = null;
  let bestEnergy = -Infinity;
  for (const chunk of world.ecs.query(['Agent', 'Position'])) {
    const energy = chunk.col('Agent', 'energy');
    for (let i = 0; i < chunk.count; i++) {
      if (energy[i] > bestEnergy) {
        bestEnergy = energy[i];
        best = chunk.entity(i);
      }
    }
  }
  return best;
}

function lawSummary(world) {
  return world.laws
    .describe()
    .map((law) =>
      law.stats.violations
        ? `${C.red(law.name)} ${law.stats.violations} denied of ${law.stats.invocations}`
        : `${C.green(law.name)} ${law.stats.invocations} ok`,
    )
    .join(' · ');
}

function header(text) {
  console.log(C.bold(C.amber(`\n  ${text}`)));
  console.log(C.dim(`  ${'─'.repeat(Math.min(78, text.length + 2))}`));
}

function row(label, value) {
  console.log(`  ${C.dim(label.padEnd(14))} ${value}`);
}

function check(name, ok, detail) {
  console.log(`  ${ok ? C.green('✓') : C.red('✗')} ${C.bold(name.padEnd(20))} ${detail}`);
  return ok;
}

function indent(text, prefix) {
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key.startsWith('no-')) {
      out[key.slice(3)] = false;
      out[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}
