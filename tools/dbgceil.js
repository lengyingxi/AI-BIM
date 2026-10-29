const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = 'C:/Users/Administrator/WorkBuddy/2026-10-26-14-53-42/aibim/outputs/';
(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'shell',
    args: ['--use-angle=swiftshader', '--no-sandbox', '--window-size=1440,900'],
    defaultViewport: { width: 1440, height: 900 } });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  await p.goto('http://127.0.0.1:8823/', { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => window.BIM && BIM.detail, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 1600));
  await p.evaluate(() => BIM.scene.setFocus(2));
  await new Promise(r => setTimeout(r, 1400));
  const st = await p.evaluate(() => {
    const f = BIM.scene.floorOf(2);
    return { op: f.mats.ceil.opacity, tr: f.mats.ceil.transparent, dw: f.mats.ceil.depthWrite,
      cam: [BIM.scene.camera().position.x.toFixed(1), BIM.scene.camera().position.y.toFixed(1), BIM.scene.camera().position.z.toFixed(1)] };
  });
  console.log('吊顶', JSON.stringify(st));
  await p.screenshot({ path: OUT + 'dbg-ceil-on.png' });
  await p.evaluate(() => BIM.detail.setCeiling(false));
  await new Promise(r => setTimeout(r, 1000));
  await p.screenshot({ path: OUT + 'dbg-ceil-off.png' });
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
