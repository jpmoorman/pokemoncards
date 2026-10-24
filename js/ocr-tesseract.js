// Fallback text reader: Tesseract.js, for browsers that can't run the PP-OCR models (no
// WebAssembly SIMD, or its runtime won't start; the app as a whole needs iOS 16.4 or newer,
// which has SIMD). Loaded by ocr.js only then, so it downloads Tesseract (~4.5 MB from
// jsDelivr, kept by the browser's cache, not the app's) only on those phones. Same results as
// ocr.js's readCard/readStamps.
import { parseBottomText, parseLabelNumbers, pickName } from './parse.js';
import { NAME_REGION, NUMBER_REGIONS, NUMBER_SPOTS, STAMP_REGION, KNOWN, cardViews, numberFound, mergeBottom, setSizes, nextPaint } from './ocr.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.crossOrigin = 'anonymous';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the text-recognition engine. Check your connection.'));
    document.head.appendChild(s);
  });
}

let workerPromise = null;
let progressCb = null;

/** Lazily create one shared Tesseract worker (downloads ~5 MB once, then cached by the browser). */
export function getWorker(onProgress) {
  if (onProgress) progressCb = onProgress;
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript(window.TESSERACT_URL || TESSERACT_URL);
      const opts = { logger: (m) => progressCb?.(m), ...(window.TESSERACT_PATHS || {}) };
      return window.Tesseract.createWorker('eng', 1, opts);
    })();
    workerPromise.catch(() => {
      workerPromise = null;
    });
  }
  return workerPromise;
}

// ---------- image prep ----------

/**
 * Crop a region (fractions) and scale it so its width is ~targetW px (never shrunk, at
 * most 4× enlarged), or shrunk to `maxPixels` if it would be bigger.
 */
function crop(src, r, targetW, maxPixels = Infinity) {
  const sx = Math.round(src.width * r.x);
  const sy = Math.round(src.height * r.y);
  const sw = Math.max(1, Math.round(src.width * r.w));
  const sh = Math.max(1, Math.round(src.height * r.h));
  const scale = Math.min(4, Math.max(1, targetW / sw), Math.sqrt(maxPixels / (sw * sh)));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

/**
 * Grayscale, flatten the lighting (divide by the local background brightness, so
 * dark text reads the same on a light border, a grey-blue name bar or next to a
 * white sticker), then contrast stretch (1st–99th percentile). `invert` turns
 * light-on-dark text into dark-on-light first. `text: 'black'` reads only black text:
 * every colour but black turns light (a pixel counts as bright as its brightest channel);
 * `text: 'white'` (inverted) only white text, every colour but white turning dark.
 */
function enhance(canvas, invert = false, { text } = {}) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const w = canvas.width;
  const h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const g = new Float32Array(w * h);
  const pick = text === 'black' ? Math.max : text === 'white' ? Math.min : null;
  for (let i = 0; i < g.length; i++) {
    const v = pick ? pick(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) : (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
    g[i] = invert ? 255 - v : v;
  }
  flattenLight(g, w, h);
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i] | 0]++;
  const n = g.length;
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255 && (acc += hist[lo]) < n * 0.01; lo++);
  for (let acc = 0; hi > 0 && (acc += hist[hi]) < n * 0.01; hi--);
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < g.length; i++) {
    let v = ((g[i] - lo) * 255) / range;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * In place: g = 255 * g / background, where background is the brightest nearby
 * value (block maximum, spread over neighbouring blocks and smoothed). Blocks are
 * bigger than a letter stroke so text never counts as background.
 */
function flattenLight(g, w, h) {
  const B = Math.max(16, Math.round(Math.min(w, h) / 12));
  const bw = Math.ceil(w / B);
  const bh = Math.ceil(h / B);
  const bmax = new Float32Array(bw * bh);
  for (let y = 0; y < h; y++) {
    const r = ((y / B) | 0) * bw;
    for (let x = 0; x < w; x++) {
      const k = r + ((x / B) | 0);
      if (g[y * w + x] > bmax[k]) bmax[k] = g[y * w + x];
    }
  }
  const spread = (src, op) => {
    const out = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let m = 0;
        let s = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy < 0 || xx < 0 || yy >= bh || xx >= bw) continue;
            const v = src[yy * bw + xx];
            if (v > m) m = v;
            s += v;
            n++;
          }
        }
        out[y * bw + x] = op === 'max' ? m : s / n;
      }
    }
    return out;
  };
  const bg = spread(spread(bmax, 'max'), 'mean');
  for (let y = 0; y < h; y++) {
    const fy = Math.min(bh - 1, Math.max(0, y / B - 0.5));
    const y0 = fy | 0;
    const y1 = Math.min(bh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(bw - 1, Math.max(0, x / B - 0.5));
      const x0 = fx | 0;
      const x1 = Math.min(bw - 1, x0 + 1);
      const tx = fx - x0;
      const b =
        (bg[y0 * bw + x0] * (1 - tx) + bg[y0 * bw + x1] * tx) * (1 - ty) + (bg[y1 * bw + x0] * (1 - tx) + bg[y1 * bw + x1] * tx) * ty;
      const v = (255 * g[y * w + x]) / Math.max(8, b);
      g[y * w + x] = v > 255 ? 255 : v;
    }
  }
}

