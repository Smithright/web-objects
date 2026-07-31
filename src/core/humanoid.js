// The humanoid rig.
//
// Every avatar ecosystem agrees on roughly the same skeleton and disagrees
// about every name in it. Unity/VRM call it `leftUpperArm`, Mixamo exports
// `mixamorig:LeftArm`, Blender rigify says `upper_arm.L`, VRoid ships
// `J_Bip_L_UpperArm`, and a hand-rigged avatar might say `Arm_L_01`. This module
// is the one place that knows all of that, so the rest of the engine only ever
// sees the canonical names.
//
// Two paths in:
//
//   1. The file declares its rig — VRM 1.0 (`VRMC_vrm`) or VRM 0.x (`VRM`)
//      carry an explicit bone -> node mapping. Believe it.
//   2. The file does not — fall back to scoring node names against the
//      conventions below, which is what actually happens with an FBX exported
//      out of Unity or Blender.
//
// The mapping is reported with a confidence and a list of what was inferred
// versus declared, because an importer that silently guesses wrong about
// `leftLowerArm` produces an avatar whose elbow bends backwards.

/** Canonical bones, in the Unity/VRM humanoid order. */
export const HUMANOID_BONES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftEye', 'rightEye', 'jaw',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  ...['left', 'right'].flatMap((side) =>
    ['Thumb', 'Index', 'Middle', 'Ring', 'Little'].flatMap((finger) =>
      ['Proximal', 'Intermediate', 'Distal'].map((segment) => `${side}${finger}${segment}`),
    ),
  ),
];

/** Without these a rig cannot be retargeted, posed, or given inverse kinematics. */
export const REQUIRED_BONES = [
  'hips', 'spine', 'head',
  'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
];

/**
 * VRChat's viseme set — the shape keys a lipsync system drives. VRM calls a
 * subset of these "expressions"; the aliases map both worlds onto one name.
 */
export const VISEMES = ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'ih', 'oh', 'ou'];

export const EXPRESSIONS = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised', 'blink', 'blinkLeft', 'blinkRight', 'lookUp', 'lookDown', 'lookLeft', 'lookRight'];

/** VRM 0.x expression presets, which used different words for the same faces. */
const VRM0_EXPRESSION_ALIASES = {
  joy: 'happy',
  angry: 'angry',
  sorrow: 'sad',
  fun: 'relaxed',
  neutral: 'neutral',
  blink: 'blink',
  blink_l: 'blinkLeft',
  blink_r: 'blinkRight',
  a: 'aa',
  i: 'ih',
  u: 'ou',
  e: 'E',
  o: 'oh',
  lookup: 'lookUp',
  lookdown: 'lookDown',
  lookleft: 'lookLeft',
  lookright: 'lookRight',
};

// --- name-based inference ---------------------------------------------------

/** Strip everything that varies between exporters: case, separators, prefixes. */
export function normalizeBoneName(name) {
  return String(name)
    .replace(/^mixamorig[:_]?/i, '')
    .replace(/^(J_Bip_|J_Sec_|J_Adj_|Bip0?1?_|Armature[|_]|Root[|_])/i, '')
    .replace(/[\s._:|-]/g, '')
    .toLowerCase();
}

/** Which side of the body a name refers to, or null. */
export function boneSide(name) {
  const raw = String(name);
  if (/(^|[^a-z])(l|left)([^a-z]|$)/i.test(raw.replace(/([a-z])([A-Z])/g, '$1 $2'))) return 'left';
  if (/(^|[^a-z])(r|right)([^a-z]|$)/i.test(raw.replace(/([a-z])([A-Z])/g, '$1 $2'))) return 'right';
  const normalized = normalizeBoneName(raw);
  if (/^l(?![aeiouy])/.test(normalized) || normalized.startsWith('left')) return 'left';
  if (/^r(?![aeiouy])/.test(normalized) || normalized.startsWith('right')) return 'right';
  if (/l$/.test(normalized) && !/all$|ball$|heel$/.test(normalized)) return 'left';
  if (/r$/.test(normalized) && !/finger$|upper$|lower$|shoulder$/.test(normalized)) return 'right';
  return null;
}

/**
 * Tokens that identify a bone, most specific first. Order matters: `upperleg`
 * must be tested before `leg`, or every thigh becomes a shin.
 */
