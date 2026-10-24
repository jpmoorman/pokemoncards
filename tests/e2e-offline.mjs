// Offline and bad-connection behaviour of the service worker (sw.js) and the files it keeps:
//  - after the first visit every big file (models/, vendor/, data/) is saved; after an online
//    start the app opens, scans (card details from the shipped file) and shows the collection
//    with no connection at all;
//  - an app update shows up at the next start and doesn't download the big files again; saved
//    versions no list mentions any more are deleted; a download cut short is never kept;
//  - a slow, hanging or flaky connection doesn't hold up the start (the saved copy opens after
//    about 2 s, and the page offers to reload once the newer version has come in).
// Serves the app itself (to slow down, drop or change files) and stubs other sites as harness.mjs does.
//   CHROMIUM_PATH=… node tests/e2e-offline.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { root, stubNetwork, makeCard, reporter, CARDS } from './harness.mjs';
import { ASSETS } from '../js/assets.js';

const t = reporter();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.traineddata': 'application/octet-stream' };

// ---------- the app's server, with knobs ----------
const net = {
  log: [], // paths asked for
  delay: 0, // ms before answering (this server speaks HTTP/1.1: the browser sends 6 requests at a time)
  slow: new Map(), // path -> ms before answering that file
  hang: false, // never answer
  drop: 0, // share of requests whose connection is cut
  changed: new Map(), // path -> Buffer served instead of the file (a new app version)
  cutOnce: new Set(), // paths whose next answer stops halfway
  waiting: new Set(), // answers held back (delay, hang): cut() drops their connections
};
/** Drop every connection still waiting for an answer (a stalled connection that finally breaks). */
async function cut() {
  for (const res of net.waiting) res.socket?.destroy();
  net.waiting.clear();
  await new Promise((r) => setTimeout(r, 300));
}
const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\//, '') || 'index.html';
  net.log.push(p);
  if (offline) return req.socket.destroy(); // no connection (the browser's offline mode misses some requests)
  if (net.hang) return net.waiting.add(res); // the connection stays open, nothing comes
  if (net.drop && Math.random() < net.drop) return req.socket.destroy();
  const delay = net.slow.get(p) || net.delay;
  if (delay) {
    net.waiting.add(res);
    await new Promise((r) => setTimeout(r, delay));
    if (!net.waiting.delete(res)) return; // cut meanwhile
  }
  let body = net.changed.get(p);
  if (!body) {
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end();
    body = fs.readFileSync(f);
  }
  if (net.cutOnce.delete(p)) body = body.subarray(0, body.length >> 1); // a download cut short (looks complete to the browser)
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Content-Length': body.length });
  res.end(body);
});
await new Promise((r) => server.listen(0, r));
const origin = `http://localhost:${server.address().port}`;
const asks = (pred) => net.log.filter(pred);
let offline = false;
const isBig = (p) => /^(models|vendor|data)\//.test(p);

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await stubNetwork(context, origin);
// Registered last, so it runs first: no other site answers while offline.
await context.route(/^https:\/\//, (r) => (offline ? r.abort('internetdisconnected') : r.fallback()));
await context.addInitScript(() => {
  window.SERVICE_WORKER_ON_HTTP = true;
  // Every toast shown on this page.
  window.__toasts = [];
  const seen = new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.classList?.contains('toast') && window.__toasts.push(n.textContent))));
  document.addEventListener('DOMContentLoaded', () => seen.observe(document.body, { childList: true }));
});
const logs = [];
const page = await context.newPage();
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && logs.push(`error: ${m.text()}`));

