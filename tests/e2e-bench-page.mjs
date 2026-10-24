// The hidden speed test page (bench.html): one tap measures this phone and browser, the camera,
// loading, timed camera and photo scans of sample cards (cold, then again), memory, a reader
// restart and a search test, and "Copy results" gives a summary plus JSON to paste. Network
// stubbed (harness: fixture card list), a fake camera, the TCGdex sample pictures served as
// drawn cards (some missing: the page draws its own then). Also with the Tesseract reader
// (?reader=tesseract), and a run the phone cut short (the page reloaded) is shown when the page
// opens again.
//   CHROMIUM_PATH=/opt/pw-browsers/chromium node tests/e2e-bench-page.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, reporter, CARDS, makeCard, root, stubNetwork } from './harness.mjs';

const FAKE_CAMERA = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
const h = await startHarness({ launchArgs: FAKE_CAMERA, contextOptions: { permissions: ['camera', 'clipboard-read', 'clipboard-write'] } });
const t = reporter();

// TCGdex pictures of the first two sample cards (drawn by the test, as PNG); the others 404.
const scratch = await h.context.newPage();
const pictures = {
  'base/base1/4': await makeCard(scratch, CARDS.baseCharizard),
  'sv/sv03/125': await makeCard(scratch, CARDS.charizardEx),
};
await scratch.close();

/** Open the page in `ctx` with the pictures routed; logs every host asked. */
async function open(ctx, query) {
  const page = await ctx.newPage();
  const hosts = new Set();
  page.on('request', (r) => hosts.add(new URL(r.url()).host));
  page.on('pageerror', (e) => h.logs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && h.logs.push(`error: ${m.text()}`));
  await page.route('https://assets.tcgdex.net/**', (r) => r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' }));
  await page.route(/assets\.tcgdex\.net\/en\/(.+)\/high\.(webp|png)$/, (r) => {
    const png = pictures[/en\/(.+)\/high\./.exec(r.request().url())[1]];
    return png ? r.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: png }) : r.fallback();
  });
  await page.goto(`${h.origin}/bench.html${query}`);
  return { page, hosts };
}

/** Tap Run and wait for the end; returns window.benchResults. */
async function runIt(page, timeout = 240000) {
  await page.click('#run');
  await page.waitForFunction(() => window.benchResults?.finished, null, { timeout });
  return page.evaluate(() => window.benchResults);
}

