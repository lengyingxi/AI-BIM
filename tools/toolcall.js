/* 工具调用（MCP 风格）+ 语音输入 的浏览器验收 */
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = 'http://127.0.0.1:8823';
const OUT = require('path').join(__dirname, '..', 'outputs') + '/';

let fail = 0;
const ok = (n, c, e) => { console.log((c ? '  ✅ ' : '  ❌ ') + n + (e ? '  → ' + e : '')); if (!c) fail++; return c; };

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    defaultViewport: { width: 1600, height: 950 },
  });
  await b.defaultBrowserContext().overridePermissions(SITE, ['microphone']);
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  // 假识别引擎：只吐中间结果、永远不给 final —— 正是用户遇到的情况
  await p.evaluateOnNewDocument(() => {
    window.__sr = { inst: null };
    class FakeSR {
      constructor() { this.continuous = false; this.interimResults = false; window.__sr.inst = this; }
      start() { this.onstart && this.onstart(); }
      stop() { this.onend && this.onend(); }
      abort() { this.onend && this.onend(); }
      emit(text, isFinal) {
        const r = [{ transcript: text }];
        r.isFinal = !!isFinal;
        this.onresult && this.onresult({ resultIndex: 0, results: [r] });
      }
      fire(err) { this.onerror && this.onerror({ error: err }); }
    }
    window.SpeechRecognition = FakeSR;
    window.webkitSpeechRecognition = FakeSR;
    window.__forceAsr = 'web';           // 这套专门测"浏览器识别"备用通道
  });

  await p.goto(SITE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => localStorage.clear());
  await p.goto(SITE + '/index.html', { waitUntil: 'networkidle2' });
  await sleep(2500);

  const say = async (t, wait) => {
    const before = await p.evaluate(() => document.querySelectorAll('.msg.ai:not(.typing)').length);
    await p.type('#txt', t);
    await p.keyboard.press('Enter');
    for (let i = 0; i < 160; i++) {
      await sleep(250);
      const st = await p.evaluate(() => ({ n: document.querySelectorAll('.msg.ai:not(.typing)').length, ty: !!document.querySelector('.msg.ai.typing') }));
      if (!st.ty && st.n > before) break;
    }
    await sleep(wait || 700);
  };
  const plan = () => p.evaluate(() => {
    const q = window.BIM._lastPlan || {};
    return { src: q.source, tools: q.tools || [], steps: (q.steps || []).map(s => ({ act: s.act, device: s.device, room: s.room, pref: s.pref, dir: s.dir, dist: s.dist, count: s.count })) };
  });
  const placed = () => p.evaluate(() => window.BIM.app.state.placed.map(e => ({ name: e.name, room: e.room, x: +e.x.toFixed(2), y: +e.y.toFixed(2), w: e.w, d: e.d })));
  const lastAI = () => p.evaluate(() => [...document.querySelectorAll('.msg.ai:not(.typing)')].pop().innerText.replace(/\n+/g, ' | '));
  const aiCount = () => p.evaluate(() => document.querySelectorAll('.msg.ai:not(.typing)').length);

  console.log('\n【1】工具层');
  const t = await p.evaluate(() => ({
    names: (window.BIM.mcp.tools || []).map(x => x.function.name),
    bound: Object.keys(window.BIM.mcp.handlers || {}),
    schema: (window.BIM.mcp.tools || []).every(x => x.type === 'function' && x.function.parameters)
  }));
  ok('全部工具都声明了 schema（' + t.names.length + ' 个）', t.names.length >= 10 && t.schema, t.names.join(','));
  ok('全部注册了处理器', t.names.every(n => t.bound.indexOf(n) >= 0));

  console.log('\n【2】一句话 → 模型直接调工具');
  await say('把空压机放到2楼202靠里');
  const p1 = await plan();
  ok('走的是 llm + 工具', p1.src === 'llm' && p1.tools.indexOf('place_equipment') >= 0, JSON.stringify(p1.tools));
  ok('方位归一化成 inner', p1.steps[0] && p1.steps[0].pref === 'inner', JSON.stringify(p1.steps[0]));
  const s1 = await placed();
  ok('设备落地', s1.length === 1 && s1[0].room === '202', JSON.stringify(s1));
  // 202 是 y 0~6.6，走廊在北侧，靠里就该落在南半边
  ok('靠里真的靠里（贴南侧而不是居中）', s1[0] && s1[0].y < 2.6, 'y=' + (s1[0] && s1[0].y));
  const textAll = await p.evaluate(() => [...document.querySelectorAll('.msg.ai')].map(e => e.innerText).join(' / '));
  ok('没有出现"没听清/没接住"', !/没听清|没接住|换个说法/.test(textAll), 'ai 条数 ' + (await aiCount()));

  console.log('\n【3】靠墙直接贴墙');
  await say('把空压机放到2楼203靠墙');
  const s2 = await placed();
  const e2 = s2[s2.length - 1];
  const gap = await p.evaluate((x, y, room) => {
    const r = window.BIM_MODEL.rooms.find(q => q.num === room);
    const gx = Math.min(Math.abs(x - r.x0), Math.abs(x - r.x1));
    const gy = Math.min(Math.abs(y - r.y0), Math.abs(y - r.y1));
    return { gx: gx, gy: gy };
  }, e2.x, e2.y, e2.room);
  // 净距要按"那面墙的垂直方向"算：靠上下墙看 d/2，靠左右墙看 w/2
  const edge = gap.gy < gap.gx ? gap.gy - (e2.d || 0) / 2 : gap.gx - (e2.w || 0) / 2;
  ok('设备外沿贴墙（0.1~0.35 米）', edge > 0.08 && edge < 0.35, '净距 ' + edge.toFixed(2) + ' m  ' + JSON.stringify(e2));

  console.log('\n【4】「往左挪一点」相对挪动');
  const before4 = (await placed()).slice(-1)[0];
  await say('把这个设备往左挪一点');
  const p4 = await plan();
  const after4 = (await placed()).slice(-1)[0];
  const d4 = Math.hypot(after4.x - before4.x, after4.y - before4.y);
  ok('模型调了 move_equipment', p4.tools.indexOf('move_equipment') >= 0, JSON.stringify(p4.tools));
  ok('带上了方向 left', p4.steps[0] && p4.steps[0].dir === 'left', JSON.stringify(p4.steps[0]));
  ok('设备真的移动了（≈0.3 米）', d4 > 0.05 && d4 < 0.9, d4.toFixed(2) + ' m  ' + JSON.stringify(before4) + ' → ' + JSON.stringify(after4));
  const m4 = await lastAI();
  ok('回复里说清挪了多少', /挪了|到边|挡住/.test(m4), m4.slice(0, 70));
  await p.screenshot({ path: OUT + 'tool-4-move.png' });

  console.log('\n【5】「再放一台」沿用上下文');
  await say('再放一台');
  const s5 = await placed();
  ok('第二台落在同一间房', s5.length === 3 && s5[1].room === s5[2].room, JSON.stringify(s5.map(e => e.room)));

  console.log('\n【6】问一句只回一条');
  const n6 = await aiCount();
  await say('这间房还能放几台', 1500);
  const m6 = await lastAI();
  ok('余量问答只出一条', (await aiCount()) === n6 + 1, '新增 ' + ((await aiCount()) - n6) + ' 条');
  ok('算出还能放几台', /还能|余量|放不/.test(m6), m6.slice(0, 60));

  console.log('\n【7】语音：预览 + 静音自动结算');
  await p.reload({ waitUntil: 'networkidle2' });
  await sleep(1800);
  // 已授权时会自动开麦；没开就点一下（点一下是"开关"，开着再点会关掉）
  let barOn = await p.evaluate(() => !document.getElementById('listenBar').hidden);
  if (!barOn) {
    await p.evaluate(() => document.getElementById('btnMic').click());
    for (let i = 0; i < 24; i++) {           // 首次 getUserMedia 可能要一会儿
      await sleep(250);
      barOn = await p.evaluate(() => !document.getElementById('listenBar').hidden);
      if (barOn) break;
    }
  }
  ok('麦克风进入聆听（自动或点击）', barOn);
  await p.evaluate(() => window.__sr.inst.emit('把空压机放到2楼202靠墙', false));
  await sleep(300);
  const prev = await p.evaluate(() => ({ bar: document.getElementById('listenTxt').textContent, box: document.getElementById('txt').value, state: document.getElementById('listenState').textContent }));
  ok('有实时预览文字', /空压机/.test(prev.bar) && /空压机/.test(prev.box), JSON.stringify(prev));
  ok('状态显示"听到了"', prev.state === '听到了', prev.state);
  await p.screenshot({ path: OUT + 'tool-7-voice.png' });
  // 只给中间结果，等静音计时器自动发出去。
  // 判定看"这句话被提交了没有"（voice.last），不看 ai 条数——
  // 大模型现在要跑多轮，回复可能好几秒，用条数判会把"已经发了"错判成"没发"。
  const want7 = '把空压机放到2楼202靠墙';
  let submitted = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const st = await p.evaluate(() => BIM.app.voice.state());
    if (st.last === want7) { submitted = true; break; }
  }
  ok('静音 1.4 秒后自动结算发送', submitted, 'voice.last=' + (await p.evaluate(() => BIM.app.voice.state().last)));
  ok('输入框已清空', (await p.evaluate(() => document.getElementById('txt').value)) === '');
  // 等这句的回复落地，免得下面【8】被上一条的 busy 挡住
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    const st = await p.evaluate(() => ({ busy: BIM.app.voice.state().busy, n: document.querySelectorAll('.msg.ai:not(.typing)').length }));
    if (!st.busy) break;
  }

  console.log('\n【8】「说完」按钮立刻发送');
  const n8 = await aiCount();
  await p.evaluate(() => window.__sr.inst.emit('看看3楼', false));
  await sleep(200);
  await p.evaluate(() => document.getElementById('btnVoiceDone').click());
  for (let i = 0; i < 80; i++) { await sleep(250); if ((await aiCount()) > n8) break; }
  ok('不等静音也能发', (await aiCount()) > n8, 'ai 条数 ' + n8 + ' → ' + (await aiCount()));

  console.log('\n【9】语音服务连不上时明确停下来');
  await p.evaluate(() => window.__sr.inst.fire('network'));
  await sleep(500);
  const st9 = await p.evaluate(() => ({ bar: !document.getElementById('listenBar').hidden, sys: [...document.querySelectorAll('.msg.sys')].pop().innerText }));
  ok('关闭聆听，不再空转', st9.bar === false);
  ok('给出人话提示', /语音|麦克风|打字/.test(st9.sys), st9.sys.slice(0, 60));

  if (errs.length) console.log('\n  页面错误：\n   ' + errs.slice(0, 5).join('\n   '));
  console.log('\n' + (fail ? fail + ' 处失败' : '全部通过（0 处失败）'));
  await b.close();
  process.exit(fail ? 1 : 0);
})();
