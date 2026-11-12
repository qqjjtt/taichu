/* 太初 TAICHU — 第一幕 · 奇点 singularity
   泽尔多维奇近似：x(q, t) = q + D(t)·ψ(q)，ψ = −∇Φ。每个质点的位置在顶点着色器里由 gl_VertexID 当场算出，
   没有任何模拟状态：任意跳转都确定、一致。白闪之前是一颗针尖般的光点；之后是辐射时期的等离子体外涌，
   复合后沉入暗红余烬，再由引力把均匀的尘埃编织成宇宙网，结点里点亮第一批恒星。 */
(function () {
  'use strict';
  const T = window.TAICHU;
  const M = T.M;

  const BANG = 13.5, DEC = 30, END = 84;
  const ZP1_DEC = 1101;                       // 1 + z 在复合时；2.725 K × 1101 ≈ 3000 K
  const LN_GROW = Math.log(ZP1_DEC / 16);     // 片尾 1 + z = 16（z = 15）
  const TAU0 = 16.5 * 0.01 / 0.99;            // 让 t = 13.5 时 a 恰为复合时的 1/10（T = 30000 K）
  const WORLD = 10;                           // 共动单位球（|q| < 1）在世界里的半径
  // 势场 Φ = Σ aᵢ·N(fᵢ·q)：5 个倍频，aᵢ ∝ fᵢ^−2.2；位移权重 a·f 随尺度下降，密度权重 a·f² 近乎平坦
  const ZF0 = 1.6, ZLAC = 2.0, ZGAIN = 0.218, ZOCT = 5;
  const ZPSI = 0.16;                          // 场的整体归一化
  const DMAX = 1.0, ZCLAMP = 0.6;             // 片尾的视觉增长量；壳层穿越软钳制强度

  const f1 = function (x) { const s = (+x).toFixed(6); return s.indexOf('.') < 0 ? s + '.0' : s; };

  // ── 正片与自检共用的那一份位移函数 ──
  const ZEL = `
#include <noised>
uniform vec3 uSeedOff;
// 与 gnoised 同一个场（同格点梯度、同五次插值），多算一个解析拉普拉斯：(∇N, ∇²N)。
// 梯度噪声不是严格带限的，"−∇²N ≈ κ²N" 只有 0.82 的相关；这里直接求和 Σ(∇²W·v + 2∇W·g)，是精确的
float zelNV, zelPhi, zelDL;   // 副产品：噪声值与势 Φ 本身（萨克斯–沃尔夫：等离子体的温度起伏 ΔT/T = −Φ/3）
vec4 zelNoiseGL(vec3 x) {
  ivec3 i = ivec3(floor(x)); vec3 f = fract(x);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0), du = 30.0 * f * f * (f * (f - 2.0) + 1.0), ddu = 60.0 * f * (f * (2.0 * f - 3.0) + 1.0);
  vec3 g = vec3(0.0); float L = 0.0; zelNV = 0.0;
  for (int k = 0; k < 8; k++) {
    ivec3 c = ivec3(k & 1, (k >> 1) & 1, k >> 2);
    vec3 s = vec3(c) * 2.0 - 1.0, w = mix(1.0 - u, u, vec3(c)), dw = s * du, ddw = s * ddu;
    vec3 gc = _ngrad(i + c);
    float v = dot(gc, f - vec3(c));
    vec3 dW = vec3(dw.x * w.y * w.z, w.x * dw.y * w.z, w.x * w.y * dw.z);
    g += dW * v + (w.x * w.y * w.z) * gc;
    zelNV += (w.x * w.y * w.z) * v;
    L += (ddw.x * w.y * w.z + w.x * ddw.y * w.z + w.x * w.y * ddw.z) * v + 2.0 * dot(dW, gc);
  }
  return 1.25 * vec4(g, L);
}
vec3 zelOct(int i) { return uSeedOff + float(i) * vec3(17.13, 31.71, 7.37); }
// (ψ, δ)：ψ = −∇Φ，δ = −∇·ψ = ∇²Φ（线性密度涨落，D = 1 时）
vec4 zelField(vec3 q) {
  vec4 s = vec4(0.0); float f = ${f1(ZF0)}, a = 1.0; zelPhi = 0.0; zelDL = 0.0;
  for (int i = 0; i < ${ZOCT}; i++) {
    vec4 n = zelNoiseGL(q * f + zelOct(i));
    s += vec4(-(a * f) * n.xyz, (a * f * f) * n.w);
    zelPhi += a * zelNV * ${f1(ZPSI)};
    if (i < 3) zelDL += (a * f * f) * n.w * ${f1(ZPSI)};
    f *= ${f1(ZLAC)}; a *= ${f1(ZGAIN)};
  }
  return s * ${f1(ZPSI)};
}
// 有效位移在第一次壳层穿越附近饱和：高密度处的质点不再穿过结点飞走，纤维保持锐利
vec3 zelMove(vec3 q, vec4 z, float D, out float dl) {
  dl = D * z.w;
  return q + z.xyz * (D / (1.0 + ${f1(ZCLAMP)} * max(dl, 0.0)));
}
vec3 zelPos(vec3 q, float D, out float dl) { return zelMove(q, zelField(q), D, dl); }
// 恒星在小尺度峰里形成，但大尺度环境越密越多（峰–背景分离的偏袒）：最富的结点星最多
float zelStarScore(vec4 z) { return z.w + 1.5 * zelDL; }
`;

  const PART_VS = `
#include <hash>
#include <blackbody>
${ZEL}
uniform mat4 uViewProj;
uniform int uN;
uniform uint uSeedU;
uniform float uScale, uD, uPx, uFocus, uCoc, uBright, uTp, uWeb, uStar, uTime, uThr, uTop, uEmis, uSW;
uniform float uStreak, uStreakK, uScaleP;   // 外涌光迹：强度（0 关）、亮度倍数、"快门"开启时的尺度
uniform vec2 uRes;
out vec3 vCol;
out vec3 vSeg;      // 光迹：半段向量（像素，y 向上）与高斯半宽；vSz < 0 表示普通圆点
out float vSz;
void cull() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 1.0; vCol = vec3(0.0); vSeg = vec3(0.0); vSz = -1.0; }
void main() {
  uint id = uint(gl_VertexID);
  bool star = uStar > 0.5;
  if (star) id = id * 8u + (pcg(id ^ 0x5A17C3u) & 7u);
  uint N = uint(uN);
  uvec3 c = uvec3(id % N, (id / N) % N, id / (N * N));
  float cell = 2.0 / float(N);
  vec3 cc = (vec3(c) + 0.5) * cell - 1.0;
  float r2 = dot(cc, cc);
  if (r2 >= 1.0) { cull(); return; }            // 只保留单位球内的格点：从任何方向看都没有立方体的棱
  vec4 h = hash4u(uvec4(c, uSeedU));
  vec3 q = cc + (h.xyz - 0.5) * cell;           // 整格抖动：D = 0 时看不出晶格
  vec4 z = zelField(q);
  float dl;
  vec3 x = zelMove(q, z, uD, dl);
  float amp = 1.0;
  if (star) {
    float sc = zelStarScore(z);
    if (sc < uThr) { cull(); return; }
    // 越密的结点越早点亮；之后缓慢、轻微地闪烁（单颗星很小，不构成大面积闪烁）
    float u = saturate((sc - uThr) / max(uTop - uThr, 1e-4));
    float ti = 52.0 + 27.0 * (1.0 - u) * (0.4 + 0.6 * h.w) + 0.8 * h.w;
    float age = uTime - ti;
    if (age <= 0.0) { cull(); return; }
    amp = smoothstep(0.0, 1.2, age) * (0.8 + 0.2 * sin(uTime * (0.9 + 2.2 * h.w) + h.w * 40.0));
  }
  gl_Position = uViewProj * vec4(x * uScale, 1.0);
  float d = gl_Position.w;
  if (d < 0.02) { cull(); return; }
  // 景深：弥散圆 ∝ |1 − 焦距/距离|，与点径正交相加；按面积降亮度，总能量不变
  float base = (star ? 1.6 : 1.1) * uPx;
  float coc = uCoc * uPx * abs(1.0 - uFocus / d);
  float want = sqrt(base * base + coc * coc);
  float sz = clamp(want, 1.5, max(1.5, 36.0 * uPx));
  gl_PointSize = sz;
  float fade = smoothstep(0.12, 0.7, d) * (1.0 - smoothstep(0.82, 1.0, sqrt(r2)));
  float gain = sq(base / sz) * fade;
  vSeg = vec3(0.0); vSz = -1.0;
  if (!star && uStreak > 0.0 && h.w > 0.993) {
    // 最亮的一小撮质点画成短促的径向光迹：从"快门"开启时的位置到现在的位置（同一条膨胀律，速度随时间减慢）
    vec4 p0 = uViewProj * vec4(x * uScaleP, 1.0);
    if (p0.w < 0.02) { cull(); return; }
    vec2 s1 = gl_Position.xy / d * 0.5 * uRes, dv = (s1 - p0.xy / p0.w * 0.5 * uRes) * uStreak;
    float L = length(dv), Lm = 110.0 * uPx;
    if (L > Lm) { dv *= Lm / L; L = Lm; }
    float w = max(0.9, uPx);
    float ps = L + 5.0 * w;
    gl_Position.xy = (s1 - 0.5 * dv) / (0.5 * uRes) * d;
    gl_PointSize = ps;
    vSeg = vec3(0.5 * dv, w); vSz = ps;
    gain = fade * mix(1.0, uStreakK, uStreak);
  }
  vec3 col;
  if (star) col = blackbody(mix(7000.0, 16000.0, h.y)) * amp;
  else {
    // 坍缩加热：气体温度随线性密度升高；发光按温度的幂次（空洞冷而暗，结点热而白）
    float Tw = mix(1700.0, 6500.0, smoothstep(-0.5, 8.0, dl + 1.0 * (h.w - 0.5)));
    float Tp = uTp * (1.0 - uSW * zelPhi / 3.0);
    float T = mix(Tp, Tw, uWeb);
    col = blackbody(T) * mix(pow(Tp / uTp, 4.0), pow(T / 4000.0, uEmis), uWeb);
  }
  vCol = col * (uBright * gain);
}`;
  const PART_FS = `
in vec3 vCol;
in vec3 vSeg;
in float vSz;
void main() {
  if (vSz > 0.0) {   // 光迹：到线段的距离做高斯截面，头亮尾暗
    vec2 p = (gl_PointCoord - 0.5) * vSz; p.y = -p.y;
    vec2 ab = 2.0 * vSeg.xy, pa = p + vSeg.xy;
    float hh = clamp(dot(pa, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
    vec2 e = pa - ab * hh;
    float k = exp(-dot(e, e) / (vSeg.z * vSeg.z)) * (0.12 + 0.88 * hh * hh);
    if (k < 1e-3) discard;
    fragColor = vec4(vCol * k, 1.0); return;
  }
  vec2 p = gl_PointCoord * 2.0 - 1.0; float r2 = dot(p, p); if (r2 > 1.0) discard; fragColor = vec4(vCol * exp(-r2 * 3.5), 1.0);
}`;

  // 全屏一层：开场的针尖光点与失稳的闪烁、白闪、等离子体的均匀辉光（不透明的宇宙）
  const VEIL_FS = `
#include <ray>
#include <common>
#include <hash>
#include <blackbody>
#include <noised>
uniform vec3 uSeedOff;
uniform float uGlowA, uGlowT, uGlowK, uGlowS, uDrift;
uniform float uFlash, uCore, uCoreR, uSpark, uSparkT;
uniform vec2 uJit;
void main() {
  vec3 col = vec3(uFlash);
  if (uGlowA > 0.0) {
    // 我们在火球里面，没有"外面"：空间处处炽热，每条视线都止于身边最后一次散射的等离子体，四面八方一样亮。
    // 温度只带极小的多尺度起伏（真实约 1e-5，这里放大到约 2% 才看得见），细密、缓慢演化；纹理随膨胀慢慢变大
    vec3 rd = normalize(cameraRay(vUv)), p = rd * uGlowS + uSeedOff * 0.37;
    float n = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) {
      n += a * gnoised(p + uDrift * (1.0 + 0.6 * float(i)) * vec3(0.31, -0.23, 0.53)).x;
      p = p * 2.07 + vec3(17.13, 31.71, 7.37); a *= 0.62;
    }
    float Tl = uGlowT * (1.0 + uGlowK * n);
    // 外涌的来处（中心方向）更亮、烧到发白；四周同色、略暗但仍在发光——给白炽一个"白点"参照，不是黑底上的球
    float th = acos(clamp(dot(rd, normalize(-uCamPos)), -1.0, 1.0));
    float src = 0.72 + 1.15 * exp(-th * th / 0.24);
    col += blackbody(Tl) * (uGlowA * src * sq(sq(Tl / uGlowT)));
  }
  if (uCore > 0.0) {
    vec3 rd = cameraRay(vUv), c = normalize(-uCamPos);
    vec3 d = rd / max(dot(rd, c), 1e-3) - c;
    vec2 p = vec2(dot(d, uCamRight), dot(d, uCamUp)) / uPixAngle;   // 以像素计的角偏移
    float px = 1.0 / (uPixAngle * 1100.0);                           // 约等于 ctx.px
    vec2 pc = p - uJit * px;
    float r2 = dot(pc, pc), R = uCoreR * px;
    col += vec3(1.0, 0.96, 0.9) * uCore * (exp(-r2 / (2.0 * R * R)) + 0.012 * exp(-sqrt(r2) / (9.0 * px)));
    if (uSpark > 0.0) {
      float rmax = mix(150.0, 10.0, pow(uSpark, 0.7)) * px;
      if (r2 < sq(rmax + 6.0 * px)) {
        float n = floor(6.0 + 34.0 * uSpark);
        for (int i = 0; i < 40; i++) {
          if (float(i) >= n) break;
          float ph = hash11(float(i) * 7.31 + 0.5), sl = floor(uSparkT * 7.0 + ph * 7.0);
          vec4 hh = hash4u(uvec4(uint(i), uint(sl + 1000.0), 0x51A2u, 7u));
          float fr = fract(uSparkT * 7.0 + ph * 7.0);
          float ang = TAU * hh.x, rad = rmax * (0.08 + 0.92 * hh.y * hh.y) * (1.0 - 0.35 * fr);
          vec2 sp = vec2(cos(ang), sin(ang)) * rad;
          float e = sin(PI * fr) * (0.3 + 0.7 * hh.z) * (2.0 + 10.0 * uSpark * uSpark);
          col += vec3(1.0, 0.9, 0.8) * e * exp(-dot(p - sp, p - sp) / (1.2 * px * px));
        }
      }
    }
  }
  fragColor = vec4(col, 1.0);
}`;

  // 在网格上求最终位置与密度代理：找最亮的结点、定恒星点亮的阈值（与正片同一份 zelPos）
  const PROBE_FS = `
${ZEL}
uniform float uDend;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int i = p.y * 512 + p.x;
  vec3 q = (vec3(i % 64, (i / 64) % 64, i / 4096) + 0.5) * (2.0 / 64.0) - 1.0;
  if (dot(q, q) >= 1.0) { fragColor = vec4(q, -1e9); return; }
  float dl; vec4 z = zelField(q);
  fragColor = vec4(zelMove(q, z, uDend, dl), zelStarScore(z));
}`;

  const TEST_FS = `
#include <hash>
${ZEL}
uniform int uMode;
void main() {
  vec3 q = (hash33(vec3(gl_FragCoord.xy, 3.7)) * 2.0 - 1.0) * 0.8;
  float dl;
  if (uMode == 0) { vec3 x = zelPos(q, 0.0, dl); fragColor = vec4(x - q, length(x - q)); return; }
  vec4 z = zelField(q);
  if (uMode == 2) { fragColor = z; return; }
  if (uMode == 3) {   // 与共享片段 gnoised 的解析梯度逐点比较：确认是同一个场
    vec3 p = q * 13.7 + zelOct(2);
    fragColor = vec4(length(zelNoiseGL(p).xyz - gnoised(p).yzw), length(gnoised(p).yzw), 0.0, 0.0); return;
  }
  float e = 1.5e-3;
  vec3 jx = (zelField(q + vec3(e, 0, 0)).xyz - zelField(q - vec3(e, 0, 0)).xyz) / (2.0 * e);
  vec3 jy = (zelField(q + vec3(0, e, 0)).xyz - zelField(q - vec3(0, e, 0)).xyz) / (2.0 * e);
  vec3 jz = (zelField(q + vec3(0, 0, e)).xyz - zelField(q - vec3(0, 0, e)).xyz) / (2.0 * e);
  vec3 cu = vec3(jy.z - jz.y, jz.x - jx.z, jx.y - jy.x);
  fragColor = vec4(length(cu), sqrt(dot(jx, jx) + dot(jy, jy) + dot(jz, jz)), -(jx.x + jy.y + jz.z), z.w);
}`;

  // ── 宇宙学时钟：live 面板、着色器与自检共用 ──
  function cosmo(t) {
    if (t < BANG) return { zp1: Infinity, D: 1, s: 0 };
    const u = M.saturate((t - BANG) / (DEC - BANG)), s = 1 - sq(1 - Math.sqrt(u));
    if (t < DEC) return { zp1: ZP1_DEC / Math.sqrt((t - BANG + TAU0) / (DEC - BANG + TAU0)), D: 1, s: s };   // 辐射时期 a ∝ t^½
    const x = Math.min((t - DEC) / (END - DEC), 1), r = Math.exp(LN_GROW * (1 - sq(1 - x)));             // 物质时期 D ∝ a
    return { zp1: ZP1_DEC / r, D: r, s: 1 };
  }
  function sq(x) { return x * x; }
  const DEND = ZP1_DEC / 16;
  function visD(t) { return DMAX * cosmo(t).D / DEND; }

  // 关键帧插值（lg：在对数里线性插值）
  function keyed(k, t, lg) {
    if (t <= k[0][0]) return k[0][1];
    for (let i = 1; i < k.length; i++) {
      if (t > k[i][0]) continue;
      const u = (t - k[i - 1][0]) / (k[i][0] - k[i - 1][0]);
      return lg ? Math.exp(M.lerp(Math.log(k[i - 1][1]), Math.log(k[i][1]), u)) : M.lerp(k[i - 1][1], k[i][1], u);
    }
    return k[k.length - 1][1];
  }
  // 画面的色温（只决定颜色；live 面板的 z(t) 另算、不动）：白闪后蓝白，一路冷到复合时恰为 3000 K，之后随红移下降
  const TVIS = [[BANG, 40000], [14, 30000], [18, 9000], [22, 6000], [26, 4200], [DEC, 3000]];
  function Tvis(t) { return t < BANG ? 30000 : t < DEC ? keyed(TVIS, t, true) : 2.725 * cosmo(t).zp1; }
  // 不透明等离子体的辉光强度（场景线性值）：白炽 → 炉膛般的橙；复合后宇宙变透明，辉光散去
  // 终审调整：中段原来只有 0.3–0.5，整屏落在中灰，读作"灰雾 / 褐色"而不是白炽；抬到接近高光，橙色才像炉膛而不像铁锈
  const GLOWK = [[BANG, 0], [BANG + 0.8, 1.1], [16, 1.1], [20, 0.82], [24, 0.68], [29, 0.6], [DEC, 0.56]];
  function glowA(t) { return t < BANG ? 0 : t < DEC ? keyed(GLOWK, t, false) : keyed(GLOWK, DEC, false) * (1 - M.smoothstep(DEC, 37, t)); }
  const SHUTTER = 0.3;                      // 质点光迹的"快门"（秒）：外涌越快，光迹越长

  function seedOff(seed) {
    const r = M.mulberry32(((seed >>> 0) ^ 0x51C6) >>> 0);
    return [r() * 300 - 150, r() * 300 - 150, r() * 300 - 150];
  }

  function probe(ctx, s) {
    const G = ctx.G, t = G.target({ w: 512, h: 512, format: 'rgba32f', filter: 'nearest' });
    G.bind(t); s.probe.use().set({ uSeedOff: s.off, uDend: DMAX }); G.fullscreen();
    const f = G.readFloat(t, 0, 0, 512, 512);
    G.dispose(t);
    const ws = [];
    // 只在云团内部找结点：拉格朗日半径 > 0.82 的质点会被边缘淡出，那里的"结点"在画面上是看不见的
    const inner = function (i) { const a = ((i % 64) + 0.5) / 32 - 1, b = (((i / 64) | 0) % 64 + 0.5) / 32 - 1, c = (((i / 4096) | 0) + 0.5) / 32 - 1; return a * a + b * b + c * c < 0.72 * 0.72; };
    const B = 18, L = 0.55, hist = new Float32Array(B * B * B);
    for (let i = 0; i < 262144; i++) {
      const w = f[i * 4 + 3];
      if (w < -1e8) continue;
      ws.push(w);
      const x = f[i * 4], y = f[i * 4 + 1], z = f[i * 4 + 2];
      if (Math.abs(x) >= L || Math.abs(y) >= L || Math.abs(z) >= L || !inner(i)) continue;
      hist[(((x + L) / (2 * L) * B) | 0) + B * ((((y + L) / (2 * L) * B) | 0) + B * (((z + L) / (2 * L) * B) | 0))]++;
    }
    ws.sort(function (a, b) { return a - b; });
    s.thr = ws[Math.floor(ws.length * 0.992)]; s.top = ws[Math.floor(ws.length * 0.9995)];
    let bi = 0;
    for (let i = 1; i < hist.length; i++) if (hist[i] > hist[bi]) bi = i;
    const cx = bi % B, cy = ((bi / B) | 0) % B, cz = (bi / (B * B)) | 0, e = [0, 0, 0], q = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < 262144; i++) {
      if (f[i * 4 + 3] < -1e8 || !inner(i)) continue;
      const x = f[i * 4], y = f[i * 4 + 1], z = f[i * 4 + 2];
      if ((((x + L) / (2 * L) * B) | 0) !== cx || (((y + L) / (2 * L) * B) | 0) !== cy || (((z + L) / (2 * L) * B) | 0) !== cz) continue;
      e[0] += x; e[1] += y; e[2] += z;
      q[0] += ((i % 64) + 0.5) / 32 - 1; q[1] += (((i / 64) | 0) % 64 + 0.5) / 32 - 1; q[2] += (((i / 4096) | 0) + 0.5) / 32 - 1;
      n++;
    }
    s.nodeX = M.scale(e, 1 / n); s.nodeQ = M.scale(q, 1 / n); s.nodeN = n;
    // 均值漂移细化：粗格子的均值落在格子中部，不一定是结点本身；逐步缩小半径，收敛到最密的那一团（片尾推镜的靶心）
    for (const r of [0.05, 0.035, 0.025, 0.018, 0.018]) {
      const c0 = s.nodeX, ex = [0, 0, 0], eq = [0, 0, 0];
      let m = 0;
      for (let i = 0; i < 262144; i++) {
        if (f[i * 4 + 3] < -1e8 || !inner(i)) continue;
        const dx = f[i * 4] - c0[0], dy = f[i * 4 + 1] - c0[1], dz = f[i * 4 + 2] - c0[2];
        if (dx * dx + dy * dy + dz * dz > r * r) continue;
        ex[0] += f[i * 4]; ex[1] += f[i * 4 + 1]; ex[2] += f[i * 4 + 2];
        eq[0] += ((i % 64) + 0.5) / 32 - 1; eq[1] += (((i / 64) | 0) % 64 + 0.5) / 32 - 1; eq[2] += (((i / 4096) | 0) + 0.5) / 32 - 1;
        m++;
      }
      if (m < 8) break;
      s.nodeX = M.scale(ex, 1 / m); s.nodeQ = M.scale(eq, 1 / m); s.nodeN = m;
    }
  }

  // 导演机位（纯时间函数，跳转一致）
  function camPose(t, s, rm) {
    const k = rm ? 0.5 : 1;
    let az = 0.5 + 0.011 * k * t, el = 0.24 - 0.0012 * k * t, dist = 6.5, target = [0, 0, 0];
    if (t < BANG) dist = 16;
    // 白闪之中镜头已落进火球内部（离中心比云团半径近）：质点从画面中央涌出、掠过镜头；之后缓缓退到复合时的 6.2
    else if (t < DEC) dist = M.lerp(M.lerp(16, 3.6, M.smootherstep(BANG, BANG + 1.2, t)), 6.2, M.smootherstep(BANG + 1.2, DEC, t));
    else dist = M.lerp(6.2, 7.2, M.smootherstep(DEC, 70, t));
    if (t > BANG && t < BANG + 2.5) {   // 大爆炸：唯一的一次镜头抖动，迅速衰减
      const a = 0.012 * k * Math.exp(-(t - BANG) * 2.2);
      az += a * Math.sin(t * 37.0); el += a * Math.sin(t * 29.0 + 1.3);
    }
    const p = M.smootherstep(68, END, t);
    if (p > 0) {
      // 结点的位置随 D 线性移动：在拉格朗日位置与最终位置之间按增长量插值
      // target 先对准最密结点（结点落到画面正中），再一路推近，让它逐渐占据画面
      const g = visD(t) / DMAX, nx = M.mix3(s.nodeQ, s.nodeX, g);
      target = M.scale(nx, WORLD * M.smootherstep(68, 77, t));
      dist = M.lerp(dist, 2.6, p);
      el = M.lerp(el, 0.12, p);
    }
    return { az: az, el: el, dist: dist, target: target, fov: 52 };
  }

  T.registerChapter({
    id: 'singularity', order: 1,
    title: '奇点', latin: 'SINGULARITY', epoch: '138 亿年前', lookback: 13.8, duration: 84,
    fadeIn: 'black',
    captions: [
      { t: 2.0, d: 4.0, text: '一百三十八亿年前。' },
      { t: 7.0, d: 5.0, text: '没有空间，没有时间，也没有“之前”。' },
      { t: 16.5, d: 5.5, text: '然后有了一切。' },
      { t: 23.0, d: 6.0, text: '最初的几分钟，宇宙造出了几乎全部的氢和氦。' },
      { t: 31.0, d: 6.5, text: '三十八万年后，光第一次可以自由穿行。' },
      { t: 42.0, d: 6.0, text: '接着是漫长的黑暗。只有引力在工作。' },
      { t: 53.0, d: 6.0, text: '物质沿着看不见的骨架聚拢，第一批恒星点亮。' },
      { t: 72.0, d: 7.0, text: '这张网的每一个结点，都是上千个星系。' },
    ],
    controls: ['拖动 环绕', '滚轮 远近'],
    anatomy: {
      lead: '两百万个质点，没有一个被保存。每一帧，每个质点的位置都由同一条公式当场算出：初始位置，加上一个随时间增长的位移。',
      equations: [
        { name: '泽尔多维奇近似', eq: 'x(q, t) = q − D(t)·∇Φ(q)' },
        { name: '密度', eq: 'ρ/ρ̄ = 1 / det(I − D·∂²Φ/∂qᵢ∂qⱼ)' },
        { name: '辐射时期', eq: 'a ∝ t^(1/2)，T ∝ 1/a' },
        { name: '物质时期', eq: 'a ∝ t^(2/3)，D ∝ a' },
      ],
      notes: [
        'Φ 是一个高斯随机场：早期宇宙里十万分之一的密度起伏。',
        '位移是势的梯度，所以没有旋度——物质只会沿着“下坡”聚拢。自检会验证这一点。',
        '画面变成橙色的那一刻约 3000 K：光与物质脱耦时的真实温度。那片光今天还在，已经冷到 2.725 K，叫宇宙微波背景。',
      ],
      live: function (ctx, s) {
        const c = cosmo(ctx.time);
        const fin = isFinite(c.zp1);
        return [['质点数', s.count.toLocaleString()],
          ['红移 z', fin ? (c.zp1 - 1 >= 100 ? Math.round(c.zp1 - 1).toLocaleString() : (c.zp1 - 1).toFixed(1)) : '∞'],
          ['背景温度', fin ? Math.round(2.725 * c.zp1).toLocaleString() + ' K' : '—'],
          ['增长因子 D', fin ? c.D.toFixed(2) : '—']];
      },
    },
    post: function (ctx, s) {
      // 颜色只由黑体温度决定：不提饱和度。等离子体时期整屏发光，暗角压到 0.1，四角不发黑
      const pl = M.smoothstep(BANG, BANG + 1, ctx.time) * (1 - M.smoothstep(DEC + 2, 40, ctx.time));
      return { bloom: 0.6, bloomRadius: 0.75, exposure: 1, vignette: M.lerp(0.35, 0.1, pl), grain: 0.03, saturation: 1 };
    },

    init: function (ctx) {
      const G = ctx.G;
      const N = ctx.quality >= 2 ? 160 : ctx.quality === 1 ? 100 : 64;
      let count = 0;   // 格心落在单位球内的格点数（与着色器的剔除规则逐一对应）
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const ci = (i + 0.5) * 2 / N - 1, cj = (j + 0.5) * 2 / N - 1;
          for (let k = 0; k < N; k++) { const ck = (k + 0.5) * 2 / N - 1; if (ci * ci + cj * cj + ck * ck < 1) count++; }
        }
      }
      const s = {
        N: N, count: count,
        parts: G.program('singularity/particles', PART_VS, PART_FS),
        veil: G.fsProgram('singularity/veil', VEIL_FS),
        probe: G.fsProgram('singularity/probe', PROBE_FS),
        cam: new T.OrbitCamera({ az: 0.5, el: 0.24, dist: 7.5, fov: 52, minDist: 0.6, maxDist: 24, returnAfter: 7 }),
        off: seedOff(ctx.seed), cues: {}, thr: 1, top: 2, nodeX: [0, 0, 0], nodeQ: [0, 0, 0], nodeN: 0,
      };
      probe(ctx, s);
      return s;
    },

    enter: function (ctx, s) { s.cues = {}; s.cam.resetUser(); },

    update: function (ctx, s) {
      const t = ctx.time;
      if (t >= BANG && !s.cues.bang) { s.cues.bang = true; ctx.cue('bang'); }
      if (t >= DEC && !s.cues.dark) { s.cues.dark = true; ctx.cue('dark'); }
      if (t >= 52 && !s.cues.firstlight) { s.cues.firstlight = true; ctx.cue('firstlight'); }
    },

    render: function (ctx, s) {
      const G = ctx.G, t = ctx.time, rm = ctx.reducedMotion;
      s.cam.script(camPose(t, s, rm)).update(ctx);
      const c = cosmo(t), Tk = isFinite(c.zp1) ? 2.725 * c.zp1 : 30000, Tv = Tvis(t);

      // 1) 质点
      if (t >= BANG) {
        const web = M.smoothstep(37, 47, t);
        // 等离子体的亮度随冷却下降；复合后红移变暗，沉入余烬；宇宙网阶段每个质点亮度恒定
        const plasma = M.lerp(0.5, 0.35, M.smoothstep(BANG, DEC, t)) * Math.pow(Math.min(Tk / 3000, 1), 1.5) * (1 - 0.6 * M.smoothstep(DEC, 40, t));
        const bright = M.lerp(plasma, 0.6 * (1 + 2.5 * sq(1 - visD(t) / DMAX)), web);   // 早期结构太淡：像眼睛适应黑暗那样补偿
        G.blend('add');
        s.parts.use().set({
          uViewProj: s.cam.viewProj(ctx.aspect, 0.02, 120), uN: s.N, uSeedU: ((ctx.seed >>> 0) ^ 0x9E37) >>> 0, uSeedOff: s.off,
          uScale: WORLD * c.s, uD: visD(t), uPx: ctx.px, uFocus: s.cam.curDist, uCoc: 5.0 + 4.0 * M.smootherstep(68, END, t), uBright: bright,
          uTp: Math.max(Tv, 1000), uWeb: web, uStar: 0, uTime: t, uThr: s.thr, uTop: s.top, uEmis: 3.0,
          // 等离子体时期质点的温度起伏同样只有一点点（否则整团斑驳）；复合后恢复原来的萨克斯–沃尔夫强度
          uSW: M.lerp(0.4, 4.0, M.smoothstep(DEC, 37, t)),
          uStreak: 1 - M.smoothstep(20, DEC, t), uStreakK: 18.0, uScaleP: WORLD * cosmo(t - SHUTTER).s, uRes: [ctx.width, ctx.height],
        });
        G.drawPoints(s.N * s.N * s.N);
        if (t >= 52) {
          s.parts.set({ uStar: 1, uBright: 30, uStreak: 0 });
          G.drawPoints(Math.floor(s.N * s.N * s.N / 8));
        }
      }

      // 2) 针尖光点、闪烁、白闪、不透明辉光
      const pre = t < BANG;
      const spark = M.saturate((t - 6) / (BANG - 6));
      const breathe = 1 + 0.22 * Math.sin(ctx.wall * 1.35);
      const core = pre ? 24 * breathe * (1 + 5 * spark * spark) : 0;
      const jit = pre ? [spark * spark * 1.4 * Math.sin(t * 23.1) , spark * spark * 1.4 * Math.sin(t * 19.7 + 2.0)] : [0, 0];
      const fa = rm ? 0.5 : 1;
      const flash = t < BANG ? 0 : fa * 7 * M.smoothstep(BANG, BANG + 0.35, t) * sq(1 - M.smoothstep(BANG + 0.35, BANG + 2.85, t));
      const gl = glowA(t);
      if (!(gl > 0 || flash > 0 || core > 0)) return;   // 宇宙网阶段这一层全为零：省掉一次全屏
      G.blend('add');
      s.veil.use().set(Object.assign({ uGlowA: gl, uGlowT: Math.max(Tv, 1000), uGlowK: 0.022, uGlowS: 7.0 / (1 + 0.03 * Math.max(t - BANG, 0)), uDrift: 0.06 * t, uSeedOff: s.off, uFlash: flash, uCore: core, uCoreR: 0.8, uSpark: pre ? spark : 0, uSparkT: t, uJit: jit }, s.cam.rayUniforms(ctx)));
      G.fullscreen();
    },

    selfTest: function (ctx, s) {
      const G = ctx.G, out = [];
      const tp = G.fsProgram('singularity/test', TEST_FS);
      const tg = G.target({ w: 16, h: 16, format: 'rgba32f', filter: 'nearest' });
      const run = function (mode) { G.bind(tg); tp.use().set({ uMode: mode, uSeedOff: s.off }); G.fullscreen(); return G.readFloat(tg, 0, 0, 16, 16); };

      const a = run(0);
      let mx = 0;
      for (let i = 0; i < 256; i++) mx = Math.max(mx, Math.abs(a[i * 4]), Math.abs(a[i * 4 + 1]), Math.abs(a[i * 4 + 2]));
      out.push({ name: 'D = 0 时位移为零 max|x − q|（256 点）', expected: '< 1e-6', measured: mx.toExponential(2), pass: mx < 1e-6 });

      const b = run(1);
      let cs = 0, js = 0, cmax = 0;
      for (let i = 0; i < 64; i++) { cs += b[i * 4]; js += b[i * 4 + 1]; cmax = Math.max(cmax, b[i * 4] / Math.max(b[i * 4 + 1], 1e-9)); }
      const cr = cs / Math.max(js, 1e-9);
      out.push({ name: '位移场无旋 Σ|∇×ψ| / Σ|∇ψ|（64 点，中心差分）', expected: '< 0.03', measured: cr.toExponential(2) + '（单点最大 ' + cmax.toExponential(1) + '）', pass: cr < 0.03 });

      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      for (let i = 0; i < 256; i++) { const x = b[i * 4 + 3], y = b[i * 4 + 2]; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
      const n = 256, cov = sxy / n - sx * sy / n / n, vx = sxx / n - sq(sx / n), vy = syy / n - sq(sy / n);
      const corr = cov / Math.sqrt(vx * vy), slope = cov / vx;
      out.push({ name: '密度代理 与 有限差分 −∇·ψ 的相关（256 点）', expected: '> 0.9', measured: corr.toFixed(4) + '（斜率 ' + slope.toFixed(3) + '）', pass: corr > 0.9 });

      const c2 = run(2);
      let pr = 0, dr = 0;
      for (let i = 0; i < 256; i++) { pr += c2[i * 4] ** 2 + c2[i * 4 + 1] ** 2 + c2[i * 4 + 2] ** 2; dr += c2[i * 4 + 3] ** 2; }
      out.push({ name: '场的量级（参考）rms|ψ|、rms δ、结点粒子数', expected: '—', measured: Math.sqrt(pr / 256).toFixed(3) + ' / ' + Math.sqrt(dr / 256).toFixed(3) + ' / ' + s.nodeN + '，阈值 ' + s.thr.toFixed(3) + '…' + s.top.toFixed(3), pass: true });

      const g3 = run(3);
      let ge = 0, gm = 0;
      for (let i = 0; i < 256; i++) { ge = Math.max(ge, g3[i * 4]); gm += g3[i * 4 + 1] / 256; }
      out.push({ name: '位移场与共享 gnoised 的梯度一致（256 点）', expected: '相对误差 < 1e-4', measured: (ge / gm).toExponential(2), pass: ge / gm < 1e-4 });

      const Tdec = 2.725 * cosmo(DEC).zp1;
      out.push({ name: 'live 面板的 z(t)：t = 30 s 时 2.725·(1+z)', expected: '3000 K ± 2%', measured: Tdec.toFixed(1) + ' K（z = ' + (cosmo(DEC).zp1 - 1).toFixed(0) + '）', pass: Math.abs(Tdec / 3000 - 1) <= 0.02 });
      const zEnd = cosmo(END).zp1 - 1;
      let mono = true;
      for (let t = BANG; t < END; t += 0.25) if (!(cosmo(t + 0.25).zp1 <= cosmo(t).zp1)) mono = false;
      out.push({ name: 'z 单调下降，片尾 z', expected: '单调，≈ 15', measured: (mono ? '单调' : '不单调') + '，' + zEnd.toFixed(2), pass: mono && Math.abs(zEnd - 15) < 0.5 });

      G.dispose(tg); G.dispose(tp);
      return out;
    },
  });

  // CPU 侧黑体色（只用于均匀辉光；与 GLSL blackbody 同一公式）
  function bbRGB(k) {
    const t = M.clamp(k, 1000, 40000), t2 = t * t;
    const u = (0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t2) / (1 + 8.42420235e-4 * t + 7.08145163e-7 * t2);
    const v = (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t2) / (1 - 2.89741816e-5 * t + 1.61456053e-7 * t2);
    const d = 2 * u - 8 * v + 4, x = 3 * u / d, y = 2 * v / d;
    const X = x / y, Z = (1 - x - y) / y;
    let r = 3.2406 * X - 1.5372 - 0.4986 * Z, g = -0.9689 * X + 1.8758 + 0.0415 * Z, b = 0.0557 * X - 0.2040 + 1.0570 * Z;
    r = Math.max(r, 0); g = Math.max(g, 0) * 1.028; b = Math.max(b, 0) * 0.976;
    const m = Math.max(r, g, b, 1e-6);
    return [r / m, g / m, b / m];
  }
})();
