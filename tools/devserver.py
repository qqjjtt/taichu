#!/usr/bin/env python3
"""太初 TAICHU 开发服务器：静态文件 + 动态 /manifest.json（按约定顺序列出 src 下的脚本）。

用法：python3 tools/devserver.py [port]      （默认 8765）
模块：from devserver import start; srv, port = start(0)   （0 = 随机空闲端口）
"""
import glob
import http.server
import json
import os
import sys
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def manifest():
    """脚本加载顺序：core（按文件名）→ audio → ui → chapters（按文件名）→ main.js。"""
    def g(pattern):
        return sorted(glob.glob(os.path.join(ROOT, pattern)))

    files = g('src/core/*.js') + g('src/audio/*.js') + g('src/ui/*.js') + g('src/chapters/*.js') + g('src/main.js')
    rel = [os.path.relpath(f, ROOT).replace(os.sep, '/') for f in files]
    css = 'src/ui/style.css'
    shell = 'src/ui/shell.html'
    return {
        'scripts': rel,
        'css': [css] if os.path.exists(os.path.join(ROOT, css)) else [],
        'shell': shell if os.path.exists(os.path.join(ROOT, shell)) else None,
    }


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def do_GET(self):
        if self.path.split('?')[0] == '/favicon.ico':   # 避免浏览器自动请求 favicon 产生 404 控制台错误
            self.send_response(204)
            self.end_headers()
            return
        if self.path.split('?')[0] == '/manifest.json':
            body = json.dumps(manifest()).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *a):
        pass


def start(port=0):
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    srv, port = start(port)
    print(f'太初 dev server: http://127.0.0.1:{port}/dev.html', flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
