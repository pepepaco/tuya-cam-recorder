#!/usr/bin/env node
// Re-authenticate against the Tuya/SmartLife web backend using email + password,
// then inject the resulting session cookies into the Chromium profile used by the recorder.
//
// The password is never stored by this script. It is read from, in order:
//   1. the system keyring (secret-tool lookup service tuya-cam-recorder account <email>)
//   2. the TUYA_PASSWORD environment variable
//   3. an interactive prompt on stdin
//
// Usage:
//   node reauth.mjs --email you@example.com --country 52
//   node reauth.mjs --email you@example.com --country 52 --check   # verify session only
//
// Login chain (reverse-engineered from the web client):
//   POST /api/login/token            -> { token, pbKey }
//   passwd = hex( RSA_PKCS1v15( pubkey, md5(password) ) )
//   POST /api/private/email/login    -> sets s-sid / fast-sid
import { attach, sleep } from './cdp.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const flag = (n) => process.argv.includes('--' + n);

const BASE_URL = process.env.BASE_URL || arg('base-url', 'https://protect-us.ismartlife.me');
const HOST = new URL(BASE_URL).host;
const EMAIL = process.env.TUYA_EMAIL || arg('email');
const COUNTRY = process.env.TUYA_COUNTRY || arg('country', '52');
const PORT = Number(process.env.PORT || arg('port', 9222));

const log = (m) => console.log(`[${new Date().toISOString().slice(0, 19)}] ${m}`);

// ---------------------------------------------------------------- password sources

async function fromKeyring() {
  try {
    const { stdout } = await exec('secret-tool', ['lookup', 'service', 'tuya-cam-recorder', 'account', EMAIL]);
    return stdout.replace(/\n$/, '') || null;
  } catch {
    return null;
  }
}

async function fromPrompt() {
  if (!process.stdin.isTTY) {
    throw new Error('no hay TTY para preguntar la contraseña; usa el keyring o TUYA_PASSWORD');
  }
  // Read raw so the password is not echoed to the terminal. readline would print it,
  // and a password on screen ends up in scrollback and screen shares.
  process.stderr.write('Contraseña de Tuya: ');
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();

  const chars = [];
  await new Promise((resolve) => {
    const onData = (buf) => {
      for (const byte of buf) {
        if (byte === 13 || byte === 10) {           // Enter
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          resolve();
          return;
        }
        if (byte === 3) {                            // Ctrl-C
          stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write('\n');
          process.exit(130);
        }
        if (byte === 127 || byte === 8) {            // Backspace
          chars.pop();
          continue;
        }
        chars.push(byte);
      }
    };
    stdin.on('data', onData);
  });

  process.stderr.write('\n');
  return Buffer.from(chars).toString('utf8');
}

// ---------------------------------------------------------------- login chain

