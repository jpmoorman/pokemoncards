// End-to-end check of stamp detection: a stamp on the artwork (set logo, 1st Edition,
// Play! Pokémon) must pre-select that version in the result sheet, and a card without
// one must keep the plain version. Runs the real app + real Tesseract OCR.
//   CHROMIUM_PATH=/opt/pw-browsers/chromium node tests/e2e-stamps.mjs
// Real photos (kept out of the repo) can be checked too, with the version they should get:
//   STAMP_PHOTOS="/path/aurorus.jpg=Set Logo Stamp" node tests/e2e-stamps.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, reporter, results, CARDS } from './harness.mjs';
import { makePhoto, PHOTOS } from './photo-helpers.mjs';
import { makeStampedCard } from './stamp-helpers.mjs';

const h = await startHarness();
const t = reporter();
const page = await h.newPage();

/** Upload a picture into the app and read the version the sheet picked. */
async function scan(buf, label, mimeType = 'image/png') {
  const started = Date.now();
  await page.setInputFiles('#file-input-library', { name: `${label}.${mimeType === 'image/png' ? 'png' : 'jpg'}`, mimeType, buffer: buf });
  try {
    await page.waitForSelector('#sheet:not([hidden]) .detail-name', { timeout: 120000 });
    await page.waitForFunction(() => document.querySelector('.headline-price')?.textContent.trim(), null, { timeout: 20000 });
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

// 5) Optional real photos: STAMP_PHOTOS="/abs/a.jpg=Set Logo Stamp,/abs/b.jpg=Holo".
for (const item of (process.env.STAMP_PHOTOS || '').split(',').filter(Boolean)) {
  const [file, version] = item.split('=');
  const got = await scan(fs.readFileSync(file), `real-${path.basename(file, path.extname(file))}`, 'image/jpeg');
  t.check(`real photo ${path.basename(file)} picks "${version}" (${got.seconds}s)`, got.version === version, summary(got));
}

const errors = h.errors();
t.check('no page errors', !errors.length, errors.join('\n'));
await h.close();
t.done();
