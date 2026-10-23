// End-to-end check of the Trade tab: build a trade from a scan, Search and the
// collection, change versions, quantities, swap, persist, refresh, share, clear.
// Real app + real Tesseract OCR in headless Chromium; network stubbed (see harness.mjs).
//   CHROMIUM_PATH=/opt/pw-browsers/chromium node tests/e2e-trade.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, makeCard, reporter, results, CARDS } from './harness.mjs';

const t = reporter();

const h = await startHarness({ contextOptions: { permissions: ['clipboard-read', 'clipboard-write'] } });
const page = await h.newPage();
const shot = (name) => page.screenshot({ path: path.join(results, `trade-${name}.png`) });

// ---- verdict maths (the module's pure function, run in the page) ----
{
  await page.waitForFunction(async () => (await import('/js/fx.js')).fx().rate === 1.12);
  const m = await page.evaluate(async () => {
    const { evaluateTrade } = await import('/js/trade.js');
    const { fx } = await import('/js/fx.js');
    const e = (v, qty = 1) => ({ id: `x${Math.random()}`, name: 'X', price: v == null ? null : { value: v, currency: 'USD' }, qty });
    const v = (give, get) => evaluateTrade({ give, get }).verdict;
    return {
      fair: v([e(100)], [e(95)]).text,
      over: v([e(100)], [e(94.99)]).text,
      ahead: v([e(10)], [e(20, 2)]).text,
      empty: [v([e(10)], []).kind, v([], [e(1)]).kind, v([], []).kind],
      unknown: v([e(null)], [e(null)]).kind,
      unpriced: evaluateTrade({ give: [e(null, 2), e(5)], get: [e(10)] }),
      eur: evaluateTrade({ give: [{ id: 'a', price: { value: 10, currency: 'EUR' } }], get: [] }).give.usd,
      rate: fx().rate,
    };
  });
  t.check('exactly 5% apart is fair', m.fair === 'Fair trade (within 5%)', m.fair);
  t.check('just over 5% apart is not fair', m.over === "You'd lose $5.01", m.over);
  t.check('getting more = ahead', m.ahead === 'You come out ahead by $30.00', m.ahead);
  t.check('an empty side asks for cards; no prices at all = unknown', m.empty.every((k) => k === 'empty') && m.unknown === 'unknown');
  const u = m.unpriced;
  t.check('unpriced cards count $0 and are counted by quantity', u.give.usd === 5 && u.give.cards === 3 && u.unpriced === 2 && u.pct === 50, JSON.stringify(u));
  t.check('old EUR saves are converted to USD', m.rate === 1.12 && m.eur === 11.2, `${m.eur} @ ${m.rate}`);
}

const state = () =>
  page.evaluate(() => {
    const txt = (s, r = document) => r.querySelector(s)?.textContent.trim() ?? null;
    const lines = (side) =>
      [...document.querySelectorAll(`#trade-${side} .citem`)].map((li) => ({
        name: txt('.c-name', li),
        sub: [...li.querySelectorAll('.c-sub')].map((s) => s.textContent).join(' | '),
        price: txt('.c-price', li),
        qty: txt('.qty span', li),
        img: li.querySelector('img')?.src || '',
      }));
    return {
      give: txt('.ts-side.give .ts-amount'),
      giveCount: txt('.ts-side.give .ts-count'),
      get: txt('.ts-side.get .ts-amount'),
      getCount: txt('.ts-side.get .ts-count'),
      giveTotal: txt('#trade-give .tside-total'),
      getTotal: txt('#trade-get .tside-total'),
      verdict: txt('.ts-verdict'),
      kind: document.querySelector('.ts-verdict')?.className.replace('ts-verdict ', ''),
      diff: txt('.ts-diff'),
      warn: txt('.ts-warn'),
      bar: document.querySelector('.ts-give')?.style.width,
      giveLines: lines('give'),
      getLines: lines('get'),
      euros: document.querySelector('#view-trade').textContent.includes('€'),
    };
  });
