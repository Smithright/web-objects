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
import { findBones, importAvatarBytes, poseWalk } from '../src/demo/avatar.js';
import { destroySlot, inspectSlot, slotPath } from '../src/core/scene.js';
import { handleIndex } from '../src/core/ids.js';
import { PRIMITIVES } from '../src/core/primitives.js';
import { FluxGraph, attachGraph, installFlux } from '../src/core/protoflux.js';
import { heldSlots, installBuild, raycastSlots } from '../src/demo/build.js';
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
  chkTaa: document.getElementById('chkTaa'),
  chkGodRays: document.getElementById('chkGodRays'),
  chkBloom: document.getElementById('chkBloom'),
  chkClouds: document.getElementById('chkClouds'),
  chkReflection: document.getElementById('chkReflection'),
  chkIslands: document.getElementById('chkIslands'),
  buildbar: document.getElementById('buildbar'),
  buildKind: document.getElementById('buildKind'),
  buildPalette: document.getElementById('buildPalette'),
  buildTarget: document.getElementById('buildTarget'),
  panelSelection: document.getElementById('panelSelection'),
  componentList: document.getElementById('componentList'),
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
let lastStats = null;
let sensitivity = 1;
let look = { yaw: 0, pitch: -0.12 };
let walkPhase = 0;
let accumulator = 0;
let lastFrame = performance.now();
let lastHud = 0;
let wearing = null; // the imported avatar currently being worn, if any
const build = { on: false, kind: 'box', palette: 0, target: null, selection: null, size: 1 };
const PALETTE_SWATCHES = ['#d1d6e6', '#4dc7b8', '#f5b859', '#ae8cfa', '#f07370', '#6b9ef2'];
const perf = { fps: 60, frameMs: 16, simMs: 0, ticks: 0 };
const memoryLog = [];

// ---------------------------------------------------------------------------

/** Import an avatar and wear it. Bytes in, slots out. */
function wearAvatar(buffer, name) {
  try {
    if (wearing) {
      // Replacing: the old body is slots like any other, so it just goes away.
      const { destroySlot } = wearing.module;
      destroySlot(world, wearing.root);
      wearing = null;
    }
    const instance = importAvatarBytes(world, buffer, {
      name,
      targetEyeHeight: 2.6 * avatarState(world).appearance.height,
    });
    world.step(); // compose transforms once so it is not at the origin for a frame
    wearing = {
      ...instance,
      bones: findBones(world, instance.root),
      module: { destroySlot },
      name,
    };
    const s = instance.summary;
    banner(`wearing ${s.name} — ${s.bones} bones, ${s.triangles.toLocaleString()} triangles, rig ${s.confidence}`);
    if (s.licence && s.licence.avatarPermission && s.licence.avatarPermission !== 'everyone') {
      setTimeout(() => banner(`licence: ${s.name} may be worn by ${s.licence.avatarPermission}`), 2600);
    }
    return instance;
  } catch (error) {
    banner(`import failed: ${error.message}`);
    console.error(error);
    return null;
  }
}

async function loadDefaultAvatar() {
  try {
    // The single-file bundle inlines the avatar, because it has to run from a
    // file:// URL and behind content policies that forbid fetching anything.
    const inlined = window.__latticebornAvatar;
    if (typeof inlined === 'string') {
      const binary = atob(inlined);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      wearAvatar(bytes.buffer, 'latticeborn-testbed');
      return;
    }
    const response = await fetch('/assets/avatars/latticeborn-testbed.vrm');
    if (!response.ok) return;
    wearAvatar(await response.arrayBuffer(), 'latticeborn-testbed');
  } catch {
    // No default avatar is not an error; the procedural body is the fallback.
  }
}

function boot(seed) {
  world = createPandora(seed === undefined ? {} : { seed });
  installBuild(world);
  installFlux(world);
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
  if (wearing) driveWornAvatar(state, dt);
  if (build.on) updateBuildTarget(state);

  const stats = renderer.render(world, camera, {
    avatar: { ...state, phase: walkPhase, yaw: look.yaw },
    firstPerson,
    // An imported body replaces the procedural one rather than wearing it.
    sdfAvatar: !wearing,
    exposure: state.swimming ? 1.15 : 1.5,
  });
  lastStats = stats;

  if (adaptive) tuneResolution(now);
  // Throttle the HUD by wall clock, not by tick count: the tick rate varies
  // with frame time and a modulo on it silently stops firing.
  if (now - lastHud > 110) {
    lastHud = now;
    updateHud(state, stats);
  }
  drawAtlas(state);
}

