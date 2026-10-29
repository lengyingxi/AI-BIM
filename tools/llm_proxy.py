#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
AIbim 本地大模型转发（解决"填了 Key 还是连不上"）

浏览器里直连大模型，常见两种死法：
  1) 服务商不给浏览器跨域（CORS）头 → 控制台/界面上只看到"连不上（Failed to fetch）"
  2) Key 不便写在前端

这个几十行的小服务在本机把请求代转出去，页面只跟 127.0.0.1 说话，就没有跨域问题了。

用法（只用标准库，Python 3.8+）：
    python tools/llm_proxy.py --target https://open.bigmodel.cn/api/paas/v4 --key sk-你的key
    python tools/llm_proxy.py --target https://api.deepseek.com/v1 --key sk-xxx --port 8790

然后页面上：点右下角「本地理解」→ 接口地址填 http://127.0.0.1:8790/v1
            Key 随便填一个（例如 proxy）→ 测试连接 → 保存

不传 --key 时，会把页面发来的 Authorization 原样转给上游（自己带 Key 也行）。
"""
import argparse
import json
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument('--target', required=True, help='上游地址，例如 https://api.deepseek.com/v1')
    ap.add_argument('--key', default='', help='上游 Key；不填就转发页面带来的 Authorization')
    ap.add_argument('--port', type=int, default=8790)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--timeout', type=int, default=60)
    return ap.parse_args()


ARGS = None


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST,GET,OPTIONS')
        self.send_header('Access-Control-Max-Age', '600')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _upstream_url(self, path):
        base = ARGS.target.rstrip('/')
        # 页面会请求 <endpoint>/chat/completions；把这段原样接到上游后面
        if path.startswith('/v1/'):
            tail = path[3:]           # /chat/completions
        elif path.startswith('/openai/'):
            tail = path[len('/openai'):]
        else:
            tail = path
        if not tail.startswith('/'):
            tail = '/' + tail
        return base + tail

    def do_GET(self):
        if self.path == '/healthz':
            body = json.dumps({'ok': True, 'target': ARGS.target}).encode()
            self.send_response(200)
            self._cors()
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n) if n else b''

        url = self._upstream_url(self.path)
        headers = {'Content-Type': 'application/json'}
        if ARGS.key:
            headers['Authorization'] = 'Bearer ' + ARGS.key
        elif self.headers.get('Authorization'):
            headers['Authorization'] = self.headers['Authorization']
        if self.headers.get('api-key'):
            headers['api-key'] = self.headers['api-key']

        req = urllib.request.Request(url, data=raw, headers=headers, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=ARGS.timeout) as r:
                body = r.read()
                code = r.status
        except urllib.error.HTTPError as e:
            body = e.read()
            code = e.code
        except Exception as e:                      # 网络/地址问题
            body = json.dumps({'error': {'message': 'proxy: %s' % e}}).encode()
            code = 502

        self.send_response(code)
        self._cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *a):
        sys.stderr.write('  · %s\n' % (fmt % a))


def main():
    global ARGS
    ARGS = parse_args()
    srv = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    print('AIbim 转发已启动：http://%s:%d/v1  →  %s' % (ARGS.host, ARGS.port, ARGS.target))
    print('页面里接口地址填 http://%s:%d/v1 ，Key 随便填（如 proxy），然后点「测试连接」。' % (ARGS.host, ARGS.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')


if __name__ == '__main__':
    main()
