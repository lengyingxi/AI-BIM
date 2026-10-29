/* 诊断：505 的门为什么"原位一点也扩不了" */
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = 'http://127.0.0.1:8823';

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1400, height: 900 },
  });
  const p = await b.newPage();
  p.on('pageerror', e => console.log('pageerror:', e.message));
  await p.goto(SITE + '/index.html', { waitUntil: 'networkidle2' });
  await sleep(2500);

  const r = await p.evaluate(() => {
    const M = window.BIM_MODEL, S = window.BIM.scene, C = window.BIM.calc;
    const room = M.rooms.find(x => x.num === '505');
    const out = { room: room && { id: room.id, x0: room.x0, x1: room.x1, y0: room.y0, y1: room.y1, live: room.live } };
    const all = M.doors.filter(d => (d.rooms || []).indexOf(room.id) >= 0);
    const doors = all.filter(d => C.doorInRoom(d, room));
    out.rawCount = all.length;
    out.exactCount = doors.length;
    out.rawAt = all.map(d => d.name + '@' + (S.doorAt ? S.doorAt(d, M.walls.find(w => w.id === d.wall)) : '?'));
    out.doors = doors.map(d => {
      const wall = M.walls.find(w => w.id === d.wall);
      const at = S.doorAt ? S.doorAt(d, wall) : null;
      // 墙轴投影：看清房间在这面墙上占的是哪一段
      let span = null;
      if (wall) {
        const [ax, ay] = wall.p1, [bx, by] = wall.p2;
        const L = Math.hypot(bx - ax, by - ay);
        const ux = (bx - ax) / L, uy = (by - ay) / L;
        const ts = [[room.x0, room.y0], [room.x1, room.y0], [room.x0, room.y1], [room.x1, room.y1]]
          .map(q => +(((q[0] - ax) * ux + (q[1] - ay) * uy)).toFixed(3));
        span = { p1: wall.p1, p2: wall.p2, L: +L.toFixed(3), ts: ts, lo: Math.min.apply(null, ts), hi: Math.max.apply(null, ts), t: wall.t };
      }
      const side = C.doorRoom ? C.doorRoom({ wall: wall, at: at, w: d.w, room: room, self: d }) : null;
      const plan = C.widenPlan ? C.widenPlan({ wall: wall, at: at, w: d.w, h: d.h, need: 1.35, room: room, equipments: [], self: d }) : null;
      return {
        name: d.name, w: d.w, h: d.h, at: at, wall: d.wall, span: span,
        side: side && { left: side.left, right: side.right, nearL: side.nearL, nearR: side.nearR },
        plan: plan && {
          D: plan.D, left: plan.side.left, right: plan.side.right,
          best: plan.best && { mode: plan.best.mode, at: plan.best.at, w: plan.best.w, why: plan.best.why },
          cands: plan.cands.map(c => ({ mode: c.mode, at: c.at, w: c.w, pass: c.pass, blocks: (c.chk.blocks || []).map(x => x.t) })),
          reach: plan.reach
        }
      };
    });
    return out;
  });
  console.log(JSON.stringify(r, null, 1).slice(0, 3000));
  await b.close();
})();
