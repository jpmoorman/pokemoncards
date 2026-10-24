// Keeping saved cards safe (Saved tab): Export backup / Import backup of the collection and the
// trade, the one-time Add to Home Screen tip in a Safari tab, the one-time import offer in a
// Home Screen app that's still empty, and asking the browser to keep the storage.
//   CHROMIUM_PATH=… node tests/e2e-backup.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, stubNetwork, reporter, results } from './harness.mjs';

const h = await startHarness();
const t = reporter();
const entry = (id, name, value, qty = 1) => ({
  id, name, setId: id.split('-')[0], setName: 'Test Set', number: '1/100', variant: 'Holo', variantId: 'holo', image: '', fallbackImage: '',
  price: { value, currency: 'USD', source: 'TCGplayer market', converted: false }, qty, added: Date.now(),
});
const COLLECTION = [entry('sv03-125', 'Charizard ex', 5.28, 2), entry('base1-4', 'Charizard', 954.65)];
const TRADE = { give: [entry('me03-024', 'Aurorus', 0.15)], get: [entry('sv03-215', 'Charizard ex', 30)], rate: 90, rateSide: 'give' };

/** A page in a fresh browser profile; mode: 'desktop' | 'safari-tab' | 'home-screen'; seed: saved data before start. */
async function open(mode, seed = null) {
  const context = await h.browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await stubNetwork(context, h.origin);
  await context.addInitScript(([mode, seed]) => {
    if (mode !== 'desktop') {
      Object.defineProperty(Navigator.prototype, 'standalone', { get: () => mode === 'home-screen', configurable: true });
      Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5, configurable: true });
    }
    // Count the requests to keep this site's storage.
    window.persistAsked = 0;
    if (navigator.storage) {
      navigator.storage.persisted = async () => false;
      navigator.storage.persist = async () => (window.persistAsked++, true);
    }
    if (seed && !sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, JSON.stringify(v));
    }
  }, [mode, seed]);
  const page = await context.newPage();
  page.on('pageerror', (e) => h.logs.push(`pageerror: ${e.message}`));
  await page.goto(`${h.origin}/index.html`);
  await page.waitForFunction(() => window.cardScanner?.catalog?.index, null, { timeout: 30000 });
  return { context, page };
}
const saved = (page) =>
  page.evaluate(() => ({
    names: [...document.querySelectorAll('#collection-list .c-name')].map((n) => n.textContent),
    total: document.querySelector('#collection-total').textContent,
    tip: !document.querySelector('#tip-home-screen').hidden,
    hint: !document.querySelector('#import-hint').hidden,
  }));
const toastText = (page) => page.waitForSelector('.toast', { timeout: 5000 }).then((n) => n.textContent()).catch(() => '');

// ---- export: from a Safari tab with saved cards ----
const tab = await open('safari-tab', { 'collection.v1': COLLECTION, 'trade.v1': TRADE });
await tab.page.click('.tab[data-view="collection"]');
let s = await saved(tab.page);
t.check('Safari tab with saved cards: the Add to Home Screen tip shows in Saved', s.tip && /Add to Home Screen/.test(await tab.page.textContent('#tip-home-screen')), JSON.stringify(s));
t.check('the browser is asked to keep the storage at start-up (cards are saved)', (await tab.page.evaluate(() => window.persistAsked)) === 1);
const [download] = await Promise.all([tab.page.waitForEvent('download'), tab.page.click('#btn-backup-export')]);
const file = path.join(results, download.suggestedFilename());
await download.saveAs(file);
const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
t.check(
  'Export backup: a JSON file with the collection and the trade',
  /^pokemon-cards-backup-\d{4}-\d\d-\d\d\.json$/.test(download.suggestedFilename()) && backup.app === 'pokemon-card-scanner' && backup.collection.length === 2 && backup.trade.give[0].name === 'Aurorus' && backup.trade.rate === 90,
  `${download.suggestedFilename()} ${JSON.stringify(backup).slice(0, 160)}`,
);
s = await saved(tab.page);
await tab.page.reload();
await tab.page.click('.tab[data-view="collection"]');
t.check('the tip goes once a backup is exported, for good', !s.tip && !(await saved(tab.page)).tip);
await tab.context.close();

// ---- the tip: "Got it", and not without saved cards or outside Safari ----
const tab2 = await open('safari-tab', { 'collection.v1': COLLECTION });
await tab2.page.click('.tab[data-view="collection"]');
await tab2.page.click('#tip-home-screen-ok');
const gone = !(await saved(tab2.page)).tip;
await tab2.page.reload();
await tab2.page.click('.tab[data-view="collection"]');
t.check('"Got it" hides the tip for good', gone && !(await saved(tab2.page)).tip);
await tab2.context.close();
const emptyTab = await open('safari-tab');
await emptyTab.page.click('.tab[data-view="collection"]');
t.check('no tip in a Safari tab with nothing saved; storage not asked for yet', !(await saved(emptyTab.page)).tip && (await emptyTab.page.evaluate(() => window.persistAsked)) === 0);
await emptyTab.context.close();
const desk = await open('desktop', { 'collection.v1': COLLECTION });
await desk.page.click('.tab[data-view="collection"]');
s = await saved(desk.page);
t.check('no tip outside Safari on iPhone', !s.tip && !s.hint);
await desk.context.close();

