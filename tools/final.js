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
  p.on('console', m => { if (m.type() === 'error') errs.push('console:' + m.text()); });
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(1200);
  const say = async t => { await p.type('#txt', t); await p.keyboard.press('Enter'); await sleep(1000); };
  const clickAt = async (x, y, z, s) => {
    const q = await p.evaluate((a, bb, c) => BIM.scene.project(a, bb, c), x, y, z);
    await p.mouse.click(q.x, q.y); await sleep(s || 1300);
  };

  await say('把空压机放到2楼202');
  await clickAt(9.9, 3.6, 4.5);
  await p.screenshot({ path: OUT + 'f1-place.png' });

  // 属性面板
  await p.evaluate(() => document.querySelectorAll('#toolbar button')[1].click());
  await sleep(300);
  const q = await p.evaluate(() => BIM.scene.project(9.9, 3.6, 5.6));
  await p.mouse.click(q.x, q.y);
  await sleep(600);
  await p.screenshot({ path: OUT + 'f2-props.png' });

  // 设备库
  await p.evaluate(() => document.querySelectorAll('#toolbar button')[2].click());
  await sleep(500);
  await p.screenshot({ path: OUT + 'f3-equip.png' });
  await p.evaluate(() => { document.getElementById('pEquip').hidden = true; });

  // 透视
  await p.evaluate(() => document.querySelectorAll('#toolbar button')[4].click());
  await sleep(600);
  await p.screenshot({ path: OUT + 'f4-xray.png' });
  await p.evaluate(() => document.querySelectorAll('#toolbar button')[4].click());

  // 阀门
  await say('关闭4楼405的阀门会影响哪些房间');
  await sleep(1200);
  await p.screenshot({ path: OUT + 'f5-valve.png' });

  // 小屏
  await p.setViewport({ width: 1280, height: 800 });
  await sleep(600);
  await p.screenshot({ path: OUT + 'f6-small.png' });

  const metrics = await p.evaluate(() => ({
    chatScroll: document.getElementById('chat').scrollHeight > document.getElementById('chat').clientHeight,
    toolbarW: document.getElementById('toolbar').getBoundingClientRect().width,
    stageW: document.getElementById('stage').getBoundingClientRect().width,
    overflowX: document.body.scrollWidth > window.innerWidth,
    fps: 0,
  }));
  console.log(JSON.stringify(metrics));
  console.log('errs:', errs);
  await b.close();
})();
