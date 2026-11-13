// Local gallery for the recorded clips. No dependencies, no build step.
//
//   node server.mjs [--port 8099] [--dir /path/to/clips]
//
// Serves:
//   /                 the player page
//   /api/clips        JSON index grouped by day
//   /media/<file>     the MP4 with HTTP range support (needed to seek)
//
// Range requests matter: without them the browser cannot seek and shows a spinner.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(process.env.PORT || arg('port', 8099));
const DIR = path.resolve(process.env.CLIPS_DIR || arg('dir', './recordings/NEW_EAGLE'));

const log = (m) => console.log(`[${new Date().toISOString().slice(0, 19)}] ${m}`);

// ---------------------------------------------------------------- clip index

// Duration needs the file read; cache by (name,size,mtime) so a page refresh does not
// ffprobe 500 files.
const durCache = new Map();

async function durationOf(file, stat) {
  const key = file;
  const hit = durCache.get(key);
  if (hit && hit.size === stat.size && hit.mtime === stat.mtimeMs) return hit.d;

  let d = null;
  try {
    const { stdout } = await exec('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', file,
    ]);
    const v = parseFloat(stdout.trim());
    if (Number.isFinite(v)) d = v;
  } catch {}
  durCache.set(key, { size: stat.size, mtime: stat.mtimeMs, d });
  return d;
}

async function buildIndex() {
  let names = [];
  try {
    // .mkv as well: remuxed clips keep the Matroska container (VP8 is not legal in MP4), and
    // omitting it hid every HD recording from the gallery while the old MP4s still showed.
    names = fs.readdirSync(DIR).filter((n) => /\.(mp4|webm|mkv|mov)$/i.test(n));
  } catch (e) {
    return { dir: DIR, error: 'no puedo leer ' + DIR, days: [] };
  }

  const days = new Map();
  for (const name of names) {
    const full = path.join(DIR, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }

    // YYYYMMDD_HHMMSS_NNN[_M<score>].ext
    const m = name.match(/^(\d{8})_(\d{6})/);
    const date = m ? m[1] : 'sin-fecha';
    const time = m ? `${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4, 6)}` : name;
    // motion score, written by the recorder as _M<percent>; absent on older clips
    const mv = name.match(/_M(\d{1,3})\.[a-z0-9]+$/i);

    if (!days.has(date)) days.set(date, []);
    days.get(date).push({
      file: name,
      time,
      size: st.size,
      motion: mv ? Number(mv[1]) : null,
      mtime: st.mtimeMs,
      duration: await durationOf(full, st),
    });
  }

  const out = [...days.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, clips]) => ({
      date,
      pretty: date.length === 8
        ? `${date.slice(6, 8)}/${date.slice(4, 6)}/${date.slice(0, 4)}`
        : date,
      size: clips.reduce((s, c) => s + c.size, 0),
      clips: clips.sort((a, b) => b.time.localeCompare(a.time)),
    }));

  return { dir: DIR, days: out };
}

// ---------------------------------------------------------------- media with ranges

