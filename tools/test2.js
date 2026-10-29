/* 泛化能力测试：任意房间 / 任意设备 / 任意门 / 任意阀 */
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = 'C:/Users/Administrator/WorkBuddy/2026-10-26-14-53-42/aibim/outputs';

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1680, height: 1000 },
  });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(1000);

  async function say(t) {
    await p.type('#txt', t);
    await p.keyboard.press('Enter');
    await sleep(900);
    return p.evaluate(() => {
      const m = [...document.querySelectorAll('.msg.ai')];
      return m.slice(-1).map(x => x.innerText.replace(/\n+/g, ' | '))[0];
    });
  }
  async function clickAt(x, y, z) {
    const pt = await p.evaluate((a, bb, c) => BIM.scene.project(a, bb, c), x, y, z);
    await p.mouse.click(pt.x, pt.y);
    await sleep(1100);
    return p.evaluate(() => {
      const m = [...document.querySelectorAll('.msg.ai')];
      return m.slice(-1).map(x => x.innerText.replace(/\n+/g, ' | '))[0];
    });
  }

  // 1. 用户原话：2 楼 502（房号与楼层不一致，看兜底）
  console.log('Q: 把这个设备放到2楼502里面');
  console.log('A:', await say('把这个设备放到2楼502里面'));
  console.log('C:', await clickAt(9.0, 4.2, 4.5));

  // 2. 重载后测更多
  for (const [q, cx, cy, cz] of [
    ['把消防水泵放到4楼405', 29.7, 3.3, 12.4],
    ['把柴油发电机放到5楼503', 16.5, 3.3, 16.3],
    ['把服务器机柜放到3楼307', 9.9, 12.3, 8.5],
  ]) {
    console.log('\nQ:', q);
    console.log('A:', await say(q));
    console.log('C:', await clickAt(cx, cy, cz));
  }

  // 3. 内墙开门
  console.log('\nQ: 在1楼101右边开个门');
  console.log('A:', await say('在1楼101右边开个门'));
  console.log('C:', await clickAt(6.6, 3.3, 1.6));

  // 4. 支管阀
  console.log('\nQ: 关掉3楼306的阀门会怎样');
  console.log('A:', await say('关掉3楼306的阀门会怎样'));

  // 5. 再打开
  console.log('\nQ: 把3楼306的阀门打开');
  console.log('A:', await say('把3楼306的阀门打开'));

  // 6. 属性
  await p.evaluate(() => document.querySelectorAll('#toolbar button')[1].click());
  await sleep(600);
  const pt = await p.evaluate(() => BIM.scene.project(16.5, 3.3, 16.3));
  await p.mouse.click(pt.x, pt.y);
  await sleep(700);
  await p.screenshot({ path: OUT + '/t10-props.png' });
  const props = await p.evaluate(() => document.getElementById('propsBody').innerText.replace(/\n/g, ' | '));
  console.log('\n属性:', props);

  console.log('\nerrors:', errs);
  await b.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
