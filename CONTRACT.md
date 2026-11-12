# 《太初》共享契约

所有参与建造的实例都以本文件为准。它规定：做什么、谁拥有哪个文件、模块之间的接口、怎样算做完。
各幕的画面与物理细节在 `briefs/<id>.md`；引擎落地后的实际用法在 `CHAPTER_GUIDE.md`（由引擎实现者撰写，与本文件冲突时以**代码的实际行为**为准并上报）。

项目根目录（下文记作 ROOT）：
`<项目根目录>`

---

## 0. 这是什么

《太初》是一部在浏览器里实时运行的六幕"宇宙简史"：奇点 → 星系 → 视界 → 蔚蓝 → 生命 → 言。
每一幕都是一个真实的物理/数学模拟，在观众的显卡上当场计算；配乐同样由代码当场合成。
最终交付物是**一个 HTML 文件**：零素材、零依赖、零外部请求。

它要让人直观感到三件事：
1. **美**——每一帧都经得起截图；
2. **真**——不是特效，是方程。每一幕都带"解剖"面板（背后的方程与实时数值）和物理自检（实测值对理论值）；
3. **完整**——有开端、推进、收束，像一部作品而不是六个 demo 的拼盘。

观众：一位在 MacBook Pro（M4 Pro，3024×1964 Retina）上观看的中文用户；也可能被转给别人在普通笔记本或手机上打开。

## 1. 全局约束（每个任务都默认包含）

- **零外部请求**：不得出现 `fetch` / `XMLHttpRequest` / `WebSocket` / 动态 `import()` / `eval` / `new Function` / 任何外部 URL（注释里也不要写 URL，`tools/build.py` 会按字面扫描并拒绝构建）。不用任何图片、字体、音频文件或第三方库。一切画面与声音由代码生成。
- **技术栈**：原生 JavaScript（ES2020），经典脚本（非 module），每个文件一个 IIFE 且 `'use strict'`；WebGL2（GLSL ES 3.00）；WebAudio。不引入构建期转译。
- **确定性**：章节内不得使用 `Math.random()` 与 `Date.now()`；随机数一律来自 `ctx.rng()` 或以 `ctx.seed` 播种的着色器哈希。同样的 `seed` 与章内时间必须得到同样的画面（截图工具依赖这一点）。
- **文件归属**：只改你拥有的文件（见 §2）。发现别人文件的问题：写进 `notes/<你的id>.md`（现象、复现命令、建议改法），不要动手改。
- **体量**：单个源文件 ≤ 800 行。注释写"为什么"，不写"是什么"。界面文案与字幕一律简体中文，字幕逐字采用 §7 的定稿。
- **性能预算**：1280×720、DPR 1 下，整帧 GPU 耗时 ≤ 10 ms（`tools/shot.py --perf` 的 `gpuAvgMs`）；重型全屏着色器通过章节的 `renderScale` 降低内部分辨率来达标，而不是降低画面野心。
- **稳健**：不得有着色器编译错误、GL 错误（`?glerr=1` 时引擎每帧 `gl.getError()`）、控制台 error。章内时间超过 `duration` 之后画面必须保持稳定可看（"驻留"模式会无限停留）。`enter()` 可被多次调用，每次都回到 t=0 的确定状态。
- **安全与舒适**：不得有快于 3 Hz 的大面积闪烁。大爆炸的白闪升起 ≥ 0.3 s、衰减 ≥ 1.5 s。`ctx.reducedMotion` 为真时，闪光幅度减半、镜头自动运动减速一半。
- **移动端**：390×844 触摸视口下不崩溃、不出错、可观看（`ctx.quality` 为 0 或 1 时用更小的粒子数与模拟分辨率）。

## 2. 目录与归属

```
ROOT/
  CONTRACT.md            总设计（本文件）
  CHAPTER_GUIDE.md       引擎实现者：给章节作者的实用指南
  briefs/<id>.md         总设计：各幕 / 界面 / 配乐的详细任务书
  notes/<id>.md          任何人：跨文件问题上报
  dev.html               总设计：开发页加载器（勿改）
  tools/                 总设计：devserver.py shot.py check.py build.py（发现缺陷可修，并在 notes 里说明）
  src/core/00-namespace.js   总设计（勿改）
  src/core/10-math.js        引擎
  src/core/20-gl.js          引擎
  src/core/30-glsl.js        引擎
  src/core/40-post.js        引擎
  src/core/50-camera.js      引擎
  src/core/60-engine.js      引擎
  src/main.js                引擎
  src/chapters/0-testcard.js 引擎（开发用参考章，不进产物）
  src/ui/shell.html          界面
  src/ui/style.css           界面
  src/ui/ui.js               界面
  src/audio/audio.js         配乐
  src/chapters/1-singularity.js   第一幕
  src/chapters/2-galaxy.js        第二幕
  src/chapters/3-horizon.js       第三幕
  src/chapters/4-azure.js         第四幕
  src/chapters/5-life.js          第五幕
  src/chapters/6-logos.js         第六幕
  shots/<id>/            各自的截图输出目录
  dist/                  构建产物
```

