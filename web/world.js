// Pandora — the client.
//
// Three loops, kept honestly separate:
//
//   input   devices -> one intent -> an `avatar.intent` command
//   world   a fixed 60 Hz tick that is the only thing allowed to change truth
//   render  a ray-traced frame built from whatever the world currently says
//
// The render loop never writes to the world, and the world never knows a
// renderer exists. That separation is the whole argument the engine is making,
// so it is worth being able to point at it in the code.

import { BIOME_NAMES, DEFAULT_APPEARANCE, SPECIES, avatarState, createPandora } from '../src/demo/pandora.js';
import { CameraRig, InputController } from '../src/demo/input.js';
import { QUALITY, buildCamera, createRaymarchRenderer } from '../src/demo/renderers/raymarch.js';
import { RegionState } from '../src/core/regions.js';
import { biomeAt, heightAt } from '../src/core/terrain.js';

const ui = {
  canvas: document.getElementById('view'),
  atlas: document.getElementById('atlas'),
  gate: document.getElementById('gate'),
  gateWebgl: document.getElementById('gateWebgl'),
  panel: document.getElementById('panel'),
  banner: document.getElementById('banner'),
  crosshair: document.getElementById('crosshair'),
  hudWorld: document.getElementById('hudWorld'),
  hudPerf: document.getElementById('hudPerf'),
  hudMemory: document.getElementById('hudMemory'),
  hudUniverse: document.getElementById('hudUniverse'),
  hudSeed: document.getElementById('hudSeed'),
  hudDevice: document.getElementById('hudDevice'),
  sliders: document.getElementById('sliders'),
  panelMemory: document.getElementById('panelMemory'),
  panelRender: document.getElementById('panelRender'),
  panelWorld: document.getElementById('panelWorld'),
  memoryLog: document.getElementById('memoryLog'),
  btnQuality: document.getElementById('btnQuality'),
  selQuality: document.getElementById('selQuality'),
  chkAdaptive: document.getElementById('chkAdaptive'),
  chkGodRays: document.getElementById('chkGodRays'),
  chkBloom: document.getElementById('chkBloom'),
  chkClouds: document.getElementById('chkClouds'),
  chkReflection: document.getElementById('chkReflection'),
  chkIslands: document.getElementById('chkIslands'),
  chkInvert: document.getElementById('chkInvert'),
  rngSensitivity: document.getElementById('rngSensitivity'),
  checkpointNote: document.getElementById('checkpointNote'),
};

const LOOK_SPEED = 0.0023;
const APPEARANCE_FIELDS = [
  { key: 'height', label: 'height', min: 0.78, max: 1.32, step: 0.01, format: (v) => `${(v * 2.9).toFixed(2)} m` },
  { key: 'build', label: 'build', min: 0, max: 1, step: 0.01, format: (v) => (v < 0.4 ? 'slender' : v < 0.7 ? 'lithe' : 'strong') },
  { key: 'skinHue', label: 'skin', min: 0, max: 1, step: 0.005, format: (v) => `hue ${(v * 360).toFixed(0)}°` },
  { key: 'glowHue', label: 'markings', min: 0, max: 1, step: 0.005, format: (v) => `hue ${(v * 360).toFixed(0)}°` },
  { key: 'glowDensity', label: 'luminance', min: 0, max: 1, step: 0.01, format: (v) => `${(v * 100).toFixed(0)}%` },
  { key: 'marking', label: 'pattern', min: 0, max: 4, step: 1, format: (v) => ['bands', 'rings', 'lattice', 'spots', 'strands'][v] ?? 'bands' },
  { key: 'queue', label: 'queue', min: 0, max: 1, step: 0.01, format: (v) => `${(0.6 + v * 1.1).toFixed(2)} m` },
];

let world;
let renderer;
let input;
let rig;
let checkpoint = null;
let running = false;
let firstPerson = false;
let adaptive = true;
let sensitivity = 1;
let look = { yaw: 0, pitch: -0.12 };
let walkPhase = 0;
let accumulator = 0;
let lastFrame = performance.now();
let lastHud = 0;
const perf = { fps: 60, frameMs: 16, simMs: 0, ticks: 0 };
const memoryLog = [];

