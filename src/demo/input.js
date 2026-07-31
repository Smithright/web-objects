// Input.
//
// Nothing here touches the world directly. Every device — keyboard, mouse,
// gamepad, touch — is reduced to the same small intent, which is submitted as
// an `avatar.intent` command and recorded in the event log like any other. That
// is what makes a play session a replayable artifact rather than a video: the
// engine can reconstruct exactly what you did from a checkpoint and the
// commands that followed it.
//
// Bindings follow the conventions people already have in their hands: WASD and
// the arrows, space to jump, shift to sprint, E to interact, mouse look under
// pointer lock, and the W3C Standard Gamepad mapping for everything else.

export const DEFAULT_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  interact: ['KeyE'],
  plant: ['KeyQ'],
  view: ['KeyV'],
  recenter: ['KeyC'],
};

/** Standard Gamepad mapping — the layout every modern controller reports. */
export const GAMEPAD = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  L3: 10,
  R3: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
};

const AXIS = { LX: 0, LY: 1, RX: 2, RY: 3 };

/** Radial deadzone with a rescaled remainder — no snapping, no dead corners. */
function deadzone(x, y, threshold = 0.18) {
  const magnitude = Math.hypot(x, y);
  if (magnitude < threshold) return { x: 0, y: 0, magnitude: 0 };
  const scaled = (magnitude - threshold) / (1 - threshold);
  const clamped = Math.min(1, scaled);
  return { x: (x / magnitude) * clamped, y: (y / magnitude) * clamped, magnitude: clamped };
}

/** Expo curve: fine control near centre, full authority at the edge. */
function response(value, exponent = 2.2) {
  return Math.sign(value) * Math.pow(Math.abs(value), exponent);
}

export class InputController {
  constructor(element, options = {}) {
    this.element = element;
    this.bindings = { ...DEFAULT_BINDINGS, ...(options.bindings ?? {}) };
    this.lookSpeed = options.lookSpeed ?? 0.0023; // radians per pixel
    this.padLookSpeed = options.padLookSpeed ?? 2.9; // radians per second
    this.invertY = options.invertY ?? false;

    this.keys = new Set();
    this.pointerLocked = false;
    this.dragging = false;
    this.gamepadIndex = null;
    this.device = 'keyboard';
    this.lastPad = { buttons: [], axes: [] };

    this.state = {
      forward: 0,
      strafe: 0,
      yawDelta: 0,
      pitchDelta: 0,
      jump: false,
      sprint: false,
      interact: false,
      plant: false,
      toggleView: false,
      recenter: false,
    };

    this._onKeyDown = (event) => {
      if (event.repeat) return;
      this.keys.add(event.code);
      this.device = 'keyboard';
      if (this._bound('view', event.code)) this.state.toggleView = true;
      if (this._bound('interact', event.code)) this.state.interact = true;
      if (this._bound('plant', event.code)) this.state.plant = true;
      if (this._bound('recenter', event.code)) this.state.recenter = true;
      if (this._bound('jump', event.code) || event.code.startsWith('Arrow')) event.preventDefault();
    };
    this._onKeyUp = (event) => this.keys.delete(event.code);
    this._onBlur = () => this.keys.clear();

    this._onMouseMove = (event) => {
      // Drag to look when the pointer is not locked. Pointer lock is the good
      // path, but a sandboxed iframe can refuse it, and a world you cannot
      // turn around in is not a world.
      if (!this.pointerLocked && !this.dragging) return;
      this.device = 'mouse';
      this.state.yawDelta -= event.movementX * this.lookSpeed;
      this.state.pitchDelta -= event.movementY * this.lookSpeed * (this.invertY ? -1 : 1);
    };
    this._onMouseDown = (event) => {
      if (event.button === 0 && !this.pointerLocked && event.target === this.element) this.dragging = true;
    };
    this._onMouseUp = () => {
      this.dragging = false;
    };
    this._onPointerLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.element;
      if (this.pointerLocked) this.dragging = false;
      options.onPointerLockChange?.(this.pointerLocked);
    };
    this._onGamepadConnected = (event) => {
      this.gamepadIndex = event.gamepad.index;
      this.device = 'gamepad';
      options.onDeviceChange?.('gamepad', event.gamepad.id);
    };
    this._onGamepadDisconnected = (event) => {
      if (this.gamepadIndex === event.gamepad.index) this.gamepadIndex = null;
      options.onDeviceChange?.('keyboard', null);
    };