章节文件名必须是 `<order>-<id>.js`。脚本加载顺序：`core/*`（按文件名）→ `audio/*` → `ui/*` → `chapters/*`（按文件名）→ `main.js`。
开发页的隔离规则：`?ch=<id>` 只加载那一章；`?ui=0` 不加载界面层；`?audio=0` 不加载配乐。截图工具默认 `ui=0&audio=0`，所以各幕作者互不干扰。
整片模式（不带 `ch`）下另有：`?only=a,b` 只加载列出的章节（`only=none` 一章也不加载）；`?devfilm=1` 时引擎把 dev 章也排进 `T.engine.film`（`T.params.devfilm`）。界面与配乐用 `only=testcard,probe&devfilm=1` 得到一部与六幕开发隔离的两幕小片来测。

## 3. 工具与验收

所有命令在 ROOT 下运行。无头 Chrome 使用本机真实 GPU（Apple M4 Pro / Metal），截图与用户看到的一致。

| 命令 | 用途 |
|---|---|
| `python3 tools/shot.py --ch <id> --t 20` | 单帧截图 + JSON 状态（错误、亮度统计） |
| `python3 tools/shot.py --ch <id> --seq 2,15,30,45,60 --sheet` | 多帧 + 联系表（一张图看时间演化；时间必须递增） |
| `python3 tools/shot.py --ch <id> --t 20 --w 1512 --h 982 --dpr 2` | 用户屏幕的真实分辨率 |
| `python3 tools/shot.py --ch <id> --perf 4` | 帧耗时与 GPU 耗时 |
| `python3 tools/shot.py --ch <id> --selftest` | 运行该章物理自检 |
| `python3 tools/shot.py --ch <id> --t 20 --do "drag:400,300,700,420;wait:0.5;shot:drag"` | 交互测试（动作见 `--help`） |
| `python3 tools/shot.py --ch <id> --t 5 --mobile` | 手机视口 |
| `python3 tools/shot.py --film --ui 1 --do "wait:2;shot:start"` | 整片流程 / 界面 |
| `python3 tools/check.py --only <id>` | 该章回归：多时间点 + 自检 + 性能 |
| `python3 tools/check.py` | 全片回归 |
| `python3 tools/build.py` | 构建单文件（含"零外部请求"静态守卫） |

**看图是验收的一部分。** 用 Read 打开截图，像挑剔的摄影指导一样判断：构图、曝光、色彩、细节、是否有条带/噪点/锯齿/闪烁伪影。数字全绿但画面平庸，不算完成。

## 4. 引擎接口

### 4.1 命名空间（`src/core/00-namespace.js`，已实现，直接读源码）

`window.TAICHU`（下文记作 `T`）：`T.chapters`、`T.registerChapter(def)`、`T.bus.on/off/emit`、`T.reportError(where, err)`、`T.errors`、`T.params`（开发参数）、`T.hashChapter()`、`T.glsl`；以及工具读取的 `window.__taichu`。

### 4.2 `T.G` — WebGL2 助手（`20-gl.js`）

```js
T.G = {
  gl,                                   // init 之后可用
  caps: { floatLinear, floatBlend, timerQuery, maxTex, maxPointSize },
  init(canvas) -> gl | null,            // 取不到 WebGL2 返回 null，不抛
  program(name, vsSrc, fsSrc) -> Program,
  fsProgram(name, fsSrc) -> Program,    // 内置全屏三角形顶点着色器，提供 in vec2 vUv（[0,1]²，原点左下）
  texture(opts) -> Tex,                 // opts: { w, h, format, filter, wrap, data, mips }
  target(opts) -> Target,               // opts: { w, h, format='rgba16f', filter='linear', wrap='clamp', count=1, depth=false }
  double(opts) -> { read, write, swap() },   // ping-pong
  bind(targetOrNull),                   // 绑定 FBO、设置 viewport 与 drawBuffers；null = 画布
  clear(r=0, g=0, b=0, a=1),
  blend(mode),                          // 'none' | 'add' | 'alpha' | 'premul'
  fullscreen(),                         // 用当前 program 画全屏三角形
  drawPoints(count),                    // 无属性 VAO；顶点着色器用 gl_VertexID 自行取数
  drawTriangles(count),                 // 同上，gl.TRIANGLES
  readFloat(target, x, y, w, h, attachment=0) -> Float32Array,   // 供 selfTest 回读
  dispose(obj),
};
Program: { name, use() -> this, set(uniforms) -> this, has(uniformName) -> bool }
Tex:     { tex, w, h, format, set(data) }
Target:  { fbo, tex, texs[], w, h, format, resize(w, h), dispose() }
```

