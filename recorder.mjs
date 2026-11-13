// Continuous recorder for a Tuya/SmartLife web IPC player.
//
// It drives the vendor's own web player through the DevTools Protocol, so no proprietary
// signaling code is reimplemented: the browser negotiates WebRTC exactly as it would for
// a human, and we capture the resulting <video> with MediaRecorder.
//
// Usage:
//   node recorder.mjs --camera "NEW_EAGLE" --out ~/camaras/NEW_EAGLE --segment 60
//
// Env vars: BASE_URL, CAMERA, OUT, SEGMENT, PORT, VIEWPORT_W, VIEWPORT_H
import { attach, sleep } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE_URL = process.env.BASE_URL || arg('base-url', 'https://protect-us.ismartlife.me');
const CAMERA = process.env.CAMERA || arg('camera', 'NEW_EAGLE');
const OUT = path.resolve(process.env.OUT || arg('out', './recordings'));
const SEGMENT = Number(process.env.SEGMENT || arg('segment', 60));
const PORT = Number(process.env.PORT || arg('port', 9222));

// HD is the main stream (HEVC over a data channel), decoded by wasm into a WebGL canvas at
// whatever size the canvas buffer has. SD is the sub stream, delivered as plain RTP into a
// <video>. HD needs hardware WebGL: chromium must run with --use-gl=angle --use-angle=vulkan,
// with swiftshader the decoder produces no frames.
const QUALITY = (process.env.QUALITY || arg('quality', 'hd')).toLowerCase();
const HD_W = Number(process.env.HD_W || arg('hd-width', 1920));
const HD_H = Number(process.env.HD_H || arg('hd-height', 1080));

// A tall viewport keeps the player controls reachable; the tile size does not matter because
// the HD buffer is resized explicitly.
const VW = Number(process.env.VIEWPORT_W || (QUALITY === 'hd' ? 1920 : 1400));
const VH = Number(process.env.VIEWPORT_H || (QUALITY === 'hd' ? 1080 : 1500));

// How many consecutive canvas/video probes without new frames before declaring the stream dead.
const STALL_LIMIT = Number(process.env.STALL_LIMIT || 3);

// Switch the player to the single-camera view before opening the stream. In the grid the
// decoder surface stays small and HD comes out soft; 1:1 gives it the full container.
const VIEW_11 = !['0', 'off', 'false', 'no'].includes(
  String(process.env.VIEW_11 || arg('view-11', 'on')).toLowerCase());

// The camera tolerates very few session attempts in quick succession; a full reload plus a
// fresh negotiation needs breathing room or it answers "Failed to connect: 11/15".
const RETRY_COOLDOWN = Number(process.env.RETRY_COOLDOWN || 45);

// Motion score in the filename (M<percent of active frames>). On by default: it costs ~2s of
// CPU per 60s segment and makes the whole day triageable with `ls`, without opening a file.
const MOTION_TAG = !['0', 'off', 'false', 'no'].includes(
  String(process.env.MOTION_TAG || arg('motion-tag', 'on')).toLowerCase());
// A frame counts as "active" when its blurred difference exceeds this luma delta.
const MOTION_THRESHOLD = Number(process.env.MOTION_THRESHOLD || 1.0);

// Output container. The stream is already compressed once by the camera and again by
// MediaRecorder, so re-encoding is a third generation and visibly softens the frames.
//   remux     (default) copy the streams into MP4, no quality loss, fixes the duration
//   transcode re-encode to H.264 (smaller, softer, CPU heavy)
//   none      keep the raw .webm as written by the browser
const OUTPUT = (process.env.OUTPUT || arg('output', 'remux')).toLowerCase();
const REMUX = OUTPUT === 'remux';
const TRANSCODE = OUTPUT === 'transcode';

// Audio: the camera sends PCMU over the same session. Recorded by default; the page is
// always muted so nothing plays through the speakers while recording, and the gallery
// starts muted too. AUDIO=off drops the track entirely.
const AUDIO = !['0', 'off', 'false', 'no'].includes(
  String(process.env.AUDIO || arg('audio', 'on')).toLowerCase());

// Upscale the SD stream onto a canvas at a fixed size (e.g. 1280x720). This is resampling,
// NOT real detail: the sub stream carries 640x360, so a 720p frame is the same information
// stretched. It is useful only for a consistent output format across cameras. Leave at 0
// to record the stream untouched.
const UP_W = Number(process.env.UPSCALE_W || arg('upscale-w', 0));
const UP_H = Number(process.env.UPSCALE_H || arg('upscale-h', 0));
const UPSCALE = UP_W > 0 && UP_H > 0;

const PLAYBACK = BASE_URL.replace(/\/$/, '') + '/playback';
const log = (m) => console.log(`[${new Date().toISOString().slice(0, 19)}] ${m}`);

fs.mkdirSync(OUT, { recursive: true });

const c = await attach(PORT);
await c.setViewport(VW, VH);

// Cookies handed over by reauth.mjs. They are injected on every start because
// Network.setCookie only lives in memory: when the browser exits, the profile's cookie
// store never sees them. Keep the file until we prove the session works.
const PENDING = new URL('.pending-cookies.json', import.meta.url).pathname;