// ---------------------------------------------------------------------------

function boot(seed) {
  world = createPandora(seed === undefined ? {} : { seed });
  const state = avatarState(world);
  look = { yaw: state.yaw, pitch: state.pitch };
  rig = new CameraRig({ yaw: look.yaw, pitch: look.pitch });
  memoryLog.length = 0;
  checkpoint = null;

  const stored = loadAppearance();
  if (stored) world.submit({ op: 'avatar.customize', actor: 'player', payload: stored });

  world.subscribe((event) => {
    if (!/^region\.|^flora\.(bloom|harvest)|^memory\./.test(event.operation)) return;
    memoryLog.push(event);
    if (memoryLog.length > 40) memoryLog.shift();
  });

  ui.hudUniverse.textContent = world.universe;
  ui.hudSeed.textContent = `seed ${world.seed}`;
  buildSliders();
}

function ground(x, z) {
  return heightAt(x, z, world.seed);
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  perf.frameMs = perf.frameMs * 0.9 + dt * 1000 * 0.1;
  perf.fps = 1000 / Math.max(1, perf.frameMs);

  const intent = input.sample(dt);
  applyEdgeActions(intent);

  if (running) {
    look.yaw += intent.yawDelta * sensitivity;
    look.pitch = clamp(look.pitch + intent.pitchDelta * sensitivity, -1.25, 1.15);

    // Fixed timestep: the simulation advances in whole ticks or not at all.
    accumulator += dt;
    const step = 1 / world.tickHz;
    let ticks = 0;
    const simStart = performance.now();
    while (accumulator >= step && ticks < 6) {
      world.submit({
        op: 'avatar.intent',
        actor: 'player',
        payload: {
          forward: intent.forward,
          strafe: intent.strafe,
          jump: intent.jump,
          sprint: intent.sprint,
          yaw: look.yaw,
          pitch: look.pitch,
        },
      });
      world.step();
      accumulator -= step;
      ticks++;
    }
    perf.ticks += ticks;
    if (ticks) perf.simMs = perf.simMs * 0.85 + ((performance.now() - simStart) / ticks) * 0.15;
  }

  const state = avatarState(world);
  if (!state) return;
  walkPhase += state.speed * dt * 1.7;
  rig.firstPerson = firstPerson;
  rig.follow({ yaw: look.yaw, pitch: look.pitch }, dt);

  renderer.resize(innerWidth, innerHeight);
  const camera = buildCamera(
    { ...state, yaw: rig.yaw, pitch: rig.pitch },
    { firstPerson, distance: rig.distance, groundAt: ground },
  );
  const stats = renderer.render(world, camera, {
    avatar: { ...state, phase: walkPhase, yaw: look.yaw },
    firstPerson,
    exposure: state.swimming ? 1.15 : 1.5,
  });

  if (adaptive) tuneResolution();
  // Throttle the HUD by wall clock, not by tick count: the tick rate varies
  // with frame time and a modulo on it silently stops firing.
  if (now - lastHud > 110) {
    lastHud = now;
    updateHud(state, stats);
  }
  drawAtlas(state);
}

/** Keep the frame budget: resolution first, because it is the cheapest knob. */
function tuneResolution() {
  const current = renderer.stats.renderScale;
  const ceiling = QUALITY[renderer.quality].scale;
  if (perf.frameMs > 26) {
    // Shed resolution in proportion to how far over budget we are, so a very
    // slow device converges in a few frames instead of a few hundred.
    const overshoot = Math.min(0.35, (perf.frameMs - 26) / 400);
    if (current > 0.25) renderer.setRenderScale(current - 0.03 - overshoot);
  } else if (perf.frameMs < 15 && current < ceiling) {
    renderer.setRenderScale(Math.min(ceiling, current + 0.03));
  }
}

/**
 * Switch preset. Individual toggles are cleared so the preset actually takes
 * effect — an option panel that silently ignores the preset you just picked is
 * worse than no option panel.
 */