- `format` 取 `'rgba8' | 'rgba16f' | 'rgba32f' | 'rg16f' | 'rg32f' | 'r16f' | 'r32f' | 'r8'`；`filter` 取 `'linear' | 'nearest'`；`wrap` 取 `'clamp' | 'repeat' | 'mirror'`。
- **着色器源码预处理**：自动加 `#version 300 es` 与 `precision highp float/int/sampler2D;`，章节源码里不要写。`#include <name>` 从 `T.glsl[name]` 展开（递归，每个片段至多一次）。片元着色器若没有自己声明 `out`，自动声明 `out vec4 fragColor;`。MRT 时自行写 `layout(location=N) out vec4 ...;`。
- **编译/链接失败**：抛出 Error，消息里有程序名、阶段、info log，以及出错行前后各 3 行带行号的源码。
- **`set(uniforms)`**：按 `getActiveUniform` 的类型分发。数字 → float 或 int；布尔 → int；长度 2/3/4 的数组 → vec；9 → mat3；16 → mat4；uniform 数组传扁平数组；`Tex` / `Target` / `WebGLTexture` → 采样器（纹理单元自 `use()` 起从 0 递增分配）。被优化掉的 uniform 静默忽略。

### 4.3 `T.glsl` — 共享着色器片段（`30-glsl.js`）

| 名字 | 提供 |
|---|---|
| `common` | `PI` `TAU` `saturate(x)` `sq(x)` `remap(x,a,b,c,d)` `mat2 rot(a)` `float luma(vec3)` |
| `hash` | 基于 uint PCG：`hash11 hash12 hash13`（→float）`hash22`（→vec2）`hash32 hash33`（→vec3）`hash43`（→vec4），值域 [0,1) |
| `noise` | `vnoise(vec3)` [0,1]；`gnoise(vec3)`、`gnoise(vec2)` ≈[-1,1]；`fbm(vec3 p, int oct, float lac, float gain)` 及 vec2 重载；`ridged(vec3 p, int oct)` [0,1] |
| `noised` | `vec4 gnoised(vec3)` = (值, 解析梯度)；`vec4 fbmd(vec3 p, int oct)` |
| `curl` | `vec3 curl(vec3 p)` 无散度向量场 |
| `blackbody` | `vec3 blackbody(float kelvin)` 线性 sRGB，最大分量归一为 1，1000–40000 K |
| `color` | `linearToSrgb` `srgbToLinear` `aces(vec3)` |
| `sky` | `vec3 skyStars(vec3 dir, float pixAngle)`、`vec3 skyMilkyWay(vec3 dir)`、`vec3 sky(vec3 dir, float pixAngle)`：全片共用的同一片星空（HDR 线性辐射度）。恒星有符合真实分布的色温与亮度幂律；`pixAngle` 是一个像素张开的角度（弧度），恒星的角半径不小于它且总能量守恒，所以任何分辨率、任何缩放下都不闪烁、不成块。不依赖屏幕空间导数（引力透镜里方向不连续，导数会爆）。银河带方向固定 |
| `ray` | 声明 `uCamPos uCamRight uCamUp uCamFwd uTanHalfFov uAspect uPixAngle`，提供 `vec3 cameraRay(vec2 uv)` |
| `dither` | `float ign(vec2 fragCoord)` 交错梯度噪声 |

### 4.4 后期链路（`40-post.js`，引擎内部使用）

场景渲染到线性 HDR 目标（`rgba16f`，值可远大于 1）→ 曝光 → 泛光 → ACES 色调映射 → sRGB → 暗角 / 色差 / 胶片颗粒 / 抖动 → 画布。
泛光用逐级降采样（首级 Karis 平均抑制萤火虫）+ 帐篷滤波升采样，不设硬阈值。内部分辨率低于画布时做轻度锐化。

章节通过 `def.post`（对象，或 `(ctx, state) => 对象`）给参数，缺省值：

```js
{ exposure: 1.0, bloom: 0.5, bloomRadius: 0.7, grain: 0.035, vignette: 0.3,
  aberration: 0.0015, saturation: 1.0, contrast: 1.0, tint: [1, 1, 1] }
```

转场的淡入淡出由引擎控制（`fade`、`fadeColor`），章节不用管。

### 4.5 `T.OrbitCamera`（`50-camera.js`）

