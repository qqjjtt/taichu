# 章节作者指南

引擎已就绪并通过验收。这份指南写的是**代码的实际行为**；范例是 `src/chapters/0-testcard.js`（里面带 `window.__skip` 的几行是调试残留，忽略）。
读完本文件与范例就可以动手，不需要去读 `src/core` 的源码。

## 1. 最小章节

```js
(function () {
  'use strict';
  const T = window.TAICHU, M = T.M;
  const FS = `
#include <ray>
#include <sky>
uniform float uTime;
void main() { fragColor = vec4(sky(cameraRay(vUv), uPixAngle), 1.0); }`;

  T.registerChapter({
    id: 'horizon', order: 3, title: '视界', latin: 'HORIZON', epoch: '约 100 亿年前', lookback: 10.0, duration: 78,
    renderScale: 0.6, fadeIn: 'black',
    captions: [{ t: 3, d: 5.5, text: '……' }],
    controls: ['拖动 环绕', '滚轮 远近'],
    anatomy: { lead: '……', equations: [{ name: '……', eq: '……' }], notes: ['……'],
      live: function (ctx, s) { return [['相机距离', s.cam.curDist.toFixed(1) + ' rₛ']]; } },
    post: function (ctx, s) { return { bloom: 0.8, exposure: 1.0 }; },
    init: function (ctx) {            // 只调用一次（启动时，所有章节依次 init）
      return { prog: ctx.G.fsProgram('horizon/main', FS), cam: new T.OrbitCamera({ az: 0, el: 0.2, dist: 30, fov: 50 }), cues: {} };
    },
    enter: function (ctx, s) { s.cues = {}; s.cam.resetUser(); },   // 回到 t=0 的确定状态；会被多次调用
    update: function (ctx, s) {       // 推进模拟 ctx.dt；暂停 / 冻结时不调用；快进时 dt 恒为 1/60、ctx.seeking 为真
      if (ctx.time >= 40 && !s.cues.closest) { s.cues.closest = true; ctx.cue('closest'); }
    },
    render: function (ctx, s) {       // 每帧调用；场景目标（线性 HDR）已绑定并清黑
      s.cam.script({ az: 0.05 * ctx.time, dist: 30 }).update(ctx);
      s.prog.use().set(Object.assign({ uTime: ctx.time }, s.cam.rayUniforms(ctx)));
      ctx.G.fullscreen();
    },
    selfTest: function (ctx, s) { return [{ name: '……', expected: '……', measured: '……', pass: true }]; },
  });
})();
```

cue 要"每次 enter 只发一次"：像上面那样在 state 里记标志、`enter` 时清掉。

## 2. `ctx`

`gl` `G` `id` `time` `dt` `frameDt` `wall` `frame` `duration` `progress` `seeking` `width` `height` `aspect` `px`（= height/1080）`scene`
`bindScene()` `quality`（0/1/2）`seed` `reducedMotion` `rng()` `input` `audio` `cue(name, data)` `say(text, 秒)`。

- `ctx.width/height` 是场景目标的像素尺寸，**会随动态分辨率逐帧变化**。与屏幕等大的自有目标要在 `resize(ctx, s)` 里重建；模拟用的目标尺寸应与屏幕无关。
- `ctx.time` 会超过 `duration`（观众可以"驻留"）；之后画面要稳定。
- `ctx.input`：`x y`（[0,1]，原点左上）`nx ny`（NDC，y 向上）`down` `dx dy`（CSS 像素）`wheel` `pinch` `clicked clickX clickY` `keys` `pressed(code)` `idle`。逐帧量只在当帧有效，在 `render` 里读。

## 3. `T.G`

```js
G.fsProgram(name, fsSrc)            // 全屏三角形；片元里有 in vec2 vUv（[0,1]²，原点左下）
G.program(name, vsSrc, fsSrc)
prog.use().set({ uA: 1.5, uV: [x, y, z], uM: float32Array16, uTex: target, uTex2: target.texs[1], uSeed: 7 })
G.target({ w, h, format, filter, wrap, count, depth })   // → { tex, texs[], w, h, resize(w,h), dispose() }
G.double(opts)                      // → { read, write, swap(), resize(w,h), dispose() }
G.texture({ w, h, format, filter, wrap, data, mips })    // → { tex, w, h, set(data), dispose() }
G.bind(target)   G.clear(r, g, b, a)   G.blend('none' | 'add' | 'alpha' | 'premul')
G.fullscreen()   G.drawPoints(n)   G.drawTriangles(n)    // 后两者无顶点属性，着色器里用 gl_VertexID
G.readFloat(target, x, y, w, h, attachment)              // → Float32Array(w*h*4)
G.dispose(obj)   G.caps.{ floatLinear, floatBlend, maxTex }
```

