// Session watchdog: tells you (desktop notification) when the camera session needs a new
// QR scan, so you find out from a notification instead of an empty recordings folder.
//
//   node watcher.mjs              # check once, notify if action is needed
//   node watcher.mjs --loop       # keep checking (used by the systemd timer/service)
//
// Exit codes: 0 = healthy, 3 = needs the QR (notification sent), 1 = unknown.
//
// Runs from a systemd user unit, so DISPLAY/DBUS come from systemctl --user show-environment.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const exec = promisify(execFile);

const BASE = process.env.BASE_URL || 'https://protect-us.ismartlife.me';
const PORT = Number(process.env.PORT || 9222);
const LOOP = process.argv.includes('--loop');
const STATE = path.join(path.dirname(new URL(import.meta.url).pathname), '.watch-state.json');
const DIR = process.env.CLIPS_DIR || './recordings/NEW_EAGLE';

const log = (m) => console.log(`[${new Date().toISOString().slice(0, 19)}] ${m}`);

function notify(title, body, urgency = 'normal') {
  // notify-send needs the session bus; if it is missing there is nothing useful to do.
  return exec('notify-send', ['-a', 'Cámara', '-u', urgency, '-i', 'camera-video', title, body])
    .then(() => true)
    .catch(async (e) => {
      log('notify-send falló: ' + e.message.slice(0, 80));
      return false;
    });
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); } catch {}
}

async function sessionStatus() {
  // Ask the running browser what cookies it has, then check one of them against an endpoint
  // that requires auth. Reading the cookie store is the only way to know the truth: a live
  // stream keeps working long after the session behind it is dead.
  const { attach } = await import('./cdp.mjs');
  let c;
  try {
    c = await attach(PORT);
  } catch {
    return { state: 'no-browser' };
  }

  const ck = await c.send('Network.getCookies', { urls: [BASE] });
  const names = ck.cookies.map((k) => k.name);
  const header = ck.cookies.map((k) => `${k.name}=${k.value}`).join('; ');
  if (!header) return { state: 'no-cookies' };

  const r = await fetch(BASE + '/api/common/user/info', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': header,
    },
  });
  const j = await r.json().catch(() => ({}));

  if (j.success) return { state: 'ok', user: j.result?.userName };
  return { state: 'expired', error: j.errorCode || j.errorMsg || 'unknown' };
}

function newestClipAgeMinutes() {
  try {
    const files = fs.readdirSync(DIR).filter((n) => n.endsWith('.mp4'));
    if (!files.length) return Infinity;
    let newest = 0;
    for (const f of files) {
      const st = fs.statSync(path.join(DIR, f));
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
    return (Date.now() - newest) / 60000;
  } catch {
    return Infinity;
  }
}

async function check() {
  const s = await sessionStatus();
  const age = newestClipAgeMinutes();
  const st = readState();
  const now = Date.now();

  log(`sesión=${s.state}${s.error ? ' (' + s.error + ')' : ''} · último clip hace ${age === Infinity ? '∞' : Math.round(age) + ' min'}`);

  // Nothing recorded for 15 minutes means the recorder is stuck even if cookies look fine.
  const stuck = age > 15;

  if (s.state === 'ok' && !stuck) {
    st.healthySince = st.healthySince || now;
    st.lastHealthy = now;
    st.lastNagged = 0;
    writeState(st);
    return 0;
  }

  // Rate limit: at most one notification every 6 hours unless it is the first failure.
  const sinceNagged = now - (st.lastNagged || 0);
  if (sinceNagged < 6 * 3600 * 1000 && st.lastNagged) {
    log('ya avisé hace poco; silencio por 6h');
    return 3;
  }

  let title, body;
  if (s.state === 'expired' || s.state === 'no-cookies') {
    title = 'La cámara necesita un QR nuevo';
    body = `La sesión caducó${stuck ? ' y no hay grabaciones nuevas' : ''}.\n` +
           `Corre:  cd ~/source/repos/tuya-cam-recorder && ./relogin.sh\n` +
           `Escanea con la app AZUL (Smart Life).`;
  } else if (s.state === 'no-browser') {
    title = 'El grabador no está corriendo';
    body = 'No hay navegador en el puerto ' + PORT + '.\n' +
           'Revisa:  systemctl --user status tuya-cam-recorder';
  } else {
    title = 'El grabador dejó de grabar';
    body = `Sin clips nuevos desde hace ${Math.round(age)} minutos, pero la sesión está viva.\n` +
           'Revisa:  journalctl --user -u tuya-cam-recorder -n 30';
  }

  log('NOTIFICANDO: ' + title);
  await notify(title, body, 'critical');
  st.lastNagged = now;
  st.lastFailure = { at: now, state: s.state, age };
  writeState(st);
  return 3;
}

if (LOOP) {
  const every = Number(process.env.CHECK_MINUTES || 60) * 60000;
  for (;;) {
    try { await check(); } catch (e) { log('error: ' + e.message); }
    await new Promise((r) => setTimeout(r, every));
  }
} else {
  process.exit(await check());
}