```js
const cam = new T.OrbitCamera({ az: 0, el: 0.3, dist: 5, target: [0, 0, 0], fov: 45,
  minDist: 1, maxDist: 100, minEl: -1.5, maxEl: 1.5, damping: 0.92, returnAfter: 6 });
cam.script({ az, el, dist, target });   // 每帧设置"导演机位"
cam.update(ctx);                        // 读 ctx.input（拖动 / 滚轮 / 双指），带惯性，用 ctx.frameDt
cam.pos, cam.right, cam.up, cam.fwd     // Float32Array(3)
cam.view                                // Float32Array(16)
cam.proj(aspect, near, far), cam.viewProj(aspect, near, far)
cam.rayUniforms(ctx)                    // { uCamPos, uCamRight, uCamUp, uCamFwd, uTanHalfFov, uAspect, uPixAngle }
cam.userActive                          // 用户正在操作或刚操作完
```

用户输入是叠加在导演机位上的**偏移**；用户停手 `returnAfter` 秒后偏移缓慢归零，画面回到导演设计的镜头。`T.params.cam` 存在时强制使用它（az, el, dist）。
章节在 **`render` 的开头**调用 `cam.script(...)` 与 `cam.update(ctx)`（`render` 每帧都会被调用；`update` 在暂停 / 冻结时不会），这样暂停时镜头仍可拖动。

### 4.6 `T.engine` 与 `ctx`（`60-engine.js`、`main.js`）

`T.boot()`（`main.js`）只做一件事：启动引擎。引擎找 `#taichu-canvas`（没有就自己创建一块全屏画布）。
画布后备缓冲 = CSS 尺寸 × min(devicePixelRatio, 2)；场景目标 = 后备缓冲 × 当前渲染缩放。

启动流程：
1. 初始化 GL；失败则 `emit('fatal', {message})`。
2. 逐个 `init` 章节（分帧进行，`emit('boot:progress', {done, total, id})`）。某章 `init` 抛错：`T.reportError`，标记该章损坏并在播放时跳过，其余照常。
3. `window.__taichu.booted = true`，`emit('ready', {film})`。
4. 正常模式：在第一幕 t=0 的画面上待机（只 render 不 update，章节用 `ctx.wall` 做待机动画），等界面调用 `T.engine.begin()`。没有界面层（`ui=0` 或未加载）时自动 `begin()`。
5. 开发模式（`?ch=<id>`）：直接进入该章（无转场），快进到 `t`，`freeze=1` 则冻结时间；之后渲染满 3 帧，置 `ready = true`。未知的章节 id、章节损坏等不可恢复的情况：`reportError` 后**同样置 `ready = true`**（让工具立刻拿到错误，而不是等到超时）。

每帧：采集输入 → （未暂停/未冻结时）`update` → 绑定并清空场景目标 → `render` → 后期 → 更新 `__taichu`。
调用章节 `render` 前，引擎保证：场景目标已绑定、viewport 已设、混合/深度测试/剔除/裁剪全部关闭、活动纹理单元为 0。章节可自由改 GL 状态，引擎事后复位。

转场：`goTo` 时旧章继续运行并淡出 1.2 s → `leave` / `enter`、章内时间归零、`emit('chapter')` → 淡入 1.8 s。淡色取进入章的 `fadeIn`（`'black'` 默认 / `'white'`）。
自动推进：`auto` 为真、章内时间 ≥ `duration`、且用户最近 5 s 没有操作时进入下一幕；最后一幕不自动结束。

动态分辨率：以章节 `renderScale`（缺省 1）为上限，在其 [0.4, 1] 倍之间按 GPU 耗时自动调节，目标 60 fps。`scale` 参数或 `freeze=1` 时固定不调。
画质档 `ctx.quality`：桌面默认 2，手机 1，低内存或软件渲染 0；`quality` 参数可覆盖。章节在 `init` 时据此决定粒子数与模拟分辨率。

```js
ctx = {
  gl, G,
  time,          // 章内时间（秒）；enter 时为 0；暂停 / 冻结时不前进；可超过 duration
  dt,            // 本次 update 的步长，已钳制到 ≤ 1/30；快进时恒为 1/60
  frameDt,       // 距上一次 render 的真实秒数（钳制到 ≤ 0.1），暂停 / 冻结时照常 > 0——镜头惯性等用它
  wall,          // 页面墙钟（秒），永远前进——用于与导演时间无关的环境动画
  frame, duration, progress,   // progress = clamp(time / duration, 0, 1)
  seeking,       // 正在快进（只 update 不 render）
  width, height, aspect,       // 场景目标的像素尺寸（已含动态分辨率）
  px,            // height / 1080：点精灵尺寸、线宽等按它缩放，保证任何分辨率下观感一致
  scene,         // 场景 HDR Target
  bindScene(),   // 章节中途绑过别的 FBO 后，用它绑回场景目标
  quality, seed, reducedMotion,
  rng(),         // 确定性随机 [0,1)，enter 时按 seed 与章节 id 重置
  input,         // 见下
  audio,         // { level, bass, mid, high }，0..1；无音频时全 0
  cue(name, data),     // 向配乐与界面发同步事件，即 emit('cue', {chapter, name, data})
  say(text, seconds),  // 临时字幕（交互反馈）
};
ctx.input = {
  x, y,              // 指针位置，画布归一化 [0,1]，原点左上
  nx, ny,            // NDC [-1,1]，y 向上
  down,              // 主键 / 单指按下
  dx, dy,            // 本帧拖动位移（CSS 像素）
  wheel,             // 本帧滚轮增量，正 = 拉远
  pinch,             // 本帧双指缩放比，1 = 无
  clicked, clickX, clickY,   // 本帧完成一次点击（按下到抬起位移 < 5 px）
  keys,              // Set<KeyboardEvent.code>
  pressed(code),     // 本帧刚按下
  idle,              // 距上次输入的秒数
};
```

