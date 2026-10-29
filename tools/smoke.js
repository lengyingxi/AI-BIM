const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'],
    defaultViewport:{width:1600,height:950} });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(2200);
  const info = await p.evaluate(() => ({
    tools: (window.BIM.mcp && window.BIM.mcp.tools || []).map(t => t.function.name),
    bound: Object.keys((window.BIM.mcp || {}).handlers || {}),
    agentOk: !!(window.BIM.agent && window.BIM.agent.plan),
    listenBar: !!document.getElementById('listenBar'),
    btnDone: !!document.getElementById('btnVoiceDone'),
    cfg: window.BIM.agent && { ep: window.BIM.agent.cfg.endpoint, model: window.BIM.agent.cfg.model }
  }));
  console.log(JSON.stringify(info, null, 1));
  console.log('errors:', errs.slice(0, 5));
  await b.close();
})();
