// Rasterizing meshes into a ray-marched world.
//
// The ray marcher owns the world's surfaces; imported content owns triangles.
// Rather than teach one to be the other, both write into the same HDR target
// and agree about depth: the scene pass writes gl_FragDepth from its hit
// distance, and this pass draws with an ordinary depth test against it. An
// avatar therefore occludes and is occluded by procedural terrain correctly,
// with no compositing heuristics and no sorting.
//
// Skinning matrices go through a float texture rather than uniforms, because a
// humanoid has fifty-five bones and a uniform array that size does not fit
// alongside everything else the shader already carries.

const MAX_MESH_LIGHTS = 12;

const VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
layout(location = 3) in vec4 aJoints;
layout(location = 4) in vec4 aWeights;

uniform mat4 uViewProjection;
uniform mat4 uModel;
uniform int uSkinned;
uniform sampler2D uBones;   // 4 texels per bone: the columns of its matrix
uniform int uBoneTexWidth;

out vec3 vWorld;
out vec3 vNormal;
out vec2 vUv;

mat4 boneMatrix(int index) {
  int base = index * 4;
  ivec2 size = ivec2(uBoneTexWidth, 1);
  return mat4(
    texelFetch(uBones, ivec2((base + 0) % uBoneTexWidth, (base + 0) / uBoneTexWidth), 0),
    texelFetch(uBones, ivec2((base + 1) % uBoneTexWidth, (base + 1) / uBoneTexWidth), 0),
    texelFetch(uBones, ivec2((base + 2) % uBoneTexWidth, (base + 2) / uBoneTexWidth), 0),
    texelFetch(uBones, ivec2((base + 3) % uBoneTexWidth, (base + 3) / uBoneTexWidth), 0)
  );
}

void main() {
  vec4 position = vec4(aPosition, 1.0);
  vec3 normal = aNormal;

  if (uSkinned == 1) {
    // Linear blend skinning. Four influences is the glTF contract.
    mat4 skin =
      boneMatrix(int(aJoints.x)) * aWeights.x +
      boneMatrix(int(aJoints.y)) * aWeights.y +
      boneMatrix(int(aJoints.z)) * aWeights.z +
      boneMatrix(int(aJoints.w)) * aWeights.w;
    // A zero matrix means unweighted vertices; fall back to rigid.
    if (aWeights.x + aWeights.y + aWeights.z + aWeights.w > 0.0001) {
      position = skin * position;
      normal = mat3(skin) * normal;
    }
  }

  vec4 world = uModel * position;
  vWorld = world.xyz;
  vNormal = normalize(mat3(uModel) * normal);
  vUv = aUv;
  gl_Position = uViewProjection * world;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec3 vWorld;
in vec3 vNormal;
in vec2 vUv;
out vec4 fragColor;

uniform vec4 uBaseColor;
uniform vec3 uEmissive;
uniform float uRoughness;
uniform float uMetallic;
uniform int uHasTexture;
uniform sampler2D uBaseColorTexture;
uniform float uAlphaCutoff;
uniform int uAlphaMask;

uniform vec3 uCamPos;
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform int uLightCount;
uniform vec4 uLightPos[${MAX_MESH_LIGHTS}];
uniform vec4 uLightColor[${MAX_MESH_LIGHTS}];
uniform vec3 uAmbient;
uniform int uToon;
uniform vec3 uShadeColor;

void main() {
  vec4 base = uBaseColor;
  if (uHasTexture == 1) base *= texture(uBaseColorTexture, vUv);
  if (uAlphaMask == 1 && base.a < uAlphaCutoff) discard;

  vec3 n = normalize(vNormal);
  vec3 view = normalize(uCamPos - vWorld);
  if (dot(n, view) < 0.0) n = -n; // double-sided content is common in avatars

  float ndl = dot(n, uKeyDir);
  vec3 light;
  if (uToon == 1) {
    // MToon-ish: one soft step instead of a gradient, which is what makes a
    // stylized avatar read as itself rather than as a plastic PBR doll.
    float toon = smoothstep(-0.1, 0.25, ndl);
    light = mix(uShadeColor, uKeyColor, toon);
  } else {
    light = uKeyColor * max(0.0, ndl);
  }

  vec3 color = base.rgb * (light + uAmbient);

  for (int i = 0; i < ${MAX_MESH_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    vec3 delta = uLightPos[i].xyz - vWorld;
    float distance = length(delta);
    float radius = uLightPos[i].w;
    if (distance > radius * 3.0) continue;
    float attenuation = uLightColor[i].a / (1.0 + (distance * distance) / (radius * radius));
    color += base.rgb * uLightColor[i].rgb * max(0.0, dot(n, delta / max(distance, 1e-4))) * attenuation * 2.4;
  }

  // A tight specular lobe: skin and fabric both need a highlight to have form.
  vec3 halfway = normalize(view + uKeyDir);
  float gloss = mix(96.0, 8.0, clamp(uRoughness, 0.0, 1.0));
  color += uKeyColor * pow(max(0.0, dot(n, halfway)), gloss) * (1.0 - uRoughness) * 0.5;
  color += uEmissive;

  // Rim light, so a dark avatar still separates from a dark world.
  color += uKeyColor * pow(1.0 - max(0.0, dot(n, view)), 4.0) * 0.35;

  fragColor = vec4(color, base.a);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`mesh shader compile failed: ${log}`);
  }
  return shader;
}