// 1) The normal run: PP-OCR, three sample cards (two pictures, one drawn), twice each way.
{
  const { page, hosts } = await open(h.context, '?samples=3&passes=2');
  const t0 = Date.now();
  const r = await runIt(page);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const d = r.steps.device;
  t.check('phone and browser: cores, SIMD, no cross-origin isolation, WebGPU answer, storage', d.cores > 0 && d.wasmSimd === true && d.crossOriginIsolated === false && typeof d.webgpu === 'string' && /Chrome/.test(d.browser) && d.storage?.quotaMB > 0 && d.appFiles?.of > 0, JSON.stringify(d));
  const c = r.steps.camera;
  t.check('camera opened the way the scanner opens it: resolution given and frame size', /^\d+x\d+$/.test(c.given) && /^\d+x\d+$/.test(c.frame) && c.asked === '3840x2160' && c.startMs >= 0, JSON.stringify(c));
  const l = r.steps.loading;
  t.check('loading: card list (downloaded on a fresh profile), set codes, details file', l.cardListMs >= 0 && l.cardListFrom === 'downloaded' && l.cards > 0 && l.setCodesMs >= 0 && /cards$/.test(l.detailsFile), JSON.stringify(l));
  t.check('sample cards: TCGdex pictures where they come, drawn ones where not', JSON.stringify(r.steps.pictures.cards) === JSON.stringify(['base1-4 (TCGdex)', 'sv03-125 (TCGdex)', 'me03-024 (drawn)']), JSON.stringify(r.steps.pictures));
  const reader = r.steps.reader;
  t.check('text reader start-up timed, and which reader ran (PP-OCR here)', reader.engine === 'ppocr' && reader.ms > 0 && reader.wasmMB > 0, JSON.stringify(reader));
  const scans = r.scans;
  const camera = scans.filter((x) => x.how === 'camera');
  const photo = scans.filter((x) => x.how === 'photo');
  const timed = (x) => !x.error && x.ms > 0 && x.read > 0 && x.match >= 0 && x.find >= 0 && x.rank1 >= 0 && x.engine === 'ppocr' && x.ms >= x.read + x.match;
  t.check('12 scans (3 cards × camera and photo × 2), each timed tap to result and per step', scans.length === 12 && scans.every(timed) && scans.filter((x) => x.pass === 2).length === 6, JSON.stringify(scans.filter((x) => !timed(x))));
  // A camera scan is cut out of a frame the camera's size; a photo is 12 MP, made at most 3000 px by the app.
  t.check('camera scans are guide cut-outs of the camera frame, photos are 2250x3000', camera.every((x) => /^\d+x\d+$/.test(x.input) && x.input !== c.frame) && photo.every((x) => x.input === '2250x3000' && x.detect > 0), JSON.stringify(scans.map((x) => [x.how, x.input, x.detect])));
  const right = scans.filter((x) => x.right).length;
  t.check(`the sample cards are identified (${right} of 12 right)`, right >= 10, JSON.stringify(scans.map((x) => [x.card, x.how, x.top, x.conf])));
  t.check('stamp check timed for cards read, memory after each scan', scans.every((x) => x.stamps > 0 && x.wasmMB > 0 && x.heapMB > 0), JSON.stringify(scans.map((x) => [x.stamps, x.wasmMB, x.heapMB])));
  const w = r.steps.wholeCards;
  t.check('six whole-card reads: time and the reader memory after (at most 120 MB)', w.times?.length === 6 && w.median > 0 && w.wasmMBAfter > 0 && w.wasmMBAfter <= 120, JSON.stringify(w));
  t.check('text reader restart and the search speed test', r.steps.restart.ms > 0 && r.steps.search.median > 0, JSON.stringify([r.steps.restart, r.steps.search]));
  t.check(`the run finished without errors (${secs} s here)`, r.finished && !Object.values(r.steps).some((s) => s?.error), JSON.stringify(Object.entries(r.steps).filter(([, s]) => s?.error)));
  // What is shown: plain-English sections.
  const shown = await page.textContent('#out');
  t.check('results shown in plain English', ['This phone', 'Camera', 'Loading', 'Scans (text reader: ppocr)', 'Camera scans: first', 'Photo scans: first', 'Text reader start-up', 'after 6 whole-card reads'].every((s) => shown.includes(s)), shown.slice(0, 400));
  // Copy results: a few lines, then the whole run as one line of JSON.
  await page.click('#copy');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const json = JSON.parse(/^JSON: (.*)$/m.exec(copied)?.[1] || 'null');
  t.check('"Copy results" copies a summary plus JSON of the whole run', /^Card scanner speed test /.test(copied) && /Camera scans: first/.test(copied) && json?.scans?.length === 12 && json.summary.engine === 'ppocr' && json.summary.camera.n === 6 && json.steps.camera.given === c.given, copied.slice(0, 300));
  t.check('only the app itself and the stubbed TCGdex hosts were asked', [...hosts].every((x) => /^localhost:\d+$|^(api|assets)\.tcgdex\.net$/.test(x)), [...hosts].join(', '));

  // 2) A run the phone cut short (the page reloaded mid-run): shown, with copy, when it opens again.
  await page.evaluate(() => {
    const r = JSON.parse(localStorage.getItem('card-scanner-bench'));
    localStorage.setItem('card-scanner-bench', JSON.stringify({ ...r, finished: false, step: 'Scanning', scans: r.scans.slice(0, 3) }));
  });
  await page.reload();
  const warn = await page.textContent('.warn').catch(() => '');
  const canCopy = await page.isEnabled('#copy');
  t.check('a run cut short is shown when the page opens again (and can be copied)', /stopped during "Scanning"/.test(warn) && canCopy && (await page.locator('#out tr').count()) > 10, warn);
  await page.close();
}

// 3) The Tesseract reader (the app's reader before PP-OCR, now its fallback where PP-OCR can't
// run): ?reader=tesseract measures it, for the baseline, and says so.
{
  const ctx = await h.browser.newContext({ viewport: { width: 390, height: 844 } });
  await stubNetwork(ctx, h.origin);
  const { page } = await open(ctx, '?samples=1&passes=1&camera=0&reader=tesseract');
  const r = await runIt(page);
  const ok = r.scans.length === 2 && r.scans.every((x) => !x.error && x.engine === 'tesseract' && x.ms > 0 && x.read > 0 && x.right);
  const shown = await page.textContent('#out');
  t.check('?reader=tesseract: the Tesseract reader measured and named; PP-OCR-only tests skipped', ok && r.steps.reader.engine === 'tesseract' && r.steps.reader.forced === 'tesseract' && r.steps.device.wasmSimd === true && /PP-OCR/.test(r.steps.wholeCards.skipped) && /PP-OCR/.test(r.steps.restart.skipped) && r.steps.camera.skipped && /Scans \(text reader: tesseract\)/.test(shown), JSON.stringify({ scans: r.scans, reader: r.steps.reader, whole: r.steps.wholeCards }));
  await ctx.close();
}

// 4) Hidden: not linked from the app, but published with it.
{
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const pages = fs.readFileSync(path.join(root, '.github/workflows/pages.yml'), 'utf8');
  const copyLine = pages.split('\n').find((x) => /cp -r index\.html/.test(x)) || '';
  t.check('bench.html is not linked from the app, and the Pages workflow publishes it', !/bench/.test(html) && /\bbench\.html\b/.test(copyLine) && /\bbench-page\.js\b/.test(copyLine), copyLine.trim());
}

const errors = h.errors().filter((x) => !/Failed to load resource|404/.test(x));
t.check('no page errors', !errors.length, errors.join('\n'));
await h.close();
t.done();
