// Smoke test for the sidecar without Tauri: this script plays the Rust shell's
// part of the stdio protocol and opens each requested window in Chromium.
//   node test/smoke.mjs [path-to-DraconDex-EXE]
// Passes when the Welcome window boots, makes IPC calls, and renders.
import { spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const exe = path.resolve(process.argv[2] || path.join(here, '..', '..', 'DraconDex-EXE'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddx-rut-'));
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const child = spawn(process.execPath, [path.join(here, '..', 'sidecar', 'server.cjs'), exe], {
  env: { ...process.env, DRACONDEX_DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'inherit'],
});
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
const browser = await chromium.launch();
let base, token, ipcOk = false, opened = null;
const fail = (msg) => { console.error('FAIL:', msg); child.kill(); browser.close(); process.exit(1); };
setTimeout(() => fail('timeout'), 30000);

let buf = '';
child.stdout.on('data', async (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.startsWith('\x01DDX ')) { console.log(line); continue; }
    const m = JSON.parse(line.slice(5));
    if (m.t === 'ready') { base = `http://127.0.0.1:${m.port}`; token = m.token; send({ t: 'start' }); }
    else if (m.t === 'call') send({ t: 'reply', rpc: m.rpc, ok: true, value: { canceled: true } });
    else if (m.t === 'open' && !opened) opened = open(m);
  }
});

async function open(m) {
  const page = await browser.newPage({ viewport: { width: m.width, height: m.height } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (c) => { if (c.type() === 'error') console.log('[console]', c.text()); });
  page.on('requestfailed', (r) => console.log('[reqfail]', r.url(), r.failure()?.errorText));
  page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.url()); });
  page.on('response', (r) => { if (r.url().endsWith('/__ddx/ipc') && r.ok()) ipcOk = true; });
  await page.addInitScript(`window.__DDX={token:${JSON.stringify(token)},win:${m.id}}`);
  await page.goto(`${base}/electron/index.html${m.query ? '?' + m.query : ''}`);
  await page.waitForSelector('.welcome-hero, .welcome-wizard, .module-item, #hub-body', { timeout: 15000 }).catch(() => fail('UI did not render'));
  // A request without the token must be refused.
  const denied = await fetch(`${base}/__ddx/ipc`, { method: 'POST', body: '{"ch":"setting:get","args":[]}' }).then((r) => r.status);
  if (denied !== 403) fail(`tokenless IPC returned ${denied}`);
  const traversal = await fetch(`${base}/electron/../package.json`).then((r) => r.status);
  if (traversal === 200) fail('served a file outside electron/ and src/');
  if (!ipcOk) fail('no successful IPC call');
  const shot = path.join(here, 'smoke.png');
  await page.screenshot({ path: shot });
  console.log(`PASS — window ${m.id} (?${m.query}) rendered over IPC; screenshot ${shot}`);
  child.kill(); await browser.close(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0);
}