/**
 * In place, on an enhanced (grey) canvas: dark text printed with a light outline on dark
 * artwork (the numbers and illustrator of special-art cards) read as dark letters cut out
 * on white. Only dark areas the light outlines close off from the picture's edges stay
 * dark: the artwork around them, which reaches an edge, turns white. Plain dark text on a
 * light background stays as it is; light text on dark is lost (read it inverted instead).
 */
function fillOutlined(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const w = canvas.width;
  const h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  // Dark is below the Otsu threshold of the picture.
  const hist = new Float64Array(256);
  for (let i = 0; i < d.length; i += 4) hist[d[i]]++;
  const n = w * h;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let below = 0;
  let sumBelow = 0;
  let best = -1;
  let t = 127;
  for (let v = 0; v < 255; v++) {
    below += hist[v];
    sumBelow += v * hist[v];
    if (!below || below === n) continue;
    const between = below * (n - below) * (sumBelow / below - (sum - sumBelow) / (n - below)) ** 2;
    if (between > best) [best, t] = [between, v];
  }
  // Flood the dark areas that touch an edge (4-connected: a gap at a corner of an outline
  // doesn't let the artwork in).
  const out = new Uint8Array(n); // 1 = dark, 2 = dark and reached from an edge
  for (let i = 0; i < n; i++) out[i] = d[i * 4] <= t ? 1 : 0;
  const todo = [];
  const reach = (i) => {
    if (out[i] === 1) {
      out[i] = 2;
      todo.push(i);
    }
  };
  for (let x = 0; x < w; x++) reach(x), reach(n - w + x);
  for (let y = 0; y < h; y++) reach(y * w), reach(y * w + w - 1);
  while (todo.length) {
    const i = todo.pop();
    const x = i % w;
    if (x > 0) reach(i - 1);
    if (x < w - 1) reach(i + 1);
    if (i >= w) reach(i - w);
    if (i < n - w) reach(i + w);
  }
  for (let i = 0; i < n; i++) d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = out[i] === 1 ? 0 : 255;
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Pictures one under the other on white, `gap` px apart. */
function stack(canvases, gap = 30) {
  const c = document.createElement('canvas');
  c.width = Math.max(...canvases.map((k) => k.width));
  c.height = canvases.reduce((h, k) => h + k.height, 0) + gap * (canvases.length - 1);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  let y = 0;
  for (const k of canvases) {
    ctx.drawImage(k, 0, y);
    y += k.height + gap;
  }
  return c;
}

// ---------- text recognition ----------

// The page-segmentation mode is worker-wide state, so each read sets it and recognizes
// while holding the shared worker: a live scan and a batch run take turns read by read
// instead of switching each other's mode in between.
let workerTurn = Promise.resolve();

function withWorker(job) {
  const run = workerTurn.then(() => getWorker()).then(job);
  workerTurn = run.catch(() => {});
  return run;
}

// Tesseract's thresholding: 0 = one threshold for the whole picture (Otsu), 2 = one per tile
// (adaptive Otsu), which keeps small dark text on a mid-grey patch next to a light border.
async function recognize(canvas, psm, { adaptive = false } = {}) {
  const data = await withWorker(async (worker) => {
    await worker.setParameters({ tessedit_pageseg_mode: String(psm), preserve_interword_spaces: '1', thresholding_method: adaptive ? '2' : '0' });
    return (await worker.recognize(canvas, {}, { text: true, blocks: true })).data;
  });
  const lines = [];
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        // Use the median word height: robust to one odd glyph stretching the line box.
        const hs = (l.words || []).map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
        const height = hs.length ? hs[hs.length >> 1] : l.bbox.y1 - l.bbox.y0;
        lines.push({ text: l.text.trim(), height, conf: l.confidence, y: l.bbox.y0 });
      }
    }
  }
  return { text: data.text || '', lines };
}

