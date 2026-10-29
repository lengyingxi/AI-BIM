const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = 'C:/Users/Administrator/WorkBuddy/2026-10-26-14-53-42/aibim/outputs/';
(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'shell',
    args: ['--use-angle=swiftshader', '--no-sandbox', '--window-size=1280,860'],
    defaultViewport: { width: 1280, height: 860 } });
  const p = await b.newPage();
  await p.setViewport({ width: 1280, height: 860 });
  p.on('pageerror', e => console.log('PAGEERR', e.message));
  await p.goto('http://127.0.0.1:8823/', { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => window.BIM && BIM.detail, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 1600));
  await p.evaluate(() => {
    BIM.scene.setFocus(2, false);
    BIM.detail.setCeiling(false);
    BIM.detail.setFurniture(false);
    BIM.scene.setCam(9, 5.6, -3.0, 9.9, 6.85, -5.6);
    BIM.scene.setFlow(true);
  });
  await new Promise(r => setTimeout(r, 1500));
  const r = await p.evaluate(() => {
    const st = BIM.detail.flowState();
    let grp = null;
    BIM.scene.root().traverse(o => { if (o.name === 'flow') grp = o; });
    const kids = grp ? grp.children.map(c => ({ n: c.count, v: c.visible, c: c.material.color.getHexString() })) : null;
    return { st, kids };
  });
  console.log(JSON.stringify(r));
  await p.screenshot({ path: OUT + 'dbg-arrow.png' });
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
