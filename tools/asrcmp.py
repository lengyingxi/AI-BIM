#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
两个离线引擎的横向对比：vosk(Kaldi 小模型) vs sherpa-onnx(流式 zipformer)。

做法：用系统 TTS 把同一批运维口令合成 16k 单声道 wav（本地生成，不出网），
再把同一段音频分别喂给两个引擎，算逐句是否全对 + 字错率（CER）。

用法：
    python tools/asrcmp.py              # 合成（已有就复用）+ 对比
    python tools/asrcmp.py --regen      # 强制重新合成
    python tools/asrcmp.py --only 阀门   # 只跑含该词的行

TTS 音频比真实麦克风干净，分数会偏乐观——它的用途是横向比两个引擎的高下，
绝对值参考 tools/asrselftest.py（真实录音那 6 句）。
"""
import argparse
import difflib
import os
import sys
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASRDIR = os.path.join(ROOT, 'tools', 'asr')
GENDIR = os.path.join(ASRDIR, 'gen')
SHERPA_DIR = os.path.join(ASRDIR, 'mzh')
VOSK_DIR = os.path.join(ASRDIR, 'vosk-model-small-cn-0.22')

PHRASES = [
    '把空调放到一零一房间靠墙',
    '把空调往东挪半米',
    '把这个设备往左挪一点',
    '在三百零二房间放一台服务器机柜',
    '把消防水泵放到二楼二零一靠里',
    '关掉四楼四零五的阀门',
    '在三百零六靠走廊的墙上开一个一米五的门',
    '把那台离心机挪到墙角',
    '把设备换成空气压缩机',
    '关掉这个阀门会影响哪些房间',
    '在四零一开一个两米宽的窗户',
    '把机柜往右挪三十公分',
]


# ---------------------------------------------------------------- TTS 语料
def synth(text, out):
    """用 Windows SAPI 合成 16bit 单声道 wav"""
    import pyttsx3
    e = pyttsx3.init()
    for v in e.getProperty('voices'):
        n = (v.name or '').lower()
        i = (v.id or '').lower()
        if 'chinese' in n or 'zh' in i or 'huihui' in n or 'kangkang' in n:
            e.setProperty('voice', v.id)
            break
    e.setProperty('rate', 165)
    e.save_to_file(text, out)
    e.runAndWait()
    return out


def load16k(path):
    w = wave.open(path, 'rb')
    sr, n, sw, ch = w.getframerate(), w.getnframes(), w.getsampwidth(), w.getnchannels()
    raw = w.readframes(n)
    w.close()
    a = memoryview(raw).cast('h')
    if ch > 1:
        a = a[::ch]
    if sr == 16000:
        return a.tobytes()
    import numpy as np
    x = np.array(a, dtype=np.float32) / 32768.0
    m = int(round(len(x) * 16000.0 / sr))
    y = np.interp(np.linspace(0, len(x) - 1, m), np.arange(len(x)), x)
    return (y * 32767).astype(np.int16).tobytes()


# ---------------------------------------------------------------- 两个引擎
class Sherpa(object):
    name = 'sherpa-onnx zipformer'

    def __init__(self):
        import sherpa_onnx
        self.rec = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=os.path.join(SHERPA_DIR, 'tokens.txt'),
            encoder=self._pick('encoder'),
            decoder=self._pick('decoder'),
            joiner=self._pick('joiner'),
            num_threads=2, sample_rate=16000, feature_dim=80,
            decoding_method='greedy_search', provider='cpu')

    def _pick(self, key):
        for f in sorted(os.listdir(SHERPA_DIR)):
            if f.startswith(key) and f.endswith('.onnx') and '.int8.' in f:
                return os.path.join(SHERPA_DIR, f)
        raise SystemExit('缺 %s onnx' % key)

    def run(self, pcm):
        import numpy as np
        a = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        st = self.rec.create_stream()
        st.accept_waveform(16000, a)
        st.input_finished()
        while self.rec.is_ready(st):
            self.rec.decode_stream(st)
        return self.rec.get_result(st).replace(' ', '')


class Vosk(object):
    name = 'vosk small-cn'

    def __init__(self):
        import vosk
        vosk.SetLogLevel(-1)
        self.m = vosk.Model(VOSK_DIR)

    def run(self, pcm):
        import json
        import vosk
        r = vosk.KaldiRecognizer(self.m, 16000)
        r.AcceptWaveform(pcm)
        return json.loads(r.FinalResult()).get('text', '').replace(' ', '')


def cer(ref, hyp):
    """字错率：编辑距离 / 参考长度"""
    if not ref:
        return 0.0 if not hyp else 1.0
    sm = difflib.SequenceMatcher(None, ref, hyp)
    same = sum(b.size for b in sm.get_matching_blocks())
    return 1.0 - same / float(len(ref))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--regen', action='store_true')
    ap.add_argument('--only', default='')
    args = ap.parse_args()

    if not os.path.isdir(GENDIR):
        os.makedirs(GENDIR)

    items = []
    for i, text in enumerate(PHRASES):
        if args.only and args.only not in text:
            continue
        p = os.path.join(GENDIR, 'g%02d.wav' % i)
        if args.regen or not os.path.exists(p):
            synth(text, p)
        items.append((text, p))

    engines = [e for e in (Sherpa(), Vosk()) if True]
    print('引擎：' + '　vs　'.join(e.name for e in engines))
    print('语料：%d 句（TTS 合成，仅用于横向对比）' % len(items))
    print()
    rows = []
    for text, p in items:
        pcm = load16k(p)
        got = [e.run(pcm) for e in engines]
        rows.append((text, got))

    head = '%-30s' % '原话'
    for e in engines:
        head += ' | %-28s' % e.name
    print(head)
    print('-' * len(head.encode('gbk', 'ignore')))
    tot = [0.0] * len(engines)
    exact = [0] * len(engines)
    for text, got in rows:
        line = '%-30s' % text
        for k, g in enumerate(got):
            c = cer(text, g)
            tot[k] += c
            exact[k] += 1 if c == 0 else 0
            line += ' | %-28s' % (g if c == 0 else '%s  (CER %.0f%%)' % (g, c * 100))
        print(line)

    print()
    n = len(rows)
    for k, e in enumerate(engines):
        print('%-24s 全对 %2d/%d   平均字错率 %.1f%%' % (e.name, exact[k], n, tot[k] / n * 100))
    return 0


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
