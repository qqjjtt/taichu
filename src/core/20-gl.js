/* 太初 TAICHU — T.G：WebGL2 助手（CONTRACT.md §4.2）。
   设计取舍：薄封装、无隐式状态缓存（除纹理单元分配外），出错时给出能直接定位的信息——章节作者靠它调试。 */
(function () {
  'use strict';
  const T = window.TAICHU;

  let gl = null;
  let emptyVAO = null;
  let fsVS = null;         // 全屏三角形顶点着色器源码
  let maxUnitUsed = 0;     // 引擎复位状态时只需解绑到这里
  let current = null;      // 当前绑定的 Target（null = 画布）

  const FORMATS = {
    rgba8: ['RGBA8', 'RGBA', 'UNSIGNED_BYTE', 4, false],
    rgba16f: ['RGBA16F', 'RGBA', 'HALF_FLOAT', 4, true],
    rgba32f: ['RGBA32F', 'RGBA', 'FLOAT', 4, true],
    rg16f: ['RG16F', 'RG', 'HALF_FLOAT', 2, true],
    rg32f: ['RG32F', 'RG', 'FLOAT', 2, true],
    r16f: ['R16F', 'RED', 'HALF_FLOAT', 1, true],
    r32f: ['R32F', 'RED', 'FLOAT', 1, true],
    r8: ['R8', 'RED', 'UNSIGNED_BYTE', 1, false],
    // 引擎内部用（泛光链）：每像素 4 字节的浮点，带宽减半
    r11g11b10f: ['R11F_G11F_B10F', 'RGB', 'HALF_FLOAT', 3, true],
  };
  const WRAPS = { clamp: 'CLAMP_TO_EDGE', repeat: 'REPEAT', mirror: 'MIRRORED_REPEAT' };

  const G = {
    gl: null,
    caps: { floatLinear: false, floatBlend: false, timerQuery: false, colorBufferFloat: false, maxTex: 0, maxPointSize: 1 },
    timerExt: null,
    stats: { programs: 0, textures: 0, targets: 0 },
  };

  G.init = function (canvas) {
    try {
      gl = canvas.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false,
        preserveDrawingBuffer: false, powerPreference: 'high-performance',
      });
    } catch (e) { gl = null; }
    if (!gl) return null;
    G.gl = gl;
    const c = G.caps;
    c.colorBufferFloat = !!gl.getExtension('EXT_color_buffer_float');
    c.floatLinear = !!gl.getExtension('OES_texture_float_linear');
    c.floatBlend = !!gl.getExtension('EXT_float_blend');
    G.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    c.timerQuery = !!G.timerExt;
    c.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    c.maxPointSize = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
    c.maxUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
    c.maxDrawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS);
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    c.renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    emptyVAO = gl.createVertexArray();
    gl.bindVertexArray(emptyVAO);
    fsVS = 'out vec2 vUv;\nvoid main() {\n  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));\n' +
      '  vUv = p;\n  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);\n}\n';
    return gl;
  };

  // ── 着色器源码预处理：#include 展开、头部、行号映射 ──
  function preprocess(src, stage, withUv) {
    const lines = [];   // { text, file, line }
    const seen = {};
    function emit(text, file, line) { lines.push({ text: text, file: file, line: line }); }
    function expand(code, file) {
      const arr = String(code).split('\n');
      for (let i = 0; i < arr.length; i++) {
        const L = arr[i];
        const m = /^\s*#include\s*[<"]([\w-]+)[>"]\s*$/.exec(L);
        if (m) {
          const name = m[1];
          if (!(name in T.glsl)) {
            throw new Error('#include <' + name + '> 不存在（' + file + ' 第 ' + (i + 1) + ' 行）。可用片段：' + Object.keys(T.glsl).join(' '));
          }
          if (!seen[name]) { seen[name] = true; expand(T.glsl[name], '<' + name + '>'); }
          emit('// #include <' + name + '>', file, i + 1);
        } else if (/^\s*#version\b/.test(L) || /^\s*precision\s+\w+\s+(float|int|sampler2D)\s*;/.test(L)) {
          emit('// ' + L.trim() + '（由引擎统一提供）', file, i + 1);
        } else {
          emit(L, file, i + 1);
        }
      }
    }
    const head = ['#version 300 es', 'precision highp float;', 'precision highp int;', 'precision highp sampler2D;',
      'precision highp sampler3D;', 'precision highp usampler2D;', 'precision highp isampler2D;', 'precision highp sampler2DArray;'];
    for (const h of head) emit(h, '(引擎头部)', 0);
    const userLines = lines.length;
    expand(src, '本程序');
    if (stage === 'fs') {
      const body = lines.slice(userLines).map(function (l) { return l.text; }).join('\n');
      // 没有自己声明任何 out 的片元着色器，补一个 fragColor
      if (!/^\s*(layout\s*\([^)]*\)\s*)?out\s+\w/m.test(body)) lines.splice(userLines, 0, { text: 'out vec4 fragColor;', file: '(引擎补充)', line: 0 });
      if (withUv && !/\bin\s+vec2\s+vUv\b/.test(body)) lines.splice(userLines, 0, { text: 'in vec2 vUv;', file: '(引擎补充)', line: 0 });
    }
    return lines;
  }

  function describeError(progName, stageName, log, lines) {
    const out = ['着色器编译失败 · 程序「' + progName + '」· ' + stageName];
    const logLines = String(log || '').trim().split('\n').filter(Boolean);
    out.push(logLines.join('\n'));
    const shown = {};
    let count = 0;
    for (const ll of logLines) {
      const m = /(?:ERROR|WARNING):\s*\d+:(\d+):/.exec(ll);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (shown[n] || count >= 3) continue;
      shown[n] = true; count++;
      const at = lines[n - 1];
      out.push('—— 第 ' + n + ' 行' + (at ? '（来源 ' + at.file + ' 第 ' + at.line + ' 行）' : '') + ' ——');
      for (let k = Math.max(1, n - 3); k <= Math.min(lines.length, n + 3); k++) {
        out.push((k === n ? '>' : ' ') + String(k).padStart(5) + ' | ' + lines[k - 1].text);
      }
    }
    if (!count && lines.length) out.push('（日志里没有行号；完整源码共 ' + lines.length + ' 行）');
    return out.join('\n');
  }

  function compile(progName, type, src, withUv) {
    const stage = type === gl.VERTEX_SHADER ? 'vs' : 'fs';
    const lines = preprocess(src, stage, withUv);
    const sh = gl.createShader(type);
    gl.shaderSource(sh, lines.map(function (l) { return l.text; }).join('\n'));
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const msg = describeError(progName, stage === 'vs' ? '顶点着色器' : '片元着色器', gl.getShaderInfoLog(sh), lines);
      gl.deleteShader(sh);
      throw new Error(msg);
    }
    return sh;
  }

  const SAMPLER_TYPES = {};
  function samplerTarget(type) { return SAMPLER_TYPES[type]; }

  function texOf(v) {
    if (!v) return null;
    if (typeof WebGLTexture !== 'undefined' && v instanceof WebGLTexture) return v;
    if (v.tex) return v.tex;
    return null;
  }

  function Program(name, vsSrc, fsSrc, withUv) {
    if (!gl) throw new Error('T.G.program：GL 尚未初始化');
    if (!SAMPLER_TYPES[gl.SAMPLER_2D]) {
      SAMPLER_TYPES[gl.SAMPLER_2D] = gl.TEXTURE_2D; SAMPLER_TYPES[gl.INT_SAMPLER_2D] = gl.TEXTURE_2D;
      SAMPLER_TYPES[gl.UNSIGNED_INT_SAMPLER_2D] = gl.TEXTURE_2D; SAMPLER_TYPES[gl.SAMPLER_3D] = gl.TEXTURE_3D;
      SAMPLER_TYPES[gl.SAMPLER_2D_ARRAY] = gl.TEXTURE_2D_ARRAY; SAMPLER_TYPES[gl.SAMPLER_CUBE] = gl.TEXTURE_CUBE_MAP;
      SAMPLER_TYPES[gl.SAMPLER_2D_SHADOW] = gl.TEXTURE_2D;
    }
    this.name = name;
    const vs = compile(name, gl.VERTEX_SHADER, vsSrc);
    const fs = compile(name, gl.FRAGMENT_SHADER, fsSrc, withUv);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error('着色器链接失败 · 程序「' + name + '」\n' + log +
        '\n（常见原因：顶点着色器的 out 与片元着色器的 in 名字或类型不一致；uniform 在两个阶段里类型不同）');
    }
    this.prog = p;
    this.uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      if (!info) continue;
      const base = info.name.replace(/\[0\]$/, '');
      this.uniforms[base] = { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size, unit: -1 };
    }
    this._next = 0;
    G.stats.programs++;
  }
  Program.prototype.use = function () {
    gl.useProgram(this.prog);
    this._next = 0;
    for (const k in this.uniforms) this.uniforms[k].unit = -1;
    return this;
  };
  Program.prototype.has = function (name) { return !!this.uniforms[name]; };
  Program.prototype.set = function (u) {
    for (const key in u) {
      const info = this.uniforms[key];
      if (!info) continue;   // 被优化掉或不存在：静默忽略（契约规定）
      const v = u[key];
      if (v === undefined || v === null) {
        throw new Error('程序「' + this.name + '」的 uniform ' + key + ' 收到 ' + v);
      }
      const loc = info.loc, t = info.type;
      const tgt = samplerTarget(t);
      if (tgt) {
        const tex = texOf(v);
        if (!tex) throw new Error('程序「' + this.name + '」的采样器 ' + key + ' 需要 Tex / Target / WebGLTexture，收到 ' + Object.prototype.toString.call(v));
        if (info.unit < 0) info.unit = this._next++;
        if (info.unit > maxUnitUsed) maxUnitUsed = info.unit;
        gl.activeTexture(gl.TEXTURE0 + info.unit);
        gl.bindTexture(tgt, tex);
        gl.uniform1i(loc, info.unit);
        continue;
      }
      const arr = typeof v === 'number' || typeof v === 'boolean' ? null : v;
      switch (t) {
        case gl.FLOAT: arr ? gl.uniform1fv(loc, arr) : gl.uniform1f(loc, +v); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(loc, arr); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(loc, arr); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(loc, arr); break;
        case gl.INT: case gl.BOOL: arr ? gl.uniform1iv(loc, arr) : gl.uniform1i(loc, v === true ? 1 : v === false ? 0 : v | 0); break;
        case gl.INT_VEC2: case gl.BOOL_VEC2: gl.uniform2iv(loc, arr); break;
        case gl.INT_VEC3: case gl.BOOL_VEC3: gl.uniform3iv(loc, arr); break;
        case gl.INT_VEC4: case gl.BOOL_VEC4: gl.uniform4iv(loc, arr); break;
        case gl.UNSIGNED_INT: arr ? gl.uniform1uiv(loc, arr) : gl.uniform1ui(loc, v >>> 0); break;
        case gl.UNSIGNED_INT_VEC2: gl.uniform2uiv(loc, arr); break;
        case gl.UNSIGNED_INT_VEC3: gl.uniform3uiv(loc, arr); break;
        case gl.UNSIGNED_INT_VEC4: gl.uniform4uiv(loc, arr); break;
        case gl.FLOAT_MAT2: gl.uniformMatrix2fv(loc, false, arr); break;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(loc, false, arr); break;
        case gl.FLOAT_MAT4: gl.uniformMatrix4fv(loc, false, arr); break;
        default: throw new Error('程序「' + this.name + '」的 uniform ' + key + ' 类型 0x' + t.toString(16) + ' 不受支持');
      }
    }
    return this;
  };

  G.program = function (name, vsSrc, fsSrc) { return new Program(name, vsSrc, fsSrc); };
  G.fsProgram = function (name, fsSrc) { return new Program(name, fsVS, fsSrc, true); };

  // ── 纹理 ──
  function fmtOf(format) {
    const f = FORMATS[format || 'rgba8'];
    if (!f) throw new Error('未知纹理格式 ' + format + '（可用：' + Object.keys(FORMATS).join(' ') + '）');
    return f;
  }
  function applyParams(fmt, opts, mips) {
    const isFloat32 = fmt[2] === 'FLOAT';
    let filter = opts.filter || 'linear';
    if (filter === 'linear' && isFloat32 && !G.caps.floatLinear) filter = 'nearest';   // 退路：32 位浮点不可线性过滤
    const mag = filter === 'linear' ? gl.LINEAR : gl.NEAREST;
    const min = mips ? (filter === 'linear' ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST) : mag;
    const wrap = gl[WRAPS[opts.wrap || 'clamp']];
    if (!wrap) throw new Error('未知 wrap ' + opts.wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  }
  function upload(fmt, w, h, data, sub) {
    // 半浮点格式允许用 Float32Array 上传（type=FLOAT），省去 CPU 端转 half
    let type = gl[fmt[2]];
    if (data && fmt[2] === 'HALF_FLOAT' && data instanceof Float32Array) type = gl.FLOAT;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (sub) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl[fmt[1]], type, data);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl[fmt[0]], w, h, 0, gl[fmt[1]], type, data || null);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  G.texture = function (opts) {
    opts = opts || {};
    const fmt = fmtOf(opts.format);
    const w = opts.w | 0, h = opts.h | 0;
    if (w <= 0 || h <= 0 || w > G.caps.maxTex || h > G.caps.maxTex) throw new Error('T.G.texture：尺寸非法 ' + w + '×' + h);
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    upload(fmt, w, h, opts.data || null, false);
    applyParams(fmt, opts, !!opts.mips);
    if (opts.mips) gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    G.stats.textures++;
    return {
      tex: tex, w: w, h: h, format: opts.format || 'rgba8',
      set: function (data) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        upload(fmt, w, h, data, true);
        if (opts.mips) gl.generateMipmap(gl.TEXTURE_2D);
        gl.bindTexture(gl.TEXTURE_2D, null);
      },
      dispose: function () { if (this.tex) { gl.deleteTexture(this.tex); this.tex = null; G.stats.textures--; } },
    };
  };

  // ── 渲染目标 ──
  G.target = function (opts) {
    opts = Object.assign({ format: 'rgba16f', filter: 'linear', wrap: 'clamp', count: 1, depth: false }, opts || {});
    const fmt = fmtOf(opts.format);
    if (fmt[4] && !G.caps.colorBufferFloat) throw new Error('T.G.target：本设备不支持浮点渲染目标（EXT_color_buffer_float）');
    const t = { fbo: null, tex: null, texs: [], w: 0, h: 0, format: opts.format, count: opts.count, depth: null, _opts: opts };
    t.resize = function (w, h) {
      w = Math.max(1, w | 0); h = Math.max(1, h | 0);
      if (w === t.w && h === t.h && t.fbo) return t;
      if (w > G.caps.maxTex || h > G.caps.maxTex) throw new Error('T.G.target：尺寸超过 MAX_TEXTURE_SIZE ' + w + '×' + h);
      freeGL();
      t.w = w; t.h = h;
      t.fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.activeTexture(gl.TEXTURE0);
      for (let i = 0; i < opts.count; i++) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        upload(fmt, w, h, null, false);
        applyParams(fmt, opts, false);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0);
        t.texs.push(tex);
      }
      gl.bindTexture(gl.TEXTURE_2D, null);
      if (opts.depth) {
        t.depth = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, t.depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.depth);
      }
      t.tex = t.texs[0];
      const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (st !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error('T.G.target：帧缓冲不完整（0x' + st.toString(16) + '），格式 ' + opts.format + ' ×' + opts.count);
      }
      G.bind(null);
      return t;
    };
    function freeGL() {
      for (const x of t.texs) gl.deleteTexture(x);
      if (t.fbo) gl.deleteFramebuffer(t.fbo);
      if (t.depth) gl.deleteRenderbuffer(t.depth);
      t.texs = []; t.fbo = null; t.depth = null; t.tex = null;
    }
    t.dispose = function () { if (t.fbo) { freeGL(); G.stats.targets--; } t.w = t.h = 0; };
    t.resize(opts.w, opts.h);
    G.stats.targets++;
    return t;
  };

  G.double = function (opts) {
    const d = { read: G.target(opts), write: G.target(opts) };
    d.swap = function () { const x = d.read; d.read = d.write; d.write = x; };
    d.resize = function (w, h) { d.read.resize(w, h); d.write.resize(w, h); };
    d.dispose = function () { d.read.dispose(); d.write.dispose(); };
    return d;
  };

  const DRAW_BUFS = [];
  G.bind = function (t) {
    if (t && !t.fbo) throw new Error('T.G.bind：目标已释放');
    current = t || null;
    if (!t) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.w, t.h);
    if (!DRAW_BUFS[t.count]) {
      DRAW_BUFS[t.count] = [];
      for (let i = 0; i < t.count; i++) DRAW_BUFS[t.count].push(gl.COLOR_ATTACHMENT0 + i);
    }
    gl.drawBuffers(DRAW_BUFS[t.count]);
  };
  G.current = function () { return current; };

  G.clear = function (r, g, b, a) {
    gl.clearColor(r || 0, g || 0, b || 0, a === undefined ? 1 : a);
    let bits = gl.COLOR_BUFFER_BIT;
    if (current && current.depth) { gl.depthMask(true); gl.clearDepth(1); bits |= gl.DEPTH_BUFFER_BIT; }
    gl.clear(bits);
  };

  G.blend = function (mode) {
    if (!mode || mode === 'none') { gl.disable(gl.BLEND); return; }
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    if (mode === 'add') gl.blendFunc(gl.ONE, gl.ONE);
    else if (mode === 'alpha') gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    else if (mode === 'premul') gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    else throw new Error('T.G.blend：未知模式 ' + mode + "（'none' | 'add' | 'alpha' | 'premul'）");
  };

  G.fullscreen = function () { gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.TRIANGLES, 0, 3); };
  G.drawPoints = function (count) { gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.POINTS, 0, count | 0); };
  // count = 顶点数（三角形数 × 3）
  G.drawTriangles = function (count) { gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.TRIANGLES, 0, count | 0); };

  // 读回浮点数据（selfTest 用）：总是返回 w*h*4 个分量（RGBA），单/双通道格式的多余分量为 0/1
  G.readFloat = function (t, x, y, w, h, attachment) {
    attachment = attachment | 0;
    if (!t || !t.fbo) throw new Error('T.G.readFloat：需要一个 Target');
    const prev = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment);
    let out;
    if (fmtOf(t.format)[4]) {
      out = new Float32Array(w * h * 4);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, out);
    } else {
      const b = new Uint8Array(w * h * 4);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
      out = new Float32Array(w * h * 4);
      for (let i = 0; i < b.length; i++) out[i] = b[i] / 255;
    }
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prev);
    return out;
  };

  G.dispose = function (obj) {
    if (!obj) return;
    if (obj instanceof Program) { if (obj.prog) { gl.deleteProgram(obj.prog); obj.prog = null; G.stats.programs--; } return; }
    if (typeof obj.dispose === 'function') obj.dispose();
  };

  // 引擎在每次调用章节之后复位到契约保证的状态
  G.resetState = function () {
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST); gl.disable(gl.POLYGON_OFFSET_FILL); gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ZERO);
    gl.depthMask(true); gl.depthFunc(gl.LESS); gl.colorMask(true, true, true, true);
    gl.cullFace(gl.BACK); gl.frontFace(gl.CCW);
    for (let i = maxUnitUsed; i >= 0; i--) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    maxUnitUsed = 0;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(emptyVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.useProgram(null);
  };

  G.Program = Program;
  T.G = G;
})();
