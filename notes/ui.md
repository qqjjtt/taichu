# 界面层给总装的备注
- 署名行 `<p id="t-credit">` 留空（为空时 CSS 自动隐藏），由总设计填写。
- 界面在待机时会收到引擎为第一幕发的 `chapter`（开播前）；界面只记录不显示，幕名卡由 `begin` 补上。若引擎改成待机不发 chapter，也照常工作。
- 开发参数 `?dev=1`（--film 用）不代表跳过片头；只有 `?ch=` 时界面直接撤掉片头。
- 静音按钮始终显示，偏好存 localStorage（taichu.muted），T.audio 存在时在 ready 与每次切换时调用 setMuted。
- 流程测试脚本：python3 shots/ui/uiflow.py [desk|mobile|retina] [章节列表] [标签]，输出 shots/ui/<模式><标签>/sheet.png。
