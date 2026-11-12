#!/usr/bin/env python3
"""太初 TAICHU 配乐检查：离线渲染一幕的配乐，输出统计、WAV 与频谱图。

用法：
  python3 tools/audio_check.py --id singularity
  python3 tools/audio_check.py --all
  python3 tools/audio_check.py --id galaxy --seconds 40

依赖页面里的 TAICHU.audio.renderOffline(id, seconds)，它返回
  { sampleRate, pcm16: <单声道小端 Int16 的 base64>, peak, rms }
输出：shots/audio/<id>.png（对数频率频谱图，竖线是契约 §7 的地标时刻）、shots/audio/<id>.wav。
判定失败（退出码 1）：峰值 > 0.9；整体 RMS 不在 −34..−18 dBFS；直流偏移 > 0.005；出现疑似爆音；页面报错。
"""
import argparse
import base64
import json
import os
import sys
import wave

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from shot import ROOT, Session  # noqa: E402

# 契约 §7 的时长与地标（章内秒）
ACTS = {
    'singularity': (84, [6, 13.5, 30, 40, 52, 70]),
    'galaxy': (86, [14, 30, 48, 58]),
    'horizon': (78, [12, 40, 62, 72]),
    'azure': (84, [14, 30, 46, 60]),
    'life': (78, [8, 14, 20, 26, 32, 40, 62]),
    'logos': (80, [8, 14, 20, 26, 32, 40, 48, 56, 64]),
}


def db(x):
    return 20 * np.log10(max(float(x), 1e-9))


def spectrogram(x, sr, out, marks, title):
    n, hop = 2048, 512
    if len(x) < n:
        x = np.pad(x, (0, n - len(x)))
    win = np.hanning(n).astype(np.float32)
    frames = 1 + (len(x) - n) // hop
    idx = np.arange(n)[None, :] + hop * np.arange(frames)[:, None]
    mag = np.abs(np.fft.rfft(x[idx] * win, axis=1)) / (n / 4)
    freqs = np.fft.rfftfreq(n, 1 / sr)
    H, W = 420, 1400
    f_lo, f_hi = 25.0, sr / 2
    ys = np.exp(np.linspace(np.log(f_hi), np.log(f_lo), H))          # 自上而下：高频 → 低频
    bins = np.clip(np.searchsorted(freqs, ys), 1, len(freqs) - 1)
    cols = np.clip((np.arange(W) * frames / W).astype(int), 0, frames - 1)
    img = 20 * np.log10(mag[cols][:, bins].T + 1e-7)                  # H × W，单位 dB
    v = np.clip((img + 90) / 80, 0, 1)                                # −90..−10 dB → 0..1
    rgb = np.stack([np.clip(v * 2.2 - 0.4, 0, 1), np.clip(v * 2.0 - 0.9, 0, 1) ** 1.2, np.clip(0.9 * v * (1.6 - v), 0, 1)], -1)
    im = Image.fromarray((rgb * 255).astype(np.uint8)).convert('RGB')
    canvas = Image.new('RGB', (W + 60, H + 40), (0, 0, 0))
    canvas.paste(im, (50, 20))
    d = ImageDraw.Draw(canvas)
    dur = len(x) / sr
    for f in (50, 100, 200, 500, 1000, 2000, 5000, 10000):
        if f < f_hi:
            y = 20 + int(H * (np.log(f_hi) - np.log(f)) / (np.log(f_hi) - np.log(f_lo)))
            d.line([(46, y), (50, y)], fill=(160, 160, 160))
            d.text((2, y - 5), f'{f}' if f < 1000 else f'{f // 1000}k', fill=(160, 160, 160))
    for t in range(0, int(dur) + 1, 10):
        xx = 50 + int(W * t / dur)
        d.line([(xx, H + 20), (xx, H + 25)], fill=(160, 160, 160))
        d.text((xx - 6, H + 27), str(t), fill=(160, 160, 160))
    for t in marks:
        if t < dur:
            xx = 50 + int(W * t / dur)
            d.line([(xx, 20), (xx, H + 20)], fill=(255, 255, 255))
            d.text((xx + 3, 22), f'{t:g}', fill=(255, 255, 255))
    d.text((50, 4), title, fill=(220, 220, 220))
    canvas.save(out)


