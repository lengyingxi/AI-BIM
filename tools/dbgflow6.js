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
    const b0 = D.flowState().blocked.length;
    await window.BIM.mcp.call('toggle_valve', { valve: 'V2E', action: 'close' });
    await new Promise(x => setTimeout(x, 400));
    const b1 = D.flowState().blocked.length;
    const open1 = v.open;
    D.touch();
    await new Promise(x => setTimeout(x, 400));
    const b2 = D.flowState().blocked.length;
    S.setFocus(2);
    await new Promise(x => setTimeout(x, 500));
    const b3 = D.flowState().blocked.length;
    return { b0, b1, open1, b2, b3, focus: S.focus || null, flowFocus: window.BIM.app.state.focus };
  });
  console.log(JSON.stringify(r));
  await b.close();
})();
