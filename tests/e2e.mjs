// End-to-end check: runs the real app + real Tesseract OCR in headless Chromium
// against generated card images. The TCGdex API is stubbed with fixtures.
//   npm install && npm run test:e2e
import { chromium } from 'playwright';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'tests/fixtures');
const catalog = JSON.parse(fs.readFileSync(path.join(fixtures, 'catalog.json')));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.gz': 'application/gzip', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'index.html') : p;
  if (!file.startsWith(root) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const origin = `http://localhost:${server.address().port}`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

await context.addInitScript((o) => {
  window.TESSERACT_URL = `${o}/node_modules/tesseract.js/dist/tesseract.min.js`;
  window.TESSERACT_PATHS = {
    workerPath: `${o}/node_modules/tesseract.js/dist/worker.min.js`,
    corePath: `${o}/node_modules/tesseract.js-core`,
    langPath: `${o}/node_modules/@tesseract.js-data/eng/4.0.0_best_int`,
  };
}, origin);

function apiRoute(route) {
  const u = new URL(route.request().url());
  const p = u.pathname.replace('/v2/en', '');
  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  if (p === '/sets') return json(catalog.sets);
  if (p === '/cards') return json(catalog.cards);
  let m = /^\/sets\/([^/]+)$/.exec(p);
  if (m) return json({ id: m[1], abbreviation: catalog.abbr[m[1]] ? { official: catalog.abbr[m[1]] } : undefined });
  m = /^\/cards\/([^/]+)$/.exec(p);
  const f = m && path.join(fixtures, `card-${decodeURIComponent(m[1])}.json`);
  if (f && fs.existsSync(f)) return json(JSON.parse(fs.readFileSync(f)));
  return route.fulfill({ status: 404, body: '{}' });
}
function assetRoute(route) {
  return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="63" height="88"><rect width="63" height="88" fill="#556"/></svg>' });
}
await context.route('https://api.tcgdex.net/**', apiRoute);
await context.route('https://assets.tcgdex.net/**', assetRoute);

const page = await context.newPage();
const logs = [];
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(origin + '/index.html');

// Draw a simplified card in the page and return it as PNG/JPEG bytes.
async function makeCard(spec) {
  const dataUrl = await page.evaluate((spec) => {
    const W = 630, H = 880, s = spec.scale || 2;
    const card = document.createElement('canvas');
    card.width = W * s; card.height = H * s;
    const c = card.getContext('2d');
    c.scale(s, s);
    c.fillStyle = spec.border; c.fillRect(0, 0, W, H);
    c.fillStyle = spec.inner; c.fillRect(22, 22, W - 44, H - 44);
    // artwork
    const g = c.createLinearGradient(0, 100, W, 420);
    g.addColorStop(0, '#d2553a'); g.addColorStop(0.5, '#3a3550'); g.addColorStop(1, '#f2b24a');
    c.fillStyle = g; c.fillRect(48, 104, W - 96, 320);
    for (let i = 0; i < 400; i++) { c.fillStyle = `hsla(${(i * 37) % 360},70%,50%,.25)`; c.fillRect((i * 97) % 520 + 48, (i * 61) % 300 + 110, 18, 14); }
    c.fillStyle = '#111';
    if (spec.stage) { c.font = 'bold 15px sans-serif'; c.fillText(spec.stage, 44, 52); }
    c.font = `bold ${spec.nameSize || 38}px sans-serif`;
    c.fillText(spec.name, spec.stage ? 110 : 50, 72);
    c.font = 'bold 30px sans-serif'; c.textAlign = 'right'; c.fillText(spec.hp, W - 50, 72); c.textAlign = 'left';
    if (spec.evolves) { c.font = '13px sans-serif'; c.fillText(spec.evolves, 60, 96); }
    c.font = 'bold 22px sans-serif'; c.fillText(spec.attack || 'Fire Spin', 120, 520);
    c.font = '15px sans-serif';
    ['Discard 2 Energy attached to this Pokémon in order', 'to use this attack. This attack does 100 damage.'].forEach((t, i) => c.fillText(t, 60, 560 + i * 22));
    c.font = '14px sans-serif'; c.fillText('weakness ×2   resistance -30   retreat', 60, 760);
    c.font = '12px sans-serif'; c.fillText(spec.illus || 'Illus. 5ban Graphics', 50, 812);
    c.font = `bold ${spec.numSize || 15}px sans-serif`;
    if (spec.bottomLeft) c.fillText(spec.bottomLeft, 50, 840);
    if (spec.bottomRight) { c.textAlign = 'right'; c.fillText(spec.bottomRight, W - 50, 840); c.textAlign = 'left'; }
    c.font = '9px sans-serif'; c.fillText('©2023 Pokémon/Nintendo/Creatures/GAME FREAK', 230, 862);

    if (!spec.photo) return card.toDataURL('image/png');
    // Simulate a phone photo: card on a table, slightly rotated, softened, JPEG.
    const out = document.createElement('canvas');
    out.width = 3024; out.height = 4032;
    const o = out.getContext('2d');
    o.fillStyle = '#7a5a3c'; o.fillRect(0, 0, out.width, out.height);
    for (let i = 0; i < 3000; i++) { o.fillStyle = `rgba(0,0,0,${(i % 7) / 60})`; o.fillRect((i * 131) % 3024, (i * 89) % 4032, 40, 3); }
    o.translate(out.width / 2, out.height / 2);
    o.rotate((spec.photo.rotate || 0) * Math.PI / 180);
    o.filter = `blur(${spec.photo.blur || 0}px)`;
    const cw = out.width * spec.photo.fill, ch = cw * H / W;
    o.drawImage(card, -cw / 2, -ch / 2, cw, ch);
    return out.toDataURL('image/jpeg', 0.85);
  }, spec);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

const cases = [
  {
    label: 'Scarlet & Violet card (OBF set code)',
    spec: { border: '#c9ccd1', inner: '#f1ede3', stage: 'STAGE 2', name: 'Charizard ex', hp: 'HP 330', evolves: 'Evolves from Charmeleon', bottomLeft: 'G  OBF EN  125/197 ★', attack: 'Burning Darkness' },
    expect: { name: 'Charizard ex', set: 'Obsidian Flames', price: '$5.28' },
  },
  {
    label: 'Vintage Base Set card (symbol only, number on the right)',
    spec: { border: '#f0cc3a', inner: '#e9e4d4', name: 'Charizard', hp: '120 HP', evolves: 'Evolves from Charmeleon', bottomRight: '4/102 ★', illus: 'Illus. Mitsuhiro Arita', nameSize: 34 },
    expect: { name: 'Charizard', set: 'Base Set', price: '$954.65' },
  },
  {
    label: '30th Celebration card (30C set code, no prices yet)',
    spec: { border: '#c9ccd1', inner: '#f1ede3', stage: 'BASIC', name: 'Mewtwo ex', hp: 'HP 230', bottomLeft: 'I  30C EN  157/128 ★', attack: 'Photon Bullets', illus: 'Illus. YOSHIROTTEN' },
    expect: { name: 'Mewtwo ex', set: '30th Celebration', price: 'No price yet' },
  },
  {
    label: 'Phone photo of a card on a table (not cropped)',
    spec: { border: '#c9ccd1', inner: '#f1ede3', stage: 'STAGE 2', name: 'Charizard ex', hp: 'HP 330', evolves: 'Evolves from Charmeleon', bottomLeft: 'G  OBF EN  125/197 ★', scale: 3, photo: { fill: 0.72, rotate: 2, blur: 1 } },
    expect: { name: 'Charizard ex', set: 'Obsidian Flames', price: '$5.28' },
  },
];

let failed = 0;
for (const t of cases) {
  const buf = await makeCard(t.spec);
  fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test-results', `${t.label.replace(/\W+/g, '_')}.${t.spec.photo ? 'jpg' : 'png'}`), buf);
  const started = Date.now();
  await page.setInputFiles('#file-input-library', { name: 'card.png', mimeType: t.spec.photo ? 'image/jpeg' : 'image/png', buffer: buf });
  try {
    await page.waitForSelector('#sheet:not([hidden]) .detail-name', { timeout: 120000 });
    await page.waitForFunction(() => document.querySelector('.headline-price')?.textContent.trim(), null, { timeout: 20000 });
  } catch (e) {
    console.log(logs.slice(-20).join('\n'));
    console.log('status:', await page.textContent('#scan-status'));
  }
  const got = await page.evaluate(() => ({
    name: document.querySelector('.detail-name')?.textContent,
    set: document.querySelector('.set-name')?.textContent,
    price: document.querySelector('.headline-price')?.textContent,
    conf: document.querySelector('#confidence')?.textContent,
    clueName: document.querySelector('#clue-name')?.value,
    clueNum: document.querySelector('#clue-number')?.value,
    clueSet: document.querySelector('#clue-set')?.value,
    debug: document.querySelector('#debug')?.textContent,
  }));
  const ok = got.name === t.expect.name && got.set === t.expect.set && got.price === t.expect.price;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${t.label}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  console.log(`      read: name="${got.clueName}" number="${got.clueNum}" set="${got.clueSet}" -> ${got.name} | ${got.set} | ${got.price} | ${got.conf}`);
  if (!ok || process.env.VERBOSE) console.log(got.debug);
  await page.screenshot({ path: path.join(root, 'test-results', `${t.label.replace(/\W+/g, '_')}-result.png`) });
  await page.click('.sheet-close');
}

// Manual search + collection flow.
await page.click('.tab[data-view="search"]');
await page.fill('#q-name', 'charizard');
await page.fill('#q-number', '4/102');
await page.click('#search-form button[type="submit"]');
await page.click('#search-results .tile');
await page.waitForSelector('.add-btn');
await page.click('.variant-chips .chip:nth-child(2)');
const chipPrice = await page.textContent('.headline-price');
await page.click('.add-btn');
await page.click('.sheet-close');
await page.click('.tab[data-view="collection"]');
const total = await page.textContent('#collection-total');
const searchOk = chipPrice.includes('3,330.71') && total.includes('3,330.71');
if (!searchOk) failed++;
console.log(`${searchOk ? 'PASS' : 'FAIL'}  search → pick 1st Edition → collection total (${chipPrice} / ${total})`);
await page.screenshot({ path: path.join(root, 'test-results', 'collection.png') });

// Live camera path: feed a fake camera stream (needs ffmpeg) and press the shutter.
let haveFfmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { haveFfmpeg = false; }
if (haveFfmpeg) {
  const cardPng = path.join(root, 'test-results', 'camera-card.png');
  fs.writeFileSync(cardPng, await makeCard(cases[0].spec));
  const y4m = path.join(root, 'test-results', 'camera.y4m');
  // Portrait 1080x1920 frame, card ~940px wide in the middle (where the on-screen guide sits).
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x3b2f25:s=1080x1920:d=1', '-i', cardPng,
    '-filter_complex', '[1]scale=940:-1[c];[0][c]overlay=(W-w)/2:(H-h)/2', '-frames:v', '5', '-pix_fmt', 'yuv420p', y4m]);
  const camBrowser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`],
  });
  const camCtx = await camBrowser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['camera'] });
  await camCtx.addInitScript((o) => {
    window.TESSERACT_URL = `${o}/node_modules/tesseract.js/dist/tesseract.min.js`;
    window.TESSERACT_PATHS = { workerPath: `${o}/node_modules/tesseract.js/dist/worker.min.js`, corePath: `${o}/node_modules/tesseract.js-core`, langPath: `${o}/node_modules/@tesseract.js-data/eng/4.0.0_best_int` };
  }, origin);
  await camCtx.route('https://api.tcgdex.net/**', apiRoute);
  await camCtx.route('https://assets.tcgdex.net/**', assetRoute);
  const cam = await camCtx.newPage();
  await cam.goto(origin + '/index.html');
  await cam.click('#btn-start-camera').catch(() => {});
  await cam.waitForSelector('#btn-scan:not([disabled])', { timeout: 15000 });
  await cam.waitForTimeout(800);
  await cam.screenshot({ path: path.join(root, 'test-results', 'camera-view.png') });
  await cam.click('#btn-scan');
  await cam.waitForFunction(() => document.querySelector('.headline-price')?.textContent.trim(), null, { timeout: 120000 }).catch(() => {});
  const got = await cam.evaluate(() => [document.querySelector('.detail-name')?.textContent, document.querySelector('.set-name')?.textContent, document.querySelector('#clue-number')?.value]);
  const camOk = got[0] === 'Charizard ex' && got[1] === 'Obsidian Flames';
  if (!camOk) { failed++; console.log(await cam.evaluate(() => document.querySelector('#debug')?.textContent)); }
  console.log(`${camOk ? 'PASS' : 'FAIL'}  live camera scan -> ${got.join(' | ')}`);
  await cam.screenshot({ path: path.join(root, 'test-results', 'camera-result.png') });
  await camBrowser.close();
} else {
  console.log('SKIP  live camera scan (ffmpeg not installed)');
}

const errors = logs.filter((l) => l.startsWith('pageerror') || l.startsWith('error'));
if (errors.length) console.log('Console errors:\n' + errors.join('\n'));

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
