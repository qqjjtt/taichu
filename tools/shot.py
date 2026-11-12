#!/usr/bin/env python3
"""太初 TAICHU 截图 / 交互 / 性能 / 自检工具。

用无头 Chrome（本机真实 GPU）打开 dev.html，跳到指定章节与章内时间，截图并打印 JSON 状态。
每次调用自带一个随机端口的本地服务器和独立的浏览器，多个代理可同时运行互不干扰。

例：
  python3 tools/shot.py --ch horizon --t 20                      单帧 → shots/horizon/horizon_t020.0.png
  python3 tools/shot.py --ch galaxy --seq 5,20,35,50,70 --sheet  多帧（时间必须递增）+ 拼成一张联系表
  python3 tools/shot.py --ch horizon --t 20 --w 1512 --h 982 --dpr 2   用户屏幕的真实分辨率
  python3 tools/shot.py --ch horizon --perf 4                    不冻结时间跑 4 秒，报告帧耗时（含 GPU 计时）
  python3 tools/shot.py --ch azure --selftest                    运行该章 selfTest
  python3 tools/shot.py --ch life --t 30 --do "drag:400,300,700,420;wait:0.5;shot:after-drag"
  python3 tools/shot.py --film --ui 1 --do "wait:2;shot:start;click:640,500;wait:6;shot:playing"
  python3 tools/shot.py --ch logos --t 5 --mobile                手机视口（390x844, dpr 3, 触摸）

--do 动作（分号分隔，按序执行）：
  wait:秒  run:秒（冻结时也真实推进）  click:x,y  move:x,y  drag:x0,y0,x1,y1[,步数]  wheel:dy[,x,y]  key:KeyboardEvent.code
  type:文字  seek:章内秒  goto:章节id  resize:宽,高  eval:JS表达式  shot:文件名(不含扩展名)
  坐标为 CSS 像素，原点左上。

退出码：0 = 没有错误；1 = 有错误（控制台 error、着色器编译失败、TAICHU.errors、超时）。
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import devserver  # noqa: E402

ROOT = devserver.ROOT


def image_stats(path):
    """亮度统计：mean 平均亮度、std 对比、p99 高光、black/white 死黑/过曝像素占比。"""
    try:
        import numpy as np
        from PIL import Image
        im = np.asarray(Image.open(path).convert('RGB'), dtype=np.float32) / 255.0
        lum = im @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
        return {
            'mean': round(float(lum.mean()), 4),
            'std': round(float(lum.std()), 4),
            'p99': round(float(np.percentile(lum, 99)), 4),
            'black': round(float((lum < 0.008).mean()), 4),
            'white': round(float((lum > 0.98).mean()), 4),
        }
    except Exception as e:  # noqa: BLE001
        return {'error': str(e)}


def contact_sheet(paths, out, labels=None, tile_w=640):
    from PIL import Image, ImageDraw
    ims = [Image.open(p).convert('RGB') for p in paths]
    n = len(ims)
    cols = n if n <= 3 else (2 if n == 4 else 3 if n <= 9 else 4)
    rows = (n + cols - 1) // cols
    th = int(ims[0].height * tile_w / ims[0].width)
    sheet = Image.new('RGB', (cols * tile_w, rows * th), (0, 0, 0))
    draw = ImageDraw.Draw(sheet)
    for i, im in enumerate(ims):
        x, y = (i % cols) * tile_w, (i // cols) * th
        sheet.paste(im.resize((tile_w, th), Image.LANCZOS), (x, y))
        if labels:
            draw.rectangle([x, y, x + 10 + 7 * len(labels[i]), y + 18], fill=(0, 0, 0))
            draw.text((x + 5, y + 3), labels[i], fill=(255, 255, 255))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    sheet.save(out)
    return out


class Session:
    """一个无头 Chrome 页面 + 本地开发服务器。"""

    def __init__(self, w=1280, h=720, dpr=1.0, mobile=False, timeout=120.0):
        from playwright.sync_api import sync_playwright
        self.srv, self.port = devserver.start(0)
        self._pw = sync_playwright().start()
        self.browser = self._pw.chromium.launch(channel='chrome', headless=True, args=[
            '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'])
        if mobile:
            w, h, dpr = 390, 844, 3.0
        self.ctx = self.browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=dpr,
                                            has_touch=mobile, is_mobile=mobile)
        self.page = self.ctx.new_page()
        self.timeout = timeout
        self.console = []
        self.page.on('console', self._on_console)
        self.page.on('pageerror', lambda e: self.console.append({'type': 'pageerror', 'text': str(e)[:2000]}))

    def _on_console(self, m):
        if m.type in ('error', 'warning'):
            self.console.append({'type': m.type, 'text': m.text[:2000]})

    def url(self, page='dev.html', **params):
        from urllib.parse import urlencode
        q = urlencode({k: v for k, v in params.items() if v is not None})
        return f'http://127.0.0.1:{self.port}/{page}' + ('?' + q if q else '')

    def open(self, page='dev.html', wait='ready', **params):
        self.page.goto(self.url(page, **params))
        if wait:
            self.wait(wait)

    def wait(self, flag='ready'):
        self.page.wait_for_function(f'window.__taichu && window.__taichu.{flag} === true', timeout=self.timeout * 1000)

    def status(self):
        return self.page.evaluate('() => JSON.parse(JSON.stringify(window.__taichu || {}))')

    def seek(self, t):
        self.page.evaluate('t => TAICHU.engine.devSeek(t)', t)

    def shot(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.page.screenshot(path=path)
        return path

    def errors(self):
        st = self.status()
        return list(st.get('errors') or []) + [c['text'] for c in self.console if c['type'] in ('error', 'pageerror')]

    def close(self):
        try:
            self.browser.close()
        finally:
            self._pw.stop()
            self.srv.shutdown()


def run_actions(sess, spec, outdir, res):
    p = sess.page
    for raw in [a.strip() for a in spec.split(';') if a.strip()]:
        name, _, arg = raw.partition(':')
        if name == 'wait':
            p.wait_for_timeout(float(arg) * 1000)
        elif name == 'run':
            # 冻结模式下 wait 不推进章内时间；run 临时解冻，真实运行 N 秒后再冻结
            was = p.evaluate('() => !!(TAICHU.engine.setFrozen && TAICHU.engine.setFrozen(false))')
            p.wait_for_timeout(float(arg) * 1000)
            p.evaluate('w => TAICHU.engine.setFrozen && TAICHU.engine.setFrozen(w)', was)
        elif name == 'click':
            x, y = map(float, arg.split(','))
            p.mouse.click(x, y)
        elif name == 'move':
            x, y = map(float, arg.split(','))
            p.mouse.move(x, y)
        elif name == 'drag':
            v = [float(s) for s in arg.split(',')]
            steps = int(v[4]) if len(v) > 4 else 12
            p.mouse.move(v[0], v[1])
            p.mouse.down()
            p.mouse.move(v[2], v[3], steps=steps)
            p.mouse.up()
        elif name == 'wheel':
            v = [float(s) for s in arg.split(',')]
            if len(v) >= 3:
                p.mouse.move(v[1], v[2])
            p.mouse.wheel(0, v[0])
        elif name == 'resize':
            w, h = map(int, arg.split(','))
            p.set_viewport_size({'width': w, 'height': h})
        elif name == 'key':
            p.keyboard.press(arg)
        elif name == 'type':
            p.keyboard.type(arg)
        elif name == 'seek':
            sess.seek(float(arg))
        elif name == 'goto':
            p.evaluate('id => TAICHU.engine.goTo(id)', arg)
        elif name == 'eval':
            res.setdefault('eval', []).append(p.evaluate(arg))
        elif name == 'shot':
            path = sess.shot(os.path.join(outdir, arg + '.png'))
            res['shots'].append({'name': arg, 'path': path, 'stats': image_stats(path)})
        else:
            raise SystemExit(f'未知动作: {raw}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--ch', help='章节 id（testcard / singularity / galaxy / horizon / azure / life / logos）')
    ap.add_argument('--film', action='store_true', help='不指定章节：从片头开始（配合 --ui 1 与 --do 测试整片流程）')
    ap.add_argument('--t', type=float, default=1.0, help='章内时间（秒）')
    ap.add_argument('--seq', help='逗号分隔的多个章内时间（递增）')
    ap.add_argument('--sheet', action='store_true', help='把 --seq 的结果拼成一张联系表')
    ap.add_argument('--out', help='单帧输出路径（默认 shots/<ch>/<ch>_tNNN.N.png）')
    ap.add_argument('--outdir', help='输出目录（默认 shots/<ch>/）')
    ap.add_argument('--tag', default='', help='文件名后缀，用于区分迭代轮次，如 --tag _v2')
    ap.add_argument('--w', type=int, default=1280)
    ap.add_argument('--h', type=int, default=720)
    ap.add_argument('--dpr', type=float, default=1.0)
    ap.add_argument('--mobile', action='store_true', help='390x844 dpr3 触摸视口')
    ap.add_argument('--scale', type=float, help='固定渲染缩放（关闭动态分辨率）')
    ap.add_argument('--quality', type=int, choices=[0, 1, 2])
    ap.add_argument('--seed', type=int)
    ap.add_argument('--cam', help='az,el,dist 覆盖导演机位（弧度, 弧度, 距离）')
    ap.add_argument('--ui', type=int, default=0, choices=[0, 1], help='是否显示界面层（默认 0 = 纯画面）')
    ap.add_argument('--audio', type=int, default=0, choices=[0, 1], help='是否加载配乐模块（默认 0）')
    ap.add_argument('--only', help='--film 时只加载这些章节（逗号分隔 id；none = 一章也不加载）')
    ap.add_argument('--devfilm', action='store_true', help='--film 时把开发章（testcard / probe 等）也当作正片的幕')
    ap.add_argument('--wait', type=float, default=0.0, help='每次截图前额外等待的秒数')
    ap.add_argument('--do', help='交互动作序列，见上方说明')
    ap.add_argument('--perf', type=float, help='不冻结时间运行 N 秒并报告帧耗时')
    ap.add_argument('--selftest', action='store_true')
    ap.add_argument('--dist', action='store_true', help='测试构建产物 dist/taichu-standalone.html 而不是 dev.html')
    ap.add_argument('--timeout', type=float, default=120.0)
    a = ap.parse_args()
    if not a.ch and not a.film:
        ap.error('需要 --ch <id> 或 --film')

    name = a.ch or 'film'
    outdir = a.outdir or os.path.join(ROOT, 'shots', name)
    times = [float(x) for x in a.seq.split(',')] if a.seq else [a.t]
    page = 'dist/taichu-standalone.html' if a.dist else 'dev.html'
    res = {'ok': True, 'shots': []}
    sess = Session(a.w, a.h, a.dpr, a.mobile, a.timeout)
    try:
        try:
            if a.ch:
                sess.open(page, ch=a.ch, t=times[0], freeze=0 if a.perf else 1, ui=a.ui, audio=a.audio, glerr=1,
                          scale=a.scale, quality=a.quality, seed=a.seed, cam=a.cam)
            else:
                sess.open(page, wait='booted', dev=1, ui=a.ui, audio=a.audio, glerr=1, quality=a.quality, seed=a.seed,
                          only=a.only, devfilm=1 if a.devfilm else None)
        except Exception as e:  # noqa: BLE001
            res['ok'] = False
            res['error'] = '页面未就绪: ' + str(e)[:400]

        if res['ok']:
            if a.perf:
                sess.page.evaluate('() => TAICHU.engine.devResetPerf()')
                sess.page.wait_for_timeout(a.perf * 1000)
                res['perf'] = sess.status().get('perf')
            if a.do:
                run_actions(sess, a.do, outdir, res)
            elif a.ch and not a.perf:
                paths = []
                for i, t in enumerate(times):
                    if i > 0:
                        sess.seek(t)
                    if a.wait:
                        sess.page.wait_for_timeout(a.wait * 1000)
                    path = a.out if (a.out and len(times) == 1) else os.path.join(outdir, f'{name}{a.tag}_t{t:05.1f}.png')
                    sess.shot(path)
                    paths.append(path)
                    res['shots'].append({'t': t, 'path': path, 'stats': image_stats(path)})
                if a.sheet and len(paths) > 1:
                    res['sheet'] = contact_sheet(paths, os.path.join(outdir, f'{name}{a.tag}_sheet.png'),
                                                 [f't={t:g}s' for t in times])
            elif a.film:
                if a.wait:
                    sess.page.wait_for_timeout(a.wait * 1000)
                path = sess.shot(a.out or os.path.join(outdir, f'film{a.tag}.png'))
                res['shots'].append({'path': path, 'stats': image_stats(path)})
            if a.selftest and a.ch:
                res['selftest'] = sess.page.evaluate('id => TAICHU.engine.devSelfTest(id)', a.ch)
                if any(not r.get('pass') for r in (res['selftest'] or [])):
                    res['ok'] = False

        try:
            st = sess.status()
            res['status'] = {k: st.get(k) for k in ('chapter', 't', 'frames', 'frameMs', 'gpuMs', 'scale', 'width', 'height', 'quality')}
            errs = sess.errors()
        except Exception as e:  # noqa: BLE001
            errs = ['无法读取页面状态: ' + str(e)[:300]]
        if errs:
            res['ok'] = False
            res['errors'] = errs[:20]
        warns = [c['text'] for c in sess.console if c['type'] == 'warning']
        if warns:
            res['warnings'] = warns[:10]
    finally:
        sess.close()
    print(json.dumps(res, ensure_ascii=False, indent=1))
    sys.exit(0 if res['ok'] else 1)


if __name__ == '__main__':
    main()
