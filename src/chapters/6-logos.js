/* 太初 TAICHU — 第六幕「言」LOGOS。
   一百万个阻尼弹簧振子：a = −k·(x − x_target) − c·v + s·curl(x, t)。
   落点来自一张离屏画布上的字（fillText → alpha → 按覆盖度采样 → 确定性洗牌）。
   同一个推进着色器、同一个采样函数被正片与 selfTest 共用。 */
(function () {
  'use strict';
  const T = window.TAICHU;
  const M = T.M;

  const DT = 1 / 60, MAX_SUB = 4;
  const CAM_DIST = 10, FOV = 40;
  const VIEW_H = 2 * CAM_DIST * Math.tan(FOV * Math.PI / 360);   // z = 0 平面上的可见高度（世界单位）
  const CW = 2048, CH = 1024;
  const FONT = '"Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif';
  const RISE = 0.45, FALL = 0.9;

  // 剧本：时间单位为章内秒。col = [色温 K, 向 tint 混合的比例, tint r, g, b]
  const SCRIPT = [
    { t: 8, text: '光', col: [5400, 0.0, 1, 1, 1], cue: 'glyph' },
    { t: 12.6, rel: true },
    { t: 14, text: '星', col: [12000, 0.0, 1, 1, 1], cue: 'glyph' },
    { t: 18.6, rel: true },
    { t: 20, text: '海', col: [9000, 0.45, 0.22, 0.52, 1.0], cue: 'glyph' },
    { t: 24.6, rel: true },
    { t: 26, text: '生', col: [7000, 0.6, 0.30, 1.0, 0.72], cue: 'glyph' },
    { t: 30.6, rel: true },
    { t: 32, text: '言', col: [3700, 0.0, 1, 1, 1], cue: 'glyph' },
    { t: 37.0, rel: true },
    { t: 40, text: '宇宙花了一百三十八亿年', col: [4300, 0.0, 1, 1, 1], cue: 'line' },
    { t: 46.4, rel: true },
    { t: 48, text: '才学会说话', col: [4000, 0.0, 1, 1, 1], cue: 'line' },
    { t: 54, rel: true, burst: true },
    { t: 56, text: '你好。', col: [3400, 0.0, 1, 1, 1], cue: 'hello', breathOut: 1 },
    { t: 64, cue: 'invite' },
  ];
  const USER_COL = [3900, 0.0, 1, 1, 1];

  // ── 物理：推进、初始化、绘制共用的那一份 GLSL ──
  const PHYS = `
#include <curl>
#include <hash>
uniform float uT, uWrite, uRelease, uSpan, uRise, uFall;
uniform vec3 uText;      // (缩放, 中心 x, 中心 y)：画布像素 → 世界
uniform vec3 uHome;      // 自由漂浮云团的半尺寸
uniform float uFlow, uFlowText, uBreath, uBreathOut;
uniform uint uSeed;
uniform int uN;
const float K_TEXT = 25.0, K_HOME = 0.35, C_TEXT = 9.0, C_FREE = 1.1;
vec4 phash(uint id) { return hash4u(uvec4(id, uSeed, 0x6C6F676Fu, 3u)); }
bool isBokeh(vec4 h) { return h.x < 0.1; }
bool isWisp(vec4 h) { return h.w < 0.06; }
vec3 homePos(uint id, vec4 h) {
  vec3 q = hash4u(uvec4(id, uSeed, 0x484F4D45u, 7u)).xyz * 2.0 - 1.0;
  if (isBokeh(h)) return vec3(q.x * uHome.x * 1.5, q.y * uHome.y * 1.5, q.z < 0.0 ? -3.5 + 12.0 * q.z : 2.5 + 3.5 * q.z);   // 避开焦平面：要么远要么近
  return vec3(q.xy * uHome.xy, q.z * uHome.z);
}
// 无散流场：v = ∇×ψ（curl 片段），空间频率低、随时间缓慢平移
vec3 flowVel(vec3 x, float t) { return curl(x * 0.21 + vec3(0.0, -t * 0.035, t * 0.05)); }
// 依附权重：出发早晚由落点横坐标（delay）决定；散开时同样从左往右先松动
float attachW(float delay, vec4 h) {
  if (isBokeh(h)) return 0.0;
  float d = delay * uSpan;
  float w = smoothstep(0.0, uRise, uT - uWrite - d) * (1.0 - smoothstep(0.0, uFall, uT - uRelease - d));
  if (isWisp(h)) {   // 少量粒子周期性松手，像呼出的气
    float ph = fract(uT / 7.0 + h.z * 7.0);
    w *= 1.0 - uBreathOut * smoothstep(0.0, 0.12, ph) * (1.0 - smoothstep(0.5, 0.8, ph));
  }
  return w;
}`;

  const STEP_FS = PHYS + `
uniform sampler2D uPos, uVel, uTgt;
uniform float uDt;
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uint id = uint(p.y * uN + p.x);
  vec4 h = phash(id);
  vec4 P = texelFetch(uPos, p, 0), V = texelFetch(uVel, p, 0), G = texelFetch(uTgt, p, 0);
  float w = attachW(G.z, h) * G.w;
  vec3 tgt = vec3(uText.yz + G.xy * uText.x, (h.z - 0.5) * 0.05);
  vec3 xt = mix(homePos(id, h), tgt, w);
  float br = uBreath * sin(uT * 0.95 + h.y * 0.6);
  float k = mix(K_HOME, K_TEXT * (1.0 + 0.10 * br), w);
  float c = mix(C_FREE, C_TEXT, w);
  float s = mix(uFlow, uFlowText * (1.0 + 0.7 * br), w);
  vec3 a = -k * (P.xyz - xt) - c * V.xyz + s * flowVel(P.xyz, uT);
  if (isWisp(h)) a.y += 0.4 * (1.0 - w) * uBreathOut;   // 呼出的气微微上浮
  vec3 v = V.xyz + a * uDt;          // 半隐式欧拉：先速度，后位置
  oVel = vec4(v, 0.0);
  oPos = vec4(P.xyz + v * uDt, w);
}`;

  const INIT_FS = PHYS + `
layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uint id = uint(p.y * uN + p.x);
  oPos = vec4(homePos(id, phash(id)), 0.0);
  oVel = vec4(0.0);
}`;

  const DRAW_VS = PHYS + `
#include <blackbody>
uniform sampler2D uPos, uVel;
uniform mat4 uViewProj;
uniform float uPx, uEFree, uEText, uEBokeh, uFocus, uSizeQ, uKeep;
uniform vec2 uTC;        // (色温, 向 tint 的混合)
uniform vec3 uTint;
out vec3 vCol;
out float vBig;
void main() {
  ivec2 p = ivec2(gl_VertexID % uN, gl_VertexID / uN);
  vec4 P = texelFetch(uPos, p, 0);
  vec4 h = phash(uint(gl_VertexID));
  float spd = length(texelFetch(uVel, p, 0).xyz);
  gl_Position = uViewProj * vec4(P.xyz, 1.0);
  float depth = gl_Position.w;
  // 薄透镜弥散圆：对焦在文字平面；点被放大时按面积降亮度，能量守恒
  float coc = 34.0 * uPx * abs(depth - uFocus) / max(depth, 0.5);
  float want = max(1.6 * uPx * uSizeQ, coc);
  float cap = 30.0 * uPx;
  float sz = clamp(want, 1.5, cap);
  float lp = min(pow(1.0 - h.y * 0.99995, -0.72), 60.0) / 3.2;   // 幂律亮度：少数亮，多数暗
  float tw = 2.2 * pow(0.5 + 0.5 * sin(uT * (0.4 + 1.2 * h.z) + h.w * 40.0), 3.0);   // 自由时的萤火明灭（≤ 0.3 Hz）
  float lpB = min(pow(1.0 - h.y * 0.99999, -0.95), 400.0) / 20.0;   // 光斑：绝大多数几乎看不见，只有几颗
  float E = isBokeh(h) ? uEBokeh * lpB * (0.8 + 0.2 * tw) : mix(uEFree * lp * tw, uEText * lp / (1.0 + 1.5 * spd * spd), max(P.w, isWisp(h) ? 0.6 * uBreathOut : 0.0));   // 在途的粒子暗，落定才亮：字是"落"出来的
  // 落定的笔画上每像素叠着几十个粒子：只画其中 uKeep 比例、亮度乘 1/uKeep（总能量不变），省掉同像素混合的争用
  float keep = (isBokeh(h) || isWisp(h)) ? 1.0 : mix(1.0, fract(h.z * 97.13) < uKeep ? 1.0 / uKeep : 0.0, P.w);
  E *= keep * smoothstep(2.0, 4.0, depth) * min(1.0, sq(cap / want));
  if (keep == 0.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  vec3 freeC = isBokeh(h) ? blackbody(mix(2700.0, 7000.0, h.z)) : blackbody(mix(2500.0, 4600.0, h.z));
  vec3 textC = mix(blackbody(uTC.x), uTint, uTC.y);
  vCol = mix(freeC, textC, P.w) * (E * 5.1 / (sz * sz));
  vBig = smoothstep(5.0 * uPx, 12.0 * uPx, sz);
  gl_PointSize = sz;
}`;
  const DRAW_FS = `
in vec3 vCol;
in float vBig;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  float disk = smoothstep(1.0, 0.82, sqrt(r2)) * (0.85 + 0.25 * r2) * 0.55;   // 离焦光斑：平顶、边缘略亮
  fragColor = vec4(vCol * mix(exp(-r2 * 4.0), disk, vBig), 1.0);
}`;

  const SKY_FS = `
#include <ray>
#include <sky>
void main() { fragColor = vec4(sky(cameraRay(vUv), uPixAngle) * 0.3, 1.0); }`;

  // ── 文字 → 落点（CPU） ──
  let canvas = null;
  function getCanvas() {
    if (!canvas) { canvas = document.createElement('canvas'); canvas.width = CW; canvas.height = CH; }
    return canvas;
  }
  function hashStr(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  function sanitize(text) {
    let s = String(text == null ? '' : text);
    try { s = s.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Cc}\p{Cf}\p{Co}\p{Cs}️⃣]/gu, ''); } catch (e) { s = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ''); }
    s = s.replace(/\s+/g, ' ').trim();
    return Array.from(s).slice(0, 48).join('');
  }
  function splitLines(text, portrait) {
    const ch = Array.from(text), maxPer = portrait ? 6 : 12;
    const n = Math.ceil(ch.length / maxPer), per = Math.ceil(ch.length / n), out = [];
    for (let i = 0; i < ch.length; i += per) out.push(ch.slice(i, i + per).join(''));
    return out;
  }
  // 把一句话画进离屏画布，返回 alpha 与包围盒
  const rcache = [];
  function raster(text, portrait) {
    const key = text + '|' + portrait;
    for (let i = 0; i < rcache.length; i++) if (rcache[i].key === key) return rcache[i].r;
    const r = rasterNow(text, portrait);
    rcache.unshift({ key: key, r: r });
    if (rcache.length > 2) rcache.pop();
    return r;
  }
  function rasterNow(text, portrait) {
    const cv = getCanvas(), g = cv.getContext('2d', { willReadFrequently: true });
    const lines = splitLines(text, portrait);
    let maxLen = 1;
    lines.forEach(function (l) { maxLen = Math.max(maxLen, Array.from(l).length); });
    const fs = Math.floor(Math.min(860, 1900 / maxLen, 940 / (lines.length * 1.2)));
    g.clearRect(0, 0, CW, CH);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = fs + 'px ' + FONT;
    lines.forEach(function (l, i) { g.fillText(l, CW / 2, CH / 2 + (i - (lines.length - 1) / 2) * fs * 1.2); });
    const d = g.getImageData(0, 0, CW, CH).data;
    let x0 = CW, x1 = -1, y0 = CH, y1 = -1, cov = 0;
    for (let y = 0; y < CH; y++) {
      for (let x = 0, i = y * CW * 4 + 3; x < CW; x++, i += 4) {
        const a = d[i];
        if (a === 0) continue;
        cov += a;
        if (a >= 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    if (x1 < 0) return null;
    return { data: d, x0: x0, x1: x1, y0: y0, y1: y1, cov: cov / 255, nLines: lines.length, fs: fs, chars: Array.from(text).length };
  }
  // 按覆盖度加权的系统抽样（加亚像素抖动），再确定性洗牌。返回 count×(x, y, delay, 1)，x/y 为相对包围盒中心的画布像素、y 向上
  function sampleTargets(r, count, seed) {
    const d = r.data, rng = M.mulberry32(seed);
    const wgt = function (a) { return a < 112 ? 0 : a / 255; };
    let W = 0;
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0, i = (y * CW + x) * 4 + 3; x <= r.x1; x++, i += 4) W += wgt(d[i]);
    const out = new Float32Array(count * 4);
    const cx = (r.x0 + r.x1 + 1) / 2, cy = (r.y0 + r.y1 + 1) / 2, bw = r.x1 - r.x0 + 1, bh = r.y1 - r.y0 + 1;
    const lh = bh / r.nLines, step = W / count;
    let thr = rng() * step, acc = 0, k = 0;
    for (let y = r.y0; y <= r.y1 && k < count; y++) {
      const li = Math.min(r.nLines - 1, Math.floor((y - r.y0) / lh));
      for (let x = r.x0, i = (y * CW + x) * 4 + 3; x <= r.x1 && k < count; x++, i += 4) {
        const w = wgt(d[i]);
        if (w === 0) continue;
        acc += w;
        while (acc > thr && k < count) {
          const px = x + rng(), py = y + rng(), o = k * 4;
          out[o] = px - cx; out[o + 1] = cy - py;
          out[o + 2] = (li + 0.9 * (px - r.x0) / bw) / r.nLines + 0.12 * rng();
          out[o + 3] = 1;
          thr += step; k++;
        }
      }
    }
    for (; k < count; k++) {   // 浮点舍入留下的空位：复用已有落点并加微小抖动
      const j = Math.floor(rng() * Math.max(1, k - 1)) * 4, o = k * 4;
      out[o] = out[j] + rng() - 0.5; out[o + 1] = out[j + 1] + rng() - 0.5; out[o + 2] = out[j + 2]; out[o + 3] = 1;
    }
    for (let i = count - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      for (let c = 0; c < 4; c++) { const t = out[i * 4 + c]; out[i * 4 + c] = out[j * 4 + c]; out[j * 4 + c] = t; }
    }
    return { tgt: out, bw: bw, bh: bh, cx: cx, cy: cy };
  }

  // ── 模拟对象：正片与 selfTest 用同一套函数 ──
  function makeSim(G, N) {
    return { N: N, st: G.double({ w: N, h: N, format: 'rgba32f', filter: 'nearest', count: 2 }),
      tgt: G.texture({ w: N, h: N, format: 'rgba32f', filter: 'nearest', data: new Float32Array(N * N * 4) }), tgtData: null };
  }
  function disposeSim(G, sim) { G.dispose(sim.st); G.dispose(sim.tgt); }
  function newDir() {
    return { text: '', write: 1e6, release: 1e6, span: 0.6, bw: 1, bh: 1, cov: 0, col: [3400, 0, 1, 1, 1],
      burstAt: -1e6, breathOut: 0.4, portrait: false };
  }
  function resetSim(G, P, sim, U) {
    G.bind(sim.st.read); P.init.use().set(U); G.fullscreen();
    G.bind(sim.st.write); P.init.use().set(U); G.fullscreen();
  }
  function stepSim(G, P, sim, U) {
    G.bind(sim.st.write);
    P.step.use().set(Object.assign({ uPos: sim.st.read.texs[0], uVel: sim.st.read.texs[1], uTgt: sim.tgt, uDt: DT }, U));
    G.fullscreen();
    sim.st.swap();
  }
  // 换字：光栅化、采样、上传；在 at 时刻开始书写
  function setText(sim, dir, text, at, col, seed, portrait) {
    const r = raster(text, portrait);
    if (!r) return false;
    const smp = sampleTargets(r, sim.N * sim.N, (seed ^ hashStr(text)) >>> 0);
    sim.tgt.set(smp.tgt); sim.tgtData = smp.tgt;
    dir.text = text; dir.write = at; dir.release = 1e6; dir.bw = smp.bw; dir.bh = smp.bh; dir.cov = r.cov;
    dir.span = Math.min(1.6, 0.35 + 0.08 * r.chars); dir.col = col; dir.portrait = portrait;
    return true;
  }
  function textScale(dir, aspect) {
    const vw = VIEW_H * aspect;
    return Math.min(0.70 * vw / dir.bw, (dir.text.length === 1 ? 0.5 : 0.6) * VIEW_H / dir.bh);
  }
  function simUniforms(dir, t, aspect, N, seed, flowGain) {
    const sc = textScale(dir, aspect);
    const burst = Math.exp(-Math.max(0, t - dir.burstAt) / 1.6) * (t >= dir.burstAt ? 1 : 0);
    const formed = M.smoothstep(dir.write + dir.span, dir.write + dir.span + 1.5, t);
    return {
      uT: t, uWrite: dir.write, uRelease: dir.release, uSpan: dir.span, uRise: RISE, uFall: FALL,
      uText: [sc, 0, 0.05 * VIEW_H], uHome: [VIEW_H * aspect * 0.6, VIEW_H * 0.6, 2.6],
      uFlow: flowGain * 0.55 * (1 + 2.2 * burst), uFlowText: flowGain * 0.28,
      uBreath: formed, uBreathOut: dir.breathOut * formed, uSeed: seed >>> 0, uN: N,
    };
  }

  function checksum(f) {
    const u = new Uint32Array(f.buffer);
    let h = 0x811c9dc5;
    for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // 剧本推进：在仿真时间 t 上触发写字 / 散开 / cue
  function director(ctx, s) {
    const t = s.simT, d = s.dir;
    while (s.ev < SCRIPT.length && SCRIPT[s.ev].t <= t) {
      const e = SCRIPT[s.ev++];
      if (e.rel && !s.user) { d.release = e.t; if (e.burst) d.burstAt = e.t; }
      if (e.text && !s.user) {
        setText(s.sim, d, e.text, e.t, e.col, ctx.seed, ctx.aspect < 1);
        d.breathOut = e.breathOut || 0.4;
      }
      if (e.cue) ctx.cue(e.cue, e.text ? { char: e.text, text: e.text } : undefined);
    }
    if (s.pending) {   // 观众的话：先让当前的字松开，等它散尽再写
      const free = d.release <= t || d.write > t;
      s.queued = { text: s.pending, at: free ? t + 0.6 : t + d.span + FALL + 0.4 };
      if (!free) d.release = t;
      s.pending = null; s.user = true;
    }
    if (s.queued && t >= s.queued.at) {
      if (setText(s.sim, d, s.queued.text, t, USER_COL, ctx.seed, ctx.aspect < 1)) d.breathOut = 0.6;
      s.queued = null;
    }
  }

  T.registerChapter({
    id: 'logos', order: 6,
    title: '言', latin: 'LOGOS', epoch: '现在', lookback: 0, duration: 80,
    captions: [
      { t: 2.0, d: 5.0, text: '很久以后，一种生命抬起头，开始给星星起名字。' },
      { t: 66.0, d: 8.0, text: '现在，轮到你说。' },
    ],
    controls: ['拖动 环视', '输入 写字'],
    anatomy: {
      lead: '一百万个粒子，每一个都被一根看不见的弹簧拉向一个落点。落点来自字的笔画；路上推着它们的，是一个没有源也没有汇的流场。',
      equations: [
        { name: '阻尼弹簧', eq: 'a = −k·(x − x_target) − c·v' },
        { name: '流场', eq: 'v_flow = ∇ × ψ，所以 ∇·v_flow = 0' },
        { name: '积分', eq: 'v ← v + a·Δt，  x ← x + v·Δt' },
      ],
      notes: [
        '每个粒子出发的早晚由它落点的横坐标决定，所以字是从左往右"写"出来的。',
        '你输入的文字被画进一张看不见的画布，再按笔画采样成一百万个落点。',
        '画面上没有一个字是贴图。',
      ],
      live: function (ctx, s) {
        return [['粒子数', (s.N * s.N).toLocaleString()], ['当前文字', s.dir.text || '—'],
          ['平均到位误差', s.err == null ? '—' : s.err.toFixed(2) + ' px'], ['流场强度', s.flowNow.toFixed(2)]];
      },
    },
    input: { placeholder: '写下一句话，按回车', maxLength: 24, at: 64 },
    post: function () { return { exposure: 1.0, bloom: 0.55, bloomRadius: 0.75, vignette: 0.4, grain: 0.03 }; },

    onInput: function (ctx, s, text) {
      const t = sanitize(text);
      if (!t) return;
      s.pending = t;
      ctx.cue('typed');   // 配乐在观众每次落笔时轻轻琶音一次
    },

    init: function (ctx) {
      const G = ctx.G, N = ctx.quality >= 2 ? 1024 : ctx.quality === 1 ? 512 : 256;
      const P = {
        step: G.fsProgram('logos/step', STEP_FS),
        init: G.fsProgram('logos/init', INIT_FS),
        draw: G.program('logos/draw', DRAW_VS, DRAW_FS),
        sky: G.fsProgram('logos/sky', SKY_FS),
      };
      return {
        N: N, P: P, sim: makeSim(G, N), dir: newDir(),
        cam: new T.OrbitCamera({ az: 0, el: 0, dist: CAM_DIST, fov: FOV, minDist: 5, maxDist: 20, minEl: -0.6, maxEl: 0.6, returnAfter: 6 }),
        steps: 0, simT: 0, acc: 0, ev: 0, pending: null, queued: null, user: false, err: null, flowNow: 0,
      };
    },

    enter: function (ctx, s) {
      s.dir = newDir(); s.steps = 0; s.simT = 0; s.acc = 0; s.ev = 0;
      s.pending = null; s.queued = null; s.user = false; s.err = null;
      resetSim(ctx.G, s.P, s.sim, simUniforms(s.dir, 0, ctx.aspect, s.N, ctx.seed, 1));
      s.cam.resetUser();
    },

    update: function (ctx, s) {
      s.acc = Math.min(s.acc + ctx.dt, DT * MAX_SUB);
      while (s.acc >= DT - 1e-7) {
        director(ctx, s);
        const U = simUniforms(s.dir, s.simT, ctx.aspect, s.N, ctx.seed, 1);
        s.flowNow = M.lerp(U.uFlow, U.uFlowText, s.dir.write <= s.simT && s.dir.release > s.simT ? 1 : 0);
        stepSim(ctx.G, s.P, s.sim, U);
        s.steps++; s.simT = s.steps * DT; s.acc -= DT;
      }
      // 横竖屏切换：重新排版当前文字（每行字数不同）
      const portrait = ctx.aspect < 1;
      if (s.dir.text && s.dir.portrait !== portrait && s.dir.release > s.simT) {
        const keep = { w: s.dir.write, b: s.dir.breathOut };
        setText(s.sim, s.dir, s.dir.text, keep.w, s.dir.col, ctx.seed, portrait);
        s.dir.breathOut = keep.b;
      }
      // 到位误差：抽 32×32 个粒子读回（不在快进时做）
      if (!ctx.seeking && s.steps % 30 === 0 && s.sim.tgtData) {
        const n = Math.min(32, s.N), f = ctx.G.readFloat(s.sim.st.read, 0, 0, n, n, 0);
        const sc = textScale(s.dir, ctx.aspect), ppw = ctx.height / VIEW_H;
        let sum = 0, cnt = 0;
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
          const i = (y * n + x) * 4, j = (y * s.N + x) * 4;
          if (f[i + 3] < 0.98) continue;
          const dx = f[i] - s.sim.tgtData[j] * sc, dy = f[i + 1] - (0.05 * VIEW_H + s.sim.tgtData[j + 1] * sc);
          sum += Math.sqrt(dx * dx + dy * dy) * ppw; cnt++;
        }
        s.err = cnt > 20 ? sum / cnt : null;
      }
    },

    render: function (ctx, s) {
      const G = ctx.G, t = ctx.time, rm = ctx.reducedMotion ? 0.5 : 1;
      s.cam.script({ az: 0.07 * Math.sin(t * 0.045 * rm), el: 0.035 * Math.sin(t * 0.06 * rm + 1.0) }).update(ctx);
      s.P.sky.use().set(s.cam.rayUniforms(ctx));
      G.fullscreen();
      G.blend('add');
      const U = simUniforms(s.dir, s.simT, ctx.aspect, s.N, ctx.seed, 1);
      const NN = s.N * s.N, area = ctx.width * ctx.height, ppw = ctx.height / VIEW_H;
      const sc = U.uText[0];
      const eText = 1.45 * s.dir.cov * sq(sc * ppw) / Math.max(1, NN * 0.9);
      G.blend('add');
      s.P.draw.use().set(Object.assign(U, {
        uPos: s.sim.st.read.texs[0], uVel: s.sim.st.read.texs[1], uViewProj: s.cam.viewProj(ctx.aspect, 0.1, 100), uPx: ctx.px,
        uEFree: 0.014 * area / NN, uEText: eText, uEBokeh: 0.3 * area / NN, uFocus: s.cam.curDist,
        uSizeQ: s.N >= 1024 ? 1 : s.N >= 512 ? 1.35 : 1.8,
        uKeep: M.clamp(7 * s.dir.cov * sq(sc * ppw) / Math.max(1, NN * 0.9), 0.04, 1),
        uTC: [s.dir.col[0], s.dir.col[1]], uTint: s.dir.col.slice(2, 5),
      }));
      G.drawPoints(NN);
    },

    selfTest: function (ctx, s) {
      const G = ctx.G, out = [], seed = ctx.seed >>> 0;
      // 1) 落点都在笔画里：同一个 raster + sampleTargets
      const r = raster('言', false);
      const smp = sampleTargets(r, 65536, seed ^ hashStr('言'));
      const cx = smp.cx, cy = smp.cy;
      let inside = 0;
      for (let k = 0; k < 65536; k++) {
        const x = Math.floor(smp.tgt[k * 4] + cx), y = Math.floor(cy - smp.tgt[k * 4 + 1]);
        if (x >= 0 && x < CW && y >= 0 && y < CH && r.data[(y * CW + x) * 4 + 3] > 127) inside++;
      }
      const fin = inside / 65536;
      out.push({ name: '「言」的落点落在 alpha > 0.5 的笔画像素里', expected: '≥ 99.5%', measured: (fin * 100).toFixed(2) + '%', pass: fin >= 0.995 });

      // 2) 会收敛：关掉流场，从散开状态积分 3 秒（同一个推进着色器）
      const S = 64, sim = makeSim(G, S), dir = newDir(), aspect = 16 / 9;
      resetSim(G, s.P, sim, simUniforms(dir, 0, aspect, S, seed, 0));
      setText(sim, dir, '言', 0, USER_COL, seed, false);
      dir.breathOut = 0;
      for (let i = 0; i < 180; i++) stepSim(G, s.P, sim, simUniforms(dir, i * DT, aspect, S, seed, 0));
      const f = G.readFloat(sim.st.read, 0, 0, S, S, 0), sc = textScale(dir, aspect), tol = 0.003 * VIEW_H;
      let ok = 0, cnt = 0;
      for (let i = 0; i < S * S; i++) {
        if (f[i * 4 + 3] < 0.5) continue;   // 景深光斑粒子不写字（依附权重恒为 0）
        const dx = f[i * 4] - sim.tgtData[i * 4] * sc, dy = f[i * 4 + 1] - (0.05 * VIEW_H + sim.tgtData[i * 4 + 1] * sc);
        cnt++; if (Math.sqrt(dx * dx + dy * dy) < tol) ok++;
      }
      const conv = ok / Math.max(1, cnt);
      out.push({ name: '无流场积分 3 秒后到位（误差 < 0.3% 屏高）', expected: '≥ 95%', measured: (conv * 100).toFixed(1) + '%（' + cnt + ' 粒子）', pass: conv >= 0.95 });

      // 3) 怪输入：onInput → 剧本推进 → 推进 30 步，16×16 状态无 NaN
      const small = { N: 16, P: s.P, sim: makeSim(G, 16), dir: newDir(), steps: 0, simT: 0, acc: 0, ev: SCRIPT.length, pending: null, queued: null, user: false };
      resetSim(G, s.P, small.sim, simUniforms(small.dir, 0, aspect, 16, seed, 1));
      const fake = { seed: seed, aspect: aspect, cue: function () {} };
      const inputs = ['', '   ', '😀🎉👍🏽👨‍👩‍👧', '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈'];
      let thrown = '', finite = true;
      inputs.forEach(function (txt) {
        try {
          const raw = sanitize(txt); if (raw) small.pending = raw;
          for (let i = 0; i < 150; i++) {
            director(fake, small);
            stepSim(G, s.P, small.sim, simUniforms(small.dir, small.simT, aspect, 16, seed, 1));
            small.steps++; small.simT = small.steps * DT;
          }
          const a = G.readFloat(small.sim.st.read, 0, 0, 16, 16, 0);
          for (let i = 0; i < a.length; i++) if (!isFinite(a[i])) finite = false;
        } catch (e) { thrown += String(e && e.message || e) + ' '; }
      });
      out.push({ name: '空串 / 空格 / emoji / 48 字长句', expected: '不抛错、无 NaN', measured: (thrown ? '抛错：' + thrown : '无抛错') + '，' + (finite ? '状态有限' : '出现 NaN') + '，末句「' + small.dir.text.slice(0, 6) + '…」',
        pass: !thrown && finite && small.dir.text.length === 48 });

      // 4) 流场无散：同一个 flowVel
      const t64 = G.target({ w: 32, h: 32, format: 'rgba32f', filter: 'nearest' });
      const pd = G.fsProgram('logos/st-div', PHYS + `
void main() {
  vec3 q = hash33(vec3(gl_FragCoord.xy, 11.0)) * vec3(14.0, 8.0, 6.0) - vec3(7.0, 4.0, 3.0);
  float e = 1e-2, t = 37.0;
  float dx = flowVel(q + vec3(e, 0, 0), t).x - flowVel(q - vec3(e, 0, 0), t).x;
  float dy = flowVel(q + vec3(0, e, 0), t).y - flowVel(q - vec3(0, e, 0), t).y;
  float dz = flowVel(q + vec3(0, 0, e), t).z - flowVel(q - vec3(0, 0, e), t).z;
  vec3 gx = flowVel(q + vec3(e, 0, 0), t) - flowVel(q - vec3(e, 0, 0), t);
  vec3 gy = flowVel(q + vec3(0, e, 0), t) - flowVel(q - vec3(0, e, 0), t);
  vec3 gz = flowVel(q + vec3(0, 0, e), t) - flowVel(q - vec3(0, 0, e), t);
  fragColor = vec4(abs(dx + dy + dz) / (2.0 * e), sqrt(dot(gx, gx) + dot(gy, gy) + dot(gz, gz)) / (2.0 * e), 0.0, 1.0);
}`);
      G.bind(t64); pd.use().set({ uSeed: seed, uN: 32 }); G.fullscreen();
      const b = G.readFloat(t64, 0, 0, 32, 32);
      let ds = 0, gs = 0;
      for (let i = 0; i < 1024; i++) { ds += b[i * 4]; gs += b[i * 4 + 1]; }
      const ratio = ds / Math.max(gs, 1e-9);
      out.push({ name: '流场数值散度 / 梯度幅值（1024 点）', expected: '< 0.02', measured: ratio.toExponential(2), pass: ratio < 0.02 });

      // 5) 确定性：同一 seed 推进两次
      const run = function () {
        const d2 = newDir();
        resetSim(G, s.P, sim, simUniforms(d2, 0, aspect, S, seed, 1));
        setText(sim, d2, '言', 0.5, USER_COL, seed, false);
        for (let i = 0; i < 120; i++) stepSim(G, s.P, sim, simUniforms(d2, i * DT, aspect, S, seed, 1));
        return checksum(G.readFloat(sim.st.read, 0, 0, S, S, 0));
      };
      const c1 = run(), c2 = run();
      out.push({ name: '同一 seed 推进 120 步两次的校验和', expected: c1, measured: c2, pass: c1 === c2 });

      disposeSim(G, sim); disposeSim(G, small.sim); G.dispose(t64); G.dispose(pd);
      return out;
    },
  });

  function sq(x) { return x * x; }
})();
