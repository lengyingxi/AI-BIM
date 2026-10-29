/* 开窗 + 流向 的验收：全走工具层（大模型/语音最终落到这同一套）
   重点验：
     ① 自然语言解析：1.8 米宽 2 米高 / 落地窗 / 靠窗 / 拆窗 / 列窗 / 查窗
     ② 开窗：落位、窗垛窗顶校核、mesh 真建出来
     ③ 不跟已有洞口打架（自动挪开 或 明确拒绝）
     ④ 拆窗：原有的拒绝、新增的能拆、能撤回
     ⑤ 流向：关阀即断流，开阀恢复；关掉流向状态清空
     ⑥ 吊顶 / 家具 显隐；开流向自动收吊顶
     ⑦ 工具栏三个新按钮不炸
*/
const puppeteer = require('puppeteer-core');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = 'http://127.0.0.1:8823';
const OUT = path.join(__dirname, '..', 'outputs') + '/';

let fail = 0;
const ok = (n, c, e) => { console.log((c ? '  ✅ ' : '  ❌ ') + n + (e !== undefined && e !== '' ? '  → ' + e : '')); if (!c) fail++; return c; };

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1600, height: 950 },
  });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await p.goto(SITE, { waitUntil: 'load' });
  await p.evaluate(() => window.BIM.agent.saveCfg({ endpoint: '', model: '', key: '' }));
  await sleep(1400);

  await p.evaluate(() => {
    window.T = {
      call: (n, a) => window.BIM.mcp.call(n, a || {}),
      S: window.BIM.scene,
      D: window.BIM.detail,
      N: window.BIM.nlp,
      A: window.BIM.agent,
      M: () => window.BIM.app.model(),
      st: () => window.BIM.app.state,
      wins: () => window.BIM.app.model().windows || [],
      plan: t => window.BIM.agent.local(t),
      chat: () => document.getElementById('chat').innerText
    };
  });

  /* ---------- 1. 自然语言 ---------- */
  console.log('\n【1】自然语言解析');
  const nlp = await p.evaluate(() => {
    const f = t => window.BIM.nlp.parse(t);
    const a = f('在 202 南墙开一个 1.8 米宽 2 米高的窗');
    const c = f('202 开个落地窗');
    const d = f('在 201 靠窗开个窗户');
    return {
      a: { intent: a.intent, w: a.width, h: a.winH, sill: a.sill, side: a.side, room: a.room && a.room.num },
      c: { intent: c.intent, kind: c.winKind, sill: c.sill, h: c.winH },
      d: { intent: d.intent, pref: d.pref, room: d.room && d.room.num }
    };
  });
  ok('「1.8 米宽 2 米高」认成窗', nlp.a.intent === 'window', nlp.a.intent);
  ok('宽 1.8 / 高 2.0 / 台 0.9', Math.abs(nlp.a.w - 1.8) < .01 && Math.abs(nlp.a.h - 2) < .01 && Math.abs(nlp.a.sill - .9) < .01,
    nlp.a.w + '×' + nlp.a.h + ' 台 ' + nlp.a.sill);
  ok('问到 202 房间', nlp.a.room === '202', nlp.a.room);
  ok('「落地窗」→ 窗台 0.12', nlp.c.kind === 'floor' && nlp.c.sill <= .15, nlp.c.kind + ' 台 ' + nlp.c.sill);
  ok('「靠窗」→ 方位偏好 window', nlp.d.pref === 'window', nlp.d.pref);

  const plan = await p.evaluate(() => ({
    off: window.BIM.agent.local('把 202 的窗户拆了').steps,
    list: window.BIM.agent.local('202 有几个窗').steps,
    info: window.BIM.agent.local('202 这个窗多宽').steps,
    add: window.BIM.agent.local('在 202 开一个 1.8 米的窗').steps
  }));
  ok('本地规划「拆窗」→ windowoff', plan.off.length && plan.off[0].act === 'windowoff', JSON.stringify(plan.off));
  ok('本地规划「几个窗」→ wins', plan.list.length && plan.list[0].act === 'wins', JSON.stringify(plan.list));
  ok('本地规划「窗多宽」→ wininfo（不会被当成开窗）', plan.info.length && plan.info[0].act === 'wininfo', JSON.stringify(plan.info));
  ok('本地规划「开一个 1.8 米的窗」仍是 window', plan.add.length && plan.add[0].act === 'window', (plan.add[0] || {}).act);

  /* ---------- 2. 开窗 ---------- */
  console.log('\n【2】开窗：落位 + 建模 + 校核');
  const before = await p.evaluate(() => window.T.wins().length);
  const w1 = await p.evaluate(async () => {
    const r = await window.T.call('open_window', { room: '202', width: 1.8, height: 1.8, sill: .9 });
    const w = window.T.wins();
    const d = w[w.length - 1];
    const g = window.T.S.floorOf(d.floor).g.getObjectByName('win-' + d.id);
    return {
      ok: r.ok, say: r.say, data: r.data, n: w.length,
      d: { id: d.id, name: d.name, w: d.w, h: d.h, sill: d.sill, added: !!d.added, wall: d.wall },
      mesh: !!g, meshKids: g ? (() => { let c = 0; g.traverse(o => { if (o.isMesh) c++; }); return c; })() : 0,
      glass: g ? (() => { let t = false; g.traverse(o => { if (o.isMesh && o.material && o.material.transparent) t = true; }); return t; })() : false
    };
  });
  ok('开出来 1 樘', w1.ok && w1.n === before + 1, w1.say);
  ok('记录里标了 added', w1.d.added === true, w1.d.name + ' @ ' + w1.d.wall);
  ok('尺寸落到 1.8 × 1.8 / 台 0.9', Math.abs(w1.d.w - 1.8) < .01 && Math.abs(w1.d.h - 1.8) < .01 && Math.abs(w1.d.sill - .9) < .01,
    w1.d.w + '×' + w1.d.h + ' 台 ' + w1.d.sill);
  ok('场景里真建出来了（框 + 玻璃）', w1.mesh && w1.meshKids >= 2 && w1.glass === true,
    w1.meshKids + ' 个 mesh，玻璃=' + w1.glass);
  ok('返回了窗宽窗高窗台高', !!(w1.data && w1.data.width != null), JSON.stringify(w1.data));

  await p.screenshot({ path: OUT + 'wf-window.png' });

  /* ---------- 3. 落地窗 ---------- */
  console.log('\n【3】落地窗（窗台 0.1）');
  const w2 = await p.evaluate(async () => {
    const r = await window.T.call('open_window', { room: '201', width: 1.2, height: 2.4, sill: .1 });
    const w = window.T.wins();
    const d = w[w.length - 1];
    return { ok: r.ok, say: r.say, sill: d.sill, h: d.h, top: d.sill + d.h, added: !!d.added };
  });
  ok('落地窗开出来了', w2.ok && w2.added, w2.say);
  ok('窗台压到 0.1~0.15', w2.sill >= .09 && w2.sill <= .15, String(w2.sill));
  ok('窗顶没穿到梁里（≤ 3.4）', w2.top < 3.4, '窗顶 ' + w2.top.toFixed(2));

  /* ---------- 4. 不跟已有洞口打架 ---------- */
  console.log('\n【4】同一面墙连开两樘：不许叠在一起');
  const w3 = await p.evaluate(async () => {
    const prev = window.T.wins().filter(x => x.added);
    const last = prev[prev.length - 1];
    const r = await window.T.call('open_window', { room: '201', width: 1.2, height: 2.4, sill: .1 });
    const w = window.T.wins();
    const d = w[w.length - 1];
    const dx = d.pos[0] - last.pos[0], dy = d.pos[1] - last.pos[1];
    return { ok: r.ok, say: r.say, gap: Math.sqrt(dx * dx + dy * dy), need: (d.w + last.w) / 2 + .3, sameWall: d.wall === last.wall, n: w.length };
  });
  if (w3.ok) {
    ok('第二樘自动挪开了（不重叠）', !w3.sameWall || w3.gap >= w3.need - .02,
      '间距 ' + w3.gap.toFixed(2) + ' m，至少要大 ' + w3.need.toFixed(2));
  } else {
    ok('开不了时明确说了原因（也是合格表现）', /冲突|腾不出|不够|撞/.test(w3.say || ''), w3.say);
  }

  /* ---------- 5. 拆窗 ---------- */
  console.log('\n【5】拆窗：原有的拆不了，新增的能拆');
  const off1 = await p.evaluate(async () => {
    const old = window.T.wins().find(x => !x.added);
    const r = await window.T.call('remove_window', { window: old.id });
    return { ok: r.ok, say: r.say, n: window.T.wins().length };
  });
  ok('原有窗拒绝拆', off1.ok === false && /原有/.test(off1.say || ''), off1.say);

  const off2 = await p.evaluate(async () => {
    const w = window.T.wins();
    const mine = w.filter(x => x.added);
    const t = mine[mine.length - 1];
    const n0 = w.length;
    const r = await window.T.call('remove_window', { window: t.id });
    return { ok: r.ok, say: r.say, n0, n1: window.T.wins().length, name: t.name };
  });
  ok('新增窗拆掉了', off2.ok && off2.n1 === off2.n0 - 1, off2.say);

  const undo = await p.evaluate(async () => {
    const n0 = window.T.wins().length;
    const r = await window.T.call('undo_last', {});
    return { ok: r.ok, say: r.say, n0, n1: window.T.wins().length };
  });
  ok('撤回把窗开回来了', undo.ok && undo.n1 === undo.n0 + 1, undo.say);

  /* ---------- 6. 吊顶 / 家具 ---------- */
  console.log('\n【6】吊顶 / 家具显隐');
  const vis = await p.evaluate(() => {
    const fg = window.T.S.floorOf(2);
    const u = fg.g.userData.deco || { ceil: [], furn: [] };
    const any = arr => arr.some(g => g.visible);
    window.T.S.setCeiling(false);
    const cOff = any(u.ceil);
    window.T.S.setCeiling(true);
    const cOn = any(u.ceil);
    window.T.S.setFurniture(false);
    const fOff = any(u.furn);
    window.T.S.setFurniture(true);
    const fOn = any(u.furn);
    return { nCeil: u.ceil.length, nFurn: u.furn.length, cOff, cOn, fOff, fOn };
  });
  ok('2 楼有吊顶和家具（' + vis.nCeil + ' / ' + vis.nFurn + ' 组）', vis.nCeil > 0 && vis.nFurn > 0);
  ok('吊顶能收也能放', vis.cOff === false && vis.cOn === true, '收=' + vis.cOff + ' 放=' + vis.cOn);
  ok('家具能收也能放', vis.fOff === false && vis.fOn === true, '收=' + vis.fOff + ' 放=' + vis.fOn);

  /* ---------- 7. 流向 ---------- */
  console.log('\n【7】流向：关阀即断流');
  const fl0 = await p.evaluate(async () => {
    window.T.S.setFocus(2);
    window.T.S.setFlow(true);
    await new Promise(r => setTimeout(r, 600));
    const st = window.T.D.flowState();
    return { st, ceil: window.T.D.on.ceil, grp: !!window.T.S.root().getObjectByName('flow') };
  });
  ok('2 楼流向建出来了', !!fl0.st && fl0.st.count > 0, fl0.st ? fl0.st.count + ' 段管' : 'null');
  ok('开流向自动收起吊顶', fl0.ceil === false, String(fl0.ceil));
  ok('场景里有 flow 组', fl0.grp === true);

  const closed = await p.evaluate(async () => {
    const M = window.T.M();
    const vs = M.valves.filter(x => x.floor === 2);
    const rows = [];
    for (const v of vs) {
      await window.T.call('toggle_valve', { valve: v.id, action: 'close' });
      await new Promise(x => setTimeout(x, 260));
      const st = window.T.D.flowState();
      rows.push({ v: v.id, blocked: st ? st.blocked.length : -1, count: st ? st.count : 0, open: v.open });
      await window.T.call('toggle_valve', { valve: v.id, action: 'open' });
      await new Promise(x => setTimeout(x, 120));
    }
    const top = rows.slice().sort((a, b) => b.blocked - a.blocked)[0];
    return { rows, top };
  });
  const hit = closed.rows.filter(r => r.blocked > 0);
  ok('关阀后有断流段（' + hit.length + '/' + closed.rows.length + ' 个阀会断流）', hit.length > 0,
    hit.map(r => r.v + '→' + r.blocked + '段').join('  ') || '一个都没断（关阀后 open=' +
    closed.rows.map(r => r.v + ':' + r.open).join(',') + '）');
  ok('箭头总数不变（10 段管都在，只是换了颜色）', closed.rows.every(r => r.count === closed.top.count) && closed.top.count > 0,
    String(closed.top.count));

  // 关掉影响最大的那个阀，截图
  await p.evaluate(async v => {
    await window.T.call('toggle_valve', { valve: v, action: 'close' });
    await new Promise(x => setTimeout(x, 500));
  }, closed.top.v);
  await p.screenshot({ path: OUT + 'wf-flow-dead.png' });

  const opened = await p.evaluate(async v => {
    const r = await window.T.call('toggle_valve', { valve: v, action: 'open' });
    await new Promise(x => setTimeout(x, 500));
    const st = window.T.D.flowState();
    return { ok: r.ok, blocked: st ? st.blocked : null };
  }, closed.top.v);
  ok('再打开就恢复通流', opened.ok && (opened.blocked || []).length === 0, '剩 ' + (opened.blocked || []).length + ' 段断流');

  const flOff = await p.evaluate(() => { window.T.S.setFlow(false); return window.T.D.flowState(); });
  ok('关掉流向状态清空', flOff === null, String(flOff));

  /* ---------- 8. 工具栏 ---------- */
  console.log('\n【8】工具栏三个新按钮');
  const tb = await p.evaluate(async () => {
    const q = k => document.querySelector('#toolbar button[data-k="' + k + '"]');
    const has = ['flow', 'ceil', 'furn'].every(k => !!q(k));
    const c0 = window.T.D.on.ceil;
    q('ceil').click();                       // 翻一次
    const afterCeil = q('ceil').classList.contains('on');
    const c1 = window.T.D.on.ceil;
    q('ceil').click();                       // 翻回来
    q('flow').click();                       // 开流向（会自动收吊顶）
    await new Promise(r => setTimeout(r, 400));
    const st = {
      flowOn: q('flow').classList.contains('on'),
      ceilOn: q('ceil').classList.contains('on'),
      detail: { flow: window.T.D.on.flow, ceil: window.T.D.on.ceil }
    };
    q('flow').click();                       // 关掉
    await new Promise(r => setTimeout(r, 200));
    return { has, c0, afterCeil, c1, st, flowOff: q('flow').classList.contains('on') };
  });
  ok('三个按钮都在', tb.has);
  ok('点吊顶能切换（' + tb.c0 + ' → ' + tb.c1 + '）', tb.afterCeil === tb.c1 && tb.c1 === !tb.c0);
  ok('点流向能开', tb.st.flowOn === true && tb.st.detail.flow === true);
  ok('开流向时吊顶按钮同步变灰（不是骗人）', tb.st.ceilOn === false && tb.st.detail.ceil === false,
    '按钮 on=' + tb.st.ceilOn + ' 实际=' + tb.st.detail.ceil);
  ok('再点一次能关', tb.flowOff === false);

  await p.evaluate(() => { window.T.S.setFocus(2); window.T.S.setFlow(true); window.T.S.setCam(6, 8.6, 6, 16, 7.2, -7); });
  await sleep(1400);
  await p.screenshot({ path: OUT + 'wf-flow-live.png' });

  console.log('\n报错：', errs.length ? errs.join(' | ') : '无');
  console.log(fail ? '\n❌ 失败 ' + fail + ' 条' : '\n✅ 全部通过');
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
