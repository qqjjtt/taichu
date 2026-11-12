/* 太初 TAICHU — 第三幕「视界」horizon。
   每个像素向后追一条光线，在史瓦西时空里积分零测地线（rₛ = 1）。盘的上下两重像、光子环、多普勒增亮
   全部是积分结果。光线积分写成一份 GLSL（PHYS），正片与自检探测程序共用。 */
(function () {
  'use strict';
  const T = window.TAICHU;
  const M = T.M;

  const MAX_STEPS_HARD = 400;
  // 盘内缘峰值色温：外缘观测约 3200–3400 K（橙红），内圈金白，迎面一侧经多普勒到约 7800 K（蓝白），背离一侧深橙红
  const T_PEAK = 6100;
  const DISK_TIME_SCALE = 3.0;   // 每秒影片时间 = 3 rₛ/c 的盘内时间：内缘一圈约 15 s，外缘约 150 s

  // ── 共享物理：正片与 selfTest 拼进同一份源码 ──
  // 积分在辅助平直空间里做：d²x/dλ² = −(3/2)·h²·x/|x|⁵，h = |x × v| 守恒，λ 是仿射参数。
  const PHYS = `
const float R_IN = 3.0;
const float R_OUT = 14.0;
const float F_MAX = 0.00209800;   // r⁻³(1 − √(3/r)) 在 r = 49/12 处的极大
uniform float uDiskTime;
uniform float uDiskGain;
uniform float uObsBoost;          // 1/√(1 − rₛ/r_cam)：静止相机相对无穷远的引力蓝移
uniform float uTpeak;
uniform float uIgnite;            // 点燃前沿半径（开场由内向外推进）

vec3 geoAcc(vec3 x, float h2) {
  float r2 = dot(x, x);
  return -1.5 * h2 * x / (r2 * r2 * sqrt(r2));
}

// 静止观测者局域标架 → 坐标方向：径向分量乘 √(1 − rₛ/r)
vec3 localToCoord(vec3 pos, vec3 d) {
  vec3 n = normalize(pos);
  float dr = dot(d, n);
  return normalize(d + n * dr * (sqrt(1.0 - 1.0 / length(pos)) - 1.0));
}

// 像素 → 初始 (x, v)。正片与阴影自检走同一条路
void primaryRay(vec2 uv, out vec3 x, out vec3 v) {
  x = uCamPos;
  v = localToCoord(uCamPos, cameraRay(uv));
}

float escRadius(float rc) { return max(rc * 1.05, 30.0); }

// 红移因子 g = ν_obs/ν_emit（到无穷远）。vTraced 是被追踪的方向；光子真实传播方向是它的反向，
// 在交点处静止观测者的局域标架里量它与盘物质速度的夹角
float diskG(vec3 p, vec3 vTraced) {
  float r = length(p), f = 1.0 - 1.0 / r;
  vec3 n = p / r;
  vec3 k = -normalize(vTraced);
  vec3 kl = normalize(k + n * dot(k, n) * (1.0 / sqrt(f) - 1.0));
  vec3 u = normalize(vec3(-p.z, 0.0, p.x));
  float beta = sqrt(1.0 / (2.0 * (r - 1.0)));
  return sqrt(f) * sqrt(1.0 - beta * beta) / (1.0 - beta * dot(kl, u));
}

// 盘纹理：分形噪声，按像素在盘面上的足迹逐级关掉高频（掠射时不闪）
float diskNoise(vec3 q, float w) {
  float s = 0.0, a = 0.5, f = 1.0, nrm = 0.0;
  for (int i = 0; i < 5; i++) {
    float k = 1.0 - smoothstep(0.35, 0.8, f * w);
    if (k <= 0.0) break;   // 足迹已经盖过这一级：更高频的也一样，省掉
    s += a * k * gnoise(q * f);
    nrm += a;
    f *= 2.13; a *= 0.56;
    q = q.yzx + vec3(1.7, 9.2, 3.1);
  }
  // 足迹大到第一级就被关掉时 nrm = 0：返回噪声的均值 0，否则 0/0 = NaN 会在透镜像上打出黑色月牙（总装修复）
  return nrm > 0.0 ? s / nrm : 0.0;
}
float diskLayer(float r, float ang, float seed, float w) {
  // 方位向的空间频率远低于径向：丝缕沿轨道拉长
  vec3 q = vec3(cos(ang) * 1.5, sin(ang) * 1.5, r * 3.4 + seed);
  float n = diskNoise(q, w * 3.4), fine = 1.0 - smoothstep(0.1, 0.3, w * 14.0);
  if (fine > 0.0) n += 0.35 * fine * gnoise(vec3(cos(ang) * 5.0, sin(ang) * 5.0, r * 14.0 + seed));
  return n;
}
// 随盘共转坐标 (r, φ − Ω(r)·t)：较差自转会把图样无限缠紧，所以两层相位错开、轮流重置、交叉淡化
float diskTex(float r, float phi, float w) {
  const float P = 36.0;
  float om = sqrt(0.5 / (r * r * r));
  float u = uDiskTime / P;
  float f0 = fract(u), f1 = fract(u + 0.5);
  float c0 = floor(u), c1 = floor(u + 0.5);
  float w0 = 1.0 - abs(2.0 * f0 - 1.0);
  // 权重接近 0 的那一层不必算（每个周期里有一半时间只有一层占主导）
  float n0 = w0 > 0.01 ? diskLayer(r, phi - om * f0 * P, hash11(c0 + 0.37) * 40.0, w) : 0.0;
  float n1 = w0 < 0.99 ? diskLayer(r, phi - om * f1 * P, hash11(c1 + 0.71) * 40.0 + 50.0, w) : 0.0;
  float n = (n0 * w0 + n1 * (1.0 - w0)) / sqrt(w0 * w0 + sq(1.0 - w0));
  return exp(3.4 * n - 0.6);
}

// 一次穿越盘面：返回 (发光 rgb, 不透明度)
vec4 diskShade(vec3 p, vec3 v, float pathLen, float pixA) {
  if (uDiskGain <= 0.0) return vec4(0.0);   // 未点燃：盘既不发光也不遮光
  float r = length(p);
  // 点燃前沿由内向外推进：前沿之外的盘完全透明
  float edge = smoothstep(R_IN - 0.05, R_IN + 0.35, r) * (1.0 - smoothstep(R_OUT - 5.0, R_OUT, r))
             * (1.0 - smoothstep(uIgnite - 4.0, uIgnite, r));
  if (edge <= 0.0) return vec4(0.0);
  float F = (1.0 - sqrt(R_IN / max(r, R_IN))) / (r * r * r);
  float Fn = F / F_MAX;
  float Te = uTpeak * pow(Fn, 0.25);
  float g = diskG(p, v) * uObsBoost;
  // 像素足迹是盘面上的椭圆：短轴 pathLen·pixA，长轴沿视线在盘面的投影再除以 |cos|。
  // 丝缕的高频在径向，方位向很低频：取径向足迹（方位向按频率之比折算）。
  // 各向同性地用长轴会把侧面掠射处的丝缕整片抹平，在盘面地平线上留下一条硬的水平过渡
  vec3 vu = normalize(v);
  float fmin = pathLen * pixA, fmaj = fmin / max(abs(vu.y), 0.04);
  float wl = length(vu.xz);
  float cr = wl > 1e-4 ? dot(vu.xz / wl, p.xz / r) : 0.0, sr2 = 1.0 - cr * cr;
  float foot = max(sqrt(sq(fmaj * cr) + sq(fmin) * sr2), sqrt(sq(fmaj) * sr2 + sq(fmin * cr)) * 0.44 / r);
  float tex = diskTex(r, atan(p.z, p.x), foot);
  float alpha = edge * mix(0.45, 1.0, smoothstep(0.08, 0.9, tex));
  vec3 e = blackbody(g * Te) * (2.2 * g * g * g * g * Fn * tex * uDiskGain * alpha);
  return vec4(e, alpha);
}

// 返回 0 逃逸 / 1 落入视界 / 2 步数用尽 / 3 被盘挡死。x, v 原地推进；col, trans 前向后合成
int traceRay(inout vec3 x, inout vec3 v, float rEsc, int maxSteps, bool disk, float pixA,
             inout vec3 col, inout float trans, out int steps) {
  v = normalize(v);
  vec3 L = cross(x, v);
  float h2 = dot(L, L), h = sqrt(h2);
  vec3 a = geoAcc(x, h2);
  float path = 0.0;
  int crossings = 0;
  steps = 0;
  for (int i = 0; i < ${MAX_STEPS_HARD}; i++) {
    if (i >= maxSteps) return 2;
    steps = i;
    float r = length(x), rv = dot(x, v);
    // 光子球之内向里走的光线必然落入（有效势在 r < 1.5 单调）
    if (r < 1.5 && rv < 0.0) return 1;
    if (r > rEsc && rv > 0.0) {
      // 剩余的一阶偏折解析补上：(rₛ/b)(1 − cos∠(x, v))，与数值段连续衔接，不留接缝
      float vv = dot(v, v), vinf2 = max(vv - h2 / (r * r * r), 1e-12);
      vec3 vh = v / sqrt(vv), xh = x / r;
      vec3 perp = xh - dot(xh, vh) * vh;
      float pl = length(perp);
      if (pl > 1e-6) {
        float dlt = sqrt(vinf2) / max(h, 1e-9) * (1.0 - dot(xh, vh));
        v = vh * cos(dlt) - (perp / pl) * sin(dlt);
      }
      return 0;
    }
    // 步长与 r 成正比；靠近光子球时更细
    float ds = r * mix(0.03, 0.09, smoothstep(2.0, 8.0, r));
    float dl = ds / length(v);
    vec3 xn = x + v * dl + 0.5 * a * dl * dl;
    vec3 an = geoAcc(xn, h2);
    vec3 vn = v + 0.5 * (a + an) * dl;
    if (disk && x.y * xn.y <= 0.0 && x.y != xn.y && crossings < 6) {
      float t = x.y / (x.y - xn.y);
      vec3 p = mix(x, xn, t);
      // 高阶像（绕过光子球的光线）的光束发散远大于平直路径长：足迹按穿越次数放大，免得光子环上闪点
      vec4 e = diskShade(p, mix(v, vn, t), path + t * ds, pixA * (1.0 + 2.0 * float(crossings * crossings)));
      col += trans * e.rgb;
      trans *= 1.0 - e.a;
      crossings++;
      if (trans < 0.01) { x = xn; v = vn; return 3; }
    }
    path += ds;
    x = xn; v = vn; a = an;
  }
  return 2;
}
`;

  const HEAD = `
#include <ray>
#include <sky>
#include <hash>
#include <noise>
#include <blackbody>
`;

  const MAIN_FS = HEAD + PHYS + `
uniform mat3 uSkyRot;
uniform float uSkyGain;
uniform int uMaxSteps;
uniform vec2 uRes;
void trace1(vec2 uv, out vec3 col, out float trans, out int st, out vec3 sd) {
  vec3 x, v;
  primaryRay(uv, x, v);
  col = vec3(0.0); trans = 1.0;
  int steps;
  st = traceRay(x, v, escRadius(length(uCamPos)), uMaxSteps, true, uPixAngle, col, trans, steps);
  sd = uSkyRot * normalize(v);
}
void main() {
  vec3 col, sd; float trans; int st;
  trace1(vUv, col, trans, st, sd);
  // 像素在天球上的真实足迹（相邻像素出射方向之差）：光子环附近星空被极度压缩，按足迹滤波就不会闪
  float fp = max(length(dFdx(sd)), length(dFdy(sd)));
  float pa = clamp(fp, uPixAngle, 0.03);
  if (st == 0) col += trans * uSkyGain * sky(sd, pa);
  // 临界曲线附近（碰撞参数接近 b_c）亚像素级的结构最密：只在这一窄带里再追 4 条旋转网格子样本
  vec3 d0 = localToCoord(uCamPos, cameraRay(vUv));
  float rc = length(uCamPos), h0 = length(cross(uCamPos, d0));
  float b = h0 / sqrt(max(1.0 - h0 * h0 / (rc * rc * rc), 1e-6));
  if (abs(b - 2.598) < 0.35) {
    vec2 o[4] = vec2[4](vec2(0.125, 0.375), vec2(-0.375, 0.125), vec2(-0.125, -0.375), vec2(0.375, -0.125));
    for (int k = 0; k < 4; k++) {
      vec3 c2, s2; float t2; int st2;
      trace1(vUv + o[k] / uRes, c2, t2, st2, s2);
      if (st2 == 0) c2 += t2 * uSkyGain * sky(s2, pa);
      col += c2;
    }
    col /= 5.0;
  }
  fragColor = vec4(col, 1.0);
}`;

  const PROBE_FS = HEAD + PHYS + `
uniform int uMode;
uniform float uB0;
uniform float uDB;
uniform float uN;
void main() {
  float i = floor(gl_FragCoord.x);
  vec3 col = vec3(0.0);
  float trans = 1.0;
  int steps;
  vec3 x, v;
  vec4 o = vec4(0.0);
  if (uMode == 0) {          // 从 r = 1000 以碰撞参数 b 平行入射
    float b = uB0 + (i + 0.5) * uDB;
    x = vec3(b, 0.0, -1000.0); v = vec3(0.0, 0.0, 1.0);
    int st = traceRay(x, v, 1500.0, ${MAX_STEPS_HARD}, false, 0.0, col, trans, steps);
    o = vec4(float(st), float(steps), 0.0, 0.0);
  } else if (uMode == 1) {   // 弱场：从 r = 10⁴ 入射，积分到 1.2×10⁴ 再补尾段
    x = vec3(uB0, 0.0, -1.0e4); v = vec3(0.0, 0.0, 1.0);
    int st = traceRay(x, v, 1.2e4, ${MAX_STEPS_HARD}, false, 0.0, col, trans, steps);
    o = vec4(normalize(v), float(st));
  } else if (uMode == 2) {   // 阴影：与正片同一个 primaryRay，扫描中间一行
    primaryRay(vec2((i + 0.5) / uN, 0.5), x, v);
    int st = traceRay(x, v, escRadius(length(uCamPos)), ${MAX_STEPS_HARD}, false, 0.0, col, trans, steps);
    o = vec4(float(st), float(steps), 0.0, 0.0);
  } else {                   // r = 3 处正面出射（光子沿 +y 传播，被追踪方向为 −y）；另给 r = 4 侧视的迎面 / 背离两侧
    o = vec4(diskG(vec3(3.0, 0.0, 0.0), vec3(0.0, -1.0, 0.0)), diskG(vec3(4.0, 0.0, 0.0), vec3(0.0, 0.0, -1.0)),
             diskG(vec3(-4.0, 0.0, 0.0), vec3(0.0, 0.0, -1.0)), 0.0);
  }
  fragColor = o;
}`;

  // 单调三次样条（Fritsch–Carlson）：镜头连续、不过冲；两端速度为零
  function track(keys, t) {
    const n = keys.length;
    if (t <= keys[0][0]) return keys[0][1];
    if (t >= keys[n - 1][0]) return keys[n - 1][1];
    let i = 0;
    while (t > keys[i + 1][0]) i++;
    const sl = function (k) { return (keys[k + 1][1] - keys[k][1]) / (keys[k + 1][0] - keys[k][0]); };
    const tan = function (k) {
      if (k === 0 || k === n - 1) return 0;
      const a = sl(k - 1), b = sl(k);
      return a * b <= 0 ? 0 : 2 / (1 / a + 1 / b);
    };
    const hh = keys[i + 1][0] - keys[i][0], u = (t - keys[i][0]) / hh, u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * keys[i][1] + (u3 - 2 * u2 + u) * tan(i) * hh
      + (-2 * u3 + 3 * u2) * keys[i + 1][1] + (u3 - u2) * tan(i + 1) * hh;
  }

  // 最近点 r ≈ 15：相机始终在盘外缘（14）之外
  const K_DIST = [[0, 60], [12, 34], [27, 21], [40, 15], [51, 15.6], [62, 15], [70, 24], [78, 34]];
  const K_INCL = [[0, 77], [12, 78], [27, 83], [40, 85.5], [51, 84.2], [62, 85.5], [75, 40], [78, 40]];
  const K_AZ = [[0, -0.35], [40, 0.25], [62, 0.25 + Math.PI], [78, 0.75 + Math.PI]];
  const K_EXPO = [[0, 1.0], [62, 1.0], [76, 1.25]];
  const K_FOV = [[0, 38], [12, 42], [40, 52], [62, 52], [78, 50]];

  function camAt(t, reduced) {
    let az = track(K_AZ, t);
    if (t > 78) {   // 高纬缓慢环绕；从静止平滑起步
      const tt = t - 78, w = 0.035 * (reduced ? 0.5 : 1);
      az += tt < 6 ? w * tt * tt / 12 : w * (tt - 3);
    }
    return { az: az, el: M.rad(90 - track(K_INCL, t)), dist: track(K_DIST, t), fov: track(K_FOV, t) };
  }

  // 把开场视线对准银心稍偏处：星空本身不动，只是选了一个让银河带从洞后面经过的朝向
  function skyRotation() {
    const c0 = camAt(0), el = c0.el, az = c0.az;
    const a = M.norm([-Math.cos(el) * Math.sin(az), -Math.sin(el), -Math.cos(el) * Math.cos(az)]);
    const b = M.norm(M.add(M.add(M.scale([0.692829, -0.098851, 0.714295], 0.82), M.scale([0.655577, 0.498922, -0.566829], 0.57)), M.scale([-0.300346, 0.860991, 0.410472], 0.06)));
    const k = M.cross(a, b), s = M.len(k), c = M.dot(a, b);
    const n = M.scale(k, 1 / s);
    const K = [[0, -n[2], n[1]], [n[2], 0, -n[0]], [-n[1], n[0], 0]];
    const R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let kk = 0;
        for (let m = 0; m < 3; m++) kk += K[i][m] * K[m][j];
        R[i][j] += s * K[i][j] + (1 - c) * kk;
      }
    }
    // 列主序
    return new Float32Array([R[0][0], R[1][0], R[2][0], R[0][1], R[1][1], R[2][1], R[0][2], R[1][2], R[2][2]]);
  }

  // 0–7 s 盘严格为 0；7–17 s 由内圈向外圈点燃
  function diskGain(t) { return t <= 7 ? 0 : M.smootherstep(7, 15, t); }
  function igniteRadius(t) { return 2.0 + 17.0 * M.smootherstep(7, 17, t); }

  T.registerChapter({
    id: 'horizon', order: 3,
    title: '视界', latin: 'HORIZON', epoch: '约 100 亿年前', lookback: 10.0, duration: 78,
    renderScale: 0.6, fadeIn: 'black',
    captions: [
      { t: 3.0, d: 5.5, text: '最重的恒星死去时，会在时空里留下一个洞。' },
      { t: 14.0, d: 6.0, text: '它本身不发光。你看见的，是坠入它的物质最后的光。' },
      { t: 24.0, d: 7.0, text: '光在这里拐弯：盘的背面，被弯到了上方和下方。' },
      { t: 35.0, d: 6.5, text: '朝你转来的一侧更亮、更蓝——那是相对论。' },
      { t: 46.0, d: 6.5, text: '中间那圈细细的光环，是绕着黑洞转了半圈以上的光。' },
      { t: 64.0, d: 7.0, text: '视界之内，再没有消息传出来。' },
    ],
    controls: ['拖动 环绕', '滚轮 远近'],
    anatomy: {
      lead: '每个像素向后追一条光线，在史瓦西时空里一步一步积分它的测地线，直到它落进视界、撞上吸积盘，或逃向星空。',
      equations: [
        { name: '史瓦西度规', eq: 'ds² = −(1 − rₛ/r)·c²dt² + dr²/(1 − rₛ/r) + r²dΩ²' },
        { name: '光子轨道', eq: 'd²u/dφ² + u = (3/2)·rₛ·u²，  u = 1/r' },
        { name: '红移与多普勒', eq: 'g = √(1 − rₛ/r)·√(1 − β²) / (1 − β·cos ψ)' },
        { name: '观测亮度', eq: 'I_obs = g⁴·I_emit，  T_obs = g·T_emit' },
        { name: '阴影', eq: 'b_c = (3√3/2)·rₛ ≈ 2.598 rₛ' },
      ],
      notes: [
        '没有贴图，也没有后期合成的光环。上方和下方的弧，是同一个盘的背面被弯过来的像。',
        '真实吸积盘的温度在十万到千万开，主要辐射紫外线和 X 射线。这里把色温整体平移到可见光，保留相对关系。',
        '这是不自转的史瓦西黑洞。自转的克尔黑洞，阴影会略微不对称。',
      ],
      live: function (ctx, s) {
        return [
          ['相机距离', s.cam.curDist.toFixed(1) + ' rₛ'],
          ['倾角', (90 - M.deg(s.cam.curEl)).toFixed(0) + '°'],
          ['本帧渲染分辨率', ctx.width + '×' + ctx.height],
          ['每条光线最大步数', String(s.maxSteps)],
        ];
      },
    },
    post: function (ctx, s) { return { exposure: track(K_EXPO, ctx.time), bloom: 0.6, bloomRadius: 0.75, vignette: 0.32, saturation: 1.15 }; },

    init: function (ctx) {
      const G = ctx.G;
      const c0 = camAt(0);
      return {
        prog: G.fsProgram('horizon/main', MAIN_FS),
        cam: new T.OrbitCamera({ az: c0.az, el: c0.el, dist: c0.dist, fov: c0.fov, minDist: 15, maxDist: 120,
          minEl: -1.45, maxEl: 1.45, returnAfter: 7 }),
        skyRot: skyRotation(),
        maxSteps: [200, 280, 360][ctx.quality] || 280,
        cues: {},
      };
    },

    enter: function (ctx, s) { s.cues = {}; s.cam.resetUser(); },

    update: function (ctx, s) {
      if (ctx.time >= 40 && !s.cues.closest) { s.cues.closest = true; ctx.cue('closest'); }
    },

    render: function (ctx, s) {
      const c = camAt(ctx.time, ctx.reducedMotion);
      s.cam.script(c).update(ctx);
      const rc = Math.max(s.cam.curDist, 1.5), dg = diskGain(ctx.time);
      s.prog.use().set(Object.assign({
        uDiskTime: ctx.time * DISK_TIME_SCALE, uDiskGain: dg, uObsBoost: 1 / Math.sqrt(1 - 1 / rc), uTpeak: T_PEAK,
        uIgnite: igniteRadius(ctx.time),
        uSkyRot: s.skyRot, uSkyGain: M.lerp(1.0, 0.75, dg), uMaxSteps: s.maxSteps, uRes: [ctx.width, ctx.height],
      }, s.cam.rayUniforms(ctx)));
      ctx.G.fullscreen();
    },

    selfTest: function (ctx, s) {
      const G = ctx.G, out = [];
      const prog = G.fsProgram('horizon/probe', PROBE_FS);
      const N = 1024;
      const tgt = G.target({ w: N, h: 1, format: 'rgba32f', filter: 'nearest' });
      const base = { uDiskTime: 0, uDiskGain: 1, uObsBoost: 1, uTpeak: 10500 };
      const run = function (u) {
        G.bind(tgt);
        prog.use().set(Object.assign({}, base, u));
        G.fullscreen();
        return G.readFloat(tgt, 0, 0, N, 1);
      };
      const camU = function (r, thf) {
        return { uCamPos: [0, 0, r], uCamRight: [1, 0, 0], uCamUp: [0, 1, 0], uCamFwd: [0, 0, -1],
          uTanHalfFov: thf, uAspect: 1, uPixAngle: 2 * thf / N };
      };
      const dummyCam = camU(1000, 0.1);

      // 1) 临界碰撞参数：两轮扫描，找俘获 / 逃逸的分界
      let lo = 2.3, hi = 2.9;
      for (let round = 0; round < 2; round++) {
        const db = (hi - lo) / N;
        const f = run(Object.assign({ uMode: 0, uB0: lo, uDB: db, uN: N }, dummyCam));
        let k = 0;
        while (k < N && f[k * 4] !== 0) k++;
        const nlo = lo + (k - 1 + 0.5) * db, nhi = lo + (k + 0.5) * db;
        lo = nlo; hi = nhi;
      }
      const bc = 0.5 * (lo + hi), bcE = 1.5 * Math.sqrt(3);
      const e1 = Math.abs(bc / bcE - 1);
      out.push({ name: '临界碰撞参数 b_c（r = 1000 入射，二分）', expected: '2.598 rₛ ± 0.5%', measured: bc.toFixed(4) + ' rₛ（' + (e1 * 100).toFixed(3) + '%）', pass: e1 < 0.005 });

      // 2) 弱场偏折 b = 50
      const b = 50;
      const f2 = run(Object.assign({ uMode: 1, uB0: b, uDB: 0, uN: N }, dummyCam));
      const defl = Math.acos(M.clamp(f2[2], -1, 1)) * (f2[0] < 0 ? 1 : -1);
      const dE = 2 / b + (15 * Math.PI / 16) / (b * b);
      const e2 = Math.abs(defl / dE - 1);
      out.push({ name: '弱场偏折角（b = 50 rₛ）', expected: dE.toExponential(4) + ' rad ± 1%', measured: defl.toExponential(4) + ' rad（' + (e2 * 100).toFixed(3) + '%）', pass: e2 < 0.01 && f2[3] === 0 });

      // 3) 静止观测者在 r = 10 看到的阴影角半径（辛格公式）
      const thf = Math.tan(M.rad(20));
      const f3 = run(Object.assign({ uMode: 2, uB0: 0, uDB: 0, uN: N }, camU(10, thf)));
      let kr = N / 2;
      while (kr < N && f3[kr * 4] !== 0) kr++;
      let kl = N / 2 - 1;
      while (kl >= 0 && f3[kl * 4] !== 0) kl--;
      const ang = function (u) { return Math.atan(Math.abs(2 * u - 1) * thf); };
      const aMeas = 0.5 * (ang(kr / N) + ang((kl + 1) / N));
      const aE = Math.asin(1.5 * Math.sqrt(3) / 10 * Math.sqrt(1 - 1 / 10));
      const e3 = Math.abs(aMeas / aE - 1);
      out.push({ name: '阴影角半径（相机 r = 10，辛格公式）', expected: M.deg(aE).toFixed(3) + '° ± 1%', measured: M.deg(aMeas).toFixed(3) + '°（' + (e3 * 100).toFixed(3) + '%）', pass: e3 < 0.01 });

      // 4) 红移因子：r = 3 正面出射
      const f4 = run(Object.assign({ uMode: 3, uB0: 0, uDB: 0, uN: N }, dummyCam));
      out.push({ name: '红移因子 g（r = 3，正面出射）', expected: '0.7071 ± 0.001', measured: f4[0].toFixed(5), pass: Math.abs(f4[0] - Math.SQRT1_2) <= 0.001 });
      const gA = Math.sqrt(0.75) * Math.sqrt(1 - 1 / 6) / (1 - Math.sqrt(1 / 6)), gR = Math.sqrt(0.75) * Math.sqrt(1 - 1 / 6) / (1 + Math.sqrt(1 / 6));
      const ok5 = Math.abs(f4[1] - gA) < 1e-3 && Math.abs(f4[2] - gR) < 1e-3;
      out.push({ name: '红移因子 g（r = 4 侧视，迎面 / 背离）', expected: gA.toFixed(4) + ' / ' + gR.toFixed(4), measured: f4[1].toFixed(4) + ' / ' + f4[2].toFixed(4) + '（g⁴ 之比 ' + Math.pow(f4[1] / f4[2], 4).toFixed(0) + '×）', pass: ok5 });

      G.dispose(tgt); G.dispose(prog);
      return out;
    },
  });
})();
