/* 拓门两件事的验收：
   ① 拓之前必须把门洞两侧分别量一遍（左能扩多少、右能扩多少），
      只能往一侧挖的时候不能硬按"两侧各半"去扩；
   ② 拓完要给设备的最终安全系数，并在回答下方给"看计算书"的快捷入口。 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'outputs') + '/';

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
  await p.evaluate(() => { window.BIM.agent.saveCfg({ endpoint: '', model: '', key: '' }); });

  const say = async (t, w) => {
    const before = await p.evaluate(() => document.querySelectorAll('.msg.ai:not(.typing)').length);
    await p.type('#txt', t);
    await p.keyboard.press('Enter');
    for (let i = 0; i < 90; i++) {
      await sleep(200);
      const st = await p.evaluate(() => ({ n: document.querySelectorAll('.msg.ai:not(.typing)').length, typing: !!document.querySelector('.msg.ai.typing') }));
      if (!st.typing && st.n > before) break;
    }
    await sleep(w || 1000);
  };
  const lastAI = () => p.evaluate(() => [...document.querySelectorAll('.msg.ai')].pop().innerText.replace(/\n+/g, ' | '));
  const chipList = () => p.evaluate(() => [...document.querySelectorAll('.chips')].pop()
    ? [...document.querySelectorAll('.chips')].pop().innerText.split('\n').filter(Boolean) : []);
  const clickChip = async (re, w) => {
    const done = await p.evaluate(src => {
      const re2 = new RegExp(src);
      const all = [...document.querySelectorAll('.chips button')];
      const btn = all.reverse().find(x => re2.test(x.textContent));
      if (!btn) return false;
      btn.click(); return true;
    }, re.source || re);
    await sleep(w || 2000);
    return done;
  };
  const shot = n => p.screenshot({ path: OUT + 'widen-' + n + '.png' });

  /* ---------- ① 两侧分别量：门贴着墙角时只能往另一侧扩 ---------- */
  console.log('\n【1】门贴着墙角，只能往一侧扩');
  const plan = await p.evaluate(() => {
    const S = window.BIM.scene, C = window.BIM.calc, M = window.BIM_MODEL;
    const wall = M.walls.find(w => w.id === 'W-1F-005');
    const d = M.doors.find(x => x.wall === 'W-1F-005' && Math.abs(x.pos[0] - 1.5) < 0.01);
    const room = M.rooms.find(r => r.num === '101');
    const at0 = S.doorAt(d, wall);
    // 把这扇门挪到离墙角/柱子只剩几厘米的位置，制造"左边顶死、右边还有地方"的现场
    const nd = S.replaceDoor(d, { at: 0.85, w: 1.0, h: d.h });
    const out = { before: null, after: null };
    out.before = { left: null, right: null };
    const pl = C.widenPlan({ wall: wall, at: 0.85, w: 1.0, h: d.h, need: 1.6, room: room, equipments: [], self: nd });
    out.after = {
      left: +pl.side.left.toFixed(2), right: +pl.side.right.toFixed(2), nearL: pl.side.nearL,
      mode: pl.best ? pl.best.mode : null,
      at: pl.best ? +pl.best.at.toFixed(2) : null,
      w: pl.best ? +pl.best.w.toFixed(2) : null,
      cands: pl.cands.map(c => c.mode + ':' + (c.pass ? 'pass' : 'fail'))
    };
    // 复原
    const back = S.replaceDoor(nd, { at: at0, w: 1.0, h: d.h });
    out.restored = !!back;
    return out;
  });
  console.log('    左侧余量 ' + plan.after.left + ' m（' + plan.after.nearL + '）、右侧 ' + plan.after.right + ' m');
  console.log('    候选 ' + plan.after.cands.join(' / '));
  ok('两侧余量分别算出来且不相等', plan.after.left < 0.1 && plan.after.right > 4,
    '左 ' + plan.after.left + ' / 右 ' + plan.after.right);
  ok('左边顶死时不硬按两侧各半', plan.after.mode === 'right', '选中的方案 = ' + plan.after.mode);
  ok('门心真的往右让了半个增量', Math.abs(plan.after.at - 1.15) < 0.02, '新门心 at = ' + plan.after.at);
  ok('拓完能还原', plan.restored);
  await shot('1-geom');

  /* ---------- ② 门偏小 → 拓门 → 最终安全系数 + 计算书 ---------- */
  console.log('\n【2】门偏小挡住搬运（102 只有 1.0 m 的门，空压机立起来要 1.32 m）');
  await say('把空压机放到一楼102靠墙', 1800);
  const ask = await lastAI();
  const chips0 = await chipList();
  ok('认出"搬不进来"并问要不要拓', /搬不进|门偏小|拓/.test(ask), ask.slice(0, 110));
  ok('回复里报了两侧的余量', /左侧可扩/.test(ask) && /右侧可扩/.test(ask),
    (ask.match(/左侧可扩[^，。]*/) || [''])[0] + ' ' + (ask.match(/右侧可扩[^，。]*/) || [''])[0]);
  ok('给了拓门按钮', chips0.some(t => /拓到/.test(t)), chips0.join(' / '));
  await shot('2-ask');

  console.log('\n【3】点"拓门"');
  const clicked = await clickChip(/拓到/, 2600);
  ok('按钮可点', clicked);
  const after = await lastAI();
  const chips1 = await chipList();
  ok('门真的改了', /拓到/.test(after) && /开门校核通过/.test(after), after.slice(0, 120));
  ok('报出左右各扩了多少', /左侧扩了|右侧扩了/.test(after), (after.match(/左侧扩了[^。]*/) || [''])[0]);
  ok('给了最终安全系数', /最终安全系数/.test(after), (after.match(/最终安全系数[^）]*）?/) || [''])[0]);
  ok('下方有"看计算书"按钮', chips1.some(t => /计算书/.test(t)), chips1.join(' / '));
  await shot('3-widened');

  console.log('\n【4】点"看计算书"');
  await clickChip(/计算书/, 1600);
  const calc = await p.evaluate(() => {
    const panel = document.getElementById('pCalc');
    const body = document.getElementById('calcBody');
    const t = body ? body.innerText.replace(/\n+/g, ' ') : '';
    return { open: panel && !panel.hidden, full: t, head: t.slice(0, 160) };
  });
  ok('计算书面板打开了', calc.open);
  ok('计算书里是这台设备（空压机）', /空压机|空气压缩机/.test(calc.full), calc.head);
  ok('计算书里有安全系数', /安全系数|K\s*=|承载力/.test(calc.full),
    (calc.full.match(/安全系数[^ ]*|K\s*=\s*[\d.]+/) || [''])[0]);
  await shot('4-calc');

  /* ---------- ⑤ 直接说"把门加宽到 1.6 米"，走的是同一条求解器 ---------- */
  console.log('\n【5】直接说"把门加宽到 1.6 米"');
  await say('把门加宽到1.6米', 1800);
  const manual = await lastAI();
  const chips2 = await chipList();
  ok('回复报了两侧各扩多少', /左侧扩|右侧扩/.test(manual), (manual.match(/门改成[^。]*。/) || [''])[0]);
  ok('回复给了最终安全系数', /最终安全系数/.test(manual), (manual.match(/最终安全系数[^）]*/) || [''])[0]);
  ok('下方有"看计算书"按钮', chips2.some(t => /计算书/.test(t)), chips2.join(' / '));
  const dw = await p.evaluate(() => {
    const m = BIM.app.model();
    const d = m.doors.filter(x => Math.abs(x.w - 1.6) < 0.02);
    return { n: d.length, w: d.length ? d[0].w : null };
  });
  ok('门实际改到了 1.60 m', dw.n > 0, JSON.stringify(dw));
  await shot('5-manual');

  console.log('\n错误数: ' + errs.length);
  errs.slice(0, 5).forEach(e => console.log('  ' + e));
  console.log(fail ? '\n❌ ' + fail + ' 项未通过' : '\n✅ 全部通过');
  await b.close();
  process.exit(fail ? 1 : 0);
})();
