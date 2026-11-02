/* 总开关 vs 分路：控制范围分开，取证五屏
   ① 三路全合（基线）
   ② 只断第 1 分路：那一路手柄落下变红，另两路不动
   ③ 走一遍对话"把2楼总开关拉下来"：总开关手柄落下、三路手柄仍朝上、灯变暗
   ④ 日常浏览（没开电气视图）时配电箱仍在墙上
   ⑤ 查看回路影响：主干立管只画本层这一段
   用法：SITE=http://127.0.0.1:8899 node tools/shot5.js */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = process.env.SITE || 'http://127.0.0.1:8899';
const OUT = 'outputs';
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const b = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    defaultViewport: { width: 1500, height: 900 }
  });
  const p = await b.newPage();
  await p.goto(SITE + '/index.html', { waitUntil: 'networkidle2' });
  await sleep(2400);

  /* 截图前把会挡视线的面板/吊顶/家具关掉 */
  await p.evaluate(() => {
    const t = document.querySelector('[data-close="pTree"]'); if (t) t.click();
    if (BIM.detail && BIM.detail.setCeiling) BIM.detail.setCeiling(false);
    if (BIM.detail && BIM.detail.setFurniture) BIM.detail.setFurniture(false);
  });

  /* ① 三路全合 —— 基准 */
  await p.evaluate(() => {
    const E = BIM.elec, S = BIM.scene;
    E.togglePanel(2, true);
    E.list(2).forEach(c => E.toggle(c.id, true));
    S.refreshPanels(2);
    S.focusPanel(2);
    /* focusPanel 会把透视关掉（要看清手柄），但那样视野就被一面实墙塞满。
       这里再开回来，三张图的机位和透视保持一致，才好对比开关状态。 */
    S.showConduits(true);
    S.syncCircuitPower();
  });
  await sleep(2200);
  await p.screenshot({ path: OUT + '/p5_panel_all_on.png' });

  /* ② 只断第 1 分路：只动那一只手柄 */
  await p.evaluate(() => {
    const E = BIM.elec, S = BIM.scene;
    E.toggle('L2A', false);
    S.refreshPanels(2);
    S.showConduits(true);
    S.syncCircuitPower();
  });
  await sleep(1600);
  await p.screenshot({ path: OUT + '/p6_branch_off.png' });

  /* ③ 总开关：走对话，看箱子 + 回复卡片 */
  await p.evaluate(async () => {
    const E = BIM.elec, S = BIM.scene;
    E.toggle('L2A', true);                 // 先复位那一路，免得混在一起
    S.refreshPanels(2);
    await BIM.app.send('把2楼总开关拉下来');
  });
  await sleep(3200);
  await p.screenshot({ path: OUT + '/p7_main_off.png' });

  /* ④ 日常浏览：电气视图关掉 —— 箱子和门、设备一样还在墙上，管线一根都不画 */
  await p.evaluate(() => {
    const E = BIM.elec, S = BIM.scene;
    E.togglePanel(2, true);
    E.list(2).forEach(c => E.toggle(c.id, true));
    S.refreshPanels(2);          // 几何按"全合"重烘，不然截图里还是断闸的样子
    S.focusPanel(2);             // 先把镜头站到箱子前
  });
  await sleep(1800);             // 等 flyTo 的 780 ms 缓动走完
  await p.evaluate(() => {
    const S = BIM.scene;
    S.showConduits(false);       // ← 关掉电气层：管线全部收起，配电箱不动
    S.setXray(true);             // 墙体半透明，才看得清箱子挂在哪面墙上
  });
  await sleep(1600);
  await p.screenshot({ path: OUT + '/p8_panel_daily.png' });

  /* ⑤ 查看回路影响：主干立管只画本层这一段（镜头压到竖井旁边看得清） */
  await p.evaluate(() => {
    const E = BIM.elec, S = BIM.scene;
    const c = E.circuit('L2A');
    S.circuitRoute(c, E.circuitRooms('L2A'));
    const pn = E.panelOf(2);
    S.focusBounds(2, pn.x - 5, pn.y - 5, pn.x + 5, pn.y + 5);
  });
  await sleep(2400);
  await p.screenshot({ path: OUT + '/p9_trunk_local.png' });

  /* 顺手把数据打出来，截图之外还能对一眼 */
  const info = await p.evaluate(() => {
    const E = BIM.elec, S = BIM.scene;
    const c = E.circuit('L2A');
    const route = (E.ready().conduits || []).filter(x =>
      x.circuit === c.id || ((x.layer === 'trunk' || x.layer === 'feed') && x.floor === c.floor));
    return {
      trunk: route.filter(x => x.layer === 'trunk').map(x => x.id + '@' + x.floor + 'F'),
      feed: route.filter(x => x.layer === 'feed').length,
      corridor: route.filter(x => x.layer === 'corridor').length,
      drop: route.filter(x => x.layer === 'drop').length,
      room: route.filter(x => x.layer === 'room').length,
      mainOn: E.mainOn(2),
      switch: E.list(2).map(x => x.id + ':' + (x.switch_on ? '合' : '断') + '/' + (x.on ? '有电' : '无电')),
      panelsVisible: (S.root().getObjectByName('panels') || { visible: null }).visible
    };
  });
  console.log('五张图已更新 → outputs/p5…p9');
  console.log('L2A 路由：主干 ' + JSON.stringify(info.trunk) + '，层进线 ' + info.feed +
    '，走廊 ' + info.corridor + '，下引 ' + info.drop + '，支线 ' + info.room);
  console.log('2F 开关：' + info.switch.join(' | ') + '，panels.visible=' + info.panelsVisible);
  await b.close();
})();
