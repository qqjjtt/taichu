/* 太初 TAICHU — 第四幕 · 蔚蓝 azure
   一颗岩石行星从岩浆海冷却成蓝色星球。核心是逐像素单次散射：瑞利 + 米氏 + 臭氧，系数取地球大气实测值，
   观测者在大气外，太阳方向的透射率查预计算表。单位一律 km，镜头单位是行星半径。 */
(function () {
  'use strict';
  const T = window.TAICHU;
  const M = T.M;

  // ── 大气：正片、查找表生成、自检探针共用这一份 ──
  // 查找表存的是三种成分沿光线的"柱密度"（km·海平面密度），不是透射率：
  // 早期浑浊大气只改系数倍率 uAR / uAM，同一张表仍然成立。
  const ATMO = `
#include <common>
uniform sampler2D uLut;
uniform float uAR;
uniform float uAM;
const float RP = 6371.0, RT = 6471.0;
const vec3 BETA_R = vec3(5.802e-3, 13.558e-3, 33.1e-3);
const float BETA_M = 3.996e-3, MIE_EXT = 1.11;
const vec3 BETA_O = vec3(0.650e-3, 1.881e-3, 0.085e-3);
const float H_R = 8.0, H_M = 1.2;
const float LUT_W = 256.0, LUT_H = 64.0;
const int LUT_N = 512;
vec3 density(float h) { return vec3(exp(-h / H_R), exp(-h / H_M), max(0.0, 1.0 - abs(h - 25.0) / 15.0)); }
// (RT-r)(RT+r) 而不是 RT²-r²：两个 4e7 量级的数相减会丢掉大气层这 100 km
float distTop(float r, float mu) { return max(0.0, -r * mu + sqrt(max((RT - r) * (RT + r) + r * r * mu * mu, 0.0))); }
vec3 columnToTop(float r, float mu, int n) {
  float dt = distTop(r, mu) / float(n);
  vec3 s = vec3(0.0);
  for (int i = 0; i < 2048; i++) {
    if (i >= n) break;
    float t = (float(i) + 0.5) * dt;
    s += density(sqrt(r * r + t * t + 2.0 * r * mu * t) - RP);
  }
  return s * dt;
}
float lutHT() { return sqrt((RT - RP) * (RT + RP)); }
// Bruneton 参数化：近地面与近地平线分到更多纹素
vec2 lutUv(float r, float mu) {
  r = clamp(r, RP, RT);
  float H = lutHT(), rho = sqrt(max((r - RP) * (r + RP), 0.0));
  float dmin = RT - r, dmax = rho + H;
  float xm = (distTop(r, mu) - dmin) / max(dmax - dmin, 1e-4), xr = rho / H;
  return vec2(0.5 / LUT_W + xm * (1.0 - 1.0 / LUT_W), 0.5 / LUT_H + xr * (1.0 - 1.0 / LUT_H));
}
vec3 extinction(vec3 col) { return uAR * BETA_R * col.x + vec3(uAM * BETA_M * MIE_EXT * col.y) + BETA_O * col.z; }
// 太阳在地平线以下 → 行星本影；用太阳视半径 0.27° 做半影
vec3 sunTrans(float r, float mu) {
  r = max(r, RP + 1e-3);
  float muH = -sqrt(max((r - RP) * (r + RP), 0.0)) / r;
  float vis = smoothstep(-0.0047, 0.0047, mu - muH);
  if (vis <= 0.0) return vec3(0.0);
  return vis * exp(-extinction(texture(uLut, lutUv(r, max(mu, muH))).xyz));
}
`;

  const LUT_FS = `
${ATMO}
void main() {
  float H = lutHT();
  float xm = (vUv.x - 0.5 / LUT_W) / (1.0 - 1.0 / LUT_W), xr = (vUv.y - 0.5 / LUT_H) / (1.0 - 1.0 / LUT_H);
  float rho = H * xr, r = sqrt(rho * rho + RP * RP);
  float dmin = RT - r, dmax = rho + H, d = dmin + xm * (dmax - dmin);
  float mu = d <= 0.0 ? 1.0 : clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
  fragColor = vec4(columnToTop(r, mu, LUT_N), 1.0);
}`;

  // ── 地形与云：正片和高程直方图共用 ──
  const SURF = `
#include <noised>
uniform vec3 uSeedOff;
uniform float uT;
uniform float uMaxOct;
const float TF = 1.6, HS = 8.5;
// 域扭曲 fbm，高程 km；梯度经扭曲的雅可比链式求导，全部解析，没有有限差分
vec4 terrain(vec3 nb, float fp) {
  vec3 p = nb * TF + uSeedOff;
  vec4 wx = gnoised(p * 0.7 + vec3(3.1, 0.0, 0.0)), wy = gnoised(p * 0.7 + vec3(0.0, 7.7, 1.9)), wz = gnoised(p * 0.7 + vec3(5.3, 0.0, 9.1));
  vec3 q = p + 0.5 * vec3(wx.x, wy.x, wz.x);
  float h = 0.0, a = 1.0, f = 1.0;
  vec3 g = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    // 小于约 2 个像素的八度淡出：远处不闪
    float k = smoothstep(1.5 * fp, 4.0 * fp, RP / (TF * f));
    if (k <= 0.0 || float(i) >= uMaxOct) break;
    vec4 r = gnoised(q * f + float(i) * vec3(17.13, 31.71, 7.37));
    h += a * k * r.x; g += a * k * f * r.yzw;
    a *= i < 2 ? 0.6 : 0.47; f *= 2.0;
  }
  vec3 gp = g + 0.35 * (g.x * wx.yzw + g.y * wy.yzw + g.z * wz.yzw);
  return vec4(HS * h - 1.3, HS * TF * gp);
}
vec3 rotY(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x + s * p.z, p.y, c * p.z - s * p.x); }
// 云：按纬度带不同速度流动（信风向西、西风带向东）；两相流图交替，剪切不会无限累积
float cloudField(vec3 nb, float fp, float maxo) {
  float w = 0.0055 * cos(3.0 * asin(clamp(nb.y, -1.0, 1.0)));
  float tt = uT / 24.0, v = 0.0, w2 = 0.0;
  for (int j = 0; j < 2; j++) {
    float ph = fract(tt + 0.5 * float(j)), cy = floor(tt + 0.5 * float(j));
    float wt = 1.0 - abs(2.0 * ph - 1.0);
    if (wt < 1e-3) continue;
    vec3 p = rotY(nb, w * ph * 24.0 + 0.0015 * uT) * vec3(2.6, 4.4, 2.6) + uSeedOff.zxy + vec3(1.7, 0.4, 2.3) * mod(cy + float(j) * 3.0, 7.0);
    // 气旋：沿低频场的等值线推移（梯度 × 法向），越靠近极值转得越多 → 涡旋臂；两级，大的强、小的弱
    vec4 v1 = gnoised(p * 0.42 + 2.0);
    p += 0.75 * cross(v1.yzw, nb) / (0.6 + length(v1.yzw));
    vec4 v2 = gnoised(p * 1.1 + 6.0);
    p += 0.1 * cross(v2.yzw, nb) / (0.8 + length(v2.yzw)) + 0.2 * vec3(v2.x, 0.0, -v2.x);
    p += 0.45 * vec3(gnoise(p * 0.7 + 2.0), 0.0, gnoise(p * 0.7 + 8.0));
    // 锋面：低频脊线噪声给出拉长的云带
    float fr = gnoise(p * 0.5 + 11.0); fr = 1.0 - 6.0 * fr * fr;
    float s = 0.16 * (fr * fr * fr - 0.25), a = 1.0, f = 1.0;
    for (int i = 0; i < 12; i++) {
      float k = smoothstep(1.5 * fp, 4.0 * fp, RP / (2.6 * f));
      if (k <= 0.0 || float(i) >= maxo) break;
      if (i == 3) p += 0.03 * vec3(gnoise(p * 3.0 + 1.0), 0.0, gnoise(p * 3.0 + 5.0));   // 小尺度扭曲：边缘破碎
      s += a * k * gnoise(p * f + float(i) * vec3(5.1, 9.3, 2.7));
      a *= i < 2 ? 0.5 : 0.68; f *= 2.0;
    }
    v += wt * s; w2 += wt * wt;
  }
  // 两个独立场线性混合会降低方差，按权重的二范数归一，覆盖率不随相位起伏
  return v / sqrt(max(w2, 1e-4));
}
`;

  const HMAP_FS = `
#include <common>
const float RP = 6371.0;
${SURF}
void main() {
  float lat = (vUv.y - 0.5) * PI, lon = vUv.x * TAU;
  fragColor = vec4(terrain(vec3(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon)), 40.0).x, 0.0, 0.0, 1.0);
}`;

  const MAIN_FS = `
#include <ray>
#include <sky>
#include <hash>
#include <blackbody>
${ATMO}
${SURF}
uniform vec3 uSunDir;
uniform mat3 uBody;
uniform float uEsun, uSea, uTplate, uTcrack, uCrackW, uLavaK, uCloudCov, uCloudMax, uSteam, uGreen, uIce, uLights, uFlashK, uWeather;
uniform vec4 uImp[6];
uniform int uSteps;
uniform uint uSeedU;
// 可见光辐亮度随温度：按 600 nm 处的普朗克函数相对 1600 K 标定（总功率 ∝ T⁴，可见光段比它陡得多，所以板块是黑的）
vec3 glow(float K) { return blackbody(K) * 9.0 * (exp(14.9875) - 1.0) / (exp(min(23980.0 / K, 80.0)) - 1.0); }
vec3 lava(vec3 nb, float fp, out float broad) {
  vec3 p = nb * 4.0 + uSeedOff * 1.3;
  vec3 q = p + 0.5 * vec3(gnoise(p * 0.6 + 4.0), gnoise(p * 0.6 + 8.0), gnoise(p * 0.6 + 12.0));
  float n1 = gnoise(q), n2 = gnoise(q * 2.7 + 3.3);
  float px = fp / RP * 8.0;
  // 裂纹宽度不小于约一个像素；被加宽时按面积降亮度，远处不闪
  float w1 = max(uCrackW, 1.2 * px), w2 = max(uCrackW * 0.6, 3.2 * px);
  float c1 = (1.0 - smoothstep(0.0, w1, abs(n1))) * uCrackW / w1;
  float c2 = (1.0 - smoothstep(0.0, w2, abs(n2))) * uCrackW * 0.6 / w2 * 0.5;
  broad = 1.0 - smoothstep(0.0, 0.35, abs(n1));
  float Tp = uTplate + 120.0 * gnoise(p * 2.0) * saturate((uTplate - 600.0) / 900.0);
  return mix(glow(Tp), glow(uTcrack), saturate(max(c1, c2)));
}
vec3 impacts(vec3 nb) {
  vec3 e = vec3(0.0);
  for (int k = 0; k < 6; k++) {
    float age = uT - uImp[k].w;
    if (age < 0.0 || age > 30.0) continue;
    float sz = length(uImp[k].xyz);
    float ang = acos(clamp(dot(nb, uImp[k].xyz / sz), -1.0, 1.0));
    // 白闪升起 0.3 s、衰减约 1.5 s；之后是扩张的发光环与慢慢变暗的熔融坑
    float fl = smoothstep(0.0, 0.3, age) * exp(-max(age - 0.3, 0.0) / 0.7) * uFlashK;
    e += vec3(1.0, 0.96, 0.9) * 40.0 * fl * exp(-sq(ang / (sz * (0.5 + 1.2 * min(age, 1.0)))));
    float rr = sz * (0.5 + 1.6 * sqrt(age / 4.0)), rw = sz * (0.18 + 0.12 * age);
    e += glow(700.0 + 1100.0 * exp(-age / 2.5)) * exp(-sq((ang - rr) / rw)) * smoothstep(0.0, 0.25, age);
    e += glow(mix(uTplate, 1700.0, exp(-age / 6.0))) * (1.0 - smoothstep(0.55 * sz, 0.9 * sz, ang)) * smoothstep(0.1, 0.6, age);
  }
  return e;
}
vec3 lightning(vec3 nb) {
  vec3 s = vec3(0.0);
  for (int k = 0; k < 3; k++) {
    float x = uT * 1.7 + float(k) * 0.37, slot = floor(x), ph = x - slot;
    vec4 h = hash4u(uvec4(uint(slot + 4096.0), uint(k), uSeedU, 77u));
    if (h.w > 0.5) continue;
    vec3 d = normalize(h.xyz * 2.0 - 1.0);
    float fl = exp(-ph * 30.0) + 0.6 * step(0.12, ph) * exp(-(ph - 0.12) * 35.0);
    s += vec3(0.75, 0.82, 1.0) * 5.0 * fl * exp(-(1.0 - dot(nb, d)) / 0.00012);
  }
  return s * uSteam;
}
float specGGX(vec3 N, vec3 V, vec3 Lb, float a) {
  vec3 H = normalize(V + Lb);
  float NoL = max(dot(N, Lb), 0.0), NoV = max(dot(N, V), 1e-3), NoH = max(dot(N, H), 0.0), VoH = max(dot(V, H), 0.0);
  float a2 = a * a, d = NoH * NoH * (a2 - 1.0) + 1.0;
  float vis = 0.5 / (NoL * sqrt(NoV * NoV * (1.0 - a2) + a2) + NoV * sqrt(NoL * NoL * (1.0 - a2) + a2) + 1e-5);
  return a2 / (PI * d * d) * vis * (0.02 + 0.98 * pow(1.0 - VoH, 5.0)) * NoL;
}
// 边缘留一段半透明（薄云），厚云才不透光
float cloudThr() { return mix(0.9, -0.85, uCloudCov); }
float cloudAlpha(float c) { float thr = cloudThr(); return uCloudMax * (0.38 * smoothstep(thr - 0.05, thr + 0.07, c) + 0.62 * smoothstep(thr + 0.05, thr + 0.24, c)); }

void main() {
  vec3 rd = cameraRay(vUv), ro = uCamPos * RP, L = uSunDir;
  vec3 SUN = blackbody(5800.0) * uEsun;
  float mu = dot(rd, L);
  vec3 bg = sky(rd, uPixAngle) * 0.45 + SUN * 12.0 * smoothstep(0.99997, 0.99999, mu);
  // 先减去行星中心（相机本来就在以行星为原点的坐标里），用最近点距离写判别式：r² − d² = (r − d)(r + d)
  float b = dot(ro, rd), dc = length(ro - b * rd);
  float dA = (RT - dc) * (RT + dc);
  if (dA <= 0.0 || -b + sqrt(dA) <= 0.0) { fragColor = vec4(bg, 1.0); return; }
  float sA = sqrt(dA), tA = max(-b - sA, 0.0), tB = -b + sA;
  float dP = (RP - dc) * (RP + dc);
  bool hit = dP > 0.0 && -b - sqrt(dP) > 0.0;
  if (dP > 0.0 && -b + sqrt(dP) > 0.0 && !hit) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }   // 镜头被推进了地下
  float tEnd = hit ? -b - sqrt(dP) : tB;
  vec3 Lb = uBody * L, Vb = uBody * (-rd);

  // ── 云层：8–12 km 的薄壳，取 10 km 处一层 ──
  float RC = RP + 10.0, dC = (RC - dc) * (RC + dc), tC = 1e9, aC = 0.0;
  vec3 cloudRad = vec3(0.0);
  if (uCloudCov > 0.0 && dC > 0.0 && -b - sqrt(dC) > 0.0) {
    tC = -b - sqrt(dC);
    vec3 nw = (ro + rd * tC) / RC, nb = uBody * nw;
    float c = cloudField(nb, tC * uPixAngle, uMaxOct - 1.0);
    aC = cloudAlpha(c);
    aC = 1.0 - pow(1.0 - aC, 1.0 / max(abs(dot(nw, rd)), 0.15));   // 斜看时光程更长
    float muS = dot(nb, Lb), thick = smoothstep(cloudThr() + 0.02, cloudThr() + 0.45, c);
    vec3 Ts = sunTrans(RC, muS);
    cloudRad = SUN * Ts * (1.05 / PI) * mix(0.42 + 0.2 * (1.0 - uSteam), 1.0, thick) * (0.85 * sqrt(saturate(muS + 0.01)) + 0.1 * smoothstep(-0.05, 0.3, muS));   // 云顶起伏：近晨昏线仍被掠射照亮，红边因此看得见
    cloudRad += SUN * (1.0 - exp(-uAR * BETA_R * H_R)) * 0.2 * smoothstep(-0.1, 0.4, muS);
    if (uLavaK > 0.0) {   // 云底透出下方岩浆的暗红：只透出大尺度的裂纹网
      float broad; lava(nb, 300.0, broad);
      cloudRad += (glow(uTcrack) * 0.15 + glow(uTplate) * 0.4) * (0.25 + 0.75 * broad) * 2.0 * uLavaK * uSteam;
    }
    cloudRad += lightning(nb);
  }

  // ── 地表 ──
  vec3 groundRad = vec3(0.0);
  if (hit) {
    vec3 nb = uBody * ((ro + rd * tEnd) / RP);
    float fp = tEnd * uPixAngle;
    vec4 tr = terrain(nb, fp);
    float h = tr.x, muS = dot(nb, Lb), lat = asin(clamp(nb.y, -1.0, 1.0));
    vec3 gt = tr.yzw - dot(tr.yzw, nb) * nb;
    vec3 E = SUN * sunTrans(RP + max(max(h, uSea), 0.0), muS);
    if (uCloudCov > 0.0 && muS > -0.02) {   // 云影：沿太阳方向找到 10 km 高处的那一点
      vec3 ns = normalize(nb * RP + Lb * (10.0 / max(muS, 0.08)));
      E *= 1.0 - 0.75 * cloudAlpha(cloudField(ns, 60.0, 3.0));
    }
    vec3 amb = SUN * (1.0 - exp(-uAR * BETA_R * H_R)) * 0.3 * smoothstep(-0.12, 0.35, muS);
    amb += SUN * 0.1 * uCloudCov * uCloudCov * smoothstep(-0.05, 0.4, muS);   // 云缝里有光：四周云壁把光散进缝里
    float ice = 0.0;
    if (h < uSea) {
      float depth = uSea - h;
      // 近岸浅水偏青（大陆架）；新生的海浑浊、浅，偏青绿
      float young = 1.0 - smoothstep(44.0, 60.0, uT);
      vec3 alb = mix(vec3(0.004, 0.014, 0.032), mix(vec3(0.02, 0.1, 0.11), vec3(0.045, 0.15, 0.12), young), exp(-depth / (0.5 + 1.0 * young)));
      ice = uIce * smoothstep(1.2, 1.32, abs(lat) + 0.05 * gnoise(nb * 9.0));
      vec4 wn = gnoised(nb * 70.0 + uSeedOff);
      vec3 Nw = normalize(nb + 0.012 * (wn.yzw - dot(wn.yzw, nb) * nb));
      float rough = 0.06 + 0.06 * saturate(gnoise(nb * 11.0) + 0.5);
      groundRad = alb / PI * (E * max(muS, 0.0) + amb) + E * specGGX(Nw, Vb, Lb, rough) * (1.0 - ice);
      groundRad = mix(groundRad, vec3(0.72, 0.76, 0.8) / PI * (E * max(muS, 0.0) + amb), ice);
    } else {
      vec3 N = normalize(nb - 6.0 * gt / RP);
      float above = h - uSea, mz = gnoise(nb * 2.3 + uSeedOff.yzx) + 0.5 * gnoise(nb * 5.1 + 3.0);
      float moist = 0.54 + 0.7 * mz - 0.25 * exp(-sq((abs(lat) - 0.4) / 0.12));
      float rv = saturate(gnoise(nb * 17.0) + 0.5);
      vec3 rock = mix(vec3(0.045, 0.042, 0.04), mix(vec3(0.17, 0.14, 0.11), vec3(0.12, 0.11, 0.1), rv), uWeather);
      // 沙漠浅褐（带一点红土的变化）、山地灰褐
      vec3 sand = mix(vec3(0.46, 0.35, 0.21), vec3(0.42, 0.26, 0.15), saturate(gnoise(nb * 6.0 + 2.0) + 0.5));
      vec3 alb = mix(rock, sand, (1.0 - smoothstep(0.28, 0.42, moist)) * uWeather);
      float front = uGreen * 3.0;
      float veg = smoothstep(0.42, 0.55, moist) * (1.0 - smoothstep(front - 0.5, front, above)) * step(1e-4, uGreen);
      vec3 vegc = mix(vec3(0.03, 0.068, 0.02), mix(vec3(0.065, 0.1, 0.03), vec3(0.15, 0.14, 0.065), saturate(0.6 - 2.5 * (moist - 0.45))), saturate(gnoise(nb * 23.0) + 0.5 + 0.6 * (0.62 - moist)));
      alb = mix(alb, vegc, veg);
      alb = mix(alb, mix(vec3(0.16, 0.14, 0.12), vec3(0.11, 0.1, 0.095), rv), smoothstep(1.6, 2.6, above + 0.5 * gnoise(nb * 13.0)) * uWeather * 0.85);
      ice = uIce * max(smoothstep(1.08, 1.22, abs(lat) + 0.08 * gnoise(nb * 7.0)), smoothstep(3.3, 4.2, h + 0.4 * gnoise(nb * 31.0)));
      alb = mix(alb, vec3(0.72, 0.76, 0.8), ice);
      groundRad = alb / PI * (E * max(dot(N, Lb), 0.0) + amb);
      if (uLavaK > 0.0) { float br; groundRad += (lava(nb, fp, br) + impacts(nb)) * uLavaK; }
      if (uLights > 0.0 && muS < 0.02) {   // 夜面海岸极稀疏的灯火；像素大于格子时换成平均值
        float cell = RP / 700.0;
        vec3 cq = nb * 700.0, ci = floor(cq), hh = hash33(ci + 13.0), cf = cq - ci - (0.25 + 0.5 * hh);
        float dotv = exp(-dot(cf, cf) * 40.0) * step(0.88, hh.x);
        float lit = mix(dotv, 0.12 * 0.03, smoothstep(0.4 * cell, 1.5 * cell, fp));
        groundRad += blackbody(2700.0) * 0.5 * lit * (1.0 - smoothstep(0.03, 0.4, above)) * smoothstep(0.02, -0.1, muS) * uLights;
      }
    }
  }

  // ── 沿视线的单次散射：在近地点（或地面）一侧加密的非均匀步长 ──
  float tp = clamp(-b, tA, tEnd), L1 = tp - tA, L2 = tEnd - tp, fs = L1 / max(L1 + L2, 1e-3);
  vec3 colV = vec3(0.0), sR = vec3(0.0), sM = vec3(0.0), TvC = vec3(1.0);
  bool past = false;
  float n = float(uSteps);
  for (int i = 0; i < 32; i++) {
    if (i >= uSteps) break;
    float x = (float(i) + 0.5) / n, t, ds;
    if (x < fs) { float u = x / fs; t = tA + L1 * (1.0 - sq(1.0 - u)); ds = 2.0 * L1 * (1.0 - u) / (n * fs); }
    else { float u = (x - fs) / max(1.0 - fs, 1e-4); t = tp + L2 * u * u; ds = 2.0 * L2 * u / (n * max(1.0 - fs, 1e-4)); }
    vec3 p = ro + rd * t;
    float r = length(p);
    vec3 dn = density(r - RP) * ds;
    colV += 0.5 * dn;
    if (!past && t > tC) { past = true; TvC = exp(-extinction(colV)); }
    vec3 w = exp(-extinction(colV)) * sunTrans(r, dot(p, L) / r) * (t > tC ? 1.0 - aC : 1.0);
    sR += w * dn.x; sM += w * dn.y;
    colV += 0.5 * dn;
  }
  if (!past) TvC = exp(-extinction(colV));
  vec3 Tend = exp(-extinction(colV));
  float g = 0.8, pR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float pM = 3.0 / (8.0 * PI) * (1.0 - g * g) * (1.0 + mu * mu) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  vec3 inscat = SUN * (uAR * BETA_R * sR * pR + uAM * BETA_M * sM * pM);
  vec3 behind = hit ? groundRad : bg;
  fragColor = vec4(inscat + behind * Tend * (1.0 - aC) + cloudRad * TvC * aC, 1.0);
}`;

  const PROBE_FS = `
${ATMO}
uniform vec4 uQ[4];
void main() {
  int i = int(gl_FragCoord.x);
  vec4 o = vec4(0.0);
  if (int(gl_FragCoord.y) == 0) o = vec4(sunTrans(uQ[i].x, uQ[i].y), 0.0);
  else if (i == 0) o = vec4(columnToTop(RP, 1.0, LUT_N), 0.0);
  else if (i == 1) o = vec4(BETA_R, BETA_M);
  fragColor = o;
}`;

  // ── 时间线（JS 侧唯一来源；着色器只拿结果） ──
  const sst = function (a, b, x) { const u = M.clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
  const kf = function (keys, t) {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) return keys[i - 1][1] + (keys[i][1] - keys[i - 1][1]) * sst(keys[i - 1][0], keys[i][0], t);
    return keys[keys.length - 1][1];
  };
  function sched(t, s) {
    const c = {};
    c.Tplate = 650 + 850 * Math.exp(-t / 4);
    c.Tcrack = 1650 - 500 * sst(2, 32, t);
    c.crackW = 0.017 - 0.009 * sst(0, 30, t);
    c.lavaK = 1 - sst(30, 40, t);
    c.cov = sst(11, 24, t) * (1 - 0.38 * sst(32, 44, t) - 0.12 * sst(44, 54, t));   // 成海时云层先破开，再退到今日约一半
    c.cmax = 0.985 - 0.06 * sst(34, 50, t);
    c.steam = sst(12, 22, t) * (1 - sst(33, 46, t));
    const x = M.clamp((t - 30) / 16, 0, 1);
    c.sea = t < 30 ? s.hmin - 1 : s.hmin - 0.3 + (s.hsea - s.hmin + 0.3) * (1 - (1 - x) * (1 - x));
    const a = sst(46, 60, t);
    c.aR = 0.5 + 0.5 * a; c.aM = 6 - 5 * a;
    c.weather = sst(26, 44, t);
    c.green = sst(60, 75, t); c.ice = sst(40, 56, t); c.lights = sst(68, 73, t);
    const cf = c.crackW * 2.5, Tl = c.Tplate * (1 - cf) + c.Tcrack * cf;
    c.Tmean = Tl + (288 - Tl) * sst(24, 46, t);
    return c;
  }

  // 恒星方向几乎水平，晨昏线从世界 Y 轴旁边约 7° 经过：低轨镜头在那里沿晨昏线看出去，左昼右夜。
  // OrbitCamera 的上方向是世界 Y，镜头只在 Y 附近横移，画面的滚转保持很小
  const SUN = M.norm([-0.85, 0.12, 0.53]);
  const E2 = M.norm([-SUN[2], 0, SUN[0]]), NIGHT = M.norm([-SUN[0], 0, -SUN[2]]);
  const TILT = 0.75, SPIN = 0.006, LON0 = 2.4;   // 低轨段正下方是一块大陆与它的海岸
  const AX = M.norm(M.add(M.scale([0, 1, 0], Math.cos(TILT)), M.scale(E2, Math.sin(TILT))));
  const BX0 = M.norm(M.sub(SUN, M.scale(AX, M.dot(SUN, AX)))), BZ0 = M.norm(M.cross(BX0, AX));
  function bodyRows(t) {
    const a = LON0 + SPIN * t, c = Math.cos(a), sn = Math.sin(a);
    return [M.add(M.scale(BX0, c), M.scale(BZ0, sn)), AX, M.add(M.scale(BX0, -sn), M.scale(BZ0, c))];
  }
  function bodyMat(t) {
    const r = bodyRows(t);
    return new Float32Array([r[0][0], r[1][0], r[2][0], r[0][1], r[1][1], r[2][1], r[0][2], r[1][2], r[2][2]]);
  }
  function toBody(d, t) { const r = bodyRows(t); return [M.dot(r[0], d), M.dot(r[1], d), M.dot(r[2], d)]; }
  function genImpacts(rng) {
    const a = new Float32Array(24), cd = [Math.sin(0.78), 0.1, Math.cos(0.78)];
    for (let k = 0; k < 6; k++) {
      const tk = 0.8 + k * 2.1 + rng() * 1.2;
      const d = M.norm(M.add(cd, [(rng() - 0.5) * 1.3, (rng() - 0.5) * 1.1, (rng() - 0.5) * 1.3]));
      const nb = toBody(d, tk), sz = 0.03 + 0.035 * rng();
      a.set([nb[0] * sz, nb[1] * sz, nb[2] * sz, tk], k * 4);
    }
    return a;
  }

  // ── 镜头 ──
  function groundDir(phi, psi) {
    const c = Math.cos(phi);
    return M.norm(M.add(M.add(M.scale([0, 1, 0], c * Math.cos(psi)), M.scale(E2, c * Math.sin(psi))), M.scale(NIGHT, Math.sin(phi))));
  }
  function lowPose(t) {
    const phi = kf([[60, -0.1], [64, -0.1], [67, -0.05], [71.5, 0.24], [74.5, 0.24], [78.5, -0.1]], t);
    const psi = -0.12 + 0.01 * (t - 60);
    const C = M.scale(groundDir(phi, psi), 1.3), tg = groundDir(phi, psi + 0.27), d = M.sub(C, tg), dist = M.len(d);
    return { az: Math.atan2(d[0], d[2]), el: Math.asin(d[1] / dist), dist: dist, target: tg, fov: 50 };
  }
  function orbitPose(t, rm) {
    if (t < 70) {   // 行星直径约占画面高 55–60%；略偏右，让亮面落在画面中部
      const az = kf([[0, 0.78], [16, 0.66], [40, 0.24], [52, 0.26], [60, 0.4]], t), k = 0.42 * (1 - sst(46, 60, t));
      return { az: az, el: kf([[0, 0.1], [60, 0.17]], t), dist: kf([[0, 5.3], [28, 5.0], [46, 4.8], [60, 3.8]], t),
        target: [-k * Math.cos(az), 0, k * Math.sin(az)], fov: 40 };
    }
    return { az: 0.42 + 0.01 * rm * (t - 78), el: 0.2 + 0.05 * Math.sin((t - 78) * 0.02), dist: 3.3, target: [0, 0, 0], fov: 40 };
  }
  function camPose(t, rm) {
    const o = orbitPose(t, rm);
    if (t < 60 || t > 86) return o;
    const lo = lowPose(t), w = sst(60, 64.5, t) * (1 - sst(78.5, 85, t));
    return { az: M.lerp(o.az, lo.az, w), el: M.lerp(o.el, lo.el, w), dist: Math.exp(M.lerp(Math.log(o.dist), Math.log(lo.dist), w)),
      target: M.mix3(o.target, lo.target, w), fov: M.lerp(o.fov, lo.fov, w) };
  }

  function frameUniforms(ctx, s, t, imp) {
    const c = sched(t, s);
    return {
      uLut: s.lut, uT: t, uSunDir: SUN, uEsun: 4.0, uBody: bodyMat(t), uSeedOff: s.seedOff, uSea: c.sea,
      uTplate: c.Tplate, uTcrack: c.Tcrack, uCrackW: c.crackW, uLavaK: c.lavaK, uCloudCov: c.cov, uCloudMax: c.cmax,
      uSteam: c.steam, uAR: c.aR, uAM: c.aM, uGreen: c.green, uIce: c.ice, uLights: c.lights, uWeather: c.weather,
      uImp: imp, uFlashK: ctx.reducedMotion ? 0.5 : 1, uMaxOct: s.maxOct, uSteps: s.steps, uSeedU: ctx.seed >>> 0,
    };
  }
  function oceanCover(s, level) {
    const h = s.hs; let lo = 0, hi = h.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (h[m] < level) lo = m + 1; else hi = m; }
    return lo === 0 ? 0 : s.cw[lo - 1];
  }
  function checksum(f) {
    const u = new Uint32Array(f.buffer);
    let h = 0x811c9dc5;
    for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  T.registerChapter({
    id: 'azure', order: 4,
    title: '蔚蓝', latin: 'AZURE', epoch: '46 亿年前', lookback: 4.6, duration: 84,
    renderScale: 0.65, fadeIn: 'black',
    captions: [
      { t: 3.0, d: 5.0, text: '四十六亿年前。' },
      { t: 8.0, d: 6.0, text: '一颗普通恒星的第三颗行星，还是一片岩浆的海。' },
      { t: 18.0, d: 6.0, text: '它慢慢冷却，结出一层薄壳。' },
      { t: 31.0, d: 6.5, text: '水汽凝结成雨。雨下了很久，久到填满了海。' },
      { t: 48.0, d: 7.0, text: '天是蓝的，因为空气散射蓝光的本领，是红光的五倍多。' },
      { t: 61.0, d: 6.5, text: '然后，海岸线上出现了一点绿色。' },
      { t: 74.0, d: 7.0, text: '目前已知的全部生命，都在这一层薄薄的蓝色里。' },
    ],
    controls: ['拖动 环绕', '滚轮 远近'],
    anatomy: {
      lead: '每个像素沿视线穿过大气，逐段计算有多少星光被空气分子散射进你的眼睛。天的蓝、晨昏的红，都来自同一组实测系数。',
      equations: [
        { name: '瑞利散射', eq: 'β_R(λ) ∝ 1/λ⁴' },
        { name: '单次散射', eq: 'L = ∫ T(观测者→p)·β(h)·P(θ)·T(p→恒星)·E_sun ds' },
        { name: '透射率', eq: 'T = exp(−∫ β(h) ds)，  β(h) = β₀·e^(−h/H)' },
        { name: '瑞利相函数', eq: 'P(θ) = (3/16π)·(1 + cos²θ)' },
      ],
      notes: [
        '蓝光（440 nm）被散射的本领是红光（680 nm）的 (680/440)⁴ ≈ 5.7 倍。',
        '日落时光要斜穿过几百公里的空气，蓝光在半路就被散射掉了，剩下的是红。',
        '大气的厚度不到行星半径的百分之二。这里按真实比例画。',
      ],
      live: function (ctx, s) {
        const t = ctx.time, c = sched(t, s);
        const tau = c.aR * 13.558e-3 * 8 + c.aM * 3.996e-3 * 1.11 * 1.2 + 1.881e-3 * 15;
        const ago = t < 60 ? 46 - 8 * t / 60 : 4.7 * (1 - sst(60, 84, t));
        return [['地表平均温度', Math.round(c.Tmean) + ' K'], ['海洋覆盖率', Math.round(100 * (t < 30 ? 0 : oceanCover(s, c.sea))) + '%'],
          ['天顶透射率 550 nm', (100 * Math.exp(-tau)).toFixed(1) + '%'], ['距今', ago < 0.05 ? '今日' : ago.toFixed(1) + ' 亿年']];
      },
    },
    post: function (ctx, s) { const t = ctx.time;
      return { exposure: 1.0 + 0.45 * sst(60, 64, t) * (1 - sst(80, 86, t)), bloom: 0.42 + 0.26 * (1 - sst(20, 34, t)), bloomRadius: 0.7,
        // 进入蓝色行星之后把白平衡对到恒星光上（5800 K 的黑体偏暖，叠上散射会发粉）
        // 系数取 1/(5800 K 黑体 × 云顶处 θs≈53° 的透射率)，按亮度归一：日照下的云为中性白
        tint: [1 - 0.125 * sst(18, 44, t), 1 + 0.055 * sst(18, 44, t), 1 + 0.16 * sst(18, 44, t)] }; },

    init: function (ctx) {
      const G = ctx.G, q = ctx.quality;
      const rs = M.mulberry32((ctx.seed ^ 0x4A2E5) >>> 0);
      const s = {
        prog: G.fsProgram('azure/main', MAIN_FS),
        lut: G.target({ w: 256, h: 64, format: 'rgba16f', filter: 'linear', wrap: 'clamp' }),
        cam: new T.OrbitCamera({ az: 0.78, el: 0.1, dist: 6.6, fov: 40, minDist: 0.25, maxDist: 25, returnAfter: 6 }),
        seedOff: [rs() * 8, rs() * 8, rs() * 8], maxOct: q >= 2 ? 11 : q === 1 ? 9 : 7, steps: q >= 1 ? 16 : 10,
        cues: {}, imp: new Float32Array(24),
        probe: G.fsProgram('azure/probe', PROBE_FS),   // 自检探针在启动时编译，自检本身不花编译时间
      };
      // 透射率表（柱密度）：一次全屏着色器
      const lp = G.fsProgram('azure/lut', LUT_FS);
      G.bind(s.lut); lp.use(); G.fullscreen();
      // 高程直方图（按纬度面积加权）：决定最终海平面 = 71% 分位，以及海洋覆盖率读数
      const HW = 128, HH = 64, ht = G.target({ w: HW, h: HH, format: 'rgba32f', filter: 'nearest' });
      const hp = G.fsProgram('azure/hmap', HMAP_FS);
      G.bind(ht); hp.use().set({ uSeedOff: s.seedOff, uT: 0, uMaxOct: 11 }); G.fullscreen();
      const f = G.readFloat(ht, 0, 0, HW, HH), idx = [], wts = new Float64Array(HW * HH);
      let wsum = 0;
      for (let y = 0; y < HH; y++) for (let x = 0; x < HW; x++) { const i = y * HW + x; wts[i] = Math.cos(((y + 0.5) / HH - 0.5) * Math.PI); wsum += wts[i]; idx.push(i); }
      idx.sort(function (a, b) { return f[a * 4] - f[b * 4]; });
      s.hs = new Float32Array(idx.length); s.cw = new Float32Array(idx.length);
      let acc = 0;
      idx.forEach(function (i, k) { acc += wts[i] / wsum; s.hs[k] = f[i * 4]; s.cw[k] = acc; });
      const quant = function (p) { for (let k = 0; k < s.cw.length; k++) if (s.cw[k] >= p) return s.hs[k]; return s.hs[s.hs.length - 1]; };
      s.hmin = quant(0.004); s.hsea = quant(0.71); s.hmax = s.hs[s.hs.length - 1];
      [ht, hp, lp].forEach(function (o) { G.dispose(o); });
      return s;
    },

    enter: function (ctx, s) {
      s.cues = {};
      s.imp = genImpacts(ctx.rng);
      s.cam.resetUser();
    },

    update: function (ctx, s) {
      if (ctx.time >= 30 && !s.cues.rain) { s.cues.rain = true; ctx.cue('rain'); }
      if (ctx.time >= 60 && !s.cues.green) { s.cues.green = true; ctx.cue('green'); }
    },

    render: function (ctx, s) {
      s.cam.script(camPose(ctx.time, ctx.reducedMotion ? 0.5 : 1)).update(ctx);
      s.prog.use().set(Object.assign(frameUniforms(ctx, s, ctx.time, s.imp), s.cam.rayUniforms(ctx)));
      ctx.G.fullscreen();
    },

    selfTest: function (ctx, s) {
      const G = ctx.G, out = [];
      const pr = s.probe;
      const tg = G.target({ w: 4, h: 2, format: 'rgba32f', filter: 'nearest' });
      const RPk = 6371, MU89 = Math.cos(89 * Math.PI / 180);
      const Q = [[RPk, 0.5], [RPk + 10, 0.1], [RPk + 30, -0.05], [RPk, MU89]];
      G.bind(tg);
      pr.use().set({ uLut: s.lut, uAR: 1, uAM: 1, uQ: [].concat.apply([], Q.map(function (q) { return [q[0], q[1], 0, 0]; })) });
      G.fullscreen();
      const r = G.readFloat(tg, 0, 0, 4, 2);
      const BR = [r[20], r[21], r[22]], BM = r[23];   // 第二行：(0) 天顶柱密度，(1) 系数
      // 1) 1/λ⁴：着色器里实际使用的系数
      const ratio = BR[2] / BR[0], want = Math.pow(680 / 440, 4);
      out.push({ name: 'β_R(440)/β_R(680)（着色器系数）', expected: '5.70 ± 1%（(680/440)⁴ = ' + want.toFixed(3) + '）', measured: ratio.toFixed(3), pass: Math.abs(ratio / 5.70 - 1) <= 0.01 });
      // 2) 天顶光学厚度：查找表所用的同一个积分器 vs 解析式
      const tauN = BR[2] * r[16], tauA = BR[2] * 8 * (1 - Math.exp(-100 / 8));
      out.push({ name: '天顶瑞利光学厚度 440 nm', expected: tauA.toFixed(4) + ' ± 1%', measured: tauN.toFixed(4), pass: Math.abs(tauN / tauA - 1) < 0.01 });
      // 3) 查找表：正片的查表函数 vs CPU 双精度直接积分
      const cpuT = function (rr, mu) {
        const dTop = -rr * mu + Math.sqrt((6471 - rr) * (6471 + rr) + rr * rr * mu * mu), N = 6000, dt = dTop / N;
        let cr = 0, cm = 0, co = 0;
        for (let i = 0; i < N; i++) {
          const t = (i + 0.5) * dt, h = Math.sqrt(rr * rr + t * t + 2 * rr * mu * t) - 6371;
          cr += Math.exp(-h / 8); cm += Math.exp(-h / 1.2); co += Math.max(0, 1 - Math.abs(h - 25) / 15);
        }
        const BO = [0.650e-3, 1.881e-3, 0.085e-3];
        return [0, 1, 2].map(function (k) { return Math.exp(-(BR[k] * cr + BM * 1.11 * cm + BO[k] * co) * dt); });
      };
      let worst = 0;
      for (let k = 0; k < 3; k++) {
        const ref = cpuT(Q[k][0], Q[k][1]);
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(r[k * 4 + c] / ref[c] - 1));
      }
      out.push({ name: '透射率表 vs 直接积分（3 点 × RGB）', expected: '< 1%', measured: (100 * worst).toFixed(3) + '%', pass: worst < 0.01 });
      // 4) 晨昏线：地面、太阳天顶角 89°
      const t89 = [r[12], r[13], r[14]];
      const ok4 = t89[0] > t89[1] && t89[1] > t89[2] && t89[2] / t89[0] < 0.2;
      out.push({ name: '地面 θs = 89° 的透射率', expected: 'R > G > B，B/R < 0.2', measured: t89.map(function (v) { return v.toFixed(4); }).join(' / ') + '，B/R = ' + (t89[2] / t89[0]).toFixed(4), pass: ok4 });
      // 5) 确定性：两次从同一 seed 生成陨击、同一时刻渲染正片着色器，回读逐比特比较
      const pt = G.target({ w: 64, h: 36, format: 'rgba32f', filter: 'nearest' });
      const run = function () {
        const imp = genImpacts(M.mulberry32(ctx.seed >>> 0));
        G.bind(pt);
        s.prog.use().set(Object.assign(frameUniforms(ctx, s, 9.0, imp), s.cam.rayUniforms(ctx)));
        G.fullscreen();
        return checksum(G.readFloat(pt, 0, 0, 64, 36));
      };
      const c1 = run(), c2 = run();
      out.push({ name: '同一 seed 两次渲染 t = 9 的像素校验和', expected: c1, measured: c2, pass: c1 === c2 });
      out.push({ name: '高程：0.4% 分位 / 海平面（71% 分位）/ 最高', expected: '约 −6 / — / +5 km', measured: [s.hmin, s.hsea, s.hmax].map(function (v) { return v.toFixed(2); }).join(' / ') + ' km', pass: s.hmin > -9 && s.hmax < 9 });
      [tg, pt].forEach(function (o) { G.dispose(o); });
      return out;
    },
  });
})();
