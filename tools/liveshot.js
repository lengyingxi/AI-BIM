/* 真网关演示截图：一次多步指令（放设备 + 换楼层），全部由大模型拆解 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = path.join(__dirname, '..', 'outputs') + '/';

(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'], defaultViewport:{width:1600,height:950} });
  const p = await b.newPage();
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => localStorage.clear());
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(2500);

  const say = async (t, ms) => {
    const before = await p.evaluate(() => document.querySelectorAll('.msg.ai:not(.typing)').length);
    await p.type('#txt', t); await p.keyboard.press('Enter');
    for (let i = 0; i < 200; i++) {
      await sleep(300);
      const st = await p.evaluate(() => ({ n: document.querySelectorAll('.msg.ai:not(.typing)').length, ty: !!document.querySelector('.msg.ai.typing') }));
      if (!st.ty) { await sleep(ms || 900); if (st.n > before) break; }
    }
  };

  await p.screenshot({ path: OUT + 'live-1-boot.png' });

  await say('把空压机放到2楼202靠里');
  await p.screenshot({ path: OUT + 'live-2-place.png' });

  await say('再放一台水冷机组到3楼306靠窗');
  await p.screenshot({ path: OUT + 'live-3-second.png' });

  await p.evaluate(() => document.getElementById('btnAI').click());
  await sleep(400);
  await p.screenshot({ path: OUT + 'live-4-panel.png' });

  const plan = await p.evaluate(() => window.BIM._lastPlan);
  const n = await p.evaluate(() => BIM.app.state.placed.map(e => e.room + '/' + e.floor));
  console.log('来源', plan && plan.source, '| 落地', JSON.stringify(n));
  await b.close();
})();