指针事件只在画布上监听（界面元素自然拦截自己的事件）；焦点在输入框时不采集键盘。保留给界面的按键：`Space`（暂停）、`ArrowLeft/Right`（上一幕 / 下一幕）、`KeyF`（全屏）、`KeyM`（静音）、`KeyI`（解剖）、`KeyA`（自动 / 驻留）、`Escape`。章节可用其它键。

```js
T.engine = {
  film,                 // [{ id, order, title, latin, epoch, lookback, duration }]，不含 dev 章
  current,              // { def, state, index } | null
  begun, auto, paused,
  begin(),              // 须在用户手势内调用：启动音频，从起始章 t=0 开播（起始章 = T.hashChapter() 或第一幕）
  goTo(idOrIndex), next(), prev(),
  setAuto(bool), setPaused(bool),
  live(),               // 当前章 anatomy.live(ctx, state) 的结果 [[名, 值], ...]，出错返回 []
  runSelfTest(id),      // Promise<[{ chapter, name, expected, measured, pass }]>
  submitInput(text),    // 转给当前章的 onInput(ctx, state, text)
  // 开发接口
  devSeek(t),           // Promise：快进（t 小于当前则先 enter 重置）→ 渲染满 3 帧后 resolve。每个动画帧至多推进 120 次 update
  devSelfTest(id),      // 同 runSelfTest，缺省当前章
  devResetPerf(),
};
```

存在 `T.audio` 且 `T.params.audio` 为真时，引擎负责调用：`begin()`（在 `T.engine.begin` 内）、`setChapter(id)`（转场开始时）、`sync(time, playing)`（每帧）、`cue(name, data)`（转发 `ctx.cue`）、`levels()`（每帧填 `ctx.audio`）。

### 4.7 状态对象 `window.__taichu`

```js
{ ready, booted, chapter, t, frames,
  frameMs,   // rAF 间隔的指数平均
  gpuMs,     // 计时查询的整帧 GPU 耗时指数平均（不支持则 null）
  scale, width, height, quality,
  errors,    // 即 T.errors
  perf }     // 自 devResetPerf() 以来：{ samples, avgMs, p95Ms, maxMs, gpuAvgMs }
```

### 4.8 章节定义

```js
TAICHU.registerChapter({
  id: 'horizon', order: 3,
  title: '视界', latin: 'HORIZON',
  epoch: '约 100 亿年前', lookback: 10.0,      // lookback：距今多少个十亿年（时间轴定位用）
  duration: 78,
  renderScale: 0.6,          // 可选：重型全屏着色器的内部分辨率上限
  fadeIn: 'black',           // 可选
  post: { bloom: 0.8 },      // 可选：对象或 (ctx, state) => 对象
  captions: [{ t: 3, d: 5.5, text: '……' }],        // 逐字采用 §7
  controls: ['拖动 环绕', '滚轮 远近'],               // 操作提示
  anatomy: {
    lead: '一句话：这一幕在算什么。',
    equations: [{ name: '光子轨道', eq: 'd²u/dφ² + u = (3GM/c²)·u²' }],   // 纯 Unicode 文本，不用 LaTeX
    notes: ['……'],
    live(ctx, state) { return [['相机距离', '12.3 rₛ']]; },   // 每秒被调用约 4 次
  },
  input: { placeholder: '……', maxLength: 24, at: 64 },   // 可选：向界面申请一个文本输入框；章内时间 ≥ at（缺省 0）时界面才显示它
  onInput(ctx, state, text) {},                   // 可选
  init(ctx) { return state; },      // 创建程序、纹理、目标；按 ctx.quality 定规模。只调用一次
  enter(ctx, state) {},             // 回到 t=0 的确定状态（重置模拟）。可被多次调用
  update(ctx, state) {},            // 推进模拟 ctx.dt。内部自行做固定子步
  render(ctx, state) {},            // 画进场景目标（线性 HDR）
  resize(ctx, state) {},            // 可选：场景尺寸变化
  leave(ctx, state) {},             // 可选
  selfTest(ctx, state) { return [{ name: '阴影半径', expected: '2.598 rₛ', measured: '2.597 rₛ', pass: true }]; },
});
```

