const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = 'C:/Users/Administrator/WorkBuddy/2026-10-26-14-53-42/aibim/outputs/';

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1600, height: 950, deviceScaleFactor: 2 },
  });
  const p = await b.newPage();
  p.on('pageerror', e => console.log('PAGEERR', e.message));
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(1200);
  await p.type('#txt', '把空压机放到2楼202');
  await p.keyboard.press('Enter');
  await sleep(1000);
  const q = await p.evaluate(() => BIM.scene.project(9.9, 3.6, 4.5));
  await p.mouse.click(q.x, q.y);
  await sleep(1500);
  const lab = await p.evaluate(() => BIM.scene.project(9.9, 4.5, 3.6 + 1.2 + 0.95));
  console.log('label@', lab);
  await p.screenshot({ path: OUT + 'z1-label.png', clip: { x: Math.max(0, lab.x - 130), y: Math.max(0, lab.y - 60), width: 260, height: 130 } });
  await b.close();
  console.log('done');
})();
