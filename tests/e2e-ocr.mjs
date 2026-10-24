// The text reader itself: PP-OCR in its worker on the normal path (no Tesseract download),
// Tesseract as the fallback where PP-OCR can't run (no WebAssembly SIMD: iOS before 16.4),
// started in the background when the app opens, its memory bounded, stopped when idle.
//   CHROMIUM_PATH=/opt/pw-browsers/chromium node tests/e2e-ocr.mjs
import { startHarness, reporter, CARDS, makeCard, stubNetwork } from './harness.mjs';

const h = await startHarness();
const t = reporter();

/** A fresh browser profile (nothing cached) with its requests to the app logged. */
async function freshPage(init, setup) {
  const ctx = await h.browser.newContext({ viewport: { width: 390, height: 844 } });
  await stubNetwork(ctx, h.origin);
  // When the reader's worker was asked to start (ocr.js posts it 'init').
  await ctx.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (msg, ...rest) {
      if (msg?.type === 'init') window.__readerStarted ??= performance.now();
      return post.call(this, msg, ...rest);
    };
  });
  if (init) await ctx.addInitScript(init);
  await setup?.(ctx);
  const page = await ctx.newPage();
  const asked = [];
  ctx.on('request', (r) => asked.push(new URL(r.url()).pathname));
  page.on('pageerror', (e) => h.logs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && h.logs.push(`error: ${m.text()}`));
  await page.goto(`${h.origin}/index.html`);
  await page.waitForFunction(() => window.cardScanner?.catalog?.index, null, { timeout: 30000 });
  return { ctx, page, asked };
}