async function injectPending() {
  try {
    if (!fs.existsSync(PENDING)) return 0;
    const { host, cookies } = JSON.parse(fs.readFileSync(PENDING, 'utf8'));
    await c.send('Network.enable');
    for (const ck of cookies) {
      await c.send('Network.setCookie', {
        // url (not domain) keeps these host-only, matching how the server sets them.
        // A domain cookie with the same name would coexist and get sent alongside it.
        name: ck.name, value: ck.value, url: 'https://' + host + '/',
        secure: true, httpOnly: true, sameSite: 'Lax',
      }).catch(() => {});
    }
    log(`inyectadas ${cookies.length} cookies de reauth`);
    return cookies.length;
  } catch (e) {
    log('no pude inyectar cookies: ' + e.message.slice(0, 60));
    return 0;
  }
}

async function reauthNow() {
  const email = process.env.TUYA_EMAIL;
  if (!email) {
    log('sesión expirada y sin TUYA_EMAIL: no puedo re-autenticar');
    return false;
  }
  log('sesión expirada -> reautenticando con email/password');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    const { stdout } = await run('node', [
      new URL('./reauth.mjs', import.meta.url).pathname,
      '--email', email,
      '--country', process.env.TUYA_COUNTRY || '52',
      '--port', String(PORT),
    ], { timeout: 60000 });
    stdout.trim().split('\n').forEach((l) => log('  reauth: ' + l.replace(/^\[[^\]]+\] /, '')));
    return true;
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).trim();
    out.split('\n').filter(Boolean).forEach((l) => log('  reauth: ' + l.replace(/^\[[^\]]+\] /, '')));
    // exit 4 = login worked but the account has no devices (wrong Tuya identity).
    // Retrying is pointless and only burns requests, so back off hard.
    if (e.code === 4) {
      log('la cuenta de la contraseña no tiene cámaras; hace falta un QR nuevo (node qr.mjs)');
      log('esperando 10 min antes de reintentar');
      await sleep(600000);
      return false;
    }
    return false;
  }
}

const injected = await injectPending();

// ---------------------------------------------------------------- page helpers

const stateOf = () => c.eval(`(() => {
  const v = document.querySelector('video');
  // widest canvas wins: the HD decoder surface is the big one, small ones are UI leftovers
  const cv = [...document.querySelectorAll('canvas')]
    .filter(x => x.width > 200 && x.height > 100)
    .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0] || null;
  const q = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
  return {
    // SD surface
    vw: v ? v.videoWidth : 0,
    vh: v ? v.videoHeight : 0,
    frames: q ? q.totalVideoFrames : -1,
    tr: v && v.srcObject ? v.srcObject.getTracks().map(t => t.kind + ':' + t.readyState).join(',') : 'none',
    // HD surface: the wasm decoder paints into a WebGL canvas whose buffer size we control
    cw: cv ? cv.width : 0,
    ch: cv ? cv.height : 0,
    canvas: !!cv,
    // a canvas that has a running captureStream means the decoder is drawing into it
    canvasLive: !!(window.__canvasTrack && window.__canvasTrack.readyState === 'live'),
    hasVideo: !!v,
  };
})()`);

// A stream is usable when *either* surface is live with real dimensions.
const isLive = (s) => {
  if (!s) return false;
  const videoOk = s.vw > 100 && /video:live/.test(s.tr || '');
  const canvasOk = s.cw > 100 && s.ch > 100;
  if (QUALITY === 'hd') return canvasOk || videoOk;
  return videoOk;
};

// ...and even a live track with real dimensions can be carrying nothing. After the page is
// reloaded or the WebRTC session is torn down underneath it, the element keeps reporting
// videoWidth 640, tracks "live" and an advancing currentTime, yet decodes zero frames — the
// recorder then writes empty segments forever. totalVideoFrames is the only honest signal.
// WebGL canvases cannot be sampled with getImageData (the drawing buffer is not preserved),
// so for HD we count frames delivered by the captureStream instead.
let lastFrameCount = -1;
async function framesAdvancing(gapMs = 4000) {
  if (await c.eval('!!(window.__canvasTrack)')) {
    const a = await c.eval('window.__canvasFrames || 0');
    await sleep(gapMs);
    const b = await c.eval('window.__canvasFrames || 0');
    lastFrameCount = b;
    return b > a;
  }
  const a = await stateOf();
  if (!a || a.frames < 0) return true;      // browser without playback quality API
  await sleep(gapMs);
  const b = await stateOf();
  if (!b || b.frames < 0) return true;
  const gained = b.frames - a.frames;
  lastFrameCount = b.frames;
  return gained > 0;
}

async function click(x, y) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await sleep(120);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await c.send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', clickCount: 1, buttons: 1,
    });
    await sleep(80);
  }
}

