#!/usr/bin/env python3
"""太初 TAICHU 构建：src/ → 单文件。

产物：
  dist/taichu.html             Artifact 片段（无 doctype/html/head/body，发布时由平台包裹骨架）
  dist/taichu-standalone.html  完整文档，可直接双击打开，也是 tools/shot.py --dist 测试的对象
  manifest.json                静态清单（供非 devserver 的静态服务器使用）

规则：
  - 脚本顺序同 tools/devserver.py 的 manifest()；文件名以 "0-" 开头的章节是开发用章，不进产物。
  - 静态守卫：源码里出现网络请求或动态求值（fetch / XMLHttpRequest / WebSocket / import( / eval( / new Function /
    外部 URL）即构建失败 —— 《太初》的承诺是零素材、零依赖、零外部请求。
用法：python3 tools/build.py
"""
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import devserver  # noqa: E402

ROOT = devserver.ROOT

# 与 Artifact 发布骨架等价的 head（见 CONTRACT.md §9）
SKELETON_HEAD = (
    '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    '<style>:root{color-scheme:light;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}'
    'body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>\n'
    '</head>\n<body>\n')

FORBIDDEN = [
    (r'\bfetch\s*\(', 'fetch('),
    (r'\bXMLHttpRequest\b', 'XMLHttpRequest'),
    (r'\bWebSocket\b', 'WebSocket'),
    (r'\bEventSource\b', 'EventSource'),
    (r'\bimport\s*\(', 'import('),
    (r'\beval\s*\(', 'eval('),
    (r'\bnew\s+Function\b', 'new Function'),
    (r'\bimportScripts\b', 'importScripts'),
    (r'\bsendBeacon\b', 'sendBeacon'),
    (r'https?://(?!www\.w3\.org/)', '外部 URL'),
]


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def main():
    m = devserver.manifest()
    scripts = [s for s in m['scripts'] if not os.path.basename(s).startswith('0-')]
    css = '\n'.join(read(p) for p in m['css'])
    shell = read(m['shell']) if m['shell'] else '<canvas id="taichu-canvas"></canvas>'

    problems = []
    parts, lines, shaders = [], 0, 0
    for rel in scripts:
        src = read(rel)
        for pat, label in FORBIDDEN:
            for hit in re.finditer(pat, src):
                ln = src.count('\n', 0, hit.start()) + 1
                problems.append(f'{rel}:{ln} 出现 {label}')
        lines += src.count('\n') + 1
        shaders += len(re.findall(r'\bvoid\s+main\s*\(', src))
        parts.append(f'/* ── {rel} ── */\n' + src.replace('</script', '<\\/script'))
    for rel, text in [(p, read(p)) for p in m['css']] + ([(m['shell'], shell)] if m['shell'] else []):
        for hit in re.finditer(r'https?://(?!www\.w3\.org/)|@import|url\(\s*["\']?(?!data:)', text):
            ln = text.count('\n', 0, hit.start()) + 1
            problems.append(f'{rel}:{ln} 出现外部资源引用')
        lines += text.count('\n') + 1
    if problems:
        print('构建失败 —— 违反"零外部请求"：')
        for p in problems:
            print('  ✗', p)
        sys.exit(1)

    info = {
        'files': len(scripts) + len(m['css']) + (1 if m['shell'] else 0),
        'lines': lines,
        'shaders': shaders,
        'bytes': 0,
        'builtAt': time.strftime('%Y-%m-%d'),
    }

    def assemble():
        return (
            '<title>太初</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n'
            '<style>\n' + css + '\n</style>\n' + shell + '\n'
            '<script>\n' + '\n'.join(parts) + '\n</script>\n'
            '<script>\nTAICHU.buildInfo = ' + json.dumps(info, ensure_ascii=False) + ';\nTAICHU.boot();\n</script>\n')

    info['bytes'] = len(assemble().encode('utf-8'))
    frag = assemble()
    os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)
    with open(os.path.join(ROOT, 'dist', 'taichu.html'), 'w', encoding='utf-8') as f:
        f.write(frag)
    with open(os.path.join(ROOT, 'dist', 'taichu-standalone.html'), 'w', encoding='utf-8') as f:
        f.write(SKELETON_HEAD + frag + '</body>\n</html>\n')
    with open(os.path.join(ROOT, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(m, f, ensure_ascii=False, indent=1)
    print(f"构建完成：{info['files']} 个源文件 · {info['lines']} 行 · {info['shaders']} 个着色器 · {info['bytes'] / 1024:.1f} KB")
    print('  dist/taichu.html（Artifact 片段）  dist/taichu-standalone.html（独立文档）')


if __name__ == '__main__':
    main()
