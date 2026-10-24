// End-to-end check of stamp detection: a stamp on the artwork (set logo, 1st Edition,
// Play! Pokémon) must pre-select that version in the result sheet, and a card without
// one must keep the plain version. Runs the real app + real Tesseract OCR.
//   CHROMIUM_PATH=/opt/pw-browsers/chromium node tests/e2e-stamps.mjs
// Real photos (kept out of the repo) can be checked too, with the version they should get:
//   STAMP_PHOTOS="/path/aurorus.jpg=Set Logo Stamp" node tests/e2e-stamps.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, reporter, results, CARDS, stubNetwork } from './harness.mjs';
import { makePhoto, PHOTOS } from './photo-helpers.mjs';
import { makeStampedCard } from './stamp-helpers.mjs';

const h = await startHarness();
const t = reporter();
// Log every message to the OCR worker (see section 5).
await h.context.addInitScript(() => {
  window.__ocrLog = [];
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (msg, ...rest) {
    if (msg?.action === 'setParameters') window.__ocrLog.push(`P${msg.payload.params.tessedit_pageseg_mode}`);
    else if (msg?.action === 'recognize') window.__ocrLog.push('R');
    return post.call(this, msg, ...rest);
  };
});
const page = await h.newPage();

/** Upload a picture into the app and read the version the sheet picked. */
async function scan(buf, label, mimeType = 'image/png') {
  const started = Date.now();
  await page.setInputFiles('#file-input-library', { name: `${label}.${mimeType === 'image/png' ? 'png' : 'jpg'}`, mimeType, buffer: buf });
  try {
    await page.waitForSelector('#sheet:not([hidden]) .detail-name', { timeout: 120000 });
    // A scan's artwork is read for stamps once the sheet shows a card that comes stamped.
    await page.waitForFunction(() => document.querySelector('.headline-price')?.textContent.trim() && !document.querySelector('.variant-reason.checking'), null, { timeout: 20000 });
  } catch {
    console.log(h.logs.slice(-20).join('\n'));
    console.log('status:', await page.textContent('#scan-status'));
  }
  const got = await page.evaluate(() => ({
    name: document.querySelector('.detail-name')?.textContent,
    version: document.querySelector('.variant-chips .chip.active')?.firstChild?.textContent,
    price: document.querySelector('.headline-price')?.textContent,
    source: document.querySelector('.headline-source')?.textContent,
    img: document.querySelector('.detail-img')?.src,
    reason: document.querySelector('.variant-reason')?.textContent || '',
    found: !!document.querySelector('.variant-reason.found'),
    art: /ARTWORK:\n([\s\S]*?)(\n\n[A-Z ]+:|$)/.exec(document.querySelector('#debug')?.textContent || '')?.[1] || '',
  }));
  got.seconds = ((Date.now() - started) / 1000).toFixed(1);
  // Screenshot with the versions and the explanation in view.
  await page.evaluate(() => document.querySelector('.variant-chips')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300); // let the sheet's slide-in finish
  await page.screenshot({ path: path.join(results, `stamps-${label}.png`) });
  await page.click('.sheet-close');
  return got;
}

const summary = (g) => `${g.name} | ${g.version} | ${g.price} | reason="${g.reason}" | art="${g.art.replace(/\s+/g, ' ').slice(0, 100)}"`;

// 1) Flat card pictures (like a camera guide crop).
const flat = [
  { label: 'set-logo', card: 'aurorus', stamp: 'set-logo', version: 'Set Logo Stamp', price: '$32.04', says: 'Perfect Order set logo', img: '685559' },
  { label: '1st-edition', card: 'baseCharizard', stamp: '1st-edition', version: '1st Edition Shadowless Holo', price: '$3,730.40', says: '1st Edition' },
  { label: 'play-pokemon', card: 'charizardEx', stamp: 'player-rewards-program', version: 'Holo Play! Pokémon Stamp', price: '$19.82', says: 'Play! Pokémon' },
];
for (const c of flat) {
  const png = await makeStampedCard(page, CARDS[c.card], c.stamp);
  fs.writeFileSync(path.join(results, `stamps-${c.label}-card.png`), png);
  const got = await scan(png, c.label);
  const ok = got.version === c.version && got.price === c.price && got.found && got.reason.includes(c.says) && (!c.img || got.img.includes(c.img));
  t.check(`${c.label} stamp picks "${c.version}" (${got.seconds}s)`, ok, summary(got));
}

