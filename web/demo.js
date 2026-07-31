// The live world.
//
// Everything on this page is produced by the engine running in this tab. The
// canvas, the semantic block, and the projection meter are three renderers over
// one authoritative simulation; the checkpoint rail and the counterfactual
// branch are the durability and time layers, not UI tricks.

import { Priority, ProjectionServer, createTestbed, renderSemantic } from '../src/index.js';
import { createCanvasRenderer } from '../src/demo/renderers/canvas.js';
import { WORLD_SIZE } from '../src/demo/testbed.js';
import { COUNTERFACTUAL, SCRIPT, driveScript } from '../src/demo/scenario.js';

// --- chrome ----------------------------------------------------------------

const root = document.documentElement;
const storedTheme = localStorage.getItem('latticeborn-theme');
if (storedTheme) root.dataset.theme = storedTheme;
document.getElementById('themeToggle')?.addEventListener('click', () => {
  const next = root.dataset.theme === 'light' ? 'dark' : 'light';
  root.dataset.theme = next;
  localStorage.setItem('latticeborn-theme', next);
});

const toast = document.getElementById('toast');
let toastTimer = null;
function notify(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2000);
}

const ui = {
  canvas: document.getElementById('world'),
  branchCanvas: document.getElementById('branch'),
  branchBlock: document.getElementById('branchBlock'),
  branchName: document.getElementById('branchName'),
  branchFork: document.getElementById('branchFork'),
  branchStats: document.getElementById('branchStats'),
  statUniverse: document.getElementById('statUniverse'),
  statTick: document.getElementById('statTick'),
  statHash: document.getElementById('statHash'),
  worldStats: document.getElementById('worldStats'),
  schedule: document.getElementById('schedule'),
  projectionStats: document.getElementById('projectionStats'),
  bandwidthFill: document.getElementById('bandwidthFill'),
  priorityBars: document.getElementById('priorityBars'),
  lawStats: document.getElementById('lawStats'),
  lastFault: document.getElementById('lastFault'),
  semantic: document.getElementById('semantic'),
  log: document.getElementById('log'),
  rail: document.getElementById('rail'),
  railNote: document.getElementById('railNote'),
  speed: document.getElementById('speed'),
  speedOut: document.getElementById('speedOut'),
};

// --- world state -----------------------------------------------------------

const CHECKPOINT_EVERY = 150;
const MAX_CHECKPOINTS = 18;

const renderer = createCanvasRenderer(ui.canvas);
const branchRenderer = createCanvasRenderer(ui.branchCanvas);

let seed = Number(new URLSearchParams(location.search).get('seed')) || 20260731;
let world;
let projection;
let observer;
let branch = null;
let branchIndex = 0;
let checkpoints = [];
let restoredTo = null;
let events = [];
let lastSnapshot = null;
let subject = null;
let running = true;
let speed = Number(ui.speed.value);
let simMs = 0;

function boot(nextSeed) {
  seed = nextSeed;
  world = createTestbed({ seed, motes: 900, foragers: 200 });
  projection = new ProjectionServer(world);
  observer = projection.connect('observer', {
    x: WORLD_SIZE / 2,
    y: WORLD_SIZE / 2,
    radius: 110,
    budgetBytes: 4096,
  });
  world.subscribe((event) => {
    events.push(event);
    if (events.length > 60) events.splice(0, events.length - 60);
  });
  checkpoints = [{ tick: 0, checkpoint: world.checkpoint() }];
  restoredTo = null;
  events = [];
  subject = null;
  closeBranch();
  renderRail();
  update(true);
}

// --- the loop --------------------------------------------------------------

let frameCounter = 0;

function loop() {
  if (running) {
    const started = performance.now();
    for (let i = 0; i < speed; i++) {
      driveScript(world, SCRIPT);
      world.step();
      if (branch) branch.step();
    }
    simMs = simMs * 0.85 + ((performance.now() - started) / speed) * 0.15;

    if (world.tick % CHECKPOINT_EVERY === 0 && checkpoints.at(-1)?.tick !== world.tick) {
      checkpoints.push({ tick: world.tick, checkpoint: world.checkpoint() });
      if (checkpoints.length > MAX_CHECKPOINTS) checkpoints.shift();
      renderRail();
    }
  }

  lastSnapshot = projection.snapshot('observer');
  renderer.draw(world, { horizon: { x: observer.x, y: observer.y, radius: observer.radius } });
  if (branch) branchRenderer.draw(branch, {});

  if (frameCounter++ % 6 === 0) update();
  requestAnimationFrame(loop);
}

// --- panels ----------------------------------------------------------------

