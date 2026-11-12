/* 太初 TAICHU — T.OrbitCamera（CONTRACT.md §4.5）。
   导演机位（script）+ 用户偏移（拖动 / 滚轮 / 双指）。偏移带惯性；用户停手 returnAfter 秒后缓慢归零，
   画面回到导演设计的镜头。距离在对数空间里偏移，所以远近缩放的手感在任何尺度下一致。 */
(function () {
  'use strict';
  const T = window.TAICHU;
  const M = T.M;

  function OrbitCamera(o) {
    o = o || {};
    this.az = o.az || 0; this.el = o.el === undefined ? 0.3 : o.el; this.dist = o.dist || 5;
    this.target = (o.target || [0, 0, 0]).slice();
    this.fov = o.fov || 45;
    this.minDist = o.minDist || 0.01; this.maxDist = o.maxDist || 1e6;
    this.minEl = o.minEl === undefined ? -1.5 : o.minEl; this.maxEl = o.maxEl === undefined ? 1.5 : o.maxEl;
    this.damping = o.damping === undefined ? 0.92 : o.damping;
    this.returnAfter = o.returnAfter === undefined ? 6 : o.returnAfter;
    this.sensitivity = o.sensitivity || 0.0055;   // 弧度 / CSS 像素
    // 用户偏移与速度
    this.oAz = 0; this.oEl = 0; this.oZoom = 0; this.zTarget = 0;   // oZoom = ln(距离倍数)
    this.vAz = 0; this.vEl = 0;
    this.lastUser = -1e9; this.userActive = false;
    this.pos = new Float32Array(3); this.right = new Float32Array(3); this.up = new Float32Array(3); this.fwd = new Float32Array(3);
    this.view = M.mat4();
    this._proj = new Float32Array(16); this._vp = new Float32Array(16);
    this._t = 0;
    this._compute();
  }

  // 每帧设置导演机位（只传需要的字段）
  OrbitCamera.prototype.script = function (s) {
    if (!s) return this;
    if (s.az !== undefined) this.az = s.az;
    if (s.el !== undefined) this.el = s.el;
    if (s.dist !== undefined) this.dist = s.dist;
    if (s.target) { this.target[0] = s.target[0]; this.target[1] = s.target[1]; this.target[2] = s.target[2]; }
    if (s.fov !== undefined) this.fov = s.fov;
    return this;
  };

  OrbitCamera.prototype.update = function (ctx) {
    const dt = Math.min(Math.max(ctx.frameDt || 0, 0), 0.1);
    this._t += dt;
    const inp = ctx.input;
    let touched = false;
    if (inp) {
      if (inp.down && (inp.dx || inp.dy)) {
        const dAz = -inp.dx * this.sensitivity, dEl = inp.dy * this.sensitivity;
        this.oAz += dAz; this.oEl += dEl;
        // 拖动中估计速度（平滑），松手后按它滑行
        if (dt > 0) { this.vAz = 0.6 * this.vAz + 0.4 * dAz / dt; this.vEl = 0.6 * this.vEl + 0.4 * dEl / dt; }
        touched = true;
      } else if (inp.down) {
        this.vAz *= 0.5; this.vEl *= 0.5;   // 按住不动：刹车
        touched = true;
      }
      let z = 0;
      if (inp.wheel) z += inp.wheel * 0.0012;
      if (inp.pinch && inp.pinch !== 1) z -= Math.log(inp.pinch);
      if (z) { this.zTarget += z; touched = true; }
    }
    if (touched) this.lastUser = this._t;
    if (!(inp && inp.down)) {
      // 惯性：damping 是 60 fps 下每帧保留的比例，换算到任意帧率
      const k = Math.pow(this.damping, dt * 60);
      this.oAz += this.vAz * dt; this.oEl += this.vEl * dt;
      this.vAz *= k; this.vEl *= k;
      if (this._t - this.lastUser > this.returnAfter) {
        // 归位：时间常数约 2.5 秒
        const r = Math.exp(-dt / 2.5);
        this.oAz *= r; this.oEl *= r; this.zTarget *= r;
        this.vAz *= r; this.vEl *= r;
      }
    }
    // 缩放平滑跟随目标（滚轮一格一格的跳变被抹平）
    this.oZoom = M.damp(this.oZoom, this.zTarget, 12, dt);
    this.userActive = !!(inp && inp.down) || (this._t - this.lastUser) < this.returnAfter;
    this._compute();
    return this;
  };

  OrbitCamera.prototype._compute = function () {
    let az = this.az, el = this.el, dist = this.dist;
    const pc = T.params && T.params.cam;
    if (pc && pc.length >= 3 && pc.every(isFinite)) { az = pc[0]; el = pc[1]; dist = pc[2]; }
    // 偏移钳在允许范围内（同时把超出的偏移吸收掉，否则反向拖动会有"死区"）
    const elT = M.clamp(el + this.oEl, this.minEl, this.maxEl);
    this.oEl = elT - el;
    let d = dist * Math.exp(this.oZoom);
    const dc = M.clamp(d, this.minDist, this.maxDist);
    if (dc !== d) { this.oZoom = Math.log(dc / Math.max(dist, 1e-9)); d = dc; }
    const zt = M.clamp(dist * Math.exp(this.zTarget), this.minDist, this.maxDist);
    this.zTarget = Math.log(zt / Math.max(dist, 1e-9));
    const azT = az + this.oAz;
    const dir = M.sph(azT, elT);
    const t = this.target;
    this.pos[0] = t[0] + dir[0] * d; this.pos[1] = t[1] + dir[1] * d; this.pos[2] = t[2] + dir[2] * d;
    this.fwd[0] = -dir[0]; this.fwd[1] = -dir[1]; this.fwd[2] = -dir[2];
    let r = M.cross(this.fwd, [0, 1, 0]);
    if (M.len(r) < 1e-6) r = [Math.cos(azT), 0, -Math.sin(azT)];
    r = M.norm(r);
    const u = M.cross(r, this.fwd);
    this.right.set(r); this.up.set(u);
    M.lookAt(this.pos, t, u, this.view);
    this.curAz = azT; this.curEl = elT; this.curDist = d;
  };

  OrbitCamera.prototype.proj = function (aspect, near, far) {
    return M.perspective(M.rad(this.fov), aspect, near === undefined ? 0.05 : near, far === undefined ? 1000 : far, this._proj);
  };
  OrbitCamera.prototype.viewProj = function (aspect, near, far) {
    return M.mul(this.proj(aspect, near, far), this.view, this._vp);
  };
  OrbitCamera.prototype.rayUniforms = function (ctx) {
    const th = Math.tan(M.rad(this.fov) / 2);
    return {
      uCamPos: this.pos, uCamRight: this.right, uCamUp: this.up, uCamFwd: this.fwd,
      uTanHalfFov: th, uAspect: ctx.aspect, uPixAngle: 2 * th / Math.max(1, ctx.height),
    };
  };
  // 立即清除用户偏移（例如章节在某个导演时刻需要强制镜头）
  OrbitCamera.prototype.resetUser = function () {
    this.oAz = this.oEl = this.oZoom = this.zTarget = 0; this.vAz = this.vEl = 0; this.lastUser = -1e9;
    this._compute();
  };

  T.OrbitCamera = OrbitCamera;
})();
