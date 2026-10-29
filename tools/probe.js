/* 快速探模型：房间尺寸 + 设备库尺寸 */
const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1200, height: 800 },
  });
  const p = await b.newPage();
  await p.goto('http://127.0.0.1:8823/', { waitUntil: 'networkidle2' });
  await p.waitForFunction(() => window.BIM && BIM.app && BIM.app.model(), { timeout: 30000 });
  const o = await p.evaluate(() => {
    const M = BIM.app.model();
    const rooms = M.rooms.map(r => ({ f: r.floor, num: r.num, zone: r.zone,
      w: +(r.x1 - r.x0).toFixed(2), d: +(r.y1 - r.y0).toFixed(2),
      a: +((r.x1 - r.x0) * (r.y1 - r.y0)).toFixed(1) }))
      .sort((a, b) => b.a - a.a).slice(0, 8);
    const lib = (M.equipmentLibrary || []).map(d => d.id + ' ' + d.name + ' ' + d.w + 'x' + d.d + 'x' + d.h);
    return { rooms: rooms, lib: lib, floors: M.floors.map(f => f.level + '@' + f.elev) };
  });
  console.log('楼层：', o.floors.join(', '));
  console.log('最大的几个房间：'); o.rooms.forEach(r => console.log('  ', JSON.stringify(r)));
  console.log('设备库：'); o.lib.forEach(s => console.log('  ', s));
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
