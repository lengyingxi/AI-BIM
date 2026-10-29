/* 出图：语音聆听条（带预览与"说完"）+ 工具调用挪动效果 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = path.join(__dirname, '..', 'outputs') + '/';
const SITE = 'http://127.0.0.1:8823';

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    defaultViewport: { width: 1600, height: 950 },
  });
  await b.defaultBrowserContext().overridePermissions(SITE, ['microphone']);
  const p = await b.newPage();
  await p.evaluateOnNewDocument(() => {
    window.__sr = { inst: null };
    class FakeSR {
      constructor() { window.__sr.inst = this; }
      start() { this.onstart && this.onstart(); }
      stop() { this.onend && this.onend(); }
      abort() { this.onend && this.onend(); }
      emit(text) {
        const r = [{ transcript: text }]; r.isFinal = false;
        this.onresult && this.onresult({ resultIndex: 0, results: [r] });
      }
    }
    window.SpeechRecognition = FakeSR;
    window.webkitSpeechRecognition = FakeSR;
  });
  await p.goto(SITE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => localStorage.clear());
  await p.goto(SITE + '/index.html', { waitUntil: 'networkidle2' });
  await sleep(2500);

  const say = async t => {
    const n = await p.evaluate(() => document.querySelectorAll('.msg.ai:not(.typing)').length);
    await p.type('#txt', t); await p.keyboard.press('Enter');
    for (let i = 0; i < 200; i++) {
      await sleep(250);
      const st = await p.evaluate(() => ({ n: document.querySelectorAll('.msg.ai:not(.typing)').length, ty: !!document.querySelector('.msg.ai.typing') }));
      if (!st.ty && st.n > n) break;
    }
    await sleep(700);
  };

  // 1) 语音聆听中：预览 + 说完
  let on = await p.evaluate(() => !document.getElementById('listenBar').hidden);
  if (!on) { await p.evaluate(() => document.getElementById('btnMic').click()); await sleep(900); }
  await p.evaluate(() => window.__sr.inst.emit('把空压机放到2楼202靠里'));
  await sleep(400);
  const box = await p.evaluate(() => {
    const b = document.getElementById('listenBar').getBoundingClientRect();
    const inp = document.querySelector('.input-wrap').getBoundingClientRect();
    return { x: 0, y: Math.max(0, inp.y - 10), width: Math.max(inp.right, b.right) + 10, height: b.bottom - inp.top + 22 };
  });
  await p.screenshot({ path: OUT + 'voice-1-listen.png', clip: box });

  // 2) 落地 + 相对挪动
  await p.evaluate(() => document.getElementById('btnVoiceDone').click());
  for (let i = 0; i < 60; i++) { await sleep(250); if (await p.evaluate(() => !document.querySelector('.msg.ai.typing'))) break; }
  await sleep(600);
  await say('往里挪半米');
  await say('再往左挪一点');
  await p.screenshot({ path: OUT + 'voice-2-flow.png' });

  // 3) 设置面板里的工具清单
  await p.evaluate(() => document.getElementById('btnAI').click());
  await sleep(500);
  await p.screenshot({ path: OUT + 'voice-3-tools.png' });
  console.log('ok');
  await b.close();
})();
