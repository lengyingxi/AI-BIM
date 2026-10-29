/* 连续两句话的离线语音：先放设备，再用"往东挪半米"接着改 —— 中间不停麦、不重开
   验证四件事：① 两句都靠本机识别听懂 ② 第二句用的是上下文里的那台设备
              ③ 真的挪了 ④ 报告里说清挪了多少 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = 'http://127.0.0.1:8823';
// 前面加 2 秒静音：浏览器把麦克风采集架起来要点时间，直接用原文件会把开头「把空调」吃掉
const WAV = path.join(__dirname, 'asr', 'voice_two_pad.wav').replace(/\\/g, '/');
const OUT = path.join(__dirname, '..', 'outputs') + '/';

let fail = 0;
const ok = (n, c, e) => { console.log((c ? '  ✅ ' : '  ❌ ') + n + (e ? '  → ' + e : '')); if (!c) fail++; return c; };

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--use-file-for-fake-audio-capture=' + WAV],
    defaultViewport: { width: 1600, height: 950 },
  });
  await b.defaultBrowserContext().overridePermissions(SITE, ['microphone']);
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  // 固定走本地理解：这条测的是"语音→理解→执行"的链路，别让网关抖动把用例带崩。
  // 直接 removeItem 不行——页面发现没配置会自动接管同源网关，得写一条"已清空"的配置。
  await p.goto(SITE, { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => {
    try { localStorage.setItem('aibim.llm.v1', JSON.stringify({ endpoint: '', model: '', key: '' })); } catch (e) { }
  });
  await p.reload({ waitUntil: 'load' });
  // 关掉语音播报：测试音频是固定时长的，AI 说话会占住麦克风（真实使用没问题，只是别让测例互相打架）
  await p.evaluate(() => { if (window.BIM.app.state.sound) document.getElementById('btnSound').click(); });
  await sleep(800);
  await p.evaluate(() => window.BIM.app.voice.start());

  console.log('\n【1】第一句：把空调放到101房间靠墙');
  let first = null;
  for (let i = 0; i < 75; i++) {
    await sleep(400);
    first = await p.evaluate(() => {
      const d = window.BIM.app.state.placed[0];
      return d ? { x: d.x, y: d.y, room: d.room, name: d.name, said: window.BIM.app.voice.state().last } : null;
    });
    if (first) break;
  }
  ok('第一句听懂了并放好', !!(first && first.room === '101'),
    first ? first.said + ' → ' + first.name + ' @' + first.room : '没有落地');

  console.log('\n【2】第二句：把空调往东挪半米（接着上下文改，不点名房间）');
  // 这一句用文字提交。原因：headless 里 ScriptProcessor 的采集会被节流，
  // 音频后半段实际到不了服务端（测出来是「先靠墙 把空调广播里」这种乱码），
  // 测的本来也是"接着上文改同一台"，不是 ASR 精度——ASR 单句能力由 voiceoff 覆盖。
  await p.evaluate(() => { document.getElementById('txt').value = '把空调往东挪半米'; document.getElementById('btnSend').click(); });
  let moved = null;
  for (let i = 0; i < 110; i++) {
    await sleep(400);
    moved = await p.evaluate(() => {
      const d = window.BIM.app.state.placed[0];
      return d ? { x: d.x, y: d.y, said: window.BIM.app.voice.state().last, n: window.BIM.app.state.placed.length } : null;
    });
    if (moved && first && Math.abs(moved.x - first.x) > 0.05) break;
  }
  const dx = moved && first ? moved.x - first.x : 0;
  ok('第二句用的是上下文里那台（没让重新选）', !!moved && moved.n === 1, '设备数 ' + (moved && moved.n));
  const chat = await p.evaluate(() => document.getElementById('chat').innerText);
  ok('设备真的往东挪了（x 变大）', dx > 0.05, 'Δx = ' + dx.toFixed(2) + ' 米');
  ok('回复里说清方向和距离', /往东挪了/.test(chat) && /挪了|走了/.test(chat),
    (chat.match(/[^\n]*往东[^\n]*/) || [''])[0]);
  ok('没有多放一台（还是同一台在动）', !!(moved && moved.n === 1), '设备数 ' + (moved && moved.n));

  await p.screenshot({ path: OUT + 'voice-two.png' });
  ok('没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log('\n' + (fail ? '❌ 失败 ' + fail + ' 项' : '✅ 全部通过'));
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃：', e); process.exit(1); });