// React ignores element.click(); we need real mouse events at the element's centre.
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

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Device names change when a camera is re-added to an account ("NEW_EAGLE" became
// "NEW EAGLE"). Compare with spaces, underscores and dashes treated as one separator and
// case ignored, so a cosmetic rename does not silently break discovery.
const camPattern = () => {
  const parts = CAMERA.split(/[\s_-]+/).filter(Boolean).map(escRe);
  return '^' + parts.join('[\\s_-]*') + '$';
};

// Waits for a text leaf to appear. The sidebar renders asynchronously after the SPA
// fetches /api/new/common/homeList, so a fixed sleep races with slow cookie refreshes.
async function waitForText(re, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = await findByText(re);
    if (p) return p;
    await sleep(1500);
  }
  return null;
}

// The player's control strip only appears on hover, and the quality toggle is its 5th item
// (volume, record, snapshot, mic, SD/HD, 1:1, ptz, fullscreen, close). Clicking it switches
// the camera from the RTP sub stream to the HEVC main stream, which the wasm decoder then
// paints into a WebGL canvas. No label is exposed, so the index is the reliable handle.
async function hoverToolbar() {
  // Hover the grid ITEM, not the <video>: the control strip is mounted by the item card, and
  // in 1x1 the video element is smaller than the card, so its centre can sit outside the
  // element that owns the listeners. Measured: hovering the item makes the strip appear with
  // 9 children, hovering the video centre does not.
  const vp = await c.eval(`(() => {
    const el = document.querySelector('[class*="common-grid-item"]')
            || document.querySelector('[class*="gridShow_item"]')
            || document.querySelector('video');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    if (b.width < 50) return null;
    return { x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) };
  })()`);
  if (!vp) return null;
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vp.x, y: vp.y, buttons: 0 });
  await sleep(400);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: vp.x + 10, y: vp.y + 6, buttons: 0 });
  await sleep(900);
  return vp;
}

async function toolbarButton(index) {
  return c.eval(`(() => {
    const b = document.querySelector('[class*="videoTool_box"]');
    if (!b || b.children.length <= ${index}) return null;
    const r = b.children[${index}].getBoundingClientRect();
    if (r.width < 5) return null;
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  })()`);
}

// The 1:1 button forces the player to render this camera on its own, at full container size.
// In the shared grid the decoder surface stays small, and a file recorded from it is a
// low-detail frame inside a big container: 1920x1080 of soft pixels. Switch to 1:1 BEFORE
// opening the camera so the surface is created at the right size from the start.
async function switchToSingleView() {
  if (!VIEW_11) return false;

  // The single-camera layout is NOT a toolbar button. It is a dropdown next to the
  // fullscreen control under the grid, listing the grid sizes (1, 4, 6, 9, 13, 16). The
  // trigger is the element immediately before the fullscreen box, so find it by structure
  // rather than by pixel: hardcoded coordinates break whenever the viewport height changes.
  const trigger = await c.eval(`(() => {
    const fs = document.querySelector('[class*="gridFulScreen"]');
    const prev = fs ? fs.previousElementSibling : null;
    if (!prev) return null;
    const r = prev.getBoundingClientRect();
    if (r.width < 5) return null;
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  })()`);
  if (!trigger) { log('no encontré el selector de grid'); return false; }

  const open = async () => (await c.eval(
    `document.querySelectorAll('[class*="gridSwitch_grid-item"]').length > 0`)) === true;

  // The popover is rendered on demand and takes a moment; a single click with a short wait
  // misses it on a freshly loaded page. Retry the trigger a few times with growing waits.
  if (!await open()) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await click(trigger.x, trigger.y);
      await sleep(1200 * attempt);
      if (await open()) break;
    }
  }
  if (!await open()) { log('el dropdown no abrió'); return false; }

  const opt = await c.eval(`(() => {
    const items = [...document.querySelectorAll('[class*="gridSwitch_grid-item"]')];
    const one = items.find(e => (e.innerText || '').trim() === '1');
    if (!one) return null;
    const r = one.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
             options: items.map(e => (e.innerText || '').trim()).join(',') };
  })()`);
  if (!opt) { log('el dropdown no ofrece la opción 1'); return false; }

  await click(opt.x, opt.y);
  await sleep(2500);

  const single = await c.eval(`(() => {
    const sqrt = document.querySelector('[class*="gridShow_sqrt"]');
    return sqrt ? sqrt.children.length === 1 : false;
  })()`);
  log(single ? `vista 1x1 activada (opciones: ${opt.options})` : 'la vista 1x1 no se aplicó');
  return single === true;
}

async function switchToHD() {
  // The control strip only mounts while the pointer is over the player, and in 1:1 the video
  // fills the container so its centre is a safe target. Retry the hover: the strip can take a
  // moment to appear right after the stream opens.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const vp = await hoverToolbar();
    if (!vp) { log('no encontré la superficie del video'); return false; }
    const btn = await toolbarButton(4);
    if (btn) {
      await click(btn.x, btn.y);
      log('conmutando a HD');
      return true;
    }
    log(`  barra de controles aún no visible (intento ${attempt})`);
    await sleep(1500);
  }
  log('no encontré el botón de calidad');
  return false;
}