    addEventListener('keydown', this._onKeyDown);
    addEventListener('keyup', this._onKeyUp);
    addEventListener('blur', this._onBlur);
    addEventListener('mousemove', this._onMouseMove);
    addEventListener('mousedown', this._onMouseDown);
    addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    addEventListener('gamepadconnected', this._onGamepadConnected);
    addEventListener('gamepaddisconnected', this._onGamepadDisconnected);
    this._options = options;
  }

  _bound(action, code) {
    return this.bindings[action]?.includes(code) ?? false;
  }

  _held(action) {
    return this.bindings[action]?.some((code) => this.keys.has(code)) ?? false;
  }

  requestPointerLock() {
    // A sandboxed frame refuses this, and refuses it as a rejected promise in
    // newer browsers and a thrown error in older ones. Neither is a failure
    // worth reporting: drag-to-look covers the case.
    try {
      const pending = this.element.requestPointerLock?.();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
      /* no pointer lock here */
    }
  }

  /** Poll the gamepad. Browsers only expose a snapshot, so this must be per frame. */
  _pollGamepad(dt) {
    const pads = navigator.getGamepads?.() ?? [];
    let pad = this.gamepadIndex !== null ? pads[this.gamepadIndex] : null;
    if (!pad) pad = [...pads].find((candidate) => candidate && candidate.connected) ?? null;
    if (!pad) return false;
    this.gamepadIndex = pad.index;

    const move = deadzone(pad.axes[AXIS.LX] ?? 0, pad.axes[AXIS.LY] ?? 0);
    const look = deadzone(pad.axes[AXIS.RX] ?? 0, pad.axes[AXIS.RY] ?? 0, 0.12);
    const active = move.magnitude > 0 || look.magnitude > 0 || pad.buttons.some((b) => b.pressed);
    if (active) this.device = 'gamepad';

    if (move.magnitude > 0) {
      this.state.forward += -move.y;
      this.state.strafe += move.x;
    }
    if (look.magnitude > 0) {
      this.state.yawDelta -= response(look.x) * this.padLookSpeed * dt;
      this.state.pitchDelta -= response(look.y) * this.padLookSpeed * dt * (this.invertY ? -1 : 1);
    }

    const pressed = (index) => pad.buttons[index]?.pressed ?? false;
    const rising = (index) => pressed(index) && !this.lastPad.buttons[index];

    if (pressed(GAMEPAD.A)) this.state.jump = true;
    // Sprint on either the left stick click or the right trigger, because both
    // conventions are in the wild and neither is worth arguing about.
    if (pressed(GAMEPAD.L3) || (pad.buttons[GAMEPAD.RT]?.value ?? 0) > 0.45) this.state.sprint = true;
    if (rising(GAMEPAD.X)) this.state.interact = true;
    if (rising(GAMEPAD.Y)) this.state.plant = true;
    if (rising(GAMEPAD.RB) || rising(GAMEPAD.BACK)) this.state.toggleView = true;
    if (rising(GAMEPAD.R3)) this.state.recenter = true;

    this.lastPad = {
      buttons: pad.buttons.map((b) => b.pressed),
      axes: [...pad.axes],
    };
    return true;
  }

  /**
   * Collapse this frame's devices into one intent.
   *
   * Edge-triggered actions (interact, plant, view) are consumed here so a
   * single press produces a single command no matter the frame rate.
   */
  sample(dt) {
    this.state.forward = 0;
    this.state.strafe = 0;
    if (this._held('forward')) this.state.forward += 1;
    if (this._held('back')) this.state.forward -= 1;
    if (this._held('right')) this.state.strafe += 1;
    if (this._held('left')) this.state.strafe -= 1;
    this.state.jump = this._held('jump');
    this.state.sprint = this._held('sprint');

    this._pollGamepad(dt);

    const intent = {
      forward: Math.max(-1, Math.min(1, this.state.forward)),
      strafe: Math.max(-1, Math.min(1, this.state.strafe)),
      yawDelta: this.state.yawDelta,
      pitchDelta: this.state.pitchDelta,
      jump: this.state.jump,
      sprint: this.state.sprint,
      interact: this.state.interact,
      plant: this.state.plant,
      toggleView: this.state.toggleView,
      recenter: this.state.recenter,
      device: this.device,
      pointerLocked: this.pointerLocked,
    };

    this.state.yawDelta = 0;
    this.state.pitchDelta = 0;
    this.state.interact = false;
    this.state.plant = false;
    this.state.toggleView = false;
    this.state.recenter = false;
    return intent;
  }

  dispose() {
    removeEventListener('keydown', this._onKeyDown);
    removeEventListener('keyup', this._onKeyUp);
    removeEventListener('blur', this._onBlur);
    removeEventListener('mousemove', this._onMouseMove);
    removeEventListener('mousedown', this._onMouseDown);
    removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    removeEventListener('gamepadconnected', this._onGamepadConnected);
    removeEventListener('gamepaddisconnected', this._onGamepadDisconnected);
  }
}

/**
 * Camera smoothing.
 *
 * The avatar turns instantly because the simulation is authoritative about
 * where it faces; the camera lags slightly behind because a camera welded to a
 * body reads as a body welded to a camera. Critically damped, frame-rate
 * independent.
 */
export class CameraRig {
  constructor({ yaw = 0, pitch = -0.1, distance = 6.4 } = {}) {
    this.yaw = yaw;
    this.pitch = pitch;
    this.distance = distance;
    this.targetDistance = distance;
    this.firstPerson = false;
  }

  follow(target, dt, responsiveness = 14) {
    const k = 1 - Math.exp(-responsiveness * dt);
    this.yaw += shortestAngle(this.yaw, target.yaw) * k;
    this.pitch += (target.pitch - this.pitch) * k;
    this.distance += (this.targetDistance - this.distance) * Math.min(1, 6 * dt);
    return this;
  }
}

export function shortestAngle(from, to) {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}
