// Print the login QR so you can scan it with the SmartLife / iSmartLife app.
//
// Two things make this usable without opening a file:
//  - the QR is an <img> with a data: URL, so we read it from the DOM at native resolution;
//  - it is also drawn in the terminal, so you can scan it straight off the console.
//
//   node qr.mjs            # save qr.png and draw it in the terminal
//   node qr.mjs --wait     # ...and block until the scan actually lands
//   node qr.mjs --no-term  # only write the file
//
// Login polling semantics (verified against the backend):
//   {"result": true}                    -> QR still waiting to be scanned
//   {"result": {uid, clientId, ...}}    -> scanned, session ready
//   {"errorCode": "SYSTEM_ERROR"}       -> token invalid or expired
import { attach, sleep } from './cdp.mjs';
import fs from 'node:fs';

const BASE_URL = process.env.BASE_URL || 'https://protect-us.ismartlife.me';
const OUT = process.env.OUT || './qr.png';
const WAIT = process.argv.includes('--wait');
const NO_TERM = process.argv.includes('--no-term');

const base = BASE_URL.replace(/\/$/, '');
const c = await attach(Number(process.env.PORT || 9222));
await c.setViewport(1400, 1500);

// Already logged in? Nothing to scan.
await c.goto(base + '/playback');
await sleep(5000);
if (!String(await c.eval('location.pathname')).includes('/login')) {
  console.log('already logged in, session is valid');
  process.exit(0);
}

// The token is never rendered as text, so capture it from the response that produced the
// QR. Installing the shim before navigation catches it on load.
await c.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    (() => {
      const orig = window.fetch;
      window.fetch = async function (...args) {
        const res = await orig.apply(this, args);
        try {
          const u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
          if (u.indexOf('QCtoken') >= 0) {
            res.clone().json().then(j => { if (j && j.result) window.__qrToken = j.result; }).catch(() => {});
          }
        } catch (e) {}
        return res;
      };
    })();
  `,
});

await c.goto(base + '/login');
await sleep(6000);

const grab = () => c.eval(`(() => {
  const l = document.querySelectorAll('img');
  for (let i = 0; i < l.length; i++) {
    const s = l[i].src || '';
    // The QR is a small PNG (a few hundred bytes -> ~1 KB of base64), so filtering on a
    // length threshold silently skips it. Match on the data URL plus a real size instead.
    if (s.indexOf('data:image/') === 0 && l[i].clientWidth > 60) return s;
  }
  return null;
})()`);

const data = await grab();
if (!data) {
  console.error('no QR image found in the DOM');
  process.exit(1);
}
fs.writeFileSync(OUT, Buffer.from(data.split(',')[1], 'base64'));
console.log('QR saved to ' + OUT);

// Draw it in the terminal by sampling the image, so no QR library is needed.
if (!NO_TERM) {
  const m = await c.eval(`(() => {
    const img = [...document.querySelectorAll('img')]
      .find(e => (e.src || '').indexOf('data:image/') === 0 && e.clientWidth > 60);
    if (!img) return null;
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const w = cv.width, h = cv.height;
    const px = ctx.getImageData(0, 0, w, h).data;
    const dark = (x, y) => px[(y * w + x) * 4] < 128;

    // The QR PNG is tightly cropped (no quiet zone), so there is nothing to measure from
    // the edge. Every run of same-colour pixels is a whole number of modules, which makes
    // the median run length the module size.
    const runs = [];
    for (let y = 0; y < h; y += 2) {
      let cur = dark(0, y), len = 0;
      for (let x = 0; x < w; x++) {
        const d = dark(x, y);
        if (d === cur) len++; else { runs.push(len); cur = d; len = 1; }
      }
    }
    runs.sort((a, b) => a - b);
    const module = runs[Math.floor(runs.length / 2)] || 1;
    const n = Math.round(w / module);

    const grid = [];
    for (let r = 0; r < n; r++) {
      let line = '';
      for (let col = 0; col < n; col++) {
        line += dark(Math.floor((col + 0.5) * module), Math.floor((r + 0.5) * module)) ? '1' : '0';
      }
      grid.push(line);
    }
    return { module, n, grid };
  })()`);

  if (m && m.grid) {
    const g = m.grid;
    console.log('');
    // two module rows per text line, using half blocks
    for (let r = 0; r < g.length; r += 2) {
      let line = '  ';
      for (let x = 0; x < g[r].length; x++) {
        const top = g[r][x] === '1';
        const bot = r + 1 < g.length && g[r + 1][x] === '1';
        line += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' ';
      }
      console.log(line);
    }
    console.log('');
    console.log('  ' + m.n + 'x' + m.n + ' modules — scan with the SmartLife app (~1-2 min)');
  }
}

if (!WAIT) process.exit(0);

const token = await c.eval('window.__qrToken || null');
console.log(token ? 'waiting for the scan...' : 'no token captured; watching the URL instead');

const deadline = Date.now() + 300000;
let refreshed = false;

while (Date.now() < deadline) {
  await sleep(3000);

  if (token) {
    const st = await c.eval(`(async () => {
      const r = await fetch('/api/login/poll', { method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ token: ${JSON.stringify(token)} }) });
      return await r.json();
    })()`, true);

    if (st && st.success && st.result && typeof st.result === 'object') {
      console.log('logged in as ' + st.result.uid);
      await c.goto(base + '/playback');
      await sleep(6000);
      console.log('session ready, browser at ' + (await c.eval('location.pathname')));
      process.exit(0);
    }
    if (st && st.errorCode === 'SYSTEM_ERROR') {
      console.error('token expired before it was scanned');
      process.exit(2);
    }
  } else {
    const where = String(await c.eval('location.pathname'));
    if (!where.includes('/login')) { console.log('logged in'); process.exit(0); }
  }

  // the code rotates every couple of minutes; refresh it once if the user is slow
  if (!refreshed && Date.now() > deadline - 210000) {
    await c.goto(base + '/login');
    await sleep(5000);
    const fresh = await grab();
    if (fresh) {
      fs.writeFileSync(OUT, Buffer.from(fresh.split(',')[1], 'base64'));
      console.log('QR expired, refreshed -> ' + OUT);
      refreshed = true;
    }
  }
}
console.error('timed out waiting for the scan');
process.exit(2);