// 2) No stamp: the plain version, with a pointer to the stamped one.
{
  const got = await scan(await makeStampedCard(page, CARDS.aurorus, null), 'no-stamp');
  const ok = got.version === 'Holo' && got.price === '$0.15' && !got.found && /also comes as Set Logo Stamp/.test(got.reason);
  t.check(`no stamp keeps Holo $0.15 and mentions the stamped version (${got.seconds}s)`, ok, summary(got));
}

// 2b) A scan from the app reads the artwork only once the sheet shows a card that comes
// stamped (it takes about a second on a phone): never for Mewtwo ex 30th, printed unstamped.
{
  const log = await page.evaluate(() => window.__ocrLog.length);
  const got = await scan(await makeStampedCard(page, CARDS.mewtwo30th, null), 'never-stamped');
  const reads = await page.evaluate((n) => window.__ocrLog.slice(n).filter((m) => m === 'R').length, log);
  t.check(`a card never printed with a stamp: no artwork read (${reads} OCR passes)`, got.name === 'Mewtwo ex' && !got.art && !got.reason && reads <= 3, `${summary(got)} reads=${reads}`);
}

// 3) Phone photos of the stamped card: toploader + sticker + glare, turned, steep.
for (const setup of ['toploader', 'turned', 'steep']) {
  const png = await makeStampedCard(page, CARDS.aurorus, 'set-logo');
  const photo = await makePhoto(page, CARDS.aurorus, { ...PHOTOS[setup], cardImage: png });
  fs.writeFileSync(path.join(results, `stamps-photo-${setup}.jpg`), photo.buffer);
  const got = await scan(photo.buffer, `photo-${setup}`, 'image/jpeg');
  t.check(`photo (${setup}) of the stamped Aurorus picks Set Logo Stamp (${got.seconds}s)`, got.version === 'Set Logo Stamp' && got.price === '$32.04', summary(got));
}

// 4) Straight through identify() + the same version pick the batch queue uses: stamped
// photos must get the stamped version, unstamped photos must never get a stamp.
{
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const cards = [
    ['aurorus', 'me03-024', 'set-logo', 'Set Logo Stamp'],
    ['baseCharizard', 'base1-4', '1st-edition', '1st Edition Shadowless Holo'],
    ['charizardEx', 'sv03-125', 'player-rewards-program', 'Holo Play! Pokémon Stamp'],
  ];
  const plainVersion = { aurorus: 'Holo', baseCharizard: 'Holo', charizardEx: 'Holo' };
  let stampedOk = 0;
  let stampedN = 0;
  const falseStamps = [];
  const misses = [];
  const n = Number(process.env.SWEEP || 8);
  for (let i = 0; i < n; i++) {
    const [card, id, stamp, version] = pick(cards);
    const withStamp = i % 2 === 0;
    const spec = {
      background: pick(['carpet', 'wood', 'table']),
      rotate: (rnd() * 2 - 1) * 12,
      tilt: rnd() * 15,
      fill: 0.5 + rnd() * 0.25,
      toploader: rnd() < 0.5,
      sticker: rnd() < 0.3,
      blur: rnd() * 1.2,
      seed: i + 300,
    };
    const png = await makeStampedCard(page, CARDS[card], withStamp ? stamp : null);
    const photo = await makePhoto(page, CARDS[card], { ...spec, cardImage: png });
    const got = await page.evaluate(async ({ b64, want }) => {
      const { identify } = await import('/js/identify.js');
      const { fileToCanvas } = await import('/js/ocr.js');
      const { getCard } = await import('/js/api.js');
      const { variantPrices } = await import('/js/prices.js');
      const { chooseVariant, detectStamps } = await import('/js/stamps.js');
      const canvas = await fileToCanvas(await (await fetch(`data:image/jpeg;base64,${b64}`)).blob());
      const r = await identify(canvas, () => {});
      const card = await getCard(want);
      const rows = variantPrices(card);
      return { id: r.ranked[0]?.card.id, version: rows[chooseVariant(rows, { card, clues: r.clues })]?.label, stamps: detectStamps(r.clues.artText, card), art: r.clues.artText };
    }, { b64: photo.buffer.toString('base64'), want: id });
    const line = `#${i} ${card} ${withStamp ? stamp : 'no stamp'} ${JSON.stringify(spec)} -> ${got.id} "${got.version}" stamps=${got.stamps} art="${got.art.replace(/\s+/g, ' ').slice(0, 80)}"`;
    if (withStamp) {
      stampedN++;
      if (got.version === version) stampedOk++;
      else misses.push(line);
    } else if (got.stamps.length || got.version !== plainVersion[card]) {
      falseStamps.push(line);
    }
    if (process.env.VERBOSE) console.log(line);
  }
  t.check(`random photos: no stamp read on unstamped cards (${n - stampedN} photos)`, !falseStamps.length, falseStamps.join('\n'));
  t.check(`random photos: stamped version picked ${stampedOk}/${stampedN}`, stampedOk >= Math.ceil(stampedN * 0.75), misses.join('\n'));
}