def check(sess, cid, seconds, outdir):
    dur, marks = ACTS.get(cid, (seconds or 30, []))
    seconds = seconds or dur
    r = sess.page.evaluate('([id, s]) => TAICHU.audio.renderOffline(id, s)', [cid, seconds])
    sr = int(r['sampleRate'])
    x = np.frombuffer(base64.b64decode(r['pcm16']), dtype='<i2').astype(np.float32) / 32768.0
    with wave.open(os.path.join(outdir, f'{cid}.wav'), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((x * 32767).astype('<i2').tobytes())
    peak = float(np.abs(x).max()) if len(x) else 0.0
    rms = float(np.sqrt(np.mean(x ** 2))) if len(x) else 0.0
    dc = float(abs(x.mean())) if len(x) else 0.0
    seg = 5 * sr
    windows = [round(db(np.sqrt(np.mean(x[i:i + seg] ** 2))), 1) for i in range(0, len(x) - seg + 1, seg)]
    # 疑似爆音：相邻采样的跳变远大于附近的典型跳变，且绝对值可闻
    diff = np.abs(np.diff(x))
    k = 256
    pad = np.pad(diff, (k, k), mode='edge')
    csum = np.cumsum(np.insert(pad, 0, 0.0))
    local = (csum[2 * k:] - csum[:-2 * k])[:len(diff)] / (2 * k)
    clicks = np.where((diff > 0.12) & (diff > 12 * (local + 1e-5)))[0]
    click_times = sorted({round(float(i) / sr, 2) for i in clicks})[:12]
    png = os.path.join(outdir, f'{cid}.png')
    spectrogram(x, sr, png, marks, f'{cid}  {seconds:g}s  peak {peak:.2f}  rms {db(rms):.1f} dBFS')
    problems = []
    if peak > 0.9:
        problems.append(f'峰值 {peak:.2f} > 0.9')
    if not (-34 <= db(rms) <= -18):
        problems.append(f'整体 RMS {db(rms):.1f} dBFS 不在 −34..−18')
    if dc > 0.005:
        problems.append(f'直流偏移 {dc:.4f} > 0.005')
    if click_times:
        problems.append(f'疑似爆音 @ {click_times} s')
    return {'id': cid, 'seconds': seconds, 'peak': round(peak, 3), 'rmsDb': round(db(rms), 1), 'dc': round(dc, 5),
            'rmsDbPer5s': windows, 'clicks': click_times, 'spectrogram': png, 'problems': problems}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--id')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--seconds', type=float)
    a = ap.parse_args()
    ids = list(ACTS) if a.all else [a.id]
    if not ids or ids == [None]:
        ap.error('需要 --id <幕id> 或 --all')
    outdir = os.path.join(ROOT, 'shots', 'audio')
    os.makedirs(outdir, exist_ok=True)
    sess = Session(800, 450, 1.0, timeout=180.0)
    res = {'ok': True, 'acts': []}
    try:
        sess.open('dev.html', wait='booted', dev=1, only='none', ui=0, audio=1)
        for cid in ids:
            try:
                row = check(sess, cid, a.seconds, outdir)
            except Exception as e:  # noqa: BLE001
                row = {'id': cid, 'problems': ['渲染失败: ' + str(e)[:400]]}
            res['acts'].append(row)
            if row['problems']:
                res['ok'] = False
        errs = sess.errors()
        if errs:
            res['ok'] = False
            res['errors'] = errs[:20]
    finally:
        sess.close()
    print(json.dumps(res, ensure_ascii=False, indent=1))
    sys.exit(0 if res['ok'] else 1)


if __name__ == '__main__':
    main()
