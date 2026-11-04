/* 视图呈现口径回归（用户明确要求的几条）
   ① "关闭空开"这种没指明哪一路的话，是命令不是查询 —— 必须真的关掉，且和明确指令同一个执行器；
   ② 查看楼层：墙体不隐藏，其它楼层 50% 半透明，顶梁也 50%；
   ③ 聚焦楼层 / 查看回路 / 看管线 都要做成 MCP 工具，大模型能调；
   ④ 管线只跟楼层有关：看某层只画那层的管；
   ⑤ 看所有管线时，整栋楼 20% 半透明（楼体还在，不是不显示）。
*/
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = process.env.SITE || 'http://127.0.0.1:8823';
const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let fail = 0;
const P = (n, c, e) => { console.log((c ? '  ✅ ' : '  ❌ ') + n + (e ? '  → ' + e : '')); if (!c) fail++; };
const H = t => console.log('\n' + t);

(async () => {
  const b = await puppeteer.launch({
    executablePath: EDGE, headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1600, height: 950 },
  });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/asr\/warm/.test(m.text())) errs.push(m.text()); });
  p.on('dialog', async d => { await d.dismiss(); });
  await p.goto(SITE + '/', { waitUntil: 'domcontentloaded' });
  await sleep(3800);

  const call = (n, a) => p.evaluate((n, a) => window.BIM.mcp.call(n, a), n, a);
  const state = () => p.evaluate(() => ({ body: window.BIM.scene.bodyVis(), cond: window.BIM.scene.conduitVis(), focus: window.BIM.scene.focus }));
  const onOf = lv => p.evaluate(l => window.BIM.elec.data.circuits.filter(c => c.floor === l).map(c => c.no + ':' + (c.on !== false)), lv);

  /* ---------- ① 模糊指令 ---------- */
  H('【1】"关闭空开"是命令，不是查询');
  const parse = await p.evaluate(() => {
    const N = window.BIM.nlp;
    return ['关闭空开', '关掉空开', '把空开关了', '关闭照明', '关闭第三回路'].map(t => {
      const o = N.parse(t);
      return { t: t, act: o.intent === 'circuitset' && o.action === 'off', intent: o.intent };
    });
  });
  P('这几句都解析成"关电"的动作', parse.every(x => x.act), JSON.stringify(parse.filter(x => !x.act)));
  await p.evaluate(() => { window.BIM.agent.mem.ctx.floor = 3; window.BIM.agent.mem.ctx.room = null; });
  const before = await onOf(3);
  await p.evaluate(() => { document.querySelector('#txt').value = ''; });
  await p.click('#txt'); await p.type('#txt', '关闭空开'); await p.click('#btnSend');
  /* 等这一句真的跑完（软件渲染 + 大模型一来一回，固定 sleep 容易读早了） */
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const done = await p.evaluate(() => !!window.BIM._lastPlan && !document.querySelector('.msg.typing'));
    if (done && (await onOf(3)).join() !== before.join()) break;
  }
  await sleep(600);
  const after = await onOf(3);
  P('说完"关闭空开"真的有一路被关掉', before.join() !== after.join(), before.join(' ') + ' → ' + after.join(' '));
  const plan = await p.evaluate(() => { const q = window.BIM._lastPlan; return q ? { src: q.source, tools: q.tools } : null; });
  P('走的是回路控制那条路（toggle_circuit / 本地 circuitset）',
    !!plan && (plan.src === 'local' || (plan.tools || []).indexOf('toggle_circuit') >= 0), JSON.stringify(plan));
  const say = await p.evaluate(() => {
    const els = Array.from(document.querySelectorAll('#chat .ai .body'));
    return els.length ? els[els.length - 1].innerText.replace(/\n/g, ' | ') : '';
  });
  P('回复说清了关的是第几回路、带哪几间房', /第\s*\d\s*回路/.test(say) && /间/.test(say), say.slice(0, 70));

  /* ---------- ② 楼层半透明 ---------- */
  H('【2】查看楼层（不看管线）：墙体不隐藏，50% 半透明，顶梁也 50%');
  /* 上一步"关闭空开"走的是回路控制，会把透视打开（那是"看管线"的档位）。
     这里验的是**普通聚焦楼层**，先把透视关掉，否则别层是收起的，口径不一样。 */
  await p.evaluate(() => { window.BIM.scene.showConduits(false); window.BIM.scene.setXray(false); });
  await sleep(300);
  await p.evaluate(() => window.BIM.scene.setFocus(3, false));
  await sleep(700);
  let s = await state();
  const fl = s.body.floors || {};
  const others = Object.keys(fl).filter(k => k !== '3');
  P('别的楼层还在画（visible=true，不是藏起来）', others.length > 0 && others.every(k => fl[k].visible === true),
    others.map(k => 'F' + k + ':' + fl[k].visible).join(' '));
  P('别的楼层墙体 50% 半透明', others.every(k => Math.abs(fl[k].opacity - .5) < .02),
    others.map(k => 'F' + k + ':' + fl[k].opacity).join(' '));
  P('顶梁 50% 半透明且可见', !!s.body.roof && s.body.roof.visible === true && Math.abs(s.body.roof.opacity - .5) < .02,
    JSON.stringify(s.body.roof));

  /* ---------- ③ MCP 工具 ---------- */
  H('【3】聚焦 / 看回路 / 看管线 都是 MCP 工具');
  const names = await p.evaluate(() => (window.BIM.mcp.tools || []).map(t => t.function.name));
  ['focus_floor', 'view_circuit', 'show_conduits'].forEach(n => P('工具 ' + n + ' 已注册', names.indexOf(n) >= 0));
  const r1 = await call('focus_floor', { floor: 2 });
  await sleep(400);
  P('focus_floor 能切层', r1 && r1.ok !== false && (await state()).focus === 2, JSON.stringify(r1).slice(0, 100));
  const r2 = await call('view_circuit', { floor: 2, circuit_no: 3 });
  await sleep(900);
  P('view_circuit 能只画某一路', r2 && r2.ok !== false && /完整路由/.test(JSON.stringify(r2)), JSON.stringify(r2.say || '').slice(0, 90));
  const iso = await p.evaluate(() => (window.BIM.scene.conduitStat ? window.BIM.scene.conduitStat().iso : null));
  P('看回路时管径与"看所有分路"一致（grow=1）', !!iso && iso.grow === 1, JSON.stringify(iso));
  P('看回路时接头也画（与"看所有分路"一致）', !!iso && iso.joints === true && iso.shaded === true,
    iso ? iso.boxes + ' 个方头，接头着色=' + iso.shaded : '无');

  /* ---------- ④ 管线跟楼层 ---------- */
  H('【4】管线只跟楼层有关；看某层管线时只留这一层');
  const r3 = await call('show_conduits', { scope: 'floor', floor: 2 });
  await sleep(900);
  s = await state();
  P('show_conduits(floor) 只画本层', r3 && r3.ok !== false && Object.keys(s.cond.byFloor).every(k => (k === '2' ? s.cond.byFloor[k].on > 0 : s.cond.byFloor[k].on === 0)),
    JSON.stringify(s.cond.byFloor));
  const fl2 = s.body.floors || {};
  const others2 = Object.keys(fl2).filter(k => k !== '2');
  P('别的楼层整层收起', others2.length > 0 && others2.every(k => fl2[k].visible === false),
    others2.map(k => 'F' + k + ':' + fl2[k].visible).join(' '));
  P('本层墙体与梁柱 50% 半透明', !!fl2['2'] && fl2['2'].visible === true &&
    Math.abs(fl2['2'].opacity - .5) < .02 && Math.abs(fl2['2'].beam - .5) < .02, JSON.stringify(fl2['2']));
  P('顶梁跟着收起', !!s.body.roof && s.body.roof.visible === false, JSON.stringify(s.body.roof));

  /* ---------- ⑤ 看所有管线 ---------- */
  H('【5】看所有管线：整栋 20% 半透明，楼体还在');
  const r4 = await call('show_conduits', { scope: 'all' });
  await sleep(800);
  s = await state();
  P('所有楼层的管都画出来', Object.keys(s.cond.byFloor).every(k => s.cond.byFloor[k].on > 0), JSON.stringify(s.cond.byFloor));
  const keys = Object.keys(s.body.floors);
  P('楼体 20% 半透明且都还在', r4 && r4.ok !== false && keys.every(k => s.body.floors[k].visible === true && Math.abs(s.body.floors[k].opacity - .2) < .02),
    keys.map(k => 'F' + k + ':' + s.body.floors[k].opacity).join(' '));
  P('顶梁也是 20%', !!s.body.roof && s.body.roof.visible === true && Math.abs(s.body.roof.opacity - .2) < .02, JSON.stringify(s.body.roof));

  await b.close();
  console.log('\n控制台错误：' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none'));
  console.log(fail ? '\n❌ 失败 ' + fail + ' 项' : '\n✅ 全部通过');
  process.exit(fail ? 1 : 0);
})();