// Tap the page's Web Audio graph so the camera audio can be recorded in HD mode.
//
// In HD the player has no <video> element: the main stream arrives as fMP4 over a data
// channel, is decoded by wasm, and its audio is played through an AudioContext rather than a
// MediaStream track. There is nothing to copy with getAudioTracks(), so we intercept the
// player's connection into the context destination:
//
//   source -> tap (MediaStreamAudioDestination)   <- what we record
//   source -> gain(0) -> destination              <- silence, keeps the graph rendering
//
// Muting at the sound server or with --mute-audio both silenced the recorded track as well,
// because Chromium stops producing samples for a muted output. An in-graph gain of zero keeps
// the render quantum running (the tap is an active sink) while emitting nothing audible.
const AUDIO_TAP = `(() => {
  const Orig = window.AudioContext || window.webkitAudioContext;
  if (!Orig || Orig.__tapped) return;

  const taps = new WeakMap();
  const mutes = new WeakMap();
  const origConnect = AudioNode.prototype.connect;

  AudioNode.prototype.connect = function (target, ...rest) {
    try {
      const name = target && target.constructor ? target.constructor.name : '';
      if (name === 'AudioDestinationNode') {
        const ctx = this.context;

        let tap = taps.get(ctx);
        if (!tap) { tap = ctx.createMediaStreamDestination(); taps.set(ctx, tap); }

        let mute = mutes.get(ctx);
        if (!mute) {
          mute = ctx.createGain();
          mute.gain.value = 0;
          mutes.set(ctx, mute);
          origConnect.call(mute, target);   // gain -> destination, once
        }

        origConnect.call(this, tap);        // capture path
        window.__audioStream = tap.stream;
        window.__audioCtx = ctx;
        return origConnect.call(this, mute); // audible path is silent
      }
    } catch (e) {}
    return origConnect.call(this, target, ...rest);
  };

  const Patched = function (...a) {
    const ctx = new Orig(...a);
    window.__audioCtx = ctx;
    return ctx;
  };
  Patched.prototype = Orig.prototype;
  Object.setPrototypeOf(Patched, Orig);
  Patched.__tapped = true;
  window.AudioContext = Patched;
  window.webkitAudioContext = Patched;
})()`;

async function openStream() {
  log('opening stream');
  // install the audio tap before the player builds its audio graph
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: AUDIO_TAP }).catch(() => {});
  await c.goto(PLAYBACK);
  await sleep(8000);

  // Expired session: the app bounces us to /login. Re-authenticate and try once more.
  const where = await c.eval('location.pathname');
  if (String(where).includes('/login')) {
    log('el navegador cayó en /login');
    if (await reauthNow()) {
      await injectPending();
      await c.goto(PLAYBACK);
      await sleep(4000);
      if (String(await c.eval('location.pathname')).includes('/login')) {
        log('sigue en /login tras reauth');
        return false;
      }
    } else {
      return false;
    }
  }

  // Expanding the device tree is a toggle, so clicking it blindly can collapse a list that was
