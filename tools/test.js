/* 自动化验收：放置设备 / 开门 / 阀门影响 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const OUT = 'C:/Users/Administrator/WorkBuddy/2026-10-26-14-53-42/aibim/outputs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      '--window-size=1680,1000', '--hide-scrollbars', '--disable-features=Translate'],
    defaultViewport: { width: 1680, height: 1000 },
  });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => logs.push('[' + m.type() + '] ' + m.text()));
  page.on('pageerror', e => logs.push('[pageerror] ' + e.message));

  await page.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, 't01-overview.png') });

  // 顶视图诊断
  await page.evaluate(() => BIM.scene.setCam(16.5, 60, -7.8, 16.5, 4, -7.8));
  await sleep(400);
  await page.screenshot({ path: path.join(OUT, 't02-top.png') });

  // 复位 + 放置设备
  await page.evaluate(() => BIM.scene.viewAll(false));
  await sleep(500);
  await page.type('#txt', '把空压机放到2楼202');
  await page.keyboard.press('Enter');
  await sleep(1400);
  await page.screenshot({ path: path.join(OUT, 't03-place-mode.png') });

  // 点击 202 房间靠梁位置
  const pt = await page.evaluate(() => BIM.scene.project(9.0, 4.0, 4.5));
  await page.mouse.click(pt.x, pt.y);
  await sleep(1600);
  await page.screenshot({ path: path.join(OUT, 't04-placed.png') });

  // 计算书
  await page.evaluate(() => document.querySelectorAll('#toolbar button')[0].click());
  await sleep(600);
  await page.screenshot({ path: path.join(OUT, 't05-calc.png') });
  await page.evaluate(() => { document.getElementById('pCalc').hidden = true; });

  // 开门
  await page.type('#txt', '在3楼306左边开个门');
  await page.keyboard.press('Enter');
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, 't06-door-mode.png') });
  const dp = await page.evaluate(() => BIM.scene.project(0.01, 13.2, 9.9));
  await page.mouse.click(dp.x, dp.y);
  await sleep(1200);
  await page.screenshot({ path: path.join(OUT, 't07-door.png') });

  // 阀门
  await page.type('#txt', '关闭4楼405的阀门会影响哪些房间');
  await page.keyboard.press('Enter');
  await sleep(1800);
  await page.screenshot({ path: path.join(OUT, 't08-valve.png') });

  const state = await page.evaluate(() => ({
    errs: window.__errs,
    msgs: [...document.querySelectorAll('.msg.ai p')].map(x => x.textContent),
    placed: BIM.scene.reg.equip.length,
    doors: BIM_MODEL.doors.length,
    calc: document.getElementById('calcBody').textContent.slice(0, 200),
  }));
  console.log(JSON.stringify(state, null, 1));
  console.log('---console---');
  console.log(logs.slice(0, 25).join('\n'));
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
