// Renders the app's own 3D sequences frame by frame to public/data/video.
// Usage: start `npx vite --port 5199`, then `node scripts/capture_video.mjs`. Needs ffmpeg with libx264.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const URL_ = process.env.URL ?? 'http://localhost:5199/';
const OUT = new URL('../public/data/video/', import.meta.url).pathname;
const FPS = 30;
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });

async function page() {
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })).newPage();
  p.on('pageerror', (e) => console.log('PAGEERR', e.message));
  await p.goto(URL_);
  await p.waitForFunction(() => window.__viewer?.slots.size >= 26 && window.__viewer.boxA && !window.__viewer.boxA.isEmpty(), { timeout: 60000 });
  await p.evaluate(async () => {
    const v = window.__viewer;
    document.querySelector('#gl').style.opacity = 1;
    v.renderer.setAnimationLoop(null);
    const r = await (await fetch('data/robot.json')).json();
    window.__parts = r.parts;
    const ids = r.parts.filter((x) => x.mesh_opt);
    await Promise.all(ids.map((x) => v.setOptMesh(x.id, x.mesh_opt)));
    const col = (x) => { const l = x.designs?.[0]?.label ?? ''; return /honeycomb/i.test(l) ? '#ffb800' : /topolog/i.test(l) ? '#ff3d6e' : /hollow/i.test(l) ? '#2e8bff' : null; };
    window.__palette = Object.fromEntries(ids.filter(col).map((x) => [x.id, col(x)]));
    window.__t = 0;
    window.__shot = (dt = 1 / 30, draw = true) => {
      window.__t += dt;
      v.step(dt, window.__t);
      if (window.__fix) window.__fix();
      v.controls.update();
      if (window.__fix2) window.__fix2();
      v.renderer.render(v.scene, v.camera);
      return draw ? v.renderer.domElement.toDataURL('image/jpeg', 0.93) : null;
    };
  });
  return p;
}

async function record(name, seconds, setup, perFrame) {
  const p = await page();
  await p.evaluate(setup);
  const n = Math.round(seconds * FPS);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-r', String(FPS), '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', '-an', `${OUT}${name}.mp4`], { stdio: ['pipe', 'inherit', 'inherit'] });
  for (let i = 0; i < n; i++) {
    const url = await p.evaluate(perFrame, i / (n - 1));
    const jpg = Buffer.from(url.split(',')[1], 'base64');
    if (i === Math.floor(n * 0.6)) fs.writeFileSync(`${OUT}${name}.jpg`, jpg);
    if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  await p.context().close();
  console.log(name, (fs.statSync(`${OUT}${name}.mp4`).size / 1e6).toFixed(2), 'MB');
}

const ease = 'const e=(a,b,x)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t)};';

await record('explode', 6, () => {
  const v = window.__viewer;
  v.setColorMode('mass');
  v.setShot({ fit: 'exploded', az: 0.1, el: 0.1, pad: 0.6, shiftX: 0, shiftY: 0 });
  for (let i = 0; i < 90; i++) window.__shot(1 / 30, false);
}, new Function('x', `${ease}const v=window.__viewer;v.setExplode(e(.1,.75,x));v.shot.az=.1+x*.6;return window.__shot()`));

await record('honeycomb', 7, () => {
  const v = window.__viewer;
  const foot = window.__parts.find((p) => /honeycomb/i.test(p.designs?.[0]?.label ?? ''));
  v.setExplode(1);
  v.setShot({ fit: 'exploded', az: 0.3, el: 0.1, pad: 0.6, shiftX: 0, shiftY: 0 });
  v.setView(true, true);
  v.setSelected(foot.id);
  for (let i = 0; i < 120; i++) window.__shot(1 / 30, false);
  const c = v.goalTarget.clone();
  const s = v.slots.get(foot.id);
  window.__c = c; window.__slot = s; window.__r = s.radius;
}, new Function('x', `const v=window.__viewer,c=window.__c,s=window.__slot,r=window.__r;
  v.userCam=true;
  if(!window.__plane){window.__plane=true;v.setCut(s.part.id);const P=s.optMat.clippingPlanes[0];P.normal.set(0,-1,0);P.constant=c.y-r*.12;for(const o of v.slots.values())if(o!==s)o.holder.visible=false;v.scene.environmentIntensity=.3;v.renderer.toneMappingExposure=.55;s.optMat.metalness=0;s.optMat.roughness=.85;s.optMat.needsUpdate=true;}
  const a=-.35+x*.7,el=1.32-.12*x;const d=r*(1.45-x*.3)/Math.tan(13*Math.PI/180);
  window.__fix=()=>{v.controls.target.copy(c);};
  window.__fix2=()=>{v.camera.position.set(c.x+d*Math.cos(el)*Math.cos(a),c.y+d*Math.sin(el),c.z+d*Math.cos(el)*Math.sin(a));v.camera.lookAt(c);v.camera.clearViewOffset();v.camera.updateProjectionMatrix();};
  return window.__shot()`));

await record('reassembly', 6, () => {
  const v = window.__viewer;
  v.setPalette(window.__palette);
  v.setView(true, false);
  v.setExplode(1);
  v.setShot({ fit: 'exploded', az: 0.3, el: 0.1, pad: 0.6, shiftX: 0, shiftY: 0 });
  for (let i = 0; i < 120; i++) window.__shot(1 / 30, false);
}, new Function('x', `${ease}const v=window.__viewer;v.setExplode(1-e(.1,.8,x));v.shot.az=.3+x*.5;if(x>.5&&v.shot.fit!=='assembled'){v.shot={...v.shot,fit:'assembled',pad:.55}}return window.__shot()`));

await browser.close();
