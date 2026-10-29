/* 端到端：说一句话放设备 → 看回执里的朝向 → 点属性看朝向行。
   node tools/oriente2e.js */
const puppeteer = require('puppeteer-core');
const OUT = __dirname + '/../outputs/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new', args: ['--use-angle=swiftshader', '--window-size=1440,900']
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.goto('http://127.0.0.1:8823/', { waitUntil: 'networkidle2' });
  await sleep(3600);

  const say = async t => {
    await p.evaluate(s => { document.getElementById('txt').value = s; document.getElementById('btnSend').click(); }, t);
    await sleep(2600);
  };

  await say('把空气压缩机放到205室靠墙');
  const r1 = await p.evaluate(() => {
    const eq = BIM.app.state.placed[BIM.app.state.placed.length - 1];
    const ds = [...document.querySelectorAll('#chat .msg')].map(m => m.textContent.trim());
    return {
      eq: eq ? { n: eq.name, rot: +eq.rot.toFixed(2), at: [+eq.x.toFixed(2), +eq.y.toFixed(2)], applied: +(eq.rotApplied || 0).toFixed(2) } : null,
      lastAI: ds.filter(s => s.indexOf('正面朝') >= 0).slice(-1)[0] || (ds.slice(-1)[0] || '').slice(0, 90)
    };
  });
  console.log('① 靠墙', JSON.stringify(r1));

  await say('把服务器机柜放到206室');
  const r2 = await p.evaluate(() => {
    const eq = BIM.app.state.placed[BIM.app.state.placed.length - 1];
    const ds = [...document.querySelectorAll('#chat .msg')].map(m => m.textContent.trim());
    return {
      eq: eq ? { n: eq.name, rot: +eq.rot.toFixed(2), at: [+eq.x.toFixed(2), +eq.y.toFixed(2)] } : null,
      lastAI: ds.filter(s => s.indexOf('正面朝') >= 0).slice(-1)[0] || ''
    };
  });
  console.log('② 未说方位', JSON.stringify(r2));

  // 点刚放的那台 → 属性里要有"正面朝向"
  const r3 = await p.evaluate(async () => {
    const eq = BIM.app.state.placed[BIM.app.state.placed.length - 1];
    BIM.app.onTreePick({ kind: 'equip', data: eq });
    await new Promise(r => setTimeout(r, 400));
    const box = document.getElementById('pProps');
    return { open: !box.classList.contains('hide'), text: (box.textContent || '').replace(/\s+/g, ' ').slice(0, 220) };
  });
  console.log('③ 属性', JSON.stringify(r3));
  await p.screenshot({ path: OUT + 'o-3-props.png' });

  // 挪到墙角 → 朝向应该跟着换墙
  await say('把服务器机柜挪到墙角');
  const r4 = await p.evaluate(() => {
    const eq = BIM.app.state.placed[BIM.app.state.placed.length - 1];
    return { n: eq.name, rot: +eq.rot.toFixed(2), at: [+eq.x.toFixed(2), +eq.y.toFixed(2)], applied: +(eq.rotApplied || 0).toFixed(2) };
  });
  console.log('④ 挪到墙角', JSON.stringify(r4));

  console.log('错误', errs.length ? errs.slice(0, 3) : '无');
  await b.close();
})();
