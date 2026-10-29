const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1600, height: 950 },
  });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('c:' + m.text()); });
  const client = await p.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: 'C:/Users/Administrator/WorkBuddy/2026-10-26-14-53-42/aibim/outputs/dl' });
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(1200);
  await p.type('#txt', '把空压机放到2楼202'); await p.keyboard.press('Enter'); await sleep(900);
  const q = await p.evaluate(() => BIM.scene.project(9.9, 3.6, 4.5));
  await p.mouse.click(q.x, q.y); await sleep(1400);
  // 计算书
  await p.evaluate(() => document.querySelectorAll('#toolbar button')[0].click()); await sleep(600);
  await p.evaluate(() => document.getElementById('calcDl').click()); await sleep(1200);
  // IFC
  await p.evaluate(() => document.querySelectorAll('#toolbar button')[5].click()); await sleep(1500);
  console.log('errs', errs);
  await b.close();
})();