/**
 * Put the worn avatar where the body is.
 *
 * The simulation owns position, heading, and gait; the imported slots are
 * driven from that every frame. Nothing about the avatar is authoritative —
 * delete it and the world carries on with the procedural body.
 */
function driveWornAvatar(state, dt) {
  const feet = state.position.y - 2.6 * state.appearance.height;
  const half = look.yaw * 0.5;
  world.ecs.set(wearing.root, 'LocalTransform', {
    px: state.position.x,
    py: feet,
    pz: state.position.z,
    // Yaw only: an avatar that rolls with the camera looks possessed.
    rx: 0, ry: Math.sin(half), rz: 0, rw: Math.cos(half),
  });
  poseWalk(world, wearing.bones, {
    phase: walkPhase,
    speed: state.speed,
    grounded: state.grounded,
  });
}

// ---------------------------------------------------------------------------
// Build mode
// ---------------------------------------------------------------------------

/** What the crosshair is pointing at, from the same camera the shader uses. */
function updateBuildTarget(state) {
  const forward = {
    x: Math.sin(look.yaw) * Math.cos(look.pitch),
    y: Math.sin(look.pitch),
    z: Math.cos(look.yaw) * Math.cos(look.pitch),
  };
  const held = heldSlots(world);
  const hit = raycastSlots(world, state.position, forward, { maxDistance: 40, ignore: held });
  build.target = hit;
  if (hit) {
    const name = world.store('scene').name(handleIndex(hit.handle)) ?? 'slot';
    ui.buildTarget.textContent = `${name} · ${hit.distance.toFixed(1)} m`;
  } else {
    ui.buildTarget.textContent = held.length ? 'holding — G to drop' : 'nothing under the cursor';
  }
}

function spawnAhead(state) {
  const reach = 3.5;
  world.submit({
    op: 'build.spawn',
    actor: 'player',
    payload: {
      kind: build.kind,
      palette: build.palette,
      scale: build.size,
      position: [
        state.position.x + Math.sin(look.yaw) * Math.cos(look.pitch) * reach,
        state.position.y + Math.sin(look.pitch) * reach,
        state.position.z + Math.cos(look.yaw) * Math.cos(look.pitch) * reach,
      ],
    },
  });
  banner(`${build.kind} placed`);
}

function selectTarget() {
  build.selection = build.target?.handle ?? null;
  if (build.selection) banner(`selected ${world.store('scene').name(handleIndex(build.selection))}`);
}

/** Make the selection move on its own, sandboxed to that one slot. */
function animateSelection() {
  const handle = build.selection ?? build.target?.handle;
  if (!handle) return banner('nothing selected to animate');
  installFlux(world);
  const index = handleIndex(handle);
  const transform = world.ecs.get(handle, 'WorldTransform');

  const graph = new FluxGraph(`bob-${index}`);
  const time = graph.add('Time');
  const wave = graph.add('Sin', { value: { node: time, output: 'seconds' } });
  const height = graph.add('Multiply', { a: { node: wave, output: 'value' }, b: 0.6 });
  const y = graph.add('Add', { a: { node: height, output: 'value' }, b: transform.py });
  graph.add('SetSlotPosition', { slot: index, x: transform.px, y: { node: y, output: 'value' }, z: transform.pz });
  const spin = graph.add('Multiply', { a: { node: time, output: 'seconds' }, b: 0.9 });
  graph.add('SetSlotSpin', { slot: index, angle: { node: spin, output: 'value' } });

  // The graph is admitted with permission to move exactly this one slot.
  attachGraph(world, graph, { slots: [index] });
  banner(`flux graph attached — ${graph.nodes.length} nodes, scoped to one slot`);
}

function toggleBuild(force) {
  build.on = force ?? !build.on;
  ui.buildbar.hidden = !build.on;
  document.body.dataset.build = build.on ? 'on' : 'off';
  banner(build.on ? 'build mode' : 'build mode off');
  if (build.on) renderPalette();
}

