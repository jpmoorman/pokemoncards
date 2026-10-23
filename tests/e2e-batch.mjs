// End-to-end check of the Batch tab: save photos now, identify them later, review, save.
// Real app + real Tesseract OCR in headless Chromium; network stubbed (see harness.mjs).
//   CHROMIUM_PATH=/opt/pw-browsers/chromium node tests/e2e-batch.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startHarness, makeCard, reporter, results, CARDS } from './harness.mjs';

const h = await startHarness();
const t = reporter();
const page = await h.newPage();
const shot = (p, name) => p.screenshot({ path: path.join(results, `batch-${name}.png`) });

const items = (p = page) =>
  p.$$eval('#batch-list .bitem', (els) =>
    els.map((e) => ({
      status: ['waiting', 'processing', 'matched', 'nomatch', 'error'].find((s) => e.classList.contains(s)),
      flag: e.classList.contains('flag'),
      name: e.querySelector('.b-name')?.textContent,
      sub: [...e.querySelectorAll('.b-sub')].map((s) => s.textContent).join(' | '),
      price: e.querySelector('.b-price')?.textContent || '',
      tags: e.querySelector('.b-tags')?.textContent || '',
    })),
  );
const stats = (p = page) =>
  p.$$eval('#batch-stats .b-stat', (els) => Object.fromEntries(els.map((e) => [e.querySelector('span').textContent, e.querySelector('b').textContent])));
const thumbsLoaded = (p = page) =>
  p.waitForFunction(() => [...document.querySelectorAll('#batch-list .b-photo img')].every((i) => i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0), null, { timeout: 10000 });
const allDone = (n, p = page) =>
  p.waitForFunction((n) => document.querySelectorAll('#batch-list .bitem').length === n && !document.querySelector('#batch-list .bitem.waiting, #batch-list .bitem.processing'), n, { timeout: 180000 });
const batchKeys = (p = page) =>
  p.evaluate(
    () =>
      new Promise((resolve) => {
        const r = indexedDB.open('pokecard-scanner');
        r.onsuccess = () => {
          const q = r.result.transaction('kv').objectStore('kv').getAllKeys();
          q.onsuccess = () => {
            r.result.close();
            resolve(q.result.filter((k) => String(k).startsWith('batch:')));
          };
        };
      }),
  );
const png = async (spec) => ({ name: 'card.png', mimeType: 'image/png', buffer: await makeCard(page, spec) });

// ---- empty state ----
await page.click('.tab[data-view="batch"]');
await page.waitForSelector('.b-empty');
const empty = await page.textContent('.b-empty');
t.check('empty state explains how to batch', /Batch mode/.test(empty) && /Library/.test(empty) && /Process all/.test(empty), empty.slice(0, 80));
await shot(page, 'empty');

// ---- several library photos at once go to the batch, unprocessed ----
await page.click('.tab[data-view="scan"]');
const files = [await png(CARDS.charizardEx), await png(CARDS.baseCharizard), await png(CARDS.aurorus)];
await page.setInputFiles('#file-input-library', files);
await page.waitForFunction(() => document.querySelector('#view-batch.active') && document.querySelectorAll('#batch-list .bitem.waiting').length === 3, null, { timeout: 20000 });
await thumbsLoaded();
let s = await stats();
let badge = await page.textContent('#batch-count');
t.check(
  'library pick of 3 photos queues them without processing; badge says 3',
  s.waiting === '3' && s.identified === '0' && badge === '3' && (await page.isHidden('#sheet')),
  `${JSON.stringify(s)} badge=${badge}`,
);
await shot(page, 'queued');

// ---- process all (and switch tabs mid-way) ----
await page.click('#batch-process');
await page.waitForSelector('#batch-progress');
const prog = await page.textContent('#batch-progress');
t.check('progress shows "Processing n of 3…"', /^Processing [1-3] of 3…$/.test(prog), prog);
await shot(page, 'processing');
await page.click('.tab[data-view="search"]');
await page.waitForTimeout(400);
await page.click('.tab[data-view="batch"]');
await allDone(3);
let got = await items();
const want = [
  ['Charizard ex', 'Obsidian Flames · 125/197', '$5.28'],
  ['Charizard', 'Base Set · 4/102', '$954.65'],
  ['Aurorus', 'Perfect Order · 024/088', '$0.15'],
];
t.check(
  'all three identified with name, set, printed number and USD price',
  want.every(([n, sub, p], i) => got[i]?.status === 'matched' && got[i].name === n && got[i].sub.startsWith(sub) && got[i].price === p),
  JSON.stringify(got),
);
s = await stats();
t.check('header counts and value after processing', s.waiting === '0' && s.identified === '3' && s.value === '$960.08' && (await page.isHidden('#batch-count')), JSON.stringify(s));
t.check('no euros anywhere in the batch', !(await page.textContent('#view-batch')).includes('€'));
await thumbsLoaded();
await shot(page, 'processed');