/**
 * The mesh pass. Owns GPU copies of imported geometry and nothing else — the
 * world stays authoritative, and this is a cache that can be thrown away and
 * rebuilt from it.
 */
export function createMeshPass(gl) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`mesh program link failed: ${gl.getProgramInfoLog(program)}`);
  }

  const uniform = (name) => gl.getUniformLocation(program, name);
  const u = {
    viewProjection: uniform('uViewProjection'),
    model: uniform('uModel'),
    skinned: uniform('uSkinned'),
    bones: uniform('uBones'),
    boneTexWidth: uniform('uBoneTexWidth'),
    baseColor: uniform('uBaseColor'),
    emissive: uniform('uEmissive'),
    roughness: uniform('uRoughness'),
    metallic: uniform('uMetallic'),
    hasTexture: uniform('uHasTexture'),
    baseColorTexture: uniform('uBaseColorTexture'),
    alphaCutoff: uniform('uAlphaCutoff'),
    alphaMask: uniform('uAlphaMask'),
    camPos: uniform('uCamPos'),
    keyDir: uniform('uKeyDir'),
    keyColor: uniform('uKeyColor'),
    lightCount: uniform('uLightCount'),
    lightPos: uniform('uLightPos'),
    lightColor: uniform('uLightColor'),
    ambient: uniform('uAmbient'),
    toon: uniform('uToon'),
    shadeColor: uniform('uShadeColor'),
  };

  const meshes = new Map(); // asset id -> GPU record
  const textures = new Map(); // asset id -> WebGLTexture
  const whiteTexture = makeWhite(gl);
  let boneTexture = null;
  let boneTexWidth = 0;
  let boneData = null;
  const stats = { draws: 0, triangles: 0, uploads: 0 };

  function makeWhite(gl) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return texture;
  }

  function buffer(target, data, usage = gl.STATIC_DRAW) {
    const handle = gl.createBuffer();
    gl.bindBuffer(target, handle);
    gl.bufferData(target, data, usage);
    return handle;
  }

  /** Upload a mesh asset. Idempotent — the asset id is the cache key. */
  function upload(assetId, mesh) {
    if (meshes.has(assetId)) return meshes.get(assetId);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const attribute = (location, data, components, type = gl.FLOAT, normalized = false) => {
      if (!data) {
        gl.disableVertexAttribArray(location);
        gl.vertexAttrib4f(location, 0, 0, 0, 0);
        return;
      }
      buffer(gl.ARRAY_BUFFER, data);
      gl.enableVertexAttribArray(location);
      if (type === gl.UNSIGNED_SHORT || type === gl.UNSIGNED_BYTE) {
        // Joint indices must stay integers, so upload them as floats the
        // vertex shader can cast — WebGL2 integer attributes need ivec inputs.
        gl.vertexAttribPointer(location, components, gl.FLOAT, normalized, 0, 0);
      } else {
        gl.vertexAttribPointer(location, components, type, normalized, 0, 0);
      }
    };

    attribute(0, mesh.positions, 3);
    attribute(1, mesh.normals, 3);
    attribute(2, mesh.uvs, 2);
    attribute(3, mesh.joints ? Float32Array.from(mesh.joints) : null, 4);
    attribute(4, mesh.weights, 4);

    const indices = mesh.indices instanceof Uint32Array ? mesh.indices : Uint32Array.from(mesh.indices);
    buffer(gl.ELEMENT_ARRAY_BUFFER, indices);

    gl.bindVertexArray(null);
    const record = {
      vao,
      count: indices.length,
      skinned: Boolean(mesh.joints && mesh.weights),
      bounds: mesh.bounds,
    };
    meshes.set(assetId, record);
    stats.uploads++;
    return record;
  }

  function uploadTexture(assetId, image) {
    if (textures.has(assetId)) return textures.get(assetId);
    const texture = gl.createTexture();
    textures.set(assetId, texture);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Placeholder until the decode finishes; avatars appear untextured for a
    // frame rather than not at all.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([200, 200, 210, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    if (image?.bytes && typeof createImageBitmap === 'function') {
      createImageBitmap(new Blob([image.bytes], { type: image.mimeType ?? 'image/png' }))
        .then((bitmap) => {
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
          bitmap.close?.();
        })
        .catch(() => {
          /* an undecodable texture is a flat colour, not a failed import */
        });
    }
    return texture;
  }

  /** Bone matrices live in a float texture: 4 RGBA texels per matrix. */
  function uploadBones(matrices, boneCount) {
    const needed = boneCount * 4;
    if (!boneTexture || needed > boneTexWidth) {
      boneTexWidth = Math.max(64, 1 << Math.ceil(Math.log2(Math.max(4, needed))));
      boneData = new Float32Array(boneTexWidth * 4);
      if (boneTexture) gl.deleteTexture(boneTexture);
      boneTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, boneTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    boneData.set(matrices.subarray(0, Math.min(matrices.length, boneData.length)));
    gl.bindTexture(gl.TEXTURE_2D, boneTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, boneTexWidth, 1, 0, gl.RGBA, gl.FLOAT, boneData);
  }

  /**
   * Draw a list of {mesh, material, model, bones}. Depth testing against the
   * ray march happens here; the caller has already bound the target.
   */
  function draw(list, camera, options = {}) {
    if (!list.length) return { draws: 0, triangles: 0 };
    gl.useProgram(program);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    gl.uniformMatrix4fv(u.viewProjection, false, camera.viewProjection);
    gl.uniform3f(u.camPos, camera.position.x, camera.position.y, camera.position.z);
    const key = options.keyDir ?? [-0.5698, 0.6243, 0.5346];
    gl.uniform3f(u.keyDir, key[0], key[1], key[2]);
    const keyColor = options.keyColor ?? [0.44, 0.52, 0.86];
    gl.uniform3f(u.keyColor, keyColor[0], keyColor[1], keyColor[2]);
    const ambient = options.ambient ?? [0.05, 0.07, 0.12];
    gl.uniform3f(u.ambient, ambient[0], ambient[1], ambient[2]);
    gl.uniform1i(u.lightCount, Math.min(MAX_MESH_LIGHTS, options.lightCount ?? 0));
    if (options.lightPos) gl.uniform4fv(u.lightPos, options.lightPos.subarray(0, MAX_MESH_LIGHTS * 4));
    if (options.lightColor) gl.uniform4fv(u.lightColor, options.lightColor.subarray(0, MAX_MESH_LIGHTS * 4));

    let draws = 0;
    let triangles = 0;
    let boundBones = false;

    for (const item of list) {
      const record = meshes.get(item.mesh);
      if (!record) continue;
      gl.bindVertexArray(record.vao);
      gl.uniformMatrix4fv(u.model, false, item.model);

      const skinned = record.skinned && item.bones;
      gl.uniform1i(u.skinned, skinned ? 1 : 0);
      if (skinned) {
        if (!boundBones || item.bonesDirty !== false) {
          uploadBones(item.bones, item.boneCount);
          boundBones = true;
        }
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, boneTexture);
        gl.uniform1i(u.bones, 1);
        gl.uniform1i(u.boneTexWidth, boneTexWidth);
      }

      const material = item.material ?? {};
      const color = material.baseColor ?? [1, 1, 1, 1];
      gl.uniform4f(u.baseColor, color[0], color[1], color[2], color[3] ?? 1);
      const emissive = material.emissive ?? [0, 0, 0];
      gl.uniform3f(u.emissive, emissive[0], emissive[1], emissive[2]);
      gl.uniform1f(u.roughness, material.roughness ?? 0.8);
      gl.uniform1f(u.metallic, material.metallic ?? 0);
      gl.uniform1f(u.alphaCutoff, material.alphaCutoff ?? 0.5);
      gl.uniform1i(u.alphaMask, material.alphaMode === 'MASK' ? 1 : 0);
      gl.uniform1i(u.toon, material.mtoon ? 1 : 0);
      const shade = material.mtoon?.shadeColorFactor ?? [0.15, 0.18, 0.28];
      gl.uniform3f(u.shadeColor, shade[0], shade[1], shade[2]);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, item.texture ?? whiteTexture);
      gl.uniform1i(u.baseColorTexture, 0);
      gl.uniform1i(u.hasTexture, item.texture ? 1 : 0);

      if (material.doubleSided) gl.disable(gl.CULL_FACE);
      else gl.enable(gl.CULL_FACE);

      gl.drawElements(gl.TRIANGLES, record.count, gl.UNSIGNED_INT, 0);
      draws++;
      triangles += record.count / 3;
    }

    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    stats.draws = draws;
    stats.triangles = triangles;
    return { draws, triangles };
  }

  return {
    upload,
    uploadTexture,
    draw,
    has: (id) => meshes.has(id),
    get stats() {
      return { ...stats, meshes: meshes.size, textures: textures.size };
    },
    dispose() {
      for (const record of meshes.values()) gl.deleteVertexArray(record.vao);
      for (const texture of textures.values()) gl.deleteTexture(texture);
      if (boneTexture) gl.deleteTexture(boneTexture);
      gl.deleteProgram(program);
    },
  };
}

