// Small UI behaviours: Stop during a batch pause, and toasts that never cover each other
// even when the phone's toolbar hides (clientHeight smaller than the fixed-position area).
//   CHROMIUM_PATH=… node tests/e2e-ui.mjs
import { startHarness, makeCard, reporter, CARDS } from './harness.mjs';

const h = await startHarness();
const t = reporter();
const page = await h.newPage();
const png = async (spec) => ({ name: 'card.png', mimeType: 'image/png', buffer: await makeCard(page, spec) });

// ---- Stop works while batch processing is paused for a scan ----
await page.setInputFiles('#file-input-library', [await png(CARDS.charizardEx), await png(CARDS.baseCharizard), await png(CARDS.aurorus)]);
await page.waitForSelector('#view-batch.active');
await page.waitForSelector('#batch-process');
await page.evaluate(() => document.dispatchEvent(new CustomEvent('scan:busy', { detail: { busy: true } })));
await page.click('#batch-process');
await page.waitForFunction(() => /Paused while your scan/.test(document.querySelector('#batch-progress-msg')?.textContent || ''), null, { timeout: 30000 });
await page.click('#batch-stop');
const stoppedQuickly = await page
  .waitForFunction(() => !document.querySelector('#batch-stop'), null, { timeout: 2500 })
  .then(() => true, () => false);
const statuses = await page.$$eval('#view-batch .bitem', (ns) => ns.map((n) => n.className));
t.check('Stop takes effect while paused for a scan (scan still running)', stoppedQuickly && statuses.every((c) => !/matched|processing/.test(c)), statuses.join(' | '));
await page.evaluate(() => document.dispatchEvent(new CustomEvent('scan:busy', { detail: { busy: false } })));

// ---- toasts stack by their own size, not the viewport height ----
const layout = await page.evaluate(async () => {
  const ui = await import('/js/ui.js');
  // Phone toolbar hidden: the reported clientHeight is shorter than the fixed-position area.
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, get: () => window.innerHeight - 56 });
  ui.actionToast('Deleted photo 1', 'Undo', () => {}, { ms: 4000 });
  ui.toast('Added to collection', 4000);
  const box = (sel) => document.querySelector(sel).getBoundingClientRect();
  const undo = box('.toast[data-action]');
  const msg = box('.toast[data-plain]');
  const overlap = !(msg.bottom <= undo.top || msg.top >= undo.bottom);
  // The Undo button stays tappable: the element at its centre is the button itself.
  const btn = document.querySelector('.toast[data-action] button').getBoundingClientRect();
  const hit = document.elementFromPoint(btn.left + btn.width / 2, btn.top + btn.height / 2);
  const tappable = hit?.tagName === 'BUTTON';
  // When the Undo toast goes, the message drops back to its normal place.
  document.querySelector('.toast[data-action] button').click();
  const after = document.querySelector('.toast[data-plain]').style.bottom;
  return { overlap, tappable, after, undo: [undo.top, undo.bottom], msg: [msg.top, msg.bottom] };
});
t.check('a message never covers the Undo toast, even with the phone toolbar hidden', !layout.overlap && layout.tappable, JSON.stringify(layout));
t.check('the message returns to its normal place when the Undo toast goes', layout.after === '', JSON.stringify(layout));

const errors = h.errors();
t.check('no page errors', !errors.length, errors.join('\n'));
await h.close();
t.done();
