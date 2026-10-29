/* 朝向自检：12 类设备 × 多种落位方式，看「正面朝哪、前方还剩多少净空、背面贴哪面墙」。
   判定标准：
   - 背面贴墙（backGap ≤ 0.45）：正面必须朝房间里（前方净空 ≥ 0.55，不能冲墙）
   - 房间中间：正面必须朝门（与门的夹角 ≤ 90°）
   - 旋转后的占位必须真的在房间里
   跑法：node tools/orient2.js（需 tools/serve.py 在 8823 上） */
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new', args: ['--use-angle=swiftshader', '--window-size=1440,900']
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.goto('http://127.0.0.1:8823/', { waitUntil: 'networkidle2' });
  await sleep(3600);

  const table = await p.evaluate(() => {
    const out = [];
    const one = (roomNum, dev, pref) => {
      const room = BIM_MODEL.rooms.find(r => r.num === roomNum);
      const spot = BIM.app.spotFor(room, dev, pref);
      if (!spot) return { dev: dev.name, pref: String(pref), err: 'no spot' };
      const E = Object.assign({}, dev, { rot: spot.rot });
      BIM.app.placeAt(room, E, spot.x, spot.y, spot.ob);
      const eq = BIM.app.state.placed[BIM.app.state.placed.length - 1];
      const f = BIM.calc.foot(eq);
      const rot = eq.rot;
      const fx = Math.sin(rot), fy = -Math.cos(rot);
      const hx = f.w / 2, hy = f.d / 2;
      const free = Math.abs(fx) > 0.5
        ? (fx > 0 ? room.x1 - (eq.x + hx) : (eq.x - hx) - room.x0)
        : (fy > 0 ? room.y1 - (eq.y + hy) : (eq.y - hy) - room.y0);
      const face = Math.abs(fx) > 0.5 ? (fx > 0 ? '东' : '西') : (fy > 0 ? '北' : '南');
      const back = {
        西: (eq.x - hx) - room.x0, 东: room.x1 - (eq.x + hx),
        南: (eq.y - hy) - room.y0, 北: room.y1 - (eq.y + hy)
      };
      const bw = Object.keys(back).sort((a, c) => back[a] - back[c])[0];
      const ds = (BIM_MODEL.doors || []).filter(d => d.floor === room.floor && (d.rooms || []).indexOf(room.id) >= 0);
      let doorAng = null;
      if (ds.length) {
        let best = ds[0], bd = 1e9;
        ds.forEach(d => { const dd = Math.hypot(d.pos[0] - eq.x, d.pos[1] - eq.y); if (dd < bd) { bd = dd; best = d; } });
        const tx = (best.pos[0] - eq.x) / (bd || 1), ty = (best.pos[1] - eq.y) / (bd || 1);
        doorAng = +(Math.acos(Math.max(-1, Math.min(1, fx * tx + fy * ty))) * 180 / Math.PI).toFixed(0);
      }
      const r = BIM.calc.eqRect(eq);
      const inside = r.x0 >= room.x0 - 0.02 && r.x1 <= room.x1 + 0.02 && r.y0 >= room.y0 - 0.02 && r.y1 <= room.y1 + 0.02;
      return {
        dev: dev.name, pref: pref || '-', rot: +rot.toFixed(2), face,
        frontFree: +free.toFixed(2), backWall: bw, backGap: +back[bw].toFixed(2),
        doorAng, inside, at: [+eq.x.toFixed(2), +eq.y.toFixed(2)]
      };
    };
    ['201', '202', '203', '204'].forEach(rn => {
      BIM_MODEL.equipmentLibrary.forEach((dev, j) => {
        const pref = ['wall', 'center', 'corner', null][j % 4];
        try { out.push(one(rn, dev, pref)); }
        catch (e) { out.push({ dev: dev.name, pref: String(pref), err: String(e).slice(0, 80) }); }
      });
    });
    return out;
  });

  let bad = 0;
  table.forEach(t => {
    if (t.err) { bad++; console.log('✗ ' + JSON.stringify(t)); return; }
    const wallMounted = t.backGap <= 0.45;
    const okFace = t.frontFree >= 0.55;
    const okDoor = wallMounted ? true : (t.doorAng == null || t.doorAng <= 91);
    const ok = okFace && okDoor && t.inside;
    if (!ok) bad++;
    console.log((ok ? '✓' : '✗') + ' ' + t.dev.padEnd(8) +
      ' pref=' + String(t.pref).padEnd(7) +
      ' rot=' + String(t.rot).padStart(5) +
      ' 正面朝' + t.face +
      ' 前方净空=' + String(t.frontFree).padStart(5) +
      ' 背面=' + t.backWall + '(' + t.backGap + ')' +
      ' 门夹角=' + (t.doorAng == null ? '-' : t.doorAng) +
      (t.inside ? '' : ' ❗出界'));
  });
  console.log('不合格 ' + bad + ' / ' + table.length);
  console.log('错误', errs.length ? errs.slice(0, 3) : '无');
  await b.close();
})();
