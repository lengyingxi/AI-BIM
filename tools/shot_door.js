/* 开一个会撞线管的门，验证"改线走向"真的画在屏幕上。
   用法：SITE=http://127.0.0.1:8899 node tools/shot_door.js */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = process.env.SITE || 'http://127.0.0.1:8899';
const OUT = 'outputs';
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1500, height: 900 }
  });
  const p = await b.newPage();
  await p.goto(SITE + '/index.html', { waitUntil: 'networkidle2' });
  await sleep(2400);
  await p.evaluate(() => {
    const t = document.querySelector('[data-close="pTree"]'); if (t) t.click();
    if (BIM.detail && BIM.detail.setCeiling) BIM.detail.setCeiling(false);
  });

  /* 用 mcp 调用开门：挑一面"墙中间确实埋着插座管"的墙，让系统走改线流程 */
  const r = await p.evaluate(async () => {
    const E = BIM.elec, M = BIM_MODEL;
    let tgt = null;
    for (const room of M.rooms) {
      for (const k of ['north', 'south', 'east', 'west']) {
        const w = M.walls.find(x => x.id === (room.sides || {})[k]);
        if (!w || w.kind === 'ext') continue;
        const L = Math.hypot(w.p2[0] - w.p1[0], w.p2[1] - w.p1[1]);
        /* 只挑"墙中间开 1 m 门一定会撞上"的那面墙，否则系统会自己顺墙挪开，看不到改线 */
        const hit = E.hitWall(w, { at: L / 2, w: 1.0, h: 2.1, sill: 0 });
        if (hit.length) { tgt = { room: room, side: k, wall: w, hits: hit.length }; break; }
      }
      if (tgt) break;
    }
    if (!tgt) return { ok: false, why: '没找到会撞线管的墙' };
    const res = await BIM.mcp.call('open_door', { room: tgt.room.num, side: tgt.side, width: 1.0, height: 2.1 });
    await new Promise(r => setTimeout(r, 900));
    const grp = BIM.scene.root().getObjectByName('reroutes');
    return {
      ok: res.ok, room: tgt.room.num, side: tgt.side, hits: tgt.hits,
      reroutes: grp ? grp.children.length : 0,
      say: res.say || ''
    };
  });
  console.log('开门 ' + (r.ok ? '成功' : '失败') + '：' + r.room + ' ' + r.side +
    '（原位置撞 ' + r.hits + ' 根管），场景里改线对象 ' + r.reroutes + ' 个');
  await sleep(1200);
  await p.screenshot({ path: OUT + '/p5_door_reroute.png' });
  console.log('  → ' + OUT + '/p5_door_reroute.png');
  console.log('回复：' + (r.say || '').slice(0, 160));
  await b.close();
})();
