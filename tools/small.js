const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    defaultViewport: { width: 1280, height: 720 },
  });
  const c = b.defaultBrowserContext();
  await c.overridePermissions('http://127.0.0.1:8823', ['microphone']);
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(1500);
  await p.type('#txt', '把空压机放到2楼202靠里'); await p.keyboard.press('Enter'); await sleep(1800);
  await p.type('#txt', '再放一台'); await p.keyboard.press('Enter'); await sleep(1600);
  const m = await p.evaluate(() => {
    const g = s => { const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom)]; };
    const chat = document.querySelector('.chat');
    return {
      chat: g('.chat'), ctx: g('.ctxbar'), comp: g('.composer'), listen: g('#listenBar'),
      chatScrollable: chat.scrollHeight > chat.clientHeight,
      overflowY: document.documentElement.scrollHeight > innerHeight,
      of: document.documentElement.scrollWidth > innerWidth,
      toolbar: (() => { const r = document.querySelector('.toolbar').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.bottom)]; })()
    };
  });
  console.log(JSON.stringify(m), 'errs', errs);
  await p.screenshot({ path: 'outputs/ui-5-small.png' });
  await b.close();
})();