const sheetOpen = () => page.waitForSelector('#sheet:not([hidden]) .actions .btn', { timeout: 20000 });
const sheetClosed = () => page.waitForSelector('#sheet', { state: 'hidden', timeout: 10000 });
const activeChip = () => page.evaluate(() => document.querySelector('.variant-chips .chip.active')?.firstChild.textContent);
const chip = (label) => page.locator('.variant-chips .chip', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\$`) });
const headline = () => page.waitForFunction(() => document.querySelector('.headline-price')?.textContent.trim()).then((h) => h.jsonValue());
const tradeView = () => page.waitForSelector('#view-trade.active', { timeout: 10000 });
const line = (side, name) => page.locator(`#trade-${side} .citem`, { hasText: name });

async function searchAndOpen(setId, number, name) {
  await page.waitForSelector('#view-search.active');
  await page.evaluate(() => document.querySelector('#search-results').replaceChildren());
  await page.fill('#q-name', '');
  await page.selectOption('#q-set', setId);
  await page.fill('#q-number', number);
  await page.click('#search-form button[type="submit"]');
  await page.click(`#search-results .tile:has-text("${number}/")`);
  await sheetOpen();
  await page.waitForFunction((n) => document.querySelector('.detail-name')?.textContent === n, name);
}

// ---- empty trade ----
await page.click('.tab[data-view="trade"]');
await tradeView();
let s = await state();
t.check(
  'empty trade: $0 both sides, asks for cards, tools disabled',
  s.give === '$0.00' && s.get === '$0.00' && s.kind === 'empty' && (await page.isDisabled('#trade-share')) && (await page.isDisabled('#trade-clear')),
  JSON.stringify(s),
);
await shot('empty');

// ---- You give: scan a card from the Trade tab ----
await page.click('#trade-give button:has-text("Scan")');
await page.waitForSelector('#view-scan.active #scan-target:not([hidden])');
const banner = await page.textContent('#scan-target-label');
t.check('Scan from a side opens the scanner with a banner', banner === 'Adding cards to: You give', banner);
const png = await makeCard(page, CARDS.aurorus);
fs.writeFileSync(path.join(results, 'trade-aurorus.png'), png);
await page.setInputFiles('#file-input-library', { name: 'card.png', mimeType: 'image/png', buffer: png });
await page.waitForSelector('#sheet:not([hidden]) .detail-name', { timeout: 120000 });
const scannedPrice = await headline();
const scannedVersion = await activeChip();
const giveBtnPrimary = await page.locator('.actions .btn', { hasText: 'Trade: I give' }).evaluate((b) => b.classList.contains('primary'));
t.check('scan result highlights "Trade: I give"', (await page.textContent('.detail-name')) === 'Aurorus' && giveBtnPrimary, `${scannedVersion} ${scannedPrice}`);
await shot('scan-sheet');
await page.click('.actions .btn:has-text("Trade: I give")');
await sheetClosed();
t.check('sheet closes after adding, scanner still in trade mode', await page.isVisible('#view-scan.active #scan-target'));
await page.click('#btn-target-done');
await tradeView();
s = await state();
t.check(
  'Done returns to the trade with the scanned card in You give',
  s.giveLines.length === 1 && s.giveLines[0].name === 'Aurorus' && s.giveLines[0].sub.includes(scannedVersion) && s.giveLines[0].price === scannedPrice && s.give === scannedPrice,
  JSON.stringify(s.giveLines),
);

// ---- change the version of a trade line ("Use this version") ----
await line('give', 'Aurorus').locator('.c-name').click();
await sheetOpen();
const useBtn = page.locator('.actions .btn', { hasText: 'Use this version' });
t.check('tapping a trade card opens its sheet on the saved version', (await useBtn.count()) === 1 && (await activeChip()) === scannedVersion);
await chip('Set Logo Stamp').click();
await shot('version-sheet');
await useBtn.click();
await sheetClosed();
s = await state();
t.check(
  'Use this version replaces the line (photo + USD price of that version)',
  scannedVersion !== 'Set Logo Stamp' && s.giveLines.length === 1 && s.giveLines[0].sub.endsWith('Set Logo Stamp') && s.giveLines[0].price === '$32.04' && s.giveLines[0].img.includes('685559'),
  JSON.stringify(s.giveLines),
);

// ---- You get: two cards via Search, one with a different version ----
await page.click('#trade-get button:has-text("Search")');
await page.waitForSelector('#view-search.active #search-target:not([hidden])');
t.check('Search from a side shows which side', (await page.textContent('#search-target')) === 'Pick a card for: You get');
await searchAndOpen('base1', '4', 'Charizard');
await chip('1st Edition Shadowless Holo').click();
t.check('1st Edition (EUR only) is shown in USD', (await headline()) === '$3,730.40');
await page.click('.actions .btn:has-text("Trade: I get")');
await tradeView();
await sheetClosed();

await page.click('#trade-get button:has-text("Search")');
await searchAndOpen('sv03', '125', 'Charizard ex');
// Save the stamped version to the collection for later, then trade the regular one.
await chip('Holo Play! Pokémon Stamp').click();
await page.click('.actions .btn:has-text("Add to collection")');
await chip('Holo').click();
await page.click('.actions .btn:has-text("Trade: I get")');
await tradeView();
await sheetClosed();

s = await state();
t.check(
  'You get lists both cards with their versions',
  s.getLines.length === 2 &&
    s.getLines[0].name === 'Charizard' && s.getLines[0].sub === 'Base Set · 4/102 | 1st Edition Shadowless Holo' && s.getLines[0].price === '$3,730.40' &&
    s.getLines[1].name === 'Charizard ex' && s.getLines[1].sub === 'Obsidian Flames · 125/197 | Holo' && s.getLines[1].price === '$5.28',
  JSON.stringify(s.getLines),
);
t.check(
  'subtotals, difference, % and verdict',
  s.give === '$32.04' && s.giveCount === '1 card' && s.get === '$3,735.68' && s.getCount === '2 cards' && s.giveTotal === '$32.04' && s.getTotal === '$3,735.68' &&
    s.verdict === 'You come out ahead by $3,703.64' && s.kind === 'ahead' && s.diff === 'Difference $3,703.64 · 99% of the bigger side' && !s.warn && !s.euros,
  JSON.stringify(s),
);
await shot('filled');

// ---- quantities ----
await line('give', 'Aurorus').locator('button[aria-label="Add one"]').click();
s = await state();
t.check('+ adds a copy', s.giveLines[0].qty === '×2' && s.give === '$64.08' && s.giveCount === '2 cards' && s.verdict === 'You come out ahead by $3,671.60', JSON.stringify(s));
await line('give', 'Aurorus').locator('button[aria-label="Remove one"]').click();
s = await state();
t.check('− removes a copy', s.giveLines[0].qty === '×1' && s.give === '$32.04');

// ---- change version with the same side's trade button (keeps quantity) ----
await line('give', 'Aurorus').locator('button[aria-label="Add one"]').click();
await line('give', 'Aurorus').locator('img').click();
await sheetOpen();
await chip('Cosmos Holo').click();
await page.click('.actions .btn:has-text("Trade: I give")');
await sheetClosed();
s = await state();
t.check(
  '"Trade: I give" on a different version replaces that line',
  s.giveLines.length === 1 && s.giveLines[0].sub.includes('| Cosmos Holo') && s.giveLines[0].qty === '×2' && s.giveLines[0].price === '$56.00' && s.give === '$56.00',
  JSON.stringify(s.giveLines),
);

// ---- entry-only payload (what the Batch tab sends) ----
await page.evaluate(() => {
  const entry = { id: '30th-157', name: 'Mewtwo ex', setId: '30th', setName: '30th Celebration', number: '157/128', variant: 'Normal', variantId: 'generated-0', image: '', fallbackImage: 'https://assets.tcgdex.net/en/me/30th/157/low.webp', price: null, qty: 1, added: Date.now() };
  document.dispatchEvent(new CustomEvent('card:action', { detail: { action: 'trade-get', card: null, row: null, entry } }));
});
s = await state();
t.check(
  'batch-style entry is added; a card without price warns',
  s.getLines.length === 3 && s.getLines[2].name === 'Mewtwo ex' && s.getLines[2].price === '—' && s.getCount === '3 cards' && s.get === '$3,735.68' && /^1 card has no price — check eBay/.test(s.warn || ''),
  `${s.warn} ${JSON.stringify(s.getLines[2])}`,
);

// ---- From collection ----
await page.evaluate(() => {
  const items = JSON.parse(localStorage.getItem('collection.v1') || '[]');
  items.push({ key: 'sv03-001|old', id: 'sv03-001', name: 'Oddish', setName: 'Obsidian Flames', number: '001/197', variant: 'Normal', image: '', price: { value: 10, currency: 'EUR', source: 'Cardmarket trend' }, qty: 3 });
  localStorage.setItem('collection.v1', JSON.stringify(items));
});
await page.click('#trade-give button:has-text("From collection")');
await page.waitForSelector('.trade-picker .citem');
const pickerAll = await page.$$eval('.trade-picker .citem', (els) => els.map((e) => e.textContent));
await page.fill('.trade-picker input[type="search"]', 'pokemon stamp');
const pickerFiltered = await page.$$eval('.trade-picker .citem', (els) => els.map((e) => e.querySelector('.c-name').textContent));
t.check(
  'picker lists saved cards in USD and filters (accents ignored)',
  pickerAll.length === 2 && pickerAll.some((x) => x.includes('$11.20') && x.includes('You have 3')) && !pickerAll.join().includes('€') && pickerFiltered.length === 1 && pickerFiltered[0] === 'Charizard ex',
  JSON.stringify({ pickerAll, pickerFiltered }),
);
await page.click('.trade-picker .tp-add');
const addedLabel = await page.textContent('.trade-picker .tp-add');
await shot('picker');
await page.click('.trade-picker .tp-head .btn');
s = await state();
t.check(
  'From collection adds a copy with qty 1',
  addedLabel === 'Added ×1' && s.giveLines.length === 2 && s.giveLines[1].name === 'Charizard ex' && s.giveLines[1].sub.endsWith('Holo Play! Pokémon Stamp') && s.giveLines[1].qty === '×1' && s.giveLines[1].price === '$19.82' && s.give === '$75.82' && s.giveCount === '3 cards',
  JSON.stringify(s.giveLines),
);

// ---- sticky summary ----
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(150);
const stick = await page.evaluate(() => ({
  bar: document.querySelector('.topbar').getBoundingClientRect().bottom,
  sum: document.querySelector('.ts-card').getBoundingClientRect().top,
  scrolled: window.scrollY,
}));
t.check('summary stays visible while scrolling', stick.scrolled > 0 && stick.sum >= stick.bar - 1 && stick.sum < stick.bar + 20, JSON.stringify(stick));
await shot('scrolled');
await page.evaluate(() => window.scrollTo(0, 0));

// ---- swap sides ----
await page.click('.trade-swap');
s = await state();
t.check(
  'swap sides',
  s.give === '$3,735.68' && s.get === '$75.82' && s.giveLines.length === 3 && s.getLines.length === 2 && s.verdict === "You'd lose $3,659.86" && s.kind === 'behind' && s.diff === 'Difference $3,659.86 · 98% of the bigger side',
  JSON.stringify(s),
);
await shot('swapped');

// ---- removing the last copy can be undone ----
await line('give', 'Mewtwo ex').locator('button[aria-label="Remove one"]').click();
s = await state();
const removed = s.giveLines.length === 2 && !s.warn;
await page.click('.trade-undo button');
s = await state();
t.check('− on the last copy removes the card, Undo puts it back', removed && s.giveLines.length === 3 && s.giveLines[2].name === 'Mewtwo ex' && !!s.warn);

// ---- persists across reloads ----
const before = await state();
await page.reload();
await page.click('.tab[data-view="trade"]');
await tradeView();
s = await state();
t.check('trade is still there after reopening the app', JSON.stringify(s) === JSON.stringify(before), JSON.stringify(s));

// ---- refresh prices ----
await page.evaluate(() => {
  const tr = JSON.parse(localStorage.getItem('trade.v1'));
  tr.get.find((e) => e.name === 'Charizard ex').price = { value: 1, currency: 'USD', source: 'TCGplayer market' };
  localStorage.setItem('trade.v1', JSON.stringify(tr));
});
await page.reload();
await page.click('.tab[data-view="trade"]');
await tradeView();
const stale = (await state()).get;
await page.click('#trade-refresh');
await page.waitForFunction(() => document.querySelector('#trade-refresh')?.textContent === 'Refresh prices' && document.querySelector('.ts-side.get .ts-amount').textContent === '$75.82', null, { timeout: 15000 }).catch(() => {});
s = await state();
t.check('Refresh prices fetches current prices', stale === '$57.00' && s.get === '$75.82', `${stale} -> ${s.get}`);

// ---- share ----
await page.evaluate(() => {
  Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => (window.__shared = d) });
});
await page.click('#trade-share');
const shared = await page.evaluate(() => window.__shared);
const text = shared?.text || '';
t.check(
  'Share sends a text summary with every card, version and price',
  shared?.title === 'Pokémon card trade' &&
    text.includes('You give: $3,735.68 (3 cards)') &&
    text.includes('• Charizard (Base Set 4/102) · 1st Edition Shadowless Holo — $3,730.40') &&
    text.includes('• Mewtwo ex (30th Celebration 157/128) · Normal — no price') &&
    text.includes('You get: $75.82 (3 cards)') &&
    text.includes('• 2× Aurorus (Perfect Order 024/088) · Cosmos Holo — $56.00 ($28.00 each)') &&
    text.includes("You'd lose $3,659.86") &&
    text.includes('Difference: $3,659.86 (98% of the bigger side)') &&
    !text.includes('€'),
  `\n${text}`,
);
await page.evaluate(() => Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }));
await page.click('#trade-share');
await page.waitForSelector('.toast:has-text("Trade copied")', { timeout: 5000 }).catch(() => {});
const clip = await page.evaluate(() => navigator.clipboard.readText().catch((e) => `ERR ${e.message}`));
t.check('without Web Share it copies the summary to the clipboard', clip === text, clip.slice(0, 80));

