const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1600, height: 950 },
  });
  const p = await b.newPage();
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(1200);
  await p.type('#txt', '在3楼306左边打一个门');
  await p.keyboard.press('Enter');
  await sleep(1200);
  const r = await p.evaluate(() => {
    const M = BIM_MODEL, r6 = M.rooms.find(x => x.id === '306');
    const w = M.walls.find(x => x.id === r6.sides.south);
    const [ax, ay] = w.p1, [bx, by] = w.p2, L = Math.hypot(bx - ax, by - ay);
    const t = 0.9 / L;
    return BIM.scene.project(ax + (bx - ax) * t, ay + (by - ay) * t, w.base + 1.1);
  });
  await p.mouse.click(r.x, r.y);
  await sleep(1600);
  const m = await p.evaluate(() => {
    const c = document.getElementById('chat');
    const card = [...document.querySelectorAll('#chat .res')].pop();
    const cr = card ? card.getBoundingClientRect() : null;
    return { top: c.scrollTop, sh: c.scrollHeight, ch: c.clientHeight, cardBottom: cr && cr.bottom, cardTop: cr && cr.top, vh: window.innerHeight };
  });
  console.log(JSON.stringify(m));
  await b.close();
})();
