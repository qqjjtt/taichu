/* 太初 TAICHU — 后期链路（CONTRACT.md §4.4，引擎内部使用）。
   场景 HDR → 泛光（逐级降采样 + 一次 B 样条汇总）→ 曝光 / 调色 → ACES → sRGB → 暗角 · 色差 · 颗粒 · 抖动 → 画布。

   泛光是能量守恒的"镜头点扩散"：最终 = mix(场景, 泛光, k)。均匀的中灰画面混合前后完全不变（不发雾），
   亮点则把 k 份能量摊进一条长尾。各级权重按"屏幕高度的比例尺度"分配（每倍频程衰减 bloomRadius），
   所以 720p 与 4K 的光晕形状一致。降采样核是 [1 3 3 1]/8：每个源像素对下一级的总贡献恒为 1/4，
   亚像素亮点在平移时能量不跳，光晕不闪。首级做"带膝"的 Karis 加权：亮度低于膝点（32）的像素原样参与，
   只压制更亮的萤火虫像素。

   性能（实测 Apple M4 Pro / ANGLE Metal，有效算力只有标称的约 1/6，全屏通道的每一次运算都要省）：
   - 合成通道跑在画布分辨率上（3024×1964 时 590 万像素），是整条链路的大头。所以色调映射整体烘进一张
     48³ 的 3D 查找表（对数整形输入 → ACES + sRGB 输出，alpha 存颗粒强度），只在 contrast 变化时重烘；
     曝光 / 色调 / 饱和度是线性的，合成一个 3×3 矩阵在查表前乘上；颗粒与抖动从一张 256² 噪声纹理取。
     这样合成通道每像素只剩 3 次取样 + 约 30 次运算。
   - 每多一个相互依赖的渲染通道要多付约 0.1 ms 的流水线排空，所以泛光不逐级升采样，而是一次汇总通道
     对各级做 B 样条采样再加权求和；场景高 ≥ 1900 像素时，权重几乎为零的半分辨率级直接跳过，
     首级改为 4:1（核 [1 3 5 7 7 5 3 1]/32，同样是单位分解，亮点不闪）。 */
