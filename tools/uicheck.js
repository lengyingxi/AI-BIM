const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1600, height: 950, deviceScaleFactor: 2 },
  });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(1500);
  await p.screenshot({ path: 'outputs/ui-1-boot.png', clip: { x: 0, y: 0, width: 340, height: 950 } });
  await p.type('#txt', '把空压机放到2楼202靠里'); await p.keyboard.press('Enter'); await sleep(1800);
  await p.type('#txt', '再放一台'); await p.keyboard.press('Enter'); await sleep(1600);
  await p.screenshot({ path: 'outputs/ui-2-ctx.png', clip: { x: 0, y: 0, width: 340, height: 950 } });
  await p.evaluate(() => document.getElementById('btnAI').click());
  await sleep(400);
  await p.screenshot({ path: 'outputs/ui-3-ai.png' });
  const m = await p.evaluate(() => {
    const r = document.querySelector('.ctxbar').getBoundingClientRect();
    const c = document.querySelector('.composer').getBoundingClientRect();
    const panel = document.getElementById('pAI').getBoundingClientRect();
    return { ctx: [r.top, r.height], comp: [c.top, c.height], panel: [panel.left, panel.top, panel.width, panel.height], of: document.documentElement.scrollWidth > innerWidth };
  });
  console.log(JSON.stringify(m), 'errs', errs);
  await b.close();
})();