// already open. It is also labelled in the account's language ("All Devices", "所有设备"...),
// so matching the text breaks the moment the UI language changes - which is exactly what
// happened after a re-login. Address it structurally instead: the tree's collapsed switcher
// is language-independent, and the camera name itself is never translated.
  const treeSwitcher = () => c.eval(`(() => {
    const closed = document.querySelector('[class*="ant-tree-switcher_close"]');
    if (!closed) return null;
    const r = closed.getBoundingClientRect();
    if (r.width < 5) return null;
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  })()`);

  const ensureExpanded = async () => {
    for (let i = 0; i < 4; i++) {
      if (await findByText(camPattern())) return true;
      const sw = await treeSwitcher();
      if (!sw) {
        // nothing collapsed: the tree is open but the camera really is missing
        await sleep(2000);
        if (await findByText(camPattern())) return true;
        return false;
      }
      await click(sw.x, sw.y);
      await sleep(2200);
      if (await findByText(camPattern())) return true;
    }
    return !!(await findByText(camPattern()));
  };

  if (!await ensureExpanded()) {
    const lang = await c.eval('(document.cookie.match(/gTyPlatLang=([^;]+)/)||[])[1] || "?"');
    log(`no apareció la cámara en la lista (idioma de la UI: ${lang})`);
    return false;
  }

  // Layout BEFORE opening the camera. Switching the grid size tears down whatever stream is
  // live, so doing it afterwards leaves an empty tile ("Select device to play from left
  // list"). With an empty grid the dropdown is harmless and the camera then opens straight
  // into the full-size single view.
  if (QUALITY === 'hd' && VIEW_11) {
    await switchToSingleView();
    await sleep(1500);
  }

  // Opening the camera is not deterministic: sometimes the player negotiates the camera's
  // sub stream over plain RTP, which on some firmware connects ICE and DTLS and then sends
  // no video at all (videoWidth 2). Re-selecting the device usually lands the main stream.
  // Detect that broken state fast instead of waiting out the full timeout.
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (attempt > 1) {
      // The camera only tolerates a few session attempts in quick succession; hammering it
      // yields the degraded sub-stream path every time. Space attempts out.
      const cool = 25 + (attempt - 2) * 15;
      log(`intento ${attempt}: esperando ${cool}s antes de reabrir`);
      await sleep(cool * 1000);
      if (attempt >= 3) { await c.goto(PLAYBACK); await sleep(8000); await ensureExpanded(); }
    }

    // Always re-read the position: expanding or collapsing the tree shifts every row.
    const pos = await findByText(camPattern());
    if (!pos) { log('la cámara desapareció de la lista'); break; }
    await click(pos.x, pos.y);

    let broken = false;
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      const s = await stateOf();
      if (isLive(s) || (s.vw > 100 && /video:live/.test(s.tr || ''))) {
        // dimensions alone lie: confirm frames are actually being decoded
        if (await framesAdvancing(3000)) {
          log(`live ${s.vw || s.cw}x${s.vh || s.ch}`);
          // SD is up. For HD, flip the quality toggle and wait for the canvas to take over.
          if (QUALITY === 'hd') {
            await switchToHD();
            for (let j = 0; j < 12; j++) {
              await sleep(2500);
              const h = await stateOf();
              // A canvas alone is not proof: the player already owns a 1280x720 composite in
              // SD mode. Wait for one clearly larger than the sub stream, which is the HD
              // decoder surface.
              if (h.canvas && h.cw >= Math.max(1800, s.vw * 2)) {
                log(`HD listo: canvas ${h.cw}x${h.ch}`);
                return true;
              }
              // Switching quality can rebuild the tile and drop back to the 4x4 grid, which
              // shrinks the decoder surface to a thumbnail. Re-assert 1x1 mid-wait.
              if (j === 3) {
                const single = await c.eval(
                  `(() => { const s = document.querySelector('[class*="gridShow_sqrt"]');
                     return s ? s.children.length === 1 : false; })()`);
                if (!single) { log('  el grid volvió a 4x4, repongo 1x1'); await switchToSingleView(); }
              }
            }
            log('HD no apareció; sigo con el stream SD actual');
          }
          return true;
        }
        log(`live ${s.vw}x${s.vh} pero sin frames nuevos -> sesión zombi, reabro`);
        broken = true;
        break;
      }
      // a track that exists but carries no frames, or one that already died
      // videoWidth 2 is the degraded negotiation: ICE and DTLS connect, audio may even flow,
      // but no video is ever offered. Retrying the same thing reproduces it. The main stream
      // takes a different path entirely, so when HD is configured go straight there.
      if (s.vw === 2) {
        if (QUALITY === 'hd') {
          log('negociación degradada (2x2) -> salto directo a HD');
          await hoverToolbar();
          await switchToHD();
          for (let j = 0; j < 12; j++) {
            await sleep(2500);
            const h = await stateOf();
            if (h.canvas && h.cw >= 600) { log(`HD listo: canvas ${h.cw}x${h.ch}`); return true; }
          }
          log('HD tampoco apareció desde el estado degradado');
        }
        broken = true;
        break;
      }
      if (/:ended/.test(s.tr || '')) { broken = true; break; }
    }
    if (!broken && attempt === 4) log('la negociación nunca entregó frames');
  }

  log('no pude abrir el stream tras 4 intentos');
  return false;
}

// The vendor player gives you roughly a minute to hit retry before it gives up for good.
// Re-selecting the device is the robust way back, so we try that before anything else.
// Releases the stream (not the session). The strip's last item is the close button. After
// closing, opening the device again rebuilds everything from SD.
async function closeStream() {
  try {
    await hoverToolbar();
    const btn = await toolbarButton(8);
    if (!btn) { log('no encontré el botón de cerrar'); return false; }
    await click(btn.x, btn.y);
    log('stream cerrado');
    await sleep(3000);
    return true;
  } catch (e) {
    return false;
  }
}

// Reopen the camera after a drop.
//
// Verified behaviour of the vendor player: the Close button releases only the *stream*, not
// the session, and opening the device again starts from SD as if it were the first time. So
// a retry is not just "click the device" - it is the whole sequence: close, reopen, wait for
// SD, switch to HD again, wait for the big canvas.
// Recovery sequence, verified against the vendor player:
//   1. the Close button releases only the stream, not the session;
//   2. reopening always comes back on SD - the sub stream, which sometimes fails outright;
//   3. changing the grid layout tears down whatever is live, so the layout has to be set on
//      an empty grid, before opening the camera.
// A full page reload is the most reliable reset, and it also restores the 4x4 layout, so the
// whole order has to be replayed: reload -> 1x1 -> camera -> HD. openStream() does exactly
// that, so the retry is a cooldown followed by openStream().
async function retry() {
  const cool = RETRY_COOLDOWN;
  log(`stream dropped -> recarga completa en ${cool}s (1x1 -> cámara -> HD)`);
  await sleep(cool * 1000);
  return openStream();
}

// ---------------------------------------------------------------- recording