function renderPalette() {
  ui.buildKind.innerHTML = `<b>${build.kind}</b> · size ${build.size.toFixed(2)}`;
  ui.buildPalette.replaceChildren(
    ...PALETTE_SWATCHES.map((colour, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.style.background = colour;
      button.className = index === build.palette ? 'active' : '';
      button.title = `palette ${index + 1}`;
      button.addEventListener('click', () => {
        build.palette = index;
        renderPalette();
      });
      return button;
    }),
  );
}

function handleBuildKey(event) {
  if (event.code === 'KeyB') {
    toggleBuild();
    return true;
  }
  if (!build.on) return false;

  const digit = /^Digit([1-7])$/.exec(event.code);
  if (digit) {
    build.kind = PRIMITIVES[Number(digit[1]) - 1] ?? 'box';
    renderPalette();
    return true;
  }

  switch (event.code) {
    case 'KeyG': {
      const held = heldSlots(world);
      if (held.length) world.submit({ op: 'build.release', actor: 'player', payload: {} });
      else if (build.target) {
        world.submit({
          op: 'build.grab',
          actor: 'player',
          payload: { slot: handleIndex(build.target.handle), distance: Math.max(1.5, build.target.distance) },
        });
      }
      return true;
    }
    case 'KeyX':
      if (build.target) {
        world.submit({ op: 'build.delete', actor: 'player', payload: { slot: handleIndex(build.target.handle) } });
        banner('deleted — Z to undo');
      }
      return true;
    case 'KeyC':
      if (build.target) {
        world.submit({ op: 'build.duplicate', actor: 'player', payload: { slot: handleIndex(build.target.handle) } });
      }
      return true;
    case 'KeyF':
      animateSelection();
      return true;
    case 'KeyZ':
      world.submit({ op: 'build.undo', actor: 'player', payload: {} });
      banner(`undo: ${world.store('undo').labels.undo ?? 'nothing'}`);
      renderer.resetHistory();
      return true;
    case 'KeyY':
      world.submit({ op: 'build.redo', actor: 'player', payload: {} });
      renderer.resetHistory();
      return true;
    case 'BracketLeft':
    case 'BracketRight': {
      const factor = event.code === 'BracketRight' ? 1.25 : 0.8;
      if (heldSlots(world).length) world.submit({ op: 'build.adjust', actor: 'player', payload: { scale: factor } });
      else {
        build.size = Math.min(20, Math.max(0.05, build.size * factor));
        renderPalette();
      }
      return true;
    }
    default:
      return false;
  }
}

/**
 * Keep the frame budget: resolution first, because it is the cheapest knob.
 *
 * This is a feedback controller, and the first version of it was written as if
 * it were a graphics function — evaluate the error, act on it, every frame.
 * That is an oscillator. Below the low threshold it added 0.03 per frame, and
 * every change resized the canvas: the browser's upscale to CSS pixels shifted
 * by a fraction of a pixel and the temporal history was thrown away, so the
 * image visibly crawled while the accumulator never got the sixteen frames it
 * needs. On a fast machine it did that forever.
 *
 * So: a wide deadband, quantised steps so no adjustment is too small to matter,
 * a decision every half second rather than every frame, and two consecutive
 * agreeing decisions before acting. A controller that does nothing is the
 * correct behaviour almost always, and doing nothing must be free.
 */
const RESOLUTION = {
  shedAbove: 20, // ms
  climbBelow: 9,
  step: 0.05, // quantised: a change is always a real change in pixels
  tick: 250, // ms between decisions
  shedAfter: 2, // decisions over budget before shedding — half a second
  climbAfter: 8, // decisions under budget before climbing — two seconds
};
let tuneAt = 0;
let tuneAgreement = 0;

/**
 * Decide in wall-clock time, not in frames.
 *
 * The obvious counter — "act every N frames" — is exactly backwards, because
 * when the renderer is in trouble, frames are the scarce thing. Thirty frames
 * at five fps is six seconds of the user sitting in the mess before anything
 * happens. Milliseconds do not slow down when the GPU does.
 *
 * And the response is asymmetric on purpose: shed after half a second over
 * budget, climb only after two seconds under it. Being over budget is felt
 * immediately; being under it is not felt at all, so there is nothing to win
 * by climbing fast and a settled image to lose. Two seconds is also more than
 * the sixteen frames the temporal accumulator needs to converge, at any frame
 * rate worth climbing from.
 */