const BONE_PATTERNS = [
  ['hips', ['hips', 'hip', 'pelvis', 'root', 'cog']],
  ['upperChest', ['upperchest', 'chestupper', 'spine3', 'chest2']],
  ['chest', ['chest', 'spine2', 'ribcage', 'torso']],
  ['spine', ['spine1', 'spine', 'abdomen', 'waist', 'lowerback']],
  ['neck', ['neck']],
  ['jaw', ['jaw', 'chin']],
  ['leftEye', ['eye']],
  ['head', ['head', 'skull']],
  ['leftToes', ['toebase', 'toes', 'toe', 'ball']],
  ['leftFoot', ['foot', 'ankle']],
  ['leftLowerLeg', ['lowerleg', 'leglower', 'calf', 'shin', 'knee', 'leg2']],
  ['leftUpperLeg', ['upperleg', 'legupper', 'thigh', 'upleg', 'leg1', 'leg']],
  ['leftShoulder', ['shoulder', 'clavicle', 'collar']],
  ['leftLowerArm', ['lowerarm', 'armlower', 'forearm', 'elbow', 'arm2']],
  ['leftUpperArm', ['upperarm', 'armupper', 'arm1', 'arm']],
  ['leftHand', ['hand', 'wrist']],
];

const FINGERS = [
  ['Thumb', ['thumb']],
  // "fore" alone would claim every ForeArm in every Mixamo rig ever exported.
  ['Index', ['index', 'pointer', 'forefinger']],
  ['Middle', ['middle']],
  ['Ring', ['ring']],
  ['Little', ['little', 'pinky', 'pinkie']],
];

const SEGMENTS = [
  ['Distal', ['distal', '3', 'tip', 'end']],
  ['Intermediate', ['intermediate', 'middle2', '2']],
  ['Proximal', ['proximal', '1', 'meta']],
];

const SIDED = new Set(
  HUMANOID_BONES.filter((bone) => bone.startsWith('left') || bone.startsWith('right')),
);

/** Best canonical bone for a node name, or null. */
export function classifyBoneName(name) {
  const normalized = normalizeBoneName(name);
  if (!normalized) return null;
  const side = boneSide(name);

  // Fingers first: "leftindexdistal" also contains "index" and nothing else.
  for (const [finger, fingerTokens] of FINGERS) {
    if (!fingerTokens.some((token) => normalized.includes(token))) continue;
    for (const [segment, segmentTokens] of SEGMENTS) {
      if (segmentTokens.some((token) => normalized.endsWith(token) || normalized.includes(segment.toLowerCase()))) {
        return side ? `${side}${finger}${segment}` : null;
      }
    }
    return side ? `${side}${finger}Proximal` : null;
  }

  for (const [bone, tokens] of BONE_PATTERNS) {
    if (!tokens.some((token) => normalized.includes(token))) continue;
    if (!SIDED.has(bone)) return bone;
    if (!side) return null;
    return bone.replace(/^left/, side === 'left' ? 'left' : 'right');
  }
  return null;
}

/**
 * Infer a humanoid mapping from node names alone.
 *
 * When two nodes claim the same bone the one closer to the root wins, because
 * exporters name twist bones and helpers after the joint they follow
 * (`LeftArmTwist`, `LeftArm_end`) and those hang below the real joint.
 */
export function inferHumanoid(nodes) {
  const depth = new Map();
  const depthOf = (node) => {
    if (depth.has(node.index)) return depth.get(node.index);
    const value = node.parent >= 0 && nodes[node.parent] ? depthOf(nodes[node.parent]) + 1 : 0;
    depth.set(node.index, value);
    return value;
  };

  const claims = new Map();
  for (const node of nodes) {
    const bone = classifyBoneName(node.name);
    if (!bone) continue;
    // "…_end" and "…Tip" leaves are helpers, never the joint itself.
    if (/(_end|tip|nub|twist|helper|ik|target|pole)$/i.test(normalizeBoneName(node.name))) continue;
    const current = claims.get(bone);
    if (!current || depthOf(node) < depthOf(nodes[current])) claims.set(bone, node.index);
  }

  // Eyes are the one pair where the name often carries no side at all.
  if (claims.has('leftEye') && !claims.has('rightEye')) {
    const eyes = nodes.filter((n) => normalizeBoneName(n.name).includes('eye'));
    if (eyes.length === 2) {
      const [a, b] = eyes;
      claims.set('leftEye', a.index);
      claims.set('rightEye', b.index);
    }
  }

  return Object.fromEntries(claims);
}

// --- VRM --------------------------------------------------------------------

/**
 * Read the rig, metadata, and expressions a VRM file declares.
 *
 * VRM 1.0 and 0.x describe the same things with different shapes, so both are
 * normalized here and callers never branch on version.
 */
