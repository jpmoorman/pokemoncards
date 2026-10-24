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
const tradeSide = (side) => page.evaluate((side) => (JSON.parse(localStorage.getItem('trade.v1'))?.[side] || []).map((e) => `${e.id}×${e.qty}`).join(), side);
const tradeCount = (side) =>
  page.evaluate((side) => (JSON.parse(localStorage.getItem('trade.v1'))?.[side] || []).reduce((m, e) => ({ ...m, [e.id]: (m[e.id] || 0) + e.qty }), {}), side);
const maybe = (sel, timeout = 5000) => page.waitForSelector(sel, { timeout }).catch(() => null); // null: report a FAIL, don't hang
const plainToast = () => page.evaluate(() => [...document.querySelectorAll('.toast[data-plain]')].map((t) => t.textContent).join(' | '));

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
await page.waitForFunction(() => /^Processing/.test(document.querySelector('#batch-progress')?.textContent));
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

// ---- a start-up that can't read the saved list deletes no photo, and nothing is saved over it ----
await h.context.addInitScript(() => {
  const get = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (k) {
    if (k === 'batch:items' && localStorage.getItem('test.failBatchIndex')) throw new DOMException('simulated read failure', 'UnknownError');
    return get.call(this, k);
  };
});
const keysBefore = (await batchKeys()).sort().join();
await page.evaluate(() => localStorage.setItem('test.failBatchIndex', '1'));
await page.reload();
await page.click('.tab[data-view="batch"]');
const unread = await maybe('.b-unread');
await page.waitForTimeout(2500); // past the retries and any start-up clean-up
const keysUnread = (await batchKeys()).sort().join();
await page.click('.tab[data-view="scan"]');
await page.setInputFiles('#file-input-library', [await png(CARDS.aurorus), await png(CARDS.baseCharizard)]);
const refused = await maybe('.modal p:has-text("wasn\'t added")', 10000);
const refusedMsg = refused ? await refused.textContent() : '';
if (refused) await page.click('.modal .btn:has-text("OK")');
await page.waitForTimeout(500);
const keysAfterAdd = (await batchKeys()).sort().join();
await page.evaluate(() => localStorage.removeItem('test.failBatchIndex'));
await page.reload();
await page.click('.tab[data-view="batch"]');
await page.waitForFunction(() => document.querySelectorAll('#batch-list .bitem.matched').length === 3, null, { timeout: 10000 }).catch(() => {});
await thumbsLoaded().catch(() => {});
const back = await items();
t.check(
  "a start-up that can't read the saved list keeps every photo, says so, and refuses new photos instead of saving over it",
  !!unread && keysBefore.split(',').length === 7 && keysUnread === keysBefore && !!refusedMsg && keysAfterAdd === keysBefore && JSON.stringify(back) === JSON.stringify(got),
  `unread=${!!unread} | ${keysBefore} → ${keysUnread} → ${keysAfterAdd} | ${refusedMsg} | ${back.map((i) => i.name)}`,
);

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

// ---- review: a card the scan can't tell from its reprint is flagged; keeping it clears the flag ----
const twin = got[1];
await page.click('#batch-list .bitem:nth-child(2) .b-main');
await page.waitForSelector('#sheet:not([hidden]) .reprint-note');
const twinNote = await page.textContent('.reprint-note');
const twinConf = await page.textContent('#confidence');
await page.click('.actions .btn:has-text("Use this card")');
await page.waitForSelector('#sheet', { state: 'hidden' });
got = await items();
t.check(
  'a card with a reprint twin is flagged "Check", its review offers the reprint, keeping it clears the flag',
  twin.flag && twin.tags.includes('Check') && /30th Celebration \(2026\) reprint/.test(twinNote) && twinConf === 'Likely match' && !got[1].flag && got[1].name === 'Charizard' && got[1].price === '$954.65',
  JSON.stringify({ twin, twinNote, twinConf, now: got[1] }),
);

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

