// End-to-end check of scanning, matching, versions/prices, search and collection:
// runs the real app + real Tesseract OCR in headless Chromium against generated
// card images. All network APIs are stubbed with fixtures (see harness.mjs).
//   npm install && npm run test:e2e
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startHarness, makeCard, reporter, results, fixtures, CARDS, pickSet } from './harness.mjs';

const h = await startHarness();
const t = reporter();
const page = await h.newPage();

async function scanFile(spec, label) {
  const buf = await makeCard(page, spec);
  fs.writeFileSync(path.join(results, `${label}.${spec.photo ? 'jpg' : 'png'}`), buf);
  const started = Date.now();
  await page.setInputFiles('#file-input-library', { name: 'card.png', mimeType: spec.photo ? 'image/jpeg' : 'image/png', buffer: buf });
  try {
    await page.waitForSelector('#sheet:not([hidden]) .detail-name', { timeout: 120000 });
    await page.waitForFunction(() => document.querySelector('.headline-price')?.textContent.trim(), null, { timeout: 20000 });
  } catch {
    console.log(h.logs.slice(-20).join('\n'));
    console.log('status:', await page.textContent('#scan-status'));
  }
  const got = await page.evaluate(() => ({
    name: document.querySelector('.detail-name')?.textContent,
    set: document.querySelector('.set-name')?.textContent,
    meta: document.querySelector('.detail-meta')?.textContent,
    price: document.querySelector('.headline-price')?.textContent,
    conf: document.querySelector('#confidence')?.textContent,
    clueName: document.querySelector('#clue-name')?.value,
    clueNum: document.querySelector('#clue-number')?.value,
    clueSet: document.querySelector('.setpick:has(#clue-set) .setpick-input')?.value || 'Any set',
    debug: document.querySelector('#debug')?.textContent,
  }));
  got.seconds = ((Date.now() - started) / 1000).toFixed(1);
  return got;
}

const cases = [
  { label: 'Scarlet & Violet card (OBF set code)', spec: CARDS.charizardEx, expect: { name: 'Charizard ex', set: 'Obsidian Flames', price: '$5.28', set_: 'OBF · Obsidian Flames' } },
  { label: 'Vintage Base Set card (symbol only)', spec: CARDS.baseCharizard, expect: { name: 'Charizard', set: 'Base Set', price: '$954.65', set_: 'Any set' } },
  { label: '30th Celebration card (30C, no prices yet)', spec: CARDS.mewtwo30th, expect: { name: 'Mewtwo ex', set: '30th Celebration', price: 'No price yet', set_: '30C · 30th Celebration' } },
  { label: 'Perfect Order Aurorus (POR, 024/088)', spec: CARDS.aurorus, expect: { name: 'Aurorus', set: 'Perfect Order', price: '$0.15', set_: 'POR · Perfect Order', meta: '#024/088' } },
  { label: 'Phone photo of a card on a table', spec: { ...CARDS.charizardEx, scale: 3, photo: { fill: 0.72, rotate: 2, blur: 1 } }, expect: { name: 'Charizard ex', set: 'Obsidian Flames', price: '$5.28' } },
];

