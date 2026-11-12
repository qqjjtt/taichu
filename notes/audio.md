# 配乐（audio）给总装的说明
- 测试：python3 tools/audio_check.py --all；换幕交叉淡化：--id 'singularity>galaxy' --seconds 22（先放前一幕最后 10 秒，第 10 秒 setChapter 到后一幕）。
- renderOffline 结果额外带 nodes:{baseline, created, liveAtEnd, oscAtEnd}；TAICHU.audio.stats() 给实时的活动节点数、上下文状态、当前幕与游标。
- 任务书里的实时测试章 probe 不存在，用 --only testcard；没有专属配乐的章（testcard 等）播放一层安静的 D 音垫。
- 换幕时引擎在 out 阶段仍发旧章时间：新幕会等章内时间回到 <1 s 再开始（最多等 4 s），避免把旧时间当成 seek。
- 静音的初始状态由界面层调用 setMuted 决定；levels() 取自静音之后，静音时可视化随之归零。
- 驻留（超过 duration）每幕都有循环的尾声；seek 进中段时持续音垫与当前一轮尾声会以 1.5 s 淡入续上，其余被跳过的事件不补响。
