// The text reader itself: PP-OCR in its worker on the normal path (no Tesseract download),
// Tesseract as the fallback where PP-OCR can't run (no WebAssembly SIMD, or a runtime that
// won't start), started in the background when the app opens, its memory bounded, stopped at
// once in the background, restarted after a read that failed or never came back.
//   CHROMIUM_PATH=/opt/pw-browsers/chromium node tests/e2e-ocr.mjs
import { startHarness, reporter, CARDS, makeCard, stubNetwork } from './harness.mjs';
import { makePhoto, PHOTOS } from './photo-helpers.mjs';
import { makeStampedCard } from './stamp-helpers.mjs';

const h = await startHarness();
const t = reporter();

/** A fresh browser profile (nothing cached) with its requests to the app logged. */
async function freshPage(init, setup) {
  const ctx = await h.browser.newContext({ viewport: { width: 390, height: 844 } });
  await stubNetwork(ctx, h.origin);
  // When the reader's worker was asked to start (ocr.js posts it 'init'), and every toast shown.
  await ctx.addInitScript(() => {
    window.__toasts = [];
    const seen = new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.classList?.contains('toast') && window.__toasts.push(n.textContent))));
    document.addEventListener('DOMContentLoaded', () => seen.observe(document.body, { childList: true }));
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