export function readVrm(doc) {
  const vrm1 = doc.json.extensions?.VRMC_vrm;
  const vrm0 = doc.json.extensions?.VRM;
  if (!vrm1 && !vrm0) return null;

  if (vrm1) {
    const bones = vrm1.humanoid?.humanBones ?? {};
    const humanoid = {};
    for (const [bone, spec] of Object.entries(bones)) {
      if (spec && typeof spec.node === 'number') humanoid[bone] = spec.node;
    }
    const expressions = {};
    for (const [name, preset] of Object.entries(vrm1.expressions?.preset ?? {})) {
      expressions[name] = normalizeExpression(preset);
    }
    for (const [name, custom] of Object.entries(vrm1.expressions?.custom ?? {})) {
      expressions[name] = normalizeExpression(custom);
    }
    const meta = vrm1.meta ?? {};
    return {
      version: vrm1.specVersion ?? '1.0',
      humanoid,
      expressions,
      lookAt: vrm1.lookAt ?? null,
      firstPerson: vrm1.firstPerson ?? null,
      meta: {
        name: meta.name ?? doc.name,
        authors: meta.authors ?? [],
        version: meta.version ?? '',
        license: meta.licenseUrl ?? '',
        avatarPermission: meta.avatarPermission ?? 'onlyAuthor',
        commercialUsage: meta.commercialUsage ?? 'personalNonProfit',
        modification: meta.modification ?? 'prohibited',
        allowRedistribution: meta.allowRedistribution ?? false,
        thumbnail: meta.thumbnailImage,
      },
    };
  }

  const humanoid = {};
  for (const bone of vrm0.humanoid?.humanBones ?? []) {
    if (typeof bone.node === 'number' && bone.bone) humanoid[bone.bone] = bone.node;
  }
  const expressions = {};
  for (const group of vrm0.blendShapeMaster?.blendShapeGroups ?? []) {
    const key = VRM0_EXPRESSION_ALIASES[String(group.presetName ?? group.name).toLowerCase()] ?? group.name;
    expressions[key] = {
      morphTargetBinds: (group.binds ?? []).map((bind) => ({
        node: bind.mesh,
        index: bind.index,
        weight: (bind.weight ?? 100) / 100,
      })),
      isBinary: Boolean(group.isBinary),
    };
  }
  const meta = vrm0.meta ?? {};
  return {
    version: vrm0.exporterVersion ?? '0.x',
    humanoid,
    expressions,
    lookAt: vrm0.firstPerson ?? null,
    firstPerson: vrm0.firstPerson ?? null,
    meta: {
      name: meta.title ?? doc.name,
      authors: meta.author ? [meta.author] : [],
      version: meta.version ?? '',
      license: meta.otherLicenseUrl ?? meta.licenseName ?? '',
      avatarPermission: meta.allowedUserName ?? 'OnlyAuthor',
      commercialUsage: meta.commercialUssageName ?? meta.commercialUsageName ?? 'Disallow',
      modification: meta.licenseName ?? '',
      allowRedistribution: meta.violentUssageName !== undefined ? undefined : false,
      thumbnail: meta.texture,
    },
  };
}

function normalizeExpression(preset) {
  return {
    morphTargetBinds: (preset.morphTargetBinds ?? []).map((bind) => ({
      node: bind.node,
      index: bind.index,
      weight: bind.weight ?? 1,
    })),
    materialColorBinds: preset.materialColorBinds ?? [],
    isBinary: Boolean(preset.isBinary),
    overrideBlink: preset.overrideBlink,
    overrideMouth: preset.overrideMouth,
  };
}

// --- assembling the rig -----------------------------------------------------

/**
 * Build the canonical rig for a document: bones, how they were found, what is
 * missing, the avatar's measurements, and any licence the file carries.
 */
export function buildRig(doc) {
  const nodes = doc.nodes();
  const vrm = readVrm(doc);
  const declared = vrm ? { ...vrm.humanoid } : {};
  const inferred = inferHumanoid(nodes);

  const bones = {};
  const source = {};
  for (const bone of HUMANOID_BONES) {
    if (typeof declared[bone] === 'number' && nodes[declared[bone]]) {
      bones[bone] = declared[bone];
      source[bone] = 'declared';
    } else if (typeof inferred[bone] === 'number' && nodes[inferred[bone]]) {
      bones[bone] = inferred[bone];
      source[bone] = 'inferred';
    }
  }

  const missing = REQUIRED_BONES.filter((bone) => bones[bone] === undefined);
  const world = worldTransforms(nodes);
  const measurements = measure(bones, world, meshBounds(doc));

  return {
    bones,
    source,
    missing,
    nodes,
    world,
    vrm,
    measurements,
    expressions: vrm?.expressions ?? {},
    // Declared beats inferred; a rig with no required bones missing and no
    // guesses is the only one that can be trusted without a human looking.
    confidence: missing.length
      ? 'unusable'
      : Object.values(source).every((s) => s === 'declared')
        ? 'declared'
        : 'inferred',
    isHumanoid: missing.length === 0,
  };
}

