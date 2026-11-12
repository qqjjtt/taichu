#!/usr/bin/env python3
"""太初 TAICHU 全量回归：逐章多时间点截图 + 错误检查 + 亮度统计 + 物理自检 + 性能。

用法：
  python3 tools/check.py                    全部正片章节
  python3 tools/check.py --only horizon,life
  python3 tools/check.py --fast             每章 3 个时间点，不测性能
  python3 tools/check.py --dist             测构建产物 dist/taichu-standalone.html
  python3 tools/check.py --dev-chapters     连同 dev 章（testcard 等）一起测

输出：shots/check/<id>_sheet.png、shots/check/report.json，并打印汇总表。
判定失败（退出码 1）：任何错误（控制台 error / TAICHU.errors / 着色器编译失败）、任何 selfTest 不通过、
某章所有抽样帧全黑、页面超时。性能超预算只给警告：1280x720 下 GPU 帧耗时 > 12ms 或帧间隔 > 20ms。
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from shot import ROOT, Session, contact_sheet, image_stats  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--only')
    ap.add_argument('--fast', action='store_true')
    ap.add_argument('--dist', action='store_true')
    ap.add_argument('--dev-chapters', action='store_true')
    ap.add_argument('--w', type=int, default=1280)
    ap.add_argument('--h', type=int, default=720)
    a = ap.parse_args()

    page = 'dist/taichu-standalone.html' if a.dist else 'dev.html'
    outdir = os.path.join(ROOT, 'shots', 'check')
    os.makedirs(outdir, exist_ok=True)
    report = {'ok': True, 'chapters': [], 'boot_errors': []}
    sess = Session(a.w, a.h, 1.0)
    try:
        try:
            sess.open(page, wait='booted', dev=1, ui=0, audio=0, glerr=1)
        except Exception as e:  # noqa: BLE001
            print('启动失败：', str(e)[:400])
            print(json.dumps(sess.errors(), ensure_ascii=False, indent=1))
            sys.exit(1)
        report['boot_errors'] = sess.errors()
        if report['boot_errors']:
            report['ok'] = False
        chapters = sess.page.evaluate(
            '() => TAICHU.chapters.slice().sort((x, y) => x.order - y.order)'
            '.map(c => ({id: c.id, title: c.title, duration: c.duration, dev: !!c.dev}))')
        if not a.dev_chapters:
            chapters = [c for c in chapters if not c['dev']]
        if a.only:
            want = set(a.only.split(','))
            chapters = [c for c in chapters if c['id'] in want]

        for c in chapters:
            cid, d = c['id'], float(c['duration'])
            times = [1.0, d * 0.5, max(1.0, d - 1.0)] if a.fast else [1.0, d * 0.25, d * 0.5, d * 0.75, max(1.0, d - 1.0)]
            row = {'id': cid, 'title': c['title'], 'ok': True, 'shots': [], 'errors': [], 'warnings': []}
            sess.console.clear()
            try:
                sess.open(page, ch=cid, t=times[0], freeze=1, ui=0, audio=0, glerr=1)
                paths = []
                for i, t in enumerate(times):
                    if i > 0:
                        sess.seek(t)
                    path = sess.shot(os.path.join(outdir, f'{cid}_t{t:05.1f}.png'))
                    paths.append(path)
                    row['shots'].append({'t': round(t, 1), 'stats': image_stats(path)})
                row['sheet'] = contact_sheet(paths, os.path.join(outdir, f'{cid}_sheet.png'), [f'{cid} t={t:g}s' for t in times])
                means = [s['stats'].get('mean', 0) for s in row['shots']]
                if max(means) < 0.004:
                    row['errors'].append('所有抽样帧全黑')
                if any(s['stats'].get('white', 0) > 0.6 for s in row['shots']):
                    row['warnings'].append('有抽样帧大面积过曝（white > 60%）')
                st = sess.page.evaluate('id => TAICHU.engine.devSelfTest(id)', cid) or []
                row['selftest'] = st
                for r in st:
                    if not r.get('pass'):
                        row['errors'].append(f"selfTest 不通过: {r.get('name')} 期望 {r.get('expected')} 实测 {r.get('measured')}")
                row['errors'] += sess.errors()
                if not a.fast:
                    sess.console.clear()
                    sess.open(page, ch=cid, t=round(d * 0.5, 1), freeze=0, ui=0, audio=0)
                    sess.page.evaluate('() => TAICHU.engine.devResetPerf()')
                    sess.page.wait_for_timeout(3000)
                    perf = sess.status().get('perf') or {}
                    row['perf'] = perf
                    if (perf.get('gpuAvgMs') or 0) > 12:
                        row['warnings'].append(f"GPU 帧耗时 {perf.get('gpuAvgMs')}ms > 12ms")
                    if (perf.get('avgMs') or 0) > 20:
                        row['warnings'].append(f"帧间隔 {perf.get('avgMs')}ms > 20ms")
                    row['errors'] += sess.errors()
            except Exception as e:  # noqa: BLE001
                row['errors'].append('异常: ' + str(e)[:400])
                try:
                    row['errors'] += sess.errors()
                except Exception:  # noqa: BLE001
                    pass
            row['errors'] = list(dict.fromkeys(row['errors']))
            row['ok'] = not row['errors']
            report['ok'] = report['ok'] and row['ok']
            report['chapters'].append(row)
    finally:
        sess.close()

    with open(os.path.join(outdir, 'report.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)

    print(f"{'章节':<14}{'结果':<6}{'亮度(各抽样帧 mean)':<40}{'自检':<8}{'GPU ms':<8}{'帧 ms':<8}")
    for r in report['chapters']:
        means = ' '.join(f"{s['stats'].get('mean', 0):.3f}" for s in r['shots'])
        st = r.get('selftest') or []
        stxt = f"{sum(1 for x in st if x.get('pass'))}/{len(st)}"
        perf = r.get('perf') or {}
        print(f"{r['id']:<14}{'通过' if r['ok'] else '失败':<6}{means:<40}{stxt:<8}{str(perf.get('gpuAvgMs', '-')):<8}{str(perf.get('avgMs', '-')):<8}")
        for e in r['errors']:
            print('   ✗', e[:300])
        for w in r['warnings']:
            print('   !', w[:300])
    for e in report['boot_errors']:
        print('启动错误 ✗', e[:300])
    print('总结：', '全部通过' if report['ok'] else '有失败', '· 报告', os.path.join(outdir, 'report.json'))
    sys.exit(0 if report['ok'] else 1)


if __name__ == '__main__':
    main()
