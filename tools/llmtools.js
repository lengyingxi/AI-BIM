/* 真网关 + 真工具：验"大模型知不知道这些能力、会不会填对参数"
   这一步是用户最在意的——说了模糊的话，模型得自己挑对工具、把方向/尺寸填对。
   需要 tools/serve.py 已经能连上私域网关（/llm-config 自动注入）。 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const URL = 'http://127.0.0.1:8823/index.html';
const OUT = path.join(__dirname, '..', 'outputs') + '/';

let fail = 0;
const ok = (n, c, e) => { console.log((c ? '  ✅ ' : '  ❌ ') + n + (e ? '  → ' + e : '')); if (!c) fail++; return c; };

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

  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => localStorage.clear());
  await p.goto(URL, { waitUntil: 'networkidle2' });
  await sleep(2400);
  await p.evaluate(() => { if (window.BIM.app.state.sound) document.getElementById('btnSound').click(); });

  const cfg = await p.evaluate(() => ({ on: window.BIM.agent.cfg.on, ep: window.BIM.agent.cfg.endpoint, model: window.BIM.agent.cfg.model }));
  ok('网关已接上', cfg.on && cfg.ep === '/llm/v1', JSON.stringify(cfg));

  /* 说一句 → 拿到这次模型调了哪些工具、参数是什么 */
  const ask = async (text, w) => {
    await p.evaluate(() => { window.BIM.mcp.log.length = 0; });
    await p.type('#txt', text);
    await p.keyboard.press('Enter');
    for (let i = 0; i < 120; i++) {
      await sleep(250);
      const busy = await p.evaluate(() => !!document.querySelector('.msg.ai.typing'));
      if (!busy) break;
    }
    await sleep(w || 900);
    return p.evaluate(() => ({
      log: window.BIM.mcp.log.map(x => ({ name: x.name, args: x.args, ok: x.ok })),
      ai: ([...document.querySelectorAll('.msg.ai')].pop() || {}).innerText || '',
      placed: window.BIM.app.state.placed.length,
      doors: window.BIM.app.model().doors.filter(d => d.added).length
    }));
  };
  const names = r => (r.log || []).map(x => x.name);
  const argsOf = (r, n) => ((r.log || []).find(x => x.name === n) || {}).args || {};

  console.log('\n【1】模糊需求：「202 放台空调，你看着放，别挡门」');
  const r1 = await ask('在202室放一台精密空调，你看着放，别挡着门');
  ok('模型没有反问，自己调了工具', r1.log.length >= 1, names(r1).join(','));
  ok('调的是"挑位置"或"放设备"', /suggest_positions|place_equipment/.test(names(r1).join(',')), names(r1).join(','));
  ok('设备真的落地了', r1.placed >= 1, r1.placed + ' 台');
  ok('回话是一句人话，不念参数', r1.ai.length > 6 && !/\{|\}|pref|direction/.test(r1.ai), r1.ai.replace(/\n/g, ' ').slice(0, 90));

  console.log('\n【2】相机视角的「往左挪一点」');
  const r2 = await ask('把空调往左挪一点');
  ok('调了 move_equipment', names(r2).includes('move_equipment'), names(r2).join(','));
  ok('方向填的是 left（不是写死的东/西）', argsOf(r2, 'move_equipment').direction === 'left', JSON.stringify(argsOf(r2, 'move_equipment')));

  console.log('\n【3】「换成风冷冷水机组」');
  const r3 = await ask('这台换成风冷冷水机组', 1200);
  const nm = await p.evaluate(() => (window.BIM.app.state.placed[0] || {}).name);
  ok('调了 replace_equipment', names(r3).includes('replace_equipment'), names(r3).join(','));
  ok('型号真换了', /风冷/.test(nm || ''), nm);

  console.log('\n【4】「加宽到 1.6 米」——门');
  const r4a = await p.evaluate(async () => (await window.BIM.mcp.call('open_door', { room: '301', side: 'east', width: 1.0 })).say);
  const r4 = await ask('把这个门加宽到1.6米', 1200);
  const dw = await p.evaluate(() => { const d = window.BIM.app.model().doors.filter(x => x.added)[0]; return d && d.w; });
  ok('调了 resize_door', names(r4).includes('resize_door'), names(r4).join(',') + ' ｜ ' + r4a);
  ok('门宽真的变成了 1.6', Math.abs((dw || 0) - 1.6) < 0.02, dw + ' m');

  console.log('\n【5】「挡住看不清了」→ 只显示这一间');
  const r5 = await ask('202挡住看不清了，只显示这一间', 1200);
  const iso = await p.evaluate(() => { const S = window.BIM.scene; return { f1: S.floorOf(1).g.visible, f2: S.floorOf(2).g.visible }; });
  ok('调了 focus_view', names(r5).includes('focus_view'), names(r5).join(','));
  ok('无关楼层真的藏了', iso.f1 === false && iso.f2 === true, '1F=' + iso.f1 + ' 2F=' + iso.f2);

  console.log('\n【6】「都显示出来」');
  const r6 = await ask('全都显示出来');
  ok('调了 show_all', names(r6).includes('show_all'), names(r6).join(','));
  const back = await p.evaluate(() => window.BIM.scene.floorOf(1).g.visible);
  ok('全楼恢复了', back === true, '1F=' + back);

  console.log('\n【7】「弄错了，撤回去」');
  const r7 = await ask('弄错了，撤回上一步', 1200);
  ok('调了 undo_last', names(r7).includes('undo_last'), names(r7).join(','));
  const after = await p.evaluate(() => ({ floors: window.BIM.scene.floorOf(1).g.visible }));
  ok('撤的是 show_all 之前那步（不是把视图又藏回去）', after.floors === true, JSON.stringify(after));

  await p.screenshot({ path: OUT + 'llm-tools.png' });
  ok('没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));

  console.log('\n' + (fail ? '❌ 失败 ' + fail + ' 项' : '✅ 全部通过'));
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃：', e); process.exit(1); });
