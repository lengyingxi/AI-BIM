# -*- coding: utf-8 -*-
"""生成中文测试语音 + 直接测 vosk 识别（不出网）

用法：
    python tools/asrtest.py --say "把空调放到一零一房间靠墙"
    python tools/asrtest.py --wav tools/asr/test.wav
"""
import argparse
import json
import os
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, 'asr', 'vosk-model-small-cn-0.22')


def say(text, out):
    """用系统 SAPI 合成 16bit 单声道 wav"""
    import pyttsx3
    e = pyttsx3.init()
    for v in e.getProperty('voices'):
        if 'chinese' in (v.name or '').lower() or 'zh' in (v.id or '').lower() or 'huihui' in (v.name or '').lower():
            e.setProperty('voice', v.id)
            break
    e.setProperty('rate', 165)
    e.save_to_file(text, out)
    e.runAndWait()
    return out


def to16k(wav_path):
    """读任意 wav → 16k 单声道 s16 的 bytes"""
    with wave.open(wav_path, 'rb') as w:
        ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if sw != 2:
        raise SystemExit('只支持 16bit wav，当前 %d bit' % (sw * 8))
    import array
    a = array.array('h')
    a.frombytes(raw)
    if ch == 2:
        a = array.array('h', [int((a[i] + a[i + 1]) / 2) for i in range(0, len(a) - 1, 2)])
    if sr == 16000:
        return a.tobytes(), sr
    # 简单线性插值降采样
    ratio = sr / 16000.0
    out = array.array('h')
    pos = 0.0
    while pos < len(a) - 1:
        i = int(pos)
        f = pos - i
        out.append(int(a[i] * (1 - f) + a[i + 1] * f))
        pos += ratio
    return out.tobytes(), 16000


def run(pcm):
    import vosk
    vosk.SetLogLevel(-1)
    m = vosk.Model(MODEL)
    rec = vosk.KaldiRecognizer(m, 16000)
    step = 16000 * 2 * 4000       # 4 秒一段
    hits = []
    for i in range(0, len(pcm), step):
        if rec.AcceptWaveform(pcm[i:i + step]):
            hits.append(json.loads(rec.Result()).get('text', ''))
    hits.append(json.loads(rec.FinalResult()).get('text', ''))
    return ' '.join(h for h in hits if h).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--say', default='')
    ap.add_argument('--wav', default='')
    ap.add_argument('--out', default=os.path.join(HERE, 'asr', 'test.wav'))
    a = ap.parse_args()
    wav = a.wav or say(a.say or '把空调放到一零一房间靠墙', a.out)
    pcm, sr = to16k(wav)
    print('wav=%s  %d Hz  %.2f 秒' % (os.path.basename(wav), sr, len(pcm) / 2 / 16000))
    print('识别：%s' % (run(pcm) or '(空)'))


if __name__ == '__main__':
    main()