- `format`：`rgba8 rgba16f rgba32f rg16f rg32f r16f r32f r8`；`filter`：`linear | nearest`；`wrap`：`clamp | repeat | mirror`。
- 着色器源码**不要写** `#version` 与 `precision`。`#include <name>` 递归展开（`curl` 会带上 `noised` `hash` `common`，等等），重复包含无害。片元着色器没有自己声明 `out` 时自动得到 `out vec4 fragColor;`。
- `set()` 按 uniform 的实际类型分发：`uint` / `int` / `bool` 传数字即可；数组传扁平数组；采样器收 `Target`（取 `texs[0]`）、`Tex` 或裸 `WebGLTexture`。纹理单元自动分配。被优化掉的 uniform 静默忽略。
- 编译失败会抛出带程序名、行号与上下文的错误，直接看 `shot.py` 输出的 `errors`。
- 自己绑过 FBO 之后，画回场景前调用 `ctx.bindScene()`。引擎在每次调用章节之后复位 GL 状态（混合、深度、纹理单元等），进入 `render` 时混合 / 深度测试都是关的。场景目标带深度缓冲，需要时自己 `gl.enable(gl.DEPTH_TEST)`。

### MRT 与 GPU 粒子（第二、六幕会用到）

```js
// init：位置与速度各一张 rgba32f，两个附件
s.st = G.double({ w: N, h: N, format: 'rgba32f', filter: 'nearest', count: 2 });
// 推进（片元着色器，自己声明两个输出）：
//   layout(location = 0) out vec4 oPos;  layout(location = 1) out vec4 oVel;
//   ivec2 p = ivec2(gl_FragCoord.xy);  vec4 pos = texelFetch(uPos, p, 0), vel = texelFetch(uVel, p, 0);
G.bind(s.st.write);
s.step.use().set({ uPos: s.st.read.texs[0], uVel: s.st.read.texs[1], uDt: DT });
G.fullscreen();  s.st.swap();
// 绘制（顶点着色器）：ivec2 p = ivec2(gl_VertexID % N, gl_VertexID / N);  vec4 pos = texelFetch(uPos, p, 0);
ctx.bindScene();  G.blend('add');
s.draw.use().set({ uPos: s.st.read.texs[0], uViewProj: s.cam.viewProj(ctx.aspect, 0.05, 500), uPx: ctx.px });
G.drawPoints(N * N);
```

初始状态：用一个"初始化着色器"按 `gl_FragCoord` 与哈希直接在 GPU 上生成（确定、快），或 CPU 生成 `Float32Array` 后 `G.texture({...data})` 再拷进去。模拟状态一律用 `texelFetch` 读（32 位浮点未必能线性过滤）。

### 固定子步

```js
s.acc = Math.min(s.acc + ctx.dt, DT * MAX_SUB);
while (s.acc >= DT) { stepOnce(); s.acc -= DT; s.steps++; }
```

快进时引擎以 dt = 1/60 连续调用 `update`（每个动画帧至多 120 次），所以"每次 update 的子步数"决定快进的代价：跳到 t=80 是 4800 次 update。

## 4. 共享着色器片段

| 片段 | 内容 |
|---|---|
| `common` | `PI` `TAU` `saturate` `sq` `remap(x,a,b,c,d)` `mat2 rot(a)` `luma(vec3)` |
| `hash` | `hashu(uint)` `hash4u(uvec4)→vec4` `hash11` `hash12` `hash13` `hash22` `hash32` `hash33` `hash43`，值域 [0,1)；另有 `pcg(uint)` `pcg3d(uvec3)` `pcg4d(uvec4)` |
| `noise` | `vnoise(vec3)` [0,1]；`gnoise(vec3)` `gnoise(vec2)` ≈[-1,1]；`fbm(p, int oct, float lac, float gain)`（vec3 / vec2）；`ridged(vec3, int oct)` [0,1] |
| `noised` | `vec4 gnoised(vec3)` = (值, 解析梯度 xyz)；`vec4 fbmd(vec3, int oct)` |
| `curl` | `vec3 curl(vec3)` 无散度 |
| `blackbody` | `blackbody(K)` 线性 sRGB、最大分量 = 1；`blackbodyN(K)` 亮度归一 |
| `color` | `linearToSrgb` `srgbToLinear` `aces` |
| `ray` | 声明 `uCamPos uCamRight uCamUp uCamFwd uTanHalfFov uAspect uPixAngle`；`vec3 cameraRay(vec2 uv)` |
| `sky` | `sky(dir, pixAngle)` `skyStars(dir, pixAngle)` `skyMilkyWay(dir)`；常量 `SKY_NG`（银河北极）`SKY_CG`（银心方向） |
| `dither` | `ign(fragCoord)` |

