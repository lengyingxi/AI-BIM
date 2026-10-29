const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1400, height: 900 },
  });
  const p = await b.newPage();
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(1000);
  const out = await p.evaluate(() => {
    const M = BIM_MODEL, C = BIM.calc;
    const r = M.rooms.find(x => x.num === '306');
    const w = M.walls.find(x => x.id === r.sides.west);
    const [ax, ay] = w.p1, [bx, by] = w.p2, L = Math.hypot(bx - ax, by - ay);
    const ux = (bx - ax) / L, uy = (by - ay) / L;
    const ts = [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]].map(([x, y]) => (x - ax) * ux + (y - ay) * uy);
    const rows = [];
    for (let t = 0; t < L; t += 0.5) {
      const c = C.door({ wall: w, at: t, w: 1, h: 2.1, equipments: [] });
      rows.push(t.toFixed(1) + (c.pass ? ' ok' : ' X:' + c.blocks.map(b2 => b2.k).join(',')));
    }
    return { room: { x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1 }, L: L, span: [Math.min(...ts).toFixed(1), Math.max(...ts).toFixed(1)], rows };
  });
  console.log(JSON.stringify(out));
  await b.close();
})();