(function () {
  'use strict';
  const T = window.TAICHU;

  const DEFAULTS = {
    exposure: 1.0, bloom: 0.5, bloomRadius: 0.7, grain: 0.035, vignette: 0.3,
    aberration: 0.0015, saturation: 1.0, contrast: 1.0, tint: [1, 1, 1],
  };
  const LUT_N = 48, LOG_LO = -13, LOG_HI = 7;   // 查找表覆盖 2^-13 … 2^7 的场景值（更暗 → 黑，更亮 → ACES 已饱和）
  const NOISE_N = 256;

  const DOWN = `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uKaris;
uniform float uWide;
float kw(vec3 c) { float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); return uKaris > 0.5 ? 1.0 / (1.0 + max(l - 32.0, 0.0) / 32.0) : 1.0; }
// NaN / Inf 不得进入泛光链（一个坏像素会被扩散成整屏的黑块）；clamp 在 NaN 上返回边界值
vec3 safe(vec3 c) { return clamp(c, 0.0, 60000.0); }
void main() {
  vec3 s = vec3(0.0); float ws = 0.0;
  if (uWide > 0.5) {
    // 4:1：每轴 8 个源像素 [1 3 5 7 7 5 3 1]/32，用 4 个双线性样本取到
    const vec4 OFF = vec4(-2.75, -0.916667, 0.916667, 2.75), WT = vec4(1.0, 3.0, 3.0, 1.0);
    for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
      vec3 c = safe(texture(uSrc, vUv + vec2(OFF[i], OFF[j]) * uTexel).rgb);
      float w = WT[i] * WT[j] * kw(c);
      s += c * w; ws += w;
    }
  } else {
    // 2:1：每轴 [1 3 3 1]/8，4 个双线性样本
    vec2 o = 0.75 * uTexel;
    for (int k = 0; k < 4; k++) {
      vec3 c = safe(texture(uSrc, vUv + vec2((k & 1) == 0 ? -o.x : o.x, k < 2 ? -o.y : o.y)).rgb);
      float w = kw(c);
      s += c * w; ws += w;
    }
  }
  fragColor = vec4(s / ws, 1.0);
}`;

  // 汇总：最细一级与输出同分辨率，取 1 次；更粗的每级做 4 样本 B 样条（错开半个该级像素的双线性 = 盒 ⊛ 双线性）
  const GATHER = `
uniform sampler2D uL0;
uniform sampler2D uL1;
uniform sampler2D uL2;
uniform sampler2D uL3;
uniform sampler2D uL4;
uniform sampler2D uL5;
uniform sampler2D uL6;
uniform sampler2D uL7;
uniform vec2 uTex[8];
uniform float uW[8];
vec3 bs(sampler2D t, vec2 tx) {
  vec2 o = 0.5 * tx;
  return 0.25 * (texture(t, vUv + vec2(-o.x, -o.y)).rgb + texture(t, vUv + vec2(o.x, -o.y)).rgb
               + texture(t, vUv + vec2(-o.x, o.y)).rgb + texture(t, vUv + vec2(o.x, o.y)).rgb);
}
void main() {
  vec3 c = uW[0] * texture(uL0, vUv).rgb + uW[1] * bs(uL1, uTex[1]) + uW[2] * bs(uL2, uTex[2]) + uW[3] * bs(uL3, uTex[3]);
  if (uW[4] > 0.0) c += uW[4] * bs(uL4, uTex[4]);
  if (uW[5] > 0.0) c += uW[5] * bs(uL5, uTex[5]);
  if (uW[6] > 0.0) c += uW[6] * bs(uL6, uTex[6]);
  if (uW[7] > 0.0) c += uW[7] * bs(uL7, uTex[7]);
  fragColor = vec4(c, 1.0);
}`;

  // 查找表烘焙：一层一个 draw。格点 → 场景值（对数整形的逆）→ 对比度 → ACES → sRGB；alpha = 颗粒强度
  //（阴影与中间调多、高光少、纯黑为零——黑保持真黑）
  const BAKE = `
#include <common>
#include <color>
uniform float uLayer;
uniform float uContrast;
const float N = ${LUT_N}.0, LO = ${LOG_LO}.0, HI = ${LOG_HI}.0;
vec3 sceneOf(vec3 g) { return exp2(LO + g / (N - 1.0) * (HI - LO)); }
void main() {
  vec3 g = vec3(floor(gl_FragCoord.xy), uLayer);
  vec3 h = sceneOf(g);
  if (g.x == 0.0) h.x = 0.0;
  if (g.y == 0.0) h.y = 0.0;
  if (g.z == 0.0) h.z = 0.0;
  if (uContrast != 1.0) h = 0.18 * pow(h / 0.18, vec3(uContrast));
  vec3 s = linearToSrgb(aces(h));
  float ls = luma(s);
  fragColor = vec4(s, smoothstep(0.0, 0.12, ls) * (1.0 - 0.8 * smoothstep(0.3, 1.0, ls)));
}`;

  const COMPOSITE = `
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform mediump sampler3D uLut;
uniform mediump sampler2D uNoise;
uniform vec2 uSceneTexel;
uniform float uSharpen;
uniform float uBloomK;
uniform mat3 uColor;      // 曝光 × 色调 × 饱和度
uniform vec2 uVigScale;
uniform float uVignette;
uniform float uAberr;
uniform float uGrain;
uniform ivec2 uNoiseOff;
uniform float uFade;
uniform vec3 uFadeColor;
const float LUT_A = ${(LUT_N - 1) / (LOG_HI - LOG_LO) / LUT_N}, LUT_B = ${(-LOG_LO * (LUT_N - 1) / (LOG_HI - LOG_LO) + 0.5) / LUT_N};
void main() {
  vec2 uv = vUv;
  vec3 m = texture(uScene, uv).rgb;
  vec3 col = m;
  if (uSharpen > 0.0) {
    // 内部分辨率低于画布时的轻度锐化：结果钳在邻域最小/最大值之间，不会振铃
    vec3 a = texture(uScene, uv + vec2(uSceneTexel.x, 0.0)).rgb, b = texture(uScene, uv - vec2(uSceneTexel.x, 0.0)).rgb;
    vec3 c = texture(uScene, uv + vec2(0.0, uSceneTexel.y)).rgb, d = texture(uScene, uv - vec2(0.0, uSceneTexel.y)).rgb;
    vec3 mn = min(m, min(min(a, b), min(c, d))), mx = max(m, max(max(a, b), max(c, d)));
    col = clamp(m + uSharpen * (m - 0.25 * (a + b + c + d)), mn, mx);
  }
  if (uAberr > 0.0) {
    // 极小的径向色差：红向外、蓝向内（只作用于场景；泛光本身是低频的，偏移几个像素看不出）
    vec2 dv = (uv - 0.5) * uAberr;
    col.r += texture(uScene, uv + dv).r - m.r;
    col.b += texture(uScene, uv - dv).b - m.b;
  }
  vec3 hdr = mix(col, texture(uBloom, uv).rgb, uBloomK);
  vec2 vc = (uv - 0.5) * uVigScale;
  float f = 1.0 + 0.22 * dot(vc, vc);
  hdr = clamp(uColor * hdr, 0.0, 60000.0) * mix(1.0, 1.0 / (f * f), uVignette);   // clamp 顺带清掉 NaN
  vec4 t = texture(uLut, log2(hdr + 1e-9) * LUT_A + LUT_B);
  vec4 n = texelFetch(uNoise, (ivec2(gl_FragCoord.xy) + uNoiseOff) & ${NOISE_N - 1}, 0);
  vec3 s = mix(t.rgb, uFadeColor, uFade);
  // 颗粒：两次均匀噪声之和 = 三角分布，约 24 fps 换一次；抖动：±1 LSB 三角分布，在 8 位量化之前，消除暗部条带
  s += (n.x + n.y - 1.0) * (uGrain * t.a * (1.0 - uFade)) + (n.z - n.w) * (1.0 / 255.0);
  fragColor = vec4(s, 1.0);
}`;

  const P = { DEFAULTS: DEFAULTS, levels: 0, sceneW: 0, sceneH: 0 };
  let G, gl, progDown, progGather, progComp, progBake;
  let downs = [], scales = [], gatherT = null;
  let lutTex = null, lutFbo = null, lutContrast = NaN, noiseTex = null;

  P.init = function () {
    G = T.G; gl = G.gl;
    progDown = G.fsProgram('post/down', DOWN);
    progGather = G.fsProgram('post/gather', GATHER);
    progComp = G.fsProgram('post/composite', COMPOSITE);
    progBake = G.fsProgram('post/lut', BAKE);
    lutTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, lutTex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, LUT_N, LUT_N, LUT_N, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_3D, null);
    lutFbo = gl.createFramebuffer();
    // 噪声：固定种子的白噪声（引擎内部的确定性，与章节 seed 无关）
    const rng = T.M.mulberry32(0x7A1C0);
    const d = new Uint8Array(NOISE_N * NOISE_N * 4);
    for (let i = 0; i < d.length; i++) d[i] = Math.floor(rng() * 256);
    noiseTex = G.texture({ w: NOISE_N, h: NOISE_N, format: 'rgba8', filter: 'nearest', wrap: 'repeat', data: d });
    bakeLut(1);
  };

  function bakeLut(contrast) {
    lutContrast = contrast;
    gl.bindFramebuffer(gl.FRAMEBUFFER, lutFbo);
    gl.viewport(0, 0, LUT_N, LUT_N);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.disable(gl.BLEND);
    progBake.use().set({ uContrast: contrast });
    for (let z = 0; z < LUT_N; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, lutTex, 0, z);
      progBake.set({ uLayer: z });
      G.fullscreen();
    }
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, null, 0, 0);
    G.bind(null);
  }

  // 场景尺寸变化时重建泛光链：每级 2:1，直到短边约 8 像素（1080p → 7 级）；至多 8 级
  P.resize = function (sw, sh) {
    if (sw === P.sceneW && sh === P.sceneH && downs.length) return;
    P.sceneW = sw; P.sceneH = sh;
    for (const t of downs) t.dispose();
    if (gatherT) gatherT.dispose();
    downs = []; scales = [];
    const top = Math.max(3, Math.min(9, Math.floor(Math.log2(Math.min(sw, sh * 1.5) / 8))));
    const first = sh >= 1900 ? 2 : 1;
    for (let i = Math.max(first, top - 7); i <= top; i++) {
      const f = Math.pow(2, i);
      downs.push(G.target({ w: Math.max(1, Math.round(sw / f)), h: Math.max(1, Math.round(sh / f)), format: 'r11g11b10f', filter: 'linear' }));
      scales.push(i);
    }
    gatherT = G.target({ w: downs[0].w, h: downs[0].h, format: 'r11g11b10f', filter: 'linear' });
    P.levels = downs.length;
  };

  // 每级权重：在"相对屏幕高度的尺度"上，每倍频程衰减 rho；比参考尺度（1080p 的第 1 级）更细的都归入最细一级，
  // 比最粗一级更粗的长尾归入最粗一级。
  function levelWeights(rho, sh) {
    const L = downs.length, w = [];
    const x0 = -0.5;
    let total = 0;
    for (let k = 0; k < L; k++) {
      const e = scales[k] - 1 + Math.log2(1080 / sh);
      const lo = k === 0 ? x0 : Math.max(e - 0.5, x0);
      const hi = k === L - 1 ? Infinity : Math.max(e + 0.5, x0);
      const m = Math.max(0, Math.pow(rho, lo) - (hi === Infinity ? 0 : Math.pow(rho, hi)));
      w.push(m); total += m;
    }
    return w.map(function (x) { return x / total; });
  }

  // 曝光 × 色调 × 饱和度（绕 Rec.709 亮度轴）合成一个列主序 mat3
  const LW = [0.2126, 0.7152, 0.0722];
  const colorMat = new Float32Array(9);
  function colorMatrix(exposure, tint, sat) {
    for (let c = 0; c < 3; c++) {        // 列 c：输入通道 c 对各输出通道的贡献
      for (let r = 0; r < 3; r++) {
        colorMat[c * 3 + r] = exposure * tint[r] * ((1 - sat) * LW[c] + (r === c ? sat : 0));
      }
    }
    return colorMat;
  }

  // 绑定并声明"旧内容作废"：每个通道都整屏覆盖，瓦片式 GPU 因此不必先把旧像素从显存读进瓦片
  let INV_ATT = null, INV_DEF = null;
  function fresh(t) {
    G.bind(t);
    if (!INV_ATT) { INV_ATT = [gl.COLOR_ATTACHMENT0]; INV_DEF = [gl.COLOR]; }
    gl.invalidateFramebuffer(gl.FRAMEBUFFER, t ? INV_ATT : INV_DEF);
  }

  // scene：场景 Target；p：合并后的参数（含 fade、fadeColor）；info：{ frame, wall, canvasW, canvasH }
  P.render = function (scene, p, info) {
    const rho = Math.min(0.95, Math.max(0.05, +p.bloomRadius || 0.05));
    const bloomK = Math.max(0, Math.min(1, (+p.bloom || 0) * 0.12));
    const contrast = Math.max(0.25, Math.min(4, Math.round(+p.contrast * 100) / 100));
    if (contrast !== lutContrast) bakeLut(contrast);
    let bloomTex = scene;
    if (bloomK > 0) {
      let src = scene;
      for (let k = 0; k < downs.length; k++) {
        fresh(downs[k]);
        progDown.use().set({ uSrc: src, uTexel: [1 / src.w, 1 / src.h], uKaris: k === 0 ? 1 : 0, uWide: scales[k] - (k ? scales[k - 1] : 0) > 1 ? 1 : 0 });
        G.fullscreen();
        src = downs[k];
      }
      const w = levelWeights(rho, scene.h);
      const u = { uTex: new Float32Array(16), uW: new Float32Array(8) };
      for (let k = 0; k < 8; k++) {
        const t = downs[Math.min(k, downs.length - 1)];
        u['uL' + k] = t;
        u.uTex[k * 2] = 1 / t.w; u.uTex[k * 2 + 1] = 1 / t.h;
        u.uW[k] = k < downs.length ? w[k] : 0;
      }
      fresh(gatherT);
      progGather.use().set(u);
      G.fullscreen();
      bloomTex = gatherT;
    }
    fresh(null);
    const ratio = info.canvasH / scene.h;
    const tint = p.tint && p.tint.length === 3 ? p.tint : DEFAULTS.tint;
    const gf = Math.floor(info.wall * 24);
    const aspect = info.canvasW / info.canvasH;
    progComp.use().set({
      uScene: scene, uBloom: bloomTex, uLut: lutTex, uNoise: noiseTex, uSceneTexel: [1 / scene.w, 1 / scene.h],
      uSharpen: ratio > 1.02 ? 0.35 * Math.min(1, (ratio - 1) * 2) : 0,
      uBloomK: bloomK, uColor: colorMatrix(+p.exposure, tint, +p.saturation),
      uVigScale: [2 * aspect, 2], uVignette: +p.vignette, uAberr: +p.aberration, uGrain: +p.grain,
      uNoiseOff: [(Math.imul(gf, 0x9E3779B1) >>> 7) & (NOISE_N - 1), (Math.imul(gf, 0x85EBCA77) >>> 9) & (NOISE_N - 1)],
      uFade: Math.max(0, Math.min(1, +p.fade || 0)), uFadeColor: p.fadeColor || [0, 0, 0],
    });
    G.fullscreen();
  };

  // 合并章节参数与缺省值；非有限数字回落到缺省，避免一处 NaN 把整屏变黑
  P.merge = function (user) {
    const o = Object.assign({}, DEFAULTS);
    if (user) {
      for (const k in user) {
        const v = user[k];
        if (k === 'tint') { if (Array.isArray(v) && v.length === 3 && v.every(isFinite)) o.tint = v; } else if (typeof v === 'number' && isFinite(v)) o[k] = v;
      }
    }
    return o;
  };

  T.Post = P;
})();
