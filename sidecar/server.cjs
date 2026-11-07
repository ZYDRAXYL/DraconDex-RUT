'use strict';
// DraconDex-RUT sidecar — runs DraconDex-EXE's REAL main process (electron/main.js,
// every IPC handler, the whole db layer) under plain Node, with the `electron`
// module replaced by a stub that forwards windows / dialogs / shell to the Tauri
// shell over stdio. Same idea as EXE's .claude/skills/run-dracondex/web-driver.mjs,
// made into a real app host.
//
//   node sidecar/server.cjs <path-to-DraconDex-EXE>
//
// stdout lines that start with "\x01DDX " are protocol (JSON) for the Rust side;
// every other stdout/stderr line is ordinary main-process logging.
// stdin carries JSON lines back from Rust.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const Module = require('module');
const readline = require('readline');

const EXE = path.resolve(process.argv[2] || process.env.DRACONDEX_EXE || path.join(__dirname, '..', '..', 'DraconDex-EXE'));
const MAIN = path.join(EXE, 'electron', 'main.js');
const INDEX = path.join(EXE, 'electron', 'index.html');
const APP_PRELOAD = path.join(EXE, 'electron', 'preload.js');
if (!fs.existsSync(MAIN)) { console.error(`[rut] no electron/main.js under ${EXE} — set DRACONDEX_EXE`); process.exit(2); }

const TOKEN = crypto.randomBytes(32).toString('hex');
const exePkg = JSON.parse(fs.readFileSync(path.join(EXE, 'package.json'), 'utf8'));

// ── stdio protocol ─────────────────────────────────────────────────────────
process.stdout.on('error', () => {}); // the shell went away first (killed); nothing left to tell
const emit = (msg) => process.stdout.write('\x01DDX ' + JSON.stringify(msg) + '\n');
let rpcSeq = 0;
const pending = new Map();
const call = (op, args) => new Promise((resolve, reject) => {
  const rpc = ++rpcSeq;
  pending.set(rpc, { resolve, reject });
  emit({ t: 'call', rpc, op, args });
});
const fire = (op, args) => call(op, args).catch((e) => console.error(`[rut] ${op}:`, e.message));

// ── electron stub ──────────────────────────────────────────────────────────
let workArea = { x: 0, y: 0, width: 1920, height: 1080 };
const display = () => ({ workArea, bounds: workArea, scaleFactor: 1 });
const app = new EventEmitter();
let readyResolve;
const readyP = new Promise((r) => { readyResolve = r; });
let quitting = false;
const paths = {};
const dataDir = process.env.DRACONDEX_DATA_DIR;
Object.assign(app, {
  isPackaged: false, // ponytail: dev-flavoured paths; DRACONDEX_DATA_DIR (set by Rust) decides where data lives
  getPath: (k) => paths[k] ?? ({
    exe: process.execPath, appData: dataDir, userData: dataDir, temp: require('os').tmpdir(),
    home: require('os').homedir(), documents: path.join(require('os').homedir(), 'Documents'),
    downloads: path.join(require('os').homedir(), 'Downloads'), desktop: path.join(require('os').homedir(), 'Desktop'),
  })[k] ?? dataDir,
  setPath: (k, v) => { paths[k] = v; },
  getVersion: () => exePkg.version,
  getName: () => 'DraconDex',
  commandLine: { appendSwitch() {} },
  requestSingleInstanceLock: () => true, // tauri-plugin-single-instance does this on the Rust side
  whenReady: () => readyP,
  isReady: () => false,
  quit() {
    if (quitting) return;
    quitting = true;
    try { app.emit('before-quit'); app.emit('will-quit', { preventDefault() {} }); } catch (e) { console.error(e); }
    emit({ t: 'quit' });
    setTimeout(() => process.exit(0), 50);
  },
  exit: (c) => process.exit(c ?? 0),
  focus() {},
});

const wins = new Map();
let winSeq = 0;
let focusedId = null;

class WebContents extends EventEmitter {
  constructor(win) { super(); this.win = win; this.id = win.id; this.streams = new Set();
    // permission lockdown is the webview's job on the Tauri side (no permissions are granted)
    this.session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {}, onHeadersReceived() {} } };
  }
  isDestroyed() { return this.win.destroyed; }
  send(channel, ...args) {
    const data = `data: ${encode({ channel, args })}\n\n`;
    for (const res of this.streams) res.write(data);
  }
  executeJavaScript() { return Promise.resolve(); }
  setWindowOpenHandler() {}
  printToPDF() { return Promise.reject(new Error('printToPDF is not available in the Tauri build yet')); }
  openDevTools() {}
}