async function startRec() {
  return c.eval(`(async () => {
    // A recorder left running by a previous run keeps emitting chunks into the next
    // recording and corrupts it (the EBML header is lost), so always drain it first.
    if (window.__rec && window.__rec.state !== 'inactive') {
      try {
        const old = new Promise(r => { window.__rec.onstop = r; });
        window.__rec.stop();
        await old;
      } catch (e) {}
    }
    // release a previous canvas track so two do not feed the same recorder
    if (window.__canvasTrack) { try { window.__canvasTrack.stop(); } catch (e) {} window.__canvasTrack = null; }

    const useHd = ${JSON.stringify(QUALITY)} === 'hd';
    const wantAudio = ${JSON.stringify(AUDIO)};
    let stream = null;
    let source = null;
    let size = null;

    // Never let the camera's audio play out loud; it is captured, not monitored. Mute every
    // media element, not just the video: in HD the player routes audio through an <audio>
    // element and a Web Audio graph, and either one can reach the speakers.
    const vid = document.querySelector('video');
    if (vid) { try { vid.muted = true; vid.volume = 0; } catch (e) {} }
    document.querySelectorAll('audio').forEach(a => {
      try { a.muted = true; a.volume = 0; } catch (e) {}
    });

    if (useHd) {
      // Scope the lookup to the camera's own tile. A global "biggest canvas" query can grab
      // the wrong surface: the multigrid keeps a canvas per tile plus small status canvases
      // for the cloud/SD badges, and after switching to 1:1 the player may leave the old tile
      // canvas in place. Recording that one yields a big file with soft pixels - HD in name
      // only. Walk up from the video element to its tile card and search inside it.
      const findTileCanvas = () => {
        const v = document.querySelector('video');
        if (!v) return null;
        // the tile card is the nearest ancestor that also holds the device name
        let node = v;
        for (let i = 0; i < 8 && node; i++) {
          const named = node.querySelector ? node.querySelector('[class*="device-name"]') : null;
          if (named) {
            const inner = [...node.querySelectorAll('canvas')]
              .filter(x => x.width > 200 && x.height > 100)
              .sort((a, b) => (b.width * b.height) - (a.width * a.height));
            if (inner.length) return { cv: inner[0], scoped: true };
          }
          node = node.parentElement;
        }
        return null;
      };

      const scoped = findTileCanvas();
      const cv = scoped ? scoped.cv : [...document.querySelectorAll('canvas')]
        .filter(x => x.width > 200 && x.height > 100)
        .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
      if (cv) {
        // Where did the canvas come from? Scoping makes the 1:1 path deterministic; the global
        // fallback can still pick a neighbour's surface in a multi-camera grid, so it is worth
        // seeing in the log.
        const scope = scoped ? 'tile' : 'global';
        // The player's own canvas already has the right size, and the wasm decoder paints at
        // exactly that buffer size. Resizing it does NOT give the decoder a bigger surface -
        // measurements showed a resized canvas keeps producing the same softness as an SD
        // upscale. Leave it alone unless HD_W/HD_H is explicitly set.
        if (!window.__hdSized && ${HD_W} > 0 && ${HD_H} > 0) {
          cv.width = ${HD_W};
          cv.height = ${HD_H};
          window.__hdSized = true;
        }
        const up = ${JSON.stringify(UPSCALE)};
        if (up) {
          // Downscale the decoded HD frame onto a 2D canvas. Unlike upscaling SD, this keeps
          // the detail the main stream actually carries and only discards surplus pixels.
          let oc = window.__outCanvas;
          if (!oc) {
            oc = document.createElement('canvas');
            oc.width = ${UP_W};
            oc.height = ${UP_H};
            oc.style.cssText = 'position:fixed;left:-9999px';
            document.body.appendChild(oc);
            window.__outCanvas = oc;
          }
          const octx = oc.getContext('2d', { alpha: false, desynchronized: true });
          if (window.__outTimer) clearInterval(window.__outTimer);
          window.__outTimer = setInterval(() => {
            try { if (cv.width) octx.drawImage(cv, 0, 0, oc.width, oc.height); } catch (e) {}
          }, 66);
          stream = oc.captureStream(15);
          window.__canvasTrack = stream.getVideoTracks()[0] || null;
          size = ${UP_W} + 'x' + ${UP_H} + ' (' + scope + ' HD ' + cv.width + 'x' + cv.height + ')';
          source = 'hd-downscale';
        } else {
          stream = cv.captureStream(15);
          window.__canvasTrack = stream.getVideoTracks()[0] || null;
          const st = window.__canvasTrack ? window.__canvasTrack.getSettings() : {};
          size = (st.width || cv.width) + 'x' + (st.height || cv.height) + ' (' + scope + ')';
          source = 'canvas';
        }
      }
    }

    // Audio source, in order of preference:
    //   1. the <video>'s own stream (SD mode, audio rides RTP)
    //   2. the Web Audio tap (HD mode, audio is decoded by wasm and only exists as a graph)
    let audioTrack = null;
    if (wantAudio) {
      if (vid && vid.srcObject) {
        audioTrack = vid.srcObject.getAudioTracks()[0] || null;
      }
      if (!audioTrack && window.__audioStream) {
        audioTrack = window.__audioStream.getAudioTracks()[0] || null;
      }
    }

    if (!stream) {
      if (!vid || !vid.videoWidth) return 'no surface (ni canvas HD ni video SD)';

      if (${JSON.stringify(UPSCALE)}) {
        // Resample the SD frames onto our own 2D canvas. This keeps the output format
        // consistent but adds no detail: the source is 640x360.
        let cv = window.__upCanvas;
        if (!cv) {
          cv = document.createElement('canvas');
          cv.width = ${UP_W};
          cv.height = ${UP_H};
          cv.style.cssText = 'position:fixed;left:-9999px';
          document.body.appendChild(cv);
          window.__upCanvas = cv;
        }
        const ctx = cv.getContext('2d', { alpha: false, desynchronized: true });
        if (window.__upTimer) clearInterval(window.__upTimer);
        window.__upTimer = setInterval(() => {
          try {
            if (vid.videoWidth) ctx.drawImage(vid, 0, 0, cv.width, cv.height);
          } catch (e) {}
        }, 66);                              // ~15 fps
        stream = cv.captureStream(15);
        window.__canvasTrack = stream.getVideoTracks()[0] || null;
        size = ${UP_W} + 'x' + ${UP_H} + ' (desde ' + vid.videoWidth + 'x' + vid.videoHeight + ')';
        source = 'upscale';
      } else {
        stream = vid.srcObject || vid.captureStream();
        if (!stream) return 'no MediaStream';
        size = vid.videoWidth + 'x' + vid.videoHeight;
        source = 'video';
      }
    } else if (audioTrack) {
      // HD: rebuild the stream so it carries the canvas video plus the camera audio.
      stream = new MediaStream([...stream.getVideoTracks(), audioTrack]);
    }

    // The upscale path needs the audio track appended too.
    if (source === 'upscale' && audioTrack) {
      stream = new MediaStream([...stream.getVideoTracks(), audioTrack]);
    }

    const mime = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus',
                  'video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm']
      .find(t => MediaRecorder.isTypeSupported(t)) || '';
    const bitrate = useHd && source === 'canvas' ? 3_500_000 : 2_000_000;
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: bitrate } : undefined);
    rec.__chunks = [];                                  // per-recorder buffer
    rec.__bytes = 0;
    rec.ondataavailable = e => {
      if (e.data && e.data.size) { rec.__chunks.push(e.data); rec.__bytes += e.data.size; }
    };
    rec.start(2000);
    window.__rec = rec;
    window.__recSource = source;
    window.__recSize = size;
    return { ok: true, source, size, mime, audio: !!audioTrack };
  })()`, true);
}