// ---- survives a reload without re-fetching card data ----
const fetched = [];
page.on('request', (r) => /api\.tcgdex\.net\/v2\/en\/cards\//.test(r.url()) && fetched.push(r.url()));
await page.reload();
await page.click('.tab[data-view="batch"]');
await page.waitForFunction(() => document.querySelectorAll('#batch-list .bitem.matched').length === 3, null, { timeout: 10000 });
const after = await items();
t.check('items and results survive a reload', JSON.stringify(after) === JSON.stringify(got), JSON.stringify(after));
t.check('reload re-fetches no card data', !fetched.length, fetched.join(', '));

// ---- review: pick an alternate card ----
await page.click('#batch-list .bitem:nth-child(1) .b-main');
await page.waitForSelector('#sheet:not([hidden]) .actions .btn:has-text("Use this card")');
const review = await page.evaluate(() => ({ detected: !document.querySelector('#detected').hidden, name: document.querySelector('.detail-name')?.textContent, alts: document.querySelectorAll('#alternates .tile').length }));
t.check('review sheet rebuilt from saved results (clues + alternates)', review.detected && review.name === 'Charizard ex' && review.alts > 0, JSON.stringify(review));
await shot(page, 'review');
await page.click('#alternates .tile:has-text("215/197")');
await page.waitForFunction(() => document.querySelector('.detail-meta')?.textContent.includes('215/197') && document.querySelector('.headline-price')?.textContent === '$23.47', null, { timeout: 10000 });
await page.click('.actions .btn:has-text("Use this card")');
await page.waitForSelector('#sheet', { state: 'hidden' });
got = await items();
t.check('picking an alternate updates the item', got[0].sub.startsWith('Obsidian Flames · 215/197') && got[0].price === '$23.47', JSON.stringify(got[0]));

// ---- review: pick the stamped version ----
await page.click('#batch-list .bitem:nth-child(3) .b-main');
await page.click('.variant-chips .chip:has-text("Set Logo Stamp")');
await page.waitForFunction(() => document.querySelector('.headline-price')?.textContent === '$32.04');
await page.click('.actions .btn:has-text("Use this card")');
await page.waitForSelector('#sheet', { state: 'hidden' });
got = await items();
t.check('picking a version updates the item', got[2].sub.includes('Set Logo Stamp') && got[2].price === '$32.04', JSON.stringify(got[2]));

// Re-opening shows the chosen card and version first, also after a reload.
await page.reload();
await page.click('.tab[data-view="batch"]');
await page.waitForSelector('#batch-list .bitem.matched');
await page.click('#batch-list .bitem:nth-child(3) .b-main');
await page.waitForFunction(() => document.querySelector('.variant-chips .chip.active'));
const reopened = await page.evaluate(() => ({ chip: document.querySelector('.variant-chips .chip.active').textContent, price: document.querySelector('.headline-price').textContent }));
t.check('re-opening an item restores the chosen version', reopened.chip.startsWith('Set Logo Stamp') && reopened.price === '$32.04', JSON.stringify(reopened));
await page.click('.sheet-close');
await page.click('#batch-list .bitem:nth-child(1) .b-main');
await page.waitForFunction(() => document.querySelector('.detail-meta')?.textContent.includes('215/197'), null, { timeout: 10000 });
t.check('re-opening an item shows the picked alternate first', true);
await page.click('.sheet-close');

// ---- large photo ----
await page.click('#batch-list .bitem:nth-child(2) .b-photo');
await page.waitForFunction(() => document.querySelector('.b-viewer-img')?.naturalWidth > 0);
const photo = await page.evaluate(() => ({ w: document.querySelector('.b-viewer-img').naturalWidth, src: document.querySelector('.b-viewer-img').src }));
t.check('tapping a thumbnail shows the original photo large', photo.w >= 1000 && photo.src.startsWith('blob:'), JSON.stringify(photo));
await shot(page, 'photo');
await page.click('.b-viewer .btn:has-text("Close")');

// ---- add all to collection ----
await page.click('#batch-add-all');
const confirm = await page.$('.modal .btn.primary:has-text("Add all")');
if (confirm) await confirm.click();
await page.waitForFunction(() => document.querySelector('#batch-add-all')?.disabled);
got = await items();
t.check('items are marked as in the collection', got.every((i) => i.tags.includes('In collection')), JSON.stringify(got.map((i) => i.tags)));
await shot(page, 'saved');
await page.click('.tab[data-view="collection"]');
const total = await page.textContent('#collection-total');
const count = await page.textContent('#collection-count');
t.check('Saved tab total is correct (23.47 + 954.65 + 32.04)', total === '$1,010.16' && count === '3', `${total} / ${count}`);

// ---- send to trade (entry-only card:action events) ----
await page.click('.tab[data-view="batch"]');
await page.evaluate(() => {
  window.__ev = [];
  document.addEventListener('card:action', (e) => window.__ev.push(e.detail));
});
await page.click('#batch-trade');
await page.click('.modal .btn:has-text("You give")');
await page.waitForSelector('#view-trade.active');
const ev = await page.evaluate(() => window.__ev.map((d) => ({ action: d.action, card: d.card, row: d.row, id: d.entry?.id, usd: d.entry?.price?.currency })));
t.check(
  'Send to trade → You give emits one entry-only trade-give per card and opens Trade',
  ev.length === 3 && ev.every((e) => e.action === 'trade-give' && e.card === null && e.row === null && e.usd === 'USD') && ev.map((e) => e.id).join() === 'sv03-215,base1-4,me03-024',
  JSON.stringify(ev),
);

// ---- batch mode on the Scan tab: the Photo button saves without identifying ----
await page.click('.tab[data-view="scan"]');
await page.click('#btn-mode');
const unreadable = { ...CARDS.charizardEx, stage: '', name: 'Qxwvz Jqk', evolves: '', bottomLeft: '', attack: 'Zzxq Vwq', illus: '' };
await page.setInputFiles('#file-input', await png(unreadable));
await page.waitForFunction(() => document.querySelector('#batch-count')?.textContent === '1');
await page.setInputFiles('#file-input', { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: await makeCard(page, { ...CARDS.aurorus, scale: 3, photo: { fill: 0.72, rotate: 2, blur: 1 } }) });
await page.waitForFunction(() => document.querySelector('#batch-count')?.textContent === '2');
const mode = await page.textContent('#btn-mode');
t.check('batch mode: Photo adds to the queue, nothing is identified', mode === 'Batch mode: On · 2 saved' && (await page.isHidden('#sheet')) && (await page.isVisible('#view-scan.active')), mode);
await page.click('#btn-mode'); // back to single mode
await page.click('.tab[data-view="batch"]');
await thumbsLoaded();
await page.click('#batch-process');
await allDone(5);
got = await items();
s = await stats();
t.check(
  'unreadable card → "No match" flagged to check; phone photo → Aurorus',
  got[3].status === 'nomatch' && got[3].flag && got[4].name === 'Aurorus' && s['to check'] === '1',
  JSON.stringify([got[3], got[4], s]),
);
await shot(page, 'nomatch');

// Fix the unmatched one by hand in the sheet.
await page.click('#batch-list .bitem:nth-child(4) .b-main');
await page.waitForSelector('#sheet:not([hidden]) #clue-form');
await page.fill('#clue-name', 'Charizard');
await page.fill('#clue-number', '4/102');
await page.click('#clue-form button[type="submit"]');
await page.waitForFunction(() => document.querySelector('.detail-name')?.textContent === 'Charizard' && document.querySelector('.actions .btn.wide'), null, { timeout: 10000 });
await page.click('.actions .btn:has-text("Use this card")');
await page.waitForSelector('#sheet', { state: 'hidden' });
got = await items();
s = await stats();
t.check('fixing a "No match" by hand clears the flag', got[3].name === 'Charizard' && got[3].price === '$954.65' && !got[3].flag && s['to check'] === '0', JSON.stringify([got[3], s]));

// ---- remove / clear done ----
await page.click('#batch-list .bitem:nth-child(5) .b-remove');
await page.waitForFunction(() => document.querySelectorAll('#batch-list .bitem').length === 4);
await page.click('#batch-clear-done');
await page.click('.modal .btn.primary:has-text("Remove")');
await page.waitForSelector('.b-empty');
let keys = await batchKeys();
t.check('remove + Clear done delete the photos from storage', keys.join() === 'batch:items', keys.join());

// ---- storage full: clear message, nothing half-saved ----
await page.evaluate(() => {
  const put = IDBObjectStore.prototype.put;
  window.__restorePut = () => (IDBObjectStore.prototype.put = put);
  IDBObjectStore.prototype.put = function (v, k) {
    if (String(k).startsWith('batch:photo')) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    return put.call(this, v, k);
  };
});
await page.setInputFiles('#batch-file-input', [await png(CARDS.aurorus), await png(CARDS.baseCharizard)]);
await page.waitForSelector('.modal p:has-text("out of space")');
const quota = await page.textContent('.modal p');
await shot(page, 'quota');
await page.click('.modal .btn:has-text("OK")');
await page.evaluate(() => window.__restorePut());
keys = await batchKeys();
t.check('storage full → clear message, nothing half-saved', /out of space/.test(quota) && (await page.isVisible('.b-empty')) && keys.join() === 'batch:items', `${quota} | ${keys}`);

// ---- clear all ----
await page.setInputFiles('#batch-file-input', [await png(CARDS.aurorus), await png(CARDS.baseCharizard)]);
await page.waitForFunction(() => document.querySelectorAll('#batch-list .bitem').length === 2);
await page.click('#batch-clear-all');
await page.click('.modal .btn.primary:has-text("Delete all")');
await page.waitForSelector('.b-empty');
keys = await batchKeys();
t.check('Clear all empties the batch and its storage', !keys.length && (await page.isHidden('#batch-count')), keys.join());

// ---- live camera in batch mode (needs ffmpeg) ----
let haveFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  haveFfmpeg = false;
}
if (haveFfmpeg) {
  const cardPng = path.join(results, 'batch-camera-card.png');
  fs.writeFileSync(cardPng, await makeCard(page, CARDS.baseCharizard));
  const y4m = path.join(results, 'batch-camera.y4m');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x3b2f25:s=1080x1920:d=1', '-i', cardPng,
    '-filter_complex', '[1]scale=940:-1[c];[0][c]overlay=(W-w)/2:(H-h)/2', '-frames:v', '5', '-pix_fmt', 'yuv420p', y4m]);
  const cam = await startHarness({
    launchArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`],
    contextOptions: { permissions: ['camera'] },
  });
  const p = await cam.newPage();
  await p.click('#btn-start-camera').catch(() => {});
  await p.waitForSelector('#btn-scan:not([disabled])', { timeout: 15000 });
  await p.click('#btn-mode');
  await p.waitForTimeout(500);
  await p.click('#btn-scan');
  await p.waitForFunction(() => document.querySelector('#batch-count')?.textContent === '1');
  await p.click('#btn-scan');
  await p.waitForFunction(() => document.querySelector('#batch-count')?.textContent === '2');
  await shot(p, 'camera-mode');
  const sheetHidden = await p.isHidden('#sheet');
  await p.click('.tab[data-view="batch"]');
  await thumbsLoaded(p);
  await p.click('#batch-process');
  await allDone(2, p);
  const cg = await items(p);
  t.check('camera in batch mode: shutter saves crops; processing identifies them', sheetHidden && cg.every((i) => i.name === 'Charizard' && i.price === '$954.65'), JSON.stringify(cg));
  const camErr = cam.errors();
  if (camErr.length) console.log('Camera page errors:\n' + camErr.join('\n'));
  t.check('no page errors (camera)', !camErr.length);
  await cam.close();
} else {
  console.log('SKIP  camera in batch mode (ffmpeg not installed)');
}

const errors = h.errors();
t.check('no page errors', !errors.length, errors.join('\n'));
await h.close();
t.done();
