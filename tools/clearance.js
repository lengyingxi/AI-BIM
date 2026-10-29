/* 四周净距（虚框标注）+ MCP 工具 验收 */
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = 'http://127.0.0.1:8823';
const OUT = require('path').join(__dirname, '..', 'outputs') + '/';

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

  const say = async (t) => {
    const before = await p.evaluate(() => document.querySelectorAll('.msg.ai:not(.typing)').length);
    await p.type('#txt', t);
    await p.keyboard.press('Enter');
    for (let i = 0; i < 240; i++) {
      await sleep(250);
      const st = await p.evaluate(() => ({ n: document.querySelectorAll('.msg.ai:not(.typing)').length, ty: !!document.querySelector('.msg.ai.typing') }));
      if (!st.ty && st.n > before) break;
    }
    await sleep(900);
    return p.evaluate(() => {
      const q = window.BIM._lastPlan || {};
      return {
        src: q.source, tools: q.tools || [], calls: q.calls || 0,
        ai: [...document.querySelectorAll('.msg.ai:not(.typing)')].pop().innerText.replace(/\n+/g, ' | ')
      };
    });
  };
  const clrCount = () => p.evaluate(() => {
    // 标注是一组 Line + Sprite，挂在 scene 上；数一下带 renderOrder=9/13 的对象
    let n = 0;
    window.BIM.scene.__scene ? null : null;
    return n;
  });

  console.log('\n【1】工具层：query_clearance 已注册');
  const t1 = await p.evaluate(() => ({
    names: (window.BIM.mcp.tools || []).map(x => x.function.name),
    bound: Object.keys(window.BIM.mcp.handlers || {})
  }));
  ok('工具清单里有 query_clearance', t1.names.indexOf('query_clearance') >= 0, '共 ' + t1.names.length + ' 个');
  ok('有对应处理器', t1.bound.indexOf('query_clearance') >= 0);

  console.log('\n【2】几何口径：净距算得对');
  const geo = await p.evaluate(() => {
    const M = window.BIM_MODEL, C = window.BIM.calc;
    const r = M.rooms.find(x => x.num === '203');
    // 放一台到正中偏下，四周应该是明确的四个数
    const dev = { name: '测试机', w: 2.0, d: 1.2, h: 1.5, weight: 1000, rot: 0 };
    const eq = Object.assign({ id: 'T1', room: r.id, x: (r.x0 + r.x1) / 2, y: r.y0 + 1.6, floor: r.floor }, dev);
    const cl = C.clearance({ room: r, equip: eq, x: eq.x, y: eq.y, others: [] });
    return {
      room: { x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1 },
      eq: { x: eq.x, y: eq.y, w: eq.w, d: eq.d },
      west: +cl.west.v.toFixed(3), east: +cl.east.v.toFixed(3),
      south: +cl.south.v.toFixed(3), north: +cl.north.v.toFixed(3),
      face: cl.face, faceV: +cl.faceV.toFixed(3), minCn: cl.minCn, minV: +cl.minV.toFixed(3)
    };
  });
  // 手算：203 房间 6.6×6.6 起步，设备 2.0(x) × 1.2(y)，放在 y0+1.6
  const westWant = geo.eq.x - 1.0 - geo.room.x0;
  const eastWant = geo.room.x1 - (geo.eq.x + 1.0);
  const southWant = (geo.eq.y - 0.6) - geo.room.y0;
  const northWant = geo.room.y1 - (geo.eq.y + 0.6);
  ok('左侧 = 到西墙', Math.abs(geo.west - westWant) < 0.02, geo.west + ' vs ' + westWant.toFixed(3));
  ok('右侧 = 到东墙', Math.abs(geo.east - eastWant) < 0.02, geo.east + ' vs ' + eastWant.toFixed(3));
  ok('南侧 = 到南墙', Math.abs(geo.south - southWant) < 0.02, geo.south + ' vs ' + southWant.toFixed(3));
  ok('北侧 = 到北墙', Math.abs(geo.north - northWant) < 0.02, geo.north + ' vs ' + northWant.toFixed(3));
  ok('rot=0 时正面朝南（背靠北墙）', geo.face === 'south', geo.face);
  ok('最窄侧取四个方向的最小值', Math.abs(geo.minV - Math.min(geo.west, geo.east, geo.south, geo.north)) < 0.02,
    geo.minCn + ' ' + geo.minV);

  console.log('\n【3】说一句话：给数值 + 画虚框');
  await say('把空压机放到 5 楼 203 靠里');
  const r3 = await say('这个设备旁边还有多少空间');
  ok('走的是工具调用', r3.calls > 0, JSON.stringify(r3.tools));
  ok('调了 query_clearance', r3.tools.indexOf('query_clearance') >= 0, r3.tools.join(','));
  ok('回复里有左/右/南/北四个数', /左侧/.test(r3.ai) && /右侧/.test(r3.ai) && /南侧/.test(r3.ai) && /北侧/.test(r3.ai), r3.ai.slice(0, 90));
  ok('回复点了最窄的一侧', /最窄/.test(r3.ai), (r3.ai.match(/最窄[^。]{0,30}/) || [''])[0]);
  ok('回复提了正面检修面', /检修面|正面朝/.test(r3.ai), (r3.ai.match(/正面朝[^。]{0,40}/) || [''])[0]);

  console.log('\n【4】虚框真的进了场景');
  const info = await p.evaluate(() => window.BIM.scene.clearanceInfo());
  ok('场景里有一组净距标注', !!info, JSON.stringify(info));
  ok('画了设备轮廓 + 四条余量带边框', info && info.lines >= 5, info && ('lines=' + info.lines));
  ok('四条余量带都铺出来了', info && info.bands === 4, info && ('bands=' + info.bands));
  ok('四个方向都有数值标签（+检修面）', info && info.sprites >= 4, info && ('sprites=' + info.sprites));
  ok('有一条指向检修面的箭头', info && info.arrows === 1, info && ('arrows=' + info.arrows));

  // 标注真的"看得见"才算数：算出每个标签在屏幕上占多少像素（<20 px 就别指望能读）
  console.log('\n【4b】标注在屏幕上的实际大小');
  const px = await p.evaluate(() => window.BIM.scene.clearanceScreen());
  const small = (px || []).filter(x => x.px < 20);
  ok('每个数值标签都 ≥ 20 px 高', !!px && px.length >= 4 && small.length === 0,
    (px || []).map(x => (x.side || '?') + ':' + x.px + 'px').join('  '));

  console.log('\n【5】数值和卡片对得上');
  // 注意只取标量：state.lastClr 里挂着 room/equip 和 THREE 对象，整包返回来序列化不了
  const st = await p.evaluate(() => {
    const s = window.BIM.app.state.lastClr;
    if (!s) return null;
    return {
      name: s.eq.name,
      west: +(+s.cl.west.v).toFixed(2), east: +(+s.cl.east.v).toFixed(2),
      south: +(+s.cl.south.v).toFixed(2), north: +(+s.cl.north.v).toFixed(2)
    };
  });
  ok('会话里存了这次净距结果', !!st, st ? ('device=' + st.name) : 'null');
  if (st) {
    const cardNums = await p.evaluate(() => {
      const el = [...document.querySelectorAll('.msg.ai .res .res-grid')].pop();
      return el ? [...el.querySelectorAll('b')].map(x => x.textContent.trim()) : [];
    });
    const want = [st.west, st.east, st.south, st.north].map(v => v.toFixed(2) + ' m');
    ok('卡片四个数与计算一致', cardNums.length === 4 && cardNums.join('|') === want.join('|'),
      cardNums.join(' / ') + '  vs  ' + want.join(' / '));
  }

  // 趁虚框还在，先留一张现场图（把模型树面板收起来，别挡住标注）
  await p.evaluate(() => {
    const b = document.querySelector('#toolbar button[data-k="tree"].on');
    if (b) b.click();
  });
  await sleep(700);
  await p.screenshot({ path: OUT + 'clearance.png' });

  console.log('\n【6】收掉虚框');
  await p.evaluate(() => {
    const btns = [...document.querySelectorAll('.chips button')];
    const b = btns.find(x => /收掉虚框/.test(x.textContent));
    if (b) b.click();
  });
  await sleep(600);
  const after = await p.evaluate(() => window.BIM.scene.clearanceInfo());
  ok('点"收掉虚框"后场景干净了', after === null, JSON.stringify(after));

  if (errs.length) console.log('\n  页面错误：\n   ' + errs.slice(0, 6).join('\n   '));
  console.log('\n' + (fail ? fail + ' 处失败' : '全部通过（0 处失败）'));
  await b.close();
  process.exit(fail ? 1 : 0);
})();
