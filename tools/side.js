/* 转完镜头再说"左边那面墙开个门"——必须落在画面上看到的那面墙
   以前 findSide 把"左"写死成西墙，镜头一转就开到别的墙上去了。
   这里把相机依次摆到房间正东、正南、正北，每次都说"左边"，
   落点必须分别是南墙、西墙、东墙（站在东边往西看，左手边就是南）。 */
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = 'http://127.0.0.1:8823';
const path = require('path');
const OUT = path.join(__dirname, '..', 'outputs') + '/';

let fail = 0;
const ok = (n, c, e) => { console.log((c ? '  ✅ ' : '  ❌ ') + n + (e ? '  → ' + e : '')); if (!c) fail++; return c; };

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1500, height: 900 },
  });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  // 固定走本地理解，结果才可复现。
  // 注意：不能直接 removeItem —— 页面发现"没配置"会自动接管同源网关，
  // 必须写一条"用户已经清空过"的配置（touched=true），它才不会接管。
  await p.goto(SITE, { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => {
    try { localStorage.setItem('aibim.llm.v1', JSON.stringify({ endpoint: '', model: '', key: '' })); } catch (e) { }
  });
  await p.reload({ waitUntil: 'load' });
  await sleep(900);
  const llmOn = await p.evaluate(() => !!window.BIM.agent.cfg.on);
  if (llmOn) console.log('  （注意：大模型还连着，测试会变慢）');

  const room = await p.evaluate(() => {
    const r = window.BIM.app.model().rooms.find(x => x.num === '202');
    return { id: r.id, x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, elev: r.elev, sides: r.sides };
  });

  // 把相机摆到房间的某个方位（dir: 'east' 表示站在房间东侧往中心看）
  const placeCam = (dir) => p.evaluate(({ r, dir }) => {
    const S = window.BIM.scene;
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2, y = r.elev + 0.5;
    const D = 14, UP = 9;
    const off = {
      east: [D, 0], west: [-D, 0], north: [0, -D], south: [0, D]
    }[dir];
    // three: x = bimX, z = -bimY
    S.setCam(cx + off[0], y + UP, -cy + off[1], cx, y, -cy);
  }, { r: room, dir });

  // 发一句话，固定等它处理完（本地理解一句 2.6 秒足够；按消息条数判断会漏掉"一句回两条"的情况）
  const say = async (t, ms) => {
    await p.evaluate((r) => {
      const rm = window.BIM.app.model().rooms.find(x => x.id === r.id);
      const c = window.BIM.agent.mem.ctx;
      c.room = rm; c.floor = rm.floor;
    }, room);
    await p.evaluate(t => { document.getElementById('txt').value = t; document.getElementById('btnSend').click(); }, t);
    await sleep(ms || 2600);
  };

  const lastEq = () => p.evaluate(() => {
    const list = window.BIM.app.state.placed || [];
    const e = list[list.length - 1];
    return e ? { name: e.name, x: e.x, y: e.y, room: e.room } : null;
  });

  // 现在门开在哪面墙（用 lastDoor 的 wall 反查侧向）
  const lastSide = () => p.evaluate((r) => {
    const st = window.BIM.app.state;
    const d = st.lastDoor && st.lastDoor.d;
    if (!d) return null;
    const w = st.lastDoor.wall || window.BIM.app.model().walls.find(x => x.id === d.wall);
    const k = Object.keys(r.sides).find(k => r.sides[k] === (w && w.id));
    return { side: k, wallId: w && w.id, name: d.name, w: d.w };
  }, room);

  // 画面上"左"到底朝着哪个罗盘方向：取相机自身的右轴（不经过透视，也就不会被近大远小带偏）
  const leftCompass = () => p.evaluate(() => {
    const S = window.BIM.scene;
    const q = S.camera().quaternion;
    const rv = new THREE.Vector3(1, 0, 0).applyQuaternion(q);   // 世界坐标里的"屏幕右"
    rv.y = 0; rv.normalize();
    const rb = { x: rv.x, y: -rv.z };                            // three → BIM(x, -z)
    let best = null, bd = -9;
    [['east', 1, 0], ['west', -1, 0], ['north', 0, 1], ['south', 0, -1]].forEach(([k, dx, dy]) => {
      const s = -(rb.x * dx + rb.y * dy);                        // 取反 = 屏幕左
      if (s > bd) { bd = s; best = k; }
    });
    return { k: best };
  });

  await say('你好', 2600);          // 预热一句，等前端完全就绪再开始测
  console.log('【1】站在房间东边，往西看');
  await placeCam('east');
  await sleep(500);
  let L = await leftCompass();
  ok('画面上"左"确实是南边', L.k === 'south', '往左走 = ' + L.k);
  await say('左边那面墙开个 1.2 米的门', 1700);
  let got = await lastSide();
  const lastAI = await p.evaluate(() => {
    const n = document.querySelectorAll('#chat .msg.ai');
    return n.length ? n[n.length - 1].textContent.trim().slice(0, 90) : '';
  });
  await p.screenshot({ path: OUT + 'side-east.png' });
  ok('门开在南墙', got && got.side === 'south', got ? got.side + ' / ' + got.wallId + ' / ' + got.w + ' m' : '没开门｜AI: ' + lastAI);

  console.log('\n【2】站在房间北边，往南看');
  await placeCam('north');
  await sleep(600);
  L = await leftCompass();
  ok('画面上"左"变成了东边', L.k === 'east', '往左走 = ' + L.k);
  await say('左边那面墙开个 1.0 米的门', 1700);
  got = await lastSide();
  await p.screenshot({ path: OUT + 'side-north.png' });
  ok('门开在东墙', got && got.side === 'east', got ? got.side + ' / ' + got.wallId : '没开门');

  console.log('\n【3】站在房间南边，往北看');
  await placeCam('south');
  await sleep(600);
  L = await leftCompass();
  ok('画面上"左"变回西边', L.k === 'west', '往左走 = ' + L.k);
  await say('左边那面墙开个 1.0 米的门', 1700);
  got = await lastSide();
  ok('门开在西墙', got && got.side === 'west', got ? got.side + ' / ' + got.wallId : '没开门');

  console.log('\n【4】说"前面那面墙"——正对着你的那面（远端）');
  await placeCam('east');
  await sleep(600);
  await say('前面那面墙开个 1.0 米的门', 1700);
  got = await lastSide();
  ok('门开在西墙（相机正对的那面）', got && got.side === 'west', got ? got.side : '没开门');

  console.log('\n【5】说"东边"——明说罗盘就不该跟镜头变');
  await placeCam('south');
  await sleep(600);
  await say('东边那面墙开个 1.0 米的门', 1700);
  got = await lastSide();
  ok('还是东墙', got && got.side === 'east', got ? got.side : '没开门');

  console.log('\n【7】"放到左边"——设备也要落在画面左边那一侧');
  // 换一间没开过门的房间，免得被刚开的门挤掉位置
  const r2 = await p.evaluate(() => {
    const rm = window.BIM.app.model().rooms.find(x => x.num === '305');
    return { id: rm.id, num: rm.num, x0: rm.x0, y0: rm.y0, x1: rm.x1, y1: rm.y1, elev: rm.elev };
  });
  const camAt = (dir) => p.evaluate(({ r, dir }) => {
    const S = window.BIM.scene;
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2, y = r.elev + 0.5, D = 14, UP = 9;
    const off = { east: [D, 0], west: [-D, 0], north: [0, -D], south: [0, D] }[dir];
    S.setCam(cx + off[0], y + UP, -cy + off[1], cx, y, -cy);
  }, { r: r2, dir });

  await camAt('east');
  await sleep(600);
  await say('把空压机放到 305 左边', 1800);
  let eq = await lastEq();
  ok('设备落在南侧（站东边往西看，左边是南）', eq && eq.y < (r2.y0 + r2.y1) / 2 - 0.4,
    eq ? 'x=' + eq.x.toFixed(1) + ' y=' + eq.y.toFixed(1) + '（中线 ' + ((r2.y0 + r2.y1) / 2).toFixed(1) + '，南墙 ' + r2.y0.toFixed(1) + '）' : '没放下');

  await camAt('north');
  await sleep(600);
  await say('把空压机放到 305 左边', 1800);
  eq = await lastEq();
  ok('设备落在东侧（站北边往南看，左边是东）', eq && eq.x > (r2.x0 + r2.x1) / 2 + 0.4,
    eq ? 'x=' + eq.x.toFixed(1) + ' y=' + eq.y.toFixed(1) + '（中线 ' + ((r2.x0 + r2.x1) / 2).toFixed(1) + '，东墙 ' + r2.x1.toFixed(1) + '）' : '没放下');

  console.log('\n【6】稳定性');
  ok('没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log('\n' + (fail ? '❌ 失败 ' + fail + ' 项' : '✅ 全部通过'));
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃：', e); process.exit(1); });
