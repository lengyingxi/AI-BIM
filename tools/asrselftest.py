#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
离线语音识别自检：把 tools/asr/*.wav 按 0.3 秒一包推给 /asr/chunk，
再用 /asr/final 结算，和期望文字逐字比对。

用法：
    python tools/serve.py --port 8823          # 先起服务
    python tools/asrselftest.py                # 另开一个窗口
    python tools/asrselftest.py --engine vosk  # 只看 vosk 兜底效果（需改服务启动参数）

为什么要按包推：真实麦克风就是 0.3 秒一包，一次性灌整段会掩盖流式拼接的问题。
"""
import argparse
import json
import os
import sys
import time
import urllib.request
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASRDIR = os.path.join(ROOT, 'tools', 'asr')
CHUNK_SEC = 0.3
RATE = 16000

# 只连本机，别走系统代理：机器上配了 http_proxy 时，urllib 会把 127.0.0.1 也丢给代理，
# 结果是 502，看起来像服务挂了，其实服务好好的。
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# 期望值 = 用户嘴上说的原话
CASES = [
    ('s1.wav', '把空调放到一零一房间靠墙'),
    ('s2.wav', '把空调往东挪半米'),
    ('t.wav', '把这个设备往左挪一点'),
    ('voice_cmd.wav', '把空调放到一零一房间靠墙'),
    ('voice_two.wav', '把空调放到一零一房间靠墙把空调往东挪半米'),
    ('voice_two_pad.wav', '把空调放到一零一房间靠墙把空调往东挪半米'),
]


def load16k(path):
    """读 wav 并统一成 16k、单声道、int16 小端字节"""
    w = wave.open(path, 'rb')
    sr, n, sw, ch = w.getframerate(), w.getnframes(), w.getsampwidth(), w.getnchannels()
    raw = w.readframes(n)
    w.close()
    if sw != 2:
        raise SystemExit('%s 不是 16bit 采样' % path)
    samples = memoryview(raw).cast('h')
    if ch > 1:
        samples = samples[::ch]
    if sr == RATE:
        return samples.tobytes()
    # 线性插值降/升采样，够测试用
    import numpy as np
    a = np.array(samples, dtype=np.float32) / 32768.0
    m = int(round(len(a) * RATE / sr))
    b = np.interp(np.linspace(0, len(a) - 1, m), np.arange(len(a)), a)
    return (b * 32767).astype(np.int16).tobytes()


def post(url, body=b''):
    req = urllib.request.Request(url, data=body, method='POST',
                                headers={'Content-Type': 'application/octet-stream'})
    with _OPENER.open(req, timeout=120) as r:
        return json.loads(r.read().decode('utf-8') or '{}')


def get(url):
    with _OPENER.open(url, timeout=60) as r:
        return json.loads(r.read().decode('utf-8') or '{}')


# 本机模型已知的同韵母混淆，nlp.js 的 ASR_FIX 会在语义层纠正。
# 这里单独列出来，是为了把"识别层"和"纠错层"的评价分开：识别错了就是错了，
# 只是这一条错不影响最终能不能执行对。
KNOWN_FIX = {'檬': '挪', '蒙': '挪', '萌': '挪', '朦': '挪', '猛': '挪', '梦': '挪'}


def nlp_fixed(t):
    """粗略模拟 nlp.js 的纠错，只看差异有没有被兜住"""
    return ''.join(KNOWN_FIX.get(c, c) for c in t)


def run_one(path, base):
    pcm = load16k(path)
    step = int(RATE * CHUNK_SEC) * 2
    j = post(base + '/asr/start')
    if not j.get('ok'):
        raise SystemExit('开不了会话：%s' % j)
    sid = j['sid']
    previews = []
    t0 = time.time()
    for i in range(0, len(pcm), step):
        r = post('%s/asr/chunk?sid=%s' % (base, sid), pcm[i:i + step])
        if r.get('text') or r.get('partial'):
            previews.append((r.get('text') or '') + (r.get('partial') or ''))
    fin = post('%s/asr/final?sid=%s' % (base, sid), b'')
    return fin.get('text', ''), time.time() - t0, previews, len(pcm) / 2.0 / RATE


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='http://127.0.0.1:8823')
    ap.add_argument('--only', default='', help='只跑名字里含这个子串的用例')
    args = ap.parse_args()
    base = args.base.rstrip('/')

    info = get(base + '/asr/health')
    print('引擎：%s   模型：%s' % (info.get('engine'), info.get('model')))
    if not info.get('ok'):
        raise SystemExit('识别服务不可用：%s' % info.get('err'))
    print()

    ok = 0
    soft = 0
    bad = []
    for name, want in CASES:
        if args.only and args.only not in name:
            continue
        p = os.path.join(ASRDIR, name)
        if not os.path.exists(p):
            print('%-20s 缺文件，跳过' % name)
            continue
        got, cost, prev, dur = run_one(p, base)
        good = got == want
        if good:
            ok += 1
        elif nlp_fixed(got) == want:
            soft += 1
        else:
            bad.append((name, want, got))
        mark = '✅' if good else ('⚠' if nlp_fixed(got) == want else '❌')
        print('%-20s %-5s %5.2fs音频 用时%5.2fs' % (name, mark, dur, cost))
        print('    期望 %s' % want)
        print('    识别 %s' % got)
        if not good and nlp_fixed(got) == want:
            print('    ↑ 识别层错 1 字，语义层 ASR_FIX 已纠正（可正常执行）')
        # 中间那版预览也打出来，方便看"边说边出字"是不是逐字长出来的
        if prev:
            print('    预览 %s' % prev[-1])
    print()
    total = len([1 for n, _ in CASES if not args.only or args.only in n])
    print('逐字正确 %d/%d，语义层兜底后 %d/%d' % (ok, total, ok + soft, total))
    for name, want, got in bad:
        print('  差在 %s：%s → %s' % (name, want, got))
    return 0 if ok + soft == total else 1


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
