/* 太初 TAICHU — 第二幕 · 星系 galaxy
   受限 N 体（图姆尔兄弟 1972）：两个有质量的星系核（CPU 蛙跳 + 动力摩擦）与一百万颗无质量的试验恒星（GPU，辛欧拉）。
   恒星的属性（星族、光度、旋臂、尘埃）全部定义在初始盘坐标上；旋臂图样按密度波推进（遭遇前不缠卷），遭遇后逐渐交还给随粒子剪切的物质臂；
   潮汐加速度越过阈值的"富气体"恒星点亮星暴，约 8 秒褪去。 */
(function () {
  'use strict';
  const T = window.TAICHU;
  const M = T.M;

  // ── 单位：G = 1，主星系核质量 M₁ = 1，主盘标长 R_d = 1（≈ 1 万光年）──
  const M1 = 1.0, M2 = 0.5, MT = M1 + M2;
  const EPS1 = 1.4, EPS2 = 0.6;                 // 恒星感受到的两个核的普卢默软化：大核心 = 内盘近似刚体转动，旋臂缠卷得慢
  const EPAIR2 = 1.36;                          // 核—核之间用对称的软化（轨道标定用的就是它），才有守恒的二体能量
  // 相对轨道与时间标定：在 shots/galaxy/tune2.js 里对"近心点 t=30、第二次近心（并合）t=58"做了二分求解
  const D0 = 15, RP = 3.5, FE = 1.1;            // 初始间距、开普勒近心距、能量系数（v² = FE·2M/D0）
  const FRIC = 0.1951, FRIC_R = 3.0;            // 动力摩擦 γ(r) = γ₀·exp(−r²/R_f²)：只在两晕重叠时显著
  const SIM_PER_S = 0.9705;                     // 模拟时间 / 屏幕秒
  const STEP_S = 1 / 60, DT = SIM_PER_S * STEP_S, MAX_SUB = 4;
  const T_PASS = 30, T_MERGE = 58, DUR = 86;
  const TIDE = 0.045;                            // 星暴的潮汐加速度阈值（模拟单位）
  const VUNIT = 220 / 0.5243;                    // 主星系最大圆速度 ≈ 220 km/s
  const f1 = function (x) { const s = (+x).toFixed(6); return s.indexOf('.') < 0 ? s + '.0' : s; };

  // ── 正片与自检共用：加速度、圆速度、积分一步 ──
  const PHYS = `
const float M1 = ${f1(M1)}, M2 = ${f1(M2)}, EPS1 = ${f1(EPS1)}, EPS2 = ${f1(EPS2)};
uniform vec3 uN1, uN2;
uniform float uM1, uM2;
vec3 plummer(vec3 x, vec3 c, float m, float e) {
  vec3 d = x - c; float r2 = dot(d, d) + e * e;
  return -m * d * inversesqrt(r2 * r2 * r2);
}
vec3 starAccel(vec3 x) { return plummer(x, uN1, uM1, EPS1) + plummer(x, uN2, uM2, EPS2); }
float vcirc(float r, float m, float e) { return sqrt(m * r * r / pow(r * r + e * e, 1.5)); }`;

  // 初始盘坐标上的一切：位置、速度、色温、光度、星暴资格。初始化与属性两遍共用这一个函数
  const STAR = `
#include <common>
#include <hash>
#include <noise>
uniform uint uSeed;
uniform uint uN;
uniform float uW;
uniform vec3 uC1, uC2, uU1, uU2, uE1a, uE1b, uE2a, uE2b;
const float PITCH = 0.33, TW = ${f1(8 * SIM_PER_S)};
struct Star { float gal; float bulge; vec3 q; vec3 qv; float T; float lum; float thr; };
vec2 bm(vec2 u) { return sqrt(-2.0 * log(max(u.x, 1e-7))) * vec2(cos(TAU * u.y), sin(TAU * u.y)); }
Star makeStar(uint id) {
  Star s;
  vec4 h1 = hash4u(uvec4(id, uSeed, 0x51u, 7u)), h2 = hash4u(uvec4(id, uSeed, 0x9Eu, 3u));
  vec4 h3 = hash4u(uvec4(id, uSeed, 0x2Cu, 11u)), h4 = hash4u(uvec4(id, uSeed, 0x77u, 5u));
  s.gal = h1.x < 0.65 ? 0.0 : 1.0;
  bool pri = s.gal < 0.5;
  float m = pri ? M1 : M2, e = pri ? EPS1 : EPS2, Rd = pri ? 1.0 : 0.7;
  s.bulge = h1.y < (pri ? 0.13 : 0.16) ? 1.0 : 0.0;
  // 光度幂律：绝大多数很暗，极少数很亮
  s.lum = min(pow(max(h3.x, 1e-5), -0.55), 120.0);
  s.thr = 1e6;
  if (s.bulge > 0.5) {
    // 核球：普卢默核内近似谐振势，ω² = M/ε³，各向同性弥散 σ = ω·a
    float a = 0.30 * Rd;
    s.q = a * vec3(bm(h2.xy), bm(h2.zw).x) * vec3(1.0, 1.0, 0.65);
    float sig = sqrt(m / (e * e * e)) * a;
    s.qv = sig * vec3(bm(h4.xy), bm(h4.zw).x);
    float r = length(s.q.xy);
    s.qv.xy += 0.35 * vcirc(r, m, e) * vec2(-s.q.y, s.q.x) / max(r, 1e-3);
    s.T = mix(3500.0, 5000.0, h1.w);
    s.lum *= 0.8;
    return s;
  }
  // 指数盘：r·e^(−r/R_d) 分布（两个均匀数之积的对数），截到 5 R_d
  float r = -Rd * log(max(h2.x * h2.y, 1e-7));
  if (r > 5.0 * Rd) r = mod(-Rd * log(max(h2.z * h2.w, 1e-7)), 5.0 * Rd);
  r = max(r, 0.04);
  float phi = TAU * h1.z;
  float vc = vcirc(r, m, e);
  vec2 cs = vec2(cos(phi), sin(phi));
  s.q = vec3(r * cs, 0.045 * Rd * (1.0 + 0.5 * r / Rd) * bm(h3.yz).x);
  vec2 dv = bm(h4.xy);
  s.qv = vec3(vc * vec2(-cs.y, cs.x) + 0.05 * vc * dv, 0.03 * vc * bm(h4.zw).x);
  // 旋臂是密度波：图样以 Ω_p（共转半径 3.2 R_d）刚性转动，恒星穿臂而过。uW = ∫k dt：
  // k = 1 时图样不缠卷，k = 0 时退化为随粒子剪切的物质臂（遭遇之后逐渐交还给物质臂，潮汐尾因此带走旋臂的痕迹）
  float rc = 3.2 * Rd, omp = vcirc(rc, m, e) / rc;
  float psi = phi + (vc / r - omp) * uW;
  vec2 P2 = r / Rd * vec2(cos(psi), sin(psi));
  float fil = fbm(vec3(P2 * 1.7, s.gal * 9.0), 4, 2.1, 0.55);
  float cl = vnoise(vec3(P2 * 5.0, s.gal * 17.0 + 1.3));
  // 两条主臂 + 噪声扰动的相位（絮状、不再是完美的螺线）+ 外盘一条从 1.5 R_d 分出的支臂
  float lr = log(r / Rd);
  float ph = 2.0 * (psi + lr / tan(PITCH)) + 1.3 * fil;
  float ph2 = 2.0 * (psi + lr / tan(PITCH * 1.45)) + 1.3 * fil + 0.81;
  float spur = 0.6 * pow(0.5 + 0.5 * cos(ph2), 4.0) * smoothstep(1.3, 2.4, r / Rd);
  float inr = smoothstep(0.2, 0.75, r / Rd);
  float arm = max(pow(0.5 + 0.5 * cos(ph), 3.0), spur) * (0.55 + 0.9 * cl) * inr + 0.25 * (1.0 - inr);
  // 年轻星团：权重连续（图样在恒星间流动，阈值跳变会闪）
  float yw = smoothstep(0.28, 0.5, arm) * smoothstep(0.5, 0.66, cl) * step(h1.w, 0.55);
  s.T = mix(mix(4000.0, 6200.0, h1.w), mix(10000.0, 20000.0, h3.w), yw);
  s.lum *= (0.3 + 1.4 * arm) * (1.0 + 1.2 * yw) * (1.0 + 0.3 * r / Rd);
  // 尘埃：旋臂内侧的暗带 + 絮状丝缕
  float lane = pow(0.5 + 0.5 * cos(ph + 0.85), 3.0);
  float dust = clamp(lane * (0.8 + 0.9 * fil) + 0.5 * max(fil, 0.0), 0.0, 0.95) * smoothstep(4.2 * Rd, 1.2 * Rd, r) * smoothstep(0.15, 0.6, r / Rd);
  s.lum *= 1.0 - dust;
  // 富气体的团块才会被潮汐点燃（刻在物质坐标上，与旋臂图样无关）
  float psi0 = phi + vc / r * TW;
  float gas = vnoise(vec3(r / Rd * vec2(cos(psi0), sin(psi0)) * 3.5, s.gal * 5.0 + 3.0));
  if (gas > 0.5) s.thr = 0.6 + 1.2 * h4.x;
  return s;
}
void placeStar(Star s, out vec3 x, out vec3 v) {
  bool pri = s.gal < 0.5;
  vec3 a = pri ? uE1a : uE2a, b = pri ? uE1b : uE2b, n = cross(a, b);
  x = (pri ? uC1 : uC2) + a * s.q.x + b * s.q.y + n * s.q.z;
  v = (pri ? uU1 : uU2) + a * s.qv.x + b * s.qv.y + n * s.qv.z;
}`;

  const INIT_FS = `
${PHYS}
${STAR}
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;
void main() {
  uvec2 p = uvec2(gl_FragCoord.xy);
  Star s = makeStar(p.y * uN + p.x);
  vec3 x, v; placeStar(s, x, v);
  // w：符号 = 所属星系，大小 = 1 + 星暴阈值倍数；速度 w = 上次星暴的时刻
  oPos = vec4(x, (s.gal < 0.5 ? 1.0 : -1.0) * (1.0 + s.thr));
  oVel = vec4(v, -1e4);
}`;

  const ATTR_FS = `
${PHYS}
${STAR}
void main() {
  uvec2 p = uvec2(gl_FragCoord.xy);
  Star s = makeStar(p.y * uN + p.x);
  fragColor = vec4(s.T * 1e-4, s.lum, 0.0, 0.0);
}`;

  // 自检用：在 x 轴上若干半径处放圆轨道粒子（只有主核）
  const PROBE_FS = `
${PHYS}
uniform float uR[8];
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;
void main() {
  float r = uR[int(gl_FragCoord.x)];
  oPos = vec4(r, 0.0, 0.0, 1.0 + 1e6);
  oVel = vec4(0.0, 0.0, vcirc(r, M1, EPS1), -1e4);
}`;

  const STEP_FS = `
${PHYS}
uniform sampler2D uPos, uVel;
uniform float uDt, uTime, uTide;
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(uPos, p, 0), V = texelFetch(uVel, p, 0);
  V.xyz += starAccel(P.xyz) * uDt;
  P.xyz += V.xyz * uDt;
  // 潮汐加速度：另一个核对恒星与对本星系核的加速度之差
  bool pri = P.w > 0.0;
  vec3 own = pri ? uN1 : uN2, oth = pri ? uN2 : uN1;
  float mo = pri ? uM2 : uM1, eo = pri ? EPS2 : EPS1;
  float tide = length(plummer(P.xyz, oth, mo, eo) - plummer(own, oth, mo, eo));
  if (tide > uTide * (abs(P.w) - 1.0) && uTime - V.w > 15.0) V.w = uTime;
  oPos = P; oVel = V;
}`;

  const DRAW_VS = `
#include <common>
#include <blackbody>
uniform sampler2D uPos, uVel, uAttr;
uniform int uN;
uniform mat4 uViewProj;
uniform vec3 uEye, uN1, uN2;
uniform float uPx, uTime, uGain, uBurst, uTail;
out vec3 vCol;
void main() {
  ivec2 p = ivec2(gl_VertexID % uN, gl_VertexID / uN);
  vec4 P = texelFetch(uPos, p, 0), V = texelFetch(uVel, p, 0), A = texelFetch(uAttr, p, 0);
  gl_Position = uViewProj * vec4(P.xyz, 1.0);
  float d = length(P.xyz - uEye);
  float age = uTime - V.w;
  // 星暴：约 8 秒的闪亮 + 一段更久的蓝色余辉，让年轻星团沿桥与尾成串留下
  float b = age >= 0.0 ? smoothstep(0.0, 0.5, age) * exp(-age / 2.7) * uBurst : 0.0;
  float yb = age >= 0.0 ? smoothstep(0.0, 1.5, age) * exp(-age / 18.0) * uBurst * uTail : 0.0;
  // 远离两核的星（桥、潮汐尾）：面密度低，抬一点亮度下限与点径，让星流读得出来
  float tw = uTail * smoothstep(3.2, 8.0, min(length(P.xyz - uN1), length(P.xyz - uN2)));
  // 同时压缩尾部的光度离散（稀疏处个别亮星会成"椒盐"颗粒），点径放大让星流连成雾状的光带
  float L = max(A.y / (1.0 + 0.3 * tw * A.y), 0.25 * tw) * (1.0 + 7.0 * b + 2.0 * yb) * (1.0 + 1.1 * tw);
  float bl = saturate(b * 1.5 + 1.2 * yb);
  vec3 col = mix(blackbody(A.x * 1e4), blackbody(16000.0), bl);
  col = mix(col, vec3(dot(col, vec3(0.3, 0.55, 0.15))), 0.35 * tw * (1.0 - bl));
  float want = uPx * min(0.9 + 0.2 * log2(1.0 + L), 2.6) * (1.0 + 1.0 * tw);
  gl_PointSize = max(want, 1.5);
  // 每颗星的通量 ∝ 1/d²，面亮度因此与距离无关；贴近镜头的星淡出，限制重绘
  float dd = max(d, 1.2);
  vCol = col * (L * uGain / (dd * dd) * sq(want / gl_PointSize) * smoothstep(0.25, 1.2, d));
  vCol = min(vCol, vec3(40.0));
}`;
  const DRAW_FS = `
in vec3 vCol;
void main() { vec2 q = gl_PointCoord * 2.0 - 1.0; fragColor = vec4(vCol * exp(-dot(q, q) * 4.0), 1.0); }`;

  // 星空 + 两团核球辉光（视线到核心的最近距离，世界单位，与远近无关）
  const BG_FS = `
#include <ray>
#include <sky>
#include <blackbody>
uniform vec3 uN1, uN2;
uniform vec4 uGlow;   // 主核幅度、伴核幅度、并合闪光、星空系数
float glow(vec3 c, vec3 dir, float rc) {
  vec3 o = c - uCamPos; float t = dot(o, dir);
  if (t <= 0.0) return 0.0;
  float b2 = max(dot(o, o) - t * t, 0.0) / (rc * rc);
  return pow(1.0 + b2, -1.6);
}
void main() {
  vec3 dir = cameraRay(vUv);
  vec3 c = sky(dir, uPixAngle) * uGlow.w;
  c += blackbody(4200.0) * (uGlow.x * glow(uN1, dir, 0.16) + 0.12 * uGlow.x * glow(uN1, dir, 0.6));
  c += blackbody(4500.0) * (uGlow.y * glow(uN2, dir, 0.12) + 0.12 * uGlow.y * glow(uN2, dir, 0.45));
  vec3 mid = 0.5 * (uN1 + uN2);
  c += blackbody(6500.0) * uGlow.z * (glow(mid, dir, 0.2) + 0.08 * glow(mid, dir, 0.9));
  fragColor = vec4(c, 1.0);
}`;

  // ── 星系核：CPU 蛙跳（KDK）+ 动力摩擦；正片、自检、实时读数共用 ──
  function nucInit() {
    const L = Math.sqrt(2 * MT * RP * FE), v = Math.sqrt(FE * 2 * MT / D0);
    const vt = L / D0, vr = Math.sqrt(Math.max(v * v - vt * vt, 0));
    const d = [D0, 0, 0], w = [-vr, 0, vt];
    const k1 = -M2 / MT, k2 = M1 / MT;
    return { p1: M.scale(d, k1), p2: M.scale(d, k2), u1: M.scale(w, k1), u2: M.scale(w, k2) };
  }
  function nucAcc(n, fric) {
    const d = M.sub(n.p2, n.p1), r2 = M.dot(d, d), f = 1 / Math.pow(r2 + EPAIR2, 1.5);
    const g = fric * Math.exp(-r2 / (FRIC_R * FRIC_R)), w = M.sub(n.u2, n.u1);
    // 摩擦只作用在相对速度上，保持总动量为零
    return [M.add(M.scale(d, M2 * f), M.scale(w, g * M2 / MT)), M.sub(M.scale(d, -M1 * f), M.scale(w, g * M1 / MT))];
  }
  function nucStep(n, dt, fric) {
    let a = nucAcc(n, fric);
    n.u1 = M.add(n.u1, M.scale(a[0], dt / 2)); n.u2 = M.add(n.u2, M.scale(a[1], dt / 2));
    n.p1 = M.add(n.p1, M.scale(n.u1, dt)); n.p2 = M.add(n.p2, M.scale(n.u2, dt));
    a = nucAcc(n, fric);
    n.u1 = M.add(n.u1, M.scale(a[0], dt / 2)); n.u2 = M.add(n.u2, M.scale(a[1], dt / 2));
  }
  function nucEnergy(n) {
    const d = M.sub(n.p2, n.p1);
    return 0.5 * M1 * M.dot(n.u1, n.u1) + 0.5 * M2 * M.dot(n.u2, n.u2) - M1 * M2 / Math.sqrt(M.dot(d, d) + EPAIR2);
  }

  // 两个盘的取向：主盘自转轴沿轨道角动量（顺行），伴盘绕 x 轴倾 60°
  const S60 = Math.sin(M.rad(60)), C60 = Math.cos(M.rad(60));
  const E1A = [1, 0, 0], E1B = [0, 0, 1], E2A = [1, 0, 0], E2B = [0, S60, C60];

  function initUniforms(n, seed, N) {
    return { uSeed: seed >>> 0, uN: N, uC1: n.p1, uC2: n.p2, uU1: n.u1, uU2: n.u2, uE1a: E1A, uE1b: E1B, uE2a: E2A, uE2b: E2B };
  }
  function seedState(G, s, dbl, N, seed) {
    G.bind(dbl.read);
    s.init.use().set(initUniforms(nucInit(), seed, N));
    G.fullscreen();
  }
  function stepStars(G, s, dbl, n, time, m2) {
    G.bind(dbl.write);
    s.step.use().set({ uPos: dbl.read.texs[0], uVel: dbl.read.texs[1], uN1: n.p1, uN2: n.p2, uM1: M1, uM2: m2,
      uDt: DT, uTime: time, uTide: TIDE });
    G.fullscreen();
    dbl.swap();
  }

  // 平滑分段插值：keys = [[t, v], ...]
  function kf(keys, t) {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i][0]) {
        const a = keys[i - 1], b = keys[i], u = M.smoothstep(0, 1, (t - a[0]) / (b[0] - a[0]));
        return a[1] + (b[1] - a[1]) * u;
      }
    }
    return keys[keys.length - 1][1];
  }
  const K_DIST = [[0, 9], [12, 10], [28, 19], [36, 17], [44, 18], [50, 20], [58, 19], [70, 40], [86, 110]];
  const K_EL = [[0, 0.95], [14, 0.85], [30, 0.62], [44, 0.55], [58, 0.5], [86, 0.42]];
  const K_AZ = [[0, 0.25], [30, 0.35], [48, 0.75], [86, 1.2]];
  const K_FOLLOW = [[0, 0], [12, 0], [28, 1]];
  // 定格段落（潮汐桥与长尾）：机位跟住两核中点，距离随两核间距与尾长自适应
  const K_MID = [[26, 0], [31, 1], [48, 1], [55, 0]];
  const K_SPAN = [[30, 6.5], [37, 7.5], [43, 8.2], [50, 9.5]];
  // 尾部亮度抬升与 30–50 s 的约半档增益
  const K_TAIL = [[26, 0], [31, 1], [50, 1], [60, 0]];
  // 密度波图样推进速率 k（uW 的导数，见 STAR）：遭遇前不缠卷，之后半速，并合后交还物质臂
  const K_WAVE = [[0, 1], [26, 1], [34, 0.5], [52, 0.5], [60, 0]];
  const W0 = 4 * SIM_PER_S;   // t = 4 s 那一帧与旧版"TW 预缠卷"的图样相同

  function checksum(f, h) {
    const u = new Uint32Array(f.buffer);
    for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }

  T.registerChapter({
    id: 'galaxy', order: 2,
    title: '星系', latin: 'GALAXY', epoch: '约 130 亿年前', lookback: 13.0, duration: DUR,
    renderScale: 1,
    captions: [
      { t: 3.0, d: 5.0, text: '约一百三十亿年前。' },
      { t: 9.0, d: 6.0, text: '恒星汇成星系。每一个光点，都是一颗太阳。' },
      { t: 18.0, d: 6.0, text: '星系并不孤独。它们会相遇。' },
      { t: 32.0, d: 6.5, text: '没有一颗恒星相撞——它们之间太空旷了。' },
      { t: 40.0, d: 6.5, text: '只有引力，把星流甩成几十万光年长的尾巴。' },
      { t: 59.0, d: 6.0, text: '十亿年后，两个星系成为一个。' },
      { t: 70.0, d: 7.0, text: '银河系也是这样长大的。几十亿年后，它或许将与仙女座相遇。' },
    ],
    controls: ['拖动 环绕', '滚轮 远近'],
    anatomy: {
      lead: '一百万颗恒星，各自在两个星系核的引力场里走自己的轨道。恒星之间互不作用——1972 年，图姆尔兄弟就是这样第一次算出了潮汐尾。',
      equations: [
        { name: '恒星的加速度', eq: 'a = −Σᵢ G·Mᵢ·(x − xᵢ) / (|x − xᵢ|² + εᵢ²)^(3/2)' },
        { name: '积分', eq: 'v ← v + a·Δt，  x ← x + v·Δt' },
        { name: '圆轨道速度', eq: 'v_c² = G·M·r² / (r² + ε²)^(3/2)' },
      ],
      notes: [
        '两个星系核之间是真正的二体引力，外加一项模拟动力摩擦的阻力，所以它们最终并合。',
        '蓝色的闪光是星暴：潮汐力压缩气体，触发成批的恒星诞生。这里用潮汐加速度的大小来近似。',
        '没有一颗恒星相撞。恒星之间的距离，是恒星直径的几千万倍。',
      ],
      live: function (ctx, s) {
        const n = s.nuc, sep = M.len(M.sub(n.p2, n.p1)), rv = M.len(M.sub(n.u2, n.u1));
        return [['恒星', (s.N * s.N).toLocaleString()], ['两核间距', (sep * 10).toFixed(0) + ' 千光年'],
          ['相对速度', (rv * VUNIT).toFixed(0) + ' km/s'], ['经过', (ctx.time / DUR * 15).toFixed(1) + ' 亿年']];
      },
    },
    post: function (ctx, s) { return { bloom: 0.6, bloomRadius: 0.75, exposure: 1.0, vignette: 0.35 }; },

    init: function (ctx) {
      const G = ctx.G;
      const N = ctx.quality >= 2 ? 1024 : ctx.quality === 1 ? 512 : 256;
      const s = {
        N: N,
        init: G.fsProgram('galaxy/init', INIT_FS),
        attrP: G.fsProgram('galaxy/attr', ATTR_FS),
        step: G.fsProgram('galaxy/step', STEP_FS),
        draw: G.program('galaxy/draw', DRAW_VS, DRAW_FS),
        bg: G.fsProgram('galaxy/bg', BG_FS),
        st: G.double({ w: N, h: N, format: 'rgba32f', filter: 'nearest', count: 2 }),
        attr: G.target({ w: N, h: N, format: 'rgba16f', filter: 'nearest' }),
        cam: new T.OrbitCamera({ az: 0.25, el: 0.95, dist: 10, fov: 40, minDist: 2, maxDist: 400, returnAfter: 7 }),
        nuc: nucInit(), steps: 0, acc: 0, cues: {}, attrSeed: -1,
      };
      return s;
    },

    enter: function (ctx, s) {
      const G = ctx.G;
      seedState(G, s, s.st, s.N, ctx.seed);
      s.nuc = nucInit(); s.steps = 0; s.acc = 0; s.cues = {};
      s.W = W0; s.attrSeed = -1;
      s.cam.resetUser();
    },

    update: function (ctx, s) {
      s.acc = Math.min(s.acc + ctx.dt, STEP_S * MAX_SUB);
      while (s.acc >= STEP_S - 1e-7) {
        stepStars(ctx.G, s, s.st, s.nuc, s.steps * STEP_S, M2);
        nucStep(s.nuc, DT, FRIC);
        s.W += kf(K_WAVE, s.steps * STEP_S) * DT;
        s.acc -= STEP_S; s.steps++;
      }
      // 属性只与 seed 和密度波相位 uW 有关：相位不动（并合之后）就不再重算
      if (s.attrSeed !== ctx.seed || s.attrW !== s.W) {
        ctx.G.bind(s.attr);
        s.attrP.use().set(Object.assign(initUniforms(nucInit(), ctx.seed, s.N), { uW: s.W }));
        ctx.G.fullscreen();
        s.attrSeed = ctx.seed; s.attrW = s.W;
      }
      if (ctx.time >= T_PASS && !s.cues.pass1) { s.cues.pass1 = true; ctx.cue('pass1'); }
      if (ctx.time >= T_MERGE && !s.cues.merge) { s.cues.merge = true; ctx.cue('merge'); }
    },

    render: function (ctx, s) {
      const G = ctx.G, t = ctx.time, n = s.nuc;
      const rm = ctx.reducedMotion ? 0.5 : 1;
      const fw = kf(K_FOLLOW, t), wm = kf(K_MID, t);
      const mid = M.scale(M.add(n.p1, n.p2), 0.5), sep = M.len(M.sub(n.p2, n.p1));
      const tgt = M.add(M.scale(n.p1, (1 - fw) * (1 - wm)), M.scale(mid, wm));
      const dist = kf(K_DIST, t) * (1 - wm) + (1.6 * sep + kf(K_SPAN, t)) * wm;
      let az = kf(K_AZ, t) * rm;
      if (t > DUR) az += 0.012 * (t - DUR) * rm;
      s.cam.script({ az: az, el: kf(K_EL, t), dist: dist, target: tgt }).update(ctx);
      const tail = kf(K_TAIL, t);

      // 并合闪光：升 0.4 s、衰减约 3 s
      const fl = t >= T_MERGE - 0.4 ? M.smoothstep(T_MERGE - 0.4, T_MERGE, t) * Math.exp(-Math.max(t - T_MERGE, 0) / 3.0) : 0;
      const sky = 0.35 + 0.25 * M.smoothstep(70, DUR, t);
      G.blend('none');
      s.bg.use().set(Object.assign({ uN1: n.p1, uN2: n.p2, uGlow: [0.85, 0.55, 1.2 * fl * rm, sky] }, s.cam.rayUniforms(ctx)));
      G.fullscreen();

      G.blend('add');
      s.draw.use().set({ uPos: s.st.read.texs[0], uVel: s.st.read.texs[1], uAttr: s.attr, uN: s.N,
        uViewProj: s.cam.viewProj(ctx.aspect, 0.05, 3000), uEye: s.cam.pos, uPx: ctx.px, uTime: s.steps * STEP_S,
        uGain: 6.5 * (1 + 0.4 * tail) * (1024 * 1024) / (s.N * s.N), uBurst: rm, uN1: n.p1, uN2: n.p2, uTail: tail });
      G.drawPoints(s.N * s.N);
    },

    selfTest: function (ctx, s) {
      const G = ctx.G, out = [];
      // 1–2) 只有主核：8 个半径上的圆轨道，用正片的积分着色器推进 4000 步
      const R = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0];
      const pr = G.double({ w: 8, h: 1, format: 'rgba32f', filter: 'nearest', count: 2 });
      const probe = G.fsProgram('galaxy/probe', PROBE_FS);
      G.bind(pr.read); probe.use().set({ uR: R }); G.fullscreen();
      const fixed = { p1: [0, 0, 0], p2: [1e3, 0, 0] };
      let rdev = 0;
      const ang = R.map(function () { return 0; }), last = R.map(function () { return 0; });
      for (let k = 0; k < 4000; k++) {
        stepStars(G, s, pr, fixed, 0, 0);
        if (k % 50 === 49) {
          const f = G.readFloat(pr.read, 0, 0, 8, 1, 0);
          R.forEach(function (r, i) {
            const x = f[i * 4], z = f[i * 4 + 2], rr = Math.hypot(x, z);
            rdev = Math.max(rdev, Math.abs(rr / r - 1));
            const a = Math.atan2(z, x);   // 自转方向：+x 向 +z
            let da = a - last[i]; da -= 2 * Math.PI * Math.round(da / (2 * Math.PI));
            ang[i] += da; last[i] = a;
          });
        }
      }
      let pdev = 0;
      R.forEach(function (r, i) {
        const vc = Math.sqrt(M1 * r * r / Math.pow(r * r + EPS1 * EPS1, 1.5));
        pdev = Math.max(pdev, Math.abs(ang[i] / (vc * 4000 * DT / r) - 1));
      });
      out.push({ name: '圆轨道保持圆（8 个半径 × 4000 步）', expected: '半径偏差 < 1%', measured: (rdev * 100).toFixed(3) + '%', pass: rdev < 0.01 });
      out.push({ name: '转角与 v_c·t / r 之比', expected: '偏差 < 1%', measured: (pdev * 100).toFixed(3) + '%', pass: pdev < 0.01 });

      // 3) 核轨道积分器：关掉摩擦，5000 步能量守恒
      const nn = nucInit(), E0 = nucEnergy(nn);
      let edev = 0;
      for (let k = 0; k < 5000; k++) { nucStep(nn, DT, 0); edev = Math.max(edev, Math.abs(nucEnergy(nn) / E0 - 1)); }
      out.push({ name: '二体能量守恒（无摩擦，5000 步）', expected: '|ΔE/E| < 1e-3', measured: edev.toExponential(2), pass: edev < 1e-3 });

      // 附：并合时间标定（含摩擦的同一积分器）
      const nt = nucInit();
      let prev = 1e9, prev2 = 1e9;
      const peris = [];
      for (let k = 0; k < 90 * 60 && peris.length < 2; k++) {
        nucStep(nt, DT, FRIC);
        const r = M.len(M.sub(nt.p2, nt.p1));
        if (prev < prev2 && prev < r) peris.push(k / 60);
        prev2 = prev; prev = r;
      }
      const okT = peris.length === 2 && Math.abs(peris[0] - T_PASS) <= 1 && Math.abs(peris[1] - T_MERGE) <= 1;
      out.push({ name: '第一次近心点 / 并合时刻', expected: '30 s / 58 s（±1）', measured: peris.map(function (x) { return x.toFixed(2); }).join(' / '), pass: okT });

      // 4) 确定性：32² 颗恒星，同一 seed 推进 600 步两次
      const SN = 32, dbl = G.double({ w: SN, h: SN, format: 'rgba32f', filter: 'nearest', count: 2 });
      const run = function () {
        seedState(G, s, dbl, SN, ctx.seed);
        const nu = nucInit();
        for (let k = 0; k < 600; k++) { stepStars(G, s, dbl, nu, k * STEP_S, M2); nucStep(nu, DT, FRIC); }
        let h = checksum(G.readFloat(dbl.read, 0, 0, SN, SN, 0), 0x811c9dc5);
        h = checksum(G.readFloat(dbl.read, 0, 0, SN, SN, 1), h);
        return h.toString(16).padStart(8, '0');
      };
      const c1 = run(), c2 = run();
      out.push({ name: '600 步两次的状态校验和', expected: c1, measured: c2, pass: c1 === c2 });
      [pr, probe, dbl].forEach(function (o) { G.dispose(o); });
      return out;
    },
  });
})();