/** Text on the lower artwork, where set logos, 1st Edition and other stamps sit (for stamps.js). */
export async function readStamps(card) {
  const res = await recognize(enhance(crop(card, STAMP_REGION, 1400)), 11);
  return res.text.replace(/\n\s*\n/g, '\n').trim();
}

/** OCR confidence of the clearest line with some real text in it (0 when none). */
function legible(lines, re) {
  return Math.max(0, ...lines.filter((l) => re.test(l.text)).map((l) => l.conf));
}

/**
 * Name-area OCR (sparse text), black text only: the coloured name bar turns light.
 * `conf`: how clearly it read, see legible.
 */
async function readName(card, ocr) {
  const res = await ocr(enhance(crop(card, NAME_REGION, 1600), false, { text: 'black' }), 11);
  return { name: pickName(res.lines), text: res.text, lines: res.lines, conf: legible(res.lines, /[A-Za-z]{3}/), card };
}

/**
 * A name read that isn't exactly a known card name, read again as one block of text
 * (sparse-text mode gets lost on some name bars) in plain grey (white names, and black ones
 * the black-text clean-up nicked a letter of). Whichever read's name line matches a known
 * card name better is kept. `match(text)`: how well text matches a known name (0–1), or
 * undefined when that can't be told yet (catalog not loaded: any name read is kept).
 */
async function nameAgain(r, ocr, match) {
  const m = match(r.name.best);
  if (m === undefined ? r.name.best || r.text.trim() : Math.max(m, match(r.text)) >= 1) return r;
  const again = await ocr(enhance(crop(r.card, NAME_REGION, 1600)), 6);
  const n2 = pickName(again.lines);
  const known = (t) => (match(t) === undefined ? !!t : match(t) >= KNOWN);
  const better = match(n2.best) > m || (!known(r.name.best) && !known(r.text) && (known(again.text) || !r.name.best));
  return { ...r, name: better ? n2 : r.name, text: `${r.text}\n---block---\n${again.text}`, lines: [...r.lines, ...again.lines] };
}

/**
 * Number areas (or spots) of a card, each enlarged to `width` and cleaned up for `text`:
 * 'black', 'white' (inverted) or 'outlined' (dark text in a light outline, see fillOutlined).
 */
function numberAreas(card, regions, width, text) {
  return regions.map((r) => {
    const c = enhance(crop(card, r, width), text === 'white', { text: text === 'white' ? 'white' : 'black' });
    return text === 'outlined' ? fillOutlined(c) : c;
  });
}

