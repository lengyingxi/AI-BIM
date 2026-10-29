const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = 'C:/Users/Administrator/WorkBuddy/2026-10-26-14-53-42/aibim/outputs/';

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

  const say = async (t, wait) => { await p.type('#txt', t); await p.keyboard.press('Enter'); await sleep(wait || 1100); };
  const shot = n => p.screenshot({ path: OUT + n + '.png' });
  const lastAI = () => p.evaluate(() => [...document.querySelectorAll('.msg.ai')].pop().innerText.replace(/\n+/g, ' | '));
  const clickBim = async (x, y, z, wait) => {
    const q = await p.evaluate((a, b2, c) => BIM.scene.project(a, b2, c), x, y, z);
    await p.mouse.click(q.x, q.y); await sleep(wait || 1400);
  };

  await shot('s0-overview');

  // 1 放设备（可放）
  await say('把空压机放到2楼202');
  await clickBim(9.9, 3.6, 4.5);
  await shot('s1-place-ok');
  console.log('1', await lastAI());

  // 2 放设备（超载）
  await say('把柴油发电机组放到3楼307');
  await p.evaluate(() => {
    const r = BIM_MODEL.rooms.find(x => x.id === '307');
    const q = BIM.scene.project((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, r.elev + 0.02);
    window.__pick = q;
  });
  const c307 = await p.evaluate(() => window.__pick);
  await p.mouse.click(c307.x, c307.y);
  await sleep(1500);
  await shot('s2-place-bad');
  console.log('2', await lastAI());

  // 3 开门（找一个空位）
  await say('在3楼306左边打一个门');
  const freeSpot = await p.evaluate(() => {
    const M = BIM_MODEL, C = BIM.calc, r = M.rooms.find(x => x.id === '306');
    const w = M.walls.find(x => x.id === r.sides.south);
    const [ax, ay] = w.p1, [bx, by] = w.p2, L = Math.hypot(bx - ax, by - ay);
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    const ts = [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]].map(([x, y]) => (x - ax) * ux + (y - ay) * uy);
    const lo = Math.min.apply(null, ts) + 0.7, hi = Math.max.apply(null, ts) - 0.7, mid = (lo + hi) / 2;
    let at = -1;
    for (let t = lo; t <= hi; t += 0.1) {
      if (C.door({ wall: w, at: t, w: 1.0, h: 2.1, equipments: [] }).pass) { if (at < 0 || Math.abs(t - mid) < Math.abs(at - mid)) at = t; }
    }
    const t2 = at / L;
    return { id: w.id, at: at, q: BIM.scene.project(ax + (bx - ax) * t2, ay + (by - ay) * t2, w.base + 1.1) };
  });
  await p.mouse.click(freeSpot.q.x, freeSpot.q.y);
  await sleep(1600);
  await shot('s3-door');
  console.log('3', freeSpot.id, 'at=' + freeSpot.at.toFixed(2), await lastAI());

  // 3b 开门（碰撞）
  await say('在3楼306左边再打一个门');
  const badSpot = await p.evaluate(() => {
    const M = BIM_MODEL, C = BIM.calc, r = M.rooms.find(x => x.id === '306');
    const w = M.walls.find(x => x.id === r.sides.south);
    const [ax, ay] = w.p1, [bx, by] = w.p2, L = Math.hypot(bx - ax, by - ay);
    let at = 0.2;
    for (let t = 0.15; t < L; t += 0.1) { if (!C.door({ wall: w, at: t, w: 1.0, h: 2.1, equipments: [] }).pass) { at = t; break; } }
    const t2 = at / L;
    return { at: at, q: BIM.scene.project(ax + (bx - ax) * t2, ay + (by - ay) * t2, w.base + 1.1) };
  });
  await p.mouse.click(badSpot.q.x, badSpot.q.y);
  await sleep(1600);
  await shot('s3b-door-block');
  console.log('3b at=' + badSpot.at.toFixed(2), await lastAI());

  // 4 阀门
  await say('关闭4楼405的通气阀门会影响哪些房间', 1600);
  await shot('s4-valve');
  console.log('4', await lastAI());

  // 5 计算书
  await p.evaluate(() => {
    const btns = [...document.querySelectorAll('#toolbar button')];
    btns[0].click();
  });
  await sleep(900);
  await shot('s5-calcbook');

  // 6 全楼总览
  await p.evaluate(() => {
    document.getElementById('pCalc').hidden = true;
    document.getElementById('floorPills').querySelector('button').click();
  });
  await sleep(1100);
  await shot('s6-all');

  // 7 小屏
  await p.setViewport({ width: 1280, height: 800 });
  await sleep(800);
  await shot('s7-small');

  const m = await p.evaluate(() => ({
    chatScroll: document.getElementById('chat').scrollHeight > document.getElementById('chat').clientHeight + 4,
    overflowX: document.body.scrollWidth > window.innerWidth,
    panels: [...document.querySelectorAll('.panel')].filter(x => !x.hidden).map(x => x.id),
  }));
  console.log(JSON.stringify(m));
  console.log('errs', errs);
  await b.close();
})();
