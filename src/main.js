/* 太初 TAICHU — 启动入口：只做一件事，启动引擎（CONTRACT.md §4.6）。 */
(function () {
  'use strict';
  const T = window.TAICHU;
  T.boot = function () {
    if (T._booting) return;
    T._booting = true;
    try {
      T.engine.start();
    } catch (e) {
      T.reportError('boot', e);
      window.__taichu.booted = true;
      window.__taichu.ready = true;
      T.bus.emit('fatal', { message: '启动失败：' + (e && e.message) });
    }
  };
})();
