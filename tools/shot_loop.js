/* 出一张"多轮 Agent 真的干活了"的现场图 */
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = 'http://127.0.0.1:8823';
const OUT = require('path').join(__dirname, '..', 'outputs') + '/';

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1600, height: 950 },
  });
  const p = await b.newPage();
  await p.goto(SITE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => localStorage.clear());
  await p.goto(SITE + '/index.html', { waitUntil: 'networkidle2' });
  await sleep(3000);

  const say = async (t) => {
    const before = await p.evaluate(() => document.querySelectorAll('.msg.ai:not(.typing)').length);
    await p.type('#txt', t);
    await p.keyboard.press('Enter');
    for (let i = 0; i < 240; i++) {
      await sleep(250);
      const st = await p.evaluate(() => ({ n: document.querySelectorAll('.msg.ai:not(.typing)').length, ty: !!document.querySelector('.msg.ai.typing') }));
      if (!st.ty && st.n > before) break;
    }
    await sleep(1200);
  };

  await say('把空压机放到 5 楼 505 靠里');
  await say('把这个空压机放到 506 室');
  await say('把空压机挪到靠窗的位置');
  await sleep(800);
  await p.screenshot({ path: OUT + 'agent-loop.png' });
  console.log('已截图 outputs/agent-loop.png');
  console.log(JSON.stringify(await p.evaluate(() => BIM.app.state.placed.map(e => ({ n: e.name, r: e.room, x: +e.x.toFixed(2), y: +e.y.toFixed(2) })))));
  await b.close();
})();
