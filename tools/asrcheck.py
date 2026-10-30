"""离线语音自检：用 tools/asr 里的测试音频走一遍 /asr/transcribe，确认能出字。

为什么需要它：
    语音不通时的表现非常隐蔽 —— 页面一直转圈、接口不报错、耗时 0ms、
    结果是空字符串。最常见的原因是环境里缺 numpy（sherpa-onnx 2.x 不再带它），
    喂给 accept_waveform 的数据是空的。这个脚本能在 5 秒内把这类问题定位出来。

用法：
    先起服务（不带 --no-asr），再跑：
        python tools/asrcheck.py
        SITE=http://127.0.0.1:8823 python tools/asrcheck.py
"""
import wave, glob, json, urllib.request, struct, sys, os

BASE = os.environ.get('SITE', 'http://127.0.0.1:8899')


def post(path, data=b''):
    req = urllib.request.Request(BASE + path, data=data, method='POST')
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode('utf-8'))


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.loads(r.read().decode('utf-8'))


def wav_info(f):
    w = wave.open(f)
    i = (w.getnchannels(), w.getframerate(), w.getsampwidth(), w.getnframes())
    w.close()
    return i


def to_16k_mono_pcm(f):
    """只用标准库做最简单的处理：已经是 16k/mono/16bit 就直接返回，否则报出来"""
    w = wave.open(f)
    ch, sr, sw, n = w.getnchannels(), w.getframerate(), w.getsampwidth(), w.getnframes()
    raw = w.readframes(n)
    w.close()
    if ch == 1 and sr == 16000 and sw == 2:
        return raw, None
    if sw != 2:
        return None, 'bit width %d' % (sw * 8)
    frames = [raw[i:i + 2 * ch] for i in range(0, len(raw), 2 * ch)]
    if ch > 1:                       # 取第一声道
        frames = [fr[:2] for fr in frames]
    pcm = b''.join(frames)
    if sr != 16000:                  # 线性插值重采样
        ratio = sr / 16000.0
        vals = struct.unpack('<%dh' % (len(pcm) // 2), pcm)
        outn = int(len(vals) / ratio)
        out = []
        for i in range(outn):
            x = i * ratio
            i0 = int(x)
            i1 = min(i0 + 1, len(vals) - 1)
            fr = x - i0
            out.append(int(vals[i0] * (1 - fr) + vals[i1] * fr))
        pcm = struct.pack('<%dh' % len(out), *out)
    return pcm, None


def main():
    print('引擎:', json.dumps(get('/asr/warm'), ensure_ascii=False))
    files = sorted(glob.glob('tools/asr/*.wav'))
    print('测试音频 %d 个' % len(files))
    for f in files:
        ch, sr, sw, n = wav_info(f)
        pcm, err = to_16k_mono_pcm(f)
        if not pcm:
            print('  %-28s 跳过（%s）' % (os.path.basename(f), err))
            continue
        r = post('/asr/transcribe', pcm)
        print('  %-28s %5.2fs  %s  →  %s' % (
            os.path.basename(f), n / float(sr), '%dms' % r.get('ms', 0), r.get('text', '')))


if __name__ == '__main__':
    main()
