/* 太初 TAICHU — 引擎：启动、主循环、转场、输入、计时与动态分辨率（CONTRACT.md §4.6 §4.7 §4.9）。
   原则：章节代码出任何错都不能拖垮整部片子——每次调用章节都包在 try/catch 里，同一来源的错误只记一次。 */
(function () {
  'use strict';
  const T = window.TAICHU;
  const M = T.M;
  const P = T.params;
  const S = window.__taichu;

  const FADE_OUT = 1.2, FADE_IN = 1.8, SEEK_DT = 1 / 60, SEEK_MAX = 120;

  const E = T.engine = {
    film: [], current: null, begun: false, auto: P.auto, paused: false,
  };

  let G = null, gl = null, canvas = null;
  let recs = [], byId = {}, filmRecs = [];
  let cur = null;
  let booted = false, bootIdx = 0, fatal = false;
  let time = 0, frame = 0, wall0 = performance.now() / 1000, wall = 0, lastNow = 0, frameDt = 1 / 60;
  let scene = null, bw = 1, bh = 1, scale = 1, sizeKey = '', sizeDirty = true;
  let fade = 0, fadeColor = [0, 0, 0], trans = null;
  let seek = null, readyLeft = -1;
  let frozen = false;
  let lastCaption = null, sayText = null, sayUntil = -1, lastTick = -1;
  let quality = 2, reducedMotion = false;
  const reported = new Set();
  const audioLevels = { level: 0, bass: 0, mid: 0, high: 0 };

  function reportOnce(key, where, err) {
    if (reported.has(key)) return;
    reported.add(key);
    T.reportError(where, err);
  }
  function call(rec, fn, args) {
    const f = rec.def[fn];
    if (typeof f !== 'function') return undefined;
    try {
      return f.apply(rec.def, args);
    } catch (e) {
      reportOnce(rec.def.id + ':' + fn, rec.def.id + '.' + fn, e);
      return undefined;
    } finally {
      if (gl && fn !== 'onInput' && fn !== 'live') G.resetState();
    }
  }
  function glCheck(where) {
    if (!P.glerr || !gl) return;
    const e = gl.getError();
    if (e) reportOnce('glerr:' + where + ':' + e, 'gl', new Error('GL 错误 0x' + e.toString(16) + '（发生在 ' + where + '）'));
  }
  function audio() { return P.audio && T.audio ? T.audio : null; }
  function audioCall(fn, args) {
    const a = audio();
    if (!a || typeof a[fn] !== 'function') return undefined;
    try { return a[fn].apply(a, args || []); } catch (e) { reportOnce('audio:' + fn, 'audio.' + fn, e); return undefined; }
  }

  // ── 输入 ──
  const pressedSet = new Set();
  const input = {
    x: 0.5, y: 0.5, nx: 0, ny: 0, down: false, dx: 0, dy: 0, wheel: 0, pinch: 1,
    clicked: false, clickX: 0.5, clickY: 0.5, keys: new Set(), idle: 0,
    pressed: function (code) { return pressedSet.has(code); },
  };
  let lastInput = 0;
  const ptrs = new Map();
  let primary = null, downX = 0, downY = 0, maxMove = 0, clickOk = false, pinchDist = 0;

  function touch() { lastInput = wall; }
  function setXY(cx, cy) {
    const r = canvas.getBoundingClientRect();
    input.x = M.saturate((cx - r.left) / Math.max(1, r.width));
    input.y = M.saturate((cy - r.top) / Math.max(1, r.height));
    input.nx = input.x * 2 - 1; input.ny = 1 - input.y * 2;
  }
  function twoDist() {
    const a = Array.from(ptrs.values());
    return a.length >= 2 ? Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) : 0;
  }
  function isEditable(t) {
    if (!t) return false;
    const n = (t.tagName || '').toLowerCase();
    return n === 'input' || n === 'textarea' || n === 'select' || !!t.isContentEditable;
  }
  function bindInput() {
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', function (e) {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件可能没有可捕获的指针 */ }
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      touch();
      setXY(e.clientX, e.clientY);
      if (ptrs.size === 1) {
        primary = e.pointerId; downX = e.clientX; downY = e.clientY; maxMove = 0;
        clickOk = e.button === 0 || e.pointerType !== 'mouse';
        input.down = true;
      } else {
        clickOk = false;
        pinchDist = twoDist();
      }
    });
    canvas.addEventListener('pointermove', function (e) {
      const p = ptrs.get(e.pointerId);
      if (!p) { if (e.pointerType === 'mouse') setXY(e.clientX, e.clientY); return; }
      const ddx = e.clientX - p.x, ddy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      touch();
      if (ptrs.size === 1 && e.pointerId === primary) {
        input.dx += ddx; input.dy += ddy;
        maxMove = Math.max(maxMove, Math.hypot(e.clientX - downX, e.clientY - downY));
        setXY(e.clientX, e.clientY);
      } else if (ptrs.size >= 2) {
        const d = twoDist();
        if (pinchDist > 0 && d > 0) input.pinch *= d / pinchDist;
        pinchDist = d;
      }
    });
    function up(e) {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      touch();
      if (ptrs.size === 0) {
        input.down = false;
        if (e.type === 'pointerup' && clickOk && e.pointerId === primary && maxMove < 5) {
          setXY(e.clientX, e.clientY);
          input.clicked = true; input.clickX = input.x; input.clickY = input.y;
        }
        primary = null;
      } else {
        // 双指变单指：剩下的那根接管拖动，但不产生跳变，也不算点击
        primary = ptrs.keys().next().value; clickOk = false; pinchDist = 0;
      }
    }
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      let d = e.deltaY;
      if (e.deltaMode === 1) d *= 16; else if (e.deltaMode === 2) d *= (canvas.clientHeight || 800);
      // 触控板捏合在浏览器里表现为 ctrl+wheel
      if (e.ctrlKey) input.pinch *= Math.exp(-d * 0.01); else input.wheel += d;
      setXY(e.clientX, e.clientY);
      touch();
    }, { passive: false });
    window.addEventListener('keydown', function (e) {
      if (isEditable(e.target) || e.isComposing) return;
      input.keys.add(e.code);
      if (!e.repeat) pressedSet.add(e.code);
      touch();
    });
    window.addEventListener('keyup', function (e) { input.keys.delete(e.code); });
    window.addEventListener('blur', function () { input.keys.clear(); });
  }
  function clearFrameInput() {
    input.dx = 0; input.dy = 0; input.wheel = 0; input.pinch = 1; input.clicked = false;
    pressedSet.clear();
  }

  // ── 尺寸 ──
  function cssSize() {
    return [Math.max(1, canvas.clientWidth || window.innerWidth || 1), Math.max(1, canvas.clientHeight || window.innerHeight || 1)];
  }
  function capScale() {
    const rs = cur && cur.def.renderScale > 0 ? Math.min(1, cur.def.renderScale) : 1;
    return rs;
  }
  let cssCache = [1, 1], lastDpr = 0;
  function applySize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (sizeDirty || dpr !== lastDpr) { cssCache = cssSize(); sizeDirty = false; lastDpr = dpr; }
    const css = cssCache;
    const w = Math.max(1, Math.round(css[0] * dpr)), h = Math.max(1, Math.round(css[1] * dpr));
    if (w !== bw || h !== bh || canvas.width !== w || canvas.height !== h) {
      bw = w; bh = h;
      canvas.width = w; canvas.height = h;
    }
    const sw = Math.max(16, Math.round(bw * scale)), sh = Math.max(16, Math.round(bh * scale));
    const key = sw + 'x' + sh;
    if (key === sizeKey && scene) return;
    sizeKey = key;
    if (!scene) scene = G.target({ w: sw, h: sh, format: 'rgba16f', depth: true });
    else scene.resize(sw, sh);
    T.Post.resize(sw, sh);
    if (cur && cur.inited && !cur.broken && cur.sizeKey !== sizeKey) {
      syncCtx(cur);
      cur.sizeKey = sizeKey;
      call(cur, 'resize', [cur.ctx, cur.state]);
    }
  }

  // ── 章节记录与 ctx ──
  function makeCtx(def) {
    const ctx = {
      gl: gl, G: G, id: def.id, time: 0, dt: 0, frameDt: 0, wall: 0, frame: 0, duration: def.duration, progress: 0,
      seeking: false, width: 1, height: 1, aspect: 1, px: 1, scene: null,
      quality: quality, seed: P.seed, reducedMotion: reducedMotion, rng: null, input: input, audio: audioLevels,
    };
    ctx.bindScene = function () { G.bind(scene); };
    ctx.cue = function (name, data) {
      T.bus.emit('cue', { chapter: def.id, name: name, data: data });
      if (!ctx.seeking) audioCall('cue', [name, data]);
    };
    ctx.say = function (text, seconds) {
      if (!cur || cur.def !== def) return;
      sayText = text == null ? null : String(text);
      sayUntil = wall + (seconds > 0 ? seconds : 2.5);
    };
    ctx.rng = M.mulberry32(seedFor(def.id));
    return ctx;
  }
  function seedFor(id) { return (Math.imul(P.seed | 0, 0x9E3779B1) ^ M.hashStr(id)) >>> 0; }
  function syncCtx(rec) {
    const c = rec.ctx;
    c.time = time; c.frameDt = frameDt; c.wall = wall; c.frame = frame;
    c.progress = M.saturate(time / (rec.def.duration || 1));
    c.width = scene.w; c.height = scene.h; c.aspect = scene.w / scene.h; c.px = scene.h / 1080; c.scene = scene;
    c.quality = quality; c.reducedMotion = reducedMotion;
  }

  function enterRec(rec) {
    time = 0;
    rec.ctx.rng = M.mulberry32(seedFor(rec.def.id));
    rec.ctx.dt = 0; rec.ctx.seeking = false;
    syncCtx(rec);
    if (rec.sizeKey !== sizeKey) { rec.sizeKey = sizeKey; call(rec, 'resize', [rec.ctx, rec.state]); }
    call(rec, 'enter', [rec.ctx, rec.state]);
  }
  function switchTo(rec) {
    if (cur) {
      call(cur, 'leave', [cur.ctx, cur.state]);
      if (cur.def.input) T.bus.emit('input:release');
    }
    cur = rec;
    scale = capScale();
    sayText = null; sayUntil = -1;
    if (!rec) { E.current = null; return; }
    sizeDirty = true;
    applySize();
    warmup();
    enterRec(rec);
    E.current = { def: rec.def, state: rec.state, index: filmRecs.indexOf(rec) };
    T.bus.emit('chapter', { id: rec.def.id, index: E.current.index, def: rec.def });
    if (rec.def.input) T.bus.emit('input:request', { placeholder: rec.def.input.placeholder || '', maxLength: rec.def.input.maxLength || 32 });
  }
  function resolveRec(x) {
    if (typeof x === 'number') return filmRecs[x] || null;
    const r = byId[x];
    return r && r.inited && !r.broken ? r : null;
  }

  // ── 时间推进 ──
  function step(rec, dt, seeking) {
    time += dt;
    const c = rec.ctx;
    syncCtx(rec);
    c.dt = dt; c.seeking = seeking;
    call(rec, 'update', [c, rec.state]);
    c.seeking = false;
  }

  // ── GPU 计时（异步回读；两次相邻查询分别覆盖"章节"与"后期"，合计即整帧） ──
  const pendingQ = [];
  let gpuEma = null, gpuPostEma = null;
  const perf = { frames: [], gpu: [], gpuPost: [] };
  let qActive = false;
  function qBegin() {
    if (!G.timerExt || qActive) return null;
    const q = gl.createQuery();
    gl.beginQuery(G.timerExt.TIME_ELAPSED_EXT, q);
    qActive = true;
    return q;
  }
  function qEnd() { if (qActive) { gl.endQuery(G.timerExt.TIME_ELAPSED_EXT); qActive = false; } }
  function pollQueries() {
    if (!G.timerExt) return;
    while (pendingQ.length) {
      const p = pendingQ[0];
      if (!gl.getQueryParameter(p[1], gl.QUERY_RESULT_AVAILABLE)) break;
      pendingQ.shift();
      const disjoint = gl.getParameter(G.timerExt.GPU_DISJOINT_EXT);
      if (!disjoint) {
        const a = gl.getQueryParameter(p[0], gl.QUERY_RESULT) / 1e6, b = gl.getQueryParameter(p[1], gl.QUERY_RESULT) / 1e6;
        const ms = a + b;
        gpuEma = gpuEma === null ? ms : gpuEma * 0.9 + ms * 0.1;
        // 动态分辨率用的平均：预热期（进章 / 快进后管线首次编译）不计，单帧尖峰钳到均值的 2 倍
        if (wall >= dyn.warm) dyn.gpu = dyn.gpu === null ? ms : dyn.gpu * 0.9 + Math.min(ms, Math.max(2 * dyn.gpu, 4)) * 0.1;
        gpuPostEma = gpuPostEma === null ? b : gpuPostEma * 0.9 + b * 0.1;
        if (perf.gpu.length < 20000) { perf.gpu.push(ms); perf.gpuPost.push(b); }
      }
      gl.deleteQuery(p[0]); gl.deleteQuery(p[1]);
    }
  }

  // ── 动态分辨率：有 GPU 计时就用它，否则用帧间隔；降得快、升得慢，升了马上又降则加倍等待（防抖） ──
  const dyn = { cool: 0, good: 0, backoff: 1, lastUp: -1e9, frameEma: 16.7, gpu: null, warm: 0 };
  function warmup() { dyn.warm = wall + 1.0; dyn.gpu = null; dyn.good = 0; }
  function updateDyn() {
    const cap = capScale();
    if (P.scale > 0) { scale = Math.min(2, Math.max(0.1, P.scale)); return; }
    if (frozen || !cur || seek || !booted) { scale = cap; return; }
    const lo = 0.4 * cap;
    dyn.cool -= frameDt;
    if (wall < dyn.warm) return;
    const useGpu = !!G.timerExt;
    if (useGpu && dyn.gpu === null) return;
    const load = useGpu ? dyn.gpu : dyn.frameEma;
    const high = useGpu ? 13.5 : 21, low = useGpu ? 9 : 17.6;
    const q = function (s) { return Math.round(s * 20) / 20; };
    if (load > high && dyn.cool <= 0 && scale > lo + 1e-6) {
      if (wall - dyn.lastUp < 3) dyn.backoff = Math.min(32, dyn.backoff * 2);
      scale = Math.max(lo, Math.min(scale - 0.05, q(scale * Math.sqrt(high * 0.85 / load))));
      dyn.cool = 0.5; dyn.good = 0;
    } else if (load < low && scale < cap - 1e-6) {
      dyn.good += frameDt;
      if (dyn.good > 2 * dyn.backoff && dyn.cool <= 0) {
        scale = Math.min(cap, q(scale + 0.05)); dyn.cool = 1; dyn.good = 0; dyn.lastUp = wall;
      }
    } else {
      dyn.good = 0;
    }
    if (scale > cap) scale = cap;
    if (scale < lo) scale = lo;
  }

  // ── 渲染 ──
  function postParams(rec) {
    let user = null;
    if (rec && rec.def.post) {
      if (typeof rec.def.post === 'function') {
        try { user = rec.def.post(rec.ctx, rec.state); } catch (e) { reportOnce(rec.def.id + ':post', rec.def.id + '.post', e); }
      } else user = rec.def.post;
    }
    const p = T.Post.merge(user);
    p.fade = fade; p.fadeColor = fadeColor;
    return p;
  }
  function renderFrame() {
    G.bind(scene);
    G.resetState();
    G.clear(0, 0, 0, 1);
    if (cur && !cur.broken) {
      syncCtx(cur);
      cur.ctx.dt = 0;
      call(cur, 'render', [cur.ctx, cur.state]);
      glCheck((cur.def.id) + '.render');
    }
    G.resetState();
    // 深度只在场景通道内有用：声明作废，省掉把它写回显存（3024×1964 时 24 MB / 帧）
    G.bind(scene);
    gl.invalidateFramebuffer(gl.FRAMEBUFFER, INV_DEPTH || (INV_DEPTH = [gl.DEPTH_ATTACHMENT]));
    const q2 = timing ? (qEnd(), qBegin()) : null;
    T.Post.render(scene, postParams(cur), { frame: frame, wall: wall, canvasW: bw, canvasH: bh });
    G.resetState();
    if (timing) { qEnd(); pendingQ.push([timing, q2]); }
    glCheck('post');
    frame++;
  }
  let timing = null, INV_DEPTH = null;

  // ── 字幕、tick、音频 ──
  function captions() {
    let text = null;
    if (sayUntil > wall && sayText) text = sayText;
    else if (cur && E.begun && !(trans && trans.phase === 'out') && Array.isArray(cur.def.captions)) {
      for (const c of cur.def.captions) if (time >= c.t && time < c.t + c.d) text = c.text;
    }
    if (text !== lastCaption) { lastCaption = text; T.bus.emit('caption', { text: text }); }
  }
  function tick() {
    if (wall - lastTick < 0.1) return;
    lastTick = wall;
    if (!cur) return;
    T.bus.emit('tick', {
      id: cur.def.id, index: filmRecs.indexOf(cur), time: time, duration: cur.def.duration,
      progress: M.saturate(time / cur.def.duration), auto: E.auto, paused: E.paused,
    });
  }

  // ── 转场 ──
  function colorOf(rec) { return rec && rec.def.fadeIn === 'white' ? [1, 1, 1] : [0, 0, 0]; }
  function startTransition(rec) {
    if (!cur) { switchTo(rec); fade = 1; fadeColor = colorOf(rec); trans = { phase: 'in', to: rec }; return; }
    if (trans && trans.phase === 'out') { trans.to = rec; fadeColor = colorOf(rec); audioCall('setChapter', [rec.def.id]); return; }
    trans = { phase: 'out', to: rec };
    fadeColor = colorOf(rec);
    T.bus.emit('transition', { from: cur.def.id, to: rec.def.id, phase: 'out' });
    audioCall('setChapter', [rec.def.id]);
  }
  function advanceTransition() {
    if (!trans) return;
    if (trans.phase === 'out') {
      fade = Math.min(1, fade + frameDt / FADE_OUT);
      if (fade >= 1) {
        const from = cur ? cur.def.id : null;
        switchTo(trans.to);
        trans.phase = 'in';
        T.bus.emit('transition', { from: from, to: trans.to.def.id, phase: 'in' });
      }
    } else {
      fade = Math.max(0, fade - frameDt / FADE_IN);
      if (fade <= 0) trans = null;
    }
  }
  function autoAdvance() {
    if (!E.auto || !E.begun || E.paused || trans || !cur || frozen) return;
    const i = filmRecs.indexOf(cur);
    if (i < 0 || i >= filmRecs.length - 1) return;
    if (time >= cur.def.duration && input.idle >= 5) E.next();
  }

  // ── 启动 ──
  function bootStep() {
    if (bootIdx < recs.length) {
      const rec = recs[bootIdx++];
      try {
        syncCtx(rec);
        const st = rec.def.init(rec.ctx);
        rec.state = st === undefined ? {} : st;
        rec.inited = true;
        rec.sizeKey = sizeKey;
      } catch (e) {
        rec.broken = true;
        T.reportError(rec.def.id + '.init', e);
      }
      G.resetState();
      T.bus.emit('boot:progress', { done: bootIdx, total: recs.length, id: rec.def.id });
      return;
    }
    finishBoot();
  }
  function finishBoot() {
    booted = true;
    filmRecs = recs.filter(function (r) { return (!r.def.dev || P.devfilm) && !r.broken; });   // devfilm：把开发章也排进正片（界面 / 配乐的隔离测试）
    E.film = filmRecs.map(function (r) {
      const d = r.def;
      return { id: d.id, order: d.order, title: d.title, latin: d.latin, epoch: d.epoch, lookback: d.lookback, duration: d.duration };
    });
    S.booted = true;
    T.bus.emit('ready', { film: E.film });
    if (P.ch) {
      const r = byId[P.ch];
      if (!r) {
        T.reportError('engine', new Error('未知章节「' + P.ch + '」。已加载的章节：' + (recs.map(function (x) { return x.def.id; }).join('、') || '（无）') +
          '。章节文件名须为 src/chapters/<序号>-<id>.js'));
        S.ready = true;
        return;
      }
      if (r.broken) {
        T.reportError('engine', new Error('章节「' + P.ch + '」初始化失败，无法进入（原因见上一条错误）'));
        S.ready = true;
        return;
      }
      E.begun = true;
      frozen = P.freeze;
      switchTo(r);
      fade = 0;
      seekTo(Math.max(0, P.t)).then(function () { S.ready = true; });
      return;
    }
    if (filmRecs.length) {
      switchTo(filmRecs[0]);
      fade = 1; fadeColor = [0, 0, 0]; trans = { phase: 'in', to: filmRecs[0] };
    }
    readyLeft = 3;
    const hasUI = P.ui && document.getElementById('taichu-ui');
    if (!hasUI) E.begin();
  }

  function seekTo(t) {
    return new Promise(function (res) {
      if (!cur) { res(); return; }
      if (seek) { seek.target = t; seek.phase = 'run'; seek.res.push(res); }
      else seek = { target: t, phase: 'run', left: 0, res: [res] };
      if (t < time - 1e-9) enterRec(cur);
    });
  }

  // ── 主循环 ──
  function loop(nowMs) {
    if (fatal) return;
    requestAnimationFrame(loop);
    const now = nowMs / 1000;
    const raw = lastNow ? now - lastNow : 1 / 60;
    lastNow = now;
    frameDt = Math.min(Math.max(raw, 0), 0.1);
    wall = performance.now() / 1000 - wall0;
    input.idle = wall - lastInput;
    if (raw < 0.25) {
      dyn.frameEma = dyn.frameEma * 0.92 + raw * 1000 * 0.08;
      S.frameMs = Math.round(dyn.frameEma * 100) / 100;
      if (perf.frames.length < 20000) perf.frames.push(raw * 1000);
    }
    try {
      pollQueries();
      applySize();
      if (!booted) {
        G.bind(null); G.clear(0, 0, 0, 1);
        bootStep();
      } else if (seek && seek.phase === 'run') {
        let n = 0;
        while (cur && time < seek.target - 1e-6 && n < SEEK_MAX) { step(cur, SEEK_DT, true); n++; }
        glCheck('seek');
        if (!cur || time >= seek.target - 1e-6) { seek.phase = 'render'; seek.left = 3; }
      } else {
        const running = cur && E.begun && !E.paused && !frozen && !seek && !cur.broken;
        timing = G.timerExt && pendingQ.length < 6 ? qBegin() : null;
        if (running) { step(cur, Math.min(frameDt, 1 / 30), false); glCheck(cur.def.id + '.update'); }
        advanceTransition();
        autoAdvance();
        renderFrame();
        timing = null;
        captions();
        tick();
        audioCall('sync', [time, !!(running)]);
        const lv = audioCall('levels');
        if (lv) { audioLevels.level = +lv.level || 0; audioLevels.bass = +lv.bass || 0; audioLevels.mid = +lv.mid || 0; audioLevels.high = +lv.high || 0; }
        if (seek && seek.phase === 'render' && --seek.left <= 0) {
          const rs = seek.res; seek = null;
          warmup();
          for (const r of rs) r();
        }
        if (readyLeft > 0 && --readyLeft === 0) S.ready = true;
      }
      updateDyn();
    } catch (e) {
      reportOnce('engine:loop:' + String(e && e.message), 'engine', e);
      try { qEnd(); timing = null; G.resetState(); } catch (e2) { /* 已经在报错路径上 */ }
    }
    clearFrameInput();
    S.chapter = cur ? cur.def.id : null;
    S.t = Math.round(time * 1000) / 1000;
    S.frames = frame;
    S.gpuMs = gpuEma === null ? null : Math.round(gpuEma * 1000) / 1000;
    S.scale = scale; S.width = bw; S.height = bh; S.quality = quality;
    if (frame % 10 === 0) S.perf = perfSummary();
  }

  function perfSummary() {
    const f = perf.frames.slice().sort(function (a, b) { return a - b; });
    const n = f.length;
    const avg = function (a) { let s = 0; for (const x of a) s += x; return a.length ? s / a.length : null; };
    const r2 = function (x) { return x === null ? null : Math.round(x * 100) / 100; };
    return {
      samples: n, avgMs: r2(avg(f)), p95Ms: n ? r2(f[Math.min(n - 1, Math.floor(n * 0.95))]) : null, maxMs: n ? r2(f[n - 1]) : null,
      gpuAvgMs: perf.gpu.length ? r2(avg(perf.gpu)) : null, gpuPostAvgMs: perf.gpuPost.length ? r2(avg(perf.gpuPost)) : null,
    };
  }

  function detectQuality() {
    if (P.quality >= 0) return Math.max(0, Math.min(2, P.quality));
    const r = String(G.caps.renderer || '').toLowerCase();
    if (/swiftshader|llvmpipe|software|basic render/.test(r)) return 0;
    if (navigator.deviceMemory && navigator.deviceMemory <= 2) return 0;
    const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (coarse && Math.min(screen.width, screen.height) < 820);
    return mobile ? 1 : 2;
  }

  function die(message) {
    fatal = true;
    T.bus.emit('fatal', { message: message });
    T.reportError('engine', new Error(message));
    S.booted = true; S.ready = true;
  }

  // ── 公开接口 ──
  E.start = function () {
    canvas = document.getElementById('taichu-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'taichu-canvas';
      document.body.insertBefore(canvas, document.body.firstChild);
    }
    if (!document.getElementById('taichu-ui')) {
      // 没有界面层（例如构建产物里没有 shell）：自己把画布铺满
      document.documentElement.style.height = '100%';
      document.body.style.height = '100%';
      document.body.style.margin = '0';
      document.body.style.overflow = 'hidden';
      document.body.style.background = '#000';
      canvas.style.cssText += ';position:fixed;left:0;top:0;width:100%;height:100%;display:block';
    }
    G = T.G;
    gl = G.init(canvas);
    if (!gl) { die('此浏览器不支持 WebGL2，无法播放《太初》。'); return; }
    if (!G.caps.colorBufferFloat) { die('此设备不支持浮点渲染目标（EXT_color_buffer_float），无法播放《太初》。'); return; }
    canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); die('WebGL 上下文丢失（显卡被重置或内存不足）。请刷新页面。'); });
    try { T.Post.init(); } catch (e) { die('后期链路初始化失败：' + (e && e.message)); return; }
    reducedMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    quality = detectQuality();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(function () { sizeDirty = true; }).observe(canvas);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) lastNow = 0; });
    bindInput();
    scale = 1;
    applySize();
    recs = T.chapters.slice().sort(function (a, b) { return a.order - b.order; }).map(function (def) {
      return { def: def, ctx: makeCtx(def), state: null, inited: false, broken: false, sizeKey: '' };
    });
    byId = {};
    for (const r of recs) byId[r.def.id] = r;
    requestAnimationFrame(loop);
  };

  E.begin = function () {
    if (E.begun) return;
    E.begun = true;
    audioCall('begin');
    T.bus.emit('begin');
    const h = T.hashChapter();
    const start = (h && filmRecs.find(function (r) { return r.def.id === h; })) || filmRecs[0] || null;
    if (!start) return;
    if (start !== cur) startTransition(start);
    else { time = 0; audioCall('setChapter', [start.def.id]); }
  };
  E.goTo = function (x) {
    const r = resolveRec(x);
    if (!r) { reportOnce('goTo:' + x, 'engine.goTo', new Error('无法进入章节「' + x + '」（不存在或已损坏）')); return; }
    if (!E.begun) { switchTo(r); return; }
    startTransition(r);
  };
  E.next = function () {
    const i = filmRecs.indexOf(trans ? trans.to : cur);
    if (i >= 0 && i < filmRecs.length - 1) E.goTo(i + 1);
  };
  E.prev = function () {
    const i = filmRecs.indexOf(trans ? trans.to : cur);
    if (i > 0) E.goTo(i - 1);
  };
  E.setAuto = function (b) { E.auto = !!b; T.bus.emit('state', { auto: E.auto, paused: E.paused }); };
  E.setPaused = function (b) { E.paused = !!b; T.bus.emit('state', { auto: E.auto, paused: E.paused }); };
  // 截图工具的 run:秒 动作用：冻结模式下临时让章内时间真实推进（看生长、看写字）
  E.setFrozen = function (b) { const was = frozen; frozen = !!b; return was; };
  E.live = function () {
    if (!cur || !cur.def.anatomy || typeof cur.def.anatomy.live !== 'function') return [];
    try {
      syncCtx(cur);
      const r = cur.def.anatomy.live(cur.ctx, cur.state);
      return Array.isArray(r) ? r : [];
    } catch (e) { reportOnce(cur.def.id + ':live', cur.def.id + '.anatomy.live', e); return []; }
  };
  E.submitInput = function (text) {
    if (!cur || typeof cur.def.onInput !== 'function') return;
    syncCtx(cur);
    call(cur, 'onInput', [cur.ctx, cur.state, String(text)]);
  };
  E.runSelfTest = function (id) {
    const rec = id ? byId[id] : cur;
    const cid = id || (cur && cur.def.id) || '?';
    const fail = function (name, msg) { return [{ chapter: cid, name: name, expected: '无错误', measured: msg, pass: false }]; };
    if (!rec) return Promise.resolve(fail('章节', '不存在'));
    if (!rec.inited || rec.broken) return Promise.resolve(fail('init', '章节初始化失败'));
    if (typeof rec.def.selfTest !== 'function') return Promise.resolve([]);
    const t0 = performance.now();
    let out;
    try {
      syncCtx(rec);
      out = rec.def.selfTest(rec.ctx, rec.state);
    } catch (e) {
      reportOnce(rec.def.id + ':selfTest', rec.def.id + '.selfTest', e);
      G.resetState();
      return Promise.resolve(fail('selfTest', String(e && e.message)));
    }
    G.resetState();
    return Promise.resolve(out).then(function (arr) {
      G.resetState();
      const ms = performance.now() - t0;
      if (ms > 300) console.warn('[' + rec.def.id + '.selfTest] 耗时 ' + ms.toFixed(0) + ' ms，超过 300 ms 预算');
      if (!Array.isArray(arr)) return fail('selfTest', '返回值不是数组');
      return arr.map(function (r) {
        return { chapter: rec.def.id, name: String(r.name), expected: r.expected, measured: r.measured, pass: !!r.pass };
      });
    }, function (e) {
      reportOnce(rec.def.id + ':selfTest', rec.def.id + '.selfTest', e);
      G.resetState();
      return fail('selfTest', String(e && e.message));
    });
  };
  E.devSeek = function (t) { return seekTo(Math.max(0, +t || 0)); };
  E.devSelfTest = function (id) { return E.runSelfTest(id); };
  E.devResetPerf = function () { perf.frames = []; perf.gpu = []; perf.gpuPost = []; S.perf = perfSummary(); };
  E.time = function () { return time; };
})();
