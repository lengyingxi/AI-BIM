const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'shell',
    args: ['--use-angle=swiftshader', '--no-sandbox', '--window-size=1280,860'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1280, height: 860 });
  p.on('pageerror', e => console.log('PAGEERR', e.message));
  await p.goto('http://127.0.0.1:8823/', { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => window.BIM && BIM.detail, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));
  await p.evaluate(() => { BIM.scene.setFocus(2, false); BIM.detail.setFlow(true); });
  await new Promise(r => setTimeout(r, 1200));
  const r = await p.evaluate(() => {
    let fm = null;
    BIM.scene.root().traverse(o => { if (o.isInstancedMesh) fm = o; });
    const m = new THREE.Matrix4(), v = new THREE.Vector3();
    const arr = [];
    for (let i = 0; i < Math.min(4, fm.count); i++) {
      fm.getMatrixAt(i, m); v.setFromMatrixPosition(m);
      arr.push([+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)]);
    }
    return { n: fm.count, arr, on: BIM.detail.on.flow, ver: fm.instanceMatrix.version };
  });
  console.log(JSON.stringify(r));
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
