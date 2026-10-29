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
  const info = await p.evaluate(() => {
    BIM.scene.setFocus(2);
    const f = BIM.scene.floorOf(2);
    f.mats.duct.color.set(0xff0000);
    f.mats.duct.map = null;
    f.mats.duct.needsUpdate = true;
    // 数一下第 2 层管段 mesh 的世界位置
    const out = [];
    BIM.scene.root().traverse(o => {
      if (o.userData && o.userData.kind === 'duct' && o.userData.floor === 2) {
        const d = o.userData.data;
        out.push([d.id, Math.round(d.a[2] * 100) / 100]);
      }
    });
    return out;
  });
  console.log('风管标高', JSON.stringify(info));
  await new Promise(r => setTimeout(r, 1500));
  await p.screenshot({ path: OUT + 'dbg-red.png' });
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