class BrowserWindow extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.id = ++winSeq;
    this.opts = opts;
    this.destroyed = false;
    this.state = { bounds: { x: opts.x ?? 0, y: opts.y ?? 0, width: opts.width || 800, height: opts.height || 600 }, maximized: false, minimized: false };
    this.webContents = new WebContents(this);
    wins.set(this.id, this);
    app.emit('web-contents-created', {}, this.webContents);
  }
  loadFile(file, { search } = {}) {
    // Only the app's own document, with the app's own preload. Plugin windows
    // (preload-plugin.js) and temp files (print-to-PDF) would otherwise be
    // handed the full window.api — refuse rather than open them.
    const preload = this.opts.webPreferences?.preload;
    if (path.resolve(file) !== INDEX || (preload && path.resolve(preload) !== APP_PRELOAD)) {
      this._gone();
      return Promise.reject(new Error('this window type is not supported in the Tauri build yet'));
    }
    const o = this.opts;
    emit({
      t: 'open', id: this.id, query: search || '',
      width: o.width || 800, height: o.height || 600, minWidth: o.minWidth, minHeight: o.minHeight,
      x: o.x, y: o.y, parent: o.parent?.id ?? null, frame: o.frame !== false,
    });
    focusedId = this.id;
    setImmediate(() => {
      this.emit('ready-to-show'); this.emit('show');
      this.webContents.emit('did-finish-load');
    });
    return Promise.resolve();
  }
  _gone() {
    if (this.destroyed) return;
    this.destroyed = true;
    wins.delete(this.id);
    if (focusedId === this.id) focusedId = null;
    for (const res of this.webContents.streams) res.end();
    try { this.emit('close', { preventDefault() {} }); this.emit('closed'); this.webContents.emit('destroyed'); } catch (e) { console.error(e); }
    if (wins.size === 0) app.emit('window-all-closed');
  }
  isDestroyed() { return this.destroyed; }
  isMaximized() { return this.state.maximized; }
  isMinimized() { return this.state.minimized; }
  isVisible() { return !this.destroyed; }
  getBounds() { return { ...this.state.bounds }; }
  getNormalBounds() { return { ...this.state.bounds }; }
  getParentWindow() { return this.opts.parent || null; }
  close() { if (!this.destroyed) fire('win.close', { id: this.id }); }
  destroy() { this.close(); }
  show() {} // Tauri windows are created visible; ready-to-show can fire before Rust has built it
  focus() { fire('win.focus', { id: this.id }); }
  restore() { fire('win.unminimize', { id: this.id }); }
  minimize() { this.state.minimized = true; fire('win.minimize', { id: this.id }); }
  maximize() { this.state.maximized = true; fire('win.maximize', { id: this.id }); }
  unmaximize() { this.state.maximized = false; fire('win.unmaximize', { id: this.id }); }
  setTitle() {} setBackgroundColor() {} setVibrancy() {} setMenuBarVisibility() {} setAlwaysOnTop() {}
  static getAllWindows() { return [...wins.values()]; }
  static getFocusedWindow() { return wins.get(focusedId) || null; }
  static fromWebContents(wc) { return wc?.win && !wc.win.destroyed ? wc.win : null; }
  static fromId(id) { return wins.get(id) || null; }
}

// Electron accepts (window, options) or (options).
const dlgOpts = (a, b) => (b === undefined && a && !(a instanceof BrowserWindow) ? a : b) || {};
const fakeElectron = {
  app,
  BrowserWindow,
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on() {}, removeHandler: (ch) => handlers.delete(ch) },
  dialog: {
    showOpenDialog: (a, b) => call('dialog.open', dlgOpts(a, b)),
    showSaveDialog: (a, b) => call('dialog.save', dlgOpts(a, b)),
    showMessageBox: async () => ({ response: 0 }),
    showErrorBox: (t, c) => console.error(`[dialog] ${t}: ${c}`),
  },
  shell: {
    openExternal: (url) => call('shell.openExternal', { url: String(url) }),
    openPath: (p) => call('shell.openPath', { path: String(p) }).then(() => '', (e) => e.message),
    showItemInFolder: (p) => { fire('shell.showItemInFolder', { path: String(p) }); },
    trashItem: (p) => call('shell.trashItem', { path: String(p) }),
  },
  screen: { getDisplayMatching: display, getPrimaryDisplay: display, getAllDisplays: () => [display()], getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu() {} },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0), getSize: () => ({ width: 0, height: 0 }) }), createEmpty: () => ({ isEmpty: () => true }) },
  nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: true, themeSource: 'system' }),
  // ponytail: no safeStorage — secret-store.js falls back to plaintext (it warns once). Wire Rust keyring when Drive/Sync matter here.
  safeStorage: { isEncryptionAvailable: () => false },
  protocol: null, // ddx-file:// unavailable; the renderer's <img onerror> fallback to importdock:readFiles takes over
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, ...rest);
};