function setQuality(name) {
  if (!QUALITY[name]) return;
  for (const option of ['godRays', 'bloom', 'clouds', 'reflection', 'islands', 'scale']) {
    renderer.setOption(option, null);
  }
  renderer.setQuality(name);
  ui.selQuality.value = name;
  ui.btnQuality.textContent = `quality: ${name}`;
  syncOptionChecks();
  banner(`quality: ${name}${name === 'max' ? ' — supersampled, every secondary ray on' : ''}`);
}

function syncOptionChecks() {
  const settings = renderer.settings();
  ui.chkGodRays.checked = settings.godRays > 0;
  ui.chkBloom.checked = settings.bloom > 0;
  ui.chkClouds.checked = settings.clouds > 0;
  ui.chkReflection.checked = settings.reflection > 0;
  ui.chkIslands.checked = QUALITY[renderer.quality].islands > 0;
}

function applyEdgeActions(intent) {
  document.body.dataset.device = intent.device;
  ui.hudDevice.textContent = intent.device === 'gamepad' ? 'gamepad · standard mapping' : 'keyboard + mouse';

  if (intent.toggleView) {
    firstPerson = !firstPerson;
    banner(firstPerson ? 'first person' : 'third person');
  }
  if (intent.recenter) {
    look.pitch = -0.1;
    banner('camera recentred');
  }
  if (!running) return;

  const state = avatarState(world);
  if (!state) return;

  if (intent.interact) {
    const reach = 7;
    const target = {
      x: state.position.x + Math.sin(look.yaw) * reach * 0.5,
      z: state.position.z + Math.cos(look.yaw) * reach * 0.5,
    };
    world.submit({ op: 'world.harvest', actor: 'player', payload: { x: target.x, z: target.z, radius: reach } });
    banner('taken — this region will remember the gap');
  }
  if (intent.plant) {
    world.submit({
      op: 'world.beacon',
      actor: 'player',
      payload: { x: state.position.x, z: state.position.z, hue: state.appearance.glowHue },
    });
    banner('light planted — it does not fade');
  }
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

function updateHud(state, stats) {
  const memory = world.store('regions');
  const totals = memory.totals();

  kv(ui.hudWorld, [
    ['tick', world.tick.toLocaleString()],
    ['hash', world.hash()],
    ['position', `${state.position.x.toFixed(0)}, ${state.position.z.toFixed(0)}`],
    ['altitude', `${(state.position.y - state.ground).toFixed(1)} m over ${state.ground.toFixed(0)} m`],
    ['biome', BIOME_NAMES[state.biome]],
    ['gait', state.swimming ? 'swimming' : state.grounded ? (state.speed > 9 ? 'running' : state.speed > 0.4 ? 'walking' : 'still') : 'airborne'],
    ['stamina', { text: `${(state.stamina * 100).toFixed(0)}%`, cls: state.stamina < 0.25 ? 'warn' : '' }],
    ['travelled', `${state.distance.toFixed(0)} m`],
  ]);

  kv(ui.hudPerf, [
    ['fps', { text: perf.fps.toFixed(0), cls: perf.fps > 45 ? 'good' : perf.fps > 24 ? '' : 'warn' }],
    ['frame', `${perf.frameMs.toFixed(1)} ms`],
    ['sim', `${perf.simMs.toFixed(2)} ms/tick`],
    ['trace', `${stats.width}×${stats.height}`],
    ['lights', `${stats.lights} traced`],
    ['marks', `${stats.marks} remembered`],
    ['entities', world.ecs.entityCount.toLocaleString()],
  ]);

  kv(ui.hudMemory, [
    ['regions known', totals.known.toLocaleString()],
    ['resident', { text: totals.resident.toLocaleString(), cls: 'good' }],
    ['remembered', totals.remembered.toLocaleString()],
    ['history', `${totals.mutations.toLocaleString()} marks`],
    ['stored', `${(totals.bytesRemembered / 1024).toFixed(1)} KiB`],
    ['if materialized', `${(totals.bytesIfMaterialized / 1048576).toFixed(1)} MiB`],
  ]);

  if (!ui.panel.hidden) updatePanel(state, stats, totals);
}

function updatePanel(state, stats, totals) {
  const memory = world.store('regions');
  const here = memory.get(state.region.cx, state.region.cy);
  kv(ui.panelMemory, [
    ['region', `${state.region.cx}, ${state.region.cy}`],
    ['state', { text: state.regionState, cls: state.regionState === RegionState.RESIDENT ? 'good' : '' }],
    ['first witnessed', here ? `tick ${here.firstObserved.toLocaleString()}` : '—'],
    ['visits', here ? here.observations.toLocaleString() : '0'],
    ['footfalls', here ? here.summary.trail.toLocaleString() : '0'],
    ['first contacts', here ? here.summary.blooms.toLocaleString() : '0'],
    ['taken', here ? here.summary.harvests.toLocaleString() : '0'],
    ['forgotten regions', totals.forgotten.toLocaleString()],
  ]);

  const settings = renderer.settings();
  kv(ui.panelRender, [
    ['technique', 'ray march + secondary rays'],
    ['primary steps', String(settings.steps)],
    ['shadow steps', String(settings.shadowSteps)],
    ['ambient occlusion', settings.ao ? `${settings.ao} taps` : 'off'],
    ['reflection', settings.reflection ? 'water, one bounce' : 'off'],
    ['volumetric shafts', settings.godRays ? `${settings.godRays} samples` : 'off'],
    ['bloom', settings.bloom ? `${settings.hdr ? 'HDR' : 'LDR'} 4-tap + gaussian` : 'off'],
    ['clouds', settings.clouds ? 'cloud deck' : 'off'],
    ['render scale', { text: `${(renderer.stats.renderScale * 100).toFixed(0)}%`, cls: renderer.stats.renderScale > 1 ? 'good' : '' }],
    ['resolution', `${stats.width}×${stats.height}`],
  ]);

  kv(ui.panelWorld, [
    ['universe', world.universe],
    ['seed', String(world.seed)],
    ['tick', world.tick.toLocaleString()],
    ['state hash', world.hash()],
    ['entities', world.ecs.entityCount.toLocaleString()],
    ['events', world.log.length.toLocaleString()],
    ['checkpoint', checkpoint ? `tick ${checkpoint.tick.toLocaleString()}` : 'none'],
  ]);

  ui.memoryLog.replaceChildren(
    ...memoryLog
      .slice(-14)
      .reverse()
      .map((event) => {
        const row = document.createElement('div');
        const detail =
          event.payload?.species ?? event.payload?.what ?? `${event.payload?.cx ?? ''},${event.payload?.cy ?? ''}`;
        row.innerHTML = `<span>t${event.tick}</span><div><b>${event.operation}</b> <span>${escapeHtml(String(detail))}</span></div>`;
        return row;
      }),
  );
}

/** The region atlas: what is loaded, what is only remembered, and where you walked. */
function drawAtlas(state) {
  const ctx = ui.atlas.getContext('2d');
  const memory = world.store('regions');
  const size = ui.atlas.width;
  const span = 9; // regions across
  const cell = size / span;
  const here = memory.coordOf(state.position.x, state.position.z);

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(6, 14, 24, 0.5)';
  ctx.fillRect(0, 0, size, size);

  for (let dz = -4; dz <= 4; dz++) {
    for (let dx = -4; dx <= 4; dx++) {
      const cx = here.cx + dx;
      const cy = here.cy + dz;
      const region = memory.get(cx, cy);
      const x = (dx + 4) * cell;
      const y = (dz + 4) * cell;
      if (!region) {
        ctx.fillStyle = 'rgba(120, 150, 180, 0.06)';
      } else if (region.state === RegionState.RESIDENT) {
        ctx.fillStyle = `rgba(88, 214, 201, ${0.22 + Math.min(0.5, region.mutations.length / 60)})`;
      } else {
        ctx.fillStyle = `rgba(167, 139, 250, ${0.16 + Math.min(0.45, region.mutations.length / 60)})`;
      }
      ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
    }
  }

  // Trail marks, in world space, projected into the atlas.
  const originX = (here.cx - 4) * memory.size;
  const originZ = (here.cy - 4) * memory.size;
  const scale = size / (span * memory.size);
  ctx.fillStyle = 'rgba(180, 240, 255, 0.85)';
  for (let dz = -4; dz <= 4; dz++) {
    for (let dx = -4; dx <= 4; dx++) {
      for (const mark of memory.resolve(here.cx + dx, here.cy + dz, world.tick, 'trail')) {
        ctx.globalAlpha = Math.min(1, mark.intensity);
        ctx.fillRect((mark.x - originX) * scale, (mark.z - originZ) * scale, 1.4, 1.4);
      }
    }
  }
  ctx.globalAlpha = 1;

  // The avatar, and where it is looking.
  const ax = (state.position.x - originX) * scale;
  const az = (state.position.z - originZ) * scale;
  ctx.strokeStyle = 'rgba(242, 177, 85, 0.9)';
  ctx.beginPath();
  ctx.moveTo(ax, az);
  ctx.lineTo(ax + Math.sin(look.yaw) * 12, az + Math.cos(look.yaw) * 12);
  ctx.stroke();
  ctx.fillStyle = '#f2b155';
  ctx.beginPath();
  ctx.arc(ax, az, 2.6, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Panel controls
// ---------------------------------------------------------------------------

function buildSliders() {
  const state = avatarState(world);
  ui.sliders.replaceChildren(
    ...APPEARANCE_FIELDS.map((field) => {
      const row = document.createElement('label');
      row.className = 'slider-row';
      const value = state.appearance[field.key];
      row.innerHTML = `<span>${field.label}</span>`;
      const range = document.createElement('input');
      range.type = 'range';
      range.min = field.min;
      range.max = field.max;
      range.step = field.step;
      range.value = value;
      const out = document.createElement('output');
      out.textContent = field.format(value);
      range.addEventListener('input', () => {
        const next = Number(range.value);
        out.textContent = field.format(next);
        customize({ [field.key]: next });
      });
      row.append(range, out);
      return row;
    }),
  );
}

function customize(patch) {
  world.submit({ op: 'avatar.customize', actor: 'player', payload: patch });
  const merged = { ...avatarState(world).appearance, ...patch };
  saveAppearance(merged);
}

function loadAppearance() {
  try {
    const raw = localStorage.getItem('latticeborn-avatar');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveAppearance(appearance) {
  try {
    localStorage.setItem('latticeborn-avatar', JSON.stringify(appearance));
  } catch {
    /* private mode; the avatar simply does not persist between visits */
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function banner(text) {
  ui.banner.textContent = text;
  ui.banner.classList.add('visible');
  clearTimeout(banner.timer);
  banner.timer = setTimeout(() => ui.banner.classList.remove('visible'), 2200);
}

function togglePanel(force) {
  const show = force ?? ui.panel.hidden;
  ui.panel.hidden = !show;
  if (show && document.pointerLockElement) document.exitPointerLock();
}

function enter() {
  ui.gate.classList.add('fading');
  setTimeout(() => {
    ui.gate.hidden = true;
  }, 460);
  running = true;
  lastFrame = performance.now();
  accumulator = 0;
  input.requestPointerLock();
  ui.crosshair.hidden = false;
}

function start() {
  try {
    renderer = createRaymarchRenderer(ui.canvas, { quality: 'medium' });
  } catch (error) {
    ui.gateWebgl.textContent = `WebGL2 unavailable: ${error.message}`;
    ui.gateWebgl.style.color = 'var(--danger)';
    return;
  }

  boot();

  input = new InputController(ui.canvas, {
    lookSpeed: LOOK_SPEED,
    onPointerLockChange: (locked) => {
      ui.crosshair.hidden = !locked;
      if (!locked && running) banner('paused look — click to re-enter');
    },
    onDeviceChange: (device, id) => {
      if (device === 'gamepad') banner(`controller connected${id ? `: ${id.split('(')[0].trim()}` : ''}`);
    },
  });

  document.getElementById('btnEnter').addEventListener('click', enter);
  document.getElementById('btnPanel').addEventListener('click', () => togglePanel());
  document.getElementById('btnClosePanel').addEventListener('click', () => togglePanel(false));
  ui.canvas.addEventListener('click', () => {
    if (running && !document.pointerLockElement && ui.panel.hidden) input.requestPointerLock();
  });

  addEventListener('keydown', (event) => {
    if (event.code === 'Tab') {
      event.preventDefault();
      togglePanel();
    }
  });

  ui.btnQuality.addEventListener('click', () => {
    const order = ['low', 'medium', 'high', 'ultra', 'max'];
    const next = order[(order.indexOf(renderer.quality) + 1) % order.length];
    setQuality(next);
  });
  ui.selQuality.addEventListener('change', () => setQuality(ui.selQuality.value));
  ui.chkAdaptive.addEventListener('change', () => {
    adaptive = ui.chkAdaptive.checked;
    if (!adaptive) renderer.setRenderScale(QUALITY[renderer.quality].scale);
  });
  ui.chkInvert.addEventListener('change', () => {
    input.invertY = ui.chkInvert.checked;
  });

  // Individual graphics options, layered over whatever preset is selected.
  const toggle = (element, option, on) =>
    element.addEventListener('change', () => renderer.setOption(option, element.checked ? on : 0));
  toggle(ui.chkGodRays, 'godRays', 20);
  toggle(ui.chkBloom, 'bloom', 1);
  toggle(ui.chkClouds, 'clouds', 1);
  toggle(ui.chkReflection, 'reflection', 1);
  toggle(ui.chkIslands, 'islands', 1);
  ui.rngSensitivity.addEventListener('input', () => {
    sensitivity = Number(ui.rngSensitivity.value);
  });

  document.getElementById('btnRandomLook').addEventListener('click', () => {
    const random = {
      height: 0.8 + Math.random() * 0.5,
      build: Math.random(),
      skinHue: 0.5 + Math.random() * 0.2,
      glowHue: Math.random(),
      glowDensity: 0.3 + Math.random() * 0.7,
      marking: Math.floor(Math.random() * 5),
      queue: Math.random(),
    };
    customize(random);
    world.step();
    buildSliders();
  });
  document.getElementById('btnResetLook').addEventListener('click', () => {
    customize({ ...DEFAULT_APPEARANCE });
    world.step();
    buildSliders();
  });

  document.getElementById('btnCheckpoint').addEventListener('click', () => {
    checkpoint = world.checkpoint();
    banner(`checkpoint at tick ${checkpoint.tick} — ${checkpoint.hash}`);
    ui.checkpointNote.textContent = `Captured ${world.ecs.entityCount} entities and ${world.store('regions').totals().mutations} remembered marks at hash ${checkpoint.hash}.`;
  });
  document.getElementById('btnRestore').addEventListener('click', () => {
    if (!checkpoint) return banner('no checkpoint yet');
    world.load(checkpoint);
    const state = avatarState(world);
    look = { yaw: state.yaw, pitch: state.pitch };
    banner(`restored tick ${checkpoint.tick} — hash ${world.hash()}`);
  });
  document.getElementById('btnNewSeed').addEventListener('click', () => {
    boot(Math.floor(Math.random() * 1e9));
    banner(`new world · seed ${world.seed}`);
  });

  syncOptionChecks();
  const settings = renderer.settings();
  ui.gateWebgl.textContent = `WebGL2 ready${settings.hdr ? ' · HDR bloom' : ''} — quality presets up to max.`;
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------

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

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// Exposed for the headless smoke test, which drives the same code path a
// player does rather than a special one.
window.latticeborn = {
  get world() {
    return world;
  },
  get renderer() {
    return renderer;
  },
  get perf() {
    return perf;
  },
  enter,
  banner,
  customize,
  biomeAt: (x, z) => BIOME_NAMES[biomeAt(x, z, world.seed)],
  species: SPECIES,
};

start();
