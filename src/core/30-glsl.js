/* 太初 TAICHU — T.glsl：共享着色器片段（CONTRACT.md §4.3）。
   用法：着色器源码里写 #include <name>；片段之间的依赖由片段自己 #include，重复包含会被自动去重。 */
(function () {
  'use strict';
  const T = window.TAICHU;
  const S = T.glsl;

  S.common = `
const float PI = 3.14159265358979;
const float TAU = 6.28318530717959;
float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec2 saturate(vec2 x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
vec4 saturate(vec4 x) { return clamp(x, 0.0, 1.0); }
float sq(float x) { return x * x; }
vec2 sq(vec2 x) { return x * x; }
vec3 sq(vec3 x) { return x * x; }
float remap(float x, float a, float b, float c, float d) { return c + (d - c) * (x - a) / (b - a); }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

  // PCG 系列整数哈希（Jarzynski & Olano 2020）：浮点输入取其比特，因此任何浮点值都能哈希，
  // 但 0.0 与 -0.0 视为不同；对格点请先 floor()。结果映射到 [0,1) 时只取高 24 位，保证 < 1。
  S.hash = `
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
uvec4 pcg4d(uvec4 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  v ^= v >> 16u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  return v;
}
float u2f(uint x) { return float(x >> 8u) * (1.0 / 16777216.0); }
vec2 u2f(uvec2 x) { return vec2(x >> 8u) * (1.0 / 16777216.0); }
vec3 u2f(uvec3 x) { return vec3(x >> 8u) * (1.0 / 16777216.0); }
vec4 u2f(uvec4 x) { return vec4(x >> 8u) * (1.0 / 16777216.0); }
float hashu(uint x) { return u2f(pcg(x)); }
vec4 hash4u(uvec4 x) { return u2f(pcg4d(x)); }
float hash11(float p) { return u2f(pcg(floatBitsToUint(p))); }
float hash12(vec2 p) { return u2f(pcg3d(uvec3(floatBitsToUint(p), 0x9E3779B9u)).x); }
float hash13(vec3 p) { return u2f(pcg3d(floatBitsToUint(p)).x); }
vec2 hash22(vec2 p) { return u2f(pcg3d(uvec3(floatBitsToUint(p), 0x9E3779B9u)).xy); }
vec3 hash32(vec2 p) { return u2f(pcg3d(uvec3(floatBitsToUint(p), 0x9E3779B9u))); }
vec3 hash33(vec3 p) { return u2f(pcg3d(floatBitsToUint(p))); }
vec4 hash43(vec3 p) { return u2f(pcg4d(uvec4(floatBitsToUint(p), 0x9E3779B9u))); }
`;

  // 梯度噪声用整数格点与五次插值（C2 连续，导数无折痕）；1.25 / 1.4 的系数把幅度拉到约 [-1,1]。
  // 格点哈希：三个奇数乘子异或后过一次 pcg（5 次 32 位整数乘法）。苹果 GPU 上整数乘法只有四分之一速率，
  // 而 pcg3d 要 15 次；一个 curl 要取 24 个格点梯度，这里省下的就是粒子系统的大半开销。整数格点对任何 |p| < 2³¹ 都精确。
  S.noise = `
#include <hash>
uint _nh(ivec3 c) { uvec3 u = uvec3(c); return pcg(u.x * 0x8DA6B343u ^ u.y * 0xD8163841u ^ u.z * 0xCB1AB31Fu); }
vec3 _ngrad(ivec3 c) { uint h = _nh(c); return vec3(uvec3(h, h >> 11u, h >> 22u) & uvec3(2047u, 2047u, 1023u)) * vec3(2.0 / 2047.0, 2.0 / 2047.0, 2.0 / 1023.0) - 1.0; }
vec2 _ngrad2(ivec2 c) { uvec2 u = uvec2(c); uint h = pcg(u.x * 0x8DA6B343u ^ u.y * 0xD8163841u ^ 0x51ED27u); return vec2(uvec2(h, h >> 16u) & 65535u) * (2.0 / 65535.0) - 1.0; }
float _nv(ivec3 c) { return float(_nh(c) >> 8u) * (1.0 / 16777216.0); }
float vnoise(vec3 p) {
  ivec3 i = ivec3(floor(p)); vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = _nv(i), b = _nv(i + ivec3(1, 0, 0)), c = _nv(i + ivec3(0, 1, 0)), d = _nv(i + ivec3(1, 1, 0));
  float e = _nv(i + ivec3(0, 0, 1)), g = _nv(i + ivec3(1, 0, 1)), h = _nv(i + ivec3(0, 1, 1)), k = _nv(i + ivec3(1, 1, 1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}
float gnoise(vec3 p) {
  ivec3 i = ivec3(floor(p)); vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float va = dot(_ngrad(i), f);
  float vb = dot(_ngrad(i + ivec3(1, 0, 0)), f - vec3(1, 0, 0));
  float vc = dot(_ngrad(i + ivec3(0, 1, 0)), f - vec3(0, 1, 0));
  float vd = dot(_ngrad(i + ivec3(1, 1, 0)), f - vec3(1, 1, 0));
  float ve = dot(_ngrad(i + ivec3(0, 0, 1)), f - vec3(0, 0, 1));
  float vf = dot(_ngrad(i + ivec3(1, 0, 1)), f - vec3(1, 0, 1));
  float vg = dot(_ngrad(i + ivec3(0, 1, 1)), f - vec3(0, 1, 1));
  float vh = dot(_ngrad(i + ivec3(1, 1, 1)), f - vec3(1, 1, 1));
  return 1.25 * (va + u.x * (vb - va) + u.y * (vc - va) + u.z * (ve - va) + u.x * u.y * (va - vb - vc + vd)
    + u.y * u.z * (va - vc - ve + vg) + u.z * u.x * (va - vb - ve + vf) + (-va + vb + vc - vd + ve - vf - vg + vh) * u.x * u.y * u.z);
}
float gnoise(vec2 p) {
  ivec2 i = ivec2(floor(p)); vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(_ngrad2(i), f), b = dot(_ngrad2(i + ivec2(1, 0)), f - vec2(1, 0));
  float c = dot(_ngrad2(i + ivec2(0, 1)), f - vec2(0, 1)), d = dot(_ngrad2(i + ivec2(1, 1)), f - vec2(1, 1));
  return 1.4 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// 每个八度之间做一次旋转，避免轴向条纹；结果按振幅和归一，约 [-1,1]
const mat3 _FBM_R = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
float fbm(vec3 p, int oct, float lac, float gain) {
  float s = 0.0, a = 1.0, n = 0.0;
  for (int i = 0; i < 12; i++) {
    if (i >= oct) break;
    s += a * gnoise(p); n += a;
    p = _FBM_R * p * lac; a *= gain;
  }
  return s / max(n, 1e-6);
}
float fbm(vec2 p, int oct, float lac, float gain) {
  float s = 0.0, a = 1.0, n = 0.0;
  for (int i = 0; i < 12; i++) {
    if (i >= oct) break;
    s += a * gnoise(p); n += a;
    p = mat2(0.80, 0.60, -0.60, 0.80) * p * lac; a *= gain;
  }
  return s / max(n, 1e-6);
}
float ridged(vec3 p, int oct) {
  float s = 0.0, a = 1.0, n = 0.0;
  for (int i = 0; i < 12; i++) {
    if (i >= oct) break;
    float r = 1.0 - abs(gnoise(p));
    s += a * r * r; n += a;
    p = _FBM_R * p * 2.03; a *= 0.5;
  }
  return s / max(n, 1e-6);
}
`;

  // 解析梯度：与 gnoise 完全同一个函数（同格点、同插值），gnoised(p).x == gnoise(p)
  S.noised = `
#include <noise>
vec4 gnoised(vec3 x) {
  ivec3 i = ivec3(floor(x)); vec3 f = fract(x);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec3 ga = _ngrad(i), gb = _ngrad(i + ivec3(1, 0, 0)), gc = _ngrad(i + ivec3(0, 1, 0)), gd = _ngrad(i + ivec3(1, 1, 0));
  vec3 ge = _ngrad(i + ivec3(0, 0, 1)), gf = _ngrad(i + ivec3(1, 0, 1)), gg = _ngrad(i + ivec3(0, 1, 1)), gh = _ngrad(i + ivec3(1, 1, 1));
  float va = dot(ga, f), vb = dot(gb, f - vec3(1, 0, 0)), vc = dot(gc, f - vec3(0, 1, 0)), vd = dot(gd, f - vec3(1, 1, 0));
  float ve = dot(ge, f - vec3(0, 0, 1)), vf = dot(gf, f - vec3(1, 0, 1)), vg = dot(gg, f - vec3(0, 1, 1)), vh = dot(gh, f - vec3(1, 1, 1));
  float k4 = va - vb - vc + vd, k5 = va - vc - ve + vg, k6 = va - vb - ve + vf, k7 = -va + vb + vc - vd + ve - vf - vg + vh;
  float v = va + u.x * (vb - va) + u.y * (vc - va) + u.z * (ve - va) + u.x * u.y * k4 + u.y * u.z * k5 + u.z * u.x * k6 + k7 * u.x * u.y * u.z;
  vec3 g = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.z * (ge - ga) + u.x * u.y * (ga - gb - gc + gd)
    + u.y * u.z * (ga - gc - ge + gg) + u.z * u.x * (ga - gb - ge + gf) + (-ga + gb + gc - gd + ge - gf - gg + gh) * u.x * u.y * u.z
    + du * (vec3(vb, vc, ve) - va + u.yzx * vec3(k4, k5, k6) + u.zxy * vec3(k6, k4, k5) + u.yzx * u.zxy * k7);
  return 1.25 * vec4(v, g);
}
// 不旋转（梯度保持简单），每个八度平移错开；返回 (值, 梯度)，按振幅和归一
vec4 fbmd(vec3 p, int oct) {
  vec4 s = vec4(0.0);
  float a = 1.0, f = 1.0, n = 0.0;
  for (int i = 0; i < 12; i++) {
    if (i >= oct) break;
    vec4 r = gnoised(p * f + float(i) * vec3(17.13, 31.71, 7.37));
    s += a * vec4(r.x, r.yzw * f); n += a;
    a *= 0.5; f *= 2.0;
  }
  return s / max(n, 1e-6);
}
`;

  // 向量势 ψ = (N₁, N₂, N₃) 的旋度 ∇×ψ：用解析梯度，散度恒为 0（不是近似）
  S.curl = `
#include <noised>
vec3 curl(vec3 p) {
  vec3 a = gnoised(p).yzw;
  vec3 b = gnoised(p + vec3(31.416, -47.853, 12.793)).yzw;
  vec3 c = gnoised(p + vec3(-233.17, 113.41, -71.97)).yzw;
  return vec3(c.y - b.z, a.z - c.x, b.x - a.y);
}
`;

  // Krystek (1985) 普朗克轨迹有理逼近 → CIE xyY → 线性 sRGB；末尾的白平衡增益让 6500 K 落在白点附近，
  // 与参考表（3000/5800/6500/10000/20000 K）最大偏差 0.033。
  S.blackbody = `
#include <common>
vec3 blackbody(float kelvin) {
  float t = clamp(kelvin, 1000.0, 40000.0), t2 = t * t;
  float u = (0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t2) / (1.0 + 8.42420235e-4 * t + 7.08145163e-7 * t2);
  float v = (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t2) / (1.0 - 2.89741816e-5 * t + 1.61456053e-7 * t2);
  float d = 2.0 * u - 8.0 * v + 4.0;
  float x = 3.0 * u / d, y = 2.0 * v / d;
  vec3 xyz = vec3(x / y, 1.0, (1.0 - x - y) / y);
  vec3 rgb = mat3(3.2406, -0.9689, 0.0557, -1.5372, 1.8758, -0.2040, -0.4986, 0.0415, 1.0570) * xyz;
  rgb = max(rgb, 0.0) * vec3(1.0, 1.028, 0.976);
  return rgb / max(max(rgb.r, rgb.g), rgb.b);
}
// 同色温、亮度（luma）归一为 1：用来"给定亮度、只换颜色"
vec3 blackbodyN(float kelvin) { vec3 c = blackbody(kelvin); return c / max(luma(c), 1e-4); }
`;

  // ACES：Stephen Hill 的 RRT+ODT 拟合（输入、输出均为线性 sRGB）
  S.color = `
vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
vec3 srgbToLinear(vec3 c) {
  c = max(c, 0.0);
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 aces(vec3 c) {
  const mat3 IN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  vec3 v = IN * c;
  v = (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
  return clamp(OUT * v, 0.0, 1.0);
}
`;

  S.ray = `
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uPixAngle;
// uv ∈ [0,1]²（原点左下，即 vUv）→ 世界空间单位方向
vec3 cameraRay(vec2 uv) {
  vec2 n = uv * 2.0 - 1.0;
  return normalize(uCamFwd + (n.x * uAspect * uTanHalfFov) * uCamRight + (n.y * uTanHalfFov) * uCamUp);
}
`;

  S.dither = `
float ign(vec2 fragCoord) { return fract(52.9829189 * fract(dot(fragCoord, vec2(0.06711056, 0.00583715)))); }
`;

  /* ── 全片共用的星空 ──
     恒星：三层"立方体面上的抖动格点"，每层格子数差约 9 倍、亮度带各自是截断幂律（整体 N(>F) ∝ F^-1.2）。
     立方体面用 S2 的二次投影（面积不均匀度 2.1，按格子面积修正占有率，所以每立体角的星密度处处相同），
     每层再套一个固定的旋转，各层的格子与面接缝互不对齐，看不出网格。
     每颗星画成能量归一的高斯，σ ≥ 0.6 像素角：分辨率或缩放变化时总通量不变，亚像素移动不闪。
     搜索只看像素所在的格子，靠近格边时才加看相邻格（包括相邻面），代价与视场无关；
     某层格子小到装不下星点时，平滑地退化为等能量的弥散光。
     银河：固定的大圆带 + 指向银心的核球；两通道值噪声 fbm 同时给出星云团块与尘埃带，尘埃对蓝光消光更强。 */
  S.sky = `
#include <common>
#include <hash>
#include <blackbody>
const vec3 SKY_NG = vec3(-0.300346, 0.860991, 0.410472);   // 银河北极
const vec3 SKY_CG = vec3(0.692829, -0.098851, 0.714295);   // 银心方向
const vec3 SKY_YG = vec3(0.655577, 0.498922, -0.566829);
const float SKY_SIGREF = 4.6e-4;   // 1080p、45° 视场下 0.6 像素角：亮度表以它为基准
// 星点 = 截在 2.5σ 处、减去截断值的高斯（边缘连续、无硬边）；SKY_WNORM 把它的总能量补回到完整高斯
const float SKY_K = 2.5, SKY_WCUT = 0.0439369, SKY_WNORM = 1.22142;

struct SkyL { float N; float salt; float pLo; float ratioA; float ialpha; float tBias; float occ; float r2max; float inv2s2; float gain; float rc; float m; };
// 像素在某一面上的局部坐标系：g = 格坐标；u = 立方体面坐标；dk = du/dg；p = 该处的占有率
struct SkyF { vec2 g; vec2 u; vec2 dk; float uu; float p; float face; };

float _skyDensity(float b, float cg) {
  float bulge = exp(-(1.0 - cg) * 28.0);
  return 0.55 + 1.6 * exp(-b * b * 12.5) + 1.4 * bulge;
}

// 格点哈希用纯浮点（Hoskins "hash without sine"）：苹果 GPU 上 32 位整数乘法很贵，这里的输入都是小整数，浮点足够
vec4 _skyH4(vec4 p) {
  p = fract(p * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p += dot(p, p.wzxy + 33.33);
  return fract((p.xxyz + p.yzzw) * p.zywx);
}
// 色温分布：约 7% M、48% K、25% G/F、14% A、6% B；颜色 = 0.2 + 0.8 × 等亮度的 blackbody(K)（离线算好的锚点）
vec3 _skyTint(float r) {
  vec3 c = mix(vec3(1.633, 0.874, 0.387), vec3(1.378, 0.933, 0.551), saturate(r / 0.07));
  c = mix(c, vec3(1.131, 0.979, 0.818), saturate((r - 0.07) / 0.48));
  c = mix(c, vec3(1.014, 0.995, 1.006), saturate((r - 0.55) / 0.25));
  c = mix(c, vec3(0.885, 1.004, 1.296), saturate((r - 0.80) / 0.14));
  return mix(c, vec3(0.778, 0.997, 1.685), saturate((r - 0.94) / 0.06));
}

// qp：把这一面的法轴换到 x 的方向。面坐标 u = qp.yz/|qp.x|，二次投影 u = sign(w)(w² + 2|w|)/3 把面积不均匀度压到 2.1。
// 像素不在这一面上时（相邻面的边缘带）u 会略超出 [-1,1]，公式照样成立。
SkyF _skyFrame(vec3 qp, float axis, float dens, SkyL L) {
  SkyF F;
  float ak = abs(qp.x);
  F.u = qp.yz / ak;
  vec2 w = sign(F.u) * (sqrt(1.0 + 3.0 * abs(F.u)) - 1.0);
  vec2 aw = abs(w);
  F.g = (w + 1.0) * 0.5 * L.N;
  F.dk = (2.0 * aw + 2.0) * (1.0 / 3.0) * (2.0 / L.N);
  F.uu = 1.0 + dot(F.u, F.u);
  // 占有率 × 格子相对面积（面中心的格子更大）。用像素处的值代替星点处的值：两者相距不到 2.5σ，差别 < 0.1%
  float ir = inversesqrt(F.uu);
  F.p = min(L.occ * dens, 1.0) * (1.0 + aw.x) * (1.0 + aw.y) * ir * ir * ir * (1.0 / 1.4826);
  F.face = axis * 2.0 + (qp.x >= 0.0 ? 0.0 : 1.0);
  return F;
}

// 一颗星对这个像素的贡献。角距离用面坐标的局部度量（一阶展开，格距 < 1 时误差 < 0.5%），不必把星点映回球面
vec3 _skyStar(vec2 cell, SkyF F, SkyL L) {
  if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= L.N || cell.y >= L.N) return vec3(0.0);
  vec4 h = _skyH4(vec4(cell, F.face, L.salt));
  if (h.z >= F.p) return vec3(0.0);
  vec2 du = (cell + L.m + h.xy * (1.0 - 2.0 * L.m) - F.g) * F.dk;
  float ud = dot(F.u, du);
  float r2 = (dot(du, du) * F.uu - ud * ud) / (F.uu * F.uu);
  if (r2 > L.r2max) return vec3(0.0);
  float P = L.pLo * pow(1.0 - (h.z / F.p) * (1.0 - L.ratioA), -L.ialpha);
  return _skyTint(min(h.w + L.tBias, 0.999)) * (P * L.gain * (exp(-r2 * L.inv2s2) - SKY_WCUT));
}

// 某一面上：像素所在格 + 靠近格边时的相邻格。只有主面，或像素离这一面的边不到 rc 格时才看它
vec3 _skyFace(vec3 qp, float axis, float amax, float dens, SkyL L) {
  if (abs(qp.x) < (1.0 - 3.0 * L.rc / L.N) * amax) return vec3(0.0);
  SkyF F = _skyFrame(qp, axis, dens, L);
  if (max(abs(F.g.x - 0.5 * L.N), abs(F.g.y - 0.5 * L.N)) > 0.5 * L.N + L.rc) return vec3(0.0);
  vec2 c = floor(F.g), f = F.g - c;
  vec2 side = vec2(f.x < 0.5 ? -1.0 : 1.0, f.y < 0.5 ? -1.0 : 1.0);
  vec2 dd = min(f, 1.0 - f);
  bool nx = dd.x < L.rc, ny = dd.y < L.rc;
  vec3 acc = _skyStar(c, F, L);
  if (nx) acc += _skyStar(c + vec2(side.x, 0.0), F, L);
  if (ny) acc += _skyStar(c + vec2(0.0, side.y), F, L);
  if (nx && ny) acc += _skyStar(c + side, F, L);
  return acc;
}

// 一层星。m > 0：星点只落在格子内缩 m 的区域里，星点不出格，于是只需看像素所在的那一个格子（亮层用，便宜）；
// m = 0：星点可落在格内任意处，靠近格边时加看相邻格与相邻面（最密的暗星层用，分布无任何规则感）。
// 星密度只取决于方向与银河的关系，与各层的旋转无关，所以由调用者每像素算一次（dens）。
vec3 _skyLayer(vec3 d, float dens, float sig, float N, float m, float salt, float pLo, float pHi, float alpha, float tBias, float occ, mat3 R) {
  // 二次投影下一格的最小角尺寸 = 0.889 / N；星点半径 2.5σ 须 ≤ 可用的格内余量，超出部分转成等能量的弥散光
  float room = m > 0.0 ? m : 0.45;
  float over = SKY_K * sig * N / (0.889 * room);
  float resolved = 1.0 - smoothstep(1.0, 1.5, over);
  float ratioA = pow(pLo / pHi, alpha);
  vec3 acc = vec3(0.0);
  if (resolved > 0.0) {
    float sg = min(sig, room * 0.889 / (SKY_K * N));
    SkyL L = SkyL(N, salt, pLo, ratioA, 1.0 / alpha, tBias, occ, SKY_K * SKY_K * sg * sg, 0.5 / (sg * sg),
                  SKY_WNORM * (SKY_SIGREF * SKY_SIGREF) / (sg * sg), SKY_K * sg * N / 0.889, m);
    vec3 q = R * d;
    vec3 aq = abs(q);
    float am = max(aq.x, max(aq.y, aq.z));
    if (m > 0.0) {
      bool fx = aq.x >= am, fy = !fx && aq.y >= am;
      SkyF F = _skyFrame(fx ? q : fy ? q.yzx : q.zxy, fx ? 0.0 : fy ? 1.0 : 2.0, dens, L);
      acc = _skyStar(clamp(floor(F.g), 0.0, N - 1.0), F, L);
    } else {
      acc = _skyFace(q, 0.0, am, dens, L) + _skyFace(q.yzx, 1.0, am, dens, L) + _skyFace(q.zxy, 2.0, am, dens, L);
    }
  }
  if (resolved >= 1.0) return acc;
  // 未分辨部分：截断幂律的期望 × 星数密度（平均面积修正 0.794），按方向的星密度加权；3 = 2π × 6 面 / 4π
  float meanP = pLo * (alpha / (alpha - 1.0)) * (1.0 - pow(pLo / pHi, alpha - 1.0)) / (1.0 - ratioA);
  float diffuse = 3.0 * occ * 0.794 * meanP * SKY_SIGREF * SKY_SIGREF * N * N * dens;
  return acc * resolved + vec3(1.0, 0.93, 0.85) * diffuse * (1.0 - resolved);
}

// 两层：稀疏的亮星（24²×6 格，≈2000 颗，亮度 1.6–400）与密集的暗星（160²×6 格，≈13 万颗，0.035–1.6）。
// 每层各套一个固定旋转，两层的格子与面接缝互不对齐
vec3 skyStars(vec3 dir, float pixAngle) {
  float sig = max(0.6 * pixAngle, 1e-6);
  float dens = _skyDensity(dot(dir, SKY_NG), dot(dir, SKY_CG));
  vec3 c = _skyLayer(dir, dens, sig, 24.0, 0.12, 23.0, 1.6, 400.0, 1.1, 0.06, 0.6,
      mat3(-0.661598, 0.112401, 0.741386, -0.482648, -0.820503, -0.306310, 0.573880, -0.560483, 0.597094));
  c += _skyLayer(dir, dens, sig, 160.0, 0.0, 53.0, 0.035, 1.6, 1.05, -0.02, 0.85,
      mat3(-0.297184, -0.844140, -0.446217, -0.055924, -0.451140, 0.890699, -0.953181, 0.289656, 0.086864));
  return c;
}

vec2 _skyH2(vec2 p) {
  vec3 q = fract(p.xyx * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}
// 银道坐标 (l, b) 上的两通道值噪声 fbm：x → 星云团块，y → 尘埃。l 方向按格数取模，绕银道一周无接缝；
// 沿银道方向的格子拉长 2.4 倍，尘埃丝缕自然顺着银道面走
vec2 _skyNoise2(float l, float b) {
  float P = 27.0;
  vec2 p = vec2((l / TAU + 0.5) * P, b * P * 2.4 / TAU);
  vec2 s = vec2(0.0); float a = 0.5;
  for (int o = 0; o < 3; o++) {
    vec2 i = floor(p), f = p - i, u = f * f * (3.0 - 2.0 * f);
    float x0 = mod(i.x, P), x1 = mod(i.x + 1.0, P);
    vec2 v00 = _skyH2(vec2(x0, i.y)), v10 = _skyH2(vec2(x1, i.y)), v01 = _skyH2(vec2(x0, i.y + 1.0)), v11 = _skyH2(vec2(x1, i.y + 1.0));
    s += a * mix(mix(v00, v10, u.x), mix(v01, v11, u.x), u.y);
    p = p * 2.0 + vec2(13.0, 7.31); P *= 2.0; a *= 0.5;
  }
  return s / 0.875;
}

vec3 _skyMW(vec3 d, out vec3 trans) {
  trans = vec3(1.0);
  float b = dot(d, SKY_NG);
  float cx = dot(d, SKY_CG), cy = dot(d, SKY_YG);
  float l = atan(cy, cx);
  float lon = 0.25 + 0.75 * exp(-l * l * 0.45);
  float disk = exp(-b * b * 55.0);
  float wide = exp(-b * b * 7.0);
  float bulge = exp(-(l * l * 0.8 + b * b * 2.6) * 9.0);
  if ((wide + bulge) * lon < 0.004) return vec3(0.0);
  // 噪声只在银道附近算（|b| < 0.3 rad，盘与尘埃带都在这里）；更远处只剩宽而淡的辉光，用均值代替，过渡平滑
  vec2 n = vec2(0.5);
  if (abs(b) < 0.3) n = mix(_skyNoise2(l, b), vec2(0.5), smoothstep(0.2, 0.3, abs(b)));
  float clouds = smoothstep(0.25, 0.85, n.x);
  // 尘埃：沿银道面偏一点的暗带（大暗隙），被噪声撕成斑块与丝缕
  float lane = exp(-sq(b - 0.018) * 520.0) * (0.35 + 0.65 * lon);
  // 脊状变换把团块变成丝缕
  float ridge = 1.0 - abs(2.0 * n.y - 1.0);
  float patches = smoothstep(0.45, 0.9, ridge) * smoothstep(0.2, 0.6, n.y + 0.2 * n.x);
  float tau = 2.6 * lane * patches + 1.1 * disk * smoothstep(0.6, 0.95, ridge) * lon;
  trans = exp(-tau * vec3(0.72, 1.0, 1.38));
  float glow = disk * lon * (0.25 + 1.25 * clouds) + 0.12 * wide * lon * (0.6 + 0.8 * n.x) + 1.5 * bulge * (0.7 + 0.5 * clouds);
  vec3 col = mix(vec3(1.0, 0.92, 0.82), vec3(1.0, 0.80, 0.58), saturate(bulge * 1.6));
  return col * glow * trans * 0.032;
}

vec3 skyMilkyWay(vec3 dir) { vec3 t; return _skyMW(dir, t); }

vec3 sky(vec3 dir, float pixAngle) {
  vec3 t;
  vec3 mw = _skyMW(dir, t);
  return mw + skyStars(dir, pixAngle) * t;
}
`;
})();
