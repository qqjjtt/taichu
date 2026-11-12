# 界面层任务书

文件：`src/ui/shell.html`、`src/ui/style.css`、`src/ui/ui.js`（你拥有这三个）。截图输出到 `shots/ui/`。
先读 `CONTRACT.md`（§1 §4.6 §4.8 §4.9 §5 §7 §9 §10）、`CHAPTER_GUIDE.md`，再读 `src/core/60-engine.js` 里事件与方法的实际实现。

## 界面的职责

《太初》的主角是画面。界面是一层薄薄的、几乎不存在的东西：告诉观众这是第几幕、讲到哪了、怎么操作；
在观众想知道"这是怎么算出来的"时，给出方程和自检结果。平时它应当退到看不见。

## 设计方向（已定，照此执行，把它做精）

**"古籍的竖排 + 天文仪器的刻度"。**

- 标题与幕名用**竖排**（`writing-mode: vertical-rl`），宋体，大字，像线装书的书名签；拉丁文副题是小号、宽字距的大写字母，像仪器铭牌。
- 一切线条是发丝线（1px，低不透明度），像铜版刻度。不用圆角卡片、不用投影、不用渐变按钮、不用图标字体、不用 emoji。
- 颜色只有一种"纸白"在不同透明度下的层次，加上每一幕一个取自画面本身的强调色（由 JS 在换幕时写到 `--act` 上）：

| 幕 | `--act` | 来历 |
|---|---|---|
| singularity | `#ffb46b` | 3000 K，光与物质脱耦时的颜色 |
| galaxy | `#bfd0ff` | 10000 K 的年轻恒星 |
| horizon | `#ff9a4d` | 吸积盘 |
| azure | `#6fa8ff` | 瑞利散射的天空 |
| life | `#5fe3c0` | 生物荧光 |
| logos | `#f3e2bd` | 烛光 |

- 字体全部用系统字体，不加载任何外部字体：
  - 中文：`"Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif`
  - 拉丁文与数字：`"Didot", "Bodoni 72", "Baskerville", "Iowan Old Style", "Palatino Linotype", Georgia, serif`
  - 方程：`"STIX Two Text", "STIXGeneral", "Cambria Math", "Times New Roman", serif`，斜体
  - 数值列用 `font-variant-numeric: tabular-nums`
- 在 `style.css` 顶部的 `:root` 里把设计计划写成变量：颜色（`--void` 纯黑背景、`--ink` 纸白、`--ink-dim`、`--ink-faint`、`--rule`、`--act`、`--warn`）、三种字体角色、间距与字号阶梯；上方一行注释说明布局概念。之后所有规则只用这些变量。
- 只有深色一种外观：`:root { color-scheme: dark }`，`body` 显式背景 `var(--void)`。

## 结构（`shell.html` 提供这些 id）

`#taichu-canvas`：`position: fixed; inset: 0; width: 100%; height: 100%`，`touch-action: none`。
`#taichu-ui`：覆盖全屏的界面根，自身 `pointer-events: none`，只有可交互的子元素设 `pointer-events: auto`——这样画布才能收到穿过界面空白处的拖动。`T.params.ui === false` 时把它 `hidden`。

1. **片头 `#t-start`**（`ready` 之前显示加载进度，`begin` 之后淡出）
   - 竖排大字「太初」，字号 `clamp(88px, 22vh, 220px)`，放在画面右侧三分之一处——画面正中要留给那个呼吸的光点。
   - 拉丁文副题：`TAICHU · A UNIVERSE IN ONE FILE`。
   - 三行说明：「一百三十八亿年，六幕。」「你将看到的每一帧、听到的每一个音，都由这一个文件在你的设备上当场算出。」「没有素材，没有依赖。」
   - 按钮「开始」：加载时禁用并显示「正在点亮 3 / 6」（来自 `boot:progress`），`ready` 后可用；点击调用 `T.engine.begin()`。
   - 小字提示：「建议全屏，戴上耳机」。
2. **幕名卡 `#t-card`**：收到 `chapter` 后约 0.6 秒淡入、停留约 4.5 秒、淡出。内容：「第三幕」（小字）、竖排幕名（大字）、拉丁名、epoch。位置偏画面一侧，不挡正中。
3. **字幕 `#t-caption`**：底部居中（下边距约 11% 再加安全区），最大宽度约 30 个汉字，字号 `clamp(18px, 2.4vh + 6px, 28px)`，字距 0.08em，`text-wrap: balance`，带一圈极淡的暗色描边阴影保证在亮画面上可读；0.6 秒淡入淡出；`aria-live="polite"`。
4. **时间轴 `#t-timeline`**：贴底的一条发丝线。六个刻度按真实的"距今时间"线性排布：`x = (13.8 − lookback) / 13.8`。于是奇点与星系挤在最左，生命与蔚蓝相邻，「言」在最右端——这种不均匀正是要传达的事实，不要改成等距。
   - 标签（幕名）上下交错以免相撞；两端标「138 亿年前」「现在」。
   - 当前幕的刻度用 `--act` 点亮；幕内进度是从当前刻度向右生长的一小段亮线（到下一刻度为止；最后一幕是刻度处一个缓慢呼吸的点）。
   - 刻度是 `<button>`，点击 `T.engine.goTo(id)`；悬停显示 epoch。命中区域至少 32×32 px，即使视觉上只是一根线。
   - 窄屏（< 600 px）：仍按真实比例画刻度，但只显示当前幕的标签。
