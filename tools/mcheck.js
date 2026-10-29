const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    defaultViewport: { width: 1600, height: 950 },
  });
  const c = b.defaultBrowserContext();
  await c.overridePermissions('http://127.0.0.1:8823', ['microphone']);
  const p = await b.newPage();
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(1500);
  const m = await p.evaluate(() => {
    const g = s => { const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom), Math.round(r.height)]; };
    return { side: g('.side'), chat: g('.chat'), ctx: g('.ctxbar'), comp: g('.composer'), listen: g('#listenBar'), win: innerHeight };
  });
  console.log(JSON.stringify(m));
  await b.close();
})();