`selfTest` 可同步或返回 Promise；必须**不破坏正在显示的模拟状态**（用自己的小目标或 CPU 参考实现），耗时 < 300 ms。它检验的是**这一幕真正在跑的那份代码**（同一个着色器函数 / 同一个积分器），不是另写一份公式自己和自己比。

### 4.9 事件总线（引擎发出）

| 事件 | 数据 |
|---|---|
| `boot:progress` | `{ done, total, id }` |
| `ready` | `{ film }` |
| `fatal` | `{ message }`（无 WebGL2、上下文丢失） |
| `begin` | — |
| `transition` | `{ from, to, phase: 'out' \| 'in' }` |
| `chapter` | `{ id, index, def }`（已进入新章，t=0） |
| `tick` | `{ id, index, time, duration, progress, auto, paused }`，约每秒 10 次 |
| `caption` | `{ text }`，`text` 为 `null` 表示消失 |
| `cue` | `{ chapter, name, data }` |
| `state` | `{ auto, paused }` |
| `input:request` / `input:release` | `{ placeholder, maxLength }` / — （进入 / 离开带 `input` 的章节时） |
| `error` | `{ where, message }` |

## 5. 界面层接口（详见 `briefs/ui.md`）

- `shell.html` 提供 `<canvas id="taichu-canvas">` 与界面根 `<div id="taichu-ui">`。`T.params.ui === false` 时界面根隐藏。
- 界面只通过 §4.6 的 `T.engine` 方法与 §4.9 的事件和引擎交互；静音调用 `T.audio.setMuted(bool)`。
- 界面读取 `T.buildInfo`（构建时注入：`{ files, lines, shaders, bytes, builtAt }`，开发页里可能不存在）。

## 6. 配乐接口（详见 `briefs/audio.md`）

```js
T.audio = {
  begin(),                 // 用户手势内：创建 / 恢复 AudioContext
  setChapter(id),          // 交叉淡化到该幕的配乐
  sync(time, playing),     // 每帧：章内时间与是否在播放；时间线事件据此触发
  cue(name, data),         // 章节发来的同步点（如 'bang'）
  levels(),                // { level, bass, mid, high }，0..1，已平滑
  setMuted(bool), muted,
  renderOffline(id, seconds),   // Promise<{ sampleRate: 22050, pcm16: 单声道小端 Int16 的 base64, peak, rms }>，供 tools/audio_check.py
};
```

配乐的时间线由 `sync(time, playing)` 传入的章内时间自行驱动（地标时间取 §7），**不依赖**章节发来的 cue；`cue()` 只用于交互性事件。章节仍须按 §7 发 cue（界面与日后扩展会用）。

## 7. 六幕总表：时间地标与字幕定稿

所有地标时间（秒，章内时间）是画面、配乐、字幕三方的共同约定，不得擅自移动；确需调整写进 notes。
`cue` 列是章节必须在该时刻调用的 `ctx.cue(name)`。

### 第一幕 · 奇点 `singularity` — LATIN `SINGULARITY` — epoch `138 亿年前` — lookback 13.8 — duration 84 — fadeIn black

| 时间 | 画面 | cue |
|---|---|---|
| 0–6 | 纯黑中一个极小的光点，缓慢呼吸 | |
| 6–13.5 | 光点失稳：涨落的闪烁向内收紧，亮度渐强 | |
| 13.5 | 大爆炸：白闪 | `bang` |
| 13.5–30 | 暴胀与冷却：粒子自中心外涌，穿过镜头；颜色随温度由蓝白 → 金 → 橙红 | |
| 30–40 | 复合：雾散开、变暗，只剩均匀的暗红余烬，近乎全黑 | `dark`（30） |
| 40–70 | 引力编织：宇宙网的纤维、结点、空洞浮现；52 起结点处第一批恒星点亮 | `firstlight`（52） |
| 70–84 | 镜头推向最亮的一个结点 | |

字幕：
- 2.0 / 4.0 「一百三十八亿年前。」
- 7.0 / 5.0 「没有空间，没有时间，也没有“之前”。」
- 16.5 / 5.5 「然后有了一切。」
- 23.0 / 6.0 「最初的几分钟，宇宙造出了几乎全部的氢和氦。」
- 31.0 / 6.5 「三十八万年后，光第一次可以自由穿行。」
- 42.0 / 6.0 「接着是漫长的黑暗。只有引力在工作。」
- 53.0 / 6.0 「物质沿着看不见的骨架聚拢，第一批恒星点亮。」
- 72.0 / 7.0 「这张网的每一个结点，都是上千个星系。」

