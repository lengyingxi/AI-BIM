/* 离线验证：IFC 解析 + 管线路由（node 环境跑一遍，不依赖浏览器） */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
global.window = global;

const THREE = require(path.join(root, 'web/js/vendor/three.min.js'));
global.THREE = THREE;

require(path.join(root, 'web/data/model-data.js'));
require(path.join(root, 'web/js/routes.js'));
require(path.join(root, 'web/js/ifc.js'));

const M0 = window.BIM_MODEL;
console.log('== 内置模型 ==', M0.meta.name, M0.rooms.length, 'rooms', M0.ducts.length, 'ducts', M0.valves.length, 'valves');
const R = window.BIM.routes.prepare(M0);
console.log('阀→管 挂接成功率', Object.keys(R.valveDuct).length + '/' + M0.valves.length);
const v = M0.valves.find(x => x.kind === 'main') || M0.valves[0];
const im = (function () {
  const rooms = [];
  const walk = x => { rooms.push(...(x.serves || [])); M0.valves.filter(k => k.parent === x.id).forEach(walk); };
  walk(v);
  return { n: rooms.length, v: v.name };
})();
console.log('主阀', im.v, '预置影响房间', im.n);

// 路由：从主阀到每个受影响房间
let okPath = 0, noPath = 0;
const seen = new Set();
M0.valves.filter(x => x.kind === 'main').forEach(mv => {
  M0.valves.filter(k => k.parent === mv.id || k.kind === 'zone').slice(0, 6).forEach(k => {
    (k.serves || []).forEach(rid => {
      const p = window.BIM.routes.pathToRoom(M0, mv, rid);
      if (p && p.length) okPath++; else noPath++;
      if (p && p.length) seen.add(p.join('>'));
    });
  });
});
console.log('主阀→房间 路由算得出', okPath, '算不出', noPath, '不同路径', seen.size);

const g = window.BIM.routes.geoReach(M0, v);
console.log('几何可达（内置模型）房间', g.rooms.length, '路径', g.paths.length);

/* ---- IFC 解析 ---- */
const txt = fs.readFileSync(path.join(root, 'outputs/AIBIM_Haibin_Tower_A.ifc'), 'utf8');
const t0 = Date.now();
const M1 = window.BIM.ifc.parse(txt);
const dt = Date.now() - t0;
console.log('\n== 解析自己生成的 IFC ==', dt + 'ms');
console.log('楼层', M1.floors.length, '房间', M1.rooms.length, '墙', M1.walls.length,
  '柱', M1.columns.length, '梁', M1.beams.length, '门', M1.doors.length, '窗', M1.windows.length,
  '风管', M1.ducts.length, '阀', M1.valves.length, '板', M1.slabs.length);
console.log('meta', JSON.stringify(M1.meta));
console.log('房间样本', JSON.stringify(M1.rooms.slice(0, 3).map(r => ({ n: r.num, f: r.floor, u: r.use, a: r.area, thk: r.slab.thk, live: r.live, sides: Object.keys(r.sides) }))));
console.log('墙样本', JSON.stringify(M1.walls.slice(0, 2).map(w => ({ id: w.id, p1: w.p1, p2: w.p2, t: w.t, h: w.h, rooms: w.rooms, ops: w.openings.length }))));
console.log('门样本', JSON.stringify(M1.doors.slice(0, 3)));
console.log('风管样本', JSON.stringify(M1.ducts.slice(0, 2)));
console.log('阀样本', JSON.stringify(M1.valves.slice(0, 2)));

const R1 = window.BIM.routes.prepare(M1);
console.log('导入模型 阀→管', Object.keys(R1.valveDuct).length + '/' + M1.valves.length);
if (M1.valves.length) {
  const g1 = window.BIM.routes.geoReach(M1, M1.valves[0]);
  console.log('导入模型 几何可达房间', g1.rooms.map(r => r.num).join(',') || '（无）', '路径', g1.paths.length);
}

/* 结构校核也要能在导入模型上跑 */
require(path.join(root, 'web/js/calc.js'));
const C = window.BIM.calc;
const room = M1.rooms.find(r => r.zone !== 'corr' && r.area > 20) || M1.rooms[0];
const eq = { id: 'T1', name: '空气压缩机', weight: 1800, w: 2.0, d: 1.2, h: 1.6 };
const cx = (room.x0 + room.x1) / 2, cy = (room.y0 + room.y1) / 2;
const ob = C.obstruct({ room, equip: eq, cx, cy, others: [] });
const r1 = C.check({ room, equip: eq, cx, cy, others: [] });
console.log('\n导入模型校核：', room.num, 'K=' + r1.K.toFixed(2), r1.v.tag, '板最多', (r1.Pmax_kg / 1000).toFixed(2) + 't', 'obstruct', ob.pass, ob.blocks.length);

/* 门 */
const wall = M1.walls.find(w => w.rooms.indexOf(room.id) >= 0 && w.h > 2.2);
if (wall) {
  const dc = C.door({ wall, at: 2.0, w: 1.2, h: 2.1, room, equipments: [] });
  const sg = C.suggestDoorAt({ wall, room, at: 0.3, w: 1.2, h: 2.1, equipments: [] });
  console.log('开门检查 pass=' + dc.pass, dc.blocks.map(b => b.t).join('|'), '建议位置', sg ? sg.at.toFixed(2) : '无');
}
