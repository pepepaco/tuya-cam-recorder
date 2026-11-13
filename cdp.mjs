// Minimal Chrome DevTools Protocol client.
// No npm dependencies: Node >= 22 ships global fetch and WebSocket.
import fs from 'node:fs';

export async function attach(port = 9222) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (!page) throw new Error('no page target found on port ' + port);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('websocket error attaching to CDP'));
  });

  let id = 0;
  const pending = new Map();
  const listeners = new Map();

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method) {
      (listeners.get(msg.method) || []).forEach((fn) => fn(msg.params));
    }
  };

  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const myId = ++id;
      pending.set(myId, { res, rej });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });

  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  };

  const waitFor = (method, timeout = 30000) =>
    new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting for ' + method)), timeout);
      on(method, (p) => { clearTimeout(t); res(p); });
    });

  const client = { ws, send, on, waitFor, target: page };

  client.eval = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
    }
    return r.result.value;
  };

  client.goto = async (url) => {
    const loaded = waitFor('Page.loadEventFired', 45000).catch(() => null);
    await send('Page.navigate', { url });
    await loaded;
  };

  client.screenshot = async (path) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path, Buffer.from(data, 'base64'));
    return path;
  };

  // Same-viewport trick: the player's control strip is laid out inside the current
  // viewport, so a small window hides the controls and clicks land on the wrong element.
  client.setViewport = (width, height) =>
    send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    });

  await send('Page.enable');
  await send('Runtime.enable');
  return client;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
