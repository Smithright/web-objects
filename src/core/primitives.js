// Primitive geometry.
//
// The shapes you start a build with. They produce the same mesh record the
// glTF importer produces — positions, normals, uvs, indices, bounds — so the
// renderer, the raycaster, and the inspector cannot tell an imported chair from
// a spawned box, and nothing needs a second code path.
//
// Everything here is a pure function of its parameters, which means a spawned
// primitive is described by four numbers rather than stored as a mesh: the same
// "store causes, regenerate consequences" argument the terrain makes, applied
// to props.

export const PRIMITIVES = ['box', 'sphere', 'cylinder', 'cone', 'plane', 'torus', 'capsule'];

/** Build a mesh record for a primitive. `params` are per-kind, all optional. */
export function makePrimitive(kind, params = {}) {
  switch (kind) {
    case 'box':
      return box(params);
    case 'sphere':
      return sphere(params);
    case 'cylinder':
      return cylinder(params);
    case 'cone':
      return cylinder({ ...params, topRadius: 0 });
    case 'plane':
      return plane(params);
    case 'torus':
      return torus(params);
    case 'capsule':
      return capsule(params);
    default:
      throw new Error(`unknown primitive "${kind}" (have: ${PRIMITIVES.join(', ')})`);
  }
}

class MeshBuilder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.uvs = [];
    this.indices = [];
  }

  vertex(position, normal, uv) {
    this.positions.push(position[0], position[1], position[2]);
    this.normals.push(normal[0], normal[1], normal[2]);
    this.uvs.push(uv[0], uv[1]);
    return this.positions.length / 3 - 1;
  }

  quad(a, b, c, d) {
    this.indices.push(a, b, c, a, c, d);
  }

  /** A grid of vertices, stitched into quads. */
  grid(rows, columns, fn, closed = false) {
    const map = [];
    for (let r = 0; r <= rows; r++) {
      const row = [];
      for (let c = 0; c <= columns; c++) row.push(this.vertex(...fn(r / rows, c / columns)));
      map.push(row);
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        this.quad(map[r][c], map[r + 1][c], map[r + 1][c + 1], map[r][c + 1]);
      }
    }
    return map;
  }

  finish(meta = {}) {
    const positions = Float32Array.from(this.positions);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c], positions[i + c]);
        max[c] = Math.max(max[c], positions[i + c]);
      }
    }
    return {
      positions,
      normals: Float32Array.from(this.normals),
      uvs: Float32Array.from(this.uvs),
      indices: Uint32Array.from(this.indices),
      joints: null,
      weights: null,
      colors: null,
      targets: [],
      vertexCount: positions.length / 3,
      bounds: { min, max },
      mode: 4,
      ...meta,
    };
  }
}

function box({ width = 1, height = 1, depth = 1 } = {}) {
  const b = new MeshBuilder();
  const [x, y, z] = [width / 2, height / 2, depth / 2];
  const faces = [
    { normal: [0, 0, 1], corners: [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]] },
    { normal: [0, 0, -1], corners: [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]] },
    { normal: [1, 0, 0], corners: [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]] },
    { normal: [-1, 0, 0], corners: [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]] },
    { normal: [0, 1, 0], corners: [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]] },
    { normal: [0, -1, 0], corners: [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]] },
  ];
  // Split vertices per face: a box with shared corners has no crisp edges.
  for (const face of faces) {
    const [a, c, d, e] = face.corners.map((corner, i) =>
      b.vertex(corner, face.normal, [[0, 0], [1, 0], [1, 1], [0, 1]][i]),
    );
    b.quad(a, c, d, e);
  }
  return b.finish({ primitive: { kind: 'box', width, height, depth } });
}

function sphere({ radius = 0.5, rings = 16, segments = 24 } = {}) {
  const b = new MeshBuilder();
  b.grid(rings, segments, (v, u) => {
    const phi = v * Math.PI;
    const theta = u * Math.PI * 2;
    const normal = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
    return [[normal[0] * radius, normal[1] * radius, normal[2] * radius], normal, [u, 1 - v]];
  });
  return b.finish({ primitive: { kind: 'sphere', radius, rings, segments } });
}

