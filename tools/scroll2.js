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
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(1200);
  const say = async t => { await p.type('#txt', t); await p.keyboard.press('Enter'); await sleep(1100); };
  const clickBim = async (x, y, z, w) => { const q = await p.evaluate((a, b2, c) => BIM.scene.project(a, b2, c), x, y, z); await p.mouse.click(q.x, q.y); await sleep(w || 1400); };
  await say('把空压机放到2楼202');
  await clickBim(9.9, 3.6, 4.5);
  await say('把柴油发电机组放到3楼307');
  await p.evaluate(() => { const r = BIM_MODEL.rooms.find(x => x.id === '307'); window.__q = BIM.scene.project((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, r.elev + 0.02); });
  const q = await p.evaluate(() => window.__q);
  await p.mouse.click(q.x, q.y); await sleep(1500);
  await say('在3楼306左边打一个门');
  const spot = await p.evaluate(() => {
    const M = BIM_MODEL, C = BIM.calc, r = M.rooms.find(x => x.id === '306');
    const w = M.walls.find(x => x.id === r.sides.south);
    const [ax, ay] = w.p1, [bx, by] = w.p2, L = Math.hypot(bx - ax, by - ay);
    let at = -1;
    for (let t = 0.9; t < L - 0.9; t += 0.1) if (C.door({ wall: w, at: t, w: 1, h: 2.1, equipments: [] }).pass) { at = t; break; }
    const t2 = at / L;
    return BIM.scene.project(ax + (bx - ax) * t2, ay + (by - ay) * t2, w.base + 1.1);
  });
  await p.mouse.click(spot.x, spot.y); await sleep(1800);
  const m = await p.evaluate(() => {
    const c = document.getElementById('chat');
    const card = [...document.querySelectorAll('#chat .res')].pop();
    const cr = card.getBoundingClientRect();
    return { top: c.scrollTop, sh: c.scrollHeight, ch: c.clientHeight, cardTop: Math.round(cr.top), cardBottom: Math.round(cr.bottom) };
  });
  console.log(JSON.stringify(m));
  await p.screenshot({ path: OUT + 'x3-scroll.png' });
  await b.close();
})();
