// End-to-end check of scanning whole phone photos: the card has to be found in the
// picture (carpet / wood / table, turned, tilted, in a toploader with a price sticker
// and glare; also lying sideways or upside down), straightened and identified, in a
// bounded number of OCR passes. Also camera guide crops, and two scans at once sharing
// the OCR worker. Runs the real app + real Tesseract OCR.
//   CHROMIUM_PATH=/opt/pw-browsers/chromium node tests/e2e-photo.mjs
// Extra real photos (kept out of the repo) can be checked too:
//   PHOTOS="/path/aurorus.jpg=me03-024,/path/other.jpg=sv03-125" node tests/e2e-photo.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, reporter, results, CARDS, catalog, makeCard } from './harness.mjs';
import { makePhoto, PHOTOS, cornerError } from './photo-helpers.mjs';

const h = await startHarness();
const t = reporter();
// Log every message to the OCR worker: reads must never interleave.
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

/**
 * identify() on a JPEG in the page, turned by `turns` quarter turns clockwise. Also
 * returns the OCR passes, the statuses shown and which of them were painted.
 */
async function identifyIn(buf, turns = 0) {
  return page.evaluate(
    async ({ b64, turns }) => {
      const { identify } = await import('/js/identify.js');
      const { fileToCanvas } = await import('/js/ocr.js');
      let canvas = await fileToCanvas(await (await fetch(`data:image/jpeg;base64,${b64}`)).blob());
      if (turns % 4) {
        const c = document.createElement('canvas');
        [c.width, c.height] = turns % 2 ? [canvas.height, canvas.width] : [canvas.width, canvas.height];
        const x = c.getContext('2d');
        x.translate(c.width / 2, c.height / 2);
        x.rotate((turns * Math.PI) / 2);
        x.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
        canvas = c;
      }
      const statuses = [];
      const painted = new Set();
      let on = true;
      const watch = () => on && (painted.add(statuses.at(-1)), requestAnimationFrame(watch));
      requestAnimationFrame(watch);
      // Size of every picture OCR'd (reading time grows with it).
      const worker = await (await import('/js/ocr.js')).getWorker();
      if (!worker.__sized) {
        const recognize = worker.recognize.bind(worker);
        worker.recognize = (img, ...rest) => {
          window.__ocrSizes.push(img.width * img.height);
          return recognize(img, ...rest);
        };
        worker.__sized = true;
      }
      window.__ocrSizes = [];
      const log = window.__ocrLog.length;
      const t0 = performance.now();
      const r = await identify(canvas, (m) => statuses.push(m));
      on = false;
      return {
        megapixels: +(Math.max(0, ...window.__ocrSizes) / 1e6).toFixed(2),
        id: r.ranked[0]?.card.id,
        name: r.clues.nameBest,
        number: r.clues.numbers[0]?.text,
        detect: r.debug.detect,
        reads: window.__ocrLog.slice(log).filter((m) => m === 'R').length,
        art: r.clues.artText,
        statuses,
        painted: [...painted],
        seconds: ((performance.now() - t0) / 1000).toFixed(1),
      };
    },
    { b64: buf.toString('base64'), turns },
  );
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
// Each is also read turned sideways both ways and upside down (a top-down shot saved
// with the wrong orientation).
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
  if (!expectId) continue;
  for (const turns of [1, 2, 3]) {
    const r = await identifyIn(buf, turns);
    t.check(`real photo ${path.basename(file)} turned ${turns * 90}° is ${expectId} (${r.seconds}s, ${r.reads} OCR passes)`, r.id === expectId, JSON.stringify(r));
  }
}

// 5) Cards lying sideways, steeply turned or upside down in a photo. A sideways card's
// artwork edge splits it into two upright card-shaped halves: the whole card must still
// be found and read the right way round, in a bounded number of OCR passes.
{
  const want = { charizardEx: 'sv03-125', baseCharizard: 'base1-4', mewtwo30th: '30th-157', aurorus: 'me03-024' };
  const turned = [
    ['aurorus', { rotate: 90, background: 'carpet' }],
    ['charizardEx', { rotate: -90, background: 'wood' }],
    ['baseCharizard', { rotate: 90, background: 'table' }],
    ['charizardEx', { rotate: 52, background: 'carpet' }],
    ['aurorus', { rotate: -62, background: 'wood' }],
    ['charizardEx', { rotate: -90, background: 'table', width: 2016, height: 1512, fill: 0.33 }],
    ['aurorus', { rotate: 180, background: 'carpet' }],
    ['baseCharizard', { rotate: 176, background: 'wood', toploader: true }],
  ];
  for (const [card, spec] of turned) {
    const photo = await makePhoto(page, CARDS[card], { seed: 3, fill: 0.45, ...spec });
    const label = `${card} turned ${spec.rotate}° on ${spec.background}${spec.width > spec.height ? ' (landscape photo)' : ''}${spec.toploader ? ' in a toploader' : ''}`;
    const r = await identifyIn(photo.buffer);
    if (r.id !== want[card]) fs.writeFileSync(path.join(results, `photo-${label.replace(/\W+/g, '-')}.jpg`), photo.buffer);
    t.check(`identifies ${label} (${r.seconds}s, ${r.reads} OCR passes)`, r.id === want[card] && r.reads <= 10, JSON.stringify(r));
  }
}

