/* 太初 TAICHU — 配乐。全部由 WebAudio 当场合成。
   时间线由 sync(time) 的章内时间驱动；实时与离线渲染（renderOffline）走同一套建图与调度代码。 */
(function () {
  'use strict';
  const T = (window.TAICHU = window.TAICHU || {});

  // ── 小工具 ──
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rngOf(seed, tag) {
    const r = mulberry32((seed ^ hashStr(tag)) >>> 0);
    r.range = function (a, b) { return a + (b - a) * r(); };
    r.int = function (n) { return Math.floor(r() * n); };
    r.pick = function (arr) { return arr[Math.floor(r() * arr.length)]; };
    return r;
  }
  const clamp = function (x, a, b) { return x < a ? a : x > b ? b : x; };
  const sstep = function (a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const m2f = function (m) { return 440 * Math.pow(2, (m - 69) / 12); };
  // 五声音阶 D E F♯ A B；degree 0 = D4
  const PENT = [0, 2, 4, 7, 9];
  const pent = function (i) { const o = Math.floor(i / 5); return m2f(62 + 12 * o + PENT[((i % 5) + 5) % 5]); };
  const D1 = 36.708, D2 = 73.416, D3 = 146.832, D4 = 293.665, D5 = 587.33;

  const LOOK_RT = 0.2;          // 实时前瞻
  const XFADE = 2.5;            // 换幕等功率交叉淡化
  const MAX_OSC = 30;           // 同时振荡器上限（含 FM 调制器与颤音 LFO）

  // ── 混音器：一个上下文一套（AudioContext 或 OfflineAudioContext） ──
  function makeMixer(ac, seed, realtime) {
    const M = { ac: ac, seed: seed, rt: realtime, osc: 0, created: 0, live: 0, acts: [], cur: null, waves: {} };
    M.reg = function (n) { M.created++; M.live++; return n; };
    M.free = function (nodes) { for (const n of nodes) { try { n.disconnect(); } catch (e) { /* 已断开 */ } M.live--; } };
    const R = rngOf(seed, 'mixer');

    M.duck = M.reg(ac.createGain());
    M.duck.gain.value = 0.62;
    const comp = M.reg(ac.createDynamicsCompressor());
    comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.01; comp.release.value = 0.25; comp.knee.value = 6;
    const shaper = M.reg(ac.createWaveShaper());
    const N = 2048, curve = new Float32Array(N);
    for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * 2 - 1; curve[i] = 0.86 * Math.tanh(x * 1.6 / 0.86) ; }
    shaper.curve = curve; shaper.oversample = '2x';
    M.mute = M.reg(ac.createGain());
    M.duck.connect(comp); comp.connect(shaper); shaper.connect(M.mute); M.mute.connect(ac.destination);
    if (realtime) {
      M.an = M.reg(ac.createAnalyser()); M.an.fftSize = 1024; M.an.smoothingTimeConstant = 0.5;
      M.mute.connect(M.an);
      M.fbuf = new Uint8Array(M.an.frequencyBinCount); M.tbuf = new Float32Array(M.an.fftSize);
    }

    // 混响：立体声去相关噪声 × 指数衰减，高频衰减更快（一阶低通的截止随时间下降）
    const sr = ac.sampleRate, len = Math.floor(sr * 5.2);
    const ir = ac.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c); let y = 0, e2 = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr, a = 0.08 + 0.85 * Math.exp(-t / 1.1);
        y += a * ((R() * 2 - 1) - y);
        d[i] = y * Math.exp(-t / 0.75) * (t < 0.012 ? t / 0.012 : 1);
        e2 += d[i] * d[i];
      }
      const k = 0.8 / Math.sqrt(e2);   // 单位能量：湿声与干声大致同量级
      for (let i = 0; i < len; i++) d[i] *= k;
    }
    M.verb = M.reg(ac.createConvolver()); M.verb.normalize = false; M.verb.buffer = ir;
    M.verb.connect(M.duck);

    // 噪声素材
    const nlen = sr * 4;
    M.white = ac.createBuffer(1, nlen, sr); M.brown = ac.createBuffer(1, nlen, sr);
    { const w = M.white.getChannelData(0), b = M.brown.getChannelData(0); let y = 0, mx = 0;
      for (let i = 0; i < nlen; i++) { w[i] = R() * 2 - 1; y = (y + 0.02 * w[i]) * 0.995; b[i] = y; }
      let mean = 0; for (let i = 0; i < nlen; i++) mean += b[i] / nlen;
      for (let i = 0; i < nlen; i++) { b[i] -= mean; mx = Math.max(mx, Math.abs(b[i])); }
      // 首尾交叉，循环无缝
      const f = Math.floor(sr * 0.05);
      for (let i = 0; i < f; i++) { const a = i / f; w[i] = w[i] * a + w[nlen - f + i] * (1 - a); b[i] = b[i] * a + b[nlen - f + i] * (1 - a); }
      for (let i = 0; i < nlen; i++) b[i] /= mx; }
    const dl = Math.floor(sr * 0.05);
    M.drop = ac.createBuffer(1, dl, sr);
    { const d = M.drop.getChannelData(0); let p = 0;
      for (let i = 0; i < dl; i++) { const x = R() * 2 - 1; d[i] = (x - p) * Math.exp(-i / sr / 0.006) * (i < 8 ? i / 8 : 1); p = x; } }

    function pw(amps) {
      const re = new Float32Array(amps.length + 1), im = new Float32Array(amps.length + 1);
      amps.forEach(function (a, i) { im[i + 1] = a; });
      return ac.createPeriodicWave(re, im);
    }
    const warm = []; for (let n = 1; n <= 12; n++) warm.push(1 / Math.pow(n, 1.6));
    const soft = []; for (let n = 1; n <= 9; n++) soft.push(n % 2 ? 1 / (n * n) : 0.08 / (n * n));
    M.waves.warm = pw(warm); M.waves.soft = pw(soft); M.waves.flute = pw([1, 0.35, 0.12, 0.06, 0.03]);
    return M;
  }

  // ── 乐器 ──
  // 包络：pads 线性起落；perc 指数衰减后补一段到 0 的线性尾；shape 用曲线（首尾为 0）
  function envelope(g, o, w, end) {
    const p = g.gain, pk = o.g;
    if (o.shape) { p.setValueAtTime(0, w); p.setValueCurveAtTime(o.shape(pk), w, end - w); return; }
    const a = Math.max(0.003, Math.min(o.a || 0.01, (end - w) * 0.5));
    p.setValueAtTime(0, w); p.linearRampToValueAtTime(pk, w + a);
    if (o.perc) { p.exponentialRampToValueAtTime(Math.max(1e-5, pk * 1e-3), end - 0.03); p.linearRampToValueAtTime(0, end); }
    else { const r = Math.min(o.r || 0.5, end - w - a); p.linearRampToValueAtTime(pk, end - r); p.linearRampToValueAtTime(0, end); }
  }
  function route(A, o, node, nodes, w, end) {
    const M = A.M, ac = M.ac;
    const g = M.reg(ac.createGain()); nodes.push(g); envelope(g, o, w, end); node.connect(g);
    const p = M.reg(ac.createStereoPanner()); nodes.push(p);
    p.pan.setValueAtTime(clamp(o.pan || 0, -1, 1), w);
    if (o.pan1 !== undefined) p.pan.linearRampToValueAtTime(clamp(o.pan1, -1, 1), end);
    g.connect(p); p.connect(A.dryIn);
    const s = M.reg(ac.createGain()); nodes.push(s); s.gain.value = o.send === undefined ? 0.35 : o.send;
    p.connect(s); s.connect(A.wetIn);
  }
  function filt(A, o, node, nodes, w, end) {
    if (!o.lp) return node;
    const ac = A.M.ac, f = A.M.reg(ac.createBiquadFilter()); nodes.push(f);
    f.type = o.lp.type || 'lowpass'; f.Q.value = o.lp.q || 0.7;
    f.frequency.setValueAtTime(o.lp.f0, w);
    if (o.lp.f1) f.frequency.exponentialRampToValueAtTime(o.lp.f1, Math.min(end, w + (o.lp.t || end - w)));
    node.connect(f); return f;
  }
  // 振荡器声部：o = { when, dur, f, f2, gt, wave, g, a, r, perc, shape, pan, pan1, send, lp, fm:{r,i,d}, trem:{f,depth}, must }
  function voice(A, o) {
    const M = A.M, ac = M.ac;
    const n = 1 + (o.fm ? 1 : 0) + (o.trem ? 1 : 0);
    if (!o.must && M.osc + n > MAX_OSC) return;
    const w = Math.max(o.when, ac.currentTime), end = w + o.dur, nodes = [];
    const osc = M.reg(ac.createOscillator()); nodes.push(osc);
    if (M.waves[o.wave]) osc.setPeriodicWave(M.waves[o.wave]); else osc.type = o.wave || 'sine';
    osc.frequency.setValueAtTime(o.f, w);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, w + (o.gt || o.dur));
    const oscs = [osc];
    if (o.fm) {
      const m = M.reg(ac.createOscillator()), mg = M.reg(ac.createGain()); nodes.push(m, mg); oscs.push(m);
      m.frequency.value = o.f * o.fm.r;
      mg.gain.setValueAtTime(o.f * o.fm.i, w);
      mg.gain.exponentialRampToValueAtTime(o.f * o.fm.i * 0.03 + 0.01, w + Math.min(o.fm.d, o.dur));
      m.connect(mg); mg.connect(osc.frequency);
    }
    let node = filt(A, o, osc, nodes, w, end);
    if (o.trem) {
      const tg = M.reg(ac.createGain()), lfo = M.reg(ac.createOscillator()), lg = M.reg(ac.createGain());
      nodes.push(tg, lfo, lg); oscs.push(lfo);
      tg.gain.value = 1 - o.trem.depth; lg.gain.value = o.trem.depth; lfo.frequency.value = o.trem.f;
      lfo.connect(lg); lg.connect(tg.gain); node.connect(tg); node = tg;
    }
    route(A, o, node, nodes, w, end);
    M.osc += oscs.length;
    for (const x of oscs) { x.start(w); x.stop(end + 0.05); }
    osc.onended = function () { M.osc -= oscs.length; M.free(nodes); };
  }
  // 噪声声部：o.src = 'white' | 'brown' | 'drop'；o.rate 播放速率
  function nvoice(A, o) {
    const M = A.M, ac = M.ac;
    const w = Math.max(o.when, ac.currentTime), end = w + o.dur, nodes = [];
    const s = M.reg(ac.createBufferSource()); nodes.push(s);
    s.buffer = M[o.src || 'white'];
    if (o.src !== 'drop') s.loop = true;
    if (o.rate) s.playbackRate.value = o.rate;
    const node = filt(A, o, s, nodes, w, end);
    route(A, o, node, nodes, w, end);
    s.start(w, o.src === 'drop' ? 0 : A.R() * 3.5);
    s.stop(end + 0.05);
    s.onended = function () { M.free(nodes); };
  }
  // 曲线形状：Hann 窗（可从中途开始；中途开始时加 1 秒淡入以免爆音）
  function hann(p0, dur) {
    return function (pk) {
      const n = 256, c = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1), ph = p0 + (1 - p0) * u;
        c[i] = pk * 0.5 * (1 - Math.cos(2 * Math.PI * ph)) * (p0 > 0 ? Math.min(1, u * dur) : 1);
      }
      c[n - 1] = 0; return c;
    };
  }
  function bell(A, w, f, g, o) {
    o = o || {};
    voice(A, { when: w, f: f, wave: 'sine', fm: { r: o.r || 3.5, i: o.i || 1.6, d: o.d || 1.2 }, perc: true, a: 0.004,
      dur: o.dur || 4, g: g, pan: o.pan !== undefined ? o.pan : A.R.range(-0.8, 0.8), send: o.send || 0.7, must: o.must });
  }
  function pluck(A, w, f, g, pan, kind) {
    const k = kind === 'kalimba' ? { r: 1, i: 1.4, d: 0.3 } : kind === 'glass' ? { r: 3.5, i: 0.7, d: 0.4 } : { r: 4, i: 2.2, d: 0.12 };
    voice(A, { when: w, f: f, wave: 'sine', fm: k, perc: true, a: 0.003, dur: kind === 'glass' ? 1.8 : 1.2, g: g, pan: pan, send: 0.35 });
  }
  function pad(A, w, off, d, freqs, gains, o) {
    o = o || {};
    const dur = d - off;
    if (dur < 0.5) return;
    freqs.forEach(function (f, i) {
      const lp = o.lp ? { f0: o.lp.f1 ? o.lp.f0 * Math.pow(o.lp.f1 / o.lp.f0, Math.min(1, off / (o.lp.t || d))) : o.lp.f0,
        f1: o.lp.f1, t: o.lp.t ? Math.max(0.1, o.lp.t - off) : undefined, q: o.lp.q } : null;
      voice(A, { when: w, dur: dur, f: f, wave: o.wave || 'warm', g: Array.isArray(gains) ? gains[i] : gains,
        a: off > 0 ? Math.min(1.5, o.a || 3) : (o.a || 3), r: o.r || 4, lp: lp, send: o.send === undefined ? 0.55 : o.send,
        pan: o.spread ? (i / Math.max(1, freqs.length - 1) - 0.5) * o.spread : 0, shape: o.shape, must: o.must });
    });
  }
  function bowl(A, w, f, g) {
    const parts = [[1, 1, 9], [2.76, 0.45, 5], [5.4, 0.22, 3]];
    for (const p of parts) for (const det of [0, 0.7]) {
      voice(A, { when: w, f: f * p[0] + det, wave: 'sine', perc: true, a: 0.006, dur: p[2], g: g * p[1] * 0.5,
        pan: det ? 0.25 : -0.25, send: 0.7, must: true });
    }
    nvoice(A, { when: w, dur: 0.12, src: 'white', perc: true, a: 0.002, g: g * 0.8, lp: { type: 'bandpass', f0: f * 2, q: 4 }, send: 0.5 });
  }
  function flute(A, w, f, dur, g) {
    voice(A, { when: w, f: f, dur: dur, wave: 'flute', a: 0.07, r: Math.min(0.4, dur * 0.4), g: g, send: 0.55, must: true });
    nvoice(A, { when: w, dur: dur, src: 'white', a: 0.05, r: Math.min(0.3, dur * 0.4), g: g * 0.5, lp: { type: 'bandpass', f0: f, q: 9 }, send: 0.5 });
  }

  // ── 六幕的时间线。build(R) 返回事件表 { t, d?, fn(A, when, off) }；d 表示持续段，seek 进入中段时以 off 续上 ──
  function list() {
    const L = [];
    L.at = function (t, fn, d) { L.push({ t: t, d: d, fn: fn }); };
    return L;
  }
  const ACTS = {};

  ACTS.singularity = { dur: 84, level: 1.0, build: function (R) {
    const L = list();
    L.at(0, function (A, w, off) {
      voice(A, { when: w, f: D3, dur: 13.65 - off, a: off ? 1 : 3, r: 0.15, g: 0.05, wave: 'sine', send: 0.45, trem: { f: 0.22, depth: 0.45 }, must: true });
    }, 13.6);
    L.at(6, function (A, w) {
      nvoice(A, { when: w, dur: 7.6, a: 7.25, r: 0.3, g: 0.1, lp: { type: 'bandpass', f0: 180, f1: 2600, q: 3 }, send: 0.5 });
    });
    for (let k = 0; k < 10; k++) {
      const t = 6 + k * 0.75, d = Math.min(6, 13.7 - t);
      L.at(t, function (A, w) {
        const f = 110 * Math.pow(2, k * 0.25 % 1);
        voice(A, { when: w, f: f, f2: f * Math.pow(2, 3 * d / 6), dur: d, wave: 'soft', g: 0.014 + 0.004 * k, shape: hann(0, d), pan: (k % 2 ? 0.3 : -0.3), send: 0.5 });
      });
    }
    L.at(13.5, function (A, w) {
      voice(A, { when: w, f: 120, f2: 36, gt: 0.8, dur: 4, a: 0.008, perc: true, g: 0.6, wave: 'sine', send: 0.6, must: true });
      voice(A, { when: w, f: 240, f2: 72, gt: 0.8, dur: 2.5, a: 0.008, perc: true, g: 0.16, wave: 'soft', send: 0.6, must: true });
      nvoice(A, { when: w, dur: 3.2, a: 0.012, perc: true, g: 0.5, lp: { f0: 9000, f1: 220, t: 2.6, q: 0.5 }, send: 1.0 });
    });
    L.at(14, function (A, w, off) {
      pad(A, w, off, 18, [D2, D2 * 1.5, D3, D3 * 1.5, D4], [0.07, 0.055, 0.04, 0.03, 0.015],
        { a: 3, r: 4, lp: { f0: 3200, f1: 260, t: 16 }, send: 0.55, spread: 0.6, must: true });
    }, 18);
    L.at(30, function (A, w, off) {
      pad(A, w, off, 56, [D1, D2], [0.028, 0.01], { wave: 'soft', a: 4, r: 6, lp: { f0: 200 }, send: 0.3, must: true });
    }, 56);
    for (let t = 31; t < 66; t += R.range(2.5, 4.5)) {
      L.at(t, function (A, w) { voice(A, { when: w, f: 58, f2: 40, gt: 0.4, dur: 2.2, a: 0.01, perc: true, g: 0.13, wave: 'soft', lp: { f0: 220 }, send: 0.5 }); });
    }
    for (let n = 2; n <= 13; n++) {
      const tn = 40 + (n - 2) * 2.4;
      L.at(tn, function (A, w, off) {
        voice(A, { when: w, f: D1 * n, dur: 86 - tn - off, wave: 'sine', a: off ? 1.5 : 4, r: 5, g: 0.04 / Math.sqrt(n),
          pan: (n % 2 ? -1 : 1) * 0.35 * n / 13, send: 0.5, must: true });
      }, 86 - tn);
    }
    for (let t = 52; t < 84;) {
      const deg = 5 + R.int(10), g = 0.035 * R.range(0.6, 1), dd = R.range(3, 5);
      L.at(t, function (A, w) { bell(A, w, pent(deg), g, { dur: dd }); });
      t += (3.2 + (0.55 - 3.2) * Math.pow((t - 52) / 32, 0.8)) * R.range(0.6, 1.4);
    }
    return L;
  }, tail: { start: 84, period: 16, fn: function (A, w) {
    pad(A, w, 0, 20, [D1 * 2, D1 * 3, D1 * 4, D1 * 6], [0.03, 0.022, 0.018, 0.012], { a: 5, r: 6, send: 0.5 });
    for (let i = 0; i < 3; i++) bell(A, w + A.R.range(1, 15), pent(5 + A.R.int(10)), 0.025, { dur: 4 });
  } } };

  ACTS.galaxy = { dur: 86, level: 1.0, build: function (R) {
    const L = list();
    const arpA = [50, 57, 64, 66, 69, 64], arpB = [69, 71, 74, 78, 76];
    let i = 0;
    for (let t = 0; t < 57.6; t += 2.4, i++) {
      const m = t >= 52 ? (i % 2 ? 57 : 62) : arpA[i % arpA.length];
      const swing = t > 30 && t < 48 ? 1.5 : 1;
      L.at(t, function (A, w) {
        voice(A, { when: w, f: m2f(m), dur: 5, a: 0.9, r: 2.5, g: 0.05, wave: 'soft', lp: { f0: 2000 }, send: 0.55,
          pan: clamp((0.5 * Math.sin(2 * Math.PI * t / 17) - 0.15) * swing, -0.9, 0.9) });
      });
    }
    i = 0;
    for (let t = 14; t < 57.6; t += 1.6, i++) {
      const m = t >= 52 ? (i % 2 ? 69 : 74) : arpB[i % arpB.length];
      const swing = t > 30 && t < 48 ? 1.5 : 1;
      L.at(t, function (A, w) {
        voice(A, { when: w, f: m2f(m), dur: 3.2, a: 0.3, r: 1.5, g: 0.035 * sstep(14, 20, t + 1), wave: 'sine', fm: { r: 2, i: 0.6, d: 0.8 }, send: 0.6,
          pan: clamp((0.5 * Math.sin(2 * Math.PI * t / 11 + 2) + 0.15) * swing, -0.9, 0.9) });
      });
    }
    L.at(28.6, function (A, w) {
      [61, 62, 63, 65, 66, 68].forEach(function (m, k) {
        voice(A, { when: w, f: m2f(m), dur: 5.5, a: 1.4, perc: true, g: 0.035, wave: 'soft', lp: { f0: 900, f1: 2500, t: 1.5 }, send: 0.8, pan: (k / 5 - 0.5) * 1.2, must: true });
      });
      nvoice(A, { when: w, dur: 5, a: 1.4, perc: true, g: 0.14, lp: { type: 'bandpass', f0: 400, f1: 1600, t: 1.5, q: 1.5 }, send: 0.8 });
    });
    L.at(30, function (A, w) { voice(A, { when: w, f: D2, f2: 55, gt: 1, dur: 3, a: 0.02, perc: true, g: 0.15, wave: 'soft', send: 0.6, must: true }); });
    L.at(58, function (A, w) {
      bell(A, w, D5, 0.05, { r: 2, i: 0.8, dur: 6, pan: 0, must: true });
      bell(A, w, D4, 0.05, { r: 2, i: 0.8, dur: 6, pan: 0, must: true });
    });
    L.at(58, function (A, w, off) {
      pad(A, w, off, 28, [D2, D3, D3 * 1.5, D4, D4 * 1.25, D4 * 1.5, D4 * 2.25], [0.032, 0.04, 0.035, 0.03, 0.025, 0.02, 0.015],
        { a: 2.5, r: 20, lp: { f0: 4000, f1: 900, t: 28 }, send: 0.6, spread: 0.8, must: true });
    }, 28);
    for (let t = 60.5; t < 84; t += R.range(2.5, 5)) {
      const deg = 5 + R.int(6), g = 0.04 * (1 - (t - 60) / 30);
      L.at(t, function (A, w) { bell(A, w, pent(deg), g, { r: 2, i: 0.9, dur: 5 }); });
    }
    return L;
  }, tail: { start: 86, period: 14, fn: function (A, w) {
    pad(A, w, 0, 18, [D3, D3 * 1.5, D4 * 1.25, D4 * 2.25], [0.035, 0.028, 0.02, 0.012], { a: 4, r: 6, lp: { f0: 1600 }, spread: 0.8 });
    for (let i = 0; i < 2; i++) bell(A, w + A.R.range(1, 12), pent(5 + A.R.int(6)), 0.025, { r: 2, i: 0.9, dur: 5 });
  } } };

  ACTS.horizon = { dur: 78, level: 1.0, build: function (R) {
    const L = list();
    L.at(0, function (A, w, off) {
      pad(A, w, off, 78, [D1, D1 + 0.5, 27.5], [0.05, 0.045, 0.035], { a: 4, r: 16, lp: { f0: 240 }, send: 0.4, must: true });
    }, 78);
    // 无尽下行的谢泼德–里塞滑音：每 4 秒一个分量，24 秒滑过 6 个八度
    for (let ts = -20; ts <= 56; ts += 4) {
      L.at(Math.max(0, ts), function (A, w, off0) {
        const off = Math.max(0, -ts) + off0, Ld = 24, f0 = 1760 * Math.pow(2, -6 * off / Ld);
        voice(A, { when: w, f: f0, f2: 27.5, dur: Ld - off, wave: 'sine', g: 0.024, shape: hann(off / Ld, Ld - off), send: 0.6, pan: Math.sin(ts) * 0.4, must: true });
      });
    }
    for (let t = 3; t < 66; t += R.range(5, 9)) {
      const f = R.pick([110, 146.8, 196, 220, 293.7]);
      L.at(t, function (A, w) { voice(A, { when: w, f: f, wave: 'sine', fm: { r: 1.414, i: 2.5, d: 4 }, perc: true, a: 0.01, dur: 7, g: 0.035, pan: A.R.range(-0.7, 0.7), send: 0.9 }); });
    }
    for (let t = 28; t < 64; t += 1.43) {
      const h = sstep(28, 40, t) * (1 - sstep(56, 64, t));
      if (h < 0.03) continue;
      L.at(t, function (A, w) {
        voice(A, { when: w, f: 55, f2: 38, gt: 0.15, dur: 0.6, a: 0.006, perc: true, g: 0.2 * h, wave: 'soft', lp: { f0: 160 }, send: 0.3, must: true });
        voice(A, { when: w + 0.28, f: 52, f2: 36, gt: 0.15, dur: 0.6, a: 0.006, perc: true, g: 0.12 * h, wave: 'soft', lp: { f0: 160 }, send: 0.3, must: true });
      });
    }
    [36, 43, 50, 57].forEach(function (t, k) {
      L.at(t, function (A, w) {
        const p = k % 2 ? 0.8 : -0.8;
        nvoice(A, { when: w, dur: 3.5, g: 0.13, shape: hann(0, 3.5), lp: { type: 'bandpass', f0: 2400, f1: 300, q: 5 }, pan: p, pan1: -p, send: 0.7 });
        voice(A, { when: w, f: 220, f2: 140, dur: 3.5, wave: 'soft', g: 0.025, shape: hann(0, 3.5), pan: p, pan1: -p, send: 0.7 });
      });
    });
    L.at(72, function (A, w, off) {
      A.send.gain.cancelScheduledValues(w);
      A.send.gain.setValueAtTime(Math.max(0, 1 - off / 6), w);
      A.send.gain.linearRampToValueAtTime(0, w + Math.max(0.05, 6 - off));
    }, 1e9);
    return L;
  }, realign: function (A, T0, w) { if (T0 < 72) { A.send.gain.cancelScheduledValues(w); A.send.gain.setValueAtTime(1, w); } },
  tail: { start: 78, period: 20, fn: function (A, w) {
    pad(A, w, 0, 22, [D1, D1 + 0.5], [0.025, 0.022], { a: 6, r: 6, lp: { f0: 200 }, send: 0 });
  } } };

  ACTS.azure = { dur: 84, level: 1.0, build: function (R) {
    const L = list();
    L.at(0, function (A, w, off) {
      if (32 - off < 1) return;
      nvoice(A, { when: w, dur: 32 - off, src: 'brown', a: off ? 1.5 : 2, r: Math.max(0.5, 18 - Math.max(0, off - 14)), g: 0.32, lp: { f0: 170 }, send: 0.25 });
    }, 32);
    for (let t = 0.3; t < 28;) {
      const f = R.range(250, 1800), g = 0.4 * R.range(0.3, 1), p = R.range(-0.8, 0.8);
      L.at(t, function (A, w) { nvoice(A, { when: w, dur: 0.25, perc: true, a: 0.002, g: g, lp: { type: 'bandpass', f0: f, q: 18 }, pan: p, send: 0.3 }); });
      t += R.range(0.08, 0.5) * (1 + 3 * sstep(14, 26, t));
    }
    // 降雨：颗粒由疏到密
    for (let t = 30; t < 84;) {
      const rate = 3 + 22 * sstep(30, 44, t), rr = R.range(0.7, 1.6), g = R.range(0.03, 0.09), p = R.range(-1, 1);
      L.at(t, function (A, w) { nvoice(A, { when: w, dur: 0.06, src: 'drop', rate: rr, a: 0.002, r: 0.01, g: g, pan: p, send: 0.25 }); });
      t += -Math.log(1 - R() * 0.999) / rate;
    }
    L.at(30, function (A, w, off) { nvoice(A, { when: w, dur: 54 - off, a: off ? 1.5 : 12, r: 6, g: 0.05, lp: { type: 'highpass', f0: 3500, q: 0.5 }, send: 0.2 }); }, 54);
    L.at(30, function (A, w, off) {
      pad(A, w, off, 32, [D3, D3 * 1.25, D3 * 1.5, D3 * 1.875, D3 * 2.25, D3 * 2.8125], 0.028, { a: 5, r: 6, lp: { f0: 2400 }, send: 0.6, spread: 0.9 });
    }, 32);
    L.at(46, function (A, w, off) {
      pad(A, w, off, 38, [D2, D2 * 1.5, D3 * 1.125, D3 * 1.5, D4 * 1.25, D4 * 1.875, D5 * 1.125], 0.026, { a: 5, r: 8, lp: { f0: 3500 }, send: 0.6, spread: 1.2 });
    }, 38);
    const arp = [D5, D5 * 1.25, D5 * 1.5, D5 * 1.875, D5 * 2.25, D5 * 1.5, D5 * 1.25, D5 * 1.125];
    let i = 0;
    for (let t = 46; t < 84; i++) {
      const f = arp[i % arp.length], g = t < 60 ? 0.022 : 0.013, p = 0.6 * Math.sin(i * 0.7);
      L.at(t, function (A, w) { voice(A, { when: w, f: f, wave: 'sine', fm: { r: 1, i: 0.8, d: 0.25 }, perc: true, a: 0.01, dur: 1.6, g: g, pan: p, send: 0.6 }); });
      t += t < 60 ? 0.5 : 1.0;
    }
    for (let t = 46; t < 84; t += R.range(8, 10)) {
      const p = R.range(-0.5, 0.5);
      L.at(t, function (A, w) { nvoice(A, { when: w, dur: 9, g: 0.16, shape: hann(0, 9), lp: { f0: 650, q: 0.6 }, pan: p, pan1: -p, send: 0.4 }); });
    }
    // 生命动机 A–B–D
    [[60, 1], [70, 0.6]].forEach(function (rep) {
      L.at(rep[0], function (A, w) {
        flute(A, w, m2f(69), 0.5, 0.07 * rep[1]); flute(A, w + 0.45, m2f(71), 0.5, 0.07 * rep[1]); flute(A, w + 0.9, m2f(74), 1.8, 0.07 * rep[1]);
      });
    });
    return L;
  }, tail: { start: 84, period: 18, fn: function (A, w) {
    pad(A, w, 0, 22, [D3, D3 * 1.5, D3 * 2.25, D3 * 2.8125], 0.022, { a: 5, r: 6, lp: { f0: 2400 }, spread: 0.9 });
    nvoice(A, { when: w + 2, dur: 9, g: 0.14, shape: hann(0, 9), lp: { f0: 650, q: 0.6 }, pan: -0.4, pan1: 0.4, send: 0.4 });
  } } };

  const breath = function (t) { return 0.35 + 0.65 * 0.5 * (1 - Math.cos(2 * Math.PI * (t - 62) / 5.88)); };
  ACTS.life = { dur: 78, level: 1.0, build: function (R) {
    const L = list();
    L.at(0, function (A, w, off) { pad(A, w, off, 78, [D2, D2 * 0.75], [0.03, 0.018], { wave: 'soft', a: 3, r: 6, lp: { f0: 160 }, send: 0.4, must: true }); }, 78);
    for (let t = 0.8; t < 78; t += t < 40 ? R.range(1.8, 3.5) : R.range(4, 7)) {
      const f = R.range(900, 1500), p = R.range(-0.8, 0.8);
      L.at(t, function (A, w) { voice(A, { when: w, f: f, f2: f * 0.55, gt: 0.12, perc: true, a: 0.003, dur: 0.5, g: 0.016, wave: 'sine', pan: p, send: 0.8 }); });
    }
    // 倍增：每小节 6 秒，1→2→4→8→16
    const segs = [[8, 1], [14, 2], [20, 4], [26, 8], [32, 16]];
    segs.forEach(function (s, k) {
      const end = k < 4 ? segs[k + 1][0] : 40, step = 6 / s[1];
      for (let t = s[0]; t < end - 1e-6; t += step) {
        const f = t === 8 ? m2f(69) : pent(R.int(11)), g = 0.2 * Math.pow(s[1], -0.35), p = R.range(-1, 1) * Math.min(0.9, (t - 8) / 32);
        L.at(t, function (A, w) { pluck(A, w, f, g, p, 'marimba'); });
      }
    });
    // 分化：3 对 4 对 5 的复节奏，三种音色，各自一条小循环
    const lines = [[0.8, 'marimba', -5, 0.045], [0.6, 'kalimba', 0, 0.035], [0.48, 'glass', 5, 0.022]];
    lines.forEach(function (ln, k) {
      const pat = []; const n = 4 + R.int(3);
      for (let j = 0; j < n; j++) pat.push(ln[2] + R.int(6));
      let j = 0;
      for (let t = 40; t < 78 - 1e-6; t += ln[0], j++) {
        const f = pent(pat[j % n]), b = t >= 62 ? breath(t) : 1, p = (k - 1) * 0.6;
        L.at(t, function (A, w) { pluck(A, w, f, ln[3] * b, p, ln[1]); });
      }
    });
    // 全片第一次和声进行：D – Bm – G – A
    const chords = [[50, 0], [47, 1], [43, 0], [45, 0]];
    for (let c = 0; c < 4; c++) {
      const t = 40 + c * 5.5, r = m2f(chords[c][0]), third = chords[c][1] ? 1.2 : 1.25;
      L.at(t, function (A, w, off) { pad(A, w, off, 7, [r, r * third, r * 1.5, r * 2], 0.03, { a: 2, r: 2.5, lp: { f0: 1800 }, spread: 0.8 }); }, 7);
    }
    for (let t = 62; t < 78; t += 5.88) {
      L.at(t, function (A, w) { pad(A, w, 0, 5.88, [D3, D3 * 1.5, D4 * 1.125, D4 * 1.25], 0.035, { shape: hann(0, 5.88), spread: 0.8, lp: { f0: 2000 } }); });
    }
    return L;
  }, tail: { start: 78.4, period: 5.88, fn: function (A, w) {
    pad(A, w, 0, 5.88, [D3, D3 * 1.5, D4 * 1.125, D4 * 1.25], 0.035, { shape: hann(0, 5.88), spread: 0.8, lp: { f0: 2000 } });
    for (let i = 0; i < 6; i++) { const u = (i + 0.5) / 6; pluck(A, w + u * 5.88, pent(A.R.int(11)), 0.04 * (0.35 + 0.65 * 0.5 * (1 - Math.cos(2 * Math.PI * u))), A.R.range(-0.6, 0.6), A.R.pick(['marimba', 'kalimba', 'glass'])); }
  } } };

  ACTS.logos = { dur: 80, level: 1.0, build: function (R) {
    const L = list();
    for (let t = 0.5; t < 40; t += R.range(2.5, 4)) {
      const f = R.range(700, 1300), d = R.range(3, 5), p = R.range(-0.7, 0.7);
      L.at(t, function (A, w) { nvoice(A, { when: w, dur: d, g: 0.06, shape: hann(0, d), lp: { type: 'bandpass', f0: f, f1: f * 1.2, q: 3 }, pan: p, send: 0.5 }); });
    }
    for (let t = 0.3; t < 40; t += R.range(0.25, 0.9)) {
      const f = pent(10 + R.int(10)), p = R.range(-0.9, 0.9);
      L.at(t, function (A, w) { voice(A, { when: w, f: f, wave: 'sine', perc: true, a: 0.005, dur: 0.14, g: 0.014, pan: p, send: 0.6 }); });
    }
    [8, 14, 20, 26, 32].forEach(function (t, k) { L.at(t, function (A, w) { bowl(A, w, pent(k), 0.09); }); });
    L.at(39, function (A, w, off) { pad(A, w, off, 17, [D3, D3 * 1.5, D4], 0.03, { a: 3, r: 3, lp: { f0: 1500 }, spread: 0.6 }); }, 17);
    L.at(47.5, function (A, w, off) { pad(A, w, off, 8.5, [D3 * 5 / 3, D4 * 1.25], 0.02, { a: 2, r: 2.5, lp: { f0: 1500 }, spread: 0.6 }); }, 8.5);
    const ph1 = [[0, 0, 0.6], [0.6, 1, 0.6], [1.2, 2, 0.9], [2.1, 3, 0.6], [2.7, 4, 1.2], [3.9, 3, 0.6], [4.5, 2, 2.0]];
    const ph2 = [[0, 3, 0.6], [0.6, 4, 0.6], [1.2, 5, 1.0], [2.2, 6, 0.5], [2.7, 5, 0.5], [3.2, 4, 0.8], [4.0, 3, 2.5]];
    [[40, ph1], [48, ph2]].forEach(function (P) {
      L.at(P[0], function (A, w) { for (const n of P[1]) flute(A, w + n[0], pent(n[1]), n[2] + 0.08, 0.075); });
    });
    L.at(56, function (A, w) { flute(A, w, D5, 2.6, 0.08); bowl(A, w, D5, 0.05); });
    L.at(56, function (A, w, off) {
      pad(A, w, off, 14, [D2, D3, D3 * 1.5, D4, D4 * 1.25, D4 * 1.5, D5], [0.04, 0.035, 0.03, 0.025, 0.022, 0.018, 0.012], { a: 4, r: 8, lp: { f0: 2200 }, spread: 0.9, must: true });
    }, 14);
    return L;
  }, tail: { start: 64, period: 12, fn: function (A, w, k) {
    pad(A, w, 0, 16, k % 2 ? [D3 * 0.75, D3 * 1.125, D3 * 1.5] : [D3, D3 * 1.5, D4 * 1.125], 0.022, { a: 5, r: 6, lp: { f0: 1400 }, spread: 0.7 });
    for (let i = 0; i < 4; i++) voice(A, { when: w + A.R.range(0, 12), f: pent(10 + A.R.int(10)), wave: 'sine', perc: true, a: 0.005, dur: 0.14, g: 0.01, pan: A.R.range(-0.9, 0.9), send: 0.6 });
  } } };

  // 没有专属配乐的章（如 testcard）：一层安静的 D 音垫
  const IDLE = { dur: 0, level: 1.0, build: function () { return list(); }, tail: { start: 0, period: 12, fn: function (A, w) {
    pad(A, w, 0, 16, [D3, D3 * 1.5, D4 * 1.125], 0.022, { a: 4, r: 5, lp: { f0: 1400 }, spread: 0.6 });
  } } };

  // ── 幕实例与调度 ──
  function makeAct(M, id) {
    const ac = M.ac, def = ACTS[id] || IDLE;
    const A = { M: M, id: id, def: def, R: rngOf(M.seed, 'run:' + id), cursor: null, idx: 0, tailNext: def.tail.start, tailK: 0, wait: true, born: ac.currentTime };
    A.ev = def.build(rngOf(M.seed, 'score:' + id)).slice().sort(function (a, b) { return a.t - b.t; });
    A.dryIn = M.reg(ac.createGain()); A.wetIn = M.reg(ac.createGain());
    A.send = M.reg(ac.createGain()); A.fadeD = M.reg(ac.createGain()); A.fadeW = M.reg(ac.createGain());
    A.dryIn.gain.value = def.level; A.wetIn.gain.value = def.level;
    A.dryIn.connect(A.fadeD); A.fadeD.connect(M.duck);
    A.wetIn.connect(A.send); A.send.connect(A.fadeW); A.fadeW.connect(M.verb);
    A.nodes = [A.dryIn, A.wetIn, A.send, A.fadeD, A.fadeW];
    return A;
  }
  function fadeCurve(from, up) {
    const n = 64, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const u = i / (n - 1); c[i] = up ? Math.sin(u * Math.PI / 2) : from * Math.cos(u * Math.PI / 2); }
    return c;
  }
  function switchTo(M, id) {
    const ac = M.ac, now = ac.currentTime + 0.02;
    if (M.cur) {
      const old = M.cur;
      for (const p of [old.fadeD.gain, old.fadeW.gain]) {
        const v = p.value;
        p.cancelScheduledValues(0); p.setValueAtTime(v, now);
        p.setValueCurveAtTime(fadeCurve(v, false), now + 0.001, XFADE);
      }
      old.killAt = now + XFADE + 0.5;
      M.acts.push(old);
    }
    const A = makeAct(M, id);
    for (const p of [A.fadeD.gain, A.fadeW.gain]) { p.setValueAtTime(0, now); p.setValueCurveAtTime(fadeCurve(1, true), now + 0.001, XFADE); }
    M.cur = A;
    return A;
  }
  function realign(A, T0, w) {
    let i = 0;
    while (i < A.ev.length && A.ev[i].t <= T0) {
      const e = A.ev[i];
      if (T0 >= 0.3 && e.d && T0 < e.t + e.d) e.fn(A, w + 0.03, T0 - e.t);
      i++;
    }
    A.idx = T0 < 0.3 ? 0 : i;
    const tl = A.def.tail;
    A.tailK = T0 < 0.3 || T0 <= tl.start ? 0 : Math.ceil((T0 - tl.start) / tl.period);
    A.tailNext = tl.start + A.tailK * tl.period;
    // 落在驻留段中间：当前这一轮的尾声立刻续上（尾声音垫都是慢起音，不会突兀）
    if (T0 >= 0.3 && T0 > tl.start && A.tailK > 0) tl.fn(A, w + 0.03, A.tailK - 1);
    if (A.def.realign) A.def.realign(A, T0, w);
    A.cursor = T0 < 0.3 ? -0.001 : T0;
  }
  function step(A, chNow, look) {
    const ac = A.M.ac, acNow = ac.currentTime, to = chNow + look;
    while (A.idx < A.ev.length && A.ev[A.idx].t <= to) {
      const e = A.ev[A.idx++];
      if (e.t > A.cursor) e.fn(A, acNow + Math.max(0, e.t - chNow), 0);
    }
    const tl = A.def.tail;
    while (A.tailNext <= to) {
      if (A.tailNext > A.cursor) tl.fn(A, acNow + Math.max(0, A.tailNext - chNow), A.tailK);
      A.tailK++; A.tailNext = tl.start + A.tailK * tl.period;
    }
    A.cursor = to;
  }
  // 一次调度：chNow 为当前章内时间
  function tickAct(M, A, chNow, look) {
    const ac = M.ac;
    if (A.wait) {
      // 刚换幕：旧章的时间可能还在走，等新章从 0 开始（或 4 秒后放弃等待）
      if (chNow > 1 && ac.currentTime - A.born < 4) return;
      A.wait = false; realign(A, chNow, ac.currentTime);
    } else if (A.cursor === null || chNow < A.cursor - look - 0.25 || chNow > A.cursor + 1.0) {
      realign(A, chNow, ac.currentTime);  // seek：安静地重新对齐，不补响跳过的事件
    }
    step(A, chNow, look);
  }
  function reap(M) {
    const now = M.ac.currentTime;
    M.acts = M.acts.filter(function (A) { if (now < A.killAt) return true; M.free(A.nodes); return false; });
  }

  // ── 实时 ──
  const st = { M: null, pending: null, time: 0, playing: false, stamp: 0, muted: false, timer: 0, ducked: false,
    lv: { level: 0, bass: 0, mid: 0, high: 0 } };
  function params() { return T.params || {}; }
  function rtTick() {
    const M = st.M;
    if (!M) return;
    reap(M);
    const A = M.cur;
    if (!A) return;
    if (M.ac.state !== 'running') { A.wait = false; A.cursor = -1e9; return; }   // 未恢复：恢复后重新对齐，不积压
    const now = M.ac.currentTime;
    if (!st.playing !== st.ducked) {
      st.ducked = !st.playing;
      const p = M.duck.gain; p.cancelScheduledValues(now); p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(st.ducked ? 0.62 * 0.35 : 0.62, now + 0.6);
    }
    if (!st.playing) return;
    const ext = Math.min(0.25, (performance.now() - st.stamp) / 1000);
    const chNow = st.time + ext;
    if (A.cursor === -1e9) { A.cursor = chNow; realign(A, chNow, now); }
    tickAct(M, A, chNow, LOOK_RT);
  }

  T.audio = {
    get muted() { return st.muted; },
    begin: function () {
      if (params().audio === false) return;
      if (!st.M) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ac = new AC({ latencyHint: 'playback' });
        st.M = makeMixer(ac, (params().seed | 0) || 1, true);
        st.M.mute.gain.value = st.muted ? 0 : 1;
        st.timer = setInterval(rtTick, 50);
        if (st.pending) { switchTo(st.M, st.pending); st.pending = null; }
      }
      if (st.M.ac.state !== 'running') { const p = st.M.ac.resume(); if (p && p.catch) p.catch(function () { /* 等下一次手势 */ }); }
    },
    setChapter: function (id) {
      if (params().audio === false) return;
      if (!st.M) { st.pending = id; return; }
      if (st.M.cur && st.M.cur.id === id) return;
      switchTo(st.M, id);
    },
    sync: function (time, playing) {
      st.time = +time || 0; st.playing = !!playing; st.stamp = performance.now();
      rtTick();
    },
    cue: function (name) {
      const M = st.M;
      if (!M || !M.cur || name !== 'typed' || M.ac.state !== 'running') return;
      const A = M.cur, w = M.ac.currentTime + 0.05, deg = [5, 6, 7, 8, 9];
      for (let i = 4; i > 0; i--) { const j = A.R.int(i + 1), x = deg[i]; deg[i] = deg[j]; deg[j] = x; }
      deg.forEach(function (d, i) { bell(A, w + i * 0.17, pent(d), 0.035, { r: 2, i: 0.5, d: 0.6, dur: 2.5, pan: (i - 2) * 0.3, must: true }); });
    },
    levels: function () {
      const M = st.M, lv = st.lv;
      if (!M || !M.an) return lv;
      M.an.getFloatTimeDomainData(M.tbuf); M.an.getByteFrequencyData(M.fbuf);
      let s = 0; for (let i = 0; i < M.tbuf.length; i++) s += M.tbuf[i] * M.tbuf[i];
      const hz = M.ac.sampleRate / M.an.fftSize, band = function (a, b) {
        let x = 0, n = 0; for (let i = Math.max(1, Math.floor(a / hz)); i < Math.min(M.fbuf.length, Math.ceil(b / hz)); i++) { x += M.fbuf[i]; n++; }
        return n ? x / n / 255 : 0;
      };
      const raw = { level: clamp(Math.sqrt(s / M.tbuf.length) * 5, 0, 1), bass: band(20, 250), mid: band(250, 2000), high: band(2000, 12000) };
      for (const k in raw) lv[k] += (raw[k] - lv[k]) * (raw[k] > lv[k] ? 0.5 : 0.06);
      return { level: lv.level, bass: lv.bass, mid: lv.mid, high: lv.high };
    },
    setMuted: function (b) {
      st.muted = !!b;
      const M = st.M;
      if (!M) return;
      const p = M.mute.gain, now = M.ac.currentTime;
      p.cancelScheduledValues(now); p.setValueAtTime(p.value, now); p.linearRampToValueAtTime(st.muted ? 0 : 1, now + 0.3);
    },
    stats: function () { const M = st.M; return M ? { live: M.live, created: M.created, osc: M.osc, acts: M.acts.length,
      state: M.ac.state, chapter: M.cur && M.cur.id, cursor: M.cur && M.cur.cursor, time: st.time, playing: st.playing } : null; },

    // 离线渲染：与实时同一套建图与调度，用 suspend() 每 0.5 秒推进一次时间线。
    // id 可写成 'a>b'：先放 a 的最后 10 秒，在第 10 秒 setChapter(b)，用于检验换幕交叉淡化。
    renderOffline: function (id, seconds) {
      const sr = 22050, secs = Math.max(1, +seconds || 30);
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const oac = new OAC(2, Math.ceil(secs * sr), sr);
      const M = makeMixer(oac, (params().seed | 0) || 1, false);
      const parts = String(id).split('>'), CH = 0.5, look = CH + 0.25;
      const a = parts[0], b = parts[1], swAt = b ? 10 : Infinity;
      const t0 = b ? Math.max(0, ((ACTS[a] || IDLE).dur || 10) - 10) : 0;
      let A = switchTo(M, a), base = -t0;
      A.wait = false;
      const baseline = { live: M.live };
      function tick() {
        const rt = oac.currentTime;
        if (rt >= swAt - 1e-6 && A.id === a) { A = switchTo(M, b); base = swAt; }
        reap(M);
        tickAct(M, A, rt - base, look);
      }
      tick();
      for (let t = CH; t < secs; t += CH) oac.suspend(t).then(function () { tick(); oac.resume(); });
      return oac.startRendering().then(function (buf) {
        const L = buf.getChannelData(0), Rr = buf.getChannelData(1), n = L.length;
        const pcm = new Int16Array(n); let peak = 0, s = 0;
        for (let i = 0; i < n; i++) {
          const x = (L[i] + Rr[i]) * 0.5, ax = Math.abs(x);
          if (ax > peak) peak = ax; s += x * x;
          pcm[i] = Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
        }
        const bytes = new Uint8Array(pcm.buffer); let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return { sampleRate: sr, pcm16: btoa(bin), peak: peak, rms: Math.sqrt(s / n),
          nodes: { baseline: baseline.live, created: M.created, liveAtEnd: M.live, oscAtEnd: M.osc } };
      });
    },
  };
})();
