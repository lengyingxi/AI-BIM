/* 诊断：静音 1.4 秒为什么没把话发出去 */
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = 'http://127.0.0.1:8823';

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    defaultViewport: { width: 1400, height: 900 },
  });
  await b.defaultBrowserContext().overridePermissions(SITE, ['microphone']);
  const p = await b.newPage();
  p.on('pageerror', e => console.log('pageerror:', e.message));

  await p.evaluateOnNewDocument(() => {
    window.__sr = { inst: null };
    class FakeSR {
      constructor() { this.continuous = false; this.interimResults = false; window.__sr.inst = this; }
      start() { this.onstart && this.onstart(); }
      stop() { this.onend && this.onend(); }
      abort() { this.onend && this.onend(); }
      emit(text, isFinal) {
        const r = [{ transcript: text }];
        r.isFinal = !!isFinal;
        this.onresult && this.onresult({ resultIndex: 0, results: [r] });
      }
      fire(err) { this.onerror && this.onerror({ error: err }); }
    }
    window.SpeechRecognition = FakeSR;
    window.webkitSpeechRecognition = FakeSR;
    window.__forceAsr = 'web';
  });

  await p.goto(SITE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => localStorage.clear());
  await p.goto(SITE + '/index.html', { waitUntil: 'networkidle2' });
  await sleep(2500);

  let barOn = await p.evaluate(() => !document.getElementById('listenBar').hidden);
  if (!barOn) {
    await p.evaluate(() => document.getElementById('btnMic').click());
    for (let i = 0; i < 24; i++) { await sleep(250); barOn = await p.evaluate(() => !document.getElementById('listenBar').hidden); if (barOn) break; }
  }
  console.log('聆听已开:', barOn);

  const base = await p.evaluate(() => document.querySelectorAll('.msg.ai:not(.typing)').length);
  console.log('初始 ai 条数:', base);

  // 打点：看 armVoice / commitVoice 到底有没有被调用
  await p.evaluate(() => {
    window.__sr.inst.emit('把空压机放到2楼202靠墙', false);
  });

  for (let i = 1; i <= 16; i++) {
    await sleep(250);
    const st = await p.evaluate(() => ({
      txt: document.getElementById('txt').value,
      bar: document.getElementById('listenTxt').textContent,
      state: document.getElementById('listenState').textContent,
      ai: document.querySelectorAll('.msg.ai:not(.typing)').length,
      voice: BIM.app.voice.state()
    }));
    console.log((i * 250) + 'ms', JSON.stringify(st));
    if (st.ai > base) { console.log('→ 已发出'); break; }
  }

  await b.close();
})();
