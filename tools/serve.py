#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
AIbim 演示服务：静态页面 + 大模型同源转发（一次解决跨域）

为什么需要它：
    https://llmapi.siruijie.com.cn 这类网关，POST 的响应里虽然带了
    Access-Control-Allow-Origin，但浏览器发出的 OPTIONS 预检被 nginx 直接
    403 且不带跨域头 —— 浏览器在预检那一步就被拦死，页面只能看到
    "Failed to fetch"。这不是 Key 的问题，改前端也绕不过去。

做法：
    页面和转发放在同一个端口（同源），浏览器根本不发预检请求。
    页面里接口地址填 /llm/v1 即可。

用法：
    python tools/serve.py                                  # 默认转发到 siruijie 网关
    python tools/serve.py --target https://api.deepseek.com/v1
    python tools/serve.py --key sk-xxx                     # Key 放服务端，页面不用填
    python tools/serve.py --port 8823 --host 127.0.0.1

    然后浏览器打开 http://127.0.0.1:8823/
    面板：点右下角「本地理解」→ 选「本机直连」→ 测试连接

不带 --key 时，页面里填的 Key 会原样转发给上游。
"""
import argparse
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_TARGET = 'https://llmapi.siruijie.com.cn/v1'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, 'web')

ARGS = None
CFG = {'model': '', 'hasKey': False, 'target': DEFAULT_TARGET}


# ---------------------------------------------------------------- 离线语音识别
# 浏览器自带的 SpeechRecognition 在 Chrome 上要连 Google、Edge 要连 Azure，
# 内网/受限网络下必然报 network 错误。这里在本机把麦克风 PCM 直接转文字，全程不出本机。
#
# 引擎优先级：
#   1) sherpa-onnx + streaming zipformer（默认）—— 纯 ONNX 推理，不依赖 torch。
#      中文准确率明显高于 vosk 小模型（"往东/往左"这类同音词不再听错），
#      CPU 实时率 0.06，边说边出字；模型 70MB，可整包拷进内网。
#   2) vosk（Kaldi）—— 老方案，42MB 小模型，作为没装 sherpa 时的兜底。
# 两条路对外接口完全一样，页面不用区分。
ASR_SESS = {}
ASR_LOCK = threading.Lock()
# 解码器不是线程安全的：两个线程同时解码会直接把进程 abort。这里串行化，代价可忽略。
ASR_REC = threading.Lock()
ASR = {
    'state': 'idle', 'err': '', 'engine': '', 'model': '', 'dir': '',
    'rec': None,        # sherpa-onnx OnlineRecognizer
    'vosk': None,       # vosk 兜底模型
}


def _asr_base():
    if ARGS and getattr(ARGS, 'asr_model', '') and os.path.isdir(ARGS.asr_model):
        return ARGS.asr_model
    return os.path.join(ROOT, 'tools', 'asr')


def asr_find_sherpa():
    """找一个 sherpa-onnx 流式模型目录：同一层里要有 tokens.txt + encoder/decoder/joiner .onnx"""
    base = _asr_base()
    if not os.path.isdir(base):
        return None
    hits = []
    for root, dirs, files in os.walk(base):
        depth = root.count(os.sep) - base.count(os.sep)
        if depth >= 3:
            dirs[:] = []
            continue
        pick = {}
        for f in files:
            lf = f.lower()
            if lf.endswith('.onnx'):
                for k in ('encoder', 'decoder', 'joiner'):
                    if lf.startswith(k):
                        # int8 优先：体积减半、速度更快，精度几乎无损
                        cur = pick.get(k, '')
                        if not cur or ('.int8.' in lf and '.int8.' not in cur):
                            pick[k] = os.path.join(root, f)
            elif lf == 'tokens.txt':
                pick['tokens'] = os.path.join(root, f)
        if len(pick) == 4:
            pick['dir'] = root
            hits.append(pick)
    if not hits:
        return None
    hits.sort(key=lambda p: p['dir'])
    return hits[0]


def asr_find_dir():
    """找 vosk 模型目录：tools/asr/vosk-model-*（没装 sherpa 时的兜底）"""
    base = _asr_base()
    if not os.path.isdir(base):
        return ''
    cands = [base] + [os.path.join(base, n) for n in sorted(os.listdir(base))]
    for p in cands:
        if not os.path.isdir(p):
            continue
        if (os.path.isfile(os.path.join(p, 'am', 'final.mdl'))
                or os.path.isfile(os.path.join(p, 'conf', 'model.conf'))
                or os.path.isfile(os.path.join(p, 'graph', 'HCLr.fst'))):
            return p
    return ''


def _asr_load_sherpa(errs):
    p = asr_find_sherpa()
    if not p:
        errs.append('没找到 sherpa 模型（tools/asr/<model>/ 下需要 tokens.txt 与 encoder/decoder/joiner .onnx）')
        return False
    try:
        import sherpa_onnx
    except ImportError:
        errs.append('没装 sherpa-onnx（pip install sherpa-onnx）')
        return False
    try:
        n = max(1, min(4, (os.cpu_count() or 2) // 2))
        ASR['rec'] = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=p['tokens'],
            encoder=p['encoder'],
            decoder=p['decoder'],
            joiner=p['joiner'],
            num_threads=n,
            sample_rate=16000,
            feature_dim=80,
            decoding_method='greedy_search',
            provider='cpu',
        )
        ASR['state'] = 'ready'
        ASR['engine'] = 'sherpa-onnx'
        ASR['dir'] = p['dir']
        ASR['model'] = os.path.basename(p['dir'])
        return True
    except Exception as e:
        errs.append('sherpa 加载失败 %s: %s' % (type(e).__name__, e))
        return False


def _asr_load_vosk(errs):
    d = asr_find_dir()
    if not d:
        errs.append('没找到 vosk 模型目录 tools/asr/vosk-model-*')
        return False
    try:
        import vosk
        vosk.SetLogLevel(-1)
        ASR['vosk'] = vosk.Model(d)
        ASR['state'] = 'ready'
        ASR['engine'] = 'vosk'
        ASR['dir'] = d
        ASR['model'] = os.path.basename(d)
        return True
    except ImportError:
        errs.append('没装 vosk（pip install vosk）')
        return False
    except Exception as e:
        errs.append('vosk 加载失败 %s: %s' % (type(e).__name__, e))
        return False


def asr_load():
    """加载模型（只加载一次，几秒），返回是否可用"""
    with ASR_LOCK:
        if ASR['state'] == 'ready':
            return True
        if ASR['state'] == 'error':
            return False               # 已经试过且失败，别每次请求都重试
        ASR['state'] = 'loading'
        errs = []
        if _asr_load_sherpa(errs) or _asr_load_vosk(errs):
            ASR['err'] = ''
            return True
        ASR['state'] = 'error'
        ASR['err'] = '；'.join(errs) or '没有可用的离线识别模型'
        return False


def asr_info():
    d = ASR['dir'] or _asr_base()
    return {
        'ok': ASR['state'] == 'ready' or (ASR['state'] in ('idle', 'loading')
                                          and bool(asr_find_sherpa() or asr_find_dir())),
        'state': ASR['state'],
        'engine': ASR['engine'] or 'sherpa-onnx',
        'model': ASR['model'] or os.path.basename(asr_find_sherpa()['dir'] if asr_find_sherpa() else ''),
        'dir': ASR['dir'] or d,
        'err': ASR['err'],
        'sessions': len(ASR_SESS),
    }


def asr_tidy():
    """清理超时会话，避免长时间不说完把内存占住"""
    now = time.time()
    dead = [k for k, v in ASR_SESS.items() if now - v['ts'] > 120]
    for k in dead:
        ASR_SESS.pop(k, None)


def asr_new():
    if not asr_load():
        return ''
    asr_tidy()
    sid = uuid.uuid4().hex[:12]
    with ASR_REC:
        if ASR['engine'] == 'sherpa-onnx':
            ASR_SESS[sid] = {'st': ASR['rec'].create_stream(),
                             'text': '', 'ts': time.time(), 'got': 0}
        else:
            import vosk
            rec = vosk.KaldiRecognizer(ASR['vosk'], 16000)
            rec.SetWords(False)
            ASR_SESS[sid] = {'rec': rec, 'text': '', 'ts': time.time(), 'got': 0}
    return sid


def asr_cn(t):
    """中文结果里有些引擎会带空格，去掉更符合输入习惯；有英文单词时保留"""
    t = (t or '').strip()
    if not t:
        return ''
    return t if any(c.isascii() and c.isalpha() for c in t) else t.replace(' ', '')


def _sherpa_feed(s, data):
    """流式喂 PCM(int16 mono 16k)，返回这半句目前的最佳文字（本身是累计的）"""
    import numpy as np
    rec = ASR['rec']
    st = s['st']
    a = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
    if a.size == 0:
        return s['text'], ''
    st.accept_waveform(16000, a)
    while rec.is_ready(st):
        rec.decode_stream(st)
    t = asr_cn(rec.get_result(st))
    if t:
        s['text'] = t
    return s['text'], ''


def _vosk_feed(s, data):
    rec = s['rec']
    if rec.AcceptWaveform(data):
        j = json.loads(rec.Result() or '{}')
        t = asr_cn(j.get('text'))
        if t:
            s['text'] = (s['text'] + ' ' + t).strip()
        return s['text'], ''
    j = json.loads(rec.PartialResult() or '{}')
    return s['text'], asr_cn(j.get('partial'))


def asr_feed(sid, data):
    """喂一段 PCM，返回 (已确认文本, 正在说的半句)"""
    s = ASR_SESS.get(sid)
    if not s:
        return None, None
    s['ts'] = time.time()
    s['got'] += len(data)
    with ASR_REC:
        try:
            if ASR['engine'] == 'sherpa-onnx':
                return _sherpa_feed(s, data)
            return _vosk_feed(s, data)
        except Exception as e:
            ASR['err'] = '识别出错：%s' % e
            return s['text'], ''


def asr_end(sid):
    s = ASR_SESS.pop(sid, None)
    if not s:
        return ''
    with ASR_REC:
        try:
            if ASR['engine'] == 'sherpa-onnx':
                rec = ASR['rec']
                st = s['st']
                st.input_finished()
                while rec.is_ready(st):
                    rec.decode_stream(st)
                t = asr_cn(rec.get_result(st))
                if t:
                    s['text'] = t
            else:
                j = json.loads(s['rec'].FinalResult() or '{}')
                t = asr_cn(j.get('text'))
                if t:
                    s['text'] = (s['text'] + ' ' + t).strip()
        except Exception:
            pass
    return s['text'].strip()


def parse_args():
    ap = argparse.ArgumentParser(description='AIbim demo server with same-origin LLM proxy')
    ap.add_argument('--target', default=DEFAULT_TARGET, help='上游大模型地址（含 /v1），默认 siruijie 网关')
    ap.add_argument('--key', default='', help='上游 Key；不填则转发页面带来的 Authorization')
    ap.add_argument('--key-file', default='', help='从文件读 Key（第一行），比命令行安全些')
    ap.add_argument('--model', default='', help='默认模型名；不填则启动时从 /models 里自动挑一个')
    ap.add_argument('--port', type=int, default=8823)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--timeout', type=int, default=120, help='上游超时秒数，默认 120')
    ap.add_argument('--asr-model', default='',
                    help='识别模型根目录；默认 tools/asr/（自动找 sherpa 流式模型，找不到再退回 vosk）')
    ap.add_argument('--no-asr', action='store_true', help='关掉离线语音识别（页面退回浏览器识别）')
    return ap.parse_args()


def read_key():
    if ARGS.key:
        return ARGS.key.strip()
    if ARGS.key_file:
        try:
            with open(ARGS.key_file, encoding='utf-8') as f:
                return f.readline().strip()
        except Exception as e:
            print('读 key 文件失败：%s' % e, file=sys.stderr)
    return ''


# 自动挑模型时的偏好顺序（先按关键词命中，再按"看起来能聊"的兜底）
MODEL_PREF = ['gpt-4o-mini', 'gpt-4o', 'deepseek-chat', 'deepseek', 'max', 'plus', 'pro',
              'claude', 'glm-4', 'qwen', 'moonshot', 'gemini', 'doubao', 'yi-']
MODEL_BAD = ('seedream', 'dall-e', 'image', 'tts', 'whisper', 'embed', 'rerank', 'video', 'sora', 'kling', 'midjourney')


def _probe(model, key, target):
    """发一个 1 token 的请求，确认这个模型真的能用（有的模型挂着但上游会报错）"""
    body = json.dumps({'model': model, 'messages': [{'role': 'user', 'content': 'hi'}], 'max_tokens': 1}).encode()
    headers = {'Content-Type': 'application/json'}
    if key:
        headers['Authorization'] = 'Bearer ' + key
    req = urllib.request.Request(target.rstrip('/') + '/chat/completions', data=body, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status == 200
    except Exception as e:
        print('  模型 %s 不可用：%s' % (model, e), file=sys.stderr)
        return False


def pick_model(key, target):
    """从上游 /models 里挑一个能聊、且真的能通的模型"""
    url = target.rstrip('/') + '/models'
    headers = {'Authorization': 'Bearer ' + key} if key else {}
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=20) as r:
            j = json.loads(r.read().decode('utf-8', 'ignore'))
    except Exception as e:
        print('  拉模型列表失败：%s' % e, file=sys.stderr)
        return ''
    arr = j.get('data') or j.get('models') or []
    ids = [m.get('id') if isinstance(m, dict) else str(m) for m in arr]
    ids = [i for i in ids if i and not any(b in i.lower() for b in MODEL_BAD)]

    ordered, seen = [], set()
    for p in MODEL_PREF:
        for i in ids:
            if p in i.lower() and i not in seen:
                ordered.append(i); seen.add(i)
    for i in ids:
        if i not in seen:
            ordered.append(i); seen.add(i)

    for m in ordered[:4]:
        if _probe(m, key, target):
            return m
    return ordered[0] if ordered else ''



class Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    # 转发前缀：/llm/xxx → <target>/xxx
    PREFIX = '/llm'

    def _upstream(self, path):
        base = ARGS.target.rstrip('/')
        tail = path[len(self.PREFIX):] or '/'
        if not tail.startswith('/'):
            tail = '/' + tail
        # 目标地址本身已带 /v1，而页面填的是 /llm/v1/... → 去掉重复的一层
        if base.endswith('/v1') and tail.startswith('/v1/'):
            tail = tail[3:]
        return base + tail

    def _proxy(self, method):
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n) if n else None
        url = self._upstream(self.path)

        headers = {'Content-Type': self.headers.get('Content-Type') or 'application/json'}
        if ARGS.key:
            headers['Authorization'] = 'Bearer ' + ARGS.key
        elif self.headers.get('Authorization'):
            headers['Authorization'] = self.headers['Authorization']
        if self.headers.get('api-key'):
            headers['api-key'] = self.headers['api-key']

        req = urllib.request.Request(url, data=raw, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=ARGS.timeout) as r:
                body, code = r.read(), r.status
                ctype = r.headers.get('Content-Type', 'application/json')
        except urllib.error.HTTPError as e:
            body, code = e.read(), e.code
            ctype = e.headers.get('Content-Type', 'application/json') if e.headers else 'application/json'
        except Exception as e:
            body = json.dumps({'error': {'message': '本地转发失败：%s' % e}}).encode()
            code, ctype = 502, 'application/json; charset=utf-8'

        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if method != 'HEAD':
            try:
                self.wfile.write(body)
            except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                pass
        sys.stderr.write('  · %s %s → %s %s\n' % (method, self.path, code, url))

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        try:
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass                      # 页面刷新/关掉了，别往日志里倒堆栈

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        path = u.path
        # 离线语音识别是否可用（页面据此决定走本地 vosk 还是浏览器识别）
        if path == '/asr/health':
            return self._json(200, asr_info())
        if path == '/asr/warm':
            t0 = time.time()
            ok = asr_load()
            return self._json(200 if ok else 503, dict(asr_info(), ms=int((time.time() - t0) * 1000)))
        # 页面启动时来问一句：本机有没有配好网关？配好了就不用在界面上填任何东西
        if path == '/llm-config':
            body = json.dumps({
                'endpoint': '/llm/v1',
                'model': CFG['model'],
                'hasKey': CFG['hasKey'],
                'target': CFG['target']
            }).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
            return
        if path.startswith(self.PREFIX + '/') or path == self.PREFIX:
            return self._proxy('GET')
        return super().do_GET()

    def do_HEAD(self):
        if self.path.startswith(self.PREFIX + '/'):
            return self._proxy('HEAD')
        return super().do_HEAD()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        path, qs = u.path, urllib.parse.parse_qs(u.query)
        if path.startswith('/asr/'):
            return self._asr(path, qs)
        if path.startswith(self.PREFIX + '/'):
            return self._proxy('POST')
        self.send_error(404, 'Not Found')

    # ---- 离线识别：会话式，边说边出字 ----
    def _body(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = 0
        return self.rfile.read(n) if n > 0 else b''

    def _asr(self, path, qs):
        sid = (qs.get('sid') or [''])[0]
        if path == '/asr/start':
            sid = asr_new()
            if not sid:
                return self._json(503, dict(asr_info(), ok=False))
            return self._json(200, {'ok': True, 'sid': sid, 'model': asr_info()['model']})
        if path == '/asr/chunk':
            data = self._body()
            if not data:
                return self._json(200, {'ok': True, 'text': '', 'partial': ''})
            text, partial = asr_feed(sid, data)
            if text is None:
                return self._json(410, {'ok': False, 'err': '会话已过期'})
            return self._json(200, {'ok': True, 'text': text, 'partial': partial})
        if path == '/asr/final':
            self._body()
            return self._json(200, {'ok': True, 'text': asr_end(sid)})
        if path == '/asr/cancel':
            self._body()
            ASR_SESS.pop(sid, None)
            return self._json(200, {'ok': True})
        if path == '/asr/transcribe':
            # 一整段 PCM 直接转（调试用 / 兜底用）
            data = self._body()
            sid = asr_new()
            if not sid:
                return self._json(503, dict(asr_info(), ok=False, text=''))
            t0 = time.time()
            asr_feed(sid, data)
            text = asr_end(sid)
            return self._json(200, {'ok': True, 'text': text, 'bytes': len(data),
                                    'ms': int((time.time() - t0) * 1000)})
        return self._json(404, {'ok': False, 'err': 'no such asr route'})

    def do_OPTIONS(self):
        # 同源本来不会预检；万一是跨端口访问，也给它一个能过的响应
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def end_headers(self):
        # 演示阶段别让浏览器缓存旧脚本
        if not self.path.startswith(self.PREFIX):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *a):
        # 注意：log_error() 内部也是转调这个方法，此时第一个参数是 HTTP 状态码
        # （Python 3.13 起还是 HTTPStatus 枚举），不能拿来做 'in' 判断，
        # 否则 404 之类一发生就抛 TypeError 把请求线程带崩。
        p = a[0] if a else ''
        if isinstance(p, str) and ('/llm' in p or '/asr/' in p):
            return
        sys.stderr.write('  %s\n' % (fmt % a))


class Srv(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        e = sys.exc_info()[1]
        # 页面刷新、关标签页都会硬断连接：这类不用刷屏
        if isinstance(e, (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
            return
        ThreadingHTTPServer.handle_error(self, request, client_address)


def main():
    global ARGS
    ARGS = parse_args()
    ARGS.key = read_key()
    if not os.path.isdir(WEB):
        sys.exit('找不到 web 目录：%s' % WEB)

    CFG['hasKey'] = bool(ARGS.key)
    CFG['target'] = ARGS.target
    CFG['model'] = ARGS.model or pick_model(ARGS.key, ARGS.target)

    srv = Srv((ARGS.host, ARGS.port), Handler)
    print('AIbim 演示已启动：http://%s:%d/' % (ARGS.host, ARGS.port))
    print('页面会自动接上：地址 /llm/v1  模型 %s  %s' %
          (CFG['model'] or '(未识别，请手动填)', 'Key 由本服务注入' if ARGS.key else 'Key 请在页面填'))
    print('转发规则：%s/*  →  %s/*' % (Handler.PREFIX, ARGS.target.rstrip('/')))

    if ARGS.no_asr:
        print('语音：已按 --no-asr 关闭，页面用浏览器识别')
    else:
        has = asr_find_sherpa() or asr_find_dir()
        if has:
            print('语音：准备加载离线识别模型（首次说话前已后台预热）')
            sys.stdout.flush()
            threading.Thread(target=lambda: (asr_load(),
                                             print('     模型加载完成：%s / %s' % (ASR['engine'], ASR['model'])
                                                   if ASR['state'] == 'ready'
                                                   else '     模型加载失败：%s' % ASR['err']),
                                             sys.stdout.flush()),
                             daemon=True).start()
        else:
            print('语音：没找到本地模型（tools/asr/ 下既没有 sherpa 的 onnx，也没有 vosk 目录）')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')


if __name__ == '__main__':
    main()