### 第二幕 · 星系 `galaxy` — `GALAXY` — epoch `约 130 亿年前` — lookback 13.0 — duration 86

| 时间 | 画面 | cue |
|---|---|---|
| 0–14 | 一个安静的盘星系，缓慢自转 | |
| 14–30 | 伴星系自画面一侧接近 | |
| 30 | 第一次近心点；随后潮汐桥与长尾甩出 | `pass1` |
| 48–58 | 回落 | |
| 58 | 合并，核心闪亮 | `merge` |
| 60–86 | 余晖：壳层、星流回落；镜头缓缓拉远，星系成为众星之一 | |

字幕：
- 3.0 / 5.0 「约一百三十亿年前。」
- 9.0 / 6.0 「恒星汇成星系。每一个光点，都是一颗太阳。」
- 18.0 / 6.0 「星系并不孤独。它们会相遇。」
- 32.0 / 6.5 「没有一颗恒星相撞——它们之间太空旷了。」
- 40.0 / 6.5 「只有引力，把星流甩成几十万光年长的尾巴。」
- 59.0 / 6.0 「十亿年后，两个星系成为一个。」
- 70.0 / 7.0 「银河系也是这样长大的。几十亿年后，它或许将与仙女座相遇。」

### 第三幕 · 视界 `horizon` — `HORIZON` — epoch `约 100 亿年前` — lookback 10.0 — duration 78

| 时间 | 画面 | cue |
|---|---|---|
| 0–12 | 远处，星空中一个极小的暗斑，背景星光在它周围被扭曲 | |
| 12–40 | 接近并下降到近盘面视角；吸积盘的上下两重像展开；迎面一侧更亮 | |
| 40 | 最近点（r ≈ 15 rₛ，相机始终在盘的外缘之外） | `closest` |
| 40–62 | 沿轨道环绕半周；光子环清晰可辨 | |
| 62–78 | 升到高纬俯视整个盘，再拉远 | |

字幕：
- 3.0 / 5.5 「最重的恒星死去时，会在时空里留下一个洞。」
- 14.0 / 6.0 「它本身不发光。你看见的，是坠入它的物质最后的光。」
- 24.0 / 7.0 「光在这里拐弯：盘的背面，被弯到了上方和下方。」
- 35.0 / 6.5 「朝你转来的一侧更亮、更蓝——那是相对论。」
- 46.0 / 6.5 「中间那圈细细的光环，是绕着黑洞转了半圈以上的光。」
- 64.0 / 7.0 「视界之内，再没有消息传出来。」

### 第四幕 · 蔚蓝 `azure` — `AZURE` — epoch `46 亿年前` — lookback 4.6 — duration 84

| 时间 | 画面 | cue |
|---|---|---|
| 0–14 | 一颗熔岩行星：裂纹发光，陨击的闪光 | |
| 14–30 | 冷却结壳；蒸汽云层包裹 | |
| 30 | 降雨成海 | `rain` |
| 30–46 | 海洋填满低地，大陆轮廓出现 | |
| 46–60 | 大气成形：天空转蓝，晨昏线上一道红橙色薄边；云系流动 | |
| 60 | 第一抹绿自海岸蔓延 | `green` |
| 60–84 | 今日地球的样貌；镜头掠过晨昏线到夜面，再回到日面 | |

字幕：
- 3.0 / 5.0 「四十六亿年前。」
- 8.0 / 6.0 「一颗普通恒星的第三颗行星，还是一片岩浆的海。」
- 18.0 / 6.0 「它慢慢冷却，结出一层薄壳。」
- 31.0 / 6.5 「水汽凝结成雨。雨下了很久，久到填满了海。」
- 48.0 / 7.0 「天是蓝的，因为空气散射蓝光的本领，是红光的五倍多。」
- 61.0 / 6.5 「然后，海岸线上出现了一点绿色。」
- 74.0 / 7.0 「目前已知的全部生命，都在这一层薄薄的蓝色里。」

### 第五幕 · 生命 `life` — `LIFE` — epoch `约 38 亿年前` — lookback 3.8 — duration 78

| 时间 | 画面 | cue |
|---|---|---|
| 0–8 | 黑暗的原始海水，微弱的热液光 | |
| 8 | 第一个会自我复制的斑点出现 | `spark` |
| 8–40 | 一分二、二分四……指数增殖，铺满视野 | |
| 40 | 参数漂移，分化开始 | `diverge` |
| 40–62 | 条纹、迷宫、珊瑚状斑图分区共存 | |
| 62–78 | 镜头拉远，整片"组织"像呼吸一样律动 | |