5. **控制 `#t-controls`**（右上角一排文字按钮，发丝线分隔）：「解剖」「静音」「驻留」「全屏」「关于」。有状态的用 `aria-pressed`，按下态是一条 `--act` 色的下划线。
   - 「驻留」= `T.engine.setAuto(false)`（停在这一幕不自动前进），再按恢复。
   - 「全屏」对 `document.documentElement.requestFullscreen()` 的拒绝要静默容忍；不支持时隐藏该按钮。
   - 快捷键：`Space` 暂停 / 继续，`←` `→` 上一幕 / 下一幕，`F` 全屏，`M` 静音，`I` 解剖，`A` 驻留，`Esc` 关闭面板。焦点在输入框里时一律不响应；`e.isComposing` 时不响应。
   - 左上角：极小的「太初」字标 + 当前是第几幕。
6. **解剖面板 `#t-anatomy`**（右侧抽屉，宽 `min(420px, 100% − 32px)`，半透明黑底 + `backdrop-filter: blur(10px)`，左侧一条发丝线）
   - 幕名；`anatomy.lead`；方程列表（名称是小号字，方程是方程字体、稍大，过长时在自己的容器里横向滚动）；`notes`（每条前面一个短横）；实时数值表（每 250 ms 调 `T.engine.live()`）。
   - **物理自检**：这一幕第一次打开面板时调 `T.engine.runSelfTest(id)`，逐条列出「✓ 名称 —— 实测 … / 理论 …」；不通过的用 `--warn` 标「✗」。运行中显示「正在自检…」。结果按幕缓存。
   - 面板打开时不遮挡、不拦截面板之外的画布交互。
7. **操作提示 `#t-hint`**（左下）：`def.controls` 用「 · 」连接；换幕后出现，6 秒后淡出。
8. **输入框 `#t-input`**：当前幕的 `def.input` 存在、且章内时间 ≥ `def.input.at`（缺省 0）时出现（由 `tick` 判断，不依赖 cue）。居中、位于字幕上方；一条发丝线下划线的单行输入；`placeholder` 与 `maxLength` 取自 `def.input`；字号 ≥ 16px（避免手机自动放大）。
   回车提交：调用 `T.engine.submitInput(value)` 后清空。**输入法组字期间（`e.isComposing` 或 `keyCode === 229`）按回车不得提交。** 离开该幕时隐藏。
9. **关于 `#t-about`**（居中的一小块文字，可关闭）：
   「《太初》／一个文件 · 零素材 · 零依赖／你看到的每一帧、听到的每一个音，都由这个文件里的代码在你的设备上当场算出。」
   然后一行构建数字（来自 `T.buildInfo`，不存在就不显示这一行）：「{lines} 行代码 · {shaders} 个着色器 · {KB} KB」；再列快捷键；最后署名行留一个 `<p id="t-credit">`，内容由总设计最后填写。
10. **致命错误 `#t-fatal`**：收到 `fatal` 时居中显示 message，其它界面隐藏。
11. **空闲隐藏**：3.5 秒没有指针移动或按键，控制、时间轴、提示淡出，画布上的光标隐藏；字幕、幕名卡、打开着的面板不受影响。任何输入立刻恢复。片头期间不隐藏。
12. **暂停**：`state.paused` 为真时在左上角字标旁显示「暂停」。

## 约束（来自契约 §9，逐条落实）

- 产物不含 `<!doctype>` / `<html>` / `<head>` / `<body>`；`shell.html` 只写页面内容。`html, body { height: 100% }`，不用 `100vh`；保留骨架给 `:root` 的 safe-area 内边距。
- 贴边的固定元素把对应的 `env(safe-area-inset-*, 0px)` 加进自己的内边距；文字与控件左右留白一律 `max(16px, env(safe-area-inset-left, 0px))` / `…right…`。页面任何宽度下不得横向滚动。
- 显隐用 `el.hidden`；需要过渡的用类名切换 `opacity` 与 `visibility`，静止状态必须是确定可见或确定隐藏。
- `prefers-reduced-motion: reduce` 时只保留不透明度过渡。
- 键盘可达：所有控件是真正的 `<button>` / `<input>`，有清晰的 `:focus-visible` 样式；面板打开后焦点进入面板，`Esc` 关闭并把焦点还给触发按钮。
- `localStorage` 只用来记"静音"偏好，读写都包 try/catch。
- 不出现任何外部 URL、`@import`、`url(...)`（`build.py` 会拒绝）。

## 怎么测

界面依赖引擎与章节。其他实例正在并行改六幕的文件，所以用隔离的小片子来测：
`dev.html?only=testcard,probe&devfilm=1&ui=1`（只加载两个开发章，并把它们当正片的两幕）。对应命令：

```
python3 tools/shot.py --film --ui 1 --only testcard,probe --devfilm --outdir shots/ui --do "wait:2;shot:start;eval:(()=>{const r=document.querySelector('#t-start button').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()"
```

用上一条 eval 得到的坐标去 `click:x,y`，再接 `wait` 与 `shot` 逐个截：片头、幕名卡、字幕、时间轴悬停、解剖面板（含自检结果）、关于、输入框（probe 章定义了 `input`）、空闲隐藏后。
再各截一遍 `--mobile` 与 `--w 1512 --h 982 --dpr 2`。用 `resize:` 动作确认改变窗口后布局正确。

## 完成标准

- 上述每个状态都有截图，且你作为设计师看着满意：对齐、间距、字重、层次经得起细看；
- 任何宽度下没有横向滚动、没有文字被裁切、没有元素相互重叠；
- `python3 tools/build.py` 通过（零外部资源守卫）；
- 全程控制台零错误；界面不拦截画布拖动（在界面显示的情况下 `drag:` 仍能转动 testcard 的相机）；
- 中文输入法组字时回车不提交（用 `eval` 派发带 `isComposing: true` 的键盘事件验证）。