// ---- the Home Screen app, empty: offers the import once ----
const app = await open('home-screen');
const offer = await app.page.waitForSelector('.toast-action:has-text("Moving from Safari?")', { timeout: 6000 }).catch(() => null);
const hint = (await saved(app.page)).hint && /Export backup/.test(await app.page.textContent('#import-hint'));
t.check('Home Screen app with nothing saved: offers to import a backup (once, and in Saved)', !!offer && hint);
const [chooser] = await Promise.all([app.page.waitForEvent('filechooser'), app.page.click('.toast-action:has-text("Moving from Safari?") button')]);
await chooser.setFiles(file);
await app.page.waitForFunction(() => document.querySelectorAll('#collection-list .citem').length === 2);
const imported = await toastText(app.page);
s = await saved(app.page);
await app.page.click('.tab[data-view="trade"]');
const tradeText = await app.page.textContent('#view-trade');
t.check(
  'Import from the offer: collection and trade restored',
  s.names.join() === 'Charizard ex,Charizard' && s.total === '$965.21' && /Aurorus/.test(tradeText) && /Charizard ex/.test(tradeText) && /Imported 3 cards and your trade/.test(imported),
  `${JSON.stringify(s)} | toast "${imported}"`,
);
t.check('… and the browser is asked to keep the storage', (await app.page.evaluate(() => window.persistAsked)) >= 1);
await app.page.reload();
await app.page.waitForFunction(() => window.cardScanner?.catalog?.index);
await app.page.waitForTimeout(2500);
t.check('the import offer comes only once', !(await app.page.$('.toast-action:has-text("Moving from Safari?")')));

// ---- importing over saved cards asks first; bad files are refused ----
await app.page.click('.tab[data-view="collection"]');
await app.page.click('#collection-list .citem:first-child [aria-label="Add one"]'); // 3 copies now
await app.page.setInputFiles('#backup-file', file);
const ask = await app.page.waitForSelector('.modal', { timeout: 5000 }).then((n) => n.textContent()).catch(() => '');
await app.page.click('.modal .btn:has-text("Cancel")');
const kept = await saved(app.page);
await app.page.setInputFiles('#backup-file', file);
await app.page.click('.modal .btn:has-text("Replace")');
await app.page.waitForFunction(() => document.querySelector('#collection-total').textContent === '$965.21');
t.check(
  'importing over saved cards asks first (Cancel keeps them, Replace restores the backup without doubling)',
  /Replace the 4 cards saved here and your current trade with the backup's 3 cards and a trade\?/.test(ask) && kept.total === '$970.49' && (await saved(app.page)).names.length === 2,
  `"${ask}" kept ${kept.total}`,
);
// A backup with only a trade in it (exported with no saved cards) replaces only the trade.
const tradeOnly = await app.page.evaluate(async (trade) => JSON.stringify((await import('/js/backup.js')).makeBackup([], trade)), { give: [entry('base1-58', 'Pikachu', 3)], get: [], rate: 100, rateSide: 'give' });
await app.page.setInputFiles('#backup-file', { name: 'trade.json', mimeType: 'application/json', buffer: Buffer.from(tradeOnly) });
const askTrade = await app.page.waitForSelector('.modal', { timeout: 5000 }).then((n) => n.textContent()).catch(() => '');
await app.page.click('.modal .btn:has-text("Replace")');
const tradeToast = await toastText(app.page);
const afterTrade = await saved(app.page);
await app.page.click('.tab[data-view="trade"]');
const trade2 = await app.page.textContent('#view-trade');
await app.page.click('.tab[data-view="collection"]');
t.check(
  'a backup with only a trade replaces the trade and keeps the saved cards',
  /Replace your current trade with the backup's trade\?/.test(askTrade) && /Imported your trade/.test(tradeToast) && afterTrade.total === '$965.21' && afterTrade.names.length === 2 && /Pikachu/.test(trade2) && !/Aurorus/.test(trade2),
  `"${askTrade}" "${tradeToast}" ${JSON.stringify(afterTrade)}`,
);
await app.page.setInputFiles('#backup-file', { name: 'other.json', mimeType: 'application/json', buffer: Buffer.from('{"cards": []}') });
const refused = await toastText(app.page);
await app.page.setInputFiles('#backup-file', { name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('not json') });
await app.page.waitForTimeout(300);
const refused2 = await toastText(app.page);
t.check('a file that is not a backup is refused, nothing changes', /isn't a backup from this app/.test(refused) && /isn't a backup from this app/.test(refused2) && (await saved(app.page)).names.length === 2, `"${refused}" / "${refused2}"`);
await app.page.screenshot({ path: path.join(results, 'backup-saved-tab.png'), fullPage: true });
const tipPage = await open('safari-tab', { 'collection.v1': COLLECTION });
await tipPage.page.click('.tab[data-view="collection"]');
await tipPage.page.screenshot({ path: path.join(results, 'backup-tip.png'), fullPage: true });
await tipPage.context.close();
await app.context.close();

const errors = h.errors();
t.check('no page errors', !errors.length, errors.join('\n'));
await h.close();
t.done();
