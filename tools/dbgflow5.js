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
    S.setFocus(2); S.setFlow(true);
    await new Promise(x => setTimeout(x, 600));
    const v = M.valves.find(x => x.id === 'V2E');
    const res = await window.BIM.mcp.call('toggle_valve', { valve: 'V2E', action: 'close' });
    await new Promise(x => setTimeout(x, 500));
    const st = D.flowState();
    return {
      ok: res.ok, say: res.say, open: v.open,
      blocked: st ? st.blocked.length : -1, count: st ? st.count : 0,
      step: window.BIM.agent.fillStep({ act: 'valve', text: '', valve: 'V2E', action: 'close' })
    };
  });
  console.log(JSON.stringify(r, (k, val) => (k === 'roomRef' ? '[room]' : val)));
  await b.close();
})();
