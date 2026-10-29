const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  const p = await b.newPage();
  p.on('pageerror', e => console.log('PAGEERR', e.message));
  await p.goto('http://127.0.0.1:8823', { waitUntil: 'load' });
  await sleep(1500);
  const r = await p.evaluate(() => {
    const M = window.BIM.app.model(), C = window.BIM.calc;
    const room = M.rooms.find(x => x.num === '202');
    const wall = M.walls.find(w => w.id === room.sides.south);
    const cols = M.columns.filter(c => c.floor === 2 && c.y < 1).map(c => [c.x, c.y, c.s]);
    const free = [];
    for (let at = 6.7; at <= 13.1; at += 0.05) {
      const c = C.window({ wall, at, w: 1.8, h: 1.8, sill: .9, room });
      if (c.pass) free.push(+at.toFixed(2));
    }
    const one = C.window({ wall, at: 7.75, w: 1.8, h: 1.8, sill: .9, room });
    return { cols, free, one: { pass: one.pass, blocks: one.blocks.map(b => b.t) } };
  });
  console.log(JSON.stringify(r));
  await b.close();
})();