for (const c of cases) {
  const got = await scanFile(c.spec, c.label.replace(/\W+/g, '_'));
  const ok =
    got.name === c.expect.name &&
    got.set === c.expect.set &&
    got.price === c.expect.price &&
    (!c.expect.set_ || got.clueSet === c.expect.set_) &&
    (!c.expect.meta || got.meta?.startsWith(c.expect.meta));
  t.check(`${c.label} (${got.seconds}s)`, ok, `read name="${got.clueName}" number="${got.clueNum}" set="${got.clueSet}" -> ${got.name} | ${got.set} | ${got.meta} | ${got.price} | ${got.conf}`);
  if (!ok || process.env.VERBOSE) console.log(got.debug);
  await page.screenshot({ path: path.join(results, `${c.label.replace(/\W+/g, '_')}-result.png`) });

  if (c.expect.name === 'Aurorus') {
    // Switching versions swaps the picture to that version's marketplace photo and converts EUR prices.
    await page.click('.variant-chips .chip:has-text("Set Logo Stamp")');
    const v = await page.evaluate(() => ({
      img: document.querySelector('.detail-img')?.src,
      price: document.querySelector('.headline-price')?.textContent,
      src: document.querySelector('.headline-source')?.textContent,
      note: document.querySelector('.img-note')?.textContent,
      euros: [...document.querySelectorAll('#card-detail dd, .chip-price, .headline-price')].some((n) => n.textContent.includes('€')),
    }));
    t.check("version switch shows that version's photo and USD price", v.img.includes('685559') && v.price === '$32.04' && /converted/.test(v.src) && !v.euros, JSON.stringify(v));
    await page.screenshot({ path: path.join(results, 'aurorus-stamp-version.png') });
  }
  await page.click('.sheet-close');
}

