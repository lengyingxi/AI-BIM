const puppeteer = require('puppeteer-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
(async () => {
  const b = await puppeteer.launch({
    executablePath: EDGE, headless: 'shell',
    args: ['--use-angle=swiftshader', '--no-sandbox', '--window-size=1280,860']
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1280, height: 860 });
  p.on('pageerror', e => console.log('PAGEERR', e.message));
  await p.goto('http://127.0.0.1:8823/', { waitUntil: 'networkidle2', timeout: 60000 });
  await p.waitForFunction(() => window.BIM && BIM.detail, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));

  const r = await p.evaluate(() => {
    BIM.scene.setFocus(2, false);
    BIM.detail.setFlow(true);
    const M = BIM_MODEL;
    let fm = null;
    BIM.scene.root().traverse(o => { if (o.isInstancedMesh) fm = o; });
    const out = {
      found: !!fm, count: fm ? fm.count : 0, vis: fm ? fm.visible : null,
      pv: fm && fm.parent ? fm.parent.visible : null,
      mat: fm ? [fm.material.type, fm.material.color.getHexString(), fm.material.transparent] : null,
      p0: null, geoR: fm ? fm.geometry.boundingSphere : null
    };
    if (fm) {
      const m = new THREE.Matrix4(), v = new THREE.Vector3();
      fm.getMatrixAt(0, m);
      v.setFromMatrixPosition(m);
      out.p0 = [v.x.toFixed(2), v.y.toFixed(2), v.z.toFixed(2)];
      // 投影所有实例，看有几个在屏幕内
      const cam = BIM.scene.camera();
      let inside = 0;
      for (let i = 0; i < fm.count; i++) {
        fm.getMatrixAt(i, m); v.setFromMatrixPosition(m);
        const q = v.clone().project(cam);
        if (Math.abs(q.x) < 1 && Math.abs(q.y) < 1 && q.z < 1) inside++;
      }
      out.inside = inside;
      out.cam = [cam.position.x.toFixed(1), cam.position.y.toFixed(1), cam.position.z.toFixed(1)];
      out.target = BIM.scene.controlsTarget ? 'y' : 'n/a';
    }
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
  await b.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
