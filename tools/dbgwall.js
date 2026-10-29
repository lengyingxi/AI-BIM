const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1600, height: 950 },
  });
  const p = await b.newPage();
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(1200);
  await p.type('#txt', '在3楼306左边打一个门');
  await p.keyboard.press('Enter');
  await sleep(1400);
  const out = await p.evaluate(() => {
    const M = BIM_MODEL, C = BIM.calc, S = BIM.scene;
    const r = M.rooms.find(x => x.num === '306');
    const w = M.walls.find(x => x.id === r.sides.west);
    const [ax, ay] = w.p1, [bx, by] = w.p2, L = Math.hypot(bx - ax, by - ay);
    const res = { sides: r.sides, wall: w.id, L: L, base: w.base, h: w.h, t: w.t };
    let at = -1;
    for (let t = 0.9; t < L - 0.9; t += 0.1) if (C.door({ wall: w, at: t, w: 1, h: 2.1, equipments: [] }).pass) { at = t; break; }
    res.freeAt = at;
    const k = at / L;
    const q = S.project(ax + (bx - ax) * k, ay + (by - ay) * k, w.base + 1.1);
    res.q = q;
    const pick = S.pickWallOfRoom(r, { clientX: q.x, clientY: q.y });
    res.pick = pick ? { id: pick.wall.id, at: +pick.at.toFixed(2), side: pick.side } : null;
    return res;
  });
  console.log(JSON.stringify(out, null, 1));
  await b.close();
})();
