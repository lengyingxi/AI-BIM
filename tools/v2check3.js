/* 树与其它功能的配合：三维点选回填树、柱梁风管阀属性、面板共存、复位 */
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
  p.on('console', m => { if (m.type() === 'error') errs.push('console:' + m.text()); });
  await p.goto('http://127.0.0.1:8823/', { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => window.BIM && BIM.tree && BIM_MODEL, { timeout: 30000 });
  await sleep(2200);

  /* 1) 三维点选 → 树上自动展开并高亮（模拟 showProps 的回填） */
  const reveal = await p.evaluate(async () => {
    BIM.tree.open(true);
    const w = BIM_MODEL.walls.find(x => x.floor === 2 && x.kind === 'corr');
    BIM.scene.focusThing('wall', w, {});
    BIM.app.onTreePick({ kind: 'wall', data: w });
    await new Promise(r => setTimeout(r, 500));
    const cur = document.querySelector('#treeBody .tn.cur');
    return {
      wall: w.id, propsTitle: document.getElementById('propsTitle').textContent,
      curNode: cur ? cur.textContent.trim().slice(0, 30) : null,
      bothPanels: !document.getElementById('pTree').hidden && !document.getElementById('pProps').hidden
    };
  });
  console.log('三维点选回填树', JSON.stringify(reveal, null, 2));
  await sleep(700);
  await p.screenshot({ path: OUT + 'v2-8-reveal.png' });

  /* 2) 柱 / 梁 / 风管 / 阀 属性 */
  const others = await p.evaluate(async () => {
    const out = {};
    const col = BIM_MODEL.columns.find(c => c.floor === 3);
    BIM.tree.open(true); BIM.app.onTreePick({ kind: 'column', data: col });
    await new Promise(r => setTimeout(r, 300));
    out.column = document.getElementById('propsTitle').textContent + ' :: ' + document.getElementById('propsBody').innerText.replace(/\n+/g, ' | ').slice(0, 90);
    const bm = BIM_MODEL.beams.find(x => x.floor === 3);
    BIM.app.onTreePick({ kind: 'beam', data: bm });
    await new Promise(r => setTimeout(r, 300));
    out.beam = document.getElementById('propsTitle').textContent + ' :: ' + document.getElementById('propsBody').innerText.replace(/\n+/g, ' | ').slice(0, 90);
    const du = BIM_MODEL.ducts.find(x => x.floor === 3);
    BIM.app.onTreePick({ kind: 'duct', data: du });
    await new Promise(r => setTimeout(r, 300));
    out.duct = document.getElementById('propsTitle').textContent + ' :: ' + document.getElementById('propsBody').innerText.replace(/\n+/g, ' | ').slice(0, 120);
    const v = BIM_MODEL.valves.find(x => x.floor === 3);
    BIM.app.onTreePick({ kind: 'valve', data: v });
    await new Promise(r => setTimeout(r, 300));
    out.valve = document.getElementById('propsTitle').textContent + ' :: ' + document.getElementById('propsBody').innerText.replace(/\n+/g, ' | ').slice(0, 110);
    return out;
  });
  console.log('各类构件属性', JSON.stringify(others, null, 2));
  await sleep(400);
  await p.screenshot({ path: OUT + 'v2-9-duct.png' });

  /* 3) 设备库 + 树 同屏；复位 */
  const panels = await p.evaluate(async () => {
    document.querySelector('#toolbar button[data-k="equip"]').click();
    await new Promise(r => setTimeout(r, 300));
    const s1 = { equip: !document.getElementById('pEquip').hidden, tree: !document.getElementById('pTree').hidden };
    document.querySelector('#toolbar button[data-k="reset"]').click();
    await new Promise(r => setTimeout(r, 1500));
    return {
      afterEquip: s1,
      afterReset: { focus: BIM.scene.focus, flow: !!(BIM.detail && BIM.detail.on.flow), cur: BIM.tree.cur() }
    };
  });
  console.log('面板共存 / 复位', JSON.stringify(panels, null, 2));
  await sleep(600);
  await p.screenshot({ path: OUT + 'v2-10-reset.png' });

  /* 4) 撞柱：把设备摆在真实框架柱的柱心上，看能不能报出来 + 描红 */
  const colClash = await p.evaluate(async () => {
    const c = BIM_MODEL.columns.filter(x => x.floor === 3)
      .find(x => BIM_MODEL.rooms.some(r => r.floor === 3 &&
        x.x >= r.x0 && x.x <= r.x1 && x.y >= r.y0 && x.y <= r.y1));
    const r = BIM_MODEL.rooms.filter(x => x.floor === 3).sort((a, b) => {
      const da = Math.hypot((a.x0 + a.x1) / 2 - c.x, (a.y0 + a.y1) / 2 - c.y);
      const db = Math.hypot((b.x0 + b.x1) / 2 - c.x, (b.y0 + b.y1) / 2 - c.y);
      return da - db;
    })[0];
    const dev = BIM_MODEL.equipmentLibrary[0];
    BIM.scene.setFocus(r.floor, false);
    const ob = BIM.calc.obstruct({ room: r, equip: dev, cx: c.x, cy: c.y, others: [] });
    BIM.app.state.pending = { device: dev, room: r, pref: null };
    BIM.app.placeAt(r, dev, c.x, c.y, ob);
    await new Promise(res => setTimeout(res, 900));
    return {
      col: c.id, room: r.num,
      blocks: ob.blocks.map(x => x.t), hits: (ob.hits || []).map(x => x.kind),
      hl: BIM.scene.root().children.filter(x => x.userData && x.userData.unit === 0).length
    };
  });
  console.log('撞柱/贴墙', JSON.stringify(colClash, null, 2));
  await sleep(900);
  await p.screenshot({ path: OUT + 'v2-11-colclash.png' });

  console.log('错误', errs.length ? errs.slice(0, 6) : '无');
  await b.close();
})();