async function setOffline(on) {
  offline = on;
  await context.setOffline(on);
}
const savedBig = () => page.evaluate(async () => (await (await caches.open('card-scanner-assets')).keys()).map((r) => new URL(r.url).pathname.slice(1)).sort());
async function waitSaved(paths, timeout = 60000) {
  const until = Date.now() + timeout;
  let have = [];
  while (Date.now() < until) {
    have = await savedBig();
    if (paths.every((p) => have.includes(p))) return have;
    await new Promise((r) => setTimeout(r, 300));
  }
  return have;
}
const appReady = () => page.waitForFunction(() => window.cardScanner?.catalog?.index, null, { timeout: 30000 });
/** Reload; resolves to seconds until the app is up (catalog loaded). */
async function start() {
  const t0 = Date.now();
  const sent = net.log.length;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(async (e) => {
    // A start that hangs (seen once, cause unknown): what the service worker and the server were doing.
    const sw = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      const st = (w) => w?.state || null;
      return { active: st(r?.active), waiting: st(r?.waiting), installing: st(r?.installing), controller: !!navigator.serviceWorker.controller };
    }).catch((x) => `unavailable: ${x.message}`);
    console.log('start() timed out:', JSON.stringify({ sw, asked: net.log.slice(sent), held: net.waiting.size, offline, net: { delay: net.delay, hang: net.hang, drop: net.drop, slow: [...net.slow] } }));
    throw e;
  });
  await appReady();
  return (Date.now() - t0) / 1000;
}
async function scan(spec) {
  const buf = await makeCard(page, spec);
  await page.setInputFiles('#file-input-library', { name: 'card.png', mimeType: 'image/png', buffer: buf });
  await page.waitForSelector('#sheet:not([hidden]) .detail-name', { timeout: 120000 });
  await page.waitForFunction(() => document.querySelector('.headline-price, #card-detail .status')?.textContent.trim(), null, { timeout: 20000 });
  return page.evaluate(() => ({
    name: document.querySelector('.detail-name')?.textContent,
    set: document.querySelector('.set-name')?.textContent,
    price: document.querySelector('.headline-price')?.textContent,
    conf: document.querySelector('#confidence')?.textContent,
  }));
}
const listed = Object.keys(ASSETS).filter((p) => !ASSETS[p].lazy);

// ---------- 1. first visit: shell and every big file saved ----------
await page.goto(`${origin}/index.html`);
await appReady();
await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 30000 });
const first = await waitSaved(listed);
t.check(`first visit: the service worker saves all ${listed.length} big files in the background`, listed.every((p) => first.includes(p)), first.join(', '));
const toldReady = await page.waitForFunction(() => window.__toasts.includes('Ready to scan without a connection'), null, { timeout: 10000 }).then(() => true, () => false);

// The Home Screen app's first start (everything now comes through the service worker), online:
// scan a card and save it.
await start();
await page.waitForTimeout(1500);
const toldAgain = await page.evaluate(() => window.__toasts.filter((x) => /without a connection/.test(x)).length);
t.check('once they are all saved the app says it can scan without a connection, once', toldReady && toldAgain === 0, JSON.stringify({ toldReady, toldAgain }));
const online = await scan(CARDS.charizardEx);
await page.click('.actions .btn:has-text("Add to collection")');
await page.click('.sheet-close');
t.check('online: scan identifies the card', online.name === 'Charizard ex' && online.set === 'Obsidian Flames', JSON.stringify(online));

// ---------- 2. no connection at all ----------
await setOffline(true);
net.log.length = 0;
const offlineSecs = await start();
const off = await scan(CARDS.charizardEx);
const details = await page.evaluate(async () => {
  const { lookupCard } = await import('/js/api.js');
  const c = await lookupCard('base1-4'); // never shown, never downloaded: only in the details file
  return c && { hp: c.hp, attacks: c.attacks.map((a) => a.name), illus: c.illustrator };
});
await page.click('.actions .btn:has-text("Add to collection")');
await page.click('.sheet-close');
await page.click('.tab[data-view="collection"]');
const saved = await page.evaluate(() => ({ rows: document.querySelectorAll('#collection-list .citem').length, text: document.querySelector('#collection-list').textContent, total: document.querySelector('#collection-total').textContent }));
// The server refused every request meanwhile. Only files outside the app and its big files
// may have been tried first: the Tesseract fallback the tests serve from node_modules (the
// service worker tries the network, then its copy), and what the browser fetches itself
// around the service worker (the tab icon, its check for a new sw.js).
const asked = net.log.filter((p) => !/^(icons\/|favicon|node_modules\/|sw\.js$)/.test(p));
t.check(`offline: the app opens from the saved copy (${offlineSecs.toFixed(1)}s) without asking for any of its files`, offlineSecs < 5 && asked.length === 0, asked.join(' '));
t.check('offline: a scan gives the same card and confidence as online', off.name === online.name && off.set === online.set && off.conf === online.conf && off.price === online.price, JSON.stringify({ online, off }));
t.check('offline: card details for ranking come from the shipped file', details?.hp === 120 && details.attacks.length > 0, JSON.stringify(details));
t.check('offline: the collection shows the saved card, and adding works', saved.rows === 1 && /Charizard ex/.test(saved.text) && saved.text.includes('×2'), JSON.stringify(saved));
await page.click('.tab[data-view="scan"]');

