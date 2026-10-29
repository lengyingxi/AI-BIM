const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'shell',
    args: ['--use-angle=swiftshader', '--no-sandbox', '--window-size=1440,900'],
    defaultViewport: { width: 1440, height: 900 } });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  p.on('pageerror', e => console.log('PAGEERR', e.message));
  p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('CONSOLE', m.type(), m.text().slice(0, 300)); });
  await p.goto('http://127.0.0.1:8823/', { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => window.BIM && BIM.detail, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));
  const r = await p.evaluate(() => {
    const S = BIM.scene;
    S.setFocus(2, false);
    S.setCam(34, 15, 4, 15, 5.4, -7.4);
    const out = { list: [], matOk: null, hasColorAttr: null };
    let first = null;
    S.root().traverse(o => {
      if (o.userData && o.userData.kind === 'duct' && o.userData.floor === 2 && !first) first = o;
    });
    if (first) {
      out.matOk = {
        type: first.material.type, vc: first.material.vertexColors,
        color: first.material.color.getHexString(),
        hasColor: !!first.geometry.attributes.color,
        count: first.geometry.attributes.position.count,
        visible: first.visible, parentVis: first.parent.visible
      };
      // 投影首段两端
      const d = first.userData.data;
      const a = S.project(d.a[0], d.a[1], d.a[2]);
      const c = S.project(d.b[0], d.b[1], d.b[2]);
      out.list.push({ id: d.id, a: [Math.round(a.x), Math.round(a.y)], b: [Math.round(c.x), Math.round(c.y)] });
    }
    out.tris = 0;
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