// A scan finished while on another tab opens on the next visit to Scan, but not minutes later.
{
  const cdp = await page.context().newCDPSession(page);
  const scanAway = async () => {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); // phone speed: time to switch tabs mid-scan
    await page.setInputFiles('#file-input-library', { name: 'card.png', mimeType: 'image/png', buffer: await makeCard(page, CARDS.aurorus) });
    await page.waitForSelector('#guide.busy');
    await page.click('.tab[data-view="search"]');
    await page.waitForFunction(() => !document.querySelector('#guide.busy'), null, { timeout: 120000 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  };
  const opened = () => page.evaluate(() => (document.querySelector('#sheet').hidden ? null : document.querySelector('.detail-name')?.textContent || '?'));
  await scanAway();
  await page.click('.tab[data-view="scan"]');
  await page.waitForTimeout(500);
  const soon = await opened();
  if (soon) await page.click('.sheet-close');
  await scanAway();
  await page.evaluate(() => {
    window.__now = Date.now;
    Date.now = () => window.__now() + 4 * 60 * 1000; // four minutes later
  });
  await page.click('.tab[data-view="scan"]');
  await page.waitForTimeout(500);
  const later = await opened();
  await page.evaluate(() => (Date.now = window.__now));
  if (later) await page.click('.sheet-close');
  t.check('a scan not looked at opens on the next visit to Scan, but not four minutes later', soon === 'Aurorus' && later === null, `soon=${soon} later=${later}`);
}

// Manual search with the set picker + collection in USD.
await page.click('.tab[data-view="search"]');
await pickSet(page, 'q-set', 'base1');
await page.fill('#q-number', '4');
await page.click('#search-form button[type="submit"]');
await page.click('#search-results .tile');
await page.waitForSelector('.actions .btn');
await page.click('.variant-chips .chip:nth-child(2)');
const chipPrice = await page.textContent('.headline-price');
await page.click('.actions .btn:has-text("Add to collection")');
await page.click('.sheet-close');
await page.click('.tab[data-view="collection"]');
const total = await page.textContent('#collection-total');
t.check('search by set + number → 1st Edition → collection total in USD', chipPrice === '$3,730.40' && total === '$3,730.40', `${chipPrice} / ${total}`);
await page.screenshot({ path: path.join(results, 'collection.png') });

// Older saves stored EUR prices: they must show in USD now.
await page.evaluate(() => {
  const items = JSON.parse(localStorage.getItem('collection.v1'));
  items.push({ key: 'x', id: 'sv03-001', name: 'Oddish', setName: 'Obsidian Flames', number: '001', official: 197, variant: 'Normal', image: 'https://assets.tcgdex.net/en/sv/sv03/001', price: { value: 10, currency: 'EUR', source: 'Cardmarket trend' }, qty: 1 });
  localStorage.setItem('collection.v1', JSON.stringify(items));
});
await page.click('.tab[data-view="search"]');
await page.click('.tab[data-view="collection"]');
const migrated = await page.evaluate(() => ({ total: document.querySelector('#collection-total').textContent, text: document.querySelector('#collection-list').textContent }));
t.check('old EUR saves are shown in USD', migrated.total === '$3,741.60' && migrated.text.includes('001/197') && !migrated.text.includes('€'), JSON.stringify(migrated));

// Refresh prices while cards are added or counted up elsewhere: nothing done meanwhile is lost.
// Prices cached more than 12 h ago and a slow network make the refresh take a few seconds.
await page.evaluate(
  () =>
    new Promise((resolve) => {
      const r = indexedDB.open('pokecard-scanner');
      r.onsuccess = () => {
        const tx = r.result.transaction('kv', 'readwrite');
        const s = tx.objectStore('kv');
        const q = s.getAllKeys();
        q.onsuccess = () =>
          q.result.filter((k) => String(k).startsWith('card:')).forEach((k) => {
            const g = s.get(k);
            g.onsuccess = () => s.put({ ...g.result, t: 0 }, k);
          });
        tx.oncomplete = () => {
          r.result.close();
          resolve();
        };
      };
    }),
);
const slow = /api\.tcgdex\.net\/v2\/en\/cards\/(base1-4|sv03-001)$/;
await h.context.route(slow, async (route) => {
  await new Promise((r) => setTimeout(r, 1500));
  await route.fallback();
});
await page.reload();
await page.click('.tab[data-view="collection"]');
await page.click('#btn-refresh-prices');
await page.waitForFunction(() => /Refreshing/.test(document.querySelector('#btn-refresh-prices').textContent));
await page.click('#collection-list .citem:first-child [aria-label="Add one"]');
await page.click('.tab[data-view="search"]');
await pickSet(page, 'q-set', '');
await page.fill('#q-name', 'Aurorus');
await page.fill('#q-number', '024');
await page.click('#search-form button[type="submit"]');
await page.click('#search-results .tile');
await page.click('.actions .btn:has-text("Add to collection")');
await page.click('.sheet-close');
const during = await page.textContent('#btn-refresh-prices');
await page.click('.tab[data-view="collection"]');
await page.waitForFunction(() => document.querySelector('#btn-refresh-prices').textContent === 'Refresh prices', null, { timeout: 30000 });
await h.context.unroute(slow);
const refreshed = await page.evaluate(() => JSON.parse(localStorage.getItem('collection.v1')).map((i) => `${i.name} ×${i.qty}`).join(', '));
t.check(
  'Refresh prices keeps a card added and a quantity changed while it runs',
  /^Refreshing/.test(during) && refreshed === 'Aurorus ×1, Charizard ×2, Oddish ×1',
  `${during} → ${refreshed}`,
);

// Refresh again minutes later: it downloads current prices (not the 12-hour copy), keeps the price
// of a card it can't reach and says so.
{
  const mark = h.logs.length;
  const aurorus = 'https://api.tcgdex.net/v2/en/cards/me03-024';
  const oddish = 'https://api.tcgdex.net/v2/en/cards/sv03-001';
  await page.route(aurorus, (route) => {
    const card = JSON.parse(fs.readFileSync(path.join(fixtures, 'card-me03-024.json')));
    for (const v of card.variants_detailed) for (const p of Object.values(v.pricing?.tcgplayer || {})) if (p?.marketPrice != null) p.marketPrice = 7.77;
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(card) });
  });
  await page.route(oddish, (route) => route.abort('internetdisconnected'));
  const prices = () => page.evaluate(() => Object.fromEntries(JSON.parse(localStorage.getItem('collection.v1')).map((i) => [i.name, i.price?.value])));
  const before = await prices();
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((n) => n.remove()));
  await page.click('#btn-refresh-prices');
  await page.waitForFunction(() => document.querySelector('#btn-refresh-prices').textContent === 'Refresh prices', null, { timeout: 30000 });
  const msg = await page.evaluate(() => document.querySelector('.toast[data-plain]')?.textContent || '');
  const now = await prices();
  await page.unroute(aurorus);
  await page.unroute(oddish);
  for (let i = h.logs.length - 1; i >= mark; i--) if (/Failed to load resource/.test(h.logs[i])) h.logs.splice(i, 1);
  t.check(
    "Refresh prices downloads cards looked up minutes ago, keeps the price it can't update and says so",
    now.Aurorus === 7.77 && before.Aurorus !== 7.77 && now.Oddish === before.Oddish && now.Charizard === before.Charizard && msg === "Updated 2 of 3 cards — couldn't reach the price server for the rest",
    `${JSON.stringify(before)} → ${JSON.stringify(now)} | ${msg}`,
  );
}