## 5. `T.OrbitCamera` 与 `T.M`

```js
const cam = new T.OrbitCamera({ az, el, dist, target: [0,0,0], fov: 45, minDist, maxDist, minEl, maxEl, damping: 0.92, returnAfter: 6 });
cam.script({ az, el, dist, target, fov }).update(ctx);   // 放在 render 开头；只传需要的字段
cam.viewProj(aspect, near, far)   cam.proj(aspect, near, far)   cam.view   cam.pos / right / up / fwd
cam.rayUniforms(ctx)              // 给 #include <ray> 用的全部 uniform（含 uPixAngle）
cam.curAz / curEl / curDist       // 叠加用户偏移之后的实际值
cam.resetUser()                   // 在 enter 里调用
```

Y 轴向上；`az` 绕 Y，`el` 是仰角，相机位于 `target + dist·(cos el·sin az, sin el, cos el·cos az)`。用户拖动 / 滚轮是叠加在导演机位上的偏移，停手数秒后自动回归。

`T.M`：`clamp saturate lerp remap smoothstep smootherstep damp(a,b,rate,dt) rad deg`；`M.ease.*`；`M.keyframes(keys, t, easeFn)`；`M.mulberry32(seed)`；`M.gauss(rng)`；三维向量 `add sub scale dot cross len norm mix3`；4×4 矩阵 `mat4 mul perspective lookAt translate rotX rotY rotZ invert xform`。

## 6. 亮度（场景是线性 HDR，默认曝光 1，ACES）

| 场景值 | 观感 |
|---|---|
| 0.01–0.05 | 刚好看得见的暗部（大面积背景、暗云） |
| 0.18 | 中灰 |
| 0.5–1.5 | 主体的正常亮度；1.0 已接近白 |
| 3–10 | 明确的高光，带小光晕 |
| 20–100 | 发光体，泛光烧出明显的长尾光晕 |

`sky()` 已是合适的 HDR 量级；要让它退后就乘 0.3–0.6。
点精灵小于约 1.5 像素会闪：`gl_PointSize = max(want, 1.5)`，并把亮度乘 `sq(want / gl_PointSize)` 保持能量（见范例）。点的大小乘 `ctx.px`。
后期参数缺省：`{ exposure: 1, bloom: 0.5, bloomRadius: 0.7, grain: 0.035, vignette: 0.3, aberration: 0.0015, saturation: 1, contrast: 1, tint: [1,1,1] }`。

## 7. selfTest 的写法

把要检验的 GLSL 函数写成一个 JS 字符串常量，正片程序与探测程序都拼进去；探测程序画到一张小的 `rgba32f` 目标，`G.readFloat` 读回来在 JS 里比较；最后 `G.dispose` 掉临时对象。不要碰正在显示的模拟状态。完整例子见范例末尾。

## 8. 常见坑

- 章节里不得用 `Math.random()`、`Date.now()`；注释里不得出现网址（构建会失败）。
- 单文件 ≤ 800 行。
- `init` 在启动时就执行：别在里面做几百毫秒的 CPU 计算；大的初始化交给 GPU。
- 向 `rgba32f` 目标做混合需要 `G.caps.floatBlend`；场景目标是 `rgba16f`，可以放心加色混合。
- 大坐标（上千）下的 float 精度：先平移到局部再算。
- 加色点精灵贴近镜头时会产生巨大的重绘：限制最大点径并让近处的点淡出。

## 9. 工具

```
python3 tools/shot.py --ch <id> --seq 2,15,30,45,60 --sheet     # 一张联系表看时间演化（时间递增）
python3 tools/shot.py --ch <id> --t 40 --w 1512 --h 982 --dpr 2  # 用户屏幕的真实分辨率
python3 tools/shot.py --ch <id> --selftest
python3 tools/shot.py --ch <id> --perf 4
python3 tools/shot.py --ch <id> --t 20 --do "drag:400,300,700,420;wait:0.5;shot:drag"
python3 tools/shot.py --ch <id> --t 5 --mobile
python3 tools/check.py --only <id>
```

输出 JSON 里的 `ok` / `errors` 是第一手信息；`stats.mean` 是画面平均亮度（0–1），全黑或过曝一眼可见。