// Sending again: cards already in the trade are not sent twice unless the user asks for copies.
const giveSent = await tradeSide('give');
await page.click('.tab[data-view="batch"]');
got = await items();
await page.click('#batch-trade');
const againMsg = await page.textContent('.modal p');
await page.click('.modal .btn:has-text("Cancel")');
t.check(
  'sent cards are tagged "In trade"; sending again asks before adding copies (Cancel adds nothing)',
  got.every((i) => i.tags.includes('In trade · You give')) && /already in the trade.*again/.test(againMsg) && (await tradeSide('give')) === giveSent && giveSent === 'sv03-215×1,base1-4×1,me03-024×1',
  `${againMsg} | ${giveSent} | ${got.map((i) => i.tags)}`,
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

// Scanning for a trade pauses batch mode (each card is identified); Done brings it back.
await page.click('.tab[data-view="trade"]');
await page.click('#trade-give button:has-text("Scan")');
await page.waitForSelector('#view-scan.active #scan-target:not([hidden])');
const paused = [await page.textContent('#btn-mode'), await plainToast()];
await page.click('#btn-target-done');
await page.waitForSelector('#view-trade.active');
await page.click('.tab[data-view="scan"]');
const resumed = await page.textContent('#btn-mode');
t.check(
  'scanning for a trade pauses batch mode and says so; Done turns it back on',
  /^Batch mode: Off/.test(paused[0]) && /paused/.test(paused[1]) && resumed === 'Batch mode: On · 2 saved',
  `${paused.join(' / ')} → ${resumed}`,
);
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

// ---- send to trade again: only the 2 new cards go, nothing is doubled ----
const tradeLabel = await page.textContent('#batch-trade');
await page.click('#batch-trade');
const newMsg = await page.textContent('.modal p');
await page.click('.modal .btn:has-text("You get")');
await page.waitForSelector('#view-trade.active');
const sentToast = await plainToast();
const [giveNow, getNow] = [await tradeSide('give'), await tradeSide('get')];
t.check(
  'Send to trade again sends only the cards not in the trade yet and says how many were left out',
  tradeLabel === 'Send 2 new to trade…' && /2 new cards.*3 already in the trade/.test(newMsg) && /Sent 2 new cards.*3 were already in the trade/.test(sentToast) && giveNow === giveSent && getNow === 'base1-4×1,me03-024×1',
  `${tradeLabel} | ${newMsg} | ${sentToast} | give ${giveNow} | get ${getNow}`,
);
await page.click('.tab[data-view="batch"]');

// ---- ✕ removes a row at once with Undo; the photo is deleted once Undo has passed ----
const id5 = await page.getAttribute('#batch-list .bitem:nth-child(5)', 'data-id');
const box = await page.$eval('#batch-list .bitem:nth-child(5) .b-remove', (b) => [b.offsetWidth, b.offsetHeight].join('x'));
await page.click('#batch-list .bitem:nth-child(5) .b-remove');
await page.waitForFunction(() => document.querySelectorAll('#batch-list .bitem').length === 4);
await maybe('.toast-action button:has-text("Undo")');
// A message that follows (adding the rest to the collection) shows above the Undo instead of removing it.
await page.click('#batch-add-all');
const addedMsg = await maybe('.toast[data-plain]:has-text("to your collection")', 3000);
const undo = await maybe('.toast-action button:has-text("Undo")', 1000);
const stacked = await page.evaluate(() => {
  const a = document.querySelector('.toast-action')?.getBoundingClientRect();
  const m = document.querySelector('.toast[data-plain]')?.getBoundingClientRect();
  return a && m ? { apart: m.bottom <= a.top, onScreen: m.top >= 0 && a.bottom <= innerHeight } : null;
});
t.check('a later message shows above the Undo toast instead of removing it', !!addedMsg && !!undo && !!stacked?.apart && !!stacked?.onScreen, JSON.stringify(stacked));
await shot(page, 'undo');
if (undo) {
  await undo.click();
  await page.waitForFunction(() => document.querySelectorAll('#batch-list .bitem').length === 5);
  await thumbsLoaded();
}
const restored = await page.getAttribute('#batch-list .bitem:nth-child(5)', 'data-id').catch(() => null);
let keys = await batchKeys();
t.check('✕ (40px) offers Undo, which brings the row back with its photo', box === '40x40' && restored === id5 && keys.includes(`batch:photo:${id5}`), `${box} ${restored} ${keys}`);
if (undo) {
  await page.click('#batch-list .bitem:nth-child(5) .b-remove');
  await page.waitForFunction(() => document.querySelectorAll('#batch-list .bitem').length === 4);
}
await page.waitForSelector('.toast-action', { state: 'detached', timeout: 10000 });
await page.waitForTimeout(300);
keys = await batchKeys();
t.check('…without Undo its photo is deleted from storage', !keys.some((k) => k.endsWith(id5)), keys.join());

// ---- clear done ----
await page.click('#batch-clear-done');
const askRemove = await maybe('.modal .btn.primary:has-text("Remove")', 1000); // only asked when some aren't in the collection
if (askRemove) await askRemove.click();
await page.waitForSelector('.b-empty');
keys = await batchKeys();
t.check('Clear done deletes the photos from storage', keys.join() === 'batch:items', keys.join());

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

// ---- a photo that can't be opened is reported, not hidden behind the count ----
const notImage = { name: 'photo.heic', mimeType: 'image/heic', buffer: Buffer.from('not a picture') };
await page.setInputFiles('#batch-file-input', [await png(CARDS.aurorus), notImage, await png(CARDS.baseCharizard)]);
await page.waitForFunction(() => document.querySelectorAll('#batch-list .bitem').length === 2 && !document.querySelector('.b-saving'));
await page.waitForTimeout(300);
const pickToast = await plainToast();
t.check('picking 3 photos where 1 can\'t be opened says so in the toast that stays', pickToast === "2 photos added to batch · 1 photo couldn't be opened", pickToast);

// ---- clear all ----
await page.click('#batch-clear-all');
await page.click('.modal .btn.primary:has-text("Delete all")');
await page.waitForSelector('.b-empty');
keys = await batchKeys();
t.check('Clear all empties the batch and its storage', !keys.length && (await page.isHidden('#batch-count')), keys.join());

// Clear all while photos are still being saved: the save stops and nothing comes back.
const eight = [];
for (let i = 0; i < 8; i++) eight.push(await png(i % 2 ? CARDS.aurorus : CARDS.baseCharizard));
await page.setInputFiles('#batch-file-input', eight);
await page.waitForFunction(() => document.querySelectorAll('#batch-list .bitem').length >= 2);
await page.click('#batch-clear-all');
await page.waitForSelector('.modal .btn.primary:has-text("Delete all")');
// Tap "Delete all" while the next photo is being written (a separate task, like a real tap).
await page.evaluate(() => {
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (v, k) {
    if (String(k).startsWith('batch:photo:')) {
      IDBObjectStore.prototype.put = put;
      setTimeout(() => document.querySelector('.modal .btn.primary')?.click(), 0);
    }
    return put.call(this, v, k);
  };
});
await page.waitForFunction(() => !document.querySelector('.b-saving'), null, { timeout: 60000 });
const tapped = !(await page.$('.modal'));
if (!tapped) await page.click('.modal .btn.primary:has-text("Delete all")');
await page.waitForTimeout(500);
keys = await batchKeys();
const left = (await items()).length;
t.check('Clear all during a multi-photo save: the batch and its storage stay empty', tapped && !left && !keys.length && (await page.isVisible('.b-empty')), `tapped mid-save ${tapped}, ${left} rows, keys ${keys}`);
if (left) {
  // Start the next part from an empty batch anyway.
  await page.click('#batch-clear-all');
  await page.click('.modal .btn.primary:has-text("Delete all")');
  await page.waitForSelector('.b-empty');
}

// ---- stop, photos added mid-run, reload mid-run ----
await page.setInputFiles('#batch-file-input', [await png(CARDS.charizardEx), await png(CARDS.baseCharizard), await png(CARDS.aurorus)]);
await page.waitForFunction(() => document.querySelectorAll('#batch-list .bitem.waiting').length === 3);
await page.click('#batch-process');
await page.click('#batch-stop');
await page.waitForSelector('#batch-process');
got = await items();
t.check('Stop finishes the current photo and leaves the rest waiting', got.map((i) => i.status).join() === 'matched,waiting,waiting', got.map((i) => i.status).join());

// A longer run (5 waiting) so a photo added after it starts lands mid-run.
await page.setInputFiles('#batch-file-input', [await png(CARDS.charizardEx), await png(CARDS.baseCharizard), await png(CARDS.aurorus)]);
await page.waitForFunction(() => document.querySelectorAll('#batch-list .bitem.waiting').length === 5);
const extra = await png(CARDS.mewtwo30th);
await page.click('#batch-process');
await page.setInputFiles('#batch-file-input', extra);
await page.waitForFunction(() => document.querySelectorAll('#batch-list .bitem').length === 7);
const midRun = !!(await page.$('#batch-stop'));
if (midRun) {
  await allDone(7);
  got = await items();
  t.check(
    'a photo added while processing is picked up by the same run',
    got.every((i) => i.status === 'matched') && got[6].name === 'Mewtwo ex' && got[6].price === 'No price' && !(await page.$('#batch-process')),
    JSON.stringify(got.map((i) => [i.status, i.name, i.price])),
  );
} else {
  console.log('SKIP  photo added mid-run (the run finished before the photo was saved)');
  await page.click('#batch-process');
  await allDone(7);
}

await page.setInputFiles('#batch-file-input', [await png(CARDS.aurorus), await png(CARDS.charizardEx)]);
await page.waitForFunction(() => document.querySelectorAll('#batch-list .bitem.waiting').length === 2);
await page.click('#batch-process');
await page.waitForSelector('#batch-list .bitem.processing');
await page.reload();
await page.click('.tab[data-view="batch"]');
await page.waitForSelector('#batch-list .bitem');
got = await items();
t.check('reload mid-run: the interrupted photo goes back to waiting', got.length === 9 && !got.some((i) => i.status === 'processing') && got[7].status === 'waiting', got.map((i) => i.status).join());
await page.click('#batch-process');
await allDone(9);
got = await items();
t.check('…and processing again finishes the batch', got.every((i) => i.status === 'matched') && got[7].name === 'Aurorus' && got[8].name === 'Charizard ex', got.map((i) => i.name).join());
await shot(page, 'long-list');

// ---- several Library photos while adding cards to a trade: Batch offers to send just those ----
const getBefore = await tradeCount('get');
const forTrade = [await png(CARDS.charizardEx), await png(CARDS.aurorus)];
await page.click('.tab[data-view="trade"]');
await page.click('#trade-get button:has-text("Scan")');
await page.waitForSelector('#view-scan.active #scan-target:not([hidden])');
await page.setInputFiles('#file-input-library', forTrade);
await page.waitForFunction(() => document.querySelector('#view-batch.active') && document.querySelectorAll('#batch-list .bitem').length === 11, null, { timeout: 20000 });
const pickedToast = await plainToast();
const note = (await (await page.$('.b-trade-note.get'))?.textContent()) || '';
await shot(page, 'trade-note');
await page.click('#batch-process');
// While a scan runs on the Scan tab ('scan:busy'), processing waits between photos.
const busy = (b) => page.evaluate((b) => document.dispatchEvent(new CustomEvent('scan:busy', { detail: { busy: b } })), b);
await busy(true);
const pausedRun = await page
  .waitForFunction(() => /Paused while your scan/.test(document.querySelector('#batch-progress-msg')?.textContent || ''), null, { timeout: 60000 })
  .then(() => true, () => false);
const doneAtPause = (await items()).filter((i) => i.status === 'matched').length;
await page.waitForTimeout(2500);
const doneLater = (await items()).filter((i) => i.status === 'matched').length;
await busy(false);
await allDone(11);
t.check('batch processing waits between photos while a scan runs, then carries on', pausedRun && doneAtPause === doneLater && doneLater < 11, `paused=${pausedRun} ${doneAtPause} → ${doneLater}`);
const sendBtn = await page.$('#batch-send-get');
const sendLabel = await sendBtn?.textContent();
if (sendBtn) {
  await sendBtn.click();
  const confirmSend = await maybe('.modal .btn.primary:has-text("Add all")', 1000);
  if (confirmSend) await confirmSend.click();
  await page.waitForSelector('#view-trade.active');
}
const getAfter = await tradeCount('get');
const gained = Object.entries(getAfter).filter(([id, q]) => q !== (getBefore[id] || 0)).map(([id, q]) => `${id}+${q - (getBefore[id] || 0)}`).sort().join();
t.check(
  'Library photos picked for "You get" are marked; "Send 2 to You get" sends just those',
  /2 photos added to batch for “You get”/.test(pickedToast) && /2 photos for “You get”/.test(note) && sendLabel === 'Send 2 to You get' && gained === 'me03-024+1,sv03-125+1' && !(await page.$('.b-trade-note')),
  `${pickedToast} | ${note} | ${sendLabel} | gained ${gained}`,
);

// ---- a scan finishing while a batch review sheet is open doesn't take the sheet over ----
const scanPhoto = await png(CARDS.baseCharizard);
await page.click('.tab[data-view="scan"]');
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); // phone speed: the scan takes a few seconds
await page.evaluate(() => {
  window.__busy = [];
  document.addEventListener('scan:busy', (e) => window.__busy.push(e.detail.busy));
});
await page.setInputFiles('#file-input-library', scanPhoto);
await page.waitForSelector('#guide.busy');
await page.click('.tab[data-view="batch"]');
await page.click('#batch-list .bitem:nth-child(1) .b-main');
await page.waitForSelector('#sheet:not([hidden]) .actions .btn:has-text("Use this card")');
const scanning = await page.evaluate(() => document.querySelector('#guide').classList.contains('busy'));
await page.waitForFunction(() => !document.querySelector('#guide.busy'), null, { timeout: 120000 });
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
const busyEvents = await page.evaluate(() => window.__busy.join());
t.check('a scan on the Scan tab says when it starts and ends (scan:busy), so Batch can wait', busyEvents === 'true,false', busyEvents);
const kept = await page.evaluate(() => ({
  name: document.querySelector('.detail-name')?.textContent,
  use: document.querySelectorAll('.actions .btn.wide').length,
  offer: document.querySelector('.toast-action')?.textContent,
}));
await page.click('.actions .btn:has-text("Add to collection")');
await page.click('.sheet-close');
got = await items();
const view = await maybe('.toast-action:has-text("Scan ready") button:has-text("View")');
await shot(page, 'scan-ready');
const sheetStayedShut = await page.isHidden('#sheet');
let viewed = false;
if (view) {
  await view.click();
  viewed = await page
    .waitForFunction(() => document.querySelector('.detail-name')?.textContent === 'Charizard' && !document.querySelector('.actions .btn.wide'), null, { timeout: 20000 })
    .then(() => true, () => false);
  await page.click('.sheet-close');
}
t.check(
  'scan done while a review sheet is open: the review stays, its Add to collection marks that item, the scan is offered with View',
  scanning && kept.name === 'Charizard ex' && kept.use === 1 && /Scan ready: Charizard/.test(kept.offer) && got[0].name === 'Charizard ex' && got[0].tags.includes('In collection') && sheetStayedShut && viewed,
  `${scanning} ${JSON.stringify(kept)} ${JSON.stringify(got[0])} shut=${sheetStayedShut} viewed=${viewed}`,
);