// A card sheet opens at the top, even right after another sheet was scrolled down.
await page.click('.tab[data-view="search"]');
await page.click('#search-results .tile');
await page.waitForFunction(() => document.querySelector('.headline-price')?.textContent.trim());
await page.$eval('#sheet .sheet-panel', (p) => (p.scrollTop = 99999));
await page.click('.sheet-close');
await page.click('#search-results .tile');
await page.waitForFunction(() => document.querySelector('.headline-price')?.textContent.trim());
const top = await page.evaluate(() => {
  const name = document.querySelector('.detail-name').getBoundingClientRect();
  return { scrollTop: document.querySelector('#sheet .sheet-panel').scrollTop, nameVisible: name.top >= 0 && name.bottom <= innerHeight };
});
await page.click('.sheet-close');
t.check('re-opening a card sheet starts at the top (name and price visible)', top.scrollTop === 0 && top.nameVisible, JSON.stringify(top));

// Live camera path: feed a fake camera stream (needs ffmpeg) and press the shutter.
let haveFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  haveFfmpeg = false;
}
if (haveFfmpeg) {
  const cardPng = path.join(results, 'camera-card.png');
  fs.writeFileSync(cardPng, await makeCard(page, CARDS.charizardEx));
  const y4m = path.join(results, 'camera.y4m');
  // Portrait 1080x1920 frame, card ~940px wide in the middle (where the on-screen guide sits).
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x3b2f25:s=1080x1920:d=1', '-i', cardPng,
    '-filter_complex', '[1]scale=940:-1[c];[0][c]overlay=(W-w)/2:(H-h)/2', '-frames:v', '5', '-pix_fmt', 'yuv420p', y4m]);
  const cam = await startHarness({
    launchArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`],
    contextOptions: { permissions: ['camera'] },
  });
  const p = await cam.newPage();
  await p.click('#btn-start-camera').catch(() => {});
  await p.waitForSelector('#btn-scan:not([disabled])', { timeout: 15000 });
  await p.waitForTimeout(800);
  await p.screenshot({ path: path.join(results, 'camera-view.png') });
  await p.click('#btn-scan');
  await p.waitForFunction(() => document.querySelector('.headline-price')?.textContent.trim(), null, { timeout: 120000 }).catch(() => {});
  const got = await p.evaluate(() => [document.querySelector('.detail-name')?.textContent, document.querySelector('.set-name')?.textContent, document.querySelector('#clue-number')?.value]);
  t.check('live camera scan', got[0] === 'Charizard ex' && got[1] === 'Obsidian Flames', got.join(' | '));
  await p.screenshot({ path: path.join(results, 'camera-result.png') });
  const camErr = cam.errors();
  if (camErr.length) console.log('Camera page errors:\n' + camErr.join('\n'));
  await cam.close();
} else {
  console.log('SKIP  live camera scan (ffmpeg not installed)');
}

const errors = h.errors();
t.check('no page errors', !errors.length, errors.join('\n'));
await h.close();
t.done();
