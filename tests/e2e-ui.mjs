// Small UI behaviours: Stop during a batch pause, toasts that never cover each other
// even when the phone's toolbar hides (clientHeight smaller than the fixed-position area),
// and zoom (the page never zooms; a card picture opens full screen to zoom).
//   CHROMIUM_PATH=… node tests/e2e-ui.mjs
import path from 'node:path';
import { startHarness, makeCard, reporter, CARDS, results } from './harness.mjs';

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

// ---- the page never zooms; a card picture opens full screen and zooms there ----
const lock = await page.evaluate(() => {
  const gesture = new Event('gesturestart', { cancelable: true, bubbles: true });
  document.querySelector('main').dispatchEvent(gesture);
  const touch = (id, x) => new Touch({ identifier: id, target: document.body, clientX: x, clientY: 300 });
  const pinch = new TouchEvent('touchmove', { cancelable: true, bubbles: true, touches: [touch(1, 100), touch(2, 200)] });
  document.querySelector('main').dispatchEvent(pinch);
  return {
    viewport: document.querySelector('meta[name=viewport]').content,
    touchAction: getComputedStyle(document.documentElement).touchAction,
    gestureBlocked: gesture.defaultPrevented,
    pinchBlocked: pinch.defaultPrevented,
  };
});
t.check(
  'the page is locked at its size (no pinch, double-tap or focus zoom)',
  /maximum-scale=1/.test(lock.viewport) && /user-scalable=no/.test(lock.viewport) && lock.touchAction === 'manipulation' && lock.gestureBlocked && lock.pinchBlocked,
  JSON.stringify(lock),
);

await page.evaluate(() => import('/js/sheet.js').then((m) => m.openCard('base1-4')));
await page.waitForFunction(() => document.querySelector('.detail-img')?.naturalWidth > 0);
await page.click('.detail-img');
await page.waitForSelector('.zoom .zoom-img');
const opened = await page.evaluate(() => ({ same: document.querySelector('.zoom-img').src === document.querySelector('.detail-img').src, box: document.querySelector('.zoom').getBoundingClientRect().toJSON() }));
t.check('tapping the card picture opens it full screen', opened.same && opened.box.width === 390 && opened.box.height === 844, JSON.stringify(opened));

const scale = () => page.evaluate(() => +(/scale\(([\d.]+)\)/.exec(document.querySelector('.zoom-img').style.transform)?.[1] ?? 1));
await page.mouse.dblclick(195, 422);
const tapIn = await scale();
await page.mouse.dblclick(195, 422);
const tapOut = await scale();
t.check('a double tap zooms the picture in, another zooms back out', tapIn === 2.5 && tapOut === 1, `in ${tapIn}, out ${tapOut}`);

const pinched = await page.evaluate(() => {
  const z = document.querySelector('.zoom');
  const ev = (type, id, x) => z.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: 422, bubbles: true, isPrimary: id === 1, pointerType: 'touch' }));
  ev('pointerdown', 1, 150);
  ev('pointerdown', 2, 240);
  ev('pointermove', 1, 100);
  ev('pointermove', 2, 290);
  ev('pointerup', 1, 100);
  ev('pointerup', 2, 290);
  return { transform: document.querySelector('.zoom-img').style.transform, open: !!document.querySelector('.zoom') };
});
const pinchScale = +/scale\(([\d.]+)\)/.exec(pinched.transform)?.[1];
t.check('pinching zooms the picture and keeps it open', pinched.open && pinchScale > 2 && pinchScale < 2.2, JSON.stringify(pinched));

await page.keyboard.press('Escape');
const afterEsc = await page.evaluate(() => ({ viewer: !!document.querySelector('.zoom'), sheet: !document.querySelector('#sheet').hidden }));
t.check('Escape closes only the full-screen picture, not the card under it', !afterEsc.viewer && afterEsc.sheet, JSON.stringify(afterEsc));
await page.click('.detail-img');
await page.click('.zoom-close');
t.check('✕ closes the full-screen picture', !(await page.$('.zoom')));
await page.click('.detail-img');
await page.screenshot({ path: path.join(results, 'zoom-viewer.png') });
await page.mouse.click(195, 30); // above the card
t.check('a tap beside the picture closes it', !(await page.$('.zoom')));

const errors = h.errors();
t.check('no page errors', !errors.length, errors.join('\n'));
await h.close();
t.done();
