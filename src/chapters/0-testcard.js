/* 太初 TAICHU — 参考章 testcard（开发用，不进产物）。
   它既是引擎自测，也是章节作者的范例：每个接口都用到了，照着抄即可。
   画面：可环视的全片星空；左下黑体色标（1000–20000 K）与 HDR 亮度阶梯（0.02–50）；
   中央十几万个沿 curl 噪声流动的点精灵；右上角 256² 波动方程；点击画面产生涟漪。 */
(function () {
  'use strict';
  const T = window.TAICHU;
  const M = T.M;

  const SIM = 256, SIM_DT = 1 / 120, MAX_SUBSTEPS = 8;

  // ── 着色器 ──
  const SKY_FS = `
#include <ray>
#include <sky>
void main() { fragColor = vec4(sky(cameraRay(vUv), uPixAngle), 1.0); }`;

  // 点的位置完全由 (gl_VertexID, 时间) 决定，没有任何状态：每 64 个点组成一条拖尾，沿 curl 场的同一条流线排开；
  // 流线从随机起点出发、寿命 9 秒，位置用 6 步欧拉积分算出（积分时长随时间连续变化，所以运动平滑）
  const PART_VS = `
#include <curl>
#include <blackbody>
uniform mat4 uViewProj;
uniform float uTime;
uniform float uPx;
uniform uint uSeed;
out vec3 vCol;
const float LIFE = 9.0;
void main() {
  uint id = uint(gl_VertexID), seed = id >> 6u;
  float k = float(id & 63u);
  float off = hashu(seed ^ 0xA511E9B3u);
  float cyc = floor(uTime / LIFE + off), ph = fract(uTime / LIFE + off);
  vec4 h = hash4u(uvec4(seed, uint(cyc), uSeed, 0x7u));
  vec3 p = normalize(h.xyz * 2.0 - 1.0 + 1e-4) * (1.8 * pow(h.w, 0.33));
  float tau = max(ph * LIFE - k * 0.02, 0.0), dt = tau / 3.0, speed = 0.0;
  for (int i = 0; i < 3; i++) { vec3 v = curl(p * 0.42 + vec3(0.0, cyc * 3.1, 0.0)); p += v * dt * 0.2; speed += length(v); }
  gl_Position = uViewProj * vec4(p, 1.0);
  float want = 2.6 * uPx * clamp(6.0 / gl_Position.w, 0.4, 3.0);
  gl_PointSize = max(want, 1.5);
  float env = smoothstep(0.0, 0.1, ph) * (1.0 - smoothstep(0.75, 1.0, ph)) * sq(1.0 - k / 64.0);
  // 点被放大到最小尺寸时按面积降亮度：总能量与分辨率无关
  vCol = blackbody(mix(2400.0, 12000.0, saturate(speed / 3.0 / 2.6))) * (0.5 * env * sq(want / gl_PointSize));
}`;
  const PART_FS = `
in vec3 vCol;
void main() { vec2 q = gl_PointCoord * 2.0 - 1.0; fragColor = vec4(vCol * exp(-dot(q, q) * 4.0), 1.0); }`;

  // 波动方程：状态 (hₙ, hₙ₋₁) 存在 rg32f；中心差分，c²Δt²/Δx² = 0.25（二维稳定上限 0.5）
  const STEP_FS = `
uniform sampler2D uState;
uniform vec4 uDrop;   // xy 位置 [0,1]，z 半径，w 振幅（0 = 无）
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), n = textureSize(uState, 0) - 1;
  vec2 s = texelFetch(uState, p, 0).xy;
  float lap = texelFetch(uState, min(p + ivec2(1, 0), n), 0).x + texelFetch(uState, max(p - ivec2(1, 0), ivec2(0)), 0).x
            + texelFetch(uState, min(p + ivec2(0, 1), n), 0).x + texelFetch(uState, max(p - ivec2(0, 1), ivec2(0)), 0).x - 4.0 * s.x;
  float h = (2.0 * s.x - s.y + 0.25 * lap) * 0.997;
  vec2 d = (vec2(p) + 0.5) / vec2(n + 1) - uDrop.xy;
  h += uDrop.w * exp(-dot(d, d) / (uDrop.z * uDrop.z));
  fragColor = vec4(h, s.x, 0.0, 1.0);
}`;

  // 屏幕空间叠层（以 1080 高的"参考像素"布局，任何分辨率下比例一致）
  const OVERLAY_FS = `
#include <blackbody>
uniform vec2 uRes;
uniform float uPx;
uniform sampler2D uSim;
uniform vec4 uRip[4];   // xy 参考像素，z 年龄（秒），w 是否有效
uniform float uPickK;
float inBox(vec2 p, vec2 lo, vec2 hi) { return step(lo.x, p.x) * step(p.x, hi.x) * step(lo.y, p.y) * step(p.y, hi.y); }
void main() {
  vec2 p = gl_FragCoord.xy / uPx, R = uRes / uPx;
  vec3 add = vec3(0.0);
  vec4 o = vec4(0.0);
  // 底板 + 两排色块：上排 HDR 阶梯 0.02…50（中性白），下排黑体 1000…20000 K（最大分量 = 1）
  if (inBox(p, vec2(28.0), vec2(28.0 + 12.0 * 54.0 + 4.0, 156.0)) > 0.0) {
    o = vec4(0.0, 0.0, 0.0, 0.88);
    float fi = floor((p.x - 34.0) / 54.0), fx = p.x - 34.0 - fi * 54.0;
    if (fi >= 0.0 && fi < 12.0 && fx < 46.0) {
      float k = fi / 11.0;
      if (p.y > 40.0 && p.y < 86.0) o = vec4(blackbody(1000.0 * pow(20.0, k)), 1.0);
      if (p.y > 98.0 && p.y < 144.0) o = vec4(vec3(0.02 * pow(2500.0, k)), 1.0);
    }
  }
  if (uPickK > 0.0 && inBox(p, vec2(700.0, 28.0), vec2(816.0, 156.0)) > 0.0) o = vec4(blackbody(uPickK), 1.0);
  // 右上角：波动方程的高度场，按法线打光
  vec2 lo = R - 340.0;
  if (inBox(p, lo - 2.0, lo + 302.0) > 0.0) {
    vec2 uv = (p - lo) / 300.0;
    if (inBox(uv, vec2(0.0), vec2(1.0)) > 0.0) {
      float e = 1.0 / 256.0;
      float hx = texture(uSim, uv + vec2(e, 0)).x - texture(uSim, uv - vec2(e, 0)).x;
      float hy = texture(uSim, uv + vec2(0, e)).x - texture(uSim, uv - vec2(0, e)).x;
      vec3 n = normalize(vec3(-hx * 6.0, -hy * 6.0, 1.0)), l = normalize(vec3(-0.45, 0.55, 0.7));
      float spec = pow(max(dot(reflect(-l, n), vec3(0, 0, 1)), 0.0), 60.0);
      o = vec4(vec3(0.012, 0.03, 0.045) + vec3(0.06, 0.16, 0.22) * max(dot(n, l), 0.0) + vec3(2.5) * spec, 1.0);
    } else o = vec4(vec3(0.08), 1.0);
  }
  // 点击涟漪：一圈向外扩散、逐渐变宽变暗的 HDR 光环（叠加）
  for (int i = 0; i < 4; i++) {
    if (uRip[i].w < 0.5) continue;
    float age = uRip[i].z, r = 18.0 + age * 260.0, w = 2.5 + age * 5.0;
    float d = length(p - uRip[i].xy) - r;
    add += vec3(1.0, 0.86, 0.7) * 3.0 * exp(-d * d / (2.0 * w * w)) * sq(1.0 - age / 1.6);
  }
  fragColor = vec4(o.rgb * o.a + add, o.a);
}`;

  // ── 模拟：一份推进函数，update 与 selfTest 共用 ──
  function stepSim(G, prog, dbl, drop) {
    G.bind(dbl.write);
    prog.use().set({ uState: dbl.read, uDrop: drop || [0, 0, 0.01, 0] });
    G.fullscreen();
    dbl.swap();
  }
  function resetSim(G, dbl) {
    G.bind(dbl.read); G.clear(0, 0, 0, 0);
    G.bind(dbl.write); G.clear(0, 0, 0, 0);
  }
  // 由 rng 决定的"雨滴"：每 90 步（0.75 秒）一滴
  function rainDrop(rng, step) {
    if (step % 90 !== 0) return null;
    return [0.15 + 0.7 * rng(), 0.15 + 0.7 * rng(), 0.015 + 0.01 * rng(), (rng() < 0.5 ? -1 : 1) * 0.35];
  }

  function checksum(f) {
    const u = new Uint32Array(f.buffer);
    let h = 0x811c9dc5;
    for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  T.registerChapter({
    id: 'testcard', order: 0, dev: true,
    title: '测', latin: 'TESTCARD', epoch: '开发用', lookback: 0, duration: 30,
    renderScale: 1, fadeIn: 'black',
    captions: [
      { t: 0.5, d: 4.0, text: '测试卡：星空、黑体色标、HDR 阶梯。' },
      { t: 5.0, d: 5.0, text: '拖动环视，滚轮远近，点击画面。' },
    ],
    controls: ['拖动 环视', '滚轮 远近', '点击 涟漪', 'E 切换曝光'],
    anatomy: {
      lead: '引擎自测：每一样东西都在检验一条契约。',
      equations: [
        { name: '波动方程', eq: '∂²h/∂t² = c²∇²h' },
        { name: '无散流场', eq: 'v = ∇×ψ，∇·v = 0' },
      ],
      notes: ['点精灵的位置在顶点着色器里由编号与时间算出，没有任何顶点缓冲。'],
      live: function (ctx, s) {
        return [['粒子', s.count.toLocaleString()], ['模拟步数', String(s.steps)],
          ['场景', ctx.width + '×' + ctx.height], ['曝光', s.exposure.toFixed(2)], ['点击', String(s.clicks)]];
      },
    },
    input: { placeholder: '输入一个色温（K）', maxLength: 6 },
    post: function (ctx, s) { return { exposure: s.exposure, bloom: 0.5, bloomRadius: 0.7 }; },

    onInput: function (ctx, s, text) {
      const k = parseFloat(text);
      if (isFinite(k) && k >= 1000 && k <= 40000) { s.pickK = k; ctx.say(Math.round(k) + ' K', 2.5); } else ctx.say('请输入 1000–40000 之间的数字', 2.5);
    },

    init: function (ctx) {
      const G = ctx.G;
      const s = {
        count: ctx.quality >= 1 ? 65536 : 32768,
        sky: G.fsProgram('testcard/sky', SKY_FS),
        parts: G.program('testcard/particles', PART_VS, PART_FS),
        step: G.fsProgram('testcard/wave', STEP_FS),
        overlay: G.fsProgram('testcard/overlay', OVERLAY_FS),
        sim: G.double({ w: SIM, h: SIM, format: 'rg32f', filter: 'linear' }),
        cam: new T.OrbitCamera({ az: -2.25, el: 0.16, dist: 6.5, fov: 50, minDist: 2, maxDist: 40, returnAfter: 8 }),
        ripples: [], exposure: 1, pickK: 0, clicks: 0, steps: 0, acc: 0, pendingDrop: null, resized: 0,
      };
      return s;
    },

    enter: function (ctx, s) {
      resetSim(ctx.G, s.sim);
      s.steps = 0; s.acc = 0; s.pendingDrop = null; s.ripples = [];
      s.cam.resetUser();
    },

    update: function (ctx, s) {
      // 固定子步：真实 dt 累进到 acc，按 1/120 s 一步推进；上限防止卡顿后"补课"雪崩
      s.acc = Math.min(s.acc + ctx.dt, SIM_DT * MAX_SUBSTEPS);
      while (s.acc >= SIM_DT) {
        const drop = s.pendingDrop || rainDrop(ctx.rng, s.steps);
        s.pendingDrop = null;
        if (!(window.__skip || {}).sim) stepSim(ctx.G, s.step, s.sim, drop);
        s.acc -= SIM_DT; s.steps++;
      }
    },

    render: function (ctx, s) {
      const G = ctx.G, inp = ctx.input;
      // 导演机位缓慢环绕；镜头放在 render 开头更新，暂停 / 冻结时仍可拖动
      s.cam.script({ az: -2.25 + 0.02 * ctx.time, el: 0.16 + 0.04 * Math.sin(ctx.time * 0.1) }).update(ctx);
      if (inp.pressed('KeyE')) s.exposure = s.exposure === 1 ? 2 : s.exposure === 2 ? 0.5 : 1;
      if (inp.clicked) {
        s.clicks++;
        s.ripples.push({ x: inp.clickX, y: inp.clickY, born: ctx.wall });
        if (s.ripples.length > 4) s.ripples.shift();
        s.pendingDrop = [inp.clickX, 1 - inp.clickY, 0.02, 1.0];
        ctx.cue('ping', { x: inp.clickX, y: inp.clickY });
        ctx.say('收到一次点击', 1.2);
      }
      s.ripples = s.ripples.filter(function (r) { return ctx.wall - r.born < 1.6; });

      // 1) 星空：每像素一条视线（场景目标已由引擎绑定并清空）
      const SK = window.__skip || {};
      if (SK.skyconst) { if (!s.k) s.k = G.fsProgram('k', 'void main(){ fragColor = vec4(vUv*0.01, 0.0, 1.0); }'); s.k.use(); G.fullscreen(); }
      else if (SK.skymw) { if (!s.k2) s.k2 = G.fsProgram('k2', '#include <ray>\n#include <sky>\nvoid main(){ fragColor = vec4(skyMilkyWay(cameraRay(vUv)), 1.0); }'); s.k2.use().set(s.cam.rayUniforms(ctx)); G.fullscreen(); }
      else if (SK.skystars) { if (!s.k3) s.k3 = G.fsProgram('k3', '#include <ray>\n#include <sky>\nvoid main(){ fragColor = vec4(skyStars(cameraRay(vUv), uPixAngle), 1.0); }'); s.k3.use().set(s.cam.rayUniforms(ctx)); G.fullscreen(); }
      else if (!SK.sky) { s.sky.use().set(s.cam.rayUniforms(ctx));
      G.fullscreen(); if (SK.rep) { G.blend('add'); for (let r = 1; r < SK.rep; r++) G.fullscreen(); G.blend('none'); } }
      if (SK.spin) { const t0 = performance.now(); while (performance.now() - t0 < SK.spin); }
      // 2) 点精灵：加色混合
      G.blend('add');
      s.parts.use().set({ uViewProj: s.cam.viewProj(ctx.aspect, 0.05, 200), uTime: ctx.time, uPx: ctx.px, uSeed: ctx.seed >>> 0 });
      if (!SK.parts) G.drawPoints(s.count);
      // 3) 叠层：预乘 alpha（不透明色块覆盖，涟漪 alpha=0 即叠加）
      G.blend('premul');
      const rip = new Float32Array(16);
      s.ripples.forEach(function (r, i) {
        rip.set([r.x * ctx.width / ctx.px, (1 - r.y) * ctx.height / ctx.px, ctx.wall - r.born, 1], i * 4);
      });
      s.overlay.use().set({ uRes: [ctx.width, ctx.height], uPx: ctx.px, uSim: s.sim.read, uRip: rip, uPickK: s.pickK });
      if (!SK.overlay) G.fullscreen();
    },

    resize: function (ctx, s) { s.resized++; },   // 本章没有随屏幕尺寸变化的目标；模拟状态与分辨率无关
    leave: function (ctx, s) { s.ripples = []; },

    selfTest: function (ctx, s) {
      const G = ctx.G, out = [];
      const fmt = function (x, d) { return (+x).toFixed(d === undefined ? 4 : d); };

      // 1) rgba32f 写入后读回：与 CPU 端按 float32 计算的期望逐值一致
      const t8 = G.target({ w: 8, h: 8, format: 'rgba32f', filter: 'nearest' });
      const pw = G.fsProgram('testcard/st-write', 'void main() { vec2 f = gl_FragCoord.xy; fragColor = vec4(f.x * 1.5 - 0.25, f.y * -3.0, 1234.5678, f.x * f.y * 1e-4); }');
      G.bind(t8); pw.use(); G.fullscreen();
      const a = G.readFloat(t8, 0, 0, 8, 8);
      let err = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const fx = x + 0.5, fy = y + 0.5, i = (y * 8 + x) * 4;
          const e = [Math.fround(fx * 1.5 - 0.25), Math.fround(fy * -3), Math.fround(1234.5678), Math.fround(fx * fy * 1e-4)];
          for (let c = 0; c < 4; c++) err = Math.max(err, Math.abs(a[i + c] - e[c]) / Math.max(1, Math.abs(e[c])));
        }
      }
      out.push({ name: 'rgba32f 写入 → readFloat 读回', expected: '相对误差 ≤ 1e-6', measured: err.toExponential(2), pass: err <= 1e-6 });

      // 2–4) 着色器片段的数值：hash 均值、黑体色、curl 散度 —— 都在 GPU 上用同一份片段算
      const t64 = G.target({ w: 64, h: 64, format: 'rgba32f', filter: 'nearest' });
      const pm = G.fsProgram('testcard/st-math', `
#include <hash>
#include <curl>
#include <blackbody>
uniform uint uSeed;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float hv = hash12(gl_FragCoord.xy + float(uSeed) * 64.0);
  vec4 r = vec4(hv, 0.0, 0.0, 0.0);
  if (p.y < 32) {   // 下半：curl 的中心差分散度与导数尺度
    vec3 q = hash33(vec3(gl_FragCoord.xy, 7.0)) * 8.0 - 4.0;
    float e = 2e-3;
    float dx = curl(q + vec3(e, 0, 0)).x - curl(q - vec3(e, 0, 0)).x;
    float dy = curl(q + vec3(0, e, 0)).y - curl(q - vec3(0, e, 0)).y;
    float dz = curl(q + vec3(0, 0, e)).z - curl(q - vec3(0, 0, e)).z;
    r.y = (dx + dy + dz) / (2.0 * e);
    r.z = (abs(dx) + abs(dy) + abs(dz)) / (2.0 * e);
  }
  if (p.y == 63 && p.x < 5) {   // 顶行：黑体参考温度
    float K[5] = float[5](6500.0, 3000.0, 5800.0, 10000.0, 20000.0);
    r = vec4(hv, blackbody(K[p.x]));
  }
  fragColor = r;
}`);
      G.bind(t64); pm.use().set({ uSeed: ctx.seed >>> 0 }); G.fullscreen();
      const b = G.readFloat(t64, 0, 0, 64, 64);
      let hs = 0, dsum = 0, ssum = 0;
      for (let i = 0; i < 4096; i++) hs += b[i * 4];
      for (let i = 0; i < 2048; i++) { dsum += Math.abs(b[i * 4 + 1]); ssum += b[i * 4 + 2]; }
      const hm = hs / 4096;
      out.push({ name: 'hash12 均值（4096 样本）', expected: '0.5 ± 0.02', measured: fmt(hm), pass: Math.abs(hm - 0.5) <= 0.02 });
      const bb = function (k) { const i = (63 * 64 + k) * 4; return [b[i + 1], b[i + 2], b[i + 3]]; };
      const w = bb(0), dev = Math.max(Math.abs(w[0] - 1), Math.abs(w[1] - 1), Math.abs(w[2] - 1));
      out.push({ name: 'blackbody(6500 K) 与白 (1,1,1)', expected: '偏差 ≤ 0.06', measured: '(' + w.map(function (v) { return fmt(v, 3); }).join(', ') + ')', pass: dev <= 0.06 });
      const REF = [[1, 0.46, 0.15], [1, 0.87, 0.81], [0.6, 0.71, 1], [0.41, 0.56, 1]];
      let rerr = 0;
      REF.forEach(function (r, k) { const c = bb(k + 1); for (let j = 0; j < 3; j++) rerr = Math.max(rerr, Math.abs(c[j] - r[j])); });
      out.push({ name: 'blackbody 参考表 3000/5800/10000/20000 K', expected: '最大偏差 ≤ 0.06', measured: fmt(rerr, 3), pass: rerr <= 0.06 });
      const ratio = dsum / Math.max(ssum, 1e-9);
      out.push({ name: 'curl 场数值散度 |∇·v| / Σ|∂ᵢvᵢ|（1024 点）', expected: '≤ 0.01', measured: ratio.toExponential(2), pass: ratio <= 0.01 });

      // 5) 星空能量守恒：同一块天区在两种像素角下的加窗总通量相同（星点随分辨率变细但不变亮或变暗）
      const pf = G.fsProgram('testcard/st-skyflux', `
#include <sky>
uniform float uPixA;
uniform float uN;
void main() {
  vec2 c = (gl_FragCoord.xy - 0.5 * uN) * uPixA;
  vec3 d = normalize(SKY_CG + c.x * SKY_YG + c.y * SKY_NG + vec3(0.0, 0.02, 0.0));
  float wnd = exp(-dot(c, c) / (2.0 * 0.006 * 0.006));
  fragColor = vec4(luma(skyStars(d, uPixA)) * wnd * uPixA * uPixA * 1e6, 0.0, 0.0, 1.0);
}`);
      const flux = function (n, pa) {
        const t = G.target({ w: n, h: n, format: 'rgba32f', filter: 'nearest' });
        G.bind(t); pf.use().set({ uPixA: pa, uN: n }); G.fullscreen();
        const f = G.readFloat(t, 0, 0, n, n);
        let sum = 0;
        for (let i = 0; i < n * n; i++) sum += f[i * 4];
        G.dispose(t);
        return sum;
      };
      const f1 = flux(64, 6e-4), f2 = flux(128, 3e-4), fr = f2 / Math.max(f1, 1e-12);
      out.push({ name: '星空总通量：像素角减半前后之比', expected: '1.00 ± 0.03', measured: fmt(fr, 3), pass: Math.abs(fr - 1) <= 0.03 && f1 > 0 });

      // 6) 确定性：同一 seed 推进 240 步两次，状态逐比特一致（用的就是 update 里那个 stepSim）
      const dbl = G.double({ w: SIM, h: SIM, format: 'rg32f', filter: 'nearest' });
      const run = function () {
        resetSim(G, dbl);
        const rng = M.mulberry32(ctx.seed ^ 0x5EED);
        for (let i = 0; i < 240; i++) stepSim(G, s.step, dbl, rainDrop(rng, i));
        return checksum(G.readFloat(dbl.read, 0, 0, SIM, SIM));
      };
      const c1 = run(), c2 = run();
      out.push({ name: '波动模拟 240 步两次的校验和', expected: c1, measured: c2, pass: c1 === c2 });

      [t8, t64, dbl, pw, pm, pf].forEach(function (o) { G.dispose(o); });
      return out;
    },
  });
})();