// ---------- 3. an app update ----------
await setOffline(false);
net.log.length = 0;
const v2 = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace('<title>', '<meta name="app-version" content="2" />\n  <title>');
net.changed.set('index.html', Buffer.from(v2));
net.changed.set('js/ui.js', Buffer.from(`${fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8')}\n// version 2\n`));
await start();
const version = () => page.evaluate(() => document.querySelector('meta[name="app-version"]')?.content || '1');
const uiNew = await page.evaluate(() => fetch('js/ui.js').then((r) => r.text()).then((s) => s.includes('// version 2')));
t.check('app update on a good connection: the new version opens at once', (await version()) === '2' && uiNew, `version ${await version()}`);
// The service worker itself updated too.
net.changed.set('sw.js', Buffer.from(`${fs.readFileSync(path.join(root, 'sw.js'), 'utf8')}\n// version 2\n`));
await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
await page.waitForFunction(() => navigator.serviceWorker.getRegistration().then((r) => !r.installing && !r.waiting), null, { timeout: 30000 });
await start();
const bigAsked = asks(isBig);
t.check('app update: no big file (models/, vendor/, data/) is downloaded again', bigAsked.length === 0 && listed.every((p) => net.log.includes(p) === false), bigAsked.join(' ') || `${net.log.length} requests, none for big files`);
const still = await savedBig();
t.check('app update: the saved big files are all still there', listed.every((p) => still.includes(p)), still.join(', '));

// ---------- 4. versions of big files: new ones download, unlisted ones go, cut-short ones aren't kept ----------
const blob = (n) => crypto.createHash('sha512').update(String(n)).digest().toString('hex').repeat(300); // ~38 KB
const fakes = {};
for (const n of [1, 2, 3]) {
  const p = `data/test-asset-${n}.bin`;
  const buf = Buffer.from(blob(n));
  net.changed.set(p, buf);
  fakes[p] = { bytes: buf.length, integrity: `sha256-${crypto.createHash('sha256').update(buf).digest('base64')}` };
}
const assetsJs = (extra) => {
  const list = { ...ASSETS, ...extra };
  return `export const ASSETS = ${JSON.stringify(list, null, 1)};\n`;
};
const withList = async (paths) => {
  net.changed.set('js/assets.js', Buffer.from(assetsJs(Object.fromEntries(paths.map((p) => [p, fakes[p]])))));
  await start();
};
await withList(['data/test-asset-1.bin']);
let have = await waitSaved(['data/test-asset-1.bin']);
t.check('a new big file listed by the app downloads in the background', have.includes('data/test-asset-1.bin'), have.join(', '));
await withList(['data/test-asset-2.bin']);
have = await waitSaved(['data/test-asset-2.bin']);
t.check('the version before is kept while the previous list still has it', have.includes('data/test-asset-1.bin') && have.includes('data/test-asset-2.bin'), have.join(', '));
net.cutOnce.add('data/test-asset-3.bin');
net.log.length = 0;
await withList(['data/test-asset-3.bin']);
have = await waitSaved(['data/test-asset-3.bin']);
const size3 = await page.evaluate(async () => (await (await (await caches.open('card-scanner-assets')).match('data/test-asset-3.bin'))?.arrayBuffer())?.byteLength);
t.check('a file no list has any more is deleted; files in use are kept', !have.includes('data/test-asset-1.bin') && have.includes('data/test-asset-2.bin') && listed.every((p) => have.includes(p)), have.join(', '));
t.check('a download cut short is retried and only the whole file is kept', size3 === fakes['data/test-asset-3.bin'].bytes && asks((p) => p === 'data/test-asset-3.bin').length === 2, `kept ${size3} of ${fakes['data/test-asset-3.bin'].bytes} bytes, asked ${asks((p) => p === 'data/test-asset-3.bin').length}×`);

// ---------- 5. slow, hanging and flaky connections ----------
net.delay = 8000;
const slow = await start();
t.check(`slow connection (8 s per file): the app opens from the saved copy in ${slow.toFixed(1)}s`, slow < 4.5);
net.delay = 0;
await cut();
net.hang = true;
const hung = await start();
t.check(`connection that never answers: the app opens in ${hung.toFixed(1)}s`, hung < 4.5);
net.hang = false;
await cut();
net.drop = 0.5;
const flaky = await start();
t.check(`flaky connection (half the requests cut): the app opens in ${flaky.toFixed(1)}s`, flaky < 4.5);
net.drop = 0;
// A newer version that comes in too late for this start: it opens the old one, offers Reload.
net.changed.set('index.html', Buffer.from(v2.replace('content="2"', 'content="3"')));
net.slow.set('index.html', 3500);
const late = await start();
const before = await version();
await page.waitForSelector('.toast-action:has-text("A new version of the app is ready")', { timeout: 15000 }).catch(() => null);
net.slow.clear();
const offer = await page.$('.toast-action:has-text("A new version of the app is ready") button');
if (offer) await Promise.all([page.waitForNavigation({ timeout: 30000 }).catch(() => null), offer.click()]);
await appReady();
const swState = () => page.evaluate(async () => ({ caches: (await caches.keys()).filter((k) => k.includes('shell')), state: await (await (await caches.open('card-scanner-meta')).match('__shell'))?.json() }));
t.check(`a version that comes too late opens next time: saved copy in ${late.toFixed(1)}s, then "Reload" gives the new one`, before === '2' && !!offer && (await version()) === '3', `before ${before}, offered ${!!offer}, after ${await version()} ${JSON.stringify(await swState())}`);