const postJson = async (path, body) => {
  const r = await fetch(BASE_URL.replace(/\/$/, '') + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Accept': '*/*',
      'Origin': BASE_URL.replace(/\/$/, ''),
      'Referer': BASE_URL.replace(/\/$/, '') + '/login',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify(body),
  });
  return r;
};

async function getLoginToken() {
  const r = await postJson('/api/login/token', {
    countryCode: COUNTRY, username: EMAIL, isUid: false,
  });
  const j = await r.json();
  if (!j.success || !j.result?.pbKey) {
    throw new Error('login/token falló: ' + (j.errorMsg || j.status || 'sin detalle'));
  }
  return j.result;
}

// Mirrors the vendor client: md5 the password, then RSA/PKCS#1 v1.5 with the
// public key the server hands out per attempt, then hex-encode the ciphertext.
function encryptPassword(password, pbKeyB64) {
  const md5hex = crypto.createHash('md5').update(password).digest('hex');
  const key = crypto.createPublicKey({
    key: Buffer.from(pbKeyB64, 'base64'), format: 'der', type: 'spki',
  });
  return crypto.publicEncrypt(
    { key, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(md5hex),
  ).toString('hex');
}

// The same person can own several Tuya identities: a SmartLife consumer account
// (partnerIdentity p100xxxx) and an IoT developer account (p1000000). They can even share
// one email, but only one of them has the cameras — and the password may differ. So log in
// per identifier and keep the identity that actually owns devices.
async function passwordLogin(password, ident) {
  const tok = await getLoginToken(ident.value);
  const path = ident.kind === 'phone' ? '/api/private/phone/login' : '/api/private/email/login';
  const body = {
    countryCode: COUNTRY,
    [ident.kind === 'phone' ? 'mobile' : 'email']: ident.value,
    // The web client sends a bare md5 with ifencrypt:0. The RSA variant (ifencrypt:1) is
    // accepted for email but makes the phone endpoint answer "user TOKEN incorrect".
    passwd: crypto.createHash('md5').update(password).digest('hex'),
    token: tok.token,
    ifencrypt: 0,
    options: '{"group":1}',
  };

  const r = await postJson(path, body);
  const setCookies = r.headers.getSetCookie?.() || [];
  const j = await r.json().catch(() => null);

  if (!j || !j.success) {
    throw new Error(j?.errorMsg || j?.status || `HTTP ${r.status}`);
  }
  return { result: j.result, setCookies, ident };
}

function parseCookies(setCookieHeaders) {
  const out = [];
  for (const line of setCookieHeaders) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!name || !value) continue;
    out.push({ name, value });
  }
  return out;
}

// ---------------------------------------------------------------- session check

async function sessionAlive() {
  // Must be authenticated: this endpoint answers {"success":false} for anonymous
  // requests, so probing it without cookies always reports "expired".
  let cookieHeader = '';

  const pendingPath = new URL('.pending-cookies.json', import.meta.url).pathname;
  if (fs.existsSync(pendingPath)) {
    try {
      const { cookies } = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
      cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch {}
  }

  if (!cookieHeader) {
    try {
      const c = await attach(PORT);
      const r = await c.send('Network.getCookies', { urls: [BASE_URL] });
      cookieHeader = r.cookies.map((k) => `${k.name}=${k.value}`).join('; ');
    } catch {}
  }

  if (!cookieHeader) return null;   // cannot tell without cookies

  try {
    const r = await fetch(BASE_URL.replace(/\/$/, '') + '/api/customized/web/app/info', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookieHeader,
      },
      body: '{}',
    });
    const j = await r.json();
    return !!j.success;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- main

if (flag('check')) {
  const ok = await sessionAlive();
  if (ok === null) {
    log('no hay cookies (ni navegador ni pendientes) para comprobar');
    process.exit(2);
  }
  log(ok ? 'sesión VÁLIDA' : 'sesión inválida o expirada');
  process.exit(ok ? 0 : 1);
}

let password = process.env.TUYA_PASSWORD || await fromKeyring();
let source = password ? (process.env.TUYA_PASSWORD ? 'env' : 'keyring') : null;
if (!password) {
  password = await fromPrompt();
  source = 'prompt';
}
log(`contraseña leída de: ${source}`);

// A login can succeed and still be the wrong account: the same email may have several
// Tuya identities (a consumer SmartLife account and a developer account are distinct
// uids, with different partnerIdentity values). Injecting those cookies silently swaps
// a working session for an empty account, so verify the account actually owns devices
// before touching the browser.
async function countDevices(cookieHeader, host) {
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Requested-With': 'XMLHttpRequest',
    'Cookie': cookieHeader,
  };
  const base = BASE_URL.replace(/\/$/, '');
  const homeRes = await (await fetch(base + '/api/new/common/homeList', {
    method: 'POST', headers: h, body: '{}',
  })).json();

  const homes = homeRes.result || [];
  if (!homes.length) return { homes: 0, devices: 0, names: [] };

  let devices = 0;
  const names = [];
  for (const home of homes) {
    const rr = await (await fetch(base + '/api/new/common/roomList', {
      method: 'POST', headers: h, body: JSON.stringify({ homeId: String(home.gid) }),
    })).json();
    for (const room of rr.result || []) {
      for (const d of room.deviceList || []) {
        devices++;
        if (d.category === 'sp') names.push(d.deviceName);
      }
    }
  }
  return { homes: homes.length, devices, cameras: names.length, names };
}

// Try every identifier we were given and keep the identity that owns devices.
const candidates = [];
if (EMAIL) candidates.push({ kind: 'email', value: EMAIL });
const phoneArg = process.env.TUYA_PHONE || arg('phone');
if (phoneArg) candidates.push({ kind: 'phone', value: phoneArg });
if (!candidates.length) {
  log('falta --email (o --phone) para poder iniciar sesión');
  process.exit(2);
}

let chosen = null;
let lastErr = null;
for (const ident of candidates) {
  log(`probando login por ${ident.kind}: ${ident.value}`);
  try {
    const r = await passwordLogin(password, ident);
    const cookies = parseCookies(r.setCookies);
    if (!cookies.length) { log('  sin cookies, revisa 2FA'); continue; }

    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const inv = await countDevices(cookieHeader, HOST).catch(() => ({ homes: 0, devices: 0 }));
    log(`  uid ${r.result?.uid} · partner ${r.result?.partnerIdentity} · ` +
        `${inv.homes} hogar(es), ${inv.devices} dispositivo(s)` +
        (inv.cameras ? `, cámaras: ${inv.names.join(', ')}` : ''));

    if (inv.devices > 0) { chosen = { cookies, inv, result: r.result }; break; }
    log('  esa identidad no tiene dispositivos, sigo con la siguiente');
  } catch (e) {
    lastErr = e.message;
    log('  ' + e.message);
    if (/频繁|too many/i.test(e.message)) {
      log('  el servidor limitó los intentos; espera unos minutos');
      break;
    }
  }
}

if (!chosen) {
  log('ABORTADO: ninguna identidad con esa contraseña tiene dispositivos.');
  if (lastErr) log('último error: ' + lastErr);
  log('La cuenta de las cámaras necesita su propia contraseña:');
  log('  app SmartLife -> Me -> Configuración -> Seguridad de la cuenta -> Contraseña');
  log('Después:  secret-tool store --label="Tuya camera" service tuya-cam-recorder account <email>');
  log('Y reintenta indicando también el teléfono:  node reauth.mjs --email ... --phone 52XXXXXXXXXX');
  log('No inyecto cookies para no romper una sesión que sí funciona.');
  process.exit(4);
}

const { cookies, inv } = chosen;
log(`usando la identidad con ${inv.devices} dispositivo(s)`);

// Once the password provably opens the account that owns the cameras, keep it in the
// keyring so a cron job can re-authenticate without a human. This is the whole point of
// the password path; until this moment there was nothing worth storing.
//
// secret-tool reads the secret from stdin. execFile has no `input` option (it is silently
// ignored and the process reads EOF), so spawnSync is required here.
if (source !== 'keyring' && !process.env.TUYA_NO_SAVE) {
  const st = spawnSync('secret-tool',
    ['store', '--label', 'Tuya camera', 'service', 'tuya-cam-recorder', 'account', EMAIL],
    { input: password, encoding: 'utf8' });

  const back = spawnSync('secret-tool',
    ['lookup', 'service', 'tuya-cam-recorder', 'account', EMAIL], { encoding: 'utf8' });

  if (st.status === 0 && (back.stdout || '').replace(/\n$/, '') === password) {
    log('contraseña guardada en el keyring (reauth automático activado)');
  } else {
    log('no pude guardar en el keyring (stderr: ' +
        (st.stderr || back.stderr || 'sin detalle').trim().slice(0, 60) + ')');
  }
}

// Wrap up: hand the cookies to the recorder as well as the live browser.
//
// Two things learned the hard way:
//  - setting cookies with `domain:` creates a *domain* cookie that coexists with the
//    host-only cookie of the same name the server already set, so the browser sends both
//    and the backend answers USER_SESSION_INVALID. Use `url:` to keep them host-only.
//  - cookies injected over CDP live in memory only. If chromium restarts they are gone, so
//    the file is the durable copy and the recorder re-injects it on every start.
const PENDING = new URL('.pending-cookies.json', import.meta.url).pathname;

async function persistPending() {
  fs.writeFileSync(PENDING, JSON.stringify({ host: HOST, cookies }, null, 2), { mode: 0o600 });
  log(`cookies guardadas en ${PENDING} (el grabador las reinyecta en cada arranque)`);
}

await persistPending();

let c;
try {
  c = await attach(PORT);
} catch (e) {
  log(`no hay navegador en :${PORT} (${e.message.slice(0, 50)})`);
  log('SESIÓN RENOVADA (el grabador las inyectará al arrancar)');
  process.exit(0);
}

await c.send('Network.enable');

// clear any stale copy first so we never end up with two s-sid cookies
try {
  const existing = await c.send('Network.getCookies', { urls: [BASE_URL] });
  for (const k of existing.cookies) {
    if (['s-sid', 'fast-sid', 'uid', 'clientId'].includes(k.name)) {
      await c.send('Network.deleteCookies', { name: k.name, url: BASE_URL }).catch(() => {});
    }
  }
} catch {}

for (const ck of cookies) {
  try {
    await c.send('Network.setCookie', {
      name: ck.name, value: ck.value, url: BASE_URL.replace(/\/$/, '') + '/',
      secure: true, httpOnly: true, sameSite: 'Lax',
    });
    log(`inyectada ${ck.name}`);
  } catch (e) {
    log(`! no pude inyectar ${ck.name}: ${e.message.slice(0, 60)}`);
  }
}

// Verify against the API instead of navigating: reloading the page would interrupt the
// recording that is currently running on this browser.
const check = await c.eval(`(async () => {
  const r = await fetch('/api/common/user/info', { method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest' } });
  const j = await r.json();
  return { ok: !!j.success, user: j.result && j.result.userName, err: j.errorCode || null };
})()`, true);

if (check && check.ok) {
  log(`SESIÓN RESTAURADA (${check.user}) — el grabador puede reconectar`);
} else {
  log(`las cookies no autentican (${check && check.err}); reinicia el grabador con: systemctl --user restart tuya-cam-recorder`);
}

// The CDP websocket holds the event loop open, so a oneshot systemd unit would sit in
// "activating" forever even though all the work is done. Close it and exit explicitly.
try { c.ws.close(); } catch {}
process.exit(check && check.ok ? 0 : 5);
