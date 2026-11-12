/* 太初 TAICHU — T.M：最小数学库。
   矩阵一律列主序 Float32Array(16)，与 GLSL 的 mat4 / uniformMatrix4fv(transpose=false) 直接对应。 */
(function () {
  'use strict';
  const T = window.TAICHU;

  const M = {};

  // ── 标量 ──
  M.clamp = function (x, a, b) { return x < a ? a : x > b ? b : x; };
  M.saturate = function (x) { return x < 0 ? 0 : x > 1 ? 1 : x; };
  M.lerp = function (a, b, t) { return a + (b - a) * t; };
  M.invLerp = function (a, b, x) { return (x - a) / (b - a); };
  M.remap = function (x, a, b, c, d) { return c + (d - c) * (x - a) / (b - a); };
  M.smoothstep = function (a, b, x) { const t = M.saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  M.smootherstep = function (a, b, x) { const t = M.saturate((x - a) / (b - a)); return t * t * t * (t * (t * 6 - 15) + 10); };
  // 与帧率无关的指数逼近：rate 为每秒的衰减率（1/时间常数）
  M.damp = function (a, b, rate, dt) { return b + (a - b) * Math.exp(-rate * dt); };
  M.fract = function (x) { return x - Math.floor(x); };
  M.deg = function (r) { return r * 180 / Math.PI; };
  M.rad = function (d) { return d * Math.PI / 180; };

  // ── 缓动（输入会被钳到 [0,1]）──
  M.ease = {
    linear: function (t) { return M.saturate(t); },
    inQuad: function (t) { t = M.saturate(t); return t * t; },
    outQuad: function (t) { t = M.saturate(t); return t * (2 - t); },
    inOutQuad: function (t) { t = M.saturate(t); return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t); },
    inCubic: function (t) { t = M.saturate(t); return t * t * t; },
    outCubic: function (t) { t = 1 - M.saturate(t); return 1 - t * t * t; },
    inOutCubic: function (t) { t = M.saturate(t); return t < 0.5 ? 4 * t * t * t : 1 - 4 * (1 - t) * (1 - t) * (1 - t); },
    inOutSine: function (t) { t = M.saturate(t); return 0.5 - 0.5 * Math.cos(Math.PI * t); },
    outExpo: function (t) { t = M.saturate(t); return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); },
    inOutExpo: function (t) {
      t = M.saturate(t);
      if (t <= 0 || t >= 1) return t;
      return t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2;
    },
  };
  // 关键帧插值：keys = [[t, v], ...]（t 递增；v 为数字或等长数组），段内用 easeFn（缺省 inOutSine）
  M.keyframes = function (keys, t, easeFn) {
    const e = easeFn || M.ease.inOutSine;
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      if (t < keys[i][0]) {
        const a = keys[i - 1], b = keys[i];
        const u = e((t - a[0]) / (b[0] - a[0]));
        if (typeof a[1] === 'number') return a[1] + (b[1] - a[1]) * u;
        return a[1].map(function (v, k) { return v + (b[1][k] - v) * u; });
      }
    }
    return keys[keys.length - 1][1];
  };

  // ── 随机 ──
  // mulberry32：32 位状态，周期 2^32，质量足够做演出用的随机；同一 seed 永远给同一序列
  M.mulberry32 = function (seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  // 字符串 → 32 位哈希（FNV-1a），用来把章节 id 混进种子
  M.hashStr = function (s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  };
  // 标准正态（Box–Muller），rng 为 [0,1) 生成器
  M.gauss = function (rng) {
    const u = Math.max(1e-12, rng()), v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  // ── vec3（普通数组或 Float32Array 都可）──
  M.v3 = function (x, y, z) { return [x || 0, y || 0, z || 0]; };
  M.add = function (a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; };
  M.sub = function (a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; };
  M.scale = function (a, s) { return [a[0] * s, a[1] * s, a[2] * s]; };
  M.dot = function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };
  M.cross = function (a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; };
  M.len = function (a) { return Math.hypot(a[0], a[1], a[2]); };
  M.norm = function (a) { const l = M.len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  M.mix3 = function (a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; };
  // 球坐标 → 方向：az 绕 y 轴（0 指向 +z），el 为仰角
  M.sph = function (az, el) { const c = Math.cos(el); return [c * Math.sin(az), Math.sin(el), c * Math.cos(az)]; };

  // ── mat4（列主序）──
  M.mat4 = function () { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
  M.identity = M.mat4;
  // out = a · b（先 b 后 a）
  M.mul = function (a, b, out) {
    const o = out || new Float32Array(16);
    const r = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let rr = 0; rr < 4; rr++) {
        r[c * 4 + rr] = a[rr] * b[c * 4] + a[4 + rr] * b[c * 4 + 1] + a[8 + rr] * b[c * 4 + 2] + a[12 + rr] * b[c * 4 + 3];
      }
    }
    o.set(r);
    return o;
  };
  // fovY 为弧度
  M.perspective = function (fovY, aspect, near, far, out) {
    const o = out || new Float32Array(16);
    const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
    o.fill(0);
    o[0] = f / aspect; o[5] = f;
    o[10] = (far + near) * nf; o[11] = -1;
    o[14] = 2 * far * near * nf;
    return o;
  };
  M.ortho = function (l, r, b, t, n, f, out) {
    const o = out || new Float32Array(16);
    o.fill(0);
    o[0] = 2 / (r - l); o[5] = 2 / (t - b); o[10] = -2 / (f - n);
    o[12] = -(r + l) / (r - l); o[13] = -(t + b) / (t - b); o[14] = -(f + n) / (f - n); o[15] = 1;
    return o;
  };
  M.lookAt = function (eye, target, up, out) {
    const o = out || new Float32Array(16);
    const z = M.norm(M.sub(eye, target));
    let x = M.cross(up || [0, 1, 0], z);
    if (M.len(x) < 1e-8) x = M.cross([0, 0, 1], z);
    x = M.norm(x);
    const y = M.cross(z, x);
    o[0] = x[0]; o[1] = y[0]; o[2] = z[0]; o[3] = 0;
    o[4] = x[1]; o[5] = y[1]; o[6] = z[1]; o[7] = 0;
    o[8] = x[2]; o[9] = y[2]; o[10] = z[2]; o[11] = 0;
    o[12] = -M.dot(x, eye); o[13] = -M.dot(y, eye); o[14] = -M.dot(z, eye); o[15] = 1;
    return o;
  };
  M.translate = function (x, y, z) { const m = M.mat4(); m[12] = x; m[13] = y; m[14] = z; return m; };
  M.scaleM = function (x, y, z) { const m = M.mat4(); m[0] = x; m[5] = y === undefined ? x : y; m[10] = z === undefined ? x : z; return m; };
  M.rotX = function (a) { const m = M.mat4(), c = Math.cos(a), s = Math.sin(a); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; };
  M.rotY = function (a) { const m = M.mat4(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; };
  M.rotZ = function (a) { const m = M.mat4(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; };
  M.transpose = function (a) {
    const o = new Float32Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) o[i * 4 + j] = a[j * 4 + i];
    return o;
  };
  M.invert = function (a) {
    const o = new Float32Array(16);
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return null;
    det = 1 / det;
    o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return o;
  };
  // 点变换（含透视除法）
  M.xform = function (m, p) {
    const x = p[0], y = p[1], z = p[2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
      (m[2] * x + m[6] * y + m[10] * z + m[14]) / w];
  };
  // 4×4 左上角取 mat3（列主序 Float32Array(9)）
  M.mat3From4 = function (m) { return new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]); };

  T.M = M;
})();
