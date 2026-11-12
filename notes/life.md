# life 给总装的备注
- tools/shot.py 的 --do 在冻结时间下执行（freeze=1），update 不跑，所以「拖动后 wait」只能看到刚撒下的种子，看不到生长。
  复现：python3 tools/shot.py --ch life --t 30 --do "drag:300,300,900,450,30;wait:2;shot:seeded"
  要看生长需加 --perf 1（不冻结）：python3 tools/shot.py --ch life --t 20 --perf 1 --do "drag:200,600,1100,550,30;wait:4;shot:ge"
  建议：--do 里遇到 wait 时临时解冻，或加一个 run:秒 动作。
- seek（--do seek:）会从 t=0 重放，用户播下的种子随之清空——这是预期行为。