// 6) Reading cost: a photo with nothing readable gives up quickly (no as-is read of the
// whole photo as if it were the card, no stamp read), and the status is painted before
// the card is looked for.
{
  const empty = await makePhoto(page, CARDS.aurorus, { noCard: true, background: 'carpet' });
  const r = await identifyIn(empty.buffer);
  t.check(`photo with no card: at most 3 OCR passes (${r.reads}, ${r.seconds}s)`, r.reads <= 3 && !r.art && !r.statuses.includes('Checking for stamps…'), JSON.stringify(r));
  // A phone camera's 12-megapixel photo: the whole picture is read shrunk (it took over a
  // minute at full size, 6.75 megapixels once loaded).
  const big = await makePhoto(page, CARDS.aurorus, { noCard: true, background: 'carpet', width: 3024, height: 4032 });
  const rb = await identifyIn(big.buffer);
  t.check(`phone-size photo with no card gives up in ${rb.seconds}s: ${rb.reads} OCR passes, none over 2.6 megapixels (${rb.megapixels})`, rb.reads <= 3 && rb.megapixels <= 2.6, JSON.stringify(rb));
  // An upright card whose name and number can't be read (a sticker over the name, no
  // number printed): after the card's own areas, the whole photo is read shrunk too (it
  // was read at full size, 3 megapixels here). The number areas read nothing, so their
  // number spots are read too, for black and for white text (two small passes).
  const covered = await makePhoto(page, { ...CARDS.charizardEx, bottomLeft: 'G  OBF EN' }, { ...PHOTOS.flat, sticker: 'name' });
  const rc = await identifyIn(covered.buffer);
  t.check(`card with its name and number covered gives up in ${rc.reads} OCR passes, none over 2 megapixels (${rc.megapixels}, ${rc.seconds}s)`, rc.reads <= 11 && rc.megapixels <= 2.1, JSON.stringify(rc));
  const photo = await makePhoto(page, CARDS.mewtwo30th, PHOTOS.flat);
  const m = await identifyIn(photo.buffer);
  t.check('"Finding the card…" is shown before the card is looked for', m.id === '30th-157' && m.painted.includes('Finding the card…'), JSON.stringify(m));
  // The user may pick another match (or re-match) that has stamped versions: the artwork
  // text is there for that even when the best match is never stamped.
  t.check('the stamp area is read for a card printed without stamps too', m.statuses.includes('Checking for stamps…') && typeof m.art === 'string' && m.reads <= 3, JSON.stringify(m));
}