function update(force = false) {
  const described = world.describe();

  ui.statUniverse.textContent = `${described.universe} · ${described.label}`;
  ui.statTick.textContent = described.tick.toLocaleString();
  ui.statHash.textContent = described.hash;

  kv(ui.worldStats, [
    ['entities', described.entities.toLocaleString()],
    ['agents', (world.stats.population ?? 0).toLocaleString()],
    ['archetypes', `${described.archetypes} · ${(described.memoryBytes / 1024).toFixed(0)} KiB columns`],
    ['graph edges', described.graphEdges.toLocaleString()],
    ['events', described.events.toLocaleString()],
    ['world time', `${described.time.toFixed(1)}s @ ${world.tickHz} Hz`],
    ['sim cost', { text: `${simMs.toFixed(2)} ms/tick`, cls: simMs < 4 ? 'good' : 'warn' }],
    ['throughput', `${((described.entities / Math.max(simMs, 0.01)) / 1000).toFixed(1)}M entity-ticks/s`],
  ]);

  renderSchedule(described.schedule);
  renderProjection();
  renderLaws();
  renderSemanticPanel();
  renderLog(force);
  if (branch) renderBranchStats();
}

function renderSchedule(schedule) {
  const peak = Math.max(
    0.001,
    ...schedule.waves.flatMap((w) => w.systems.map((s) => s.stats.avgMs)),
  );
  ui.schedule.replaceChildren(
    ...schedule.waves.map((wave) => {
      const el = document.createElement('div');
      el.className = 'wave';
      const head = document.createElement('div');
      head.className = 'wave-head';
      head.textContent = `WAVE ${wave.index}${wave.systems.length > 1 ? ` · ${wave.systems.length} concurrent` : ''}`;
      el.append(head);
      for (const system of wave.systems) {
        const row = document.createElement('div');
        row.className = 'system';
        row.innerHTML =
          `<div class="system-name">${system.name}` +
          `${system.rateHz !== schedule.tickHz ? `<em>${system.rateHz}Hz</em>` : ''}</div>` +
          `<div class="system-cost">${system.stats.avgMs.toFixed(3)} ms</div>` +
          `<div class="system-io">reads ${system.reads.join(' ') || '—'} · writes ${system.writes.join(' ') || '—'}</div>` +
          `<div class="system-bar"><span style="width:${(system.stats.avgMs / peak) * 100}%"></span></div>`;
        el.append(row);
      }
      return el;
    }),
  );
}

function renderProjection() {
  if (!lastSnapshot) return;
  const stats = lastSnapshot.stats;
  const saving = 100 - (stats.bytes / Math.max(1, stats.naiveBytes)) * 100;
  ui.bandwidthFill.style.width = `${Math.min(100, (stats.bytes / Math.max(1, stats.budgetBytes)) * 100)}%`;

  kv(ui.projectionStats, [
    ['in horizon', stats.considered.toLocaleString()],
    ['replicated', `${stats.sent} updates`],
    ['this tick', `${stats.bytes} B / ${stats.budgetBytes} B`],
    ['full replication', `${stats.naiveBytes} B`],
    ['saved', { text: `${saving.toFixed(0)}%`, cls: 'good' }],
    ['dropped', { text: `${stats.dropped} low priority`, cls: stats.dropped ? 'warn' : '' }],
    ['tracked', stats.tracked.toLocaleString()],
  ]);

  const counts = [0, 0, 0, 0, 0];
  for (const update of [...lastSnapshot.entered, ...lastSnapshot.updates]) counts[update.priority]++;
  const max = Math.max(1, ...counts);
  ui.priorityBars.replaceChildren(
    ...counts.map((count, priority) => {
      const row = document.createElement('div');
      row.className = 'priority-row';
      const label = ['authority', 'nearby', 'secondary', 'distant', 'cosmetic'][priority];
      row.innerHTML = `<span>P${priority}</span><i style="width:${(count / max) * 100}%"></i><span>${count}</span>`;
      row.title = label;
      return row;
    }),
  );
}

function renderLaws() {
  const laws = world.laws.describe();
  ui.lawStats.replaceChildren(
    ...laws.map((law) => {
      const el = document.createElement('div');
      el.className = 'law';
      const denied = law.stats.violations + law.stats.budgetFaults;
      el.innerHTML =
        `<b>${law.name}<span style="color:var(--text-faint)"> v${law.version}</span></b>` +
        `<span class="${denied ? 'denied' : 'ok'}">${
          denied ? `${denied.toLocaleString()} denied` : `${law.stats.invocations.toLocaleString()} ok`
        }</span>`;
      el.title = `read: ${law.capabilities.read.join(', ')}\nwrite: ${law.capabilities.write.join(', ')}\nemit: ${law.capabilities.emit.join(', ')}\ndeny: ${law.capabilities.deny.join(', ')}\nbudget: ${JSON.stringify(law.capabilities.budget)}`;
      return el;
    }),
  );
  const fault = world.laws.violations.at(-1);
  ui.lastFault.textContent = fault ? `t${fault.tick} ${fault.law}: ${fault.error}` : '';
}

function renderSemanticPanel() {
  if (subject === null || !world.ecs.alive(subject)) {
    subject = null;
    for (const handle of world.spatial.queryRadius(observer.x, observer.y, observer.radius)) {
      if (world.ecs.has(handle, 'Agent')) {
        subject = handle;
        break;
      }
    }
  }
  ui.semantic.textContent = subject === null ? 'no agent inside the observer horizon' : renderSemantic(world, subject);
}

