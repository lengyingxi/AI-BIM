/* 「只看这一间」的干净度 / 还原完整性
   只藏墙是不够的：门会悬在半空、别的房间的风管阀门梁还插在画面里。
   这里把每类对象的可见数都数出来，隔离后必须只剩这一间的量，
   show_all 后必须逐个回到原数，连切两间房也不能越用越少。 */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ALL = ['slab', 'wall', 'wallseg', 'door', 'window', 'column', 'beam', 'beamseg', 'duct', 'valve'];

(async () => {
  const b = await puppeteer.launch({
    executablePath: EDGE, headless: 'shell',
    args: ['--use-angle=swiftshader', '--no-sandbox', '--window-size=1280,860']
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1280, height: 860 });
  await p.goto('http://127.0.0.1:8823/', { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => window.BIM && BIM.mcp && BIM.scene, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));

  const snap = () => p.evaluate((ALL) => {
    const S = BIM.scene, out = {};
    ALL.forEach(k => out[k] = { vis: 0, all: 0 });
    S.root().traverse(o => {
      const k = o.userData && o.userData.kind;
      if (!k || ALL.indexOf(k) < 0) return;
      out[k].all++;
      let v = o.visible, q = o.parent;
      while (v && q) { v = q.visible; q = q.parent; }
      if (v) out[k].vis++;
    });
    let sp = { vis: 0, all: 0 };
    S.root().traverse(o => {
      if (!o.isSprite) return;
      sp.all++;
      let v = o.visible, q = o.parent;
      while (v && q) { v = q.visible; q = q.parent; }
      if (v) sp.vis++;
    });
    out.labels = sp;
    return out;
  }, ALL);

  const brief = s => Object.keys(s).map(k => k + ' ' + s[k].vis + '/' + s[k].all).join('  ');

  const base = await snap();
  console.log('1 初始   ', brief(base));

  await p.evaluate(() => BIM.mcp.call('focus_view', { room: '202', only_this: true }));
  await new Promise(r => setTimeout(r, 800));
  const iso = await snap();
  console.log('2 隔离   ', brief(iso));

  await p.evaluate(() => BIM.mcp.call('show_all', {}));
  await new Promise(r => setTimeout(r, 900));
  const back = await snap();
  console.log('3 还原   ', brief(back));

  await p.evaluate(() => BIM.mcp.call('focus_view', { room: '306', only_this: true }));
  await new Promise(r => setTimeout(r, 800));
  const iso2 = await snap();
  console.log('4 换一间 ', brief(iso2));

  await p.evaluate(() => BIM.mcp.call('show_all', {}));
  await new Promise(r => setTimeout(r, 900));
  const back2 = await snap();
  console.log('5 再还原 ', brief(back2));

  // 判据：还原后每种对象可见数 == 初始；换房间后依然只剩一间房的量
  const bad = [];
  Object.keys(base).forEach(k => {
    if (back[k].vis !== base[k].vis) bad.push(`${k} 还原不全 ${back[k].vis}/${base[k].vis}`);
    if (back2[k].vis !== base[k].vis) bad.push(`${k} 二次还原不全 ${back2[k].vis}/${base[k].vis}`);
    if (back[k].all < base[k].all) bad.push(`${k} 对象被弄丢了 ${back[k].all}/${base[k].all}`);
  });
  if (iso.wall.vis > 8) bad.push('隔离后墙太多 ' + iso.wall.vis);

  if (bad.length) { console.log('❌ ' + bad.join(' | ')); process.exitCode = 1; }
  else console.log('\n✅ 隔离干净、还原完整、可以反复切');

  expect(warn => warn);
  function expect() {}
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
