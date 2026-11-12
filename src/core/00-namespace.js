/* 太初 TAICHU — 命名空间、章节注册表、事件总线、错误收集、开发参数。
   本文件由总设计维护，是所有模块共同依赖的最小内核；其它模块不得修改它。 */
(function () {
  'use strict';
  const T = (window.TAICHU = window.TAICHU || {});
  T.version = '1.0.0';
  T.chapters = [];   // 已注册的章节定义（boot 时按 order 排序）
  T.glsl = {};       // 共享 GLSL 片段，由 core/30-glsl.js 填充，供着色器里的 #include <name> 使用
  T.errors = [];     // 运行期错误；任何一条都会让 tools/check.py 判失败

  // ── 极简事件总线 ──
  const handlers = {};
  T.bus = {
    on: function (evt, fn) {
      (handlers[evt] = handlers[evt] || []).push(fn);
      return function () { T.bus.off(evt, fn); };
    },
    off: function (evt, fn) {
      const a = handlers[evt];
      if (!a) return;
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    emit: function (evt, data) {
      const a = handlers[evt];
      if (!a) return;
      for (const fn of a.slice()) {
        try { fn(data); } catch (e) { T.reportError('bus:' + evt, e); }
      }
    },
  };

  // ── 错误收集 ──
  T.reportError = function (where, err) {
    const msg = '[' + where + '] ' + (err && err.stack ? err.stack : String(err));
    if (T.errors.length < 50) T.errors.push(msg);
    try { console.error(msg); } catch (e) { /* 忽略 */ }
    if (where.indexOf('bus:error') !== 0) T.bus.emit('error', { where: where, message: msg });
  };
  window.addEventListener('error', function (e) { T.reportError('window', e.error || e.message); });
  window.addEventListener('unhandledrejection', function (e) { T.reportError('promise', e.reason); });

  // ── 章节注册 ──
  const REQUIRED = ['id', 'order', 'title', 'latin', 'epoch', 'duration', 'init', 'enter', 'update', 'render'];
  T.registerChapter = function (def) {
    for (const k of REQUIRED) {
      if (def[k] === undefined) {
        T.reportError('registerChapter', new Error('章节缺少字段 ' + k + '（id=' + def.id + '）'));
        return;
      }
    }
    if (!/^[a-z0-9-]+$/.test(def.id)) {
      T.reportError('registerChapter', new Error('章节 id 只能含小写字母、数字、连字符: ' + def.id));
      return;
    }
    if (T.chapters.some(function (c) { return c.id === def.id; })) {
      T.reportError('registerChapter', new Error('章节 id 重复: ' + def.id));
      return;
    }
    T.chapters.push(def);
  };

  // ── 开发参数 ──
  // 只有本地开发时才有 query string；发布到 Artifact 后 location.search 恒为空，全部取默认值。
  const q = new URLSearchParams(location.search);
  function num(k, d) {
    const v = q.get(k);
    if (v === null || v === '') return d;
    const n = Number(v);
    return isFinite(n) ? n : d;
  }
  T.params = {
    ch: q.get('ch'),                       // 直接进入某一章（跳过片头，不等用户点击）
    t: num('t', 0),                        // 章内时间：进入后快进到 t
    freeze: q.get('freeze') === '1',       // 快进到 t 后冻结时间（仍每帧渲染、相机仍可交互）
    seed: num('seed', 1) | 0,              // 随机种子
    scale: num('scale', 0),                // >0 时固定渲染缩放并关闭动态分辨率
    quality: q.has('quality') ? (num('quality', 2) | 0) : -1,   // 0/1/2；-1 = 自动
    ui: q.get('ui') !== '0',               // 是否显示界面层
    audio: q.get('audio') !== '0',         // 是否启用音频
    auto: q.get('auto') !== '0',           // 是否自动进入下一幕
    glerr: q.get('glerr') === '1',         // 每帧检查 gl.getError()
    cam: q.get('cam') ? q.get('cam').split(',').map(Number) : null,   // az,el,dist 覆盖导演机位
    dev: q.has('ch') || q.has('dev'),      // 开发模式（不等待"开始"按钮）
    devfilm: q.get('devfilm') === '1',     // 把 dev 章（testcard / probe 等）也排进正片（界面与配乐的隔离测试用）
  };
  // Artifact 里只有纯 #name 能进出地址栏：用它选择起始章节
  T.hashChapter = function () {
    const h = (location.hash || '').replace(/^#/, '');
    return /^[a-z0-9-]+$/.test(h) ? h : null;
  };

  // ── 工具脚本读取的状态对象（引擎每帧更新；字段含义见 CONTRACT.md §4.7） ──
  window.__taichu = {
    ready: false, booted: false, chapter: null, t: 0, frames: 0, frameMs: 0, gpuMs: null,
    scale: 1, width: 0, height: 0, quality: 2, errors: T.errors, perf: null,
  };
})();