// 7) Camera guide crops: a card filling the guide is read as is (name + number + stamp
// area, no "Finding the card…" wait); upside down in the guide still reads. A card held
// further away, filling 65% of the guide's width, is straightened first instead of
// being read as is, turned around and only then looked for (9 passes).
{
  const png = await makeCard(page, CARDS.charizardEx);
  for (const [upsideDown, k] of [[false, 1], [true, 1], [false, 0.67], [true, 0.67]]) {
    const r = await page.evaluate(
      async ({ b64, upsideDown, k }) => {
        const { captureGuide } = await import('/js/ocr.js');
        const { identify } = await import('/js/identify.js');
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        // A fake camera: the card drawn into a canvas stream, the guide over its middle.
        const src = document.createElement('canvas');
        [src.width, src.height] = [720, 1280];
        const g = src.getContext('2d');
        const draw = () => {
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.fillStyle = '#3b2f25';
          g.fillRect(0, 0, 720, 1280);
          g.translate(360, 640);
          if (upsideDown) g.rotate(Math.PI);
          g.drawImage(img, -320 * k, -447 * k, 640 * k, 894 * k);
        };
        draw();
        const stream = src.captureStream();
        const video = document.createElement('video');
        Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '360px', height: '640px', objectFit: 'cover' });
        const guide = document.createElement('div');
        Object.assign(guide.style, { position: 'fixed', left: '15px', top: '91px', width: '330px', height: '461px' });
        document.body.append(video, guide);
        video.muted = true;
        video.srcObject = stream;
        video.play();
        for (let i = 0; i < 100 && !(video.videoWidth && video.readyState >= 2); i++) {
          draw();
          await new Promise((r) => setTimeout(r, 30));
        }
        const crop = captureGuide(video, guide);
        video.remove();
        guide.remove();
        stream.getTracks().forEach((tr) => tr.stop());
        const statuses = [];
        const log = window.__ocrLog.length;
        const res = await identify(crop, (m) => statuses.push(m));
        return { id: res.ranked[0]?.card.id, size: `${crop.width}x${crop.height}`, detect: res.debug.detect, reads: window.__ocrLog.slice(log).filter((m) => m === 'R').length, statuses };
      },
      { b64: png.toString('base64'), upsideDown, k },
    );
    const max = upsideDown ? 8 : 3; // name + number + the stamp area
    const what = `camera guide crop${k < 1 ? `, card ${Math.round(k * 97)}% of the guide` : ''}${upsideDown ? ', card upside down,' : ''}`;
    t.check(`${what} is read in ${r.reads} OCR passes`, r.id === 'sv03-125' && r.reads <= max && !r.statuses.includes('Finding the card…'), JSON.stringify(r));
  }
}

// 7b) Full-art cards print the number in white on dark artwork: it is read too, in a
// bounded number of passes.
{
  const plain = await makeCard(page, { ...CARDS.charizardEx, bottomLeft: '' });
  const png = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    [c.width, c.height] = [img.width, img.height];
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    g.scale(c.width / 630, c.height / 880);
    // Dark artwork behind the bottom line, the number in white with a dark outline.
    const art = g.createLinearGradient(0, 790, 630, 860);
    art.addColorStop(0, '#2a1d3f');
    art.addColorStop(1, '#4b2d2a');
    g.fillStyle = art;
    g.fillRect(22, 790, 586, 68);
    g.font = 'italic bold 17px sans-serif';
    g.lineWidth = 3;
    g.strokeStyle = '#111';
    g.fillStyle = '#fff';
    g.strokeText('G  OBF EN  125/197 ★', 50, 840);
    g.fillText('G  OBF EN  125/197 ★', 50, 840);
    return c.toDataURL('image/png').split(',')[1];
  }, plain.toString('base64'));
  const photo = await makePhoto(page, CARDS.charizardEx, { ...PHOTOS.flat, cardImage: Buffer.from(png, 'base64') });
  const r = await identifyIn(photo.buffer);
  t.check(`a full-art card's white number is read (${r.number}, ${r.reads} OCR passes)`, r.id === 'sv03-125' && r.number === '125/197' && r.reads <= 6, JSON.stringify(r));
}

// 8) Two scans at once (Batch processing while scanning a card): every read keeps its
// own OCR mode, so each gives exactly what it gives alone.
{
  const png = await makeCard(page, CARDS.aurorus);
  const r = await page.evaluate(async (b64) => {
    const { readRegion, NAME_REGION } = await import('/js/ocr.js');
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const card = document.createElement('canvas');
    [card.width, card.height] = [img.width, img.height];
    card.getContext('2d').drawImage(img, 0, 0);
    const sparse = (await readRegion(card, NAME_REGION, { psm: 11 })).text;
    const block = (await readRegion(card, NAME_REGION, { psm: 6 })).text;
    const log = window.__ocrLog.length;
    const [a, b] = await Promise.all([readRegion(card, NAME_REGION, { psm: 11 }), readRegion(card, NAME_REGION, { psm: 6 })]);
    return { sparse, block, a: a.text, b: b.text, log: window.__ocrLog.slice(log).join(' ') };
  }, png.toString('base64'));
  t.check('two reads at once keep their own OCR mode', r.a === r.sparse && r.b === r.block && r.log === 'P11 R P6 R', JSON.stringify(r));
}

// Tesseract's own complaints about blank or tiny areas (a sticker, a bare photo) aren't page errors.
const errors = h.errors().filter((l) => !/^error: (Image too small to scale|Line cannot be recognized|Error in (boxClipToRectangle|pixScanForForeground))/.test(l));
t.check('no page errors', !errors.length, errors.join('\n'));
await h.close();
t.done();
