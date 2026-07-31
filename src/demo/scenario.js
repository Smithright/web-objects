// A scripted sequence of external intents.
//
// Commands are the only way anything outside the simulation reaches it, and
// they are recorded as events — which is what makes the whole run replayable
// from a checkpoint and forkable at any tick. Both the terminal demo and the
// browser demo drive the same script, so both produce the same history.

import { WORLD_SIZE } from './testbed.js';

export const SCRIPT = [
  { tick: 120, op: 'world.ignite', payload: { x: 120, y: 380, radius: 40, amount: 14 } },
  { tick: 260, op: 'world.impulse', payload: { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2, radius: 140, strength: 110 } },
  { tick: 380, op: 'world.kindle_beacon', payload: { x: 400, y: 110, rate: 30, strength: 1.2 } },
  { tick: 520, op: 'world.ignite', payload: { x: 400, y: 110, radius: 48, amount: 18 } },
  { tick: 640, op: 'world.seed_forager', payload: { x: 400, y: 130, energy: 6 } },
  { tick: 760, op: 'world.cull', payload: { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2, radius: 70 } },
  { tick: 900, op: 'world.ignite', payload: { x: 120, y: 120, radius: 56, amount: 20 } },
];

/** Submit anything scheduled for the world's current tick. */
export function driveScript(world, script = SCRIPT) {
  for (const entry of script) {
    if (entry.tick !== world.tick) continue;
    world.submit({ op: entry.op, actor: 'operator', payload: entry.payload });
  }
}

/** The counterfactual: the same world, one different decision. */
export const COUNTERFACTUAL = [
  { tick: 0, op: 'world.cull', payload: { x: 256, y: 150, radius: 120 } },
  { tick: 4, op: 'world.ignite', payload: { x: 60, y: 60, radius: 90, amount: 40 } },
];