// 5) Scanning a card while the Batch tab processes another photo: both share one OCR
// worker, and a read must never run in the other job's OCR mode (a stamp read in block
// mode loses the stamp). The other photo's name isn't a card, so it is re-read in block mode.
{
  const stamped = await makePhoto(page, CARDS.aurorus, { ...PHOTOS.toploader, cardImage: await makeStampedCard(page, CARDS.aurorus, 'set-logo') });
  const other = await makePhoto(page, { ...CARDS.charizardEx, name: 'Qwyx Zorbat', stage: '' }, { background: 'wood', rotate: 5 });
  const r = await page.evaluate(
    async ({ a, b }) => {
      const { identify } = await import('/js/identify.js');
      const { fileToCanvas } = await import('/js/ocr.js');
      const { getCard } = await import('/js/api.js');
      const { variantPrices } = await import('/js/prices.js');
      const { chooseVariant } = await import('/js/stamps.js');
      const canvas = async (b64) => fileToCanvas(await (await fetch(`data:image/jpeg;base64,${b64}`)).blob());
      const version = async (res) => {
        const card = await getCard('me03-024');
        const rows = variantPrices(card);
        return rows[chooseVariant(rows, { card, clues: res.clues })]?.label;
      };
      const alone = await identify(await canvas(a), () => {});
      const log = window.__ocrLog.length;
      const [both] = await Promise.all([identify(await canvas(a), () => {}), identify(await canvas(b), () => {})]);
      const msgs = window.__ocrLog.slice(log);
      return {
        alone: await version(alone),
        together: await version(both),
        art: [alone.clues.artText, both.clues.artText],
        blockReads: msgs.filter((m) => m === 'P6').length,
        // Every recognize right after its own mode change, never two mode changes in a row.
        interleaved: msgs.some((m, i) => m[0] === 'P' && msgs[i + 1]?.[0] === 'P'),
      };
    },
    { a: stamped.buffer.toString('base64'), b: other.buffer.toString('base64') },
  );
  t.check('scanning while a batch runs: same stamp and version as alone', r.alone === 'Set Logo Stamp' && r.together === r.alone && r.art[0] === r.art[1] && r.blockReads > 0 && !r.interleaved, JSON.stringify(r));
}