function tuneResolution(now) {
  // A measured GPU time is the honest signal. Frame time also contains the
  // simulation, the compositor, and whatever else the machine is doing.
  const timing = renderer.timing;
  const budget = timing.measured && timing.gpuAvgMs > 0 ? timing.gpuAvgMs : perf.frameMs;
  perf.budgetMs = budget;

  if (now - tuneAt < RESOLUTION.tick) return;
  tuneAt = now;

  const current = renderer.stats.renderScale;
  const ceiling = QUALITY[renderer.quality].scale;
  let direction = 0;
  if (budget > RESOLUTION.shedAbove && current > 0.25) direction = -1;
  else if (budget < RESOLUTION.climbBelow && current < ceiling) direction = 1;

  // In the band, or already at a limit: forget the history and hold.
  if (direction === 0) {
    tuneAgreement = 0;
    return;
  }
  // A single slow frame is a hitch, not a trend.
  if (Math.sign(tuneAgreement) !== direction) tuneAgreement = 0;
  tuneAgreement += direction;
  const patience = direction < 0 ? RESOLUTION.shedAfter : RESOLUTION.climbAfter;
  if (Math.abs(tuneAgreement) < patience) return;
  tuneAgreement = 0;

  // Shed in proportion to the overshoot, so a machine that is badly over
  // budget converges in a second rather than in twenty steps of 0.05.
  const steps = direction < 0 ? Math.min(6, Math.ceil((budget - RESOLUTION.shedAbove) / 12) + 1) : 1;
  const target = current + direction * RESOLUTION.step * steps;
  const quantized = Math.min(ceiling, Math.max(0.25, Math.round(target / RESOLUTION.step) * RESOLUTION.step));
  if (Math.abs(quantized - current) < 1e-6) return;
  renderer.setRenderScale(quantized);
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
  ui.chkTaa.checked = settings.taa > 0;
}

