/* 家具碰撞 + 树搜索 + 门归属 三个点单独验 */
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
  await p.waitForFunction(() => window.BIM && BIM.tree && BIM_MODEL, { timeout: 30000 });
  await sleep(2200);

  const furn = await p.evaluate(() => {
    const fr = BIM.detail.furnRects || {};
    const keys = Object.keys(fr);
    const total = keys.reduce((n, k) => n + fr[k].length, 0);
    return {
      rooms: keys.length, total,
      sample: (fr['201'] || []).slice(0, 4).map(f => f.label + '@' + f.x.toFixed(1) + ',' + f.y.toFixed(1) + ' ' + f.w + 'x' + f.d),
      kinds: [...new Set(keys.flatMap(k => fr[k].map(f => f.label)))].join(','),
      room201: (fr['201'] || []).length, room205: (fr['205'] || []).length
    };
  });
  console.log('家具落位', JSON.stringify(furn, null, 2));

  /* 把设备正对着一张工位放，看能不能报「压到工位」 */
  const onDesk = await p.evaluate(() => {
    const r = BIM_MODEL.rooms.find(x => x.num === '201');
    const fr = BIM.detail.furnRects['201'] || [];
    const desk = fr.find(f => f.label === '工位');
    const dev = BIM_MODEL.equipmentLibrary.find(d => /压缩/.test(d.name));
    const ob = BIM.calc.obstruct({ room: r, equip: dev, cx: desk.x, cy: desk.y, others: [] });
    return {
      at: [desk.x, desk.y], blocks: ob.blocks.map(b => b.t), kinds: ob.blocks.map(b => b.k)
    };
  });
  console.log('压在工位上', JSON.stringify(onDesk, null, 2));

  /* 真的放下并截图 */
  const placed = await p.evaluate(() => {
    const r = BIM_MODEL.rooms.find(x => x.num === '201');
    const fr = BIM.detail.furnRects['201'] || [];
    const desk = fr.find(f => f.label === '工位');
    const dev = BIM_MODEL.equipmentLibrary.find(d => /压缩/.test(d.name));
    BIM.scene.setFocus(r.floor, false);
    const ob = BIM.calc.obstruct({ room: r, equip: dev, cx: desk.x, cy: desk.y, others: [] });
    BIM.app.state.pending = { device: dev, room: r, pref: null };
    const eq = BIM.app.placeAt(r, dev, desk.x, desk.y, ob);
    return { eq: !!eq, n: BIM.app.state.placed.length, marks: document.querySelectorAll('#treeBody .tn').length };
  });
  console.log('压在工位上放置', JSON.stringify(placed));
  await sleep(1200);
  await p.screenshot({ path: OUT + 'v2-7-furn.png' });

  /* 树搜索：房间号 / 门编号 / 阀 id / 设备名 */
  for (const q of ['202', 'M1021', 'V405', '阀门', '空压']) {
    const r = await p.evaluate(async qq => {
      BIM.tree.open(true);
      const el = document.getElementById('treeQ');
      el.value = qq;
      el.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 200));
      const rows = [...document.querySelectorAll('#treeBody .tn')];
      return { q: qq, n: rows.length, sample: rows.slice(0, 3).map(x => x.textContent.trim().slice(0, 40)) };
    }, q);
    console.log('搜索', JSON.stringify(r));
  }

  /* 门归属：202 房间下应该只剩自己的门 */
  const doors = await p.evaluate(() => {
    BIM.tree.setQuery('');
    const root = BIM.tree.root();
    const f2 = root.kids.find(k => k.label === '2F');
    const rooms = f2.kids.find(k => k.label === '房间').kids;
    const r202 = rooms.find(r => r.label.indexOf('202') === 0);
    const corr = rooms.find(r => /走廊/.test(r.label));
    const dg = n => (n.kids.find(k => k.label === '门') || { kids: [] }).kids.map(d => d.label);
    return { r202: r202.label + ' 门 ' + dg(r202).join('/'), corr: corr.label + ' 门 ' + dg(corr).length + ' 扇' };
  });
  console.log('门归属', JSON.stringify(doors, null, 2));

  console.log('错误', errs.length ? errs.slice(0, 5) : '无');
  await b.close();
})();
