// Look direction.
//
// A flipped look axis is invisible in review — every sign is individually
// plausible — and unmissable the instant somebody touches a mouse. It also
// cannot be checked inside the input module alone, because "right" is defined
// by the camera basis the renderer builds, not by the input handler's opinion.
// So these tests move a fake mouse, run the resulting yaw through the real
// `buildCamera`, and ask which way the camera actually ended up pointing.

import assert from 'node:assert/strict';
import test from 'node:test';

import { CameraRig, InputController, shortestAngle } from '../src/demo/input.js';
import { DEFAULT_APPEARANCE } from '../src/demo/pandora.js';
import { buildCamera } from '../src/demo/renderers/raymarch.js';

// The module registers window/document listeners at construction. Node has
// neither, so this is the smallest surface that lets it do that.
function withFakeDom(run) {
  const listeners = new Map();
  const element = { requestPointerLock: () => {} };
  const previous = {
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
    document: globalThis.document,
    navigator: globalThis.navigator,
  };
  globalThis.addEventListener = (type, fn) => listeners.set(type, fn);
  globalThis.removeEventListener = (type) => listeners.delete(type);
  globalThis.document = { addEventListener() {}, removeEventListener() {}, pointerLockElement: element };
  if (!globalThis.navigator) globalThis.navigator = {};

  try {
    const input = new InputController(element);
    input.pointerLocked = true;
    return run(input, (type, event) => listeners.get(type)?.(event), element);
  } finally {
    globalThis.addEventListener = previous.addEventListener;
    globalThis.removeEventListener = previous.removeEventListener;
    globalThis.document = previous.document;
    if (previous.navigator === undefined) delete globalThis.navigator;
  }
}

/** The camera the renderer would build for this yaw and pitch. */
function cameraAt(yaw, pitch) {
  const camera = buildCamera(
    { position: { x: 0, y: 40, z: 0 }, yaw, pitch, appearance: DEFAULT_APPEARANCE },
    { firstPerson: true },
  );
  const b = camera.basis;
  // Column-major: right, up, forward.
  return { right: [b[0], b[1], b[2]], up: [b[3], b[4], b[5]], forward: [b[6], b[7], b[8]] };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test('moving the mouse right turns the camera toward its own right', () => {
  const yaw = withFakeDom((input, fire) => {
    fire('mousemove', { movementX: 120, movementY: 0 });
    return input.sample(1 / 60).yawDelta;
  });

  assert.ok(yaw !== 0, 'a mouse move must produce a yaw delta');
  const before = cameraAt(0.4, 0);
  const after = cameraAt(0.4 + yaw, 0);
  // The new forward direction has to lean toward the old right vector. This is
  // the whole test: it is stated in terms of the rendered frame, so no amount
  // of agreeing sign errors between input and camera can satisfy it.
  assert.ok(
    dot(after.forward, before.right) > 0,
    `mouse right turned the camera left (yaw delta ${yaw})`,
  );
});

test('moving the mouse up tilts the camera toward its own up', () => {
  const pitch = withFakeDom((input, fire) => {
    // movementY is negative when the mouse moves up the screen.
    fire('mousemove', { movementX: 0, movementY: -120 });
    return input.sample(1 / 60).pitchDelta;
  });

  const before = cameraAt(0.4, 0);
  const after = cameraAt(0.4, pitch);
  assert.ok(dot(after.forward, before.up) > 0, `mouse up tilted the camera down (pitch delta ${pitch})`);
});

test('invert Y flips the vertical axis and only the vertical axis', () => {
  const [normal, inverted] = [false, true].map((invertY) =>
    withFakeDom((input, fire) => {
      input.invertY = invertY;
      fire('mousemove', { movementX: 90, movementY: -90 });
      const { yawDelta, pitchDelta } = input.sample(1 / 60);
      return { yawDelta, pitchDelta };
    }),
  );

  assert.equal(inverted.yawDelta, normal.yawDelta);
  assert.equal(inverted.pitchDelta, -normal.pitchDelta);
});

test('dragging looks around when the pointer is not locked, and only then', () => {
  const { locked, unlockedIdle, dragged } = withFakeDom((input, fire, element) => {
    // Locked: a drag flag must not double-count anything.
    fire('mousemove', { movementX: 60, movementY: 0 });
    const locked = input.sample(1 / 60).yawDelta;

    input.pointerLocked = false;
    fire('mousemove', { movementX: 60, movementY: 0 });
    const unlockedIdle = input.sample(1 / 60).yawDelta;

    fire('mousedown', { button: 0, target: element });
    fire('mousemove', { movementX: 60, movementY: 0 });
    const dragged = input.sample(1 / 60).yawDelta;

    fire('mouseup', {});
    assert.equal(input.dragging, false, 'releasing the button must end the drag');
    return { locked, unlockedIdle, dragged };
  });

  assert.ok(locked > 0, 'pointer lock is still the primary path');
  assert.equal(unlockedIdle, 0, 'an unlocked pointer must not steer without a button held');
  assert.equal(dragged, locked, 'a drag looks around exactly as fast as a locked pointer');
});

test('a drag started outside the canvas is somebody using the panel', () => {
  const idle = withFakeDom((input, fire) => {
    input.pointerLocked = false;
    fire('mousedown', { button: 0, target: { nodeName: 'INPUT' } });
    fire('mousemove', { movementX: 80, movementY: 0 });
    return input.sample(1 / 60).yawDelta;
  });
  assert.equal(idle, 0);
});

test('the camera rig takes the short way round the circle', () => {
  const rig = new CameraRig({ yaw: 3.0, pitch: 0 });
  // Target just past pi: the naive difference is nearly -2pi, the short one is small.
  rig.follow({ yaw: -3.0, pitch: 0 }, 1, 1e6);
  assert.ok(Math.abs(shortestAngle(3.0, -3.0)) < 0.6);
  assert.ok(rig.yaw < 3.0 + 0.6 && rig.yaw > 3.0 - 0.01 - 0.6);
});
