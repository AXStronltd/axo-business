// End-to-end browser test for the Business Hub's live mode.
//
// Drives a headless Chrome over the DevTools protocol (no extra dependencies)
// against a running API with seeded data, and asserts on what the merchant
// actually sees: sign-in, a QR payment request that a customer pays, the
// balance/feed updating, a refund, the settlement report, and a sign-out.
//
//   HUB_URL=http://127.0.0.1:8765/index.html API_URL=http://localhost:4000 node e2e/hub.e2e.mjs
//
// Needs: the API running with `npm run seed` data, and the frontend served.
// CHROME_BIN overrides the browser; screenshots go to E2E_OUT (default e2e/out).
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HUB = process.env.HUB_URL ?? 'http://127.0.0.1:8765/index.html';
const API = process.env.API_URL ?? 'http://localhost:4000';
const OUT = process.env.E2E_OUT ?? 'e2e/out';
const PORT = Number(process.env.CDP_PORT ?? 9333);
const CHROME = process.env.CHROME_BIN
  ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, what, detail = '') => {
  if (cond) console.log('  ✓', what);
  else { failures++; console.log('  ✗', what, detail ? '— ' + detail : ''); }
};

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmpdir(), 'axo-hub-e2e-' + process.pid)}`,
  '--window-size=1280,900', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  ...(process.env.CI ? ['--no-sandbox'] : []), 'about:blank',
], { stdio: 'ignore' });

let ws;
try {
  let targets = [];
  for (let i = 0; i < 80 && !targets.length; i++) {
    try { targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page'); } catch {}
    if (!targets.length) await sleep(250);
  }
  if (!targets.length) throw new Error('Chrome did not start (CHROME_BIN=' + CHROME + ')');
  ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });

  let id = 0; const pending = new Map(); const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const text = (sel) => js(`(document.querySelector(${JSON.stringify(sel)})||{}).innerText||''`);
  /** Wait until a page expression is truthy (no fixed sleeps: CI machines vary in speed). */
  const waitFor = async (expr, what, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await js(expr).catch(() => false)) return true; await sleep(150); }
    throw new Error('timed out waiting for: ' + what);
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `hub-${name}.png`), Buffer.from(r.result.data, 'base64'));
  };
  const bal = () => text('#lvBal');

  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: HUB });
  await waitFor(`typeof AXO_LIVE==='object' && !!document.querySelector('.demo-banner')`, 'Hub to load');

  console.log('demo mode');
  ok((await text('.demo-banner')).startsWith('DEMO DATA'), 'demo banner shown before sign-in');
  ok((await text('.sb-env')) === '● Demo data', 'sidebar does not claim "Production" in demo');

  console.log('sign-in');
  await js(`openSignIn(); siEmail.value='owner@java.test'; siPass.value='wrong-password'; doSignIn()`);
  await waitFor(`siMsg.textContent && siMsg.textContent!=='Signing in…'`, 'sign-in error');
  ok((await text('#siMsg')).includes('Wrong email or password'), 'wrong password is rejected');
  await js(`siPass.value='password123'; doSignIn()`);
  await waitFor(`AXO_LIVE.on && document.querySelector('#lvBal .hero-amt')`, 'live home');
  ok((await text('.demo-banner')).startsWith('SANDBOX'), 'sandbox banner after sign-in');
  ok((await text('#bizName')).includes('Java House'), 'shows the real business name');
  const before = BigInt((await bal()).replace(/\D/g, '') || '0');
  await shot('01-home');

  console.log('payment request → customer pays → Paid');
  await js(`openSheet('qr')`);
  await waitFor(`!!document.querySelector('#lvAmt')`, 'request form');
  await js(`lvAmt.value='12.50'; liveCreateRequest(false)`);
  await sleep(200);
  ok(!(await js(`!!document.querySelector('#lvReq')`)), 'KES amount with cents is refused');
  await js(`lvAmt.value='1,500'; lvDesc.value='2 x lunch'; lvRef.value='E2E-'+Date.now(); liveCreateRequest(false)`);
  await waitFor(`!!document.querySelector('#lvReq svg')`, 'QR to render');
  ok(true, 'a real QR (SVG) is shown for the request');
  await shot('02-qr');
  const reqId = await js(`lvReq.getAttribute('data-id')`);
  const merchantToken = await js(`AXO_LIVE.token`);
  const req = await (await fetch(`${API}/payment-requests/${reqId}`, { headers: { authorization: `Bearer ${merchantToken}` } })).json();
  const cust = await (await fetch(`${API}/customer/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ axoTag: '@amina', pin: '1234' }) })).json();
  const paid = await fetch(`${API}/customer/payment-requests/${req.ref}/pay`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cust.accessToken}` }, body: JSON.stringify({ pin: '1234' }) });
  ok(paid.status === 201, 'customer pays the request with their PIN', 'status ' + paid.status);
  await waitFor(`(document.querySelector('#lvReq')||{}).innerText?.includes('Paid')`, 'sheet to flip to Paid', 8000);
  ok((await text('#lvReq')).includes('@amina'), 'receipt names the payer');
  await shot('03-paid');

  console.log('home updates');
  await js(`closeSheet(); TAB='home'; render()`);
  await waitFor(`document.querySelector('#lvBal .hero-amt') && document.querySelector('#lvFeed .txn')`, 'home data');
  const after = BigInt((await bal()).replace(/\D/g, ''));
  ok(after - before === 1500n, 'balance rises by exactly KES 1,500', `${before} → ${after}`);
  ok((await text('#lvFeed')).includes('Payment received · @amina'), 'payment is at the top of the feed');

  console.log('refund');
  await js(`TAB='transactions'; render()`);
  await waitFor(`!!document.querySelector('#lvTx .txn')`, 'transactions');
  await js(`document.querySelector('#lvTx .txn').click()`);
  await waitFor(`!!document.querySelector('#lvRfAmt')`, 'refund form');
  await js(`lvRfAmt.value='500'; lvRfWhy.value='e2e'; document.querySelector('#lvRfGo').click()`);
  await waitFor(`(document.querySelector('#lvTx')||{}).innerText?.includes('Refund · @amina')`, 'refund in list');
  ok(true, 'partial refund appears in transactions');

  console.log('settlement report');
  await js(`TAB='settlements'; render()`);
  await waitFor(`(document.querySelector('#lvRep')||{}).innerText?.includes('Net')`, 'report');
  const rep = await text('#lvRep');
  ok(rep.includes('Reconciled'), 'report says both ledgers reconcile', rep.slice(0, 200));
  await shot('04-settlements');

  console.log('demo-only tools and sign-out');
  await js(`TAB='inventory'; render()`);
  ok((await text('#scroll')).includes('Not connected to the API yet'), 'demo-only tool says it is not connected');
  await send('Page.reload');
  await waitFor(`typeof AXO_LIVE==='object' && AXO_LIVE.on`, 'session to resume after reload');
  ok(true, 'reload keeps the session');
  await js(`signOut()`);
  await waitFor(`!AXO_LIVE.on`, 'sign-out');
  ok((await text('.demo-banner')).startsWith('DEMO DATA'), 'sign-out returns to the demo');

  console.log('phone width');
  await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 860, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  const bannerBox = await js(`(()=>{const r=document.querySelector('.demo-banner').getBoundingClientRect();return {w:r.width,x:r.left}})()`);
  ok(bannerBox.w >= 390 && bannerBox.x === 0, 'banner spans the full width on a phone', JSON.stringify(bannerBox));
  ok((await js(`document.documentElement.scrollWidth <= innerWidth + 1`)), 'no horizontal scrolling on a phone');
  await shot('05-phone');

  ok(errors.length === 0, 'no console errors', errors.join(' | '));
} catch (e) {
  failures++;
  console.log('  ✗', e.message);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
