// Shared end-to-end test harness: serves the app (with its own PP-OCR models and runtime),
// stubs every network API with fixtures, and points the Tesseract fallback at node_modules.
//   const h = await startHarness();  const page = await h.newPage();  ...  await h.close();
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fixtures = path.join(root, 'tests/fixtures');
export const results = path.join(root, 'test-results');
export const catalog = JSON.parse(fs.readFileSync(path.join(fixtures, 'catalog.json')));
export const EUR_USD = 1.12;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.txt': 'text/plain', '.onnx': 'application/octet-stream', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gz': 'application/gzip', '.webmanifest': 'application/manifest+json' };
const SVG = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" width="63" height="88"><rect width="63" height="88" fill="${fill}"/></svg>`;

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
  // Like the real API, every catalog card has details (identify.js looks up the best few
  // candidates); those without a fixture have no attacks, HP or prices.
  const card = m && catalog.cards.find((c) => c.id === decodeURIComponent(m[1]));
  if (card) return json(card);
  return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '{}' });
}

/** Route all third-party traffic to fixtures on a browser context. */
export async function stubNetwork(context, origin) {
  await context.addInitScript((o) => {
    window.TESSERACT_URL = `${o}/node_modules/tesseract.js/dist/tesseract.min.js`;
    window.TESSERACT_PATHS = {
      workerPath: `${o}/node_modules/tesseract.js/dist/worker.min.js`,
      corePath: `${o}/node_modules/tesseract.js-core`,
      langPath: `${o}/node_modules/@tesseract.js-data/eng/4.0.0_best_int`,
    };
  }, origin);
  await context.route('https://api.tcgdex.net/**', apiRoute);
  await context.route('https://assets.tcgdex.net/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: SVG('#556') }));
  // Marketplace photos per version: a different colour so tests can tell them apart.
  await context.route('https://tcgplayer-cdn.tcgplayer.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: SVG('#a63') }));
  await context.route('https://api.frankfurter.dev/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ base: 'EUR', date: '2026-10-22', rates: { USD: EUR_USD } }) }),
  );
  await context.route('https://open.er-api.com/**', (r) => r.fulfill({ status: 500, body: '' }));
}

export async function startHarness({ launchArgs = [], contextOptions = {} } = {}) {
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
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: launchArgs,
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, ...contextOptions });
  await stubNetwork(context, origin);
  fs.mkdirSync(results, { recursive: true });

  const logs = [];
  async function newPage() {
    const page = await context.newPage();
    page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
    await page.goto(origin + '/index.html');
    return page;
  }
  const errors = () => logs.filter((l) => l.startsWith('pageerror') || (l.startsWith('error') && !/Estimating resolution|Detected \d+ diacritics/.test(l)));
  return { origin, browser, context, newPage, logs, errors, close: async () => { await browser.close(); server.close(); } };
}

/** Tiny test runner: check(label, ok, details). Call done() at the end to exit with status. */
export function reporter() {
  let failed = 0;
  return {
    check(label, ok, details = '') {
      if (!ok) failed++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${details ? `  — ${details}` : ''}`);
      return ok;
    },
    get failed() {
      return failed;
    },
    done() {
      process.exit(failed ? 1 : 0);
    },
  };
}

// Draw a simplified card in the page and return it as PNG/JPEG bytes.
export async function makeCard(page, spec) {
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

/** Ready-made card specs used across tests. */
export const CARDS = {
  charizardEx: { border: '#c9ccd1', inner: '#f1ede3', stage: 'STAGE 2', name: 'Charizard ex', hp: 'HP 330', evolves: 'Evolves from Charmeleon', bottomLeft: 'G  OBF EN  125/197 ★', attack: 'Burning Darkness' },
  baseCharizard: { border: '#f0cc3a', inner: '#e9e4d4', name: 'Charizard', hp: '120 HP', evolves: 'Evolves from Charmeleon', bottomRight: '4/102 ★', illus: 'Illus. Mitsuhiro Arita', nameSize: 34 },
  mewtwo30th: { border: '#c9ccd1', inner: '#f1ede3', stage: 'BASIC', name: 'Mewtwo ex', hp: 'HP 230', bottomLeft: 'I  30C EN  157/128 ★', attack: 'Photon Bullets', illus: 'Illus. YOSHIROTTEN' },
  aurorus: { border: '#c9ccd1', inner: '#bfe0f2', stage: 'STAGE 2', name: 'Aurorus', hp: 'HP 170', evolves: 'Evolves from Amaura', bottomLeft: 'J  POR EN  024/088 ★', attack: 'Freezing Chill', illus: 'Illus. HACCAN' },
};

/** Choose a set in a type-to-filter set picker (hidden input id 'q-set' or 'clue-set'); '' clears it. */
export async function pickSet(page, hiddenId, setId) {
  const input = `.setpick:has(#${hiddenId}) .setpick-input`;
  if (!setId) {
    await page.fill(input, '');
    await page.locator(input).blur();
    await page.waitForFunction((id) => document.getElementById(id).value === '', hiddenId);
    return;
  }
  const name = await page.evaluate((id) => window.cardScanner.catalog.index.setsById.get(id)?.name, setId);
  await page.click(input);
  await page.fill(input, name);
  await page.locator(`.setpick:has(#${hiddenId}) li[data-id="${setId}"]`).dispatchEvent('pointerdown');
  await page.waitForFunction(([h, id]) => document.getElementById(h).value === id, [hiddenId, setId]);
}
