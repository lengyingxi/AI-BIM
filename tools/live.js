/* 真网关联调：清空本地配置 → 自动接网关 → 自然语言下发 → 大模型规划 → 落设备 */
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const URL = 'http://127.0.0.1:8823/index.html';

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
  const opt = [];
  p.on('request', r => { if (r.method() === 'OPTIONS') opt.push(r.url()); });

  // 先访问一次以拿到源，清掉本地缓存，再进页面（模拟用户第一次打开）
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => localStorage.clear());
  await p.goto(URL, { waitUntil: 'networkidle2' });
  await sleep(2200);

  const ok = (n, c, e) => { console.log((c ? '  ✅ ' : '  ❌ ') + n + (e ? '  → ' + e : '')); return c; };
  let fail = 0;

  console.log('\n【1】自动接网关');
  const cfg = await p.evaluate(() => {
    const A = window.BIM.agent;
    return { ep: A.cfg.endpoint, model: A.cfg.model, on: A.cfg.on, key: !!A.cfg.key };
  });
  if (!ok('/llm-config 已自动填地址', cfg.ep === '/llm/v1', JSON.stringify(cfg))) fail++;
  if (!ok('自动选中可用模型', !!cfg.model && cfg.model === 'qwen3.8-max', cfg.model)) fail++;
  if (!ok('开关打开（相对地址免密钥）', cfg.on === true)) fail++;
  const head = await p.evaluate(() => (document.getElementById('ctxNow') || {}).textContent || '');
  const chip = await p.evaluate(() => { const e = document.getElementById('btnAI'); return e ? e.textContent.trim() : ''; });
  console.log('     顶栏：' + head + ' ｜ 芯片：' + chip);

  console.log('\n【2】真连一次（设置面板里的"测试连接"）');
  await p.evaluate(() => document.getElementById('btnAI').click());
  await sleep(300);
  await p.evaluate(() => document.getElementById('llmTest').click());
  let diag = '';
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    diag = await p.evaluate(() => (document.getElementById('llmDiag') || {}).textContent || '');
    if (/HTTP \d{3}/.test(diag)) break;
  }
  console.log('     诊断：' + diag.replace(/\s+/g, ' ').slice(0, 180));
  if (!ok('测试返回 200', /HTTP 200/.test(diag), diag.slice(0, 120))) fail++;

  console.log('\n【3】自然语言下发');
  await p.evaluate(() => { const b = document.querySelector('#pAI .p-close') || document.querySelector('#pAI [data-close]'); if (b) b.click(); });
  await sleep(200);
  const before = await p.evaluate(() => window.BIM.app.state.placed.length);
  await p.evaluate(() => {
    const i = document.getElementById('txt');
    i.value = '把空压机放到2楼202靠里';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.evaluate(() => document.getElementById('btnSend').click());

  let plan = null;
  for (let i = 0; i < 60; i++) {
    await sleep(700);
    plan = await p.evaluate(() => window.BIM._lastPlan || null);
    if (plan) break;
  }
  console.log('     规划来源：' + (plan && plan.source) + ' ｜ 步数：' + (plan && plan.steps ? plan.steps.length : '-'));
  if (plan) console.log('     步骤：' + JSON.stringify(plan.steps).slice(0, 260));
  if (!ok('走的是大模型（source=llm）', !!plan && plan.source === 'llm', plan && plan.source)) fail++;

  const after = await p.evaluate(() => window.BIM.app.state.placed.length);
  if (!ok('设备数量增加', after > before, before + ' → ' + after)) fail++;
  const last = await p.evaluate(() => {
    const d = window.BIM.app.state.placed[window.BIM.app.state.placed.length - 1];
    return d ? { name: d.name || d.label, room: d.room, floor: d.floor, x: d.x, y: d.y, z: d.z } : null;
  });
  console.log('     新设备：' + JSON.stringify(last));

  console.log('\n【4】无跨域预检');
  if (!ok('全程 0 个 OPTIONS', opt.length === 0, String(opt.length))) fail++;

  const err = await p.evaluate(() => (document.getElementById('llmDiag') || {}).textContent || '');
  if (errs.length) console.log('\n  页面错误：\n   ' + errs.slice(0, 6).join('\n   '));
  console.log('\n' + (fail === 0 ? '全部通过（' + 0 + ' 处失败）' : fail + ' 处失败'));
  await b.close();
  process.exit(fail === 0 ? 0 : 1);
})();
