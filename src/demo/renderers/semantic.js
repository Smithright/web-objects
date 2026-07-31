// A renderer that produces no pixels.
//
// An agent "renders" the same universe as entities, affordances, relationships,
// beliefs, hazards, causal history, and possible actions. It reads the identical
// projection a visual client would receive; only the resolution target differs.

import { lodFor } from '../../core/spatial.js';

export function renderSemantic(world, handle, options = {}) {
  const radius = options.radius ?? 48;
  if (!world.ecs.alive(handle)) return 'entity no longer exists in this universe';
  const key = world.key(handle);
  const position = world.ecs.get(handle, 'Position');
  const agent = world.ecs.get(handle, 'Agent');
  const health = world.ecs.get(handle, 'Health');
  const heat = world.field('heat');

  const neighbours = [];
  for (const other of world.spatial.queryRadius(position.x, position.y, radius)) {
    if (other === handle || !world.ecs.alive(other)) continue;
    const p = world.spatial.positions.get(other);
    const distance = Math.hypot(p.x - position.x, p.y - position.y);
    neighbours.push({
      key: world.key(other),
      kind: kindOf(world, other),
      distance,
      lod: lodFor(distance).label,
    });
  }
  neighbours.sort((a, b) => a.distance - b.distance);

  const gradient = heat.gradient(position.x, position.y);
  const local = heat.sample(position.x, position.y);
  const relations = world.graph.out(key).map((e) => `${e.p} ${e.o} (since t${e.since})`);
  const lineage = world.graph.in(key).filter((e) => e.p === 'BEGAT').map((e) => `descends from ${e.s}`);
  const history = world.log.events
    .filter((e) => e.actor === key || e.target === key)
    .slice(-6)
    .map((e) => `t${e.tick} ${e.operation}${e.payload?.text ? ` "${e.payload.text}"` : ''}`);

  const affordances = [];
  if (local > 0.5) affordances.push('feed(here) — local heat is above subsistence');
  if (gradient.x || gradient.y) affordances.push(`move(${bearing(gradient.x, gradient.y)}) — warmth increases that way`);
  if (neighbours.length > 4) affordances.push('disperse() — this cell is crowded');
  if (agent && agent.energy > 8.5) affordances.push('reproduce() — energy exceeds the threshold');
  if (health && health.hp < 40) affordances.push('shelter() — condition is deteriorating');

  return [
    `SUBJECT   ${key}  (universe ${world.universe}, tick ${world.tick})`,
    `BODY      position ${fmt(position.x)}, ${fmt(position.y)}` +
      (agent ? `   energy ${fmt(agent.energy)}   age ${agent.age}   generation ${agent.generation}` : ''),
    health ? `CONDITION hp ${fmt(health.hp)} — ${health.hp > 70 ? 'sound' : health.hp > 35 ? 'strained' : 'failing'}` : null,
    `WEATHER   heat ${fmt(local)}, gradient ${bearing(gradient.x, gradient.y)} (${fmt(Math.hypot(gradient.x, gradient.y), 4)}/unit)`,
    `PERCEIVES ${neighbours.length} entities within ${radius} units` +
      (neighbours.length ? `: ${neighbours.slice(0, 5).map((n) => `${n.kind}@${fmt(n.distance, 1)}`).join(', ')}` : ''),
    relations.length ? `RELATIONS ${relations.join('; ')}` : 'RELATIONS none',
    lineage.length ? `LINEAGE   ${lineage.join('; ')}` : null,
    `HISTORY   ${history.length ? history.join(' | ') : 'no recorded events'}`,
    `AFFORDS   ${affordances.length ? affordances.join('; ') : 'wait()'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function kindOf(world, handle) {
  if (world.ecs.has(handle, 'Attractor')) return 'beacon';
  if (world.ecs.has(handle, 'Agent')) return world.ecs.get(handle, 'Agent').disposition === 1 ? 'rogue' : 'forager';
  return 'mote';
}

function bearing(x, y) {
  if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) return 'still';
  const angle = (Math.atan2(y, x) * 180) / Math.PI;
  const points = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'];
  return points[Math.round(((angle + 360) % 360) / 45) % 8];
}

function fmt(value, digits = 2) {
  return Number(value).toFixed(digits);
}
