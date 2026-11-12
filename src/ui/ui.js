/* 太初 TAICHU — 界面层（CONTRACT.md §5，briefs/ui.md）。
   只通过 T.engine 的方法与事件总线和引擎交互；幕名、epoch、lookback、解剖内容一律取自章节定义，不写死。 */
(function () {
  'use strict';
  const T = window.TAICHU;
  const E = T.engine;
  const P = T.params || {};

  const ACT_COLOR = {
    singularity: '#ffb46b', galaxy: '#bfd0ff', horizon: '#ff9a4d',
    azure: '#6fa8ff', life: '#5fe3c0', logos: '#f3e2bd',
  };
  const HAN = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const IDLE_MS = 3500, CARD_HOLD_MS = 4500, HINT_MS = 6000, LIVE_MS = 250;
  const MUTE_KEY = 'taichu.muted';

  const $ = function (id) { return document.getElementById(id); };
  const root = $('taichu-ui');
  if (!root) return;
  if (P.ui === false) { root.hidden = true; return; }

  const el = {
    start: $('t-start'), begin: $('t-begin'),
    card: $('t-card'), cardNum: $('t-card-num'), cardTitle: $('t-card-title'), cardLatin: $('t-card-latin'), cardEpoch: $('t-card-epoch'),
    caption: $('t-caption'), hint: $('t-hint'),
    inputWrap: $('t-input-wrap'), input: $('t-input'),
    track: $('t-track'), progress: $('t-progress'),
    markAct: $('t-mark-act'), paused: $('t-paused'),
    anatomy: $('t-anatomy'), anTitle: $('t-an-title'), anLatin: $('t-an-latin'), anLead: $('t-an-lead'),
    anEqs: $('t-an-eqs'), anEqsSec: $('t-an-eqs-sec'), anNotes: $('t-an-notes'), anNotesSec: $('t-an-notes-sec'),
    anLive: $('t-an-live'), anLiveSec: $('t-an-live-sec'), anTest: $('t-an-test'),
    about: $('t-about'), build: $('t-build'),
    fatal: $('t-fatal'), fatalMsg: $('t-fatal-msg'),
  };
  const btn = {};
  root.querySelectorAll('#t-controls button').forEach(function (b) { btn[b.dataset.act] = b; });

  const ui = {
    film: [], ticks: [], chapterId: null, index: -1, def: null,
    begun: false, fatal: false, inputOn: false,
    capText: null, capTimer: 0, cardTimers: [], hintTimer: 0, idleTimer: 0,
    liveTimer: 0, tests: {}, panelOpener: null, lastTick: null,
  };

  function han(n) { return n <= 10 ? HAN[n] : (n < 20 ? '十' + HAN[n - 10] : String(n)); }
  function show(node, on) { node.classList.toggle('on', !!on); }
  function setPressed(b, on) { if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  function filmIndexOf(id) { for (let i = 0; i < ui.film.length; i++) if (ui.film[i].id === id) return i; return -1; }
  function make(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  // 竖排里的阿拉伯数字（"138"、"46"）横置会躺倒：拆成纵中横排的小块
  function verticalText(node, text) {
    node.textContent = '';
    String(text || '').split(/(\d+(?:\.\d+)?)/).forEach(function (part, i) {
      if (!part) return;
      if (i % 2) node.appendChild(make('span', part.length <= 3 ? 'num' : '', part));
      else node.appendChild(document.createTextNode(part));
    });
  }

  // ── 静音偏好（localStorage 可能抛错或不存在） ──
  let muted = false;
  try { muted = window.localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { muted = false; }
  function applyMute() {
    setPressed(btn.mute, muted);
    try { if (T.audio && T.audio.setMuted) T.audio.setMuted(muted); } catch (e) { T.reportError && T.reportError('ui:mute', e); }
  }
  function toggleMute() {
    muted = !muted;
    try { window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) { /* 无存储时照常工作 */ }
    applyMute();
  }

  // ── 全屏：不支持就隐藏按钮；被拒绝时静默 ──
  const canFull = !!(document.fullscreenEnabled && document.documentElement.requestFullscreen);
  if (!canFull && btn.full) btn.full.hidden = true;
  function toggleFull() {
    if (!canFull) return;
    try {
      const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
      if (p && p.catch) p.catch(function () {});
    } catch (e) { /* 平台拒绝全屏 */ }
  }
  document.addEventListener('fullscreenchange', function () { setPressed(btn.full, !!document.fullscreenElement); });

  // ── 片头 ──
  el.begin.addEventListener('click', function () {
    if (el.begin.disabled) return;
    el.begin.disabled = true;
    try { E.begin(); } catch (e) { T.reportError && T.reportError('ui:begin', e); }
  });
  function dismissIntro() {
    if (ui.begun) return;
    ui.begun = true;
    show(el.start, false);
    root.classList.remove('is-intro');
    if (document.activeElement === el.begin) el.begin.blur();
    setTimeout(function () { el.start.hidden = true; }, 1500);
    poke();
    // 待机时引擎已进入第一幕（只是没开播）；开播若不换章就不会再发 chapter，幕名卡由这里补上
    if (ui.def) { showCard(ui.def, ui.index); showHint(ui.def); }
  }

  // ── 时间轴 ──
  function buildTimeline() {
    ui.ticks.forEach(function (t) { t.node.remove(); });
    ui.ticks = [];
    if (ui.dot) ui.dot.remove();
    ui.film.forEach(function (f, i) {
      const lb = Math.max(0, Math.min(13.8, Number(f.lookback) || 0));
      const x = (13.8 - lb) / 13.8;
      const b = make('button', 'tl-tick');
      b.type = 'button';
      b.style.left = (x * 100).toFixed(3) + '%';
      if (i % 2) b.classList.add('hi');
      if (x < 0.12) b.classList.add('al-l');
      else if (x > 0.88) b.classList.add('al-r');
      b.setAttribute('aria-label', '第' + han(i + 1) + '幕 ' + f.title + '，' + f.epoch);
      b.appendChild(make('span', 'tl-label', f.title));
      b.appendChild(make('span', 'tl-epoch', f.epoch));
      b.addEventListener('click', function () { E.goTo(f.id); });
      el.track.appendChild(b);
      ui.ticks.push({ node: b, x: x, id: f.id });
    });
    ui.dot = make('span', 'tl-dot');
    ui.dot.hidden = true;
    el.track.appendChild(ui.dot);
  }
  function updateTimeline(progress) {
    const i = ui.index, cur = ui.ticks[i];
    ui.ticks.forEach(function (t, k) { t.node.classList.toggle('cur', k === i); });
    if (!cur) { el.progress.style.width = '0'; ui.dot.hidden = true; return; }
    const next = ui.ticks[i + 1];
    el.progress.style.left = (cur.x * 100).toFixed(3) + '%';
    if (next && next.x > cur.x) {
      el.progress.style.width = ((next.x - cur.x) * Math.max(0, Math.min(1, progress)) * 100).toFixed(3) + '%';
      ui.dot.hidden = true;
    } else {
      el.progress.style.width = '0';
      ui.dot.style.left = (cur.x * 100).toFixed(3) + '%';
      ui.dot.hidden = false;
    }
  }

  // ── 幕名卡 ──
  function showCard(def, index) {
    ui.cardTimers.forEach(clearTimeout);
    show(el.card, false);
    el.cardNum.textContent = index >= 0 ? '第' + han(index + 1) + '幕' : '';
    el.cardTitle.textContent = def.title || '';
    el.cardLatin.textContent = def.latin || '';
    verticalText(el.cardEpoch, def.epoch || '');
    ui.cardTimers = [
      setTimeout(function () { show(el.card, true); }, 120),
      setTimeout(function () { show(el.card, false); }, 120 + 600 + CARD_HOLD_MS),
    ];
  }

  // ── 字幕：换句时先淡出再换字，避免两句叠印 ──
  function setCaption(text) {
    clearTimeout(ui.capTimer);
    if (!text) { ui.capText = null; show(el.caption, false); return; }
    if (text === ui.capText) return;
    const wasOn = el.caption.classList.contains('on');
    ui.capText = text;
    if (!wasOn) { el.caption.textContent = text; show(el.caption, true); return; }
    show(el.caption, false);
    ui.capTimer = setTimeout(function () {
      if (ui.capText !== text) return;
      el.caption.textContent = text;
      show(el.caption, true);
    }, 420);
  }

  // ── 操作提示 ──
  function showHint(def) {
    clearTimeout(ui.hintTimer);
    el.hint.textContent = '';
    const list = (def && def.controls) || [];
    if (!list.length) { show(el.hint, false); return; }
    list.forEach(function (c, i) {
      if (i) el.hint.appendChild(make('span', 'sep', '·'));
      el.hint.appendChild(make('span', 'it', c));
    });
    show(el.hint, true);
    ui.hintTimer = setTimeout(function () { show(el.hint, false); }, HINT_MS);
  }

  // ── 输入框：由 tick 判断（章内时间 ≥ input.at） ──
  function setInput(on) {
    on = !!on;
    if (on === ui.inputOn) return;
    ui.inputOn = on;
    show(el.inputWrap, on);
    if (on) {
      const inp = ui.def.input;
      el.input.placeholder = inp.placeholder || '';
      el.input.setAttribute('aria-label', inp.placeholder || '输入');
      el.input.maxLength = inp.maxLength > 0 ? inp.maxLength : 32;
      el.input.disabled = false;
    } else {
      if (document.activeElement === el.input) el.input.blur();
      el.input.value = '';
      el.input.disabled = true;
    }
  }
  el.input.disabled = true;
  el.input.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') { if (e.key === 'Escape') el.input.blur(); return; }
    if (e.isComposing || e.keyCode === 229) return;   // 输入法组字中的回车是"上屏"，不是提交
    e.preventDefault();
    const v = el.input.value.trim();
    if (!v) return;
    try { E.submitInput(v); } catch (err) { T.reportError && T.reportError('ui:input', err); }
    el.input.value = '';
  });

  // ── 解剖面板 ──
  function anatomyOpen() { return !el.anatomy.hidden; }
  function fillAnatomy() {
    const def = ui.def;
    if (!def) return;
    const an = def.anatomy || {};
    el.anTitle.textContent = def.title || '';
    el.anLatin.textContent = (ui.index >= 0 ? 'ACT ' + (ui.index + 1) + ' · ' : '') + (def.latin || '');
    el.anLead.textContent = an.lead || '';
    el.anLead.hidden = !an.lead;
    el.anEqs.textContent = '';
    (an.equations || []).forEach(function (q) {
      el.anEqs.appendChild(make('dt', '', q.name || ''));
      const dd = make('dd', '', q.eq || '');
      dd.tabIndex = 0;   // 过长方程可横向滚动：让键盘也能滚
      el.anEqs.appendChild(dd);
    });
    el.anEqsSec.hidden = !(an.equations && an.equations.length);
    el.anNotes.textContent = '';
    (an.notes || []).forEach(function (n) { el.anNotes.appendChild(make('li', '', n)); });
    el.anNotesSec.hidden = !(an.notes && an.notes.length);
    el.anLive.textContent = '';
    ui.liveRows = [];
    refreshLive();
    runTest(def.id);
  }
  function refreshLive() {
    let rows = [];
    try { rows = E.live() || []; } catch (e) { rows = []; }
    el.anLiveSec.hidden = !rows.length;
    if (rows.length !== ui.liveRows.length) {
      el.anLive.textContent = '';
      ui.liveRows = rows.map(function () {
        const row = make('div'), dt = make('dt'), dd = make('dd');
        row.appendChild(dt); row.appendChild(dd); el.anLive.appendChild(row);
        return [dt, dd];
      });
    }
    rows.forEach(function (r, i) {
      const c = ui.liveRows[i];
      if (c[0].textContent !== String(r[0])) c[0].textContent = String(r[0]);
      if (c[1].textContent !== String(r[1])) c[1].textContent = String(r[1]);
    });
  }
  function renderTest(id) {
    if (!ui.def || ui.def.id !== id) return;
    const rec = ui.tests[id];
    el.anTest.textContent = '';
    if (!rec || rec.state === 'running') { el.anTest.appendChild(make('li', '', null)).appendChild(make('span', 'msg', '正在自检…')); return; }
    if (rec.state === 'error') { el.anTest.appendChild(make('li')).appendChild(make('span', 'msg err', '自检未能运行：' + rec.message)); return; }
    if (!rec.results.length) { el.anTest.appendChild(make('li')).appendChild(make('span', 'msg', '这一幕没有自检项。')); return; }
    rec.results.forEach(function (r) {
      const li = make('li', r.pass ? 'pass' : 'fail');
      li.appendChild(make('span', 'mk', r.pass ? '✓' : '✗'));
      li.appendChild(make('span', 'nm', r.name));
      const v = make('span', 'vals');
      v.appendChild(document.createTextNode('实测 '));
      v.appendChild(make('b', '', String(r.measured)));
      v.appendChild(document.createTextNode('　/　理论 '));
      v.appendChild(make('b', '', String(r.expected)));
      li.appendChild(v);
      el.anTest.appendChild(li);
    });
  }
  function runTest(id) {
    if (!ui.tests[id]) {
      ui.tests[id] = { state: 'running' };
      Promise.resolve().then(function () { return E.runSelfTest(id); }).then(function (res) {
        ui.tests[id] = { state: 'done', results: Array.isArray(res) ? res : [] };
        renderTest(id);
      }, function (err) {
        ui.tests[id] = { state: 'error', message: (err && err.message) || String(err) };
        renderTest(id);
      });
    }
    renderTest(id);
  }
  function openAnatomy(opener) {
    if (!ui.def || ui.fatal) return;
    closeAbout(false);
    ui.panelOpener = opener || btn.anatomy;
    fillAnatomy();
    el.anatomy.hidden = false;
    void el.anatomy.offsetWidth;
    el.anatomy.classList.add('on');
    setPressed(btn.anatomy, true);
    clearInterval(ui.liveTimer);
    ui.liveTimer = setInterval(refreshLive, LIVE_MS);
    el.anTitle.focus({ preventScroll: true });
  }
  function closeAnatomy(restoreFocus) {
    if (!anatomyOpen()) return;
    clearInterval(ui.liveTimer);
    el.anatomy.classList.remove('on');
    setPressed(btn.anatomy, false);
    const wasFocusInside = el.anatomy.contains(document.activeElement);
    setTimeout(function () { if (!el.anatomy.classList.contains('on')) el.anatomy.hidden = true; }, 420);
    if (restoreFocus !== false && wasFocusInside && ui.panelOpener) ui.panelOpener.focus({ preventScroll: true });
    else if (wasFocusInside) document.activeElement.blur();
  }

  // ── 关于 ──
  function fillBuild() {
    const b = T.buildInfo;
    if (!b || !b.lines) { el.build.hidden = true; return; }
    el.build.textContent = '';
    const kb = Math.round((b.bytes || 0) / 1024);
    [[b.lines, ' 行代码'], [b.shaders, ' 个着色器'], [kb, ' KB']].forEach(function (p, i) {
      if (i) el.build.appendChild(document.createTextNode('　·　'));
      el.build.appendChild(document.createTextNode(Number(p[0] || 0).toLocaleString('en-US')));
      el.build.appendChild(make('span', 'han', p[1]));
    });
    el.build.hidden = false;
  }
  function aboutOpen() { return !el.about.hidden; }
  function openAbout(opener) {
    if (ui.fatal) return;
    closeAnatomy(false);
    ui.aboutOpener = opener || btn.about;
    fillBuild();
    el.about.hidden = false;
    void el.about.offsetWidth;
    el.about.classList.add('on');
    setPressed(btn.about, true);
    $('t-about-title').focus({ preventScroll: true });
  }
  function closeAbout(restoreFocus) {
    if (!aboutOpen()) return;
    el.about.classList.remove('on');
    setPressed(btn.about, false);
    const wasFocusInside = el.about.contains(document.activeElement);
    setTimeout(function () { if (!el.about.classList.contains('on')) el.about.hidden = true; }, 420);
    if (restoreFocus !== false && wasFocusInside && ui.aboutOpener) ui.aboutOpener.focus({ preventScroll: true });
    else if (wasFocusInside) document.activeElement.blur();
  }
  // 点击"关于"之外的空白处关闭它（它在画面正中，没有理由一直挡着）
  el.about.addEventListener('pointerdown', function (e) { if (e.target === el.about) closeAbout(); });

  // ── 控制 ──
  function toggleHold() { E.setAuto(!E.auto); }
  function togglePause() { E.setPaused(!E.paused); }
  const actions = {
    anatomy: function (b) { if (anatomyOpen()) closeAnatomy(); else openAnatomy(b); },
    mute: toggleMute,
    hold: toggleHold,
    full: toggleFull,
    about: function (b) { if (aboutOpen()) closeAbout(); else openAbout(b); },
  };
  Object.keys(btn).forEach(function (k) {
    btn[k].addEventListener('click', function () { actions[k](btn[k]); });
  });
  root.querySelectorAll('[data-close]').forEach(function (b) {
    b.addEventListener('click', function () { if (b.dataset.close === 'anatomy') closeAnatomy(); else closeAbout(); });
  });
  function syncState(s) {
    setPressed(btn.hold, !s.auto);
    el.paused.hidden = !s.paused;
    root.classList.toggle('is-paused', !!s.paused);
  }

  // ── 快捷键（焦点在输入框里、或输入法组字中，一律不响应） ──
  function isEditable(t) {
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }
  window.addEventListener('keydown', function (e) {
    poke();
    if (e.isComposing || e.keyCode === 229 || isEditable(e.target)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Escape') {
      if (anatomyOpen()) closeAnatomy(); else if (aboutOpen()) closeAbout();
      return;
    }
    if (ui.fatal || !ui.begun) return;
    let hit = true;
    switch (e.code) {
      case 'Space': if (!e.repeat) togglePause(); break;
      case 'ArrowLeft': if (!e.repeat) E.prev(); break;
      case 'ArrowRight': if (!e.repeat) E.next(); break;
      case 'KeyF': toggleFull(); break;
      case 'KeyM': toggleMute(); break;
      case 'KeyI': actions.anatomy(btn.anatomy); break;
      case 'KeyA': toggleHold(); break;
      default: hit = false;
    }
    if (hit) e.preventDefault();
  });

  // ── 空闲隐藏 ──
  function poke() {
    if (root.classList.contains('is-idle')) {
      root.classList.remove('is-idle');
      document.body.classList.remove('tc-idle');
    }
    clearTimeout(ui.idleTimer);
    ui.idleTimer = setTimeout(function () {
      if (!ui.begun || ui.fatal) return;
      // 隐去的控件不该还握着焦点（面板与输入框不受空闲影响，焦点在那里就留着）
      const a = document.activeElement;
      if (a && a.closest && a.closest('.chrome')) a.blur();
      root.classList.add('is-idle');
      document.body.classList.add('tc-idle');
    }, IDLE_MS);
  }
  ['pointermove', 'pointerdown', 'wheel', 'touchstart'].forEach(function (t) {
    window.addEventListener(t, poke, { passive: true });
  });

  // ── 事件 ──
  T.bus.on('boot:progress', function (d) {
    el.begin.textContent = '正在点亮 ' + d.done + ' / ' + d.total;
  });
  T.bus.on('ready', function (d) {
    ui.film = (d && d.film) || E.film || [];
    buildTimeline();
    applyMute();
    if (P.ch || E.begun) { dismissIntro(); return; }   // ?ch= 开发直达：引擎不等"开始"
    el.begin.textContent = '开始';
    el.begin.disabled = false;
    el.begin.setAttribute('aria-label', '开始');
  });
  T.bus.on('begin', dismissIntro);
  T.bus.on('chapter', function (d) {
    const def = d.def || {};
    ui.chapterId = d.id;
    ui.def = def;
    ui.index = filmIndexOf(d.id);
    root.style.setProperty('--act', ACT_COLOR[d.id] || '#e9dcc0');
    el.markAct.textContent = ui.index >= 0 ? '第' + han(ui.index + 1) + '幕　' + (def.title || '') : (def.title || '');
    setInput(false);
    if (ui.begun) { showCard(def, ui.index); showHint(def); }
    updateTimeline(0);
    if (anatomyOpen()) fillAnatomy();
  });
  T.bus.on('tick', function (d) {
    ui.lastTick = d;
    if (d.id === ui.chapterId) updateTimeline(d.progress);
    const inp = ui.def && ui.def.input;
    setInput(ui.begun && !ui.fatal && !!inp && d.id === ui.chapterId && d.time >= (Number(inp.at) || 0));
  });
  T.bus.on('caption', function (d) { setCaption(d && d.text); });
  T.bus.on('state', syncState);
  T.bus.on('input:release', function () { setInput(false); });
  T.bus.on('fatal', function (d) {
    ui.fatal = true;
    closeAnatomy(false); closeAbout(false);
    Array.prototype.forEach.call(root.children, function (c) { if (c !== el.fatal) c.hidden = true; });
    el.fatalMsg.textContent = (d && d.message) || '出了点问题。';
    el.fatal.hidden = false;
  });

  syncState({ auto: E.auto !== false, paused: !!E.paused });
})();
