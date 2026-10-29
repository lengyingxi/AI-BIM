/* 模糊需求 → 用户引导 的完整走查（全走本地理解，不依赖大模型）
   用户不会说"靠里"这种词，只会说"你看放哪合适"。
   这里验：① 系统自己算出候选位并讲清利弊 ② 给出可点的按钮 ③ 点一下就落地
          ④ 相机转过以后"往左"仍然往左 ⑤ 换型号 / 撤回 也能一句话搞定 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
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

  await p.goto('http://127.0.0.1:8823/index.html', { waitUntil: 'networkidle2' });
  await sleep(1400);
  await p.evaluate(() => window.BIM.agent.saveCfg({ endpoint: '', model: '', key: '' }));   // 固定走本地规则
  await p.evaluate(() => { if (window.BIM.app.state.sound) document.getElementById('btnSound').click(); });
  await sleep(500);

  const say = async (t, w) => {
    const before = await p.evaluate(() => document.querySelectorAll('.msg.ai:not(.typing)').length);
    await p.type('#txt', t);
    await p.keyboard.press('Enter');
    for (let i = 0; i < 80; i++) {
      await sleep(200);
      const st = await p.evaluate(() => ({ n: document.querySelectorAll('.msg.ai:not(.typing)').length, typing: !!document.querySelector('.msg.ai.typing') }));
      if (!st.typing && st.n > before) break;
    }
    await sleep(w || 900);
  };
  const lastAI = () => p.evaluate(() => [...document.querySelectorAll('.msg.ai')].pop().innerText.replace(/\n+/g, ' | '));
  const chipLabels = () => p.evaluate(() => [...document.querySelectorAll('.chips button')].map(b => b.textContent));

  console.log('\n【1】模糊需求："202 放台空调，你看放哪合适"');
  await say('202室放台精密空调，你看放哪比较合适', 1400);
  const a1 = await lastAI();
  ok('没反问"你要放哪"，自己拿了主意', /放好了|按「/.test(a1) && !/要放哪|哪个位置呢/.test(a1), a1.slice(0, 120));
  ok('说明为什么放这儿', /离门口|贴着墙|省地方|检修|散热|通风|进出/.test(a1), a1.slice(0, 160));
  const n1 = await p.evaluate(() => window.BIM.app.state.placed.length);
  ok('直接放上去了，不用再点一次', n1 === 1, n1 + ' 台');
  const cs = await chipLabels();
  ok('给出可点的改法', cs.length >= 2 && cs.some(s => /改到/.test(s)), cs.join(' / '));
  await sleep(1600);                              // 等取景动画走完再截图
  await p.screenshot({ path: OUT + 'guide-1.png' });

  console.log('\n【2】点"改到靠墙" → 真的换个位置');
  const pos0 = await p.evaluate(() => { const e = window.BIM.app.state.placed[0]; return { x: e.x, y: e.y }; });
  await p.evaluate(() => {
    const groups = document.querySelectorAll('.chips');
    const last = groups[groups.length - 1];
    [...last.querySelectorAll('button')].find(b => /改到/.test(b.textContent)).click();
  });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const moved = await p.evaluate(p0 => {
      const e = window.BIM.app.state.placed[0];
      return e && Math.hypot(e.x - p0.x, e.y - p0.y) > 0.1;
    }, pos0);
    if (moved) break;
  }
  const placed = await p.evaluate(() => window.BIM.app.state.placed.map(e => ({ name: e.name, room: e.room, x: +e.x.toFixed(2), y: +e.y.toFixed(2) })));
  ok('按"改到靠墙"挪过去了', placed.length === 1 && placed[0].room === '202' &&
    Math.hypot(placed[0].x - pos0.x, placed[0].y - pos0.y) > 0.1,
    JSON.stringify(pos0) + ' → ' + JSON.stringify({ x: placed[0].x, y: placed[0].y }));

  console.log('\n【3】相机转过来，说"往左挪一点"');
  const mv = await p.evaluate(async () => {
    const S = window.BIM.scene, room = window.BIM.app.model().rooms.find(r => r.num === '202');
    const cx = (room.x0 + room.x1) / 2, cy = (room.y0 + room.y1) / 2;
    S.setCam(cx - 16, room.elev + 13, -(cy - 12), cx, room.elev, -cy);   // 侧着看
    const e = window.BIM.app.state.placed[0];
    return { view: S.viewInfo(), s0: S.project(e.x, e.floorElev + 0.5, e.y), x0: e.x };
  });
  await p.type('#txt', '往左挪一点');
  await p.keyboard.press('Enter');
  await sleep(2200);
  const mv2 = await p.evaluate(() => {
    const S = window.BIM.scene, e = window.BIM.app.state.placed[0];
    return { s1: S.project(e.x, e.floorElev + 0.5, e.y), x1: e.x, x0: e.x };
  });
  const dScreen = mv2.s1.x - mv.s0.x;
  ok('屏幕右侧＝' + mv.view.rightIs + '（相机已转）', mv.view.rightIs !== '东', '镜头朝' + mv.view.looking);
  ok('"往左"在画面上确实往左', dScreen < -3, 'Δ屏幕 x = ' + dScreen.toFixed(1) + ' px');
  const a3 = await lastAI();
  ok('回话说清了方向+距离', /往左挪了/.test(a3), a3.slice(0, 90));

  console.log('\n【4】一句话换型号');
  await say('把空调换成风冷冷水机组', 1600);
  const nm = await p.evaluate(() => window.BIM.app.state.placed[0].name);
  ok('型号换掉了', /风冷/.test(nm), nm);
  const a4 = await lastAI();
  ok('回话说清换成了什么 + 重新校核', /换成/.test(a4) && /安全系数/.test(a4), a4.slice(0, 100));

  console.log('\n【5】"弄错了，撤回去"');
  await say('弄错了，撤回上一步', 1600);
  const nm2 = await p.evaluate(() => window.BIM.app.state.placed[0].name);
  ok('撤回把型号改回去了', nm2 !== nm, nm + ' → ' + nm2);
  ok('回话说清了撤回的是哪一步', /撤回/.test(await lastAI()), (await lastAI()).slice(0, 80));

  console.log('\n【6】"挡住看不见了" → 只显示这一间；"都显示出来" → 还原');
  await say('挡住看不清了，只看这一间', 1400);
  const iso = await p.evaluate(() => {
    const S = window.BIM.scene;
    return { f1: S.floorOf(1).g.visible, f2: S.floorOf(2).g.visible, f3: S.floorOf(3).g.visible };
  });
  ok('无关楼层藏起来了', iso.f1 === false && iso.f3 === false && iso.f2 === true, '1F=' + iso.f1 + ' 2F=' + iso.f2 + ' 3F=' + iso.f3);
  await p.screenshot({ path: OUT + 'guide-2.png' });

  await say('全都显示出来', 1400);
  const back = await p.evaluate(() => ({ f1: window.BIM.scene.floorOf(1).g.visible, f3: window.BIM.scene.floorOf(3).g.visible }));
  ok('还原回全楼', back.f1 === true && back.f3 === true, '1F=' + back.f1 + ' 3F=' + back.f3);

  console.log('\n【7】稳定性');
  ok('没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));

  console.log('\n' + (fail ? '❌ 失败 ' + fail + ' 项' : '✅ 全部通过'));
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃：', e); process.exit(1); });
