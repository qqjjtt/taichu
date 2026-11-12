/* 太初 TAICHU — 第五幕 · 生命 life
   格雷–斯科特反应扩散：U、V 两种物质在周期网格上扩散，V 吃 U 自我复制并自行衰减。
   正片、自检共用同一份 RD_GLSL（拉普拉斯、反应项、参数地图）。
   模拟按"节拍"推进：每 1/60 秒章内时间一个节拍，节拍里的子步数与参数只由节拍序号决定，
   所以实时播放与快进逐步一致。 */
(function () {
  'use strict';
  const T = window.TAICHU, M = T.M;

  const TICK = 1 / 60, MAX_TICKS = 4;
  const FOV = 38, TANH = Math.tan(M.rad(FOV / 2));
  const FK_MITOSIS = [0.0367, 0.0649];
  // 地图里的四个斑图区间（与着色器里的表一致）：珊瑚 / 迷宫 / 孤立斑点 / 蠕虫
  const REGIMES = [[0.55, 0.55, 0.0545, 0.062], [-0.55, 0.55, 0.029, 0.057], [0.55, -0.55, 0.030, 0.062], [-0.55, -0.55, 0.078, 0.061]];

  // ── 反应扩散核心：正片与自检拼进同一个程序 ──
  const RD_GLSL = `
#include <common>
#include <hash>
uniform sampler2D uState;
uniform vec4 uPh;      // 参数地图的相位（由 seed 决定）
uniform float uMix;    // 0 = 全场有丝分裂，1 = 分区地图
uniform float uBreath; // 叠加在 F 上的慢正弦
uniform vec3 uFix;     // x > 0.5 时全场用 (F, k) = yz（自检用）
const float DU = 1.0, DV = 0.5;
const vec2 FK_MITOSIS = vec2(0.0367, 0.0649);
// 低频地图：整数波数的正弦和，在周期网格上无缝；四个区间按到中心的距离做柔和加权
vec2 fkMap(vec2 q) {
  float a = sin(TAU * (q.x + uPh.x)) + 0.55 * sin(TAU * (q.x + q.y + uPh.y));
  float b = sin(TAU * (q.y + uPh.z)) + 0.55 * sin(TAU * (2.0 * q.x - q.y + uPh.w));
  vec2 z = vec2(a, b) / 1.55;
  vec4 C[4] = vec4[4](vec4(0.55, 0.55, 0.0545, 0.062), vec4(-0.55, 0.55, 0.029, 0.057),
                      vec4(0.55, -0.55, 0.030, 0.062), vec4(-0.55, -0.55, 0.078, 0.061));
  float ws = 0.0; vec2 fk = vec2(0.0);
  for (int i = 0; i < 4; i++) { vec2 d = z - C[i].xy; float w = exp(-dot(d, d) / 0.12); ws += w; fk += w * C[i].zw; }
  return fk / ws;
}
vec2 fkAt(vec2 q) {
  if (uFix.x > 0.5) return uFix.yz;
  vec2 fk = mix(FK_MITOSIS, fkMap(q), uMix);
  fk.x += uBreath;
  return fk;
}
// 9 点拉普拉斯（周期边界）：中心 −1，四邻 0.2，四角 0.05；权重和为 0，所以纯扩散严格守恒
vec2 rdLap(ivec2 p, ivec2 n, vec2 c) {
  #define RDS(dx, dy) texelFetch(uState, (p + ivec2(dx, dy) + n) % n, 0).xy
  vec2 e = RDS(1, 0) + RDS(-1, 0) + RDS(0, 1) + RDS(0, -1);
  vec2 k = RDS(1, 1) + RDS(-1, 1) + RDS(1, -1) + RDS(-1, -1);
  return 0.2 * e + 0.05 * k - c;
}
// 显式欧拉，Δt = 1
vec2 rdReact(vec2 c, vec2 lap, vec2 fk) {
  float r = c.x * c.y * c.y;
  return c + vec2(DU * lap.x - r + fk.x * (1.0 - c.x), DV * lap.y + r - (fk.x + fk.y) * c.y);
}`;

  const STEP_FS = RD_GLSL + `
uniform vec4 uSeg;    // 播种线段（网格纹素坐标）
uniform vec3 uBrush;  // 半径，开关（2 = 只播种、不推进），随机种子
void main() {
  ivec2 n = textureSize(uState, 0), p = ivec2(gl_FragCoord.xy);
  vec2 c = texelFetch(uState, p, 0).xy;
  if (uBrush.y < 1.5) c = rdReact(c, rdLap(p, n, c), fkAt((vec2(p) + 0.5) / vec2(n)));
  if (uBrush.y > 0.5) {
    vec2 x = vec2(p) + 0.5, s = uSeg.zw - uSeg.xy, d = x - uSeg.xy;
    d -= vec2(n) * round(d / vec2(n));
    float h = clamp(dot(d, s) / max(dot(s, s), 1e-6), 0.0, 1.0);
    float m = smoothstep(uBrush.x, uBrush.x * 0.45, length(d - s * h));
    // 用户的笔触不是一整条带（整片同时耗尽 U 会一起死掉），而是沿笔触撒下一串火花大小的种子
    if (uBrush.y > 1.5) {
      vec2 cell = floor(x / 13.0), ctr = (cell + 0.25 + 0.5 * hash22(cell + uBrush.z)) * 13.0;
      float on = step(hash12(cell * 1.7 + uBrush.z * 0.37), 0.6);
      // 种子是完整的火花大小（太小的斑会饿死），只要种子中心落在笔触里就整颗种下
      vec2 dc = ctr - uSeg.xy; dc -= vec2(n) * round(dc / vec2(n));
      float hc = clamp(dot(dc, s) / max(dot(s, s), 1e-6), 0.0, 1.0);
      m = on * step(length(dc - s * hc), uBrush.x) * smoothstep(6.5, 2.9, length(x - ctr));
    }
    // 每个纹素一点由种子决定的起伏：打破完美对称
    float j = hash13(vec3(x, uBrush.z));
    c = mix(c, vec2(0.5, 0.22 + 0.1 * j), m);
  }
  fragColor = vec4(c, 0.0, 1.0);
}`;

  // 自检用的初始状态：0 = 均匀不动点，1 = 二次函数，2 = 随机起伏的 u（v = 0）
  const INIT2_FS = `
#include <hash>
uniform int uMode;
uniform float uSeed;
void main() {
  vec2 x = floor(gl_FragCoord.xy) - 64.0;
  if (uMode == 1) fragColor = vec4(dot(x, x), 0.0, 0.0, 1.0);
  else if (uMode == 2) fragColor = vec4(0.5 + hash12(gl_FragCoord.xy + uSeed), 0.0, 0.0, 1.0);
  else fragColor = vec4(1.0, 0.0, 0.0, 1.0);
}`;

  // 渲染前的整理：轻度平滑的 V 作高度，中心差分梯度，U；写进可线性过滤、可平铺的半精度纹理
  const PREP_FS = `
uniform sampler2D uState;
void main() {
  ivec2 n = textureSize(uState, 0), p = ivec2(gl_FragCoord.xy);
  #define PS(dx, dy) texelFetch(uState, (p + ivec2(dx, dy) + n) % n, 0).xy
  vec2 c = PS(0, 0);
  float e = PS(1, 0).y + PS(-1, 0).y + PS(0, 1).y + PS(0, -1).y;
  float k = PS(1, 1).y + PS(-1, 1).y + PS(1, -1).y + PS(-1, -1).y;
  float vs = 0.4 * c.y + 0.1 * e + 0.05 * k;
  float gx = 0.5 * (PS(1, 0).y - PS(-1, 0).y) + 0.125 * (PS(1, 1).y - PS(-1, 1).y + PS(1, -1).y - PS(-1, -1).y);
  float gy = 0.5 * (PS(0, 1).y - PS(0, -1).y) + 0.125 * (PS(1, 1).y - PS(1, -1).y + PS(-1, 1).y - PS(-1, -1).y);
  fragColor = vec4(vs, gx / 1.5, gy / 1.5, c.x);
}`;

  // V 的总量：每个输出纹素把一块网格加起来
  const SUM_FS = `
uniform sampler2D uState;
uniform int uB;
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy) * uB;
  float s = 0.0;
  for (int j = 0; j < 64; j++) { if (j >= uB) break;
    for (int i = 0; i < 64; i++) { if (i >= uB) break; s += texelFetch(uState, o + ivec2(i, j), 0).y; } }
  fragColor = vec4(s, 0.0, 0.0, 1.0);
}`;

  // 主画面：把网格放成一块倾斜的平面，光线求交后按高度场打光；景深用环形多点采样
  const VIEW_FS = `
#include <common>
#include <blackbody>
#include <dither>
uniform vec3 uCamPos, uCamR, uCamU, uCamF;
uniform float uTan, uAspect, uN, uFocus, uAper, uDish, uTime, uVent, uLife, uH;
uniform vec4 uVents;
uniform sampler2D uTex;
const vec3 WATER = vec3(0.0016, 0.0052, 0.0075);
const vec3 FLUOR = vec3(0.025, 0.46, 0.36);   // 约 490 nm 的青绿生物荧光（线性）
vec3 shade(vec2 P, vec3 vd, out float a) {
  vec4 s = texture(uTex, P / uN + 0.5);
  float v = s.x;
  vec3 n = normalize(vec3(-s.yz * 7.0, 1.0));
  vec3 L = normalize(vec3(-0.35, 0.45, 0.82));
  float th = smoothstep(0.08, 0.19, v), core = smoothstep(0.3, 0.42, v);
  float dif = max(dot(n, L), 0.0);
  float rim = pow(1.0 - max(dot(n, vd), 0.0), 3.0);
  float spec = pow(max(dot(n, normalize(L + vd)), 0.0), 110.0);
  vec3 c = WATER * (0.6 + 0.4 * s.w);
  c += vec3(0.0, 0.012, 0.014) * (1.0 - s.w);                        // 被吃空的 U：一圈暗青的晕
  // 发光跟着反应走：u·v² 大的地方（正在复制的前沿与斑点）最亮，已经饱和的平板反而暗，免得像一块涂层
  float glow = smoothstep(0.004, 0.03, s.w * v * v);
  c += th * vec3(0.022, 0.06, 0.066) * dif;                  // 被顶光照亮的半透明组织
  c += FLUOR * (0.05 * th + 0.36 * glow * th);
  c += core * vec3(1.0, 0.52, 0.2) * 0.16;                   // 最厚处透出的暖色
  c += rim * th * FLUOR * 0.8;                                         // 薄膜边缘的荧光
  c += spec * smoothstep(0.03, 0.14, v) * vec3(0.85, 1.0, 1.0) * 1.1; // 湿润的高光
  a = th;
  return c * uLife;
}
void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uCamF + ndc.x * uTan * uAspect * uCamR + ndc.y * uTan * uCamU);
  vec3 col = WATER * (0.7 + 0.5 * vUv.y);
  if (rd.z < -1e-4) {
    float t = -uCamPos.z / rd.z;
    vec2 P = uCamPos.xy + rd.xy * t;
    vec3 vd = -rd;
    float a;
    vec3 c = shade(P, vd, a);
    // 弥散圆（网格纹素）：薄透镜，焦点在镜头注视点
    float coc = uAper * abs(t - uFocus) / uFocus * t * uTan * 2.0;
    if (coc > 0.6) {
      float ang = ign(gl_FragCoord.xy) * TAU;
      for (int i = 1; i <= 7; i++) {
        float r = sqrt(float(i) / 7.0) * coc;
        float ph = ang + float(i) * 2.39996;
        c += shade(P + r * vec2(cos(ph), sin(ph)) * vec2(1.0, 1.0), vd, a);
      }
      c /= 8.0;
    }
    // 热液口：平面上几处极暗的暖光
    vec2 v1 = P - uVents.xy, v2 = P - uVents.zw, v3 = P - uVents.zw * 6.0;
    float fl = 0.85 + 0.15 * sin(uTime * 0.7) * sin(uTime * 1.13 + 1.0);
    vec3 vent = blackbody(2300.0) * (exp(-dot(v1, v1) / 500.0) * 0.15 + exp(-dot(v2, v2) / 900.0) * 0.09 + exp(-dot(v3, v3) / 20000.0) * 0.1);
    c += vent * uVent * fl;
    // 培养皿般的边缘与远处的水
    float dish = smoothstep(uDish, uDish * 0.5, length(P));
    float fog = exp(-max(t - uFocus, 0.0) / (uFocus * 1.6));
    col = mix(col, c, dish * mix(0.25, 1.0, fog));
  }
  fragColor = vec4(col, 1.0);
}`;

  // 悬浮微粒：位置只由编号与时间决定，盒子跟着视野尺度缩放（提供深度视差）
  const DUST_VS = `
#include <common>
#include <hash>
uniform mat4 uVP;
uniform vec3 uTarget;
uniform float uScale, uTime, uPx, uProj;
uniform uint uSeed;
out vec3 vCol;
void main() {
  uint id = uint(gl_VertexID);
  vec4 h = hash4u(uvec4(id, uSeed, 0x51u, 0x1Fu));
  vec3 drift = vec3(0.006, 0.004, 0.003) * (h.wzy - 0.5) + vec3(0.002, 0.001, 0.0015);
  vec3 q = fract(h.xyz + drift * uTime + 0.01 * sin(uTime * 0.21 + h.w * 6.28));
  vec3 p = uTarget + uScale * vec3((q.xy * 2.0 - 1.0) * 2.6, 0.04 + q.z * 1.9);
  gl_Position = uVP * vec4(p, 1.0);
  float w = max(gl_Position.w, 1e-3);
  float want = uScale * 0.017 * (0.4 + h.w) * uProj / w;
  gl_PointSize = clamp(want, 1.5, 7.0 * uPx);
  float edge = smoothstep(0.0, 0.08, q.x) * smoothstep(1.0, 0.92, q.x) * smoothstep(0.0, 0.08, q.y) * smoothstep(1.0, 0.92, q.y) * smoothstep(0.0, 0.1, q.z) * smoothstep(1.0, 0.9, q.z);
  float near = smoothstep(uScale * 0.4, uScale * 1.2, w);
  vec3 tint = mix(vec3(0.55, 0.8, 0.85), vec3(1.0, 0.7, 0.45), step(0.93, h.z));
  vCol = tint * (0.05 + 0.1 * h.y) * edge * near * sq(min(want, 7.0 * uPx) / gl_PointSize);
}`;
  const DUST_FS = `
in vec3 vCol;
void main() { vec2 q = gl_PointCoord * 2.0 - 1.0; fragColor = vec4(vCol * smoothstep(1.0, 0.2, length(q)), 1.0); }`;

  // ── CPU 端：参数地图（只用于读数）、镜头 ──
  function fkMapCPU(s, q) {
    const TAU = Math.PI * 2, ph = s.ph;
    const a = Math.sin(TAU * (q[0] + ph[0])) + 0.55 * Math.sin(TAU * (q[0] + q[1] + ph[1]));
    const b = Math.sin(TAU * (q[1] + ph[2])) + 0.55 * Math.sin(TAU * (2 * q[0] - q[1] + ph[3]));
    const z = [a / 1.55, b / 1.55];
    let ws = 0, F = 0, K = 0;
    REGIMES.forEach(function (r) { const dx = z[0] - r[0], dy = z[1] - r[1], w = Math.exp(-(dx * dx + dy * dy) / 0.12); ws += w; F += w * r[2]; K += w * r[3]; });
    return [F / ws, K / ws];
  }
  function smooth(a, b, x) { return M.smoothstep(a, b, x); }
  function mixParams(t) { return smooth(40, 48, t); }
  function breathAt(t) { return t < 62 ? 0 : 0.0022 * smooth(62, 66, t) * Math.sin((t - 62) * Math.PI * 2 / 6); }
  // 每节拍的子步数：分裂期放慢让人看清，之后加速铺满
  function stepsAt(t) {
    if (t < 8) return 0;
    if (t < 20) return 4;
    if (t < 34) return Math.round(M.lerp(4, 24, (t - 20) / 14));
    return 24;
  }
  // 导演机位：[时间, 视野半高（纹素）, 倾角, 方位]
  const KEYS = [[0, 34, 0.10, 0.0], [8, 34, 0.10, 0.0], [16, 36, 0.12, 0.02], [22, 46, 0.15, 0.05], [30, 95, 0.2, 0.08],
    [40, 200, 0.3, 0.12], [52, 290, 0.5, 0.18], [62, 340, 0.55, 0.24], [76, 600, 0.6, 0.34]];
  function camKeys(t) {
    let i = 0;
    while (i < KEYS.length - 2 && t > KEYS[i + 1][0]) i++;
    const a = KEYS[i], b = KEYS[i + 1], u = M.smoothstep(a[0], b[0], t);
    return [M.lerp(a[1], b[1], u), M.lerp(a[2], b[2], u), M.lerp(a[3], b[3], u) + (t > 76 ? 0.006 * (t - 76) : 0)];
  }
  function camera(ctx, s) {
    const k = camKeys(ctx.time);
    const H = Math.min(k[0] * s.zoom, 0.62 * s.N), tilt = k[1], az = k[2] - 0.5;
    const dist = H / TANH, hd = [Math.cos(az), Math.sin(az), 0];
    const target = [0, 0, 0];
    const eye = [-hd[0] * Math.sin(tilt) * dist, -hd[1] * Math.sin(tilt) * dist, Math.cos(tilt) * dist];
    const f = M.norm(M.sub(target, eye)), r = M.norm(M.cross(f, hd)), u = M.cross(r, f);
    return { H: H, dist: dist, eye: eye, f: f, r: r, u: u, target: target };
  }
  function pick(ctx, c, nx, ny) {
    const d = M.norm(M.add(c.f, M.add(M.scale(c.r, nx * TANH * ctx.aspect), M.scale(c.u, ny * TANH))));
    if (d[2] > -1e-3) return null;
    const t = -c.eye[2] / d[2];
    return [c.eye[0] + d[0] * t, c.eye[1] + d[1] * t];
  }

  function stepRD(G, prog, dbl, u) {
    G.bind(dbl.write);
    prog.use().set(u);
    G.fullscreen();
    dbl.swap();
  }
  const NO_BRUSH = [0, 0, 0];
  function checksum(f) {
    const u = new Uint32Array(f.buffer);
    let h = 0x811c9dc5;
    for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function tick(ctx, s) {
    const G = ctx.G, t = s.tick * TICK;
    s.tick++;
    if (t >= 8 && !s.cues.spark) {
      s.cues.spark = true; ctx.cue('spark');
      const c = s.N / 2 + 0.5;
      s.pend = { seg: [c + s.sparkOff[0], c + s.sparkOff[1], c + s.sparkOff[0] + 1.5, c + s.sparkOff[1] + 0.8], r: 6.5 };
    }
    if (t >= 40 && !s.cues.diverge) { s.cues.diverge = true; ctx.cue('diverge'); }
    const n = stepsAt(t);
    s.sps = n * 60;
    if (n === 0) return;   // u=1、v=0 是不动点（自检 2），火花之前无须推进
    const base = { uState: null, uPh: s.ph, uMix: mixParams(t), uBreath: breathAt(t), uFix: [0, 0, 0], uSeg: [0, 0, 0, 0], uBrush: NO_BRUSH };
    for (let i = 0; i < n; i++) {
      base.uState = s.sim.read;
      if (i === 0 && s.pend) { base.uSeg = s.pend.seg; base.uBrush = [s.pend.r, 1, s.tick + (ctx.seed & 1023)]; s.pend = null; }
      else base.uBrush = NO_BRUSH;
      stepRD(G, s.step, s.sim, base);
      s.steps++;
    }
  }

  T.registerChapter({
    id: 'life', order: 5,
    title: '生命', latin: 'LIFE', epoch: '约 38 亿年前', lookback: 3.8, duration: 78,
    renderScale: 0.85, fadeIn: 'black',
    captions: [
      { t: 3.0, d: 5.0, text: '约三十八亿年前。' },
      { t: 9.0, d: 6.5, text: '在某处温暖的水里，化学学会了一件新的事：复制自己。' },
      { t: 18.0, d: 6.0, text: '一个变成两个，两个变成四个。' },
      { t: 28.0, d: 6.5, text: '这里没有设计图。只有两种物质，一个扩散，一个反应。' },
      { t: 42.0, d: 7.0, text: '1952 年，图灵提出：反应加扩散，就足以长出斑纹。' },
      { t: 52.0, d: 6.5, text: '你此刻看到的每一个图案，都是当场算出来的。' },
      { t: 66.0, d: 7.0, text: '简单的规则，重复足够多次，就不再简单。' },
    ],
    controls: ['拖动 播种', '滚轮 远近'],
    anatomy: {
      lead: '两种化学物质，一个扩散，一个反应。没有一行代码在描述生命，斑点却会分裂、条纹会生长。',
      equations: [
        { name: '养料 U', eq: '∂u/∂t = D_u·∇²u − u·v² + F·(1 − u)' },
        { name: '复制者 V', eq: '∂v/∂t = D_v·∇²v + u·v² − (F + k)·v' },
        { name: '9 点拉普拉斯', eq: '∇²u ≈ Σ wᵢ·uᵢ − u，  四邻 0.2，四角 0.05' },
      ],
      notes: [
        'F 是养料流入的速度，k 是 V 衰减的速度。只改这两个数，就能得到斑点、条纹或迷宫。',
        '图灵在 1952 年提出：两种以不同速度扩散的物质，就能自发长出斑纹。斑马和豹的花纹，很可能就是这样来的。',
        '你可以拖动画面播种。每一次运行都会长成不同的样子。',
      ],
      live: function (ctx, s) {
        const t = s.tick * TICK, q = [0.5 + 0.5 / s.N, 0.5 + 0.5 / s.N];
        const m = mixParams(t), mp = fkMapCPU(s, q);
        const F = M.lerp(FK_MITOSIS[0], mp[0], m) + breathAt(t), K = M.lerp(FK_MITOSIS[1], mp[1], m);
        const G = ctx.G, B = s.N / 64;
        G.bind(s.sum); s.sumP.use().set({ uState: s.sim.read, uB: B }); G.fullscreen();
        const a = G.readFloat(s.sum, 0, 0, 64, 64);
        let tot = 0;
        for (let i = 0; i < 4096; i++) tot += a[i * 4];
        ctx.bindScene();
        return [['网格', s.N + ' × ' + s.N], ['每秒反应步数', s.sps.toLocaleString()],
          ['视野中心 (F, k)', '(' + F.toFixed(4) + ', ' + K.toFixed(4) + ')'], ['V 的总量', tot.toFixed(1)]];
      },
    },
    post: function (ctx, s) { return { bloom: 0.55, bloomRadius: 0.75, vignette: 0.42, exposure: 1.0, saturation: 0.95, grain: 0.03 }; },

    init: function (ctx) {
      const G = ctx.G, N = ctx.quality >= 2 ? 1024 : ctx.quality === 1 ? 512 : 256;
      return {
        N: N, dustN: ctx.quality >= 2 ? 5000 : ctx.quality === 1 ? 3000 : 1500,
        step: G.fsProgram('life/step', STEP_FS),
        prepP: G.fsProgram('life/prep', PREP_FS),
        sumP: G.fsProgram('life/sum', SUM_FS),
        view: G.fsProgram('life/view', VIEW_FS),
        dust: G.program('life/dust', DUST_VS, DUST_FS),
        sim: G.double({ w: N, h: N, format: 'rg32f', filter: 'nearest', wrap: 'repeat' }),
        prep: G.target({ w: N, h: N, format: 'rgba16f', filter: 'linear', wrap: 'repeat' }),
        sum: G.target({ w: 64, h: 64, format: 'rgba32f', filter: 'nearest' }),
        cues: {}, tick: 0, acc: 0, steps: 0, sps: 0, zoom: 1, pend: null, last: null, strokes: 0, ph: [0, 0, 0, 0], sparkOff: [0, 0], vents: [0, 0, 0, 0],
      };
    },

    enter: function (ctx, s) {
      const G = ctx.G;
      G.bind(s.sim.read); G.clear(1, 0, 0, 1);
      G.bind(s.sim.write); G.clear(1, 0, 0, 1);
      s.cues = {}; s.tick = 0; s.acc = 0; s.steps = 0; s.sps = 0; s.zoom = 1; s.pend = null; s.last = null;
      const rng = M.mulberry32((ctx.seed ^ 0x11FE) >>> 0);
      s.ph = [rng(), rng(), rng(), rng()];
      s.sparkOff = [Math.round(rng() * 4 - 2), Math.round(rng() * 4 - 2)];
      // 热液口放在开场画面的下方（屏幕下 = −hd，右 = (hd.y, −hd.x)）
      const hx = Math.cos(-0.5), hy = Math.sin(-0.5), dn = [-hx, -hy], rt = [hy, -hx];
      s.vents = [dn[0] * 30 + rt[0] * 14, dn[1] * 30 + rt[1] * 14, dn[0] * 42 - rt[0] * 34, dn[1] * 42 - rt[1] * 34];
    },

    update: function (ctx, s) {
      s.acc = Math.min(s.acc + ctx.dt, TICK * MAX_TICKS + 1e-9);
      while (s.acc >= TICK - 1e-9) { tick(ctx, s); s.acc -= TICK; }
    },

    render: function (ctx, s) {
      const G = ctx.G, inp = ctx.input;
      if (inp.wheel) s.zoom = M.clamp(s.zoom * Math.exp(inp.wheel * 0.0012), 0.35, 2.5);
      if (inp.pinch !== 1) s.zoom = M.clamp(s.zoom / inp.pinch, 0.35, 2.5);
      const c = camera(ctx, s);
      // 播种：把指针这一帧扫过的线段交给下一个节拍
      if (inp.down) {
        const p = pick(ctx, c, inp.nx, inp.ny);
        if (p) {
          const g = [p[0] + s.N / 2, p[1] + s.N / 2], a = s.last || g;
          const r = M.clamp(c.H * 0.05, 7, 24);
          // 指针扫过的线段立刻写进状态（暂停时也有手感），之后的节拍让它自己长
          stepRD(G, s.step, s.sim, { uState: s.sim.read, uPh: s.ph, uMix: 0, uBreath: 0, uFix: [0, 0, 0],
            uSeg: [a[0], a[1], g[0], g[1]], uBrush: [r, 2, (s.strokes++ * 7919 + ctx.seed) & 0xFFFF] });
          s.last = g;
        }
      } else s.last = null;

      G.bind(s.prep); s.prepP.use().set({ uState: s.sim.read }); G.fullscreen();
      ctx.bindScene();
      const t = ctx.time;
      const vent = 1.0 - 0.9 * smooth(10, 36, t);
      const life = smooth(0, 3, t);
      s.view.use().set({
        uCamPos: c.eye, uCamR: c.r, uCamU: c.u, uCamF: c.f, uTan: TANH, uAspect: ctx.aspect, uN: s.N,
        uFocus: c.dist, uAper: 0.016, uDish: 0.8 * s.N, uVents: s.vents, uTime: t, uVent: vent, uLife: life, uH: c.H, uTex: s.prep,
      });
      G.fullscreen();
      const proj = M.perspective(M.rad(FOV), ctx.aspect, c.dist * 0.02, c.dist * 20);
      const view = M.lookAt(c.eye, c.target, c.u);
      G.blend('add');
      s.dust.use().set({ uVP: M.mul(proj, view), uTarget: c.target, uScale: c.H, uTime: t, uPx: ctx.px,
        uProj: ctx.height / (2 * TANH), uSeed: ctx.seed >>> 0 });
      G.drawPoints(s.dustN);
    },

    selfTest: function (ctx, s) {
      const G = ctx.G, out = [], R = 128;
      const dbl = G.double({ w: R, h: R, format: 'rg32f', filter: 'nearest', wrap: 'repeat' });
      const init = G.fsProgram('life/st-init', INIT2_FS);
      const put = function (mode) {
        G.bind(dbl.read); init.use().set({ uMode: mode, uSeed: 17 }); G.fullscreen();
      };
      const U = function (fix, brush, seg) {
        return { uState: dbl.read, uPh: s.ph, uMix: 0, uBreath: 0, uFix: fix, uSeg: seg || [0, 0, 0, 0], uBrush: brush || NO_BRUSH };
      };
      const run = function (n, fix, firstBrush, seg) {
        for (let i = 0; i < n; i++) { const u = U(fix, i === 0 ? firstBrush : null, seg); u.uState = dbl.read; stepRD(G, s.step, dbl, u); }
      };
      const read = function () { return G.readFloat(dbl.read, 0, 0, R, R); };

      // 1) u = x² + y²（x、y 从网格中心量起）：四邻和 = 4u + 4，四角和 = 4u + 8，
      //    0.2·(4u+4) + 0.05·(4u+8) − u = 1.2。F = k = 0、v = 0 时推进一步，u 恰好增加 D_u·1.2 = 1.2
      put(1);
      const a0 = read(); run(1, [1, 0, 0]); const a1 = read();
      let lerr = 0;
      for (let y = 58; y <= 70; y++) for (let x = 58; x <= 70; x++) { const i = (y * R + x) * 4; lerr = Math.max(lerr, Math.abs(a1[i] - a0[i] - 1.2)); }
      out.push({ name: '9 点拉普拉斯作用于 x²+y²（内部 13×13 纹素）', expected: '1.2，误差 < 1e-4', measured: lerr.toExponential(2), pass: lerr < 1e-4 });

      // 2) 均匀态 u=1、v=0 在有丝分裂参数下推进 200 步
      put(0); run(200, [1, FK_MITOSIS[0], FK_MITOSIS[1]]);
      const b = read(); let fdev = 0;
      for (let i = 0; i < R * R; i++) fdev = Math.max(fdev, Math.abs(b[i * 4] - 1), Math.abs(b[i * 4 + 1]));
      out.push({ name: '不动点 u=1、v=0 推进 200 步的最大偏差', expected: '< 1e-6', measured: fdev.toExponential(2), pass: fdev < 1e-6 });

      // 3) 纯扩散（F = k = 0、v = 0）：u 的总量守恒
      put(2);
      const sum = function (f) { let t = 0; for (let i = 0; i < R * R; i++) t += f[i * 4]; return t; };
      const m0 = sum(read()); run(200, [1, 0, 0]); const m1 = sum(read());
      const rel = Math.abs(m1 - m0) / m0;
      out.push({ name: '纯扩散 200 步后 u 总量的相对变化', expected: '< 1e-5', measured: rel.toExponential(2), pass: rel < 1e-5 });

      // 4) 有丝分裂：一个斑点推进 3600 步后，用 CPU 连通域数斑点
      const spot = function () { put(0); run(3600, [1, FK_MITOSIS[0], FK_MITOSIS[1]], [6.5, 1, ctx.seed & 1023], [64, 64, 65.5, 64.8]); };
      spot();
      const d = read(), lab = new Int32Array(R * R);
      let blobs = 0;
      for (let i = 0; i < R * R; i++) {
        if (lab[i] || d[i * 4 + 1] <= 0.1) continue;
        blobs++; const st = [i]; lab[i] = blobs;
        while (st.length) {
          const j = st.pop(), x = j % R, y = (j - x) / R;
          [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (o) {
            const k = ((y + o[1] + R) % R) * R + (x + o[0] + R) % R;
            if (!lab[k] && d[k * 4 + 1] > 0.1) { lab[k] = blobs; st.push(k); }
          });
        }
      }
      out.push({ name: '有丝分裂参数下单个斑点 3600 步后的斑点数', expected: '≥ 2', measured: String(blobs), pass: blobs >= 2 });

      // 5) 确定性：同一 seed 重来一次，校验和逐比特一致
      const c1 = checksum(d); spot(); const c2 = checksum(read());
      out.push({ name: '同一 seed 两次推进的校验和', expected: c1, measured: c2, pass: c1 === c2 });

      [dbl, init].forEach(function (o) { G.dispose(o); });
      ctx.bindScene();
      return out;
    },
  });
})();