function serveMedia(req, res, file) {
  const full = path.join(DIR, file);
  // never escape the clips directory
  if (!full.startsWith(DIR + path.sep)) { res.writeHead(403).end('forbidden'); return; }

  let st;
  try { st = fs.statSync(full); } catch { res.writeHead(404).end('not found'); return; }

  // Correct container per extension: a wrong MIME makes the browser refuse to play the file
  // even when it supports the codec inside.
  const ext = file.toLowerCase().split('.').pop();
  const type = ext === 'webm' ? 'video/webm'
             : ext === 'mkv' ? 'video/x-matroska'
             : ext === 'mov' ? 'video/quicktime'
             : 'video/mp4';
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(full).pipe(res);
    return;
  }

  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
  if (Number.isNaN(start) || start < 0) start = 0;
  if (Number.isNaN(end) || end >= st.size) end = st.size - 1;
  if (start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
    return;
  }

  res.writeHead(206, {
    'Content-Type': type,
    'Content-Range': `bytes ${start}-${end}/${st.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
  });
  fs.createReadStream(full, { start, end }).pipe(res);
}

// ---------------------------------------------------------------- page

const PAGE = `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cámaras · grabaciones locales</title>
<style>
  :root{
    --bg:#0d1117; --panel:#161b22; --line:#30363d; --fg:#e6edf3; --dim:#8b949e; --accent:#58a6ff;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  header{position:sticky;top:0;z-index:5;background:rgba(13,17,23,.92);
         backdrop-filter:blur(8px);border-bottom:1px solid var(--line);
         padding:10px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  h1{font-size:15px;margin:0;font-weight:600}
  .meta{color:var(--dim);font-size:12px}
  button{background:var(--panel);color:var(--fg);border:1px solid var(--line);
         border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px}
  button:hover{border-color:var(--accent);color:var(--accent)}
  button.on{border-color:var(--accent);color:var(--accent)}
  main{display:grid;grid-template-columns:1fr 340px;gap:16px;padding:16px;align-items:start}
  @media(max-width:900px){main{grid-template-columns:1fr}}
  .player{position:sticky;top:60px}
  video{width:100%;aspect-ratio:16/9;background:#000;border:1px solid var(--line);
        border-radius:8px;display:block;object-fit:contain}
  .now{display:flex;justify-content:space-between;gap:10px;margin-top:8px;
       color:var(--dim);font-size:12px}
  .list{max-height:calc(100vh - 90px);overflow:auto;border:1px solid var(--line);border-radius:8px}
  .list::-webkit-scrollbar{width:9px}
  .list::-webkit-scrollbar-thumb{background:var(--line);border-radius:9px}
  .day{position:sticky;top:0;background:var(--panel);padding:8px 12px;
       border-bottom:1px solid var(--line);display:flex;justify-content:space-between;
       font-size:12px;color:var(--dim);cursor:pointer}
  .day b{color:var(--fg)}
  .clip{display:flex;align-items:center;gap:10px;padding:7px 12px;
        border-bottom:1px solid #21262d;cursor:pointer;font-variant-numeric:tabular-nums}
  .clip:hover{background:#1c2128}
  .clip.active{background:#1f2d3d;border-left:3px solid var(--accent);padding-left:9px}
  .clip .t{font-family:ui-monospace,monospace}
  .mv{font-size:10px;font-family:ui-monospace,monospace;padding:1px 5px;border-radius:3px;
      border:1px solid var(--line);color:var(--dim)}
  .mv.lo{border-color:#238636;color:#3fb950}
  .mv.mv{border-color:#9e6a03;color:#d29922}
  .mv.hv{border-color:#a5372e;color:#f85149;font-weight:600}
  .clip .s{color:var(--dim);font-size:11px;margin-left:auto}
  .warn{background:#3d2b00;border:1px solid #9e6a03;color:#f0c674;
        padding:8px 12px;border-radius:6px;margin:0 16px 0;font-size:12px}
</style></head>
<body>
<header>
  <h1>Grabaciones locales</h1>
  <span class="meta" id="about">cargando…</span>
  <span style="flex:1"></span>
  <button id="auto">▶ seguir el más reciente</button>
  <button id="onlyMv">⚡ solo con movimiento</button>
  <button id="muteBtn">🔇 sonido</button>
  <button id="refresh">↻ recargar</button>
</header>
<div id="warn"></div>
<main>
  <section class="player">
    <video id="v" controls preload="metadata" muted></video>
    <div class="now"><span id="now">—</span><span id="dims"></span></div>
  </section>
  <aside class="list" id="list"></aside>
</main>
<script>
let clips = [], idx = -1, auto = false, timer = null;

const v = document.getElementById('v');
const listEl = document.getElementById('list');
const nowEl = document.getElementById('now');
const dimsEl = document.getElementById('dims');
const aboutEl = document.getElementById('about');

const fmtSize = b => b > 1e9 ? (b/1e9).toFixed(2)+' GB'
              : b > 1e6 ? (b/1e6).toFixed(1)+' MB'
              : Math.round(b/1e3)+' KB';
const fmtDur = s => s == null ? '' : Math.floor(s/60)+':'+String(Math.round(s%60)).padStart(2,'0');

async function load(keepPosition) {
  const r = await fetch('/api/clips');
  const data = await r.json();
  if (data.error) {
    document.getElementById('warn').innerHTML = '<p class="warn">⚠ ' + data.error + '</p>';
    return;
  }
  clips = [];
  for (const d of data.days) for (const c of d.clips) clips.push({ ...c, date: d.date, pretty: d.pretty });

  const total = clips.reduce((s,c)=>s+c.size,0);
  aboutEl.textContent = clips.length + ' clips · ' + fmtSize(total) + ' · ' + data.days.length + ' día(s)';

  render();
  if (keepPosition && idx >= 0 && clips[idx]) play(idx, false);
}

function render() {
  const byDay = new Map();
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (!byDay.has(c.date)) byDay.set(c.date, { pretty: c.pretty, items: [] });
    byDay.get(c.date).items.push({ ...c, i });
  }
  let html = '';
  for (const [date, d] of byDay) {
    html += '<div class="day"><span><b>' + d.pretty + '</b></span><span>' + d.items.length + ' clips</span></div>';
    for (const c of d.items) {
      // motion badge: green = quiet, amber = something moved, red = busy
      const mv = c.motion;
      const mvCls = mv === null ? '' : mv >= 10 ? 'mv hv' : mv >= 3 ? 'mv mv' : 'mv lo';
      const mvTxt = mv === null ? '' : '<span class="' + mvCls + '">M' + mv + '</span>';
      html += '<div class="clip" data-i="' + c.i + '" data-mv="' + (mv === null ? -1 : mv) + '">'
            + '<span class="t">' + c.time + '</span>' + mvTxt
            + '<span class="s">' + fmtDur(c.duration) + ' · ' + fmtSize(c.size) + '</span></div>';
    }
  }
  listEl.innerHTML = html || '<p class="warn">todavía no hay clips</p>';
  listEl.querySelectorAll('.clip').forEach(el => {
    el.onclick = () => play(Number(el.dataset.i));
  });
  // render() rebuilds the DOM from scratch, which wipes any inline display set by the motion
  // filter. Reapply it or the list silently reverts to "all clips" while the button still
  // looks pressed — which happens on every autoplay advance and every refresh.
  applyMotionFilter();
  markActive();
}

// Hide the quiet clips. Useful on a 1000-clip day where 99% is an empty garden: the score is
// in the filename, so this only toggles visibility and never rewrites anything on disk.
let onlyMotion = false;
function applyMotionFilter() {
  listEl.querySelectorAll('.clip').forEach(el => {
    const mv = Number(el.dataset.mv);
    el.style.display = onlyMotion && !(mv >= 3) ? 'none' : '';
  });
  // a day header with nothing visible below it is pointless
  listEl.querySelectorAll('.day').forEach(d => {
    let n = 0, sib = d.nextElementSibling;
    while (sib && !sib.classList.contains('day')) {
      if (sib.classList.contains('clip') && sib.style.display !== 'none') n++;
      sib = sib.nextElementSibling;
    }
    d.style.display = onlyMotion && n === 0 ? 'none' : '';
  });
}

function markActive() {
  listEl.querySelectorAll('.clip').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.i) === idx);
  });
}

function play(i, scroll = true) {
  if (!clips[i]) return;
  idx = i;
  const c = clips[i];
  // Re-assert mute on every load: the muted *attribute* only seeds the initial state, and a
  // new src can start playing with audio before any user gesture exists.
  if (userWantsAudio !== true) { v.muted = true; v.volume = 0; }
  v.src = '/media/' + encodeURIComponent(c.file);
  v.play().catch(()=>{});
  nowEl.textContent = c.pretty + ' ' + c.time;
  markActive();
  if (scroll) {
    const el = listEl.querySelector('.clip[data-i="' + i + '"]');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
}

// next clip when one ends, so playback chains like a timeline
// Advance to the next *visible* clip. With the motion filter on, the next index in the array
// may be hidden, and playing it would leave the list showing one thing while the player shows
// another. Skip over hidden ones so chaining follows what the user actually sees.
function nextVisible(from) {
  for (let i = from + 1; i < clips.length; i++) {
    const el = listEl.querySelector('.clip[data-i="' + i + '"]');
    if (!onlyMotion || (el && el.style.display !== 'none')) return i;
  }
  return -1;
}
v.onended = () => { const n = nextVisible(idx); if (n >= 0) play(n); };
v.onloadedmetadata = () => {
  dimsEl.textContent = v.videoWidth ? v.videoWidth + '×' + v.videoHeight : '';
};

document.getElementById('auto').onclick = (e) => {
  auto = !auto;
  e.target.classList.toggle('on', auto);
  if (auto) {
    if (clips.length) play(0);
    timer = setInterval(async () => {
      await load(true);
      // if we were sitting on the newest clip, hop to the new one
      if (idx === 0 && clips[0] && v.ended) play(0);
    }, 60000);
  } else if (timer) { clearInterval(timer); timer = null; }
};

document.getElementById('refresh').onclick = () => load(true);

const onlyBtn = document.getElementById('onlyMv');
onlyBtn.onclick = () => {
  onlyMotion = !onlyMotion;
  onlyBtn.classList.toggle('on', onlyMotion);
  applyMotionFilter();
};

// Clips carry the camera's audio track. It is muted by default because camera mics are
// loud and mostly record wind; enable it deliberately when you need to hear something.
let userWantsAudio = false;
const muteBtn = document.getElementById('muteBtn');
const syncMute = () => {
  muteBtn.textContent = v.muted ? '🔇 sonido' : '🔊 sonido';
  muteBtn.classList.toggle('on', !v.muted);
};
muteBtn.onclick = () => {
  userWantsAudio = !userWantsAudio;
  v.muted = !userWantsAudio;
  v.volume = userWantsAudio ? 1 : 0;
  syncMute();
};
v.muted = true;
v.volume = 0;
syncMute();

// keyboard: space, arrows, f for fullscreen
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
  if (e.code === 'ArrowRight') { const n = nextVisible(idx); if (n >= 0) play(n); }
  if (e.code === 'ArrowLeft') {
    for (let i = idx - 1; i >= 0; i--) {
      const el = listEl.querySelector('.clip[data-i="' + i + '"]');
      if (!onlyMotion || (el && el.style.display !== 'none')) { play(i); break; }
    }
  }
  if (e.key === 'f') v.requestFullscreen?.();
});

load();
</script>
</body></html>`;

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PAGE);
      return;
    }

    if (p === '/api/clips') {
      const idx = await buildIndex();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(idx));
      return;
    }

    if (p.startsWith('/media/')) {
      serveMedia(req, res, decodeURIComponent(p.slice('/media/'.length)));
      return;
    }

    res.writeHead(404).end('not found');
  } catch (e) {
    res.writeHead(500).end('error: ' + e.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`galería en http://127.0.0.1:${PORT}`);
  log(`leyendo ${DIR}`);
});
