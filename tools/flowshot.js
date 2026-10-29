/* 流向对照图：通流 / 关阀断流 */
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = 'C:/Users/Administrator/WorkBuddy/2026-10-26-14-53-42/aibim/outputs/';
(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const p = await b.newPage();
  p.on('pageerror', e => console.log('PAGEERR', e.message));
  await p.goto('http://127.0.0.1:8823', { waitUntil: 'load' });
  await sleep(1800);
  await p.evaluate(() => {
    document.querySelector('#chatScroll') && (document.querySelector('#chatScroll').style.display = 'none');
    const side = document.querySelector('#side') || document.querySelector('.side');
    if (side) side.style.display = 'none';
    BIM.scene.setFocus(2);
    BIM.scene.setFlow(true);
  });
  await sleep(600);
  await p.evaluate(() => BIM.scene.setCam(4.2, 8.4, -2.2, 20, 5.2, -6.6));
  await sleep(1500);
  await p.screenshot({ path: OUT + 'flow-live.png' });

  // 近景：看清单根管上的箭头
  await p.evaluate(() => BIM.scene.setCam(1.6, 7.85, -7.9, 30, 7.15, -7.6));
  await sleep(1200);
  await p.screenshot({ path: OUT + 'flow-live-close.png' });

  await p.evaluate(async () => {
    await BIM.mcp.call('toggle_valve', { valve: 'V2E', action: 'close' });
  });
  await sleep(2600);
  // 关阀会 focusBounds 抢镜头（还有一段镜头动画），等它跑完再摆近景
  await p.evaluate(() => BIM.scene.setCam(1.6, 7.85, -7.9, 30, 7.15, -7.6));
  await sleep(1600);
  await p.screenshot({ path: OUT + 'flow-dead-close.png' });

  await p.evaluate(() => BIM.scene.setCam(4.2, 8.4, -2.2, 20, 5.2, -6.6));
  await sleep(1200);
  await p.screenshot({ path: OUT + 'flow-dead.png' });
  console.log('ok');
  await b.close();
})();