function renderLog() {
  const recent = events.slice(-16).reverse();
  ui.log.replaceChildren(
    ...recent.map((event) => {
      const line = document.createElement('div');
      line.className = `log-line ${event.class}`;
      const detail = event.payload?.text
        ? `"${event.payload.text}"`
        : event.target
          ? event.target
          : JSON.stringify(event.payload ?? {}).slice(0, 44);
      line.innerHTML = `<span>t${event.tick}</span><div><b>${event.operation}</b> <span>${escapeHtml(detail)}</span></div>`;
      return line;
    }),
  );
}

function renderRail() {
  ui.rail.replaceChildren(
    ...checkpoints.map((entry) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `t${entry.tick}`;
      button.className = restoredTo === entry.tick ? 'current' : '';
      button.title = `state hash ${entry.checkpoint.hash}`;
      button.addEventListener('click', () => rewind(entry));
      return button;
    }),
  );
}

function renderBranchStats() {
  const divergence = branch.hash() === world.hash();
  kv(ui.branchStats, [
    ['branch tick', branch.tick.toLocaleString()],
    ['branch hash', branch.hash()],
    ['parent hash', world.hash()],
    ['identical', { text: divergence ? 'yes' : 'no — diverged', cls: divergence ? '' : 'warn' }],
    ['branch agents', (branch.stats.population ?? 0).toLocaleString()],
    ['parent agents', (world.stats.population ?? 0).toLocaleString()],
    ['branch entities', branch.ecs.entityCount.toLocaleString()],
  ]);
}

// --- interaction -----------------------------------------------------------

function rewind(entry) {
  world.load(entry.checkpoint);
  restoredTo = entry.tick;
  checkpoints = checkpoints.filter((c) => c.tick <= entry.tick);
  events = [];
  subject = null;
  renderRail();
  update(true);
  notify(`Rewound to tick ${entry.tick} — state hash ${entry.checkpoint.hash}`);
  ui.railNote.textContent = 'resimulating forward from the restored checkpoint';
}

function worldPoint(event) {
  const rect = ui.canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * WORLD_SIZE,
    y: ((event.clientY - rect.top) / rect.height) * WORLD_SIZE,
  };
}

ui.canvas.addEventListener('mousemove', (event) => {
  const point = worldPoint(event);
  observer.move(point.x, point.y);
});

ui.canvas.addEventListener('click', (event) => {
  const point = worldPoint(event);
  if (event.altKey) {
    world.submit({ op: 'world.seed_forager', actor: 'operator', payload: { x: point.x, y: point.y, energy: 6 } });
    notify('Command submitted: world.seed_forager');
  } else if (event.shiftKey) {
    world.submit({ op: 'world.impulse', actor: 'operator', payload: { x: point.x, y: point.y, radius: 90, strength: 140 } });
    notify('Command submitted: world.impulse');
  } else {
    world.submit({ op: 'world.ignite', actor: 'operator', payload: { x: point.x, y: point.y, radius: 40, amount: 16 } });
    notify('Command submitted: world.ignite');
  }
});

document.getElementById('btnPlay').addEventListener('click', (event) => {
  running = !running;
  event.currentTarget.textContent = running ? 'Pause' : 'Play';
});

document.getElementById('btnStep').addEventListener('click', () => {
  driveScript(world, SCRIPT);
  world.step();
  if (branch) branch.step();
  update(true);
});

ui.speed.addEventListener('input', () => {
  speed = Number(ui.speed.value);
  ui.speedOut.textContent = `${speed}×`;
});

document.getElementById('btnCheckpoint').addEventListener('click', () => {
  checkpoints.push({ tick: world.tick, checkpoint: world.checkpoint() });
  if (checkpoints.length > MAX_CHECKPOINTS) checkpoints.shift();
  renderRail();
  notify(`Checkpoint at tick ${world.tick}`);
});

document.getElementById('btnFork').addEventListener('click', () => {
  branch = world.fork(`u${++branchIndex}`, { label: 'counterfactual' });
  for (const entry of COUNTERFACTUAL) branch.submit({ op: entry.op, actor: 'operator', payload: entry.payload });
  ui.branchBlock.hidden = false;
  ui.branchName.textContent = branch.universe;
  ui.branchFork.textContent = branch.lineage.forkTick;
  renderBranchStats();
  notify(`Forked ${branch.universe} at tick ${branch.lineage.forkTick} — the parent is untouched`);
});

document.getElementById('btnCloseBranch').addEventListener('click', closeBranch);

function closeBranch() {
  branch = null;
  ui.branchBlock.hidden = true;
}

document.getElementById('btnReset').addEventListener('click', () => {
  boot(Math.floor(Math.random() * 1e9));
  notify(`New world seeded with ${seed}`);
});

// --- helpers ---------------------------------------------------------------

function kv(target, entries) {
  target.replaceChildren(
    ...entries.flatMap(([label, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      if (value && typeof value === 'object') {
        dd.textContent = value.text;
        if (value.cls) dd.className = value.cls;
      } else {
        dd.textContent = value;
      }
      return [dt, dd];
    }),
  );
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

boot(seed);
ui.speedOut.textContent = `${speed}×`;
requestAnimationFrame(loop);