// Bytes captured so far. Growing bytes are the honest "frames are arriving" signal for a
// WebGL canvas: getImageData cannot see the drawing buffer, and MediaRecorder only emits
// data when frames are actually encoded.
const recBytes = () => c.eval('window.__rec ? window.__rec.__bytes : 0');

// Score how much actually moved during a segment, for the filename.
//
// Frame differencing: blur (codec noise on textured surfaces otherwise dominates - a diff map
// of the gate mesh showed only the weave, no silhouette), subtract the previous frame, average
// the luma of the difference. ~2s of CPU per 60s clip at 15fps, cheap enough to run inline.
//
// The score goes in the name as M<percent> so the day can be triaged without opening anything:
// M0-M2 is an empty garden, M10+ is worth a look. Absolute values depend on the scene (wind in
// the trees moves more pixels than a person), which is why the percentage of active frames is
// used rather than the raw mean.
async function motionScore(file) {
  if (!MOTION_TAG) return null;
  try {
    const { stdout } = await exec('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', file,
      '-vf', 'gblur=sigma=8,tblend=all_mode=difference,signalstats,metadata=mode=print:file=-',
      '-f', 'null', '/dev/null',
    ], { maxBuffer: 32 * 1024 * 1024, timeout: 60000 });

    const vals = [];
    let t = null;
    for (const line of stdout.split('\n')) {
      const pt = line.match(/pts_time:([0-9.]+)/);
      if (pt) { t = parseFloat(pt[1]); continue; }
      const y = line.match(/YAVG=([0-9.]+)/);
      if (y && t !== null && t > 1) vals.push(parseFloat(y[1]));   // skip the keyframe spike
    }
    if (!vals.length) return null;

    const busy = vals.filter((v) => v > MOTION_THRESHOLD).length;
    return { pct: Math.round((100 * busy) / vals.length), peak: Math.max(...vals) };
  } catch {
    return null;
  }
}

// Insert the score before the extension: 20261111_193522_009_M14.mkv
function tagMotion(final, score) {
  if (!score) return final;
  const ext = path.extname(final);
  const base = final.slice(0, -ext.length);
  const tagged = `${base}_M${String(score.pct).padStart(2, '0')}${ext}`;
  try { fs.renameSync(final, tagged); return tagged; } catch { return final; }
}

async function stopRec() {
  return c.eval(`(async () => {
    const rec = window.__rec;
    if (!rec) return null;
    if (rec.state !== 'inactive') {
      const done = new Promise(r => { rec.onstop = r; });
      rec.stop();
      await done;
    }
    const bytes = new Uint8Array(await new Blob(rec.__chunks || [], { type: 'video/webm' }).arrayBuffer());
    // Sanity check: a real webm starts with the EBML magic bytes.
    if (bytes.length < 4 || bytes[0] !== 0x1a || bytes[1] !== 0x45 ||
        bytes[2] !== 0xdf || bytes[3] !== 0xa3) return null;
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH)
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    window.__rec = null;
    return btoa(bin);
  })()`, true);
}