function applyEdgeActions(intent) {
  document.body.dataset.device = intent.device;
  ui.hudDevice.textContent = intent.device === 'gamepad' ? 'gamepad · standard mapping' : 'keyboard + mouse';

  if (intent.toggleView) {
    firstPerson = !firstPerson;
    // Third to first person moves the eye several metres in one frame.
    renderer.resetHistory();
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

  const timing = renderer.timing;
  const rays = (stats.primaryRays ?? stats.width * stats.height) * Math.max(1, perf.fps);
  kv(ui.hudPerf, [
    ['fps', { text: perf.fps.toFixed(0), cls: perf.fps > 45 ? 'good' : perf.fps > 24 ? '' : 'warn' }],
    ['frame', `${perf.frameMs.toFixed(1)} ms`],
    [timing.measured ? 'gpu' : 'gpu (n/a)', timing.measured ? `${timing.gpuAvgMs.toFixed(2)} ms` : '—'],
    ['sim', `${perf.simMs.toFixed(2)} ms/tick`],
    ['trace', `${stats.width}×${stats.height} @${renderer.pixelRatio.toFixed(1)}x`],
    ['rays', `${(rays / 1e6).toFixed(1)}M/s`],
    ['lights', `${stats.lights} traced`],
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
    ['key light', settings.sun ? `${(settings.sun * 114.6).toFixed(1)}° disc, sampled` : 'point source'],
    ['bloom', settings.bloom ? `${settings.hdr ? 'HDR' : 'LDR'} 4-tap + gaussian` : 'off'],
    ['clouds', settings.clouds ? 'cloud deck' : 'off'],
    ['temporal accumulation', settings.taa ? (stats.accumulated ? 'reprojecting' : 'warming up') : 'off'],
    ['render scale', { text: `${(renderer.stats.renderScale * 100).toFixed(0)}%`, cls: renderer.stats.renderScale > 1 ? 'good' : '' }],
    ['device pixels', `${renderer.pixelRatio.toFixed(2)}× of ${(devicePixelRatio || 1).toFixed(2)}×${renderer.stats.capped ? ' (capped)' : ''}`],
    ['resolution', `${stats.width}×${stats.height}`],
    ['adapter', String(renderer.adapter ?? 'unknown').replace(/^ANGLE \(/, '').slice(0, 44)],
  ]);

  const selected = build.selection ?? build.target?.handle ?? null;
  if (selected && world.ecs.alive(selected)) {
    const info = inspectSlot(world, selected);
    kv(ui.panelSelection, [
      ['name', info.name],
      ['path', info.path.length > 40 ? `…${info.path.slice(-38)}` : info.path],
      ['depth', String(info.depth)],
      ['children', String(info.children)],
      ['position', info.world.position.map((v) => v.toFixed(1)).join(', ')],
      ['scale', info.local.scale[0].toFixed(2)],
      ['assets', info.assets.map((a) => `${a.kind} ${a.id}`).join(', ') || '—'],
    ]);
    ui.componentList.replaceChildren(
      ...info.components.map((component) => {
        const row = document.createElement('div');
        const values = Object.entries(component.values)
          .map(([key, value]) => `${key} ${typeof value === 'number' ? value.toFixed(2) : value}`)
          .join('  ');
        row.innerHTML = `<span>${escapeHtml(component.name)}</span><div>${escapeHtml(values.slice(0, 90))}</div>`;
        return row;
      }),
    );
  } else {
    kv(ui.panelSelection, [['selection', 'point at something in build mode']]);
    ui.componentList.replaceChildren();
  }

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
      return;
    }
    if (event.repeat) return;
    if (handleBuildKey(event)) event.preventDefault();
  });

  ui.canvas.addEventListener('mousedown', (event) => {
    if (!build.on || !running || !document.pointerLockElement) return;
    if (event.button === 0) spawnAhead(avatarState(world));
    if (event.button === 2) selectTarget();
  });
  ui.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  addEventListener('wheel', (event) => {
    if (!build.on || !heldSlots(world).length) return;
    world.submit({ op: 'build.adjust', actor: 'player', payload: { distance: event.deltaY > 0 ? -0.5 : 0.5 } });
  }, { passive: true });

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

  const pixelSlider = document.getElementById('rngPixelRatio');
  pixelSlider.value = String(renderer.pixelRatio);
  pixelSlider.addEventListener('input', () => renderer.setPixelRatio(Number(pixelSlider.value)));
  document.getElementById('btnBenchmark').addEventListener('click', () => benchmark());

  // Individual graphics options, layered over whatever preset is selected.
  const toggle = (element, option, on) =>
    element.addEventListener('change', () => renderer.setOption(option, element.checked ? on : 0));
  toggle(ui.chkGodRays, 'godRays', 20);
  toggle(ui.chkBloom, 'bloom', 1);
  toggle(ui.chkClouds, 'clouds', 1);
  toggle(ui.chkReflection, 'reflection', 1);
  toggle(ui.chkIslands, 'islands', 1);
  toggle(ui.chkTaa, 'taa', 1);
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
    // The camera teleported. Reprojection has no idea, so tell it.
    renderer.resetHistory();
    banner(`restored tick ${checkpoint.tick} — hash ${world.hash()}`);
  });
  document.getElementById('btnNewSeed').addEventListener('click', () => {
    boot(Math.floor(Math.random() * 1e9));
    renderer.resetHistory();
    banner(`new world · seed ${world.seed}`);
  });

  // Pick a starting preset from what the adapter says it is. Apple Silicon or
  // a discrete GPU has no business starting on `medium`, and a software
  // rasterizer has no business starting anywhere else but `low`.
  const adapter = String(renderer.adapter ?? '');
  const strong = /apple m\d|apple gpu|metal renderer|radeon (r[7-9]|rx)|geforce|nvidia|arc a\d/i.test(adapter);
  const software = /swiftshader|llvmpipe|software|basic render/i.test(adapter);
  if (software) {
    setQuality('low');
    renderer.setPixelRatio(1);
  } else if (strong) {
    setQuality('ultra');
    renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  }

  syncOptionChecks();
  const settings = renderer.settings();
  // Drag any .vrm/.glb onto the window to wear it.
  addEventListener('dragover', (event) => event.preventDefault());
  addEventListener('drop', async (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    banner(`reading ${file.name}…`);
    wearAvatar(await file.arrayBuffer(), file.name.replace(/\.[^.]+$/, ''));
  });

  // Static import, not dynamic: the module is already in the graph above, and
  // a dynamic import() is a fetch the single-file bundle cannot serve.
  loadDefaultAvatar();

  const shortName = adapter.replace(/^ANGLE \(|\)$/g, '').split(',')[1]?.trim() || adapter.slice(0, 46) || 'WebGL2';
  ui.gateWebgl.textContent =
    `${shortName}${settings.hdr ? ' · HDR' : ''}${renderer.timing.measured ? ' · GPU timing' : ''} — ` +
    `starting on ${renderer.quality} at ${renderer.pixelRatio.toFixed(1)}× device pixels. Drag a .vrm or .glb in to wear it.`;
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
/**
 * Sweep the presets and measure each one.
 *
 * Reports GPU time where the browser exposes a timer and frame time otherwise,
 * plus rays per second — the number that actually scales with the hardware.
 * Run it and the answer stops being a guess.
 */