/** Number-area OCR (collector number, set code), as one block of text. */
async function readBottom(card, ocr) {
  const res = await ocr(stack(numberAreas(card, NUMBER_REGIONS, 1400, 'black')), 6, { adaptive: true });
  return { bottom: parseBottomText(res.text, { totals: setSizes() }), text: res.text, conf: legible(res.lines, /[A-Za-z0-9]{3}/), card };
}

/**
 * A bottom read without a number with a known set size (or a promo's): the number spots
 * alone, with less around them to get lost in, black and outlined text (special-art cards)
 * in one go (`kinds` 'spots'); then white text (full-art cards, 'white').
 */
async function bottomAgain(r, ocr, kinds = ['spots', 'white']) {
  const reads = { spots: ['black', 'outlined'], white: ['white'] };
  for (const kind of kinds) {
    if (numberFound(r.bottom)) break;
    const texts = reads[kind];
    const res = await ocr(stack(texts.flatMap((t) => numberAreas(r.card, NUMBER_SPOTS, 900, t))), 6, { adaptive: true });
    r = { ...r, bottom: mergeBottom(r.bottom, parseBottomText(res.text, { totals: setSizes() })), text: `${r.text}\n---${kind}---\n${res.text}` };
  }
  return r;
}

// Telling which way up a card is from its first read (OCR confidences, see readCard):
// with a bottom line reading at `bottom` or more and a name area at `name` or more it is
// the right way up; with a bottom line at `sureBottom` or more it is turned only for a name
// that reads clearly that way. On 43 real photos read both ways round, no upside-down read
// met the first, and two the second (both with a clearly read name when turned). Else the
// other way round wins with a bottom line reading at `turnBottom` or more (the first's
// below it; 6 in 268 cards read upside down got there, 201 the right way up), or with
// clearly higher confidences (`margin` more, bottom and name added up).
const UPRIGHT = { name: 60, bottom: 80, sureBottom: 85, turnBottom: 70, margin: 20 };
// A whole photo is OCR'd at most this big: reading time grows with the picture (a 12-megapixel
// phone photo with no card found took over a minute at full size). With no card outline it
// is the main read (2.6 MP keeps a 1600 × 1600 photo whole); after the card's own areas
// read nothing usable it is a last try that rarely finds anything, and some pictures take
// half a minute at 2.5 MP.
const PICTURE_PIXELS = { main: 2.6e6, last: 2e6 };

