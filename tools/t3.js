const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = 'C:/Users/Administrator/WorkBuddy/2026-10-26-14-53-42/aibim/outputs/';
(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1680, height: 1000 },
  });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(800);

  // 直接校验碰撞规则
  const chk = await p.evaluate(() => {
    const M = BIM_MODEL, C = BIM.calc;
    const r306 = M.rooms.find(r => r.id === '306');
    const wall = M.walls.find(w => w.id === r306.sides.south);   // 走廊隔墙
    const cases = [
      ['门贴墙端', 0.3],
      ['与既有门重叠', 5.3],
      ['墙中段空闲', 5.95],
    ];
    return cases.map(([n, at]) => {
      const r = C.door({ wall, at, w: 1.0, h: 2.1, equipments: [] });
      return n + ' => ' + (r.pass ? '通过' : '阻挡') + ' | ' + r.blocks.map(x => x.t).join(';') + ' | 提示:' + r.warns.join(';');
    });
  });
  console.log(chk.join('\n'));

  await p.type('#txt', '在3楼306左边开个门'); await p.keyboard.press('Enter');
  await sleep(1400);
  const q = await p.evaluate(() => BIM.scene.project(5.75, 9.0, 8.95));
  await p.mouse.click(q.x, q.y);
  await sleep(1200);
  await p.screenshot({ path: OUT + 't12-door-collide.png' });
  console.log('AI:', await p.evaluate(() => [...document.querySelectorAll('.msg.ai')].pop().innerText.replace(/\n+/g, ' | ')));
  console.log('errs', errs);
  await b.close();
})();
