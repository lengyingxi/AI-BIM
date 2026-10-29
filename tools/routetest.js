const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
global.window = global;
global.THREE = require(path.join(root, 'web/js/vendor/three.min.js'));
require(path.join(root, 'web/data/model-data.js'));
require(path.join(root, 'web/js/routes.js'));

const M = window.BIM_MODEL;
const R = window.BIM.routes.prepare(M);
const attach = M.rooms.filter(r => (R.roomDucts[r.id] || []).length).length;
console.log('房间挂到风管上的', attach + '/' + M.rooms.length);
const noDuct = M.rooms.filter(r => !(R.roomDucts[r.id] || []).length).slice(0, 8).map(r => r.num);
console.log('没挂上的房间样本', noDuct.join(','));

/* 用一棵真实的子树验证：主阀 → 各支阀的 serves 房间 */
function subtree(v) {
  let out = (v.serves || []).slice();
  M.valves.filter(k => k.parent === v.id).forEach(k => { out = out.concat(subtree(k)); });
  return out;
}
let ok = 0, fail = 0, total = 0;
const paths = new Set();
M.valves.filter(v => v.kind === 'main').forEach(mv => {
  const rooms = Array.from(new Set(subtree(mv)));
  rooms.forEach(rid => {
    total++;
    const p = window.BIM.routes.pathToRoom(M, mv, rid);
    if (p && p.length) { ok++; paths.add(p.join('>')); } else fail++;
  });
});
console.log('主阀→房间 可算路由', ok + '/' + total, '不同路径', paths.size);

/* 支阀：到它自己服务的房间 */
let ok2 = 0, t2 = 0;
M.valves.filter(v => (v.serves || []).length).forEach(v => {
  v.serves.forEach(rid => {
    t2++;
    const p = window.BIM.routes.pathToRoom(M, v, rid);
    if (p && p.length) ok2++;
  });
});
console.log('支阀→自身房间 可算路由', ok2 + '/' + t2);

const mv = M.valves.find(v => v.kind === 'main' && v.floor === 4);
if (mv) {
  const g = window.BIM.routes.geoReach(M, mv);
  console.log('4F 主阀几何可达', g.rooms.length, '间 /', g.paths.length, '条路径');
  const b = window.BIM.routes.bounds(M, g.paths[0] ? g.paths[0].ids : []);
  console.log('第一条路径包围盒', b);
}

/* 导入模型：自动补层级 */
const txt = fs.readFileSync(path.join(root, 'outputs/AIBIM_Haibin_Tower_A.ifc'), 'utf8');
require(path.join(root, 'web/js/ifc.js'));
const M1 = window.BIM.ifc.parse(txt);
window.BIM.routes.prepare(M1);
const built = window.BIM.routes.buildTree(M1);
console.log('\n导入模型补层级:', built, '有 parent 的阀', M1.valves.filter(v => v.parent).length + '/' + M1.valves.length);
const mv4 = M1.valves.find(v => v.kind === 'main' && v.floor === 4);
if (mv4) {
  const g = window.BIM.routes.geoReach(M1, mv4);
  let n = 0;
  const walk = v => { n += (v.serves || []).length; M1.valves.filter(k => k.parent === v.id).forEach(walk); };
  walk(mv4);
  console.log('4F 主阀 层级影响房间', n, '几何可达', g.rooms.length);
  const p = window.BIM.routes.pathToRoom(M1, mv4, (mv4.serves || [])[0] || '');
  console.log('路径样本', p);
}