/** Read a card image with Tesseract: same arguments and result as ocr.js's readCard. */
export async function readCard(canvas, onStatus, opts = {}) {
  const debug = { name: '', bottom: '', full: '', detect: '', reads: 0, steps: [], engine: 'tesseract' };
  const ocr = (img, psm, o) => {
    debug.reads++;
    return recognize(img, psm, o);
  };
  const seen = new Map();
  const lookup = (text) => {
    if (!opts.findName || !text) return undefined;
    if (!seen.has(text)) seen.set(text, opts.findName(text));
    return seen.get(text);
  };
  const isKnown = (text, min = KNOWN) => {
    const k = lookup(text);
    return k === undefined ? !!text : !!k && k.score >= min;
  };
  // How well text matches a known card name, 0–1 (undefined: can't tell, the card list
  // isn't in yet).
  const match = (text) => (!opts.findName || opts.findName('') === undefined ? undefined : lookup(text)?.score || 0);
  // OCR of upside-down or sideways text can pass for a short name with a letter or two
  // off; read the right way up, names nearly always come out whole.
  const isSure = (text) => isKnown(text, 0.9);
  // Text the right way up mostly reads with OCR confidence well above 75, upside-down or
  // sideways text below it: a known name read that clearly is the card the right way up.
  // Only the name line, or a line that read clearly, counts: somewhere in the junk
  // upside-down text reads as, a short name ("Dana", "Seer", "Klink") often turns up (in 7
  // of 268 cards read upside down; never as the name line).
  const clear = (n) => isSure(n.name.best) || (isKnown(n.name.best) && n.conf >= 75) || n.lines.some((l) => l.conf >= 75 && isSure(l.text));
  // The right way up, the bottom line (illustrator, copyright, weakness…) nearly always has
  // a line reading at 80 or more; upside down hardly ever, and then not with a name area
  // reading at 60 or more as well.
  const upright = (r) => clear(r.n) || (r.n.conf >= UPRIGHT.name && r.b.conf >= UPRIGHT.bottom);

  const { todo } = await cardViews(canvas, onStatus, debug);

  // What was read from each view, for the debug text.
  const tried = new Map();
  const note = (v, n, b) => {
    const t = tried.get(v) || {};
    tried.set(v, { name: n?.text ?? t.name, bottom: b?.text ?? t.bottom });
  };

  let card = null;
  let bottom = { numbers: [], setCodes: [], codeCandidates: [] };
  let name = { best: '', all: '' };
  let nameText = '';
  const use = (v, n, b) => {
    card = v.card;
    ({ name } = n);
    nameText = n.text;
    bottom = b.bottom;
  };
  const numbered = () => numberFound(bottom);
  // A number or a clearly read name means this is the card, the right way up.
  const done = () => numbered() || isSure(name.best) || isSure(nameText);

  let first = null;
  let turned = false;
  if (todo.first) {
    const v = todo.first;
    onStatus?.('Reading card name…');
    await nextPaint();
    let n = await readName(v.card, ocr);
    if (!todo.light) n = await nameAgain(n, ocr, match);
    onStatus?.('Reading card number…');
    let b = await readBottom(v.card, ocr);
    // The number spots too, when the number areas gave no number; for white text only once
    // the card is known to be the right way up (below).
    if (!todo.light) b = await bottomAgain(b, ocr, ['spots']);
    note(v, n, b);
    first = { v, n, b };
    use(v, n, b);
    debug.steps.push(`${v.how} name ${Math.round(n.conf)} bottom ${Math.round(b.conf)}`);
    // A whole photo read as is is only the card if it read like one.
    if (todo.light && !done()) card = null;
  }

  if (first && !numbered() && !upright(first) && todo.turns.length) {
    // Maybe the card is the other way round. Taken that way, a card name must read
    // clearly; failing that, the way round with a number, or whose bottom line reads
    // clearly, or whose text reads with clearly higher OCR confidence wins. A bottom line
    // that read clearly is seldom upside down (the name area may still be unreadable: holo
    // foil, a sticker): then only a clearly read name turns the card.
    const legible = first.b.conf >= UPRIGHT.sureBottom;
    const probes = [];
    let turn = null;
    for (const v of todo.turns) {
      onStatus?.('Turning the card…');
      const n = await readName(v.card, ocr);
      note(v, n);
      probes.push({ v, n });
      if (clear(n)) {
        turn = probes.at(-1);
        break;
      }
    }
    if (!turn && !legible) {
      const p = probes.reduce((a, q) => (q.n.conf > a.n.conf ? q : a));
      p.b = await readBottom(p.v.card, ocr);
      note(p.v, null, p.b);
      const [a, b] = [first.b.conf, p.b.conf];
      if (numberFound(p.b.bottom) || (b >= UPRIGHT.turnBottom && a < UPRIGHT.turnBottom) || (b >= a && p.n.conf + b > first.n.conf + a + UPRIGHT.margin)) turn = p;
    }
    if (turn) {
      // It reads this way round: start over from here.
      onStatus?.('Reading card number…');
      const n = await nameAgain(turn.n, ocr, match);
      const b = await bottomAgain(turn.b || (await readBottom(turn.v.card, ocr)), ocr);
      note(turn.v, n, b);
      use(turn.v, n, b);
      turned = true;
    }
    debug.steps.push(`turns: ${probes.map((p) => `${p.v.how} name ${Math.round(p.n.conf)}${p.b ? ` bottom ${Math.round(p.b.conf)}` : ''}`).join(', ')}${turned ? ' -> turned' : ''}`);
  }
  // The right way up: white text in the number spots too, when no number was read yet.
  if (first && !turned && !todo.light && !numbered()) {
    const b = await bottomAgain(first.b, ocr, ['white']);
    note(first.v, null, b);
    ({ bottom } = b);
  }

  // Other outlines (the card in a toploader when the toploader was taken, or the other way
  // round), unless the card was just found to be the other way round: their number area,
  // and their name area if no known name was read yet.
  if (!done() && !turned) {
    for (const v of todo.others()) {
      onStatus?.('Reading card number…');
      const b = await readBottom(v.card, ocr);
      bottom = mergeBottom(bottom, b.bottom);
      let n = null;
      if (!isKnown(name.best) && !isKnown(nameText)) {
        n = await readName(v.card, ocr);
        if (isKnown(n.name.best) || !name.best) {
          name = n.name;
          card = v.card;
        }
        nameText += `\n${n.text}`;
      }
      note(v, n, b);
      debug.steps.push(`${v.how}${n ? ` name ${Math.round(n.conf)}` : ''} bottom ${Math.round(b.conf)}`);
      if (done()) break;
    }
  }
  const label = (v) => (tried.size > 1 ? `[${v.how}]\n` : '');
  debug.name = [...tried].filter(([, t]) => t.name != null).map(([v, t]) => label(v) + t.name).join('\n');
  debug.bottom = [...tried].filter(([, t]) => t.bottom != null).map(([v, t]) => label(v) + t.bottom).join('\n');

  // No number on the card: a graded card's slab label gives it ("#199 CHARIZARD EX"), read
  // with the name area when the slab was taken for the card.
  if (!numbered()) {
    const onLabel = parseLabelNumbers(nameText);
    if (onLabel.length) {
      bottom = mergeBottom(bottom, { numbers: onLabel, setCodes: [], codeCandidates: [] });
      debug.steps.push('number from a slab label');
    }
  }

  let fullText = '';
  // A known card name anywhere in the name area's text counts (it is used below).
  const nameKnown = isKnown(name.best) || isKnown(nameText);
  if (!numbered() || !nameKnown) {
    onStatus?.('Reading whole card…');
    // Nothing usable from any outline: maybe it wasn't the card, so read the whole picture
    // (shrunk, see PICTURE_PIXELS). Else the whole card: at that scale OCR often gets a
    // number (or name) its own area's read missed.
    const picture = !card || (!numbered() && !nameKnown);
    const src = picture ? canvas : card;
    const maxPixels = !picture ? Infinity : todo.light ? PICTURE_PIXELS.main : PICTURE_PIXELS.last;
    const full = enhance(crop(src, { x: 0, y: 0, w: 1, h: 1 }, Math.min(2000, Math.max(1200, src.width)), maxPixels));
    const res = await ocr(full, 11);
    debug.full = res.text;
    debug.steps.push(picture ? 'read picture' : 'read card');
    fullText = res.text;
    bottom = mergeBottom(bottom, parseBottomText(res.text));
    if (!name.best) {
      // Name is the tallest text in the top half of the picture.
      const top = res.lines.filter((l) => l.y < full.height * 0.5);
      const picked = pickName(top.length ? top : res.lines);
      name.best = picked.best;
      name.all = picked.all;
    }
  }

  // The name read is garbage (glare, a sticker…): use a known card name found in what
  // we read, name area first.
  if (opts.findName && !isKnown(name.best)) {
    const hit = [nameText, fullText].map(lookup).find((k) => k && k.score >= KNOWN);
    if (hit) {
      if (!name.all.includes(name.best)) name.all = [name.best, name.all].filter(Boolean).join(' ');
      name.best = hit.name;
      debug.nameFrom = 'dictionary';
    }
  }

  return {
    clues: { nameBest: name.best, nameAll: name.all, ...bottom, artText: '' },
    debug,
    card,
  };
}