// ── wire format: JSON + Uint8Array/Date/BigInt (Electron IPC is structured-clone) ──
function encode(v) {
  return JSON.stringify(v, function (k, x) {
    const raw = this[k];
    if (raw instanceof Uint8Array) return { __u8: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('base64') };
    if (raw instanceof ArrayBuffer) return { __u8: Buffer.from(raw).toString('base64') };
    if (raw instanceof Date) return { __date: raw.toISOString() };
    if (typeof x === 'bigint') return Number(x);
    return x;
  }) ?? 'null';
}
const decode = (s) => JSON.parse(s, (_, x) => {
  if (x && typeof x === 'object' && typeof x.__u8 === 'string') return Buffer.from(x.__u8, 'base64');
  if (x && typeof x === 'object' && typeof x.__date === 'string') return new Date(x.__date);
  return x;
});

// ── load the real main process ─────────────────────────────────────────────
const handlers = new Map();
require(MAIN);
console.log(`[rut] ${handlers.size} IPC handlers registered from ${MAIN}`);

// ── renderer bridge: the real preload.js, with contextBridge/ipcRenderer over HTTP ──
const bridgeJs = () => `(() => {
  const D = window.__DDX; if (!D) { document.documentElement.textContent = 'DraconDex-RUT: missing bridge token'; return; }
  const enc = (v) => JSON.stringify(v, function (k, x) {
    const raw = this[k];
    if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) { const u = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw; let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return { __u8: btoa(s) }; }
    if (raw instanceof Date) return { __date: raw.toISOString() };
    return x;
  });
  const dec = (s) => JSON.parse(s, (_, x) => {
    if (x && typeof x === 'object' && typeof x.__u8 === 'string') { const b = atob(x.__u8), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
    if (x && typeof x === 'object' && typeof x.__date === 'string') return new Date(x.__date);
    return x;
  });
  // settings.js zooms <body> by the UI scale and widens it to (100/scale)vw to
  // compensate — right for Chromium (Electron, WebView2 on Windows), but WebKit
  // (Tauri on Linux/macOS) already resolves vw/vh in zoomed units, so the page
  // would overflow the window by 1/scale. Cancel the compensation there only.
  if (!/Chrome[/]/.test(navigator.userAgent)) {
    const st = document.createElement('style');
    st.textContent = 'body{width:100vw!important;height:100vh!important}';
    document.head.appendChild(st);
  }
  const listeners = new Map();
  const es = new EventSource('/__ddx/events?win=' + D.win + '&token=' + D.token);
  es.onmessage = (m) => { const { channel, args } = dec(m.data); for (const f of listeners.get(channel) || []) { try { f({}, ...args); } catch (e) { console.error(e); } } };
  const ipcRenderer = {
    invoke: async (ch, ...args) => {
      const r = await fetch('/__ddx/ipc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ddx-token': D.token, 'x-ddx-win': String(D.win) }, body: enc({ ch, args }) });
      const out = dec(await r.text());
      if (!out.ok) throw new Error("Error invoking remote method '" + ch + "': " + out.error);
      return out.value;
    },
    on: (ch, f) => { if (!listeners.has(ch)) listeners.set(ch, new Set()); listeners.get(ch).add(f); return ipcRenderer; },
    removeListener: (ch, f) => { listeners.get(ch)?.delete(f); return ipcRenderer; },
  };
  const bridge = { contextBridge: { exposeInMainWorld: (k, v) => { window[k] = v; } }, ipcRenderer, webUtils: null };
  ((require) => {
${fs.readFileSync(APP_PRELOAD, 'utf8')}
  })(() => bridge);
})();`;