字幕：
- 3.0 / 5.0 「约三十八亿年前。」
- 9.0 / 6.5 「在某处温暖的水里，化学学会了一件新的事：复制自己。」
- 18.0 / 6.0 「一个变成两个，两个变成四个。」
- 28.0 / 6.5 「这里没有设计图。只有两种物质，一个扩散，一个反应。」
- 42.0 / 7.0 「1952 年，图灵提出：反应加扩散，就足以长出斑纹。」
- 52.0 / 6.5 「你此刻看到的每一个图案，都是当场算出来的。」
- 66.0 / 7.0 「简单的规则，重复足够多次，就不再简单。」

### 第六幕 · 言 `logos` — `LOGOS` — epoch `现在` — lookback 0 — duration 80（最后一幕，不自动结束）

| 时间 | 画面 | cue |
|---|---|---|
| 0–8 | 百万粒子像萤火 / 神经一样漂浮 | |
| 8 / 14 / 20 / 26 / 32 | 粒子依次聚成单字：光、星、海、生、言 | 每字 `glyph` |
| 40 | 聚成「宇宙花了一百三十八亿年」 | `line` |
| 48 | 聚成「才学会说话」 | `line` |
| 54–56 | 粒子散开 | |
| 56 | 聚成「你好。」 | `hello` |
| 64 | 界面出现输入框 | `invite` |
| 64 之后 | 观众输入的文字由粒子写出；无输入时保持「你好。」并缓慢呼吸 | |

字幕：
- 2.0 / 5.0 「很久以后，一种生命抬起头，开始给星星起名字。」
- 66.0 / 8.0 「现在，轮到你说。」

## 8. 视觉总纲

- **光是物理的**。色彩锚定在黑体辐射上：3000 K 的橙、5800 K 的白、10000 K 以上的蓝白。不用霓虹渐变，不用紫粉"AI 星云"。
- **黑是真黑**。太空没有雾。暗部干净，高光靠 HDR 与泛光说话，不靠把整幅画面提亮。
- **尺度感**。永远让观众知道东西有多大：细小而密集的细节、缓慢而有重量的运动、极大与极小并置。
- **镜头有分量**。慢，稳，有目的。除大爆炸外不抖动。每一幕至少有一个值得定格的画面。
- **克制**。一幕只讲一件事。宁可少一个效果，不可多一个俗套。
- **连续**。全片共用同一片星空（`#include <sky>`）、同一条后期链路、同一种胶片质感。前一幕的结尾要能接上后一幕的开头。

## 9. 发布约束（最终单文件会作为 Artifact 页面发布）

- 发布时平台会给文件包一层骨架：`<head>` 里只有 charset、viewport（含 `viewport-fit=cover`）和一小段重置样式（`:root` 的 `color-scheme: light` 与上下 safe-area 内边距、`body` 零外边距与 14px 系统字体、`[hidden]{display:none!important}`）。产物本身**不写** `<!doctype>` / `<html>` / `<head>` / `<body>`。`dev.html` 与独立产物已复刻同一骨架。
- 单屏应用：`html`、`body` 用 `height: 100%`，不用 `100vh`；保留 `:root` 的 safe-area 内边距。显隐用 `el.hidden`，不用 `style.display`。
- 贴边的固定元素：自身内边距加上对应的 `env(safe-area-inset-*, 0px)`；界面文字与控件左右留白用 `max(16px, env(safe-area-inset-left, 0px))` 这种写法。页面不得横向滚动。
- 本作只有深色一种外观：在 `:root` 上显式设 `color-scheme: dark`、显式背景色与全部颜色变量。
- 运行环境的限制：没有 query string（只有纯 `#name` 能进出地址栏）；`alert/confirm/prompt` 不显示；不能发起下载；声音必须由观众的点击启动；全屏只在桌面浏览器的点击中可用，要容忍被拒绝。
- `localStorage` 可能抛错或为空：读写都包在 try/catch 里，没有它页面也要正常。

## 10. 审查重点（规格没写、但最容易咬人的情况）

1. **窗口变化**：缩放窗口、进出全屏、DPR 改变时，渲染目标要重建，但模拟状态不能被重置或拉花。
2. **时间异常**：切到后台再回来（dt 尖峰）、在"驻留"里停留远超 `duration`、快速连续切换章节（转场中再次 `goTo`）、重复进入同一章。
3. **弱设备**：浮点纹理不能线性过滤或不能混合时的退路；手机上的内存与填充率。
4. **输入冲突**：焦点在输入框时的全局快捷键；中文输入法组字期间按回车（`isComposing`）不得提交。
5. **长时间运行**：模拟的数值漂移、粒子逃逸、纹理单元或 FBO 泄漏。
