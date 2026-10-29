const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  const p = await b.newPage();
  p.on('pageerror', e => console.log('PAGEERR', e.message));
  await p.goto('http://127.0.0.1:8823', { waitUntil: 'load' });
  await sleep(1600);
  const r = await p.evaluate(async () => {
    const M = window.BIM.app.model(), D = window.BIM.detail, S = window.BIM.scene;
    S.setFocus(2);
    S.setFlow(true);
    await new Promise(x => setTimeout(x, 500));
    const out = [];
    const vs = M.valves.filter(v => v.floor === 2);
    for (const v of vs) {
      S.setValve(v, !v.open);
      await new Promise(x => setTimeout(x, 300));
      const st = D.flowState();
      out.push({ id: v.id, open: v.open, blocked: st ? st.blocked.length : -1, count: st ? st.count : 0, dirty: '?' });
      S.setValve(v, v.open);
      await new Promise(x => setTimeout(x, 100));
    }
    return out;
  });
  console.log(JSON.stringify(r));
  await b.close();
})();
