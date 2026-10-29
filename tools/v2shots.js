/* 出图：模型树 / 流向按需 / 碰撞描红 / 门拓宽 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = 'C:/Users/Administrator/WorkBuddy/2026-10-26-14-53-42/aibim/outputs/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({
    executablePath: EDGE, headless: 'shell',
    args: ['--use-angle=swiftshader', '--no-sandbox', '--window-size=1440,900'],
    defaultViewport: { width: 1440, height: 900 }
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8823/', { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => window.BIM && BIM.tree, { timeout: 30000 });
  await sleep(2400);

  /* 1 模型树点房间：树 + 属性 + 定位 */
  await p.evaluate(async () => {
    BIM.tree.open(true);
    BIM.tree.state.open['f2'] = true;
    BIM.tree.state.open['g:f2:room'] = true;
    BIM.tree.render();
    await new Promise(r => setTimeout(r, 200));
    const rows = [...document.querySelectorAll('#treeBody .tn')];
    const r = rows.find(el => el.textContent.indexOf('205') === 0);
    if (r) r.click();
  });
  await sleep(1800);
  await p.screenshot({ path: OUT + 'v3-1-tree-room.png' });
  console.log('· 1 model tree');

  /* 2 问影响 → 流向自动亮；相机给个能看见风管的角度 */
  await p.evaluate(async () => {
    document.getElementById('txt').value = '关闭4楼405的阀门会影响哪些房间';
    document.getElementById('btnSend').click();
  });
  await sleep(7000);
  await p.evaluate(() => {
    const r = BIM_MODEL.rooms.find(x => x.num === '405');
    BIM.scene.setCam(r.x0 - 6, r.elev + 9.5, -(r.y1 + 7), r.x0 + 3, r.elev + 1.2, -(r.y0 + 3));
  });
  await sleep(1400);
  await p.screenshot({ path: OUT + 'v3-2-flow-on.png' });
  console.log('· 2 flow on ask');

  /* 3 关掉影响面板 → 流向收回 */
  await p.evaluate(() => document.querySelector('#pTopo [data-close]').click());
  await sleep(1200);
  await p.screenshot({ path: OUT + 'v3-3-flow-off.png' });
  console.log('· 3 flow off after close');

  /* 4 压在工位上放设备 → 碰撞描红 */
  await p.evaluate(async () => {
    const r = BIM_MODEL.rooms.find(x => x.num === '201');
    const fr = BIM.detail.furnRects['201'] || [];
    const desk = fr.find(f => f.label === '工位');
    const dev = BIM_MODEL.equipmentLibrary.find(d => /压缩/.test(d.name));
    BIM.scene.setFocus(2, false);
    const ob = BIM.calc.obstruct({ room: r, equip: dev, cx: desk.x, cy: desk.y, others: [] });
    BIM.app.state.pending = { device: dev, room: r, pref: null };
    BIM.app.placeAt(r, dev, desk.x, desk.y, ob);
    await new Promise(res => setTimeout(res, 700));
    BIM.scene.setCam(r.x1 - 1.2, r.elev + 6.2, -(r.y1 - 1.2), r.x0 + 1.2, r.elev + .8, -(r.y0 + 1.2));
  });
  await sleep(1800);
  await p.screenshot({ path: OUT + 'v3-4-collision.png' });
  console.log('· 4 collision placed');

  /* 5 门不够宽 → 拓宽 → 校核 */
  const w = await p.evaluate(async () => {
    const r = BIM_MODEL.rooms.find(x => x.num === '202');
    const dev = BIM_MODEL.equipmentLibrary.find(d => /柴油/.test(d.name)) || BIM_MODEL.equipmentLibrary[0];
    BIM.scene.setFocus(2, false);
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2 - 1.6;
    const ob = BIM.calc.obstruct({ room: r, equip: dev, cx, cy, others: [] });
    BIM.app.state.pending = { device: dev, room: r, pref: null };
    BIM.app.placeAt(r, dev, cx, cy, ob);
    await new Promise(res => setTimeout(res, 600));
    const pd = BIM.calc.passDoor({ room: r, equip: BIM.app.state.placed.slice(-1)[0] });
    const before = pd.door.w;
    BIM.app.widenDoor(r, pd.door, Math.max(pd.door.w, pd.needW), Math.max(pd.door.h, pd.needH));
    await new Promise(res => setTimeout(res, 700));
    const pd2 = BIM.calc.passDoor({ room: r, equip: BIM.app.state.placed.slice(-1)[0] });
    const w2 = BIM_MODEL.walls.find(x => x.id === pd.door.wall);
    const sp = { x: pd.door.pos[0], y: pd.door.pos[1] };
    BIM.scene.setCam(sp.x + 3.5, r.elev + 3.2, -(sp.y + 3.5), sp.x, r.elev + 1.1, -sp.y);
    return { before, after: pd2.door.w, passNow: pd2.ok, door: pd2.door.name };
  });
  console.log('· 5 door widened', JSON.stringify(w));
  await sleep(1500);
  await p.screenshot({ path: OUT + 'v3-5-widen.png' });

  console.log('错误', errs.length ? errs : '无');
  await b.close();
})();