// Any other sheet that replaces a review sheet: its buttons don't change the batch item.
await page.click('#batch-list .bitem:nth-child(2) .b-main');
await page.waitForSelector('#sheet:not([hidden]) .actions .btn:has-text("Use this card")');
await page.evaluate(() => import('/js/sheet.js').then((m) => m.openCard('sv03-215', {})));
await page.waitForFunction(() => document.querySelector('.detail-meta')?.textContent.includes('215/197'), null, { timeout: 20000 });
await page.click('.actions .btn:has-text("Add to collection")');
await page.click('.sheet-close');
got = await items();
t.check('an action from a sheet that replaced the review sheet leaves the batch item alone', got[1].name === 'Charizard' && !got[1].tags.includes('In collection'), JSON.stringify(got[1]));

// ---- "In trade" follows the trade: a review sheet's trade button, a version changed on the Trade tab, Swap sides ----
await page.click('.tab[data-view="trade"]');
await page.click('#trade-clear');
await page.click('.modal-panel .btn.primary:has-text("Clear trade")');
await page.click('.tab[data-view="batch"]');
const nMatched = (await items()).filter((i) => i.status === 'matched').length;
await page.click('#batch-list .bitem:nth-child(2) .b-main');
await page.waitForSelector('#sheet:not([hidden]) .actions .btn:has-text("Use this card")');
await page.click('.actions .btn:has-text("Trade: I give")');
await page.waitForTimeout(300);
const tagBehind = (await items())[1].tags;
await page.click('.sheet-close');
const afterSheet = [(await items())[1].tags, await page.textContent('#batch-trade')];
const newLabel = `Send ${nMatched - 1} new to trade…`;
t.check(
  'a review sheet\'s "Trade: I give" tags the item "In trade" and leaves it out of "Send new"',
  tagBehind.includes('In trade · You give') && afterSheet[0].includes('In trade · You give') && afterSheet[1] === newLabel,
  `${tagBehind} | ${afterSheet.join(' | ')} (want ${newLabel})`,
);
await page.click('.tab[data-view="trade"]');
await page.locator('#trade-give .citem').first().locator('.c-name').click();
await page.waitForSelector('#sheet:not([hidden]) .actions .btn:has-text("Use this version")');
const fromVersion = await page.locator('.variant-chips .chip.active').first().evaluate((c) => c.firstChild.textContent);
await page.locator('.variant-chips .chip:not(.active)').first().click();
await page.click('.actions .btn:has-text("Use this version")');
await page.waitForSelector('#sheet', { state: 'hidden' });
const giveLine = await page.evaluate(() => JSON.parse(localStorage.getItem('trade.v1')).give.map((e) => `${e.id}/${e.variant}`).join());
await page.click('.tab[data-view="batch"]');
const afterVersion = [(await items())[1].tags, await page.textContent('#batch-trade')];
await page.click('.tab[data-view="trade"]');
await page.click('.trade-swap');
await page.click('.tab[data-view="batch"]');
const afterSwap = (await items())[1].tags;
t.check(
  'a version changed on the Trade tab keeps the item "In trade"; after Swap sides it says "You get"',
  /^base1-4\//.test(giveLine) && giveLine !== `base1-4/${fromVersion}` && afterVersion[0].includes('In trade · You give') && afterVersion[1] === newLabel && afterSwap.includes('In trade · You get'),
  `${fromVersion} → ${giveLine} | ${afterVersion.join(' | ')} | swapped: ${afterSwap}`,
);

await page.click('#batch-clear-all');
await page.click('.modal .btn.primary:has-text("Delete all")');
await page.waitForSelector('.b-empty');

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