// Copy the streams into MP4 without re-encoding. VP8/VP9 video is not legal in an MP4 box,
// so the container has to match the codec: VP8/VP9 stay in Matroska, and only H.264 output
// lands in MP4. Either way the duration is written correctly by the muxer.
async function remux(webm) {
  const probe = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', webm]).catch(() => ({ stdout: '' }));
  const codec = (probe.stdout || '').trim();
  const ext = codec === 'h264' ? '.mp4' : '.mkv';
  const out = webm.replace(/\.webm$/, ext);
  try {
    await exec('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
      '-i', webm, '-c', 'copy', '-movflags', '+faststart', out]);
    fs.unlinkSync(webm);
    return out;
  } catch (e) {
    log('remux falló, dejo el webm: ' + e.message.slice(0, 90));
    return webm;
  }
}

// MediaRecorder writes a webm without duration in its header, so many players report
// "N/A". Re-encoding to H.264 fixes that and cuts the size ~3x at this bitrate.
async function toMp4(webm) {
  const mp4 = webm.replace(/\.webm$/, '.mp4');
  try {
    await exec('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', webm,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-movflags', '+faststart', mp4,
    ]);
    fs.unlinkSync(webm);
    return mp4;
  } catch (e) {
    log('ffmpeg failed, keeping webm: ' + e.message.slice(0, 100));
    return webm;
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------- main loop

// Always go through openStream() on start: in HD mode it is the function that sets the 1x1
// layout and switches the stream, and the relaxed liveness check would otherwise let the loop
// start recording a leftover SD tile straight away.
if (!await openStream()) log('could not start the stream; will keep trying');

let seg = 0;
for (;;) {
  const s = await stateOf();
  if (!isLive(s)) {
    if (!await retry()) {
      log('unrecoverable for now, waiting 20s');
      await sleep(20000);
    }
    continue;
  }

  const started = await startRec();
  if (!started || started.ok !== true) {
    log('could not start recording: ' + JSON.stringify(started));
    await sleep(3000);
    continue;
  }
  log(`grabando desde ${started.source} a ${started.size}${started.audio ? ' + audio' : ' (sin audio)'}`);

  // Stall detection differs per surface: the canvas cannot be sampled, so watch the bytes
  // the encoder is emitting; a <video> exposes totalVideoFrames.
  const useBytes = started.source === 'canvas' || started.source === 'upscale' || started.source === 'hd-downscale';
  let lastBytes = useBytes ? await recBytes() : 0;
  let stalls = 0;

  // A fresh MediaRecorder emits nothing until the encoder produces a keyframe, and a static
  // night scene gives it little reason to. Counting that warm-up produced false "dead stream"
  // verdicts 5-15s into every segment, so each save was followed by an unnecessary reload.
  // Give the encoder a grace window before trusting the byte counter, and require a longer
  // freeze before giving up.
  const GRACE_S = 20;
  const STALL_NEEDED = STALL_LIMIT + 2;

  let died = false;
  for (let elapsed = 0; elapsed < SEGMENT; elapsed += 5) {
    await sleep(5000);
    const st = await stateOf();
    if (!isLive(st)) { died = true; log('surface died mid-recording'); break; }

    if (useBytes) {
      const now = await recBytes();
      const grown = now > lastBytes;
      if (grown) { stalls = 0; lastBytes = now; continue; }

      // past the grace window, a frozen byte count means the encoder really stalled
      if (elapsed + 5 >= GRACE_S) {
        stalls++;
        log(`sin bytes nuevos (${stalls}/${STALL_NEEDED}) a los ${elapsed + 5}s`);
        if (stalls >= STALL_NEEDED) { died = true; log('el encoder dejó de recibir frames'); break; }
      }
    } else if (!await framesAdvancing(1500)) {
      died = true;
      log(`sin frames nuevos a los ${elapsed + 5}s, corto el segmento`);
      break;
    }
  }

  const b64 = await stopRec();
  if (b64 && b64.length > 5000) {
    const raw = path.join(OUT, `${stamp()}_${String(seg++).padStart(3, '0')}.webm`);
    fs.writeFileSync(raw, Buffer.from(b64, 'base64'));

    // Re-encoding to H.264 costs a third generation of compression: the camera already
    // compressed once, MediaRecorder again. The only reason for it is that a webm without a
    // duration in its header makes some players show "N/A" - a container problem, not a
    // picture problem. REMUX=1 fixes the duration by copying the streams untouched.
    let final = raw;
    if (REMUX) {
      final = await remux(raw);
    } else if (TRANSCODE) {
      final = await toMp4(raw);
    }

    // Score after the container is final: ffmpeg reads the mkv as happily as the webm.
    const score = await motionScore(final);
    final = tagMotion(final, score);

    const kb = (fs.statSync(final).size / 1024).toFixed(0);
    const mv = score ? ` mov=${score.pct}%` : '';
    log(`saved ${path.basename(final)} (${kb} KB${mv})${died ? ' [cut short]' : ''}`);
  } else {
    log('empty segment discarded');
  }

  if (died) await retry();
}