/**
 * The axis-aligned bounds of every mesh in the file, from accessor min/max —
 * no vertex data is touched, because every conforming exporter writes them.
 */
export function meshBounds(doc) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let found = false;
  for (const mesh of doc.json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const accessor = doc.json.accessors?.[primitive.attributes?.POSITION];
      if (!accessor?.min || !accessor?.max) continue;
      found = true;
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], accessor.min[i]);
        max[i] = Math.max(max[i], accessor.max[i]);
      }
    }
  }
  return found ? { min, max } : null;
}

/** World-space translation of every node, from the local TRS chain. */
export function worldTransforms(nodes) {
  const out = new Array(nodes.length);
  const resolve = (index) => {
    if (out[index]) return out[index];
    const node = nodes[index];
    const local = composeTRS(node.translation, node.rotation, node.scale);
    out[index] = node.parent >= 0 ? multiply(resolve(node.parent), local) : local;
    return out[index];
  };
  for (let i = 0; i < nodes.length; i++) resolve(i);
  return out;
}

export function composeTRS(t, r, s) {
  const [x, y, z, w] = r;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

export function multiply(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export function translationOf(matrix) {
  return [matrix[12], matrix[13], matrix[14]];
}

/**
 * Measure the avatar so the world can scale it to the body it is driving.
 * Eye height is the number that matters: it is what the camera sits at, and
 * getting it wrong is what makes an avatar feel like a costume.
 */
export function measure(bones, world, bounds = null) {
  const at = (bone) => (bones[bone] !== undefined ? translationOf(world[bones[bone]]) : null);
  const hips = at('hips');
  const head = at('head');
  const eye = at('leftEye') ?? at('rightEye');
  const foot = at('leftFoot') ?? at('rightFoot');

  const groundY = bounds ? bounds.min[1] : foot ? foot[1] : 0;
  // Height from the mesh when we have it: the head *bone* is inside the skull,
  // and how far inside varies by several centimetres between avatars.
  const height = bounds ? bounds.max[1] - bounds.min[1] : head ? head[1] - groundY + 0.12 : null;

  // Arm span along the chain, not hand to hand: avatars are authored in A-pose
  // as often as T-pose, and the distance between the hands says which.
  const distance = (a, b) => {
    const p = at(a);
    const q = at(b);
    return p && q ? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) : 0;
  };
  const armLength =
    distance('leftUpperArm', 'leftLowerArm') + distance('leftLowerArm', 'leftHand');
  const shoulderWidth = distance('leftUpperArm', 'rightUpperArm');
  const legLength = distance('leftUpperLeg', 'leftLowerLeg') + distance('leftLowerLeg', 'leftFoot');

  return {
    height,
    eyeHeight: eye ? eye[1] - groundY : head ? head[1] - groundY + 0.09 : null,
    hipHeight: hips ? hips[1] - groundY : null,
    armLength,
    armSpan: armLength * 2 + shoulderWidth,
    shoulderWidth,
    legLength,
    footY: groundY,
    // Proportion, for retargeting onto a body of a different size.
    hipRatio: hips && height ? (hips[1] - groundY) / Math.max(1e-6, height) : null,
  };
}

/**
 * Map an avatar's morph targets onto the viseme set a lipsync system drives.
 * Declared VRM expressions win; otherwise match morph target names, which is
 * how a VRChat-authored FBX arrives.
 */
export function mapVisemes(rig, morphTargetNames = []) {
  const out = {};
  for (const viseme of VISEMES) {
    const declared = rig.expressions?.[viseme] ?? rig.expressions?.[viseme.toLowerCase()];
    if (declared) {
      out[viseme] = { source: 'declared', binds: declared.morphTargetBinds };
      continue;
    }
    const index = morphTargetNames.findIndex((name) => {
      const normalized = String(name).toLowerCase().replace(/[^a-z]/g, '');
      return normalized === `vrc${viseme.toLowerCase()}` || normalized === `viseme${viseme.toLowerCase()}` || normalized === viseme.toLowerCase();
    });
    if (index >= 0) out[viseme] = { source: 'inferred', binds: [{ index, weight: 1 }] };
  }
  return out;
}
