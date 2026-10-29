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
  await sleep(1500);
  const r = await p.evaluate(async () => {
    const M = window.BIM.app.model();
    const R = window.BIM.routes;
    const idx = R.index(M);
    const f2 = (M.ducts || []).filter(d => d.floor === 2);
    const vs = (M.valves || []).filter(v => v.floor === 2);
    const valveMap = vs.map(v => ({ id: v.id, open: v.open, duct: idx.valveDuct[v.id] }));
    const degs = f2.map(d => ({ id: d.id, deg: idx.adj[d.id].length }));
    // 连通分量
    const seen = {}; let comps = 0;
    f2.forEach(d => { if (seen[d.id]) return; comps++; const q = [d.id]; seen[d.id] = 1; while (q.length) { const u = q.shift(); idx.adj[u].forEach(w => { if (!seen[w]) { seen[w] = 1; q.push(w); } }); } });
    await window.BIM.mcp.call('toggle_valve', { valve: vs[0].id, action: 'close' });
    await new Promise(x => setTimeout(x, 300));
    const v0 = M.valves.find(x => x.id === vs[0].id);
    const st = window.BIM.detail;
    return { nDuct: f2.length, nValve: vs.length, valveMap, degs, comps, after: { id: v0.id, open: v0.open } };
  });
  console.log(JSON.stringify(r, null, 1));
  await b.close();
})();
