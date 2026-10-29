/* 诊断：跨房间搬运为什么变成反问 */
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = 'http://127.0.0.1:8823';

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1600, height: 950 },
  });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await p.goto(SITE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => localStorage.clear());
  await p.goto(SITE + '/index.html', { waitUntil: 'networkidle2' });
  await sleep(3000);

  console.log('大模型配置:', JSON.stringify(await p.evaluate(() => ({ on: BIM.agent.cfg.on, ep: BIM.agent.cfg.endpoint, model: BIM.agent.cfg.model }))));

  const say = async (t) => {
    const before = await p.evaluate(() => document.querySelectorAll('.msg.ai:not(.typing)').length);
    await p.type('#txt', t);
    await p.keyboard.press('Enter');
    for (let i = 0; i < 200; i++) {
      await sleep(250);
      const st = await p.evaluate(() => ({ n: document.querySelectorAll('.msg.ai:not(.typing)').length, ty: !!document.querySelector('.msg.ai.typing') }));
      if (!st.ty && st.n > before) break;
    }
    await sleep(800);
    const plan = await p.evaluate(() => {
      const q = window.BIM._lastPlan || {};
      return { src: q.source, tools: q.tools || [], reply: q.reply || '', rounds: q.rounds, calls: q.calls,
               steps: (q.steps || []).map(s => ({ act: s.act, device: s.device, room: s.room, pref: s.pref, dir: s.dir, target: s.target })) };
    });
    const txt = await p.evaluate(() => [...document.querySelectorAll('.msg.ai:not(.typing)')].pop().innerText.replace(/\n+/g, ' | '));
    console.log('\n>>> ' + t);
    console.log('   plan: ' + JSON.stringify(plan));
    console.log('   ai  : ' + txt.slice(0, 200));
  };

  await say('把空压机放到2楼505靠里');
  console.log('   已放: ' + JSON.stringify(await p.evaluate(() => BIM.app.state.placed.map(e => ({ n: e.name, r: e.room, x: +e.x.toFixed(2), y: +e.y.toFixed(2) })))));
  await say('把这个空压机放到506室');
  console.log('   已放: ' + JSON.stringify(await p.evaluate(() => BIM.app.state.placed.map(e => ({ n: e.name, r: e.room, x: +e.x.toFixed(2), y: +e.y.toFixed(2) })))));
  console.log('   mcp日志: ' + JSON.stringify(await p.evaluate(() => (BIM.mcp.log || []).slice(-4))));

  if (errs.length) console.log('\n错误:\n ' + errs.slice(0, 5).join('\n '));
  await b.close();
})();