/**
 * The projection the ray marcher implies.
 *
 * The scene shader builds rays as `normalize(basis * vec3(uv * fov, 1))`, so
 * the camera looks down +Z in its own basis and this is the matrix that agrees
 * with it. Derive it once here rather than tuning two things until they match.
 */
export function cameraMatrices(camera, aspect, near = 0.05, far = 12000) {
  const b = camera.basis; // columns: right, up, forward
  const p = camera.position;
  // View = basis transposed, then translate by -eye.
  const view = new Float32Array(16);
  view[0] = b[0]; view[4] = b[1]; view[8] = b[2];
  view[1] = b[3]; view[5] = b[4]; view[9] = b[5];
  view[2] = b[6]; view[6] = b[7]; view[10] = b[8];
  view[3] = 0; view[7] = 0; view[11] = 0;
  view[12] = -(b[0] * p.x + b[1] * p.y + b[2] * p.z);
  view[13] = -(b[3] * p.x + b[4] * p.y + b[5] * p.z);
  view[14] = -(b[6] * p.x + b[7] * p.y + b[8] * p.z);
  view[15] = 1;

  const fov = camera.fov ?? 0.58;
  const projection = new Float32Array(16);
  projection[0] = 1 / (aspect * fov);
  projection[5] = 1 / fov;
  projection[10] = (far + near) / (far - near);
  projection[11] = 1;
  projection[14] = (-2 * far * near) / (far - near);

  return { view, projection, viewProjection: multiply4(projection, view) };
}

export function multiply4(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export function invert4(m) {
  const inv = new Float32Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];

  let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (!det) return null;
  det = 1 / det;
  for (let i = 0; i < 16; i++) inv[i] *= det;
  return inv;
}
