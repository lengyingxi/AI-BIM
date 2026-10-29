/* 本轮交付图：模型树 / 构件属性 / 按需流向 / 碰撞也放 / 拓门校核 */
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
  await sleep(2600);

  const shot = async (n) => { await p.screenshot({ path: OUT + n + '.png' }); console.log('·', n); };

  /* 1 首屏：树默认打开，全楼 */
  await p.evaluate(() => { BIM.scene.setCam(44, 40, 34, 16.5, 8.0, -7.8); });
  await sleep(1400);
  await shot('v4-1-default');

  /* 2 树里点 202：定位 + 右侧属性 */
  await p.evaluate(async () => {
    BIM.tree.state.open['f2'] = true;
    BIM.tree.state.open['g:f2:room'] = true;
    BIM.tree.render();
    await new Promise(r => setTimeout(r, 200));
    const row = [...document.querySelectorAll('#treeBody .tn')].find(el => el.textContent.indexOf('202') === 0);
    if (row) row.click();
  });
  await sleep(1900);
  await shot('v4-2-room-props');

  /* 3 树展到结构 + 风管，点一根柱 */
  await p.evaluate(async () => {
    BIM.tree.state.open['g:f2:struct'] = true;
    BIM.tree.state.open['g:f2:col'] = true;
    BIM.tree.state.open['g:f2:mep'] = true;
    BIM.tree.state.open['g:f2:duct'] = true;
    BIM.tree.render();
    await new Promise(r => setTimeout(r, 200));
    const col = [...document.querySelectorAll('#treeBody .tn')].find(el => /^C-2-/.test(el.textContent));
    if (col) col.click();
  });
  await sleep(1800);
  await shot('v4-3-column');

  /* 4 问影响 → 流向 + 路由面板 */
  await p.evaluate(() => {
    document.getElementById('txt').value = '关闭4楼405的阀门会影响哪些房间';
    document.getElementById('btnSend').click();
  });
  await sleep(7000);
  await p.evaluate(() => { BIM.scene.setFocus(4); });
  await sleep(1600);
  const camInfo = await p.evaluate(() => {
    // 4F 风管主管在走廊（400）吊顶里 z=14.8；从南侧上空斜俯，避开上层楼板后能看到整条主管 + 支管 + 流向箭头
    const cor = BIM_MODEL.rooms.find(r => r.num === '400' && r.floor === 4);
    BIM.scene.setCam(cor.x1 - 4.0, 21.4, -(cor.y0 - 9.4),
                     cor.x0 + 11.0, 14.55, -(cor.y0 + 1.2));
    return { cor: cor.num };
  });
  console.log('   flow cam:', JSON.stringify(camInfo));
  await sleep(1600);
  await shot('v4-4-flow');

  /* 5 碰撞也放：设备压住工位一半，红框能露出来 */
  const clash = await p.evaluate(async () => {
    document.querySelector('#pTopo [data-close]').click();
    await new Promise(r => setTimeout(r, 400));
    const r = BIM_MODEL.rooms.find(x => x.num === '201');
    const fr = BIM.detail.furnRects['201'] || [];
    const desk = fr.find(f => f.label === '工位');
    const dev = BIM_MODEL.equipmentLibrary.find(d => /压缩/.test(d.name));
    BIM.scene.setFocus(2, false);
    const cx = desk.x + 0.55, cy = desk.y + 0.1;
    const ob = BIM.calc.obstruct({ room: r, equip: dev, cx, cy, others: [] });
    BIM.app.state.pending = { device: dev, room: r, pref: null };
    BIM.app.placeAt(r, dev, cx, cy, ob);
    await new Promise(res => setTimeout(res, 700));
    BIM.scene.setCam(r.x0 - 1.6, r.elev + 7.4, -(r.y0 - 1.2), r.x0 + 3.0, r.elev + .5, -(r.y0 + 2.6));
    return { blocks: ob.blocks.map(x => x.t) };
  });
  console.log('   clash:', JSON.stringify(clash, null, 0));
  await sleep(1700);
  await shot('v4-5-collision');

  /* 6 拓门：设备搬不进 → 拓到 1.65 米 → 校核通过 */
  const wd = await p.evaluate(async () => {
    const r = BIM_MODEL.rooms.find(x => x.num === '203');
    const dev = BIM_MODEL.equipmentLibrary.find(d => /柴油/.test(d.name));
    BIM.scene.setFocus(2, false);
    const ob = BIM.calc.obstruct({ room: r, equip: dev, cx: (r.x0 + r.x1) / 2, cy: (r.y0 + r.y1) / 2, others: [] });
    BIM.app.state.pending = { device: dev, room: r, pref: null };
    BIM.app.placeAt(r, dev, (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, ob);
    await new Promise(res => setTimeout(res, 600));
    const pd = BIM.calc.passDoor({ room: r, equip: BIM.app.state.placed.slice(-1)[0] });
    const before = pd.door.w;
    BIM.app.widenDoor(r, pd.door, Math.max(pd.door.w, pd.needW), Math.max(pd.door.h, pd.needH));
    await new Promise(res => setTimeout(res, 800));
    const pd2 = BIM.calc.passDoor({ room: r, equip: BIM.app.state.placed.slice(-1)[0] });
    const pos = [pd2.door.pos[0], pd2.door.pos[1]];
    // 站屋里朝门看，能同时看到门洞变宽和屋里那台设备
    BIM.scene.setCam(pos[0] - 0.4, r.elev + 1.85, -(pos[1] - 3.4), pos[0], r.elev + 1.05, -pos[1]);
    return { before, after: pd2.door.w, pass: pd2.ok };
  });
  console.log('   door:', JSON.stringify(wd));
  await sleep(1500);
  await shot('v4-6-door');

  console.log('错误', errs.length ? errs : '无');
  await b.close();
})();
