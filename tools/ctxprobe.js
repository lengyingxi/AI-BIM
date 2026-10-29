const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1600, height: 950 },
  });
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(1500);
  const say = async (t, w) => {
    await p.type('#txt', t); await p.keyboard.press('Enter'); await sleep(w || 1500);
    const r = await p.evaluate(() => ({
      ai: [...document.querySelectorAll('.msg.ai')].pop().innerText.replace(/\n+/g, ' | ').slice(0, 110),
      plan: BIM._lastPlan ? BIM._lastPlan.steps.map(s => s.act + (s.room ? '@' + s.room : '') + (s.pref ? '/' + s.pref : '')).join(',') : '',
      placed: BIM.app.state.placed.map(e => e.name + '@' + e.room).join(' '),
      ctx: BIM.agent.ctxLine()
    }));
    console.log('\n> ' + t + '\n  ' + r.ai + '\n  steps=[' + r.plan + ']  ctx=' + r.ctx + '\n  场景: ' + r.placed);
  };
  await say('把空压机放到2楼202靠里');
  await say('再放一台');
  await say('把刚才那台挪到203');
  await say('这间房还能放几台');
  await say('在203左边开个1.2米的门');
  await say('关掉这层的阀门');
  await say('撤掉它');
  await say('回到全楼');
  console.log('\nerrs', errs);
  await b.close();
})();
