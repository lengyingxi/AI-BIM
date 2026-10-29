const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
(async () => {
  const b = await puppeteer.launch({
    executablePath: EDGE, headless: 'shell',
    args: ['--use-angle=swiftshader', '--no-sandbox', '--window-size=1280,860']
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1280, height: 860 });
  await p.goto('http://127.0.0.1:8823/', { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => window.BIM && BIM.detail, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 1800));
  const r = await p.evaluate(() => {
    const S = BIM.scene;
    S.setFocus(2, false);
    const out = { ducts: [], ceilOp: null, groupVis: null };
    let dg = null;
    S.root().traverse(o => {
      if (o.userData && o.userData.kind === 'duct' && o.userData.floor === 2) {
        out.ducts.push({
          id: o.userData.data.id, vis: o.visible,
          pv: o.parent ? o.parent.visible : null,
          pos: [o.position.x.toFixed(2), o.position.y.toFixed(2), o.position.z.toFixed(2)],
          bs: o.geometry.boundingSphere ? o.geometry.boundingSphere.radius.toFixed(2) : null,
          cnt: o.geometry.attributes.position.count
        });
      }
      if (o.userData && o.userData.ducts && !dg) dg = o;
    });
    out.groupVis = dg ? dg.userData.ducts.visible : 'no-group';
    const f = S.floorOf(2);
    out.ceilOp = [f.mats.ceil.opacity, f.mats.ceil.transparent, f.mats.ceil.depthWrite];
    out.cam = [S.camera().position.x.toFixed(1), S.camera().position.y.toFixed(1), S.camera().position.z.toFixed(1)];
    return out;
  });
  console.log(JSON.stringify(r, null, 1).slice(0, 2500));
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
