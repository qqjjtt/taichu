# 总装记录（integration）

## 每幕状态
| 幕 | check.py | 自检 | 720p GPU ms | 1512×982@2x gpuAvgMs / 稳定 scale（上限） | 帧 ms |
|---|---|---|---|---|---|
| singularity | 通过 | 7/7 | 5.7 | 10.8 / 1.0（1.0） | 16.67 |
| galaxy | 通过 | 5/5 | 7.7 | 8.4 / 1.0（1.0） | 16.67 |
| horizon | 通过 | 5/5 | 9.5 | 15.5 / 0.35（0.6） | 16.67 |
| azure | 通过 | 6/6 | 7.3 | 18.0 / 0.35（0.7） | 16.74 |
| life | 通过 | 5/5 | 9.5 | 8.8 / 0.7（0.85） | 16.67 |
| logos | 通过 | 5/5 | 5.5 | 8.4 / 1.0（1.0） | 16.67 |

retina 下六幕都稳定在 60 fps，动态分辨率都没低于各自上限的 0.5 倍，所以没调 renderScale。GPU 同时被其他实例占用，数字可能抖动 30% 到 50%。

## 核对
- §7 元数据与字幕：shots/integration/cmpmeta.py 从浏览器读出 TAICHU.chapters，与 CONTRACT.md §7 逐字比对，结果 0 差异（id/order/title/latin/epoch/lookback/duration/fadeIn、37 条字幕的时间与文本）。
- 整片流程：shots/integration/filmflow.py [desk|mobile|retina] [dev|dist] [full|short]。依次检查：片头 → 开始 → 幕名卡与字幕 → goto 五幕 → 解剖（方程、实时表、自检）→ logos t=66 输入「海内存知己」后由粒子写出 → 点时间轴跳到 horizon → 暂停、驻留、静音。dev 桌面完整跑；dist 跑了桌面、手机、retina。控制台 0 错误，横向滚动 0。
- 自动换幕：singularity 跑到 84 后自动进入 galaxy，配乐跟着换幕；logos 在 t=85 驻留，不会结束。

## 改动
1. src/chapters/3-horizon.js 的 diskNoise：像素足迹大到第一级倍频就被关掉时，nrm=0 会导致 0/0=NaN，在盘的透镜像和光子环上留下黑色月牙和黑点。动态分辨率越低越明显，retina 整片播放时 scale 0.35 就能看到。现改为这种情况返回 0。
2. src/core/60-engine.js 新增 E.setFrozen(b)，返回旧值；tools/shot.py 新增动作 `run:秒`，在冻结模式下让时间真实推进后恢复原状态。这样解决了 life 和 logos 上报的「wait 不推进」问题。
3. 重新构建 dist。

## 仍存在的问题（按严重程度）
1. horizon、azure 在 retina 下动态分辨率降到 0.35，画面偏软；后期 gpuPost 约 7.8 ms，其他幕约 3.5 ms。可以考虑让泛光金字塔在高 DPR 下再降一级（见 notes/horizon.md）。
2. horizon 在低 scale 下，上方透镜像与盘的交界附近仍有一条较硬的水平过渡；光子环下半段有少量闪点。
3. singularity 片尾没有推成「正中一团致密星光」（见作者报告）。
4. galaxy t≈22 旋臂偏同心环；azure 低轨的云偏粉灰；life 近景偏软。
5. 署名 #t-credit 留空。
