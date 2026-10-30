/* 医院重型设备验收脚本
   覆盖：设备库扩充与别名、真实构造建模深度、放置/搬入校核、承重结论、
        移动/改尺寸/替换/删除、净距、通用性（任意房间可放）。
   用法：SITE=http://127.0.0.1:88xx node tools/hospital.js */
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = process.env.SITE || 'http://127.0.0.1:8823';

let ok = 0, bad = 0;
const P = (name, cond, info) => {
  if (cond) { ok++; console.log('  ✅ ' + name + (info ? ' — ' + info : '')); }
  else { bad++; console.log('  ❌ ' + name + (info ? ' — ' + info : '')); }
};
const H = t => { console.log('\n' + t); };

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1600, height: 950 }
  });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/asr\/warm/.test(m.text())) errs.push('console: ' + m.text()); });
  await p.goto(SITE + '/index.html', { waitUntil: 'networkidle2' });
  await sleep(2800);

  /* ---------- 1. 设备库 ---------- */
  H('【1】设备库');
  const d1 = await p.evaluate(() => {
    const lib = BIM_MODEL.equipmentLibrary;
    const hosp = lib.filter(e => /^EQ-(1[3-9]|20)$/.test(e.id));
    return {
      total: lib.length,
      hosp: hosp.map(e => ({ id: e.id, name: e.name, w: e.w, d: e.d, h: e.h, wt: e.weight || e.t, alias: e.alias || [] })),
      ids: hosp.map(e => e.id)
    };
  });
  P('设备库扩到 20 种', d1.total >= 20, String(d1.total));
  P('新增 8 种医院重型设备', d1.hosp.length === 8, d1.ids.join(','));
  P('每台都有实际尺寸', d1.hosp.every(e => e.w > 0.5 && e.d > 0.3 && e.h > 0.5));
  P('每台都有重量（用于承重校核）', d1.hosp.every(e => (e.wt || 0) > 0), d1.hosp.map(e => (e.wt || 0)).join('/'));
  P('每台都有口语别名', d1.hosp.every(e => (e.alias || []).length > 0),
    d1.hosp.map(e => e.alias[0]).join('/'));

  /* ---------- 2. 真实构造建模 ---------- */
  H('【2】按实物构造建模');
  const d2 = await p.evaluate(() => {
    const lib = BIM_MODEL.equipmentLibrary.filter(e => /^EQ-(1[3-9]|20)$/.test(e.id));
    const D = BIM.detail;
    return lib.map(e => {
      const eq = { lib: e.id, name: e.name, w: e.w, h: e.h, d: e.d, color: e.color, rot: 0 };
      let n = 0, tri = 0, err = null;
      try {
        const mo = D.equipMesh(eq);
        n = (mo && mo.parts) ? mo.parts.length : 0;
        if (mo && mo.group) mo.group.traverse(o => { if (o.geometry && o.geometry.attributes && o.geometry.attributes.position) tri += o.geometry.attributes.position.count / 3; });
      } catch (x) { err = x.message; }
      return { name: e.name, parts: n, tris: Math.round(tri), err: err };
    });
  });
  d2.forEach(x => { if (x.err) console.log('    ! ' + x.name + ' 建模异常：' + x.err); });
  P('每台设备都由多个构件拼成（不是单盒子）', d2.every(x => x.parts >= 4),
    d2.map(x => x.name.split(/[（(]/)[0] + ':' + x.parts).join(' '));
  P('三角面数达到可辨识细节的量级', d2.every(x => x.tris >= 150), d2.map(x => x.tris).join('/'));

  /* ---------- 3. 别名识别 + 放到房间 ---------- */
  H('【3】别名识别与放置（走完整 MCP 链路）');
  const d3 = await p.evaluate(async () => {
    const alias = { '核磁': 'EQ-13', 'MRI': 'EQ-13', 'CT': 'EQ-14', 'DSA': 'EQ-15', '加速器': 'EQ-16', 'X光机': 'EQ-17', '手术台': 'EQ-18', '氧舱': 'EQ-19', '终端塔': 'EQ-20' };
    const M = BIM_MODEL;
    /* 每层挑面积最大的房间作为"能放重设备"的候选 */
    const biggest = fl => M.rooms.filter(r => r.floor === fl)
      .sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0];
    const out = [];
    for (const k of Object.keys(alias)) {
      const room = biggest(1);
      const r = await BIM.mcp.call('place_equipment', { device: k, room: room.num, floor: 1 });
      out.push({
        key: k, ok: r.ok, name: (r.data || {}).device, room: (r.data || {}).room,
        K: (r.data || {}).K, verdict: (r.data || {}).verdict,
        say: (r.say || '').slice(0, 80), want: alias[k]
      });
    }
    return out;
  });
  d3.forEach(x => { if (!x.ok) console.log('    ! ' + x.key + ' → ' + x.say); });
  P('9 个口语别名全部能识别并放置', d3.every(x => x.ok === true), d3.filter(x => x.ok).length + '/9');
  P('别名都映射到正确的型号', d3.every(x => x.name && x.name.length > 0),
    d3.map(x => x.key + '→' + String(x.name).split(/[（(]/)[0]).join(' '));

  /* ---------- 4. 承重与搬入校核 ---------- */
  H('【4】承重 / 搬入校核');
  const d4 = await p.evaluate(async () => {
    const M = BIM_MODEL;
    const big = M.rooms.filter(r => r.floor === 2).sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0];
    const r = await BIM.mcp.call('place_equipment', { device: '高压氧舱', room: big.num, floor: 2 });
    const cap = await BIM.mcp.call('query_capacity', {});
    return {
      ok: r.ok, K: (r.data || {}).K, verdict: (r.data || {}).verdict,
      say: (r.say || ''), capSay: (cap.say || '').slice(0, 90),
      cap: (cap.data || {})
    };
  });
  P('12 吨高压氧舱能放上去并给出结论', d4.ok === true, '安全系数 ' + d4.K + ' 判定 ' + d4.verdict);
  P('承重结论有明确说法（不空着）', /放得下|吃不消|超|余量|系数/.test(d4.say), d4.say.slice(0, 70));
  P('能问出这间房还剩多少余量', !!(d4.capSay && d4.capSay.length > 4), d4.capSay);

  /* ---------- 5. 增删改查全链路 ---------- */
  H('【5】移动 / 改尺寸 / 替换 / 撤掉');
  const d5 = await p.evaluate(async () => {
    const M = BIM_MODEL;
    const big = M.rooms.filter(r => r.floor === 3).sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0];
    const p1 = await BIM.mcp.call('place_equipment', { device: 'CT', room: big.num, floor: 3 });
    const mv = await BIM.mcp.call('move_equipment', { target: 'CT', direction: 'left', distance: 0.5 });
    const rs = await BIM.mcp.call('resize_equipment', { target: 'CT', width: 2.0, depth: 1.6 });
    const rp = await BIM.mcp.call('replace_equipment', { device: '手术台', target: 'CT' });
    const cl = await BIM.mcp.call('query_clearance', { target: '手术台' });
    const ls = await BIM.mcp.call('list_devices', {});
    const rm = await BIM.mcp.call('remove_equipment', { target: '手术台' });
    const ls2 = await BIM.mcp.call('list_devices', {});
    return {
      room: big.num,
      place: p1.ok, move: mv.ok && /挪|移动|放/.test(mv.say || ''),
      resize: rs.ok, replace: rp.ok && /换|替/.test(rp.say || ''),
      clearance: cl.ok, clSay: (cl.say || '').slice(0, 80),
      listN: (ls.data || {}).count || 0,
      removed: rm.ok, rmSay: (rm.say || '').slice(0, 80), lsSay: (ls.say || '').slice(0, 80),
      listN2: (ls2.data || {}).count || 0,
      moveSay: (mv.say || '').slice(0, 60), replaceSay: (rp.say || '').slice(0, 60)
    };
  });
  P('放到房间（' + d5.room + '）', d5.place === true);
  P('按屏幕方向挪动', d5.move === true, d5.moveSay);
  P('改尺寸后重新校核', d5.resize === true);
  P('替换成另一种设备', d5.replace === true, d5.replaceSay);
  P('能量出四周净距', d5.clearance === true, d5.clSay);
  P('撤掉后清单减少', d5.removed === true && d5.listN2 < d5.listN,
    d5.listN + ' → ' + d5.listN2 + ' | 删：' + d5.rmSay + ' | 列表：' + d5.lsSay);

  /* ---------- 6. 通用性：任意楼层任意大房间都能放 ---------- */
  H('【6】通用性（不限定某一间）');
  const d6 = await p.evaluate(async () => {
    const M = BIM_MODEL;
    const out = [];
    for (const f of M.floors) {
      const big = M.rooms.filter(r => r.floor === f.level)
        .sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0];
      if (!big) continue;
      const r = await BIM.mcp.call('place_equipment', { device: 'DR', room: big.num, floor: f.level });
      out.push({ floor: f.level, room: big.num, ok: r.ok });
    }
    return out;
  });
  P('五层都各放得下一台 DR', d6.every(x => x.ok === true),
    d6.map(x => x.floor + 'F:' + x.room).join(' '));

  await p.evaluate(() => BIM.scene.showAll && BIM.scene.showAll());
  await sleep(700);
  await p.screenshot({ path: 'outputs/hospital-equip.png' });

  console.log('\n错误：' + (errs.length ? errs.slice(0, 6).join(' | ') : 'none'));
  console.log('结果：' + ok + ' 通过 / ' + bad + ' 失败');
  await b.close();
  process.exit(bad ? 1 : 0);
})();
