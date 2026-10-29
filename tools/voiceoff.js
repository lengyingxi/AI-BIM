/* 离线语音验收：不连外网、不用浏览器识别，真音频 → 本机 vosk → 放设备
   用 Chrome/Edge 的假麦克风把一段中文语音喂进去，看系统能不能听懂并照做。 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = 'http://127.0.0.1:8823';
const WAV = path.join(__dirname, 'asr', 'voice_cmd.wav').replace(/\\/g, '/');
const OUT = path.join(__dirname, '..', 'outputs') + '/';

let fail = 0;
const ok = (n, c, e) => { console.log((c ? '  ✅ ' : '  ❌ ') + n + (e ? '  → ' + e : '')); if (!c) fail++; return c; };

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--use-file-for-fake-audio-capture=' + WAV, '--allow-file-access-from-files'],
    defaultViewport: { width: 1600, height: 950 },
  });
  await b.defaultBrowserContext().overridePermissions(SITE, ['microphone']);
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  console.log('\n【1】页面能认出本机离线识别');
  await p.goto(SITE, { waitUntil: 'load' });
  await sleep(1500);
  const health = await p.evaluate(() => fetch('/asr/health').then(r => r.json()));
  ok('后端 /asr/health 可用', health && health.ok, health && health.model);
  await p.evaluate(() => window.BIM.agent.saveCfg({ endpoint: '', model: '', key: '' }));
  // 关掉语音播报：测试音频是固定时长的，AI 说话会占住麦克风（真实使用没问题，只是别让测例互相打架）
  await p.evaluate(() => { if (window.BIM.app.state.sound) document.getElementById('btnSound').click(); });
  const mode = await p.evaluate(() => window.BIM.app.voice.mode());
  ok('页面自动选中本机通道（不用浏览器识别）', mode === 'local', 'mode=' + mode);

  console.log('\n【2】真音频喂进去，边听边出字');
  await p.evaluate(() => window.BIM.app.voice.start());
  await sleep(900);
  const st1 = await p.evaluate(() => ({
    s: window.BIM.app.voice.state(),
    bar: !document.getElementById('listenBar').hidden
  }));
  ok('麦克风开着、波形条出现', st1.bar === true && st1.s.listening === true);
  let preview = '';
  for (let i = 0; i < 22; i++) {                       // 边说边出字：不等到说完（无头环境麦克风起得慢）
    preview = await p.evaluate(() => document.getElementById('listenTxt').textContent ||
      document.getElementById('txt').value);
    if (preview) break;
    await sleep(400);
  }
  ok('已经开始出字（不是"一直在听"）', !!preview, '预览=' + preview);
  // 把"正在听 + 已经出字"这一刻截下来
  const clip = await p.evaluate(() => {
    const r = document.querySelector('.input-wrap').getBoundingClientRect();
    const b2 = document.getElementById('listenBar').getBoundingClientRect();
    const x = Math.max(0, Math.min(r.x, b2.x) - 8);
    const y = Math.max(0, Math.min(r.y, b2.y) - 34);
    const bottom = Math.max(r.bottom, b2.bottom);
    return { x, y, width: Math.min(880, Math.max(r.right, b2.right) - x + 8),
      height: Math.min(320, bottom - y + 12) };
  });
  await p.screenshot({ path: OUT + 'voice-offline-2.png', clip });

  console.log('\n【3】停 1.4 秒自动结算并执行');
  let placed = 0, said = '', box = '';
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    const s = await p.evaluate(() => ({
      n: window.BIM.app.state.placed.length,
      box: document.getElementById('txt').value,
      last: (document.querySelectorAll('#chat .msg') || []).length
    }));
    placed = s.n; box = s.box;
    if (placed > 0) break;
  }
  const all = await p.evaluate(() => document.getElementById('chat').innerText);
  ok('识别结果落进了输入流（不是空话）', placed > 0 || /空调|放置|101/.test(all),
    '已放设备 ' + placed + ' 台');
  const placedInfo = await p.evaluate(() => {
    const d = window.BIM.app.state.placed[0];
    if (!d) return null;
    const rm = ((window.BIM_MODEL || {}).rooms || []).find(r => r.id === d.room);
    return { name: d.name, id: d.room, num: rm ? String(rm.num) : '?' };
  });
  ok('听懂了房间号（101）', !!(placedInfo && placedInfo.num === '101'),
    JSON.stringify(placedInfo));
  const heardTxt = await p.evaluate(() => window.BIM.app.voice.state().last);
  ok('识别原文里带 101（同音字已纠正）', /101/.test(heardTxt || ''), heardTxt);
  ok('聊天里有回复', /空调|放|房间|楼板/.test(all), all.split('\n').filter(Boolean).slice(-1)[0] || '');

  console.log('\n【4】截图留证');
  await p.screenshot({ path: OUT + 'voice-offline-1.png' });

  ok('没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log('\n' + (fail ? '❌ 失败 ' + fail + ' 项' : '✅ 全部通过'));
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃：', e); process.exit(1); });