// ---- clear ----
await page.click('#trade-clear');
await page.waitForSelector('.modal-panel:has-text("Remove every card from this trade?")');
await shot('clear-confirm');
await page.click('.modal-panel .btn.primary:has-text("Clear trade")');
s = await state();
t.check('Clear trade empties both sides', !s.giveLines.length && !s.getLines.length && s.give === '$0.00' && s.kind === 'empty');

// ---- a fair multi-card trade ----
await page.click('#trade-give button:has-text("Search")');
await searchAndOpen('me03', '024', 'Aurorus');
await chip('Cosmos Holo').click();
await page.click('.actions .btn:has-text("Trade: I give")');
await tradeView();
await page.click('#trade-get button:has-text("From collection")');
await page.fill('.trade-picker input[type="search"]', 'charizard');
await page.click('.trade-picker .tp-add');
await page.click('.trade-picker .tp-head .btn');
await page.click('#trade-get button:has-text("Search")');
await searchAndOpen('sv03', '125', 'Charizard ex');
await chip('Holo (Jumbo)').click();
await page.click('.actions .btn:has-text("Trade: I get")');
await tradeView();
await sheetClosed();
s = await state();
t.check(
  'two cards for one, within 5% = fair',
  s.give === '$28.00' && s.get === '$27.09' && s.getCount === '2 cards' && s.verdict === 'Fair trade (within 5%)' && s.kind === 'fair' && s.diff === 'Difference $0.91 · 3.3% of the bigger side',
  JSON.stringify(s),
);
await shot('fair');

// ---- wide screen: sides next to each other ----
await page.setViewportSize({ width: 1024, height: 800 });
const sideBySide = await page.evaluate(() => document.querySelector('#trade-give').getBoundingClientRect().top === document.querySelector('#trade-get').getBoundingClientRect().top);
t.check('wide screens show the sides next to each other', sideBySide);
await shot('wide');
await page.setViewportSize({ width: 390, height: 844 });

const errors = h.errors();
t.check('no page errors', !errors.length, errors.join('\n'));
await h.close();
t.done();
