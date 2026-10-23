// End-to-end check of scanning whole phone photos: the card has to be found in the
// picture (carpet / wood / table, turned, tilted, in a toploader with a price sticker
// and glare), straightened and identified. Runs the real app + real Tesseract OCR.
//   CHROMIUM_PATH=/opt/pw-browsers/chromium node tests/e2e-photo.mjs
// Extra real photos (kept out of the repo) can be checked too:
//   PHOTOS="/path/aurorus.jpg=me03-024,/path/other.jpg=sv03-125" node tests/e2e-photo.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, reporter, results, CARDS, catalog } from './harness.mjs';
import { makePhoto, PHOTOS, cornerError } from './photo-helpers.mjs';

const h = await startHarness();
const t = reporter();
const page = await h.newPage();

/** Run detect.js on a JPEG in the page: { corners, score, ms } or null. */
async function detectIn(buf) {
  return page.evaluate(async (b64) => {
    const { detectCard } = await import('/js/detect.js');
    const { fileToCanvas } = await import('/js/ocr.js');
    const blob = await (await fetch(`data:image/jpeg;base64,${b64}`)).blob();
    const canvas = await fileToCanvas(blob, 4100);
    const t0 = performance.now();
    const found = detectCard(canvas);
    const ms = performance.now() - t0;
    return found && { corners: found.corners, score: found.score, ms };
  }, buf.toString('base64'));
}

/** Upload a photo into the app and read what the result sheet shows. */
async function scan(buf, label) {
  const started = Date.now();
  await page.setInputFiles('#file-input-library', { name: `${label}.jpg`, mimeType: 'image/jpeg', buffer: buf });
  try {
    await page.waitForSelector('#sheet:not([hidden]) #confidence', { timeout: 120000 });
    await page.waitForFunction(() => document.querySelector('.detail-name') || /No match/.test(document.querySelector('#confidence')?.textContent), null, { timeout: 30000 });
  } catch {
    console.log(h.logs.slice(-20).join('\n'));
    console.log('status:', await page.textContent('#scan-status'));
  }
  const got = await page.evaluate(() => ({
    name: document.querySelector('.detail-name')?.textContent,
    set: document.querySelector('.set-name')?.textContent,
    meta: document.querySelector('.detail-meta')?.textContent,
    conf: document.querySelector('#confidence')?.textContent,
    clueName: document.querySelector('#clue-name')?.value,
    clueNum: document.querySelector('#clue-number')?.value,
    debug: document.querySelector('#debug')?.textContent,
  }));
  got.seconds = ((Date.now() - started) / 1000).toFixed(1);
  await page.screenshot({ path: path.join(results, `photo-${label}-result.png`) });
  await page.click('.sheet-close');
  return got;
}

const SETS = { charizardEx: 'Obsidian Flames', baseCharizard: 'Base Set', mewtwo30th: '30th Celebration', aurorus: 'Perfect Order' };
const NAMES = { charizardEx: 'Charizard ex', baseCharizard: 'Charizard', mewtwo30th: 'Mewtwo ex', aurorus: 'Aurorus' };
const cases = [
  ['charizardEx', 'toploader'],
  ['charizardEx', 'steep'],
  ['baseCharizard', 'turned'],
  ['baseCharizard', 'toploader'],
  ['aurorus', 'toploader'],
  ['aurorus', 'steep'],
  ['aurorus', 'turned'],
  ['mewtwo30th', 'flat'],
];

// 1) Finding the card: corners within 3% of the card's width of the truth. On a plain
// light table a silver border is barely visible, so an edge may land on the card's
// inner frame (~4% in); the OCR crop margin absorbs that.
for (const [card, setup] of cases) {
  const label = `${card}-${setup}`;
  const photo = await makePhoto(page, CARDS[card], PHOTOS[setup]);
  fs.writeFileSync(path.join(results, `photo-${label}.jpg`), photo.buffer);
  const found = await detectIn(photo.buffer);
  const err = cornerError(found?.corners, photo.corners);
  const tolerance = PHOTOS[setup].background === 'table' ? 0.05 : 0.03;
  t.check(`finds the card: ${label}`, err <= tolerance, `corner error ${(err * 100).toFixed(1)}% of card width, ${found ? Math.round(found.ms) : '-'} ms`);
}

// Big phone photo (4032×3024 class): detection must stay fast.
{
  const photo = await makePhoto(page, CARDS.aurorus, { ...PHOTOS.toploader, width: 3024, height: 4032, seed: 7 });
  await detectIn(photo.buffer); // warm-up (JIT)
  const found = await detectIn(photo.buffer);
  const err = cornerError(found?.corners, photo.corners);
  t.check('finds the card in a 3024×4032 photo quickly', err <= 0.03 && found.ms < 400, `error ${(err * 100).toFixed(1)}%, ${Math.round(found?.ms)} ms`);
}

