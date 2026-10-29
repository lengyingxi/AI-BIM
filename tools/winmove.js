/* 验收：窗的移动（上下改窗台高 / 左右沿墙滑 / 按视角换算）+ 语音不再播报
   跑法：python tools/serve.py --port 8826 起服务后
        NODE_PATH=... node tools/winmove.js                                    */
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = process.env.SITE || 'http://127.0.0.1:8826';

let fail = 0;
const ok = (name, cond, info) => {
  console.log('  ' + (cond ? '✅' : '❌') + ' ' + name + (info !== undefined && info !== '' ? '  → ' + info : ''));
  if (!cond) fail++;
};

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
  await sleep(2600);

  console.log('\n【1】工具层：move_window 已注册');
  const tools = await p.evaluate(() => (window.BIM.mcp.tools || []).map(t => t.function.name));
  ok('工具清单里有 move_window', tools.indexOf('move_window') >= 0, '共 ' + tools.length + ' 个');
  const names = await p.evaluate(() => Object.keys(window.BIM.agent.toolToStep || {}));
  ok('agent 一步映射里有 move_window', names.indexOf('move_window') >= 0);

  console.log('\n【2】语音：默认不播报');
  const snd = await p.evaluate(() => ({
    sound: window.BIM.app.state.sound,
    off: document.getElementById('btnSound').classList.contains('off')
  }));
  ok('ST.sound 默认关', snd.sound === false, 'sound=' + snd.sound);
  ok('顶栏喇叭按钮显示为关', snd.off === true, 'off=' + snd.off);

  console.log('\n【3】开一扇窗作为挪动对象');
  const opened = await p.evaluate(async () =>
    await window.BIM.mcp.call('open_window', { room: '306', width: 1.5, height: 1.5, sill: 0.9 }));
  ok('open_window 成功', !!(opened && opened.ok !== false), JSON.stringify(opened).slice(0, 90));
  await sleep(600);

  const readWin = () => p.evaluate(() => {
    const M = window.BIM_MODEL;
    const d = M.windows[M.windows.length - 1];
    const wall = M.walls.find(w => w.id === d.wall);
    const ax = window.BIM.scene.wallAxis(wall);
    const va = window.BIM.scene.viewAxes();
    return {
      name: d.name, sill: d.sill, w: d.w, h: d.h, wallId: d.wall, floor: d.floor,
      at: window.BIM.scene.windowAt(d, wall),
      dot: va.right.x * ax.x + va.right.y * ax.y,     // 屏幕右方在墙走向上的投影
      wallH: wall.h
    };
  });

  const w0 = await readWin();
  ok('拿到窗的初始状态', !!w0 && w0.at != null, 'at=' + (w0 && w0.at.toFixed(2)) + ' sill=' + w0.sill);

  console.log('\n【4】往上挪 → 只改窗台高，位置不动');
  const r4 = await p.evaluate(async () => await window.BIM.mcp.call('move_window', { direction: 'up', distance: 0.3 }));
  await sleep(500);
  const w1 = await readWin();
  ok('工具返回成功', !!(r4 && r4.ok !== false), JSON.stringify(r4 && r4.result || r4).slice(0, 100));
  ok('窗台高了 0.30 m', Math.abs((w1.sill - w0.sill) - 0.3) < 0.02, w0.sill.toFixed(2) + ' → ' + w1.sill.toFixed(2));
  ok('沿墙位置没动', Math.abs(w1.at - w0.at) < 0.02, w0.at.toFixed(2) + ' → ' + w1.at.toFixed(2));

  console.log('\n【5】往下挪 → 降回去');
  await p.evaluate(async () => await window.BIM.mcp.call('move_window', { direction: 'down', distance: 0.3 }));
  await sleep(500);
  const w2 = await readWin();
  ok('窗台降回 0.90 m', Math.abs(w2.sill - 0.9) < 0.03, w2.sill.toFixed(2));

  console.log('\n【6】往左挪 → 沿墙滑，方向跟当前镜头一致');
  const r6 = await p.evaluate(async () => await window.BIM.mcp.call('move_window', { direction: 'left', distance: 0.4 }));
  await sleep(500);
  const w3 = await readWin();
  const moved = w3.at - w2.at;
  const wantSign = w2.dot >= 0 ? -1 : 1;              // 屏幕左 = 右方向取反
  ok('工具返回成功', !!(r6 && r6.ok), String(r6 && r6.say || '').slice(0, 80));
  ok('窗真的沿墙滑了（堵住时允许顺墙让位）', Math.abs(moved) > 0.05, 'Δ=' + moved.toFixed(2) + ' 米');
  ok('方向和"屏幕左"在墙上的投影一致', Math.sign(moved) === wantSign,
    'Δ=' + moved.toFixed(2) + '  期望号=' + wantSign + '  dot=' + w2.dot.toFixed(2));
  ok('窗台高没被带动', Math.abs(w3.sill - w2.sill) < 0.02, w3.sill.toFixed(2));

  console.log('\n【7】把镜头转 180°，同一个"往左"要走反方向');
  await p.evaluate(() => {
    const c = window.BIM.scene.camera();
    const t = window.BIM.scene.controls().target;
    window.BIM.scene.setCam(t.x - (c.position.x - t.x), c.position.y, t.z - (c.position.z - t.z), t.x, t.y, t.z);
  });
  await sleep(700);
  const wb = await readWin();
  await p.evaluate(async () => await window.BIM.mcp.call('move_window', { direction: 'left', distance: 0.4 }));
  await sleep(500);
  const wc = await readWin();
  const moved2 = wc.at - wb.at;
  const wantSign2 = wb.dot >= 0 ? -1 : 1;
  ok('镜头转过之后方向自动反过来', Math.abs(moved2) > 0.05 && Math.sign(moved2) === wantSign2,
    'Δ=' + moved2.toFixed(2) + '  期望号=' + wantSign2 + '  dot=' + wb.dot.toFixed(2));
  ok('这次投影符号确实翻了', Math.sign(wb.dot) === -Math.sign(w2.dot),
    'dot ' + w2.dot.toFixed(2) + ' → ' + wb.dot.toFixed(2));

  console.log('\n【8】一路往上挪 → 顶到梁会被拦下来，不会挪出墙');
  let blocked = false, lastSill = (await readWin()).sill;
  for (let i = 0; i < 8; i++) {
    const r = await p.evaluate(async () => await window.BIM.mcp.call('move_window', { direction: 'up', distance: 0.3 }));
    await sleep(240);
    const now = (await readWin()).sill;
    if (r && r.ok === false) { blocked = true; break; }           // 明确拒绝
    if (Math.abs(now - lastSill) < 0.01) { blocked = true; break; } // 被夹住，原地不动
    lastSill = now;
  }
  const w4 = await readWin();
  ok('连续上移最后被拦下（不再往上跑）', blocked, 'sill=' + w4.sill.toFixed(2));
  ok('窗顶没超过墙净高', w4.sill + w4.h <= w4.wallH - 0.28 + 0.02,
    'sill+h=' + (w4.sill + w4.h).toFixed(2) + ' ≤ 墙高-梁高 ' + (w4.wallH - 0.28).toFixed(2));

  console.log('\n【9】挪到墙中间');
  const w6before = await readWin();
  const r9 = await p.evaluate(async () => await window.BIM.mcp.call('move_window', { direction: 'center' }));
  await sleep(500);
  const w5 = await readWin();
  const centered = Math.abs(w5.at - w6before.at) > 0.02;
  ok('居中动作有落地或被明确拦下', centered || !!(r9 && r9.ok === false),
    centered ? ('at ' + w6before.at.toFixed(2) + ' → ' + w5.at.toFixed(2)) : String(r9 && r9.say || '').slice(0, 70));

  console.log('\n【10】自然语言：这句话会走挪窗而不是开窗');
  const nlp = await p.evaluate(() => {
    const N = window.BIM.nlp;
    return ['把窗往上挪一点', '窗户抬高一些', '这扇窗往左移半米', '把窗挪到墙中间', '在306开个1.5米的窗']
      .map(s => { const o = N.parse(s); return { s: s, intent: o.intent, dir: o.dir || null, dist: o.dist || null }; });
  });
  nlp.forEach(x => console.log('    · ' + x.s + ' → ' + x.intent + (x.dir ? ' dir=' + x.dir : '') + (x.dist ? ' dist=' + x.dist : '')));
  ok('"把窗往上挪一点" → winmove + up', nlp[0].intent === 'winmove' && nlp[0].dir === 'up');
  ok('"窗户抬高一些" → winmove + up', nlp[1].intent === 'winmove' && nlp[1].dir === 'up');
  ok('"这扇窗往左移半米" → winmove + left + 0.5', nlp[2].intent === 'winmove' && nlp[2].dir === 'left' && Math.abs(nlp[2].dist - 0.5) < 0.01);
  ok('"把窗挪到墙中间" → winmove + center', nlp[3].intent === 'winmove' && nlp[3].dir === 'center');
  ok('"在306开个1.5米的窗" 仍然是开窗', nlp[4].intent === 'window');

  console.log('\n【11】说话之后不该调用语音合成');
  await p.evaluate(() => {
    window.__spoke = 0;
    if (window.speechSynthesis) {
      window.speechSynthesis.speak = () => { window.__spoke++; };
    }
  });
  const before = await p.evaluate(() => document.querySelectorAll('.msg.ai:not(.typing)').length);
  await p.type('#txt', '把窗往上挪一点');
  await p.keyboard.press('Enter');
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    const st = await p.evaluate(() => ({ n: document.querySelectorAll('.msg.ai:not(.typing)').length, ty: !!document.querySelector('.msg.ai.typing') }));
    if (!st.ty && st.n > before) break;
  }
  await sleep(1200);
  const spoke = await p.evaluate(() => window.__spoke);
  ok('回复过程中没有调用语音合成', spoke === 0, 'speak 调用 ' + spoke + ' 次');
  const lastAi = await p.evaluate(() => [...document.querySelectorAll('.msg.ai:not(.typing)')].pop().innerText.replace(/\n+/g, ' | ').slice(0, 120));
  console.log('    AI 回执：' + lastAi);

  if (errs.length) console.log('\n  页面错误（前 5 条）：\n   ' + errs.slice(0, 5).join('\n   '));
  console.log('\n' + (fail ? fail + ' 处失败' : '全部通过（0 处失败）'));
  await b.close();
  process.exit(fail ? 1 : 0);
})();
