/* 本轮回归：模型树 / 工具栏居中 / 流向只在看影响时亮 / 碰撞也放 + 门拓宽 */
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
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.goto('http://127.0.0.1:8823/', { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => window.BIM && BIM.tree && BIM_MODEL, { timeout: 30000 });
  await sleep(2400);

  const log = (...a) => console.log(...a);

  /* 1) 顶部药丸没了、工具栏 4 个按钮且居中 */
  const ui = await p.evaluate(() => {
    const bar = document.getElementById('toolbar');
    const r = bar.getBoundingClientRect();
    const cv = document.getElementById('cv').getBoundingClientRect();
    return {
      pills: !!document.getElementById('floorPills'),
      btns: [...bar.querySelectorAll('button')].map(b => b.dataset.k + ':' + b.textContent.trim()),
      centerGap: Math.round((r.left + r.width / 2) - (cv.left + cv.width / 2)),
      treePanel: !!document.getElementById('pTree')
    };
  });
  log('UI 检查', JSON.stringify(ui));

  /* 2) 打开模型树，看层级和节点数 */
  const tree = await p.evaluate(() => {
    BIM.tree.open(true);
    const root = BIM.tree.root();
    const walk = (n, d) => {
      const o = { label: n.label, type: n.type, kids: (n.kids || []).length, depth: d };
      return o;
    };
    const f5 = root.kids[0];
    return {
      meta: document.getElementById('treeMeta').textContent,
      floors: root.kids.map(k => k.label + '(' + (k.cnt != null ? k.cnt : k.kids.length) + ')'),
      f5groups: f5.kids.map(k => k.label + ':' + (k.cnt != null ? k.cnt : '-')),
      firstRoom: f5.kids[0].kids[0].key + ' / ' + f5.kids[0].kids[0].label,
      roomGroups: f5.kids[0].kids[0].kids.map(g => g.label + ':' + (g.cnt != null ? g.cnt : (g.kids || []).length)),
      rows: document.querySelectorAll('#treeBody .tn').length
    };
  });
  log('树结构', JSON.stringify(tree, null, 2));

  await p.screenshot({ path: OUT + 'v2-1-tree.png' });

  /* 3) 展开一层楼，点一个构件，检查右侧属性 + 相机 */
  const click = await p.evaluate(async () => {
    const root = BIM.tree.root();
    const f2 = root.kids.find(k => k.label === '2F');
    BIM.tree.state.open['f2'] = true;
    BIM.tree.state.open['g:f2:room'] = true;
    BIM.tree.render();
    await new Promise(r => setTimeout(r, 300));
    // 找到 202 房间节点并点开
    const rows = [...document.querySelectorAll('#treeBody .tn')];
    const r202 = rows.find(el => el.textContent.indexOf('202') === 0);
    if (!r202) return { err: 'no 202' };
    r202.click();
    await new Promise(r => setTimeout(r, 900));
    return {
      clicked: r202.textContent.slice(0, 20),
      propsOpen: !document.getElementById('pProps').hidden,
      propsTitle: document.getElementById('propsTitle').textContent,
      propsText: document.getElementById('propsBody').innerText.replace(/\n+/g, ' | ').slice(0, 200),
      focus: BIM.scene.focus
    };
  });
  log('点房间 202', JSON.stringify(click));
  await sleep(900);
  await p.screenshot({ path: OUT + 'v2-2-room.png' });

  /* 4) 点具体构件（墙/门/窗）→ 属性 */
  const leaf = await p.evaluate(async () => {
    const rows = [...document.querySelectorAll('#treeBody .tn')];
    // 展开 202 的门分组
    const g = rows.find(el => el.textContent.indexOf('门') === 0);
    if (g) { g.click(); await new Promise(r => setTimeout(r, 400)); }
    const rows2 = [...document.querySelectorAll('#treeBody .tn')];
    const d = rows2.find(el => /^M\d/.test(el.textContent));
    if (!d) return { err: 'no door row', sample: rows2.slice(0, 12).map(x => x.textContent) };
    d.click();
    await new Promise(r => setTimeout(r, 900));
    return {
      clicked: d.textContent.trim(),
      title: document.getElementById('propsTitle').textContent,
      body: document.getElementById('propsBody').innerText.replace(/\n+/g, ' | ').slice(0, 220)
    };
  });
  log('点门构件', JSON.stringify(leaf));
  await sleep(600);
  await p.screenshot({ path: OUT + 'v2-3-door.png' });

  /* 5) 流向默认不亮；问影响才亮，关面板就收 */
  const flow = await p.evaluate(async () => {
    const before = !!(BIM.detail && BIM.detail.on.flow);
    document.getElementById('txt').value = '关闭4楼405的阀门会影响哪些房间';
    document.getElementById('btnSend').click();
    await new Promise(r => setTimeout(r, 9000));
    const on = !!(BIM.detail && BIM.detail.on.flow);
    const topo = !document.getElementById('pTopo').hidden;
    return { before, on, topo, focus: BIM.scene.focus, flowOn: BIM.app.state.flowOn };
  });
  log('流向', JSON.stringify(flow));
  await sleep(500);
  await p.screenshot({ path: OUT + 'v2-4-flow.png' });

  const flowOff = await p.evaluate(async () => {
    document.querySelector('#pTopo [data-close]').click();
    await new Promise(r => setTimeout(r, 400));
    return { on: !!(BIM.detail && BIM.detail.on.flow), flowOn: BIM.app.state.flowOn };
  });
  log('关面板后流向', JSON.stringify(flowOff));

  /* 6) 碰撞也放：往塞满家具的开放办公区放一台 */
  const clash = await p.evaluate(async () => {
    const rooms = BIM_MODEL.rooms;
    const r = rooms.find(x => x.num === '201') || rooms.find(x => x.use === '开放办公区');
    const dev = BIM_MODEL.equipmentLibrary.find(d => /压缩/.test(d.name)) || BIM_MODEL.equipmentLibrary[0];
    // 直接调用放置：模拟"点在房间正中（桌位上）"
    const S = BIM.scene;
    S.setFocus(r.floor, false);
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
    const ob = BIM.calc.obstruct({ room: r, equip: dev, cx, cy, others: [] });
    BIM.app.state.pending = { device: dev, room: r, pref: null };
    BIM.app.state.mode = 'place';
    const eq = BIM.app.placeAt(r, dev, cx, cy, ob);
    await new Promise(res => setTimeout(res, 800));
    return {
      room: r.num, obstacles: ob.blocks.length, hitKinds: (ob.hits || []).map(h => h.kind),
      placed: !!eq, placedCount: BIM.app.state.placed.length,
      lastMsg: [...document.querySelectorAll('.msg.ai p')].slice(-2).map(x => x.innerText.slice(0, 160))
    };
  });
  log('碰撞放置', JSON.stringify(clash, null, 2));
  await sleep(600);
  await p.screenshot({ path: OUT + 'v2-5-clash.png' });

  /* 7) 门不够宽 → 问拓宽 → 拓宽 + 校核 */
  const door = await p.evaluate(async () => {
    const r = BIM_MODEL.rooms.find(x => x.num === '205') || BIM_MODEL.rooms.find(x => /机房/.test(x.use));
    const eq = BIM.app.state.placed.slice(-1)[0];
    const pd = BIM.calc.passDoor({ room: r, equip: eq });
    return { room: r.num, need: [pd.needW, pd.needH], door: pd.door ? [pd.door.name, pd.door.w, pd.door.h] : null, ok: pd.ok, why: pd.why };
  });
  log('门通过性', JSON.stringify(door));

  const widenRes = await p.evaluate(async () => {
    const r = BIM_MODEL.rooms.find(x => x.num === '205') || BIM_MODEL.rooms.find(x => /机房/.test(x.use));
    const eq = BIM.app.state.placed.slice(-1)[0];
    const pd = BIM.calc.passDoor({ room: r, equip: eq });
    if (!pd.door) return { err: 'no door' };
    const before = { w: pd.door.w, h: pd.door.h, id: pd.door.id };
    const ok = BIM.app.widenDoor(r, pd.door, Math.max(pd.door.w, pd.needW), Math.max(pd.door.h, pd.needH));
    await new Promise(res => setTimeout(res, 700));
    const pd2 = BIM.calc.passDoor({ room: r, equip: eq });
    return {
      ok, before, after: { w: pd2.door ? pd2.door.w : null, h: pd2.door ? pd2.door.h : null },
      doorPassNow: pd2.ok, msgs: [...document.querySelectorAll('.msg.ai p')].slice(-2).map(x => x.innerText.slice(0, 200))
    };
  });
  log('拓宽门', JSON.stringify(widenRes, null, 2));
  await sleep(700);
  await p.screenshot({ path: OUT + 'v2-6-widen.png' });

  /* 8) 树搜索：真编号 + 口语别名都要命中 */
  const search = await p.evaluate(async () => {
    const q = document.getElementById('treeQ');
    const hit = async k => {
      q.value = k;
      q.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 260));
      const rows = [...document.querySelectorAll('#treeBody .tn')];
      return { k, n: rows.length, sample: rows.slice(0, 3).map(x => x.textContent.trim()) };
    };
    return [await hit('V400'), await hit('阀门'), await hit('202'), await hit('M1021')];
  });
  log('搜索', JSON.stringify(search));

  log('页面错误', errs.length ? errs.slice(0, 6) : '无');
  await b.close();
})();
