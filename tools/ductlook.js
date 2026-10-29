/* 对准一根风管看：确认法兰/支吊架/风口/流向真的画出来了 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = 'C:/Users/Administrator/WorkBuddy/2026-10-26-14-53-42/aibim/outputs/';
const tag = process.argv[2] || '';

(async () => {
  const b = await puppeteer.launch({
    executablePath: EDGE, headless: 'shell',
    args: ['--use-angle=swiftshader', '--no-sandbox', '--window-size=1280,860']
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1280, height: 860 });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8823/', { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => window.BIM && BIM.detail, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 1800));

  const info = await p.evaluate(() => {
    BIM.scene.setFocus(2, false);
    BIM.detail.setCeiling(false);
    BIM.detail.setFurniture(false);
    const M = BIM_MODEL;
    const d = M.ducts.filter(x => x.floor === 2 && x.w > .6)[1] || M.ducts.filter(x => x.floor === 2)[1];
    const mx = (d.a[0] + d.b[0]) / 2, my = (d.a[1] + d.b[1]) / 2, mz = d.a[2];
    // 站在走廊里，顺着走廊看这根主管
    BIM.scene.setCam(mx - 7, 4.5 + 1.55, -my, mx + 3, mz - .05, -my);
    let mesh = null;
    BIM.scene.root().traverse(o => { if (o.userData.kind === 'duct' && o.userData.data.id === d.id) mesh = o; });
    return {
      id: d.id, a: d.a, b: d.b, len: Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]).toFixed(2),
      verts: mesh ? mesh.geometry.attributes.position.count : -1,
      vis: mesh ? mesh.visible : null,
      cam: [mx - 4, mz + .55, -(my - 2.2)]
    };
  });
  console.log('风管', JSON.stringify(info));
  await new Promise(r => setTimeout(r, 1200));
  await p.screenshot({ path: OUT + 'duct-close' + tag + '.png' });

  await p.evaluate(() => BIM.scene.setFlow(true));
  await new Promise(r => setTimeout(r, 1600));
  await p.screenshot({ path: OUT + 'duct-flow' + tag + '.png' });
  console.log('报错：', errs.length ? errs.join(' | ') : '无');
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