/** identify() on a PNG in the page. */
const identifyIn = (page, png) =>
  page.evaluate(async (b64) => {
    const { identify } = await import('/js/identify.js');
    const { fileToCanvas } = await import('/js/ocr.js');
    const canvas = await fileToCanvas(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const r = await identify(canvas, () => {});
    return { id: r.ranked[0]?.card.id, engine: r.debug.engine, name: r.clues.nameBest, number: r.clues.numbers[0]?.text, art: r.clues.artText };
  }, png.toString('base64'));

const tesseract = (p) => /tesseract/.test(p);
const ppocr = (p) => /^\/(vendor|models)\//.test(p);

// 1) Normal path: the app opens, the reader starts in the background (models downloaded
// before any scan), a scan reads with PP-OCR, and nothing of Tesseract is downloaded.
{
  const { ctx, page, asked } = await freshPage();
  const warmed = await page
    .waitForFunction(() => window.__readerStarted != null, null, { timeout: 20000 })
    .then(() => true, () => false);
  // Its files come in before any scan.
  const loaded = await page
    .waitForFunction(() => import('/js/ocr.js').then((m) => m.getWorker()).then((r) => r.kind), null, { timeout: 30000 })
    .then((x) => x.jsonValue(), () => null);
  const r = await identifyIn(page, await makeCard(page, CARDS.aurorus));
  t.check('app open starts the reader in the background; a scan reads with PP-OCR, no Tesseract download', warmed && loaded === 'ppocr' && r.engine === 'ppocr' && r.id === 'me03-024' && !asked.some(tesseract), JSON.stringify({ warmed, loaded, r, tesseract: asked.filter(tesseract), ppocr: asked.filter(ppocr) }));

  // 2) Memory: six whole-card reads (the biggest text search, 960 px) keep the runtime's
  // memory within 120 MB.
  const mem = await page.evaluate(async () => {
    const { readText, readerStats } = await import('/js/ocr.js');
    const card = document.createElement('canvas');
    [card.width, card.height] = [1000, 1400];
    const g = card.getContext('2d');
    const sizes = [];
    for (let i = 0; i < 6; i++) {
      g.fillStyle = `hsl(${i * 50},40%,85%)`;
      g.fillRect(0, 0, 1000, 1400);
      g.fillStyle = '#111';
      for (let y = 60; y < 1400; y += 44) {
        g.font = `${18 + ((y / 44) % 4) * 6}px sans-serif`;
        g.fillText(`Line ${y} of card ${i}: Lightning Ball 120 Weakness ×2`, 40 + (y % 90), y);
      }
      const [res] = await readText(card, [{ x: 0, y: 0, w: 1, h: 1, maxSide: 960 }]);
      sizes.push([res.lines.length, (await readerStats()).wasmBytes]);
    }
    return sizes;
  });
  const peak = Math.max(...mem.map((m) => m[1]));
  t.check(`six whole-card reads: runtime memory ${(peak / 2 ** 20).toFixed(1)} MB (at most 120 MB)`, peak > 0 && peak <= 120 * 2 ** 20 && mem.every((m) => m[0] > 10), JSON.stringify(mem));
  await ctx.close();
}

// 3) Fallback: without WebAssembly SIMD (iOS before 16.4) the Tesseract reader scans, and
// the PP-OCR runtime and models are never downloaded.
{
  const noSimd = () => {
    const validate = WebAssembly.validate;
    // The SIMD probes (ocr.js's, and Tesseract's own) fail, as on a phone without SIMD.
    WebAssembly.validate = (bytes) => (bytes.length < 64 && [...bytes].includes(253) ? false : validate(bytes));
  };
  const { ctx, page, asked } = await freshPage(noSimd);
  const r = await identifyIn(page, await makeCard(page, CARDS.charizardEx));
  t.check('without WebAssembly SIMD the Tesseract fallback reads; no PP-OCR download', r.engine === 'tesseract' && r.id === 'sv03-125' && !asked.some(ppocr), JSON.stringify({ r, ppocr: asked.filter(ppocr) }));
  await ctx.close();
}

// 4) A runtime that fails to start (here: the worker can't be created) also falls back.
{
  const { ctx, page } = await freshPage(() => {
    const W = window.Worker;
    window.Worker = function (url, opts) {
      if (String(url).includes('ocr-worker')) throw new Error('no module workers');
      return new W(url, opts);
    };
  });
  const r = await identifyIn(page, await makeCard(page, CARDS.baseCharizard));
  t.check('a reader that cannot start falls back to Tesseract', r.engine === 'tesseract' && r.id === 'base1-4', JSON.stringify(r));
  await ctx.close();
}

// 5) A failed download (offline on the first visit) is not a reason to fall back: the scan
// says to check the connection, and the next one, back online, reads with PP-OCR.
{
  let offline = true;
  const { ctx, page } = await freshPage(null, (c) => c.route(/\/models\//, (r) => (offline ? r.abort('internetdisconnected') : r.fallback())));
  const png = (await makeCard(page, CARDS.aurorus)).toString('base64');
  const first = await page.evaluate(async (b64) => {
    const { readCard, fileToCanvas } = await import('/js/ocr.js');
    const canvas = await fileToCanvas(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    try {
      await readCard(canvas, () => {});
      return 'read';
    } catch (e) {
      return e.message;
    }
  }, png);
  offline = false;
  const again = await identifyIn(page, Buffer.from(png, 'base64'));
  t.check('a failed model download asks to check the connection; the next scan reads with PP-OCR', /connection/.test(first) && again.engine === 'ppocr' && again.id === 'me03-024', JSON.stringify({ first, again }));
  await ctx.close();
}

// 6) Stopped while still starting (the app sent to the background during start-up), then
// started again at once: the new start isn't failed along with the old one, and the scan
// that waited on the stopped start is told to try again (not to check the connection).
{
  const { ctx, page } = await freshPage();
  const png = (await makeCard(page, CARDS.aurorus)).toString('base64');
  const r = await page.evaluate(async () => {
    const ocr = await import('/js/ocr.js');
    ocr.stopReader();
    const first = ocr.getWorker().then((x) => x.kind, (e) => e.message);
    ocr.stopReader();
    const again = ocr.getWorker().then((x) => x.kind, (e) => e.message);
    return { first: await first, again: await again };
  });
  const scan = await identifyIn(page, Buffer.from(png, 'base64'));
  t.check('a reader stopped while starting and started again at once reads with PP-OCR', r.again === 'ppocr' && /try again/i.test(r.first) && scan.engine === 'ppocr' && scan.id === 'me03-024', JSON.stringify({ r, scan }));
  await ctx.close();
}

const errors = h.errors().filter((l) => !/Failed to load resource|internetdisconnected|net::ERR/.test(l));
t.check('no page errors', !errors.length, errors.join('\n'));
await h.close();
t.done();
