// One-shot snapshot: saves a single JPEG from the live stream. Useful for scheduled
// stills (timelapse) when you do not want a video file per interval.
import { attach, sleep } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';

const CAMERA = process.env.CAMERA || process.argv[2] || 'NEW_EAGLE';
const OUT = path.resolve(process.env.OUT || './snapshots');
const BASE_URL = process.env.BASE_URL || 'https://protect-us.ismartlife.me';

fs.mkdirSync(OUT, { recursive: true });
const c = await attach(Number(process.env.PORT || 9222));
await c.setViewport(1400, 1500);

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function click(x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(70);
  }
}

async function findByText(re) {
  return c.eval(`(() => {
    const r = new RegExp(${JSON.stringify(re)});
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length) continue;
      const t = (el.textContent || '').trim();
      if (!t || !r.test(t)) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 5 || b.height < 5) continue;
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    }
    return null;
  })()`);
}

await c.goto(BASE_URL.replace(/\/$/, '') + '/playback');
await sleep(6000);
let p = await findByText('^All Devices');
if (p) { await click(p.x, p.y); await sleep(2500); }
p = await findByText('^' + escRe(CAMERA) + '$');
if (p) await click(p.x, p.y);

let ready = null;
for (let i = 0; i < 20; i++) {
  await sleep(2000);
  ready = await c.eval(`(() => {
    const v = document.querySelector('video');
    return v && v.videoWidth ? { w: v.videoWidth, h: v.videoHeight } : null;
  })()`);
  if (ready) break;
}

if (!ready) {
  console.error('no live frames within 40s');
  process.exit(1);
}

const jpeg = await c.eval(`(() => {
  const v = document.querySelector('video');
  const cv = document.createElement('canvas');
  cv.width = v.videoWidth; cv.height = v.videoHeight;
  cv.getContext('2d').drawImage(v, 0, 0);
  return cv.toDataURL('image/jpeg', 0.92);
})()`);

const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const name = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.jpg`;
fs.writeFileSync(path.join(OUT, name), Buffer.from(jpeg.split(',')[1], 'base64'));
console.log(`saved ${name} (${ready.w}x${ready.h})`);