// 6) The best match has no stamped version, but the card picked instead does: picking it
// in the result sheet (or in a batch review) still finds the stamp. A Play! Pokémon
// stamped Charizard ex printed as 215/197 matches 215/197 (never stamped) first; the user
// picks 125/197 (comes with that stamp).
{
  const png = await makeStampedCard(page, { ...CARDS.charizardEx, bottomLeft: 'G  OBF EN  215/197 ★' }, 'player-rewards-program');
  await page.setInputFiles('#file-input-library', { name: 'alt-stamp.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => /215\//.test(document.querySelector('.detail-meta')?.textContent || '') && document.querySelector('.headline-price')?.textContent.trim(), null, { timeout: 120000 });
  const first = await page.evaluate(() => document.querySelector('.variant-chips .chip.active')?.firstChild?.textContent || document.querySelector('.detail-meta')?.textContent);
  await page.evaluate(() => [...document.querySelectorAll('#alternates .tile')].find((t) => /125\/197/.test(t.textContent))?.click());
  await page.waitForFunction(() => /125\//.test(document.querySelector('.detail-meta')?.textContent || '') && document.querySelector('.headline-price')?.textContent.trim() && !document.querySelector('.variant-reason.checking'), null, { timeout: 20000 });
  const picked = await page.evaluate(() => ({
    version: document.querySelector('.variant-chips .chip.active')?.firstChild?.textContent,
    reason: document.querySelector('.variant-reason')?.textContent || '',
  }));
  await page.click('.sheet-close');
  // The batch queue picks the version of a re-matched card from the same clues.
  const batch = await page.evaluate(async (b64) => {
    const { identify } = await import('/js/identify.js');
    const { fileToCanvas } = await import('/js/ocr.js');
    const { getCard } = await import('/js/api.js');
    const { variantPrices } = await import('/js/prices.js');
    const { chooseVariant } = await import('/js/stamps.js');
    const r = await identify(await fileToCanvas(await (await fetch(`data:image/png;base64,${b64}`)).blob()), () => {});
    const card = await getCard('sv03-125');
    const rows = variantPrices(card);
    return { top: r.ranked[0]?.card.id, version: rows[chooseVariant(rows, { card, clues: r.clues })]?.label };
  }, png.toString('base64'));
  t.check(
    'picking another match with a stamped version still picks the stamp (sheet and batch)',
    picked.version === 'Holo Play! Pokémon Stamp' && batch.top === 'sv03-215' && batch.version === 'Holo Play! Pokémon Stamp',
    JSON.stringify({ first, picked, batch }),
  );
}

// 7) Card details slow to come or offline: identify() never waits for them (no stamp
// decision hangs on them), and the result sheet's request shares the download that
// identify() started for the best match. A fresh browser profile, so nothing is cached.
{
  const ctx = await h.browser.newContext({ viewport: { width: 390, height: 844 } });
  await stubNetwork(ctx, h.origin);
  const p2 = await ctx.newPage();
  p2.on('pageerror', (e) => h.logs.push(`pageerror: ${e.message}`));
  let mode = 'ok';
  const asked = [];
  await p2.route(/https:\/\/api\.tcgdex\.net\/v2\/en\/cards\/.+/, async (route) => {
    asked.push(new URL(route.request().url()).pathname.split('/').pop());
    if (mode === 'offline') return route.abort('internetdisconnected');
    if (mode === 'slow') await new Promise((r) => setTimeout(r, 4000));
    return route.fallback();
  });
  await p2.goto(`${h.origin}/index.html`);
  await p2.waitForFunction(() => window.cardScanner?.catalog?.index, null, { timeout: 30000 });
  const png = (await makeStampedCard(p2, CARDS.aurorus, null)).toString('base64');
  const run = (b64) =>
    p2.evaluate(async (b64) => {
      const { identify } = await import('/js/identify.js');
      const { fileToCanvas } = await import('/js/ocr.js');
      const { getCard } = await import('/js/api.js');
      const canvas = await fileToCanvas(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const t0 = performance.now();
      const r = await identify(canvas, () => {});
      const ms = performance.now() - t0;
      // What the result sheet does next.
      const card = await getCard(r.ranked[0].card.id).catch(() => null);
      return { ms: Math.round(ms), top: r.ranked[0]?.card.id, price: !!card };
    }, b64);
  await run((await makeStampedCard(p2, CARDS.mewtwo30th, null)).toString('base64')); // warm-up: OCR engine, JIT
  mode = 'offline';
  const offline = await run(png);
  mode = 'slow';
  const before = asked.length;
  const slow = await run(png);
  slow.requests = asked.length - before;
  mode = 'ok';
  const cached = await run(png); // details now on the device: no request at all
  const extra = Math.max(offline.ms, slow.ms) - cached.ms;
  t.check(
    `slow or offline card details don't hold up identify() (+${extra} ms), one download shared`,
    offline.top === 'me03-024' && slow.top === 'me03-024' && slow.price && cached.price && extra < 1000 && slow.requests === 1,
    JSON.stringify({ offline, slow, cached, asked }),
  );
  await ctx.close();
}

// 7b) Details looked up only to rank a scan: not saved on the device (only the card shown
// is), not retried when the server can't be reached, and not asked for at all when the
// phone says it's offline. A fresh browser profile, so nothing is cached.
{
  const ctx = await h.browser.newContext({ viewport: { width: 390, height: 844 } });
  await stubNetwork(ctx, h.origin);
  const p3 = await ctx.newPage();
  p3.on('pageerror', (e) => h.logs.push(`pageerror: ${e.message}`));
  let unreachable = false;
  const asked = [];
  await p3.route(/https:\/\/api\.tcgdex\.net\/v2\/en\/cards\/.+/, (route) => {
    asked.push(decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()));
    return unreachable ? route.abort('internetdisconnected') : route.fallback();
  });
  await p3.goto(`${h.origin}/index.html`);
  await p3.waitForFunction(() => window.cardScanner?.catalog?.index, null, { timeout: 30000 });
  // Name only (no number): several printings are close, so several are looked up.
  const card = async (spec) => (await makeStampedCard(p3, spec, null)).toString('base64');
  const run = (b64, { offline = false, show = false } = {}) =>
    p3.evaluate(
      async ({ b64, offline, show }) => {
        if (offline) Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
        const { identify } = await import('/js/identify.js');
        const { fileToCanvas } = await import('/js/ocr.js');
        const { getCard } = await import('/js/api.js');
        const r = await identify(await fileToCanvas(await (await fetch(`data:image/png;base64,${b64}`)).blob()), () => {});
        if (show) await getCard(r.ranked[0].card.id); // what the result sheet does
        delete navigator.onLine;
        await new Promise((res) => setTimeout(res, 300)); // let any save finish
        const saved = await new Promise((resolve) => {
          const req = indexedDB.open('pokecard-scanner');
          req.onsuccess = () => {
            const q = req.result.transaction('kv').objectStore('kv').getAllKeys();
            q.onsuccess = () => resolve(q.result.filter((k) => String(k).startsWith('card:')).map((k) => k.slice(5)));
          };
        });
        return { top: r.ranked[0]?.card.id, unchecked: r.ranked.filter((x) => x.unchecked).length, saved };
      },
      { b64, offline, show },
    );
  const base = await card({ ...CARDS.baseCharizard, bottomRight: '' });
  const online = await run(base);
  const onlineAsked = [...asked];
  const shown = await run(base, { show: true });
  unreachable = true;
  let mark = asked.length;
  const down = await run(await card({ ...CARDS.baseCharizard, name: 'Pikachu', hp: '40 HP', evolves: '', attack: 'Thunder Jolt', bottomRight: '' }));
  const downAsked = asked.slice(mark);
  unreachable = false;
  mark = asked.length;
  const off = await run(await card({ ...CARDS.aurorus, bottomLeft: '' }), { offline: true });
  const offAsked = asked.slice(mark);
  t.check(
    'details looked up to rank a scan: kept in memory only, asked once, not at all offline',
    onlineAsked.length >= 2 &&
      !online.saved.length &&
      shown.saved.join() === shown.top &&
      asked.filter((id) => id === shown.top).length === 1 &&
      downAsked.length >= 2 &&
      new Set(downAsked).size === downAsked.length &&
      down.unchecked >= 2 &&
      !offAsked.length &&
      /^me03-/.test(off.top),
    JSON.stringify({ onlineAsked, online, shown, downAsked, down, offAsked, off }),
  );
  await ctx.close();
}

// 8) Optional real photos: STAMP_PHOTOS="/abs/a.jpg=Set Logo Stamp,/abs/b.jpg=Holo".
for (const item of (process.env.STAMP_PHOTOS || '').split(',').filter(Boolean)) {
  const [file, version] = item.split('=');
  const got = await scan(fs.readFileSync(file), `real-${path.basename(file, path.extname(file))}`, 'image/jpeg');
  t.check(`real photo ${path.basename(file)} picks "${version}" (${got.seconds}s)`, got.version === version, summary(got));
}

const errors = h.errors();
t.check('no page errors', !errors.length, errors.join('\n'));
await h.close();
t.done();