// ---------- 6. a late version with new big files, then a start with no connection ----------
// Version 4 moves the card details and the text-recognition models to new paths (the way a
// release ships a new big file) and comes in too late for the start. It must not open with no
// connection before its new files are saved: the version in use opens and scans as online did.
const moved = (p) => p.replace(/^data\/details-[\w-]+\.json$/, 'data/details-v4test.json').replace('models/ppocr-v6tiny-1/', 'models/ppocr-v6tiny-9/');
const newBig = listed.map(moved).filter((p) => !listed.includes(p));
net.changed.set('js/assets.js', Buffer.from(`export const ASSETS = ${JSON.stringify(Object.fromEntries(Object.entries(ASSETS).map(([p, a]) => [moved(p), a])), null, 1)};\n`));
net.changed.set('js/ocr-worker.js', Buffer.from(fs.readFileSync(path.join(root, 'js/ocr-worker.js'), 'utf8').replace("'models/ppocr-v6tiny-1/'", "'models/ppocr-v6tiny-9/'")));
net.changed.set('index.html', Buffer.from(v2.replace('content="2"', 'content="4"')));
const offlineCheck = async () => {
  // A scan that fails ("Could not load the text-recognition engine") says so in the status line.
  const failed = page.waitForFunction(() => /Scan failed/.test(document.querySelector('#scan-status')?.textContent || '') && document.querySelector('#scan-status').textContent, null, { timeout: 120000 });
  const res = await Promise.race([scan(CARDS.charizardEx), failed.then((h) => h.jsonValue()).then((status) => ({ status }))]);
  if (res.status) return { same: false, res };
  await page.click('.sheet-close');
  const hp = await page.evaluate(async () => (await (await import(new URL('js/api.js', location.href).href)).lookupCard('base1-4'))?.hp);
  return { same: res.name === online.name && res.set === online.set && res.conf === online.conf, hp, res };
};
// First its new files can't be had (not on the server yet).
net.slow.set('index.html', 3500);
await start();
const deadline = Date.now() + 20000;
while (Date.now() < deadline && !newBig.every((p) => net.log.includes(p))) await new Promise((r) => setTimeout(r, 300));
await new Promise((r) => setTimeout(r, 1000));
net.slow.clear();
const offeredEarly = !!(await page.$('.toast-action:has-text("A new version of the app is ready")'));
await setOffline(true);
await start();
const stayed = { version: await version(), ...(await offlineCheck()) };
await setOffline(false);
t.check('a late version whose new big files are not saved: no reload offered, and a start with no connection keeps the version in use and scans as online', !offeredEarly && stayed.version === '3' && stayed.same && stayed.hp === 120, JSON.stringify({ offeredEarly, ...stayed }));
// Now its files can be had: they download in the background after the late start, then
// Reload is offered, and a start with no connection opens the new version, scanning as online.
for (const p of newBig) net.changed.set(p, fs.readFileSync(path.join(root, listed.find((q) => moved(q) === p))));
net.slow.set('index.html', 3500);
await start();
const got = await waitSaved(newBig, 30000);
const offered4 = await page.waitForSelector('.toast-action:has-text("A new version of the app is ready")', { timeout: 15000 }).then(() => true, () => false);
net.slow.clear();
await setOffline(true);
net.log.length = 0;
await start();
const moved4 = { version: await version(), ...(await offlineCheck()) };
await setOffline(false);
t.check('...once they are saved, Reload is offered and a start with no connection opens the new version and scans as online', newBig.every((p) => got.includes(p)) && offered4 && moved4.version === '4' && moved4.same && moved4.hp === 120, JSON.stringify({ saved: newBig.filter((p) => got.includes(p)), offered4, ...moved4 }));

const errors = logs.filter((l) => !/Failed to load resource|net::ERR|Estimating resolution|Detected \d+ diacritics/.test(l));
t.check('no page errors', !errors.length, errors.slice(0, 5).join('\n'));
await browser.close();
server.close();
t.done();