// index.html as EXE ships it, plus the bridge, with connect-src opened to this
// origin only — the IPC transport is now fetch() instead of Electron IPC.
const indexHtml = () => fs.readFileSync(INDEX, 'utf8')
  .replace(/connect-src\s+'none'/g, "connect-src 'self'")
  .replace(/<head>/i, '<head>\n  <script src="/__ddx/bridge.js"></script>');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
// Only the renderer tree and the vendored src/ assets are served; nothing else in EXE.
const SERVED = [path.join(EXE, 'electron') + path.sep, path.join(EXE, 'src') + path.sep];
const LOGO = path.join(__dirname, '..', 'assets', 'DraconDex_Tauri.svg');
const BRAND = { '/src/assets/brand/web/DraconDex_Color.webp': LOGO, '/src/assets/brand/DraconDex_Color.png': LOGO };
const tokenOk = (t) => typeof t === 'string' && t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // DNS-rebinding guard: only this exact loopback origin.
  if (req.headers.host !== `127.0.0.1:${server.address().port}`) { res.writeHead(403).end(); return; }
  const sec = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
  try {
    if (url.pathname === '/__ddx/ipc' && req.method === 'POST') {
      if (!tokenOk(req.headers['x-ddx-token'])) { res.writeHead(403).end(); return; }
      const chunks = []; for await (const c of req) chunks.push(c);
      const { ch, args } = decode(Buffer.concat(chunks).toString('utf8'));
      const win = wins.get(Number(req.headers['x-ddx-win']));
      if (win) focusedId = win.id;
      const fn = handlers.get(ch);
      let out;
      if (!fn) out = { ok: false, error: `No handler registered for '${ch}'` };
      else {
        try { out = { ok: true, value: await fn({ sender: win?.webContents ?? null }, ...(args || [])) }; }
        catch (e) { out = { ok: false, error: `${e?.name || 'Error'}: ${e?.message || e}` }; }
      }
      res.writeHead(200, { ...sec, 'content-type': 'application/json' }).end(encode(out));
      return;
    }
    if (url.pathname === '/__ddx/events') {
      const win = wins.get(Number(url.searchParams.get('win')));
      if (!tokenOk(url.searchParams.get('token')) || !win) { res.writeHead(403).end(); return; }
      res.writeHead(200, { ...sec, 'content-type': 'text/event-stream' });
      res.write(': ok\n\n');
      win.webContents.streams.add(res);
      req.on('close', () => win.webContents.streams.delete(res));
      return;
    }
    if (url.pathname === '/__ddx/bridge.js') { res.writeHead(200, { ...sec, 'content-type': 'text/javascript' }).end(bridgeJs()); return; }
    // The Tauri build wears its own logo: the star compass in navy/orange, not EXE's colour one.
    if (BRAND[url.pathname]) { res.writeHead(200, { ...sec, 'content-type': 'image/svg+xml' }).end(fs.readFileSync(BRAND[url.pathname])); return; }
    const file = path.resolve(EXE, '.' + decodeURIComponent(url.pathname));
    if (file === INDEX) { res.writeHead(200, { ...sec, 'content-type': 'text/html; charset=utf-8' }).end(indexHtml()); return; }
    if (!SERVED.some((p) => file.startsWith(p)) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { ...sec, 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error('[rut] http', e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

// ── messages from Rust ─────────────────────────────────────────────────────
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch (_) { return; }
  if (m.t === 'reply') {
    const p = pending.get(m.rpc); if (!p) return;
    pending.delete(m.rpc);
    if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error || 'failed'));
  } else if (m.t === 'state') {
    const w = wins.get(m.id); if (w) Object.assign(w.state, { bounds: m.bounds ?? w.state.bounds, maximized: !!m.maximized, minimized: !!m.minimized });
  } else if (m.t === 'focus') {
    if (wins.has(m.id)) focusedId = m.id;
  } else if (m.t === 'closed') {
    wins.get(m.id)?._gone();
  } else if (m.t === 'start') {
    if (m.workArea) workArea = m.workArea;
    readyResolve();
  } else if (m.t === 'second-instance') {
    app.emit('second-instance', {}, m.argv || [], m.cwd || '');
  }
}).on('close', () => app.quit()); // Rust side gone

server.listen(0, '127.0.0.1', () => emit({ t: 'ready', port: server.address().port, token: TOKEN }));
