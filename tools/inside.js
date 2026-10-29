/* 室内近景：把镜头放进房间，看吊顶 / 家具 / 管线 / 流向到底长什么样 */
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

  // 找一间有风管穿过的房间
  const room = await p.evaluate(() => {
    const M = BIM_MODEL;
    const idx = BIM.routes.index(M);
    const r = M.rooms.filter(x => x.floor === 2 && x.zone !== 'corr' && (idx.roomDucts[x.id] || []).length)[0];
    return r ? { num: r.num, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, elev: r.elev } : null;
  });
  console.log('房间', JSON.stringify(room));

  const shot = async (name, fn) => {
    await p.evaluate(fn, room);
    await new Promise(r => setTimeout(r, 1000));
    await p.screenshot({ path: OUT + name + tag + '.png' });
  };

  await shot('in-ceil', r => {
    BIM.scene.setFocus(2, false);
    BIM.scene.setCam(r.x1 - .8, r.elev + 1.62, -(r.y1 - .8), r.x0 + .6, r.elev + 2.0, -(r.y0 + .6));
  });

  await shot('in-noceil', r => {
    BIM.detail.setCeiling(false);
    BIM.scene.setCam(r.x1 - .8, r.elev + 1.62, -(r.y1 - .8), r.x0 + .6, r.elev + 2.0, -(r.y0 + .6));
  });

  await shot('in-flow', r => {
    BIM.scene.setFlow(true);
    BIM.scene.setCam(r.x1 - .8, r.elev + 1.5, -(r.y1 - .8), r.x0 + .6, r.elev + 2.2, -(r.y0 + .6));
  });

  await shot('in-duct', r => {
    BIM.detail.setFurniture(false);
    BIM.scene.setCam(r.x1 - .7, r.elev + 2.3, -(r.y1 - .7), r.x0 + .5, r.elev + 2.45, -(r.y0 + .5));
  });

  console.log('报错：', errs.length ? errs.join(' | ') : '无');
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
