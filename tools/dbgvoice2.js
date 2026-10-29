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
  p.on('pageerror', e => console.log('PAGEERR', e.message));
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
  await p.goto(SITE, { waitUntil: 'networkidle2' });
  await sleep(2000);
  console.log('mode', await p.evaluate(() => BIM.app.voice.mode()));
  await p.evaluate(() => document.getElementById('btnMic').click());
  await sleep(1200);
  console.log('after click', JSON.stringify(await p.evaluate(() => BIM.app.voice.state())));
  await p.evaluate(() => window.__sr.inst.emit('把空压机放到2楼202靠墙', false));
  for (let i = 0; i < 14; i++) {
    await sleep(600);
    const s = await p.evaluate(() => ({
      state: document.getElementById('listenState').textContent,
      txt: document.getElementById('txt').value,
      n: document.querySelectorAll('.msg.ai').length,
      v: BIM.app.voice.state()
    }));
    console.log(i, JSON.stringify(s));
    if (s.n > 2) break;
  }
  await b.close();
})();
