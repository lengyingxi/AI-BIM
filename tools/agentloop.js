/* Agent 循环验收：大模型真的能连着调 MCP、看着结果改方案
   覆盖：跨房间搬运 / 组合要求 / 找房间 / 不越权 / 上下文承接
   需要服务已启动（tools/serve.py，8823）且本机配好了大模型 Key */
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = 'http://127.0.0.1:8823';

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

  await p.goto(SITE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => localStorage.clear());
  await p.goto(SITE + '/index.html', { waitUntil: 'networkidle2' });
  await sleep(3000);

  const cfg = await p.evaluate(() => ({ on: BIM.agent.cfg.on, model: BIM.agent.cfg.model }));
  ok('大模型已接上（没有它这套测不了）', cfg.on, JSON.stringify(cfg));
  if (!cfg.on) { await b.close(); process.exit(1); }

  const say = async (t) => {
    const before = await p.evaluate(() => document.querySelectorAll('.msg.ai:not(.typing)').length);
    await p.type('#txt', t);
    await p.keyboard.press('Enter');
    for (let i = 0; i < 240; i++) {                 // 多轮调用慢，最多等 60 秒
      await sleep(250);
      const st = await p.evaluate(() => ({ n: document.querySelectorAll('.msg.ai:not(.typing)').length, ty: !!document.querySelector('.msg.ai.typing') }));
      if (!st.ty && st.n > before) break;
    }
    await sleep(900);
    return p.evaluate(() => {
      const q = window.BIM._lastPlan || {};
      return {
        src: q.source, tools: q.tools || [], calls: q.calls || 0, rounds: q.rounds || 0,
        reply: q.reply || '', trace: (q.trace || []).map(t => t.name),
        ai: [...document.querySelectorAll('.msg.ai:not(.typing)')].pop().innerText.replace(/\n+/g, ' | ')
      };
    });
  };
  const placed = () => p.evaluate(() => BIM.app.state.placed.map(e => ({
    name: e.name, room: e.room, x: +e.x.toFixed(2), y: +e.y.toFixed(2)
  })));
  const inside = (room, x, y) => p.evaluate((rn, px, py) => {
    const r = window.BIM_MODEL.rooms.find(q => q.id === rn);
    if (!r) return false;
    return px > r.x0 && px < r.x1 && py > r.y0 && py < r.y1;
  }, room, x, y);

  console.log('\n【1】一句话放到指定房间');
  const r1 = await say('把空压机放到 5 楼 505 靠里');
  ok('模型调了工具（不是本地兜底）', r1.src === 'llm' && r1.calls > 0, JSON.stringify(r1.tools));
  ok('工具名是 place_equipment', r1.tools.indexOf('place_equipment') >= 0, r1.tools.join(','));
  const s1 = await placed();
  ok('设备落在 505', s1.length === 1 && s1[0].room === '505', JSON.stringify(s1));

  console.log('\n【2】跨房间搬运：不该再反问"往哪挪"');
  const r2 = await say('把这个空压机放到 506 室');
  ok('调了 move_equipment', r2.tools.indexOf('move_equipment') >= 0, r2.tools.join(','));
  const s2 = await placed();
  ok('设备真的到了 506', s2.length === 1 && s2[0].room === '506', JSON.stringify(s2));
  ok('没有反问"你想怎么挪"', !/你想怎么挪|怎么摆/.test(r2.ai), r2.ai.slice(0, 60));
  const inRoom = await inside('506', s2[0].x, s2[0].y);
  ok('落点在 506 房间范围内（不会飘到楼板外）', inRoom, 'x=' + s2[0].x + ' y=' + s2[0].y);
  ok('回执给了安全系数', /安全系数\s*[\d.]+/.test(r2.ai), (r2.ai.match(/安全系数\s*[\d.]+/) || [''])[0]);

  console.log('\n【3】组合要求：靠窗');
  const r3 = await say('把空压机挪到这间靠窗的位置');
  const s3 = await placed();
  // 模型偶尔会在 move / suggest 之间摇摆，这里只硬性要求"位置真的变了"，
  // 工具名作为参考打出来——判太死会让回归时红时绿，反而看不出真问题。
  const movedBy = r3.tools.join(',');
  ok('调了工具而不是只说话', r3.calls > 0, movedBy);
  ok('还在 506 且位置变了', s3[0].room === '506' && (s3[0].x !== s2[0].x || s3[0].y !== s2[0].y),
    JSON.stringify(s2[0]) + ' → ' + JSON.stringify(s3[0]));
  ok('用的是挪/引导类工具', /move_equipment|suggest_positions/.test(movedBy), movedBy);

  console.log('\n【4】"哪间能放下"：找房间');
  const r4 = await say('这层还有哪间能放下空压机');
  const roomNums = await p.evaluate(() => window.BIM_MODEL.rooms.filter(r => r.floor === 5 && r.zone !== 'corr').map(r => r.num));
  const mentioned = roomNums.filter(n => r4.ai.indexOf(n) >= 0);
  ok('回复里点了具体房号', mentioned.length > 0, mentioned.join(',') + ' ← ' + r4.ai.slice(0, 60));

  console.log('\n【5】不越权：没让开门就不能自己开');
  const r5 = await say('把空压机放到 5 楼 508 靠墙');
  ok('没有自作主张 open_door', r5.tools.indexOf('open_door') < 0, r5.tools.join(','));
  ok('没有自作主张改设备尺寸', r5.tools.indexOf('resize_equipment') < 0, r5.tools.join(','));

  console.log('\n【6】多轮链路是通的');
  ok('至少一轮工具调用', r1.calls >= 1, 'calls=' + r1.calls + ' rounds=' + r1.rounds);
  ok('trace 记到了每次调用', r1.trace.length >= 1, r1.trace.join(' → '));
  const log = await p.evaluate(() => (BIM.mcp.log || []).slice(-6).map(x => x.name + ':' + (x.ok === false ? 'X' : 'V')));
  ok('MCP 层有执行记录', log.length > 0, log.join(' '));

  if (errs.length) console.log('\n  页面错误：\n   ' + errs.slice(0, 6).join('\n   '));
  console.log('\n' + (fail ? fail + ' 处失败' : '全部通过（0 处失败）'));
  await b.close();
  process.exit(fail ? 1 : 0);
})();
