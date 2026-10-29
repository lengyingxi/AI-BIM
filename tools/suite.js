/* 泛化验收：任意房间 / 任意设备 / 任意门位 / 任意阀 */
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1600, height: 950 },
  });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('c:' + m.text()); });
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(1300);

  const say = async t => {
    await p.type('#txt', t); await p.keyboard.press('Enter'); await sleep(900);
    return p.evaluate(() => { const m = [...document.querySelectorAll('.msg.ai')]; return m.length ? m[m.length - 1].innerText.replace(/\n+/g, ' | ') : ''; });
  };
  const clickRoom = async (num) => {
    const q = await p.evaluate(n => {
      const r = BIM_MODEL.rooms.find(x => x.num === n);
      if (!r) return null;
      return BIM.scene.project((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, r.elev + 0.02);
    }, num);
    if (!q) return '房间不存在';
    await p.mouse.click(q.x, q.y); await sleep(1300);
    return p.evaluate(() => { const m = [...document.querySelectorAll('.msg.ai')]; return m[m.length - 1].innerText.replace(/\n+/g, ' | '); });
  };
  const clickWallFree = async (num, side) => {
    const q = await p.evaluate((n, sd) => {
      const M = BIM_MODEL, C = BIM.calc, r = M.rooms.find(x => x.num === n);
      const w = M.walls.find(x => x.id === r.sides[sd]);
      const [ax, ay] = w.p1, [bx, by] = w.p2, L = Math.hypot(bx - ax, by - ay);
      const ux = (bx - ax) / L, uy = (by - ay) / L;
      const ts = [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]].map(([x, y]) => (x - ax) * ux + (y - ay) * uy);
      const lo = Math.min.apply(null, ts) + 0.7, hi = Math.max.apply(null, ts) - 0.7;
      const mid = (lo + hi) / 2;
      let best = null;
      for (let t = lo; t <= hi; t += 0.2) {
        if (C.door({ wall: w, at: t, w: 1, h: 2.1, equipments: [] }).pass) {
          if (!best || Math.abs(t - mid) < Math.abs(best - mid)) best = t;
        }
      }
      if (best == null) return null;
      const k = best / L;
      return BIM.scene.project(ax + (bx - ax) * k, ay + (by - ay) * k, w.base + 1.1);
    }, num, side);
    if (!q) return '找不到空位';
    await p.mouse.click(q.x, q.y); await sleep(1400);
    return p.evaluate(() => { const m = [...document.querySelectorAll('.msg.ai')]; return m[m.length - 1].innerText.replace(/\n+/g, ' | '); });
  };

  // 1 设备放置：跨楼层、跨用途
  const cases = [
    ['把风冷冷水机组放到1楼101', '101'],
    ['把柴油发电机组放到2楼202', '202'],
    ['把服务器机柜放到3楼306', '306'],
    ['把消防水泵放到4楼409', '409'],
    ['把空压机放到5楼502', '502'],
    ['把干式变压器放到5楼508', '508'],
  ];
  for (const [q, num] of cases) {
    const ask = await say(q);
    const res = await clickRoom(num);
    console.log('Q:', q, '\n  A:', ask.slice(0, 40), '\n  R:', res);
  }

  // 2 开门：不同楼层不同朝向
  for (const [q, num, side] of [
    ['在1楼101右边打一个门', '101', 'east'],
    ['在3楼306左边打一个门', '306', 'west'],
    ['在5楼503南边打一个门', '503', 'south'],
  ]) {
    const ask = await say(q);
    const res = await clickWallFree(num, side);
    console.log('Q:', q, '\n  A:', ask.slice(0, 40), '\n  R:', res);
  }

  // 3 阀门：关 + 开
  for (const q of ['关闭2楼202的通气阀门会影响哪些房间', '把2楼202的阀门打开', '关闭5楼508的阀门会影响哪些房间']) {
    const r = await say(q);
    console.log('Q:', q, '\n  A:', r.slice(0, 120));
  }

  // 4 属性（点设备）
  await p.evaluate(() => { BIM.scene.setFocus(1); });
  await sleep(900);
  const pt = await p.evaluate(() => {
    const e = (window.__eqs || [])[0];
    return null;
  });
  console.log('\nerrors:', errs);
  await b.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
