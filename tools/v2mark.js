/* 验证：碰撞描红真的画出来了 + 放完设备树跳到该设备 */
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
  await sleep(2200);

  const r1 = await p.evaluate(async () => {
    const r = BIM_MODEL.rooms.find(x => x.num === '201');
    const fr = BIM.detail.furnRects['201'] || [];
    const desk = fr.find(f => f.label === '工位');
    const dev = BIM_MODEL.equipmentLibrary.find(d => /压缩/.test(d.name));
    BIM.tree.open(true);
    const ob = BIM.calc.obstruct({ room: r, equip: dev, cx: desk.x, cy: desk.y, others: [] });
    BIM.app.state.pending = { device: dev, room: r, pref: null };
    const eq = BIM.app.placeAt(r, dev, desk.x, desk.y, ob);
    await new Promise(res => setTimeout(res, 800));
    const hl = BIM.scene.root().children.filter(c => c.userData && c.userData.unit === 0 && !c.userData.level);
    const cur = document.querySelector('#treeBody .tn.cur');
    return {
      eq: eq && eq.id,
      hitKinds: (ob.hits || []).map(h => h.kind),
      hlGroups: hl.length, hlKids: hl.map(g => g.children.length),
      curNode: cur ? cur.textContent.trim().slice(0, 24) : null,
      treeNames: [...document.querySelectorAll('#treeBody .tn.cur')].map(x => x.textContent.trim().slice(0, 20)),
      equipNodeExists: !!BIM.tree.state.index['equip:' + (eq && eq.id)]
    };
  });
  console.log(JSON.stringify(r1, null, 2));

  await p.evaluate(() => {
    const r = BIM_MODEL.rooms.find(x => x.num === '201');
    BIM.scene.setCam(r.x0 - 2.5, r.elev + 4.6, -(r.y0 - 2.5), r.x0 + 3.3, r.elev + .6, -(r.y0 + 3.2));
  });
  await sleep(1300);
  await p.screenshot({ path: OUT + 'v3-6-mark.png' });
  console.log('错误', errs.length ? errs : '无');
  await b.close();
})();