async function benchmark(options = {}) {
  const presets = options.presets ?? ['low', 'medium', 'high', 'ultra', 'max'];
  const warmup = options.warmup ?? 30;
  const frames = options.frames ?? 90;
  const wasAdaptive = adaptive;
  const wasQuality = renderer.quality;
  adaptive = false;
  const results = [];
  banner('benchmarking…');

  for (const preset of presets) {
    setQuality(preset);
    renderer.setRenderScale(QUALITY[preset].scale);
    await waitFrames(warmup);

    const samples = [];
    const gpu = [];
    for (let i = 0; i < frames; i++) {
      const before = performance.now();
      await waitFrames(1);
      samples.push(performance.now() - before);
      if (renderer.timing.measured && renderer.timing.gpuMs > 0) gpu.push(renderer.timing.gpuMs);
    }
    samples.sort((a, b) => a - b);
    gpu.sort((a, b) => a - b);
    const stats = renderer.stats;
    const median = samples[Math.floor(samples.length / 2)];
    results.push({
      preset,
      resolution: `${stats.width}×${stats.height}`,
      pixels: stats.width * stats.height,
      medianFrameMs: +median.toFixed(2),
      p95FrameMs: +samples[Math.floor(samples.length * 0.95)].toFixed(2),
      medianGpuMs: gpu.length ? +gpu[Math.floor(gpu.length / 2)].toFixed(2) : null,
      fps: +(1000 / median).toFixed(1),
      raysPerSecond: Math.round((stats.width * stats.height * 1000) / median),
    });
  }

  adaptive = wasAdaptive;
  setQuality(wasQuality);

  const table = results
    .map(
      (r) =>
        `${r.preset.padEnd(7)} ${r.resolution.padEnd(12)} ${String(r.fps).padStart(6)} fps  ` +
        `${String(r.medianFrameMs).padStart(6)} ms frame  ` +
        `${(r.medianGpuMs === null ? '     —' : String(r.medianGpuMs).padStart(6))} ms gpu  ` +
        `${(r.raysPerSecond / 1e6).toFixed(1).padStart(6)} Mrays/s`,
    )
    .join('\n');
  const report = `adapter: ${renderer.adapter}\ndevice pixel ratio: ${renderer.pixelRatio}\n\n${table}`;
  console.log(report);
  banner('benchmark complete — see the console');
  return { adapter: renderer.adapter, pixelRatio: renderer.pixelRatio, results, report };
}

function waitFrames(count) {
  return new Promise((resolve) => {
    let remaining = count;
    const tick = () => (--remaining <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
}

window.latticeborn = {
  benchmark,
  build,
  toggleBuild,
  spawnAhead: () => spawnAhead(avatarState(world)),
  animateSelection,
  get wearing() {
    return wearing;
  },
  wearAvatar,
  inspect: (handle) => inspectSlot(world, handle),
  slotPath: (handle) => slotPath(world, handle),
  get world() {
    return world;
  },
  get renderer() {
    return renderer;
  },
  get perf() {
    return perf;
  },
  get lastStats() {
    return lastStats;
  },
  get input() {
    return input;
  },
  get look() {
    return { ...look };
  },
  enter,
  banner,
  customize,
  biomeAt: (x, z) => BIOME_NAMES[biomeAt(x, z, world.seed)],
  species: SPECIES,
};

start();