/** identify() on a PNG (or JPEG) in the page. */
const identifyIn = (page, png) =>
  page.evaluate(async ([b64, type]) => {
    const { identify } = await import('/js/identify.js');
    const { fileToCanvas } = await import('/js/ocr.js');
    const canvas = await fileToCanvas(await (await fetch(`data:${type};base64,${b64}`)).blob());
    const r = await identify(canvas, () => {});
    const toast = (window.__toasts || []).join(' | ');
    return { id: r.ranked[0]?.card.id, engine: r.debug.engine, fallback: r.debug.fallback, toast, name: r.clues.nameBest, number: r.clues.numbers[0]?.text, art: r.clues.artText };
  }, [png.toString('base64'), png[0] === 0xff ? 'image/jpeg' : 'image/png']);

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
  t.check('without WebAssembly SIMD the Tesseract fallback reads; no PP-OCR download', r.engine === 'tesseract' && r.fallback === 'no WebAssembly SIMD' && !/text reader/.test(r.toast) && r.id === 'sv03-125' && !asked.some(ppocr), JSON.stringify({ r, ppocr: asked.filter(ppocr) }));
  // The fallback shares finding the card, which areas to read, which way up and the number
  // parsing with the PP-OCR path: a few phone photos (as in e2e-photo and e2e-stamps), and a
  // stamped card whose stamp picks the version.
  const photos = [
    ['turned', 'aurorus', 'me03-024', PHOTOS.turned],
    ['toploader', 'charizardEx', 'sv03-125', PHOTOS.toploader],
    ['sideways', 'baseCharizard', 'base1-4', { seed: 3, fill: 0.45, rotate: 90, background: 'table' }],
  ];
  const got = [];
  for (const [label, card, id, spec] of photos) got.push([label, id, await identifyIn(page, (await makePhoto(page, CARDS[card], spec)).buffer)]);
  t.check('the Tesseract fallback identifies photos: turned, in a toploader, sideways', got.every(([, id, x]) => x.id === id && x.engine === 'tesseract'), JSON.stringify(got.map(([l, , x]) => [l, x.id, x.name, x.number])));
  const stamped = (await makePhoto(page, CARDS.aurorus, { ...PHOTOS.toploader, cardImage: await makeStampedCard(page, CARDS.aurorus, 'set-logo') })).buffer;
  const version = await page.evaluate(async (b64) => {
    const { identify } = await import('/js/identify.js');
    const { fileToCanvas } = await import('/js/ocr.js');
    const { getCard } = await import('/js/api.js');
    const { variantPrices } = await import('/js/prices.js');
    const { chooseVariant } = await import('/js/stamps.js');
    const r = await identify(await fileToCanvas(await (await fetch(`data:image/jpeg;base64,${b64}`)).blob()), () => {});
    const card = await getCard(r.ranked[0]?.card.id);
    const rows = variantPrices(card);
    return { id: card.id, engine: r.debug.engine, version: rows[chooseVariant(rows, { card, clues: r.clues })]?.label };
  }, stamped.toString('base64'));
  t.check('the Tesseract fallback reads a set-logo stamp: Set Logo Stamp picked', version.id === 'me03-024' && version.engine === 'tesseract' && version.version === 'Set Logo Stamp', JSON.stringify(version));
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
  // Not silently: the app says so once, and the scan's raw text says why.
  t.check('a reader that cannot start falls back to Tesseract, and the app says so', r.engine === 'tesseract' && r.id === 'base1-4' && /no module workers/.test(r.fallback) && /faster text reader couldn't start/.test(r.toast), JSON.stringify(r));
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

// 7) The reader's life: in the background it is stopped at once (a phone may freeze a hidden
// page's timers), but not during a scan; a read that fails in the runtime, or never comes
// back, gets a fresh worker for the next scan, and the scan says to try again.
{
  const { ctx, page } = await freshPage(() => {
    Object.assign(window, { __inits: 0, __terms: 0, __breakRead: false, __dropReads: false });
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (msg, ...rest) {
      if (msg?.type === 'init') window.__inits++;
      if (msg?.type === 'read' && window.__dropReads) return undefined; // a worker that never answers
      if (msg?.type === 'read' && window.__breakRead) {
        window.__breakRead = false;
        return post.call(this, { ...msg, image: null }, ...rest); // the read throws in the worker
      }
      return post.call(this, msg, ...rest);
    };
    const term = Worker.prototype.terminate;
    Worker.prototype.terminate = function () {
      window.__terms++;
      return term.call(this);
    };
    window.__setHidden = (on) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => on });
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
  await page.waitForFunction(() => import('/js/ocr.js').then((m) => m.getWorker()).then((r) => r.kind === 'ppocr'), null, { timeout: 60000 });
  const png = (await makeCard(page, CARDS.aurorus)).toString('base64');
  const counts = () => page.evaluate(() => ({ inits: window.__inits, terms: window.__terms }));
  const scanIn = (opts = {}) =>
    page.evaluate(
      async ([b64, opts]) => {
        const { identify } = await import('/js/identify.js');
        const { fileToCanvas } = await import('/js/ocr.js');
        const canvas = await fileToCanvas(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const t0 = performance.now();
        const run = identify(canvas, () => {}).then((r) => ({ id: r.ranked[0]?.card.id }), (e) => ({ error: e.message }));
        if (opts.hideAfter != null) setTimeout(() => window.__setHidden(true), opts.hideAfter);
        const r = await run;
        // Right after the scan: was the worker let go at once?
        return { ...r, secs: Math.round((performance.now() - t0) / 1000), termsAtEnd: window.__terms };
      },
      [png, opts],
    );
  const c0 = await counts();
  await page.evaluate(() => window.__setHidden(true));
  await page.waitForTimeout(300);
  const c1 = await counts();
  await page.evaluate(() => window.__setHidden(false));
  // Sent to the background during a scan (here while the reader starts again): it finishes,
  // then the worker is stopped.
  const mid = await scanIn({ hideAfter: 50 });
  await page.evaluate(() => window.__setHidden(false));
  t.check('in the background the reader stops at once; a scan going on finishes first, then it stops', c1.terms === c0.terms + 1 && mid.id === 'me03-024' && mid.termsAtEnd === c1.terms + 1, JSON.stringify({ c0, c1, mid }));

  const c2 = await counts();
  await page.evaluate(() => (window.__breakRead = true));
  const broken = await scanIn();
  const cb = await counts();
  const after = await scanIn();
  const c3 = await counts();
  t.check('a read that fails in the runtime: its worker is stopped, the next scan gets a fresh one and reads right', !!broken.error && cb.terms === c2.terms + 1 && after.id === 'me03-024' && c3.inits === cb.inits + 1, JSON.stringify({ broken, after, c2, cb, c3 }));

  await page.evaluate(() => (window.__dropReads = true));
  const stuck = await scanIn();
  await page.evaluate(() => (window.__dropReads = false));
  const again = await scanIn();
  t.check(`a read that never comes back: the scan says to try again (${stuck.secs}s), the next one reads right`, /^The text reader stopped\. Try again\.$/.test(stuck.error || '') && stuck.secs <= 50 && again.id === 'me03-024', JSON.stringify({ stuck, again }));
  await ctx.close();
}

const errors = h.errors().filter((l) => !/Failed to load resource|internetdisconnected|net::ERR/.test(l));
t.check('no page errors', !errors.length, errors.join('\n'));
await h.close();
t.done();