function cylinder({ radius = 0.5, topRadius = null, height = 1, segments = 24, caps = true } = {}) {
  const b = new MeshBuilder();
  const top = topRadius === null ? radius : topRadius;
  const slope = (radius - top) / height;

  b.grid(1, segments, (v, u) => {
    const theta = u * Math.PI * 2;
    const r = radius + (top - radius) * v;
    const dir = [Math.cos(theta), 0, Math.sin(theta)];
    const normal = normalize([dir[0], slope, dir[2]]);
    return [[dir[0] * r, -height / 2 + v * height, dir[2] * r], normal, [u, v]];
  });

  if (caps) {
    for (const [y, normal, sign] of [[height / 2, [0, 1, 0], 1], [-height / 2, [0, -1, 0], -1]]) {
      const r = y > 0 ? top : radius;
      if (r <= 1e-6) continue;
      const centre = b.vertex([0, y, 0], normal, [0.5, 0.5]);
      const ring = [];
      for (let s = 0; s <= segments; s++) {
        const theta = (s / segments) * Math.PI * 2;
        ring.push(
          b.vertex([Math.cos(theta) * r, y, Math.sin(theta) * r], normal, [
            0.5 + Math.cos(theta) * 0.5,
            0.5 + Math.sin(theta) * 0.5,
          ]),
        );
      }
      for (let s = 0; s < segments; s++) {
        if (sign > 0) b.indices.push(centre, ring[s], ring[s + 1]);
        else b.indices.push(centre, ring[s + 1], ring[s]);
      }
    }
  }
  return b.finish({ primitive: { kind: topRadius === 0 ? 'cone' : 'cylinder', radius, topRadius: top, height, segments } });
}

function plane({ width = 1, depth = 1, subdivisions = 1 } = {}) {
  const b = new MeshBuilder();
  b.grid(subdivisions, subdivisions, (v, u) => [
    [(u - 0.5) * width, 0, (v - 0.5) * depth],
    [0, 1, 0],
    [u, v],
  ]);
  return b.finish({ primitive: { kind: 'plane', width, depth, subdivisions } });
}

function torus({ radius = 0.5, tube = 0.18, rings = 24, segments = 16 } = {}) {
  const b = new MeshBuilder();
  b.grid(rings, segments, (v, u) => {
    const major = v * Math.PI * 2;
    const minor = u * Math.PI * 2;
    const centre = [Math.cos(major) * radius, 0, Math.sin(major) * radius];
    const normal = [
      Math.cos(major) * Math.cos(minor),
      Math.sin(minor),
      Math.sin(major) * Math.cos(minor),
    ];
    return [
      [centre[0] + normal[0] * tube, centre[1] + normal[1] * tube, centre[2] + normal[2] * tube],
      normal,
      [v, u],
    ];
  });
  return b.finish({ primitive: { kind: 'torus', radius, tube, rings, segments } });
}

function capsule({ radius = 0.3, height = 1, rings = 12, segments = 20 } = {}) {
  const b = new MeshBuilder();
  const cylinderHeight = Math.max(0, height - radius * 2);
  // One continuous grid from pole to pole, with the shaft inserted at the
  // equator — so the capsule has no seam where the caps meet the tube.
  b.grid(rings * 2 + 1, segments, (v, u) => {
    const theta = u * Math.PI * 2;
    const t = v * (rings * 2 + 1);
    let y;
    let normal;
    if (t <= rings) {
      const phi = (t / rings) * (Math.PI / 2);
      normal = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
      y = cylinderHeight / 2 + normal[1] * radius;
    } else if (t <= rings + 1) {
      normal = [Math.cos(theta), 0, Math.sin(theta)];
      y = cylinderHeight / 2 - (t - rings) * cylinderHeight;
    } else {
      const phi = ((t - rings - 1) / rings) * (Math.PI / 2);
      normal = [Math.cos(phi) * Math.cos(theta), -Math.sin(phi), Math.cos(phi) * Math.sin(theta)];
      y = -cylinderHeight / 2 + normal[1] * radius;
    }
    return [[normal[0] * radius, y, normal[2] * radius], normalize(normal), [u, v]];
  });
  return b.finish({ primitive: { kind: 'capsule', radius, height, rings, segments } });
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}