// No card at all: nothing found (and no crash).
{
  const photo = await makePhoto(page, CARDS.aurorus, { noCard: true, background: 'carpet' });
  const found = await detectIn(photo.buffer);
  t.check('no card in the picture -> nothing found', !found, JSON.stringify(found));
}

// 2) Full scans through the app.
for (const [card, setup] of cases) {
  const label = `${card}-${setup}`;
  const buf = fs.readFileSync(path.join(results, `photo-${label}.jpg`));
  const got = await scan(buf, label);
  const ok = got.name === NAMES[card] && got.set === SETS[card];
  t.check(`identifies ${label} (${got.seconds}s)`, ok, `read name="${got.clueName}" number="${got.clueNum}" -> ${got.name} | ${got.set} | ${got.meta} | ${got.conf}`);
  if (!ok || process.env.VERBOSE) console.log(got.debug);
}

// 3) Random photos (fixed seed): any background, 0–15° turn, 0–20° tilt, toploader,
// sticker, glare, blur. Straight through identify(); SWEEP=n for a bigger run.
{
  const n = Number(process.env.SWEEP || 10);
  const want = { charizardEx: 'sv03-125', baseCharizard: 'base1-4', mewtwo30th: '30th-157', aurorus: 'me03-024' };
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  let ok = 0;
  const misses = [];
  for (let i = 0; i < n; i++) {
    const spec = {
      background: pick(['carpet', 'wood', 'table']),
      rotate: (rnd() * 2 - 1) * 15,
      tilt: rnd() * 20,
      fill: 0.4 + rnd() * 0.35,
      offset: { x: (rnd() - 0.5) * 0.12, y: (rnd() - 0.5) * 0.1 },
      toploader: rnd() < 0.5,
      sticker: rnd() < 0.4,
      glare: rnd() < 0.5 ? { at: 0.2 + rnd() * 0.6, angle: (rnd() * 2 - 1) * 60, strength: 0.25 + rnd() * 0.3, width: 0.06 + rnd() * 0.1 } : null,
      blur: rnd() * 1.5,
      seed: i + 100,
    };
    const card = pick(Object.keys(want));
    const photo = await makePhoto(page, CARDS[card], spec);
    const got = await page.evaluate(async (b64) => {
      const { identify } = await import('/js/identify.js');
      const { fileToCanvas } = await import('/js/ocr.js');
      const canvas = await fileToCanvas(await (await fetch(`data:image/jpeg;base64,${b64}`)).blob());
      const r = await identify(canvas, () => {});
      return { id: r.ranked[0]?.card.id, name: r.clues.nameBest, number: r.clues.numbers[0]?.text, detect: r.debug.detect };
    }, photo.buffer.toString('base64'));
    if (got.id === want[card]) ok++;
    else {
      misses.push(`#${i} ${card} ${JSON.stringify(spec)} -> ${got.id} (name "${got.name}", number ${got.number}, ${got.detect})`);
      fs.writeFileSync(path.join(results, `photo-sweep-${i}.jpg`), photo.buffer);
    }
  }
  t.check(`identifies random photos: ${ok}/${n}`, ok >= Math.ceil(n * 0.9), misses.join('\n'));
}

// 4) Optional real photos: PHOTOS="/abs/a.jpg=me03-024,..." (the card must be in the fixture catalog).
for (const item of (process.env.PHOTOS || '').split(',').filter(Boolean)) {
  const [file, expectId] = item.split('=');
  const buf = fs.readFileSync(file);
  const found = await detectIn(buf);
  const got = await scan(buf, `real-${path.basename(file, path.extname(file))}`);
  const want = catalog.cards.find((c) => c.id === expectId);
  const wantSet = want && catalog.sets.find((s) => expectId.startsWith(`${s.id}-`) && expectId.slice(s.id.length + 1) === want.localId);
  const ok = want ? got.name === want.name && got.set === wantSet?.name && got.meta?.startsWith(`#${want.localId}`) : !!got.name;
  t.check(`real photo ${path.basename(file)} is ${expectId || 'a card'} (${got.seconds}s)`, ok, `card ${found ? `found (score ${found.score.toFixed(2)}, ${Math.round(found.ms)} ms)` : 'not found'}; read name="${got.clueName}" number="${got.clueNum}" -> ${got.name} | ${got.set} | ${got.meta} | ${got.conf}`);
  if (!ok || process.env.VERBOSE) console.log(got.debug);
}

const errors = h.errors();
t.check('no page errors', !errors.length, errors.join('\n'));
await h.close();
t.done();
