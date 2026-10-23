// Camera capture, image clean-up and on-device text recognition (Tesseract.js).
import { parseBottomText, parseLabelNumbers, pickName } from './parse.js';
import { CARD_ASPECT, detectCard, warpCard, rotateCorners } from './detect.js';
import { catalog } from './catalog.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';

// A Pokémon card is 63 × 88 mm.
export { CARD_ASPECT };

// Regions of a straightened card, as fractions of its width/height.
export const NAME_REGION = { x: 0.0, y: 0.0, w: 0.86, h: 0.17 };
// Where the collector number and set code are printed: bottom left from Black & White on
// ("G MEW EN 199/165", under the illustrator), bottom right before that ("17/111 ★", at the
// end of the copyright line). Both are read in one go, one under the other.
export const NUMBER_REGIONS = [
  { x: 0.02, y: 0.875, w: 0.5, h: 0.11 },
  { x: 0.55, y: 0.9, w: 0.43, h: 0.095 },
];
// Just the number's own spot in each, read when the whole areas gave no number.
export const NUMBER_SPOTS = [
  { x: 0.1, y: 0.9, w: 0.3, h: 0.08 },
  { x: 0.66, y: 0.91, w: 0.32, h: 0.075 },
];
// Artwork window; set-logo and other stamps sit in its lower part.
export const ART_REGION = { x: 0.04, y: 0.09, w: 0.92, h: 0.42 };
// Lower artwork plus the strip under it, read for stamps: set logos sit in the art's
// lower-right corner (often over its edge), the 1st Edition stamp just below its lower-left.
export const STAMP_REGION = { x: 0.03, y: 0.25, w: 0.97, h: 0.34 };

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

// ---------- camera ----------

export async function startCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open the camera. Use "Photo" instead.');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();
  // Ask for continuous autofocus where supported (Android Chrome).
  const track = stream.getVideoTracks()[0];
  try {
    const caps = track.getCapabilities?.();
    if (caps?.focusMode?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
  } catch {
    /* not supported */
  }
  return stream;
}

export function stopCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

export async function setTorch(stream, on) {
  const track = stream?.getVideoTracks()[0];
  if (!track?.getCapabilities?.().torch) return false;
  await track.applyConstraints({ advanced: [{ torch: on }] });
  return true;
}

export function torchSupported(stream) {
  const track = stream?.getVideoTracks()[0];
  return !!track?.getCapabilities?.().torch;
}

// Pictures from captureGuide: readCard reads them as the card itself.
const guideCrops = new WeakSet();

/**
 * Grab the part of the video frame that sits under the on-screen card guide.
 * The video is shown with object-fit: cover, so map screen coords back to video pixels.
 */
export function captureGuide(video, guideEl) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const vr = video.getBoundingClientRect();
  const gr = guideEl.getBoundingClientRect();
  const scale = Math.max(vr.width / vw, vr.height / vh);
  const offX = (vr.width - vw * scale) / 2;
  const offY = (vr.height - vh * scale) / 2;
  let sx = (gr.left - vr.left - offX) / scale;
  let sy = (gr.top - vr.top - offY) / scale;
  let sw = gr.width / scale;
  let sh = gr.height / scale;
  // Clamp to the frame.
  sx = Math.max(0, sx);
  sy = Math.max(0, sy);
  sw = Math.min(vw - sx, sw);
  sh = Math.min(vh - sy, sh);
  const c = document.createElement('canvas');
  c.width = Math.round(sw);
  c.height = Math.round(sh);
  c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
  guideCrops.add(c);
  return c;
}

/** Load a File/Blob into a canvas, honouring EXIF orientation, capped in size. */
export async function fileToCanvas(file, maxSide = 3000) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bmp = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not read that image.'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = bmp.width;
  const h = bmp.height;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c;
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

/** The picture turned upside down. */
function turnAround(canvas) {
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  const ctx = c.getContext('2d');
  ctx.translate(c.width, c.height);
  ctx.rotate(Math.PI);
  ctx.drawImage(canvas, 0, 0);
  return c;
}

/** Let the browser paint the latest status before a long synchronous step. */
function nextPaint() {
  if (typeof document === 'undefined' || document.hidden) return Promise.resolve();
  // requestAnimationFrame waits while the page is hidden: the timeout covers that.
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
    setTimeout(resolve, 100);
  });
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

function looksLikeCard(canvas) {
  const a = canvas.width / canvas.height;
  return a > CARD_ASPECT * 0.85 && a < CARD_ASPECT * 1.18;
}

/**
 * OCR one area of a straightened card. region is in fractions of the card
 * ({ x, y, w, h }, e.g. ART_REGION). Returns { text, lines: [{ text, height, conf, y }] }.
 */
export async function readRegion(card, region, { psm = 11, invert = false, targetW = 1600 } = {}) {
  return recognize(enhance(crop(card, region, targetW), invert), psm);
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
  return { name: pickName(res.lines), text: res.text, conf: legible(res.lines, /[A-Za-z]{3}/), card };
}

/**
 * A name read that isn't a known card name, read again as one block of text (sparse-text
 * mode gets lost on some name bars), in plain grey this time (white names too).
 */
async function nameAgain(r, ocr, isKnown) {
  if (isKnown(r.name.best) || isKnown(r.text)) return r;
  const again = await ocr(enhance(crop(r.card, NAME_REGION, 1600)), 6);
  const n2 = pickName(again.lines);
  const name = isKnown(n2.best) || isKnown(again.text) || !r.name.best ? n2 : r.name;
  return { ...r, name, text: `${r.text}\n---block---\n${again.text}` };
}

// Printed set sizes, from the card list once it is in: a number OCR mangled is still found
// next to one of them (see parse.js).
let sizes = { of: null, set: undefined };
function setSizes() {
  const sets = catalog.index?.setsById;
  if (sets && sizes.of !== sets) sizes = { of: sets, set: new Set([...sets.values()].map((s) => s.cardCount?.official).filter((n) => n >= 20)) };
  return sizes.set;
}

/**
 * Number areas (or spots) of a card, enlarged to `width`, cleaned up and put one under the
 * other: black text, or (inverted) white text.
 */
function numberAreas(card, regions, width, inverted) {
  return stack(regions.map((r) => enhance(crop(card, r, width), inverted, { text: inverted ? 'white' : 'black' })));
}

/** Number-area OCR (collector number, set code), as one block of text. */
async function readBottom(card, ocr) {
  const res = await ocr(numberAreas(card, NUMBER_REGIONS, 1400, false), 6, { adaptive: true });
  return { bottom: parseBottomText(res.text, { totals: setSizes() }), text: res.text, conf: legible(res.lines, /[A-Za-z0-9]{3}/), card };
}

/**
 * A bottom read without a number (or only one without its set size, like a promo's): the
 * number spots alone, with less around them to get lost in; then the same for white text
 * (full-art and special cards).
 */
async function bottomAgain(r, ocr) {
  for (const inverted of [false, true]) {
    if (r.bottom.numbers.some((n) => n.total)) break;
    const res = await ocr(numberAreas(r.card, NUMBER_SPOTS, 900, inverted), 6, { adaptive: true });
    r = { ...r, bottom: mergeBottom(r.bottom, parseBottomText(res.text, { totals: setSizes() })), text: `${r.text}\n---${inverted ? 'white' : 'spots'}---\n${res.text}` };
  }
  return r;
}

// Keep a sliver around a found card, in case an edge was found on its inner frame.
const WARP_MARGIN = 0.015;

// Telling which way up a card is from its first read (OCR confidences, see readCard):
// with a bottom line reading at `bottom` or more and a name area at `name` or more it is
// the right way up; with a bottom line at `sureBottom` or more it is turned only for a name
// that reads clearly that way. On 43 real photos read both ways round, no upside-down read
// met the first, and two the second (both with a clearly read name when turned).
const UPRIGHT = { name: 60, bottom: 80, sureBottom: 85 };
// A whole photo is OCR'd at most this big: reading time grows with the picture (a 12-megapixel
// phone photo with no card found took over a minute at full size). With no card outline it
// is the main read (2.6 MP keeps a 1600 × 1600 photo whole); after the card's own areas
// read nothing usable it is a last try that rarely finds anything, and some pictures take
// half a minute at 2.5 MP.
const PICTURE_PIXELS = { main: 2.6e6, last: 2e6 };

/** A card-shaped picture to read, made when first needed. */
function view(how, make) {
  let card = null;
  return {
    how,
    get card() {
      return (card ||= make());
    },
  };
}

const outline = (canvas, how, corners) => view(how, () => warpCard(canvas, corners, { margin: WARP_MARGIN }));

function findCard(canvas, opts) {
  try {
    return detectCard(canvas, opts);
  } catch (e) {
    console.warn('card detection failed', e);
    return null;
  }
}

const describe = (found) => (found ? `card found (score ${found.score.toFixed(2)}, area ${found.area.toFixed(2)}, ${found.ms} ms)` : 'no card outline found');

// A camera guide crop is mostly card: a smaller copy finds it as well and is quicker to search.
const GUIDE_DETECT_SIZE = 384;
// Read a guide crop as is when the card fills it: from 84% of the guide's width up (70% of
// its area), the name and number still sit in their areas of the crop.
const GUIDE_FILLED = 0.7;

/**
 * What to read, best guess first:
 *   first:  read in full (name, also in a second OCR mode; number, also inverted), or
 *           lightly (one pass each) when `light`
 *   turns:  the same card other ways up, tried when the first read doesn't look the right
 *           way up: name area first, the number area too if that doesn't settle it and
 *           the first number area read wasn't clear
 *   others: other outlines (name in both OCR modes, number once)
 * A camera guide crop is the card already (upright, or held upside down) when the card
 * fills it. When the card found in it (quickly, on a small copy) clearly doesn't, that
 * card is straightened and read instead, the crop as is only if that fails.
 * In a photo the card is found first; a whole photo is read as is (lightly) only when
 * no card was found in it.
 */
function plan(canvas, guide, found) {
  if (guide) {
    const asIs = view('as is', () => canvas);
    // An upright card outline inside the crop (a sideways one there is part of the card).
    const inside = found && !found.landscape && found.area < 0.8 ? found : null;
    if (inside && inside.area < GUIDE_FILLED) {
      return {
        first: outline(canvas, 'found', inside.corners),
        turns: [outline(canvas, 'turned', rotateCorners(inside.upsideDown || inside.corners, 2))],
        others: () => [asIs],
      };
    }
    return {
      first: asIs,
      turns: [view('upside down', () => turnAround(canvas))],
      others: () => (inside ? [outline(canvas, 'found', inside.corners)] : []),
    };
  }
  if (!found) return { first: looksLikeCard(canvas) ? view('as is', () => canvas) : null, light: true, turns: [], others: () => [] };
  const turns = found.whole
    ? // Maybe half of a card lying sideways: the whole card, either way round.
      [outline(canvas, 'sideways', found.whole), outline(canvas, 'sideways, turned', rotateCorners(found.whole, 2))]
    : [outline(canvas, 'turned', rotateCorners(found.upsideDown || found.corners, 2))];
  // Next-best outline (e.g. the toploader when we picked the card, or the other way round).
  const alt = found.candidates[0];
  return { first: outline(canvas, 'found', found.corners), turns, others: () => (alt ? [outline(canvas, 'alternative', alt)] : []) };
}

/**
 * Read a card image: the camera guide crop, or any photo with a card in it
 * (the card is found, straightened and then read; turned around or sideways cards too).
 *   opts.findName(text) -> { name, score } | null | undefined
 *     optional dictionary lookup (identify.js passes the catalog). Finds a known card
 *     name inside OCR text; undefined means "can't tell" (catalog not loaded yet).
 * Returns {
 *   clues: { nameBest, nameAll, numbers, setCodes, codeCandidates, artText: '' },
 *          artText is for readStamps(card) to fill in (identify.js does for every card read)
 *   debug: { name, bottom, full, detect, reads, steps } raw OCR text per area, how the card
 *          was found, how many OCR passes it took and what was read in which order,
 *   card:  the card as read, as a canvas: straightened (portrait, ~600–1000 px wide, 1.5%
 *          margin), or the camera guide crop; null when no card was found or read in a
 *          photo. Areas are fractions of it (NAME_REGION, NUMBER_REGIONS, ART_REGION); OCR
 *          more of it with readRegion(card, region).
 * }
 */
export async function readCard(canvas, onStatus, opts = {}) {
  const debug = { name: '', bottom: '', full: '', detect: '', reads: 0, steps: [] };
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
  const isKnown = (text, min = 0.75) => {
    const k = lookup(text);
    return k === undefined ? !!text : !!k && k.score >= min;
  };
  // OCR of upside-down or sideways text can pass for a short name with a letter or two
  // off; read the right way up, names nearly always come out whole.
  const isSure = (text) => isKnown(text, 0.9);
  const named = (n) => isKnown(n.name.best) || isKnown(n.text);
  // Text the right way up mostly reads with OCR confidence well above 75, upside-down or
  // sideways text below it: a known name read that clearly is the card the right way up.
  const clear = (n) => isSure(n.name.best) || isSure(n.text) || (named(n) && n.conf >= 75);
  // The right way up, the bottom line (illustrator, copyright, weakness…) nearly always has
  // a line reading at 80 or more; upside down hardly ever, and then not with a name area
  // reading at 60 or more as well.
  const upright = (r) => clear(r.n) || (r.n.conf >= UPRIGHT.name && r.b.conf >= UPRIGHT.bottom);

  const guide = guideCrops.has(canvas);
  let found = null;
  if (guide) {
    found = findCard(canvas, { detectSize: GUIDE_DETECT_SIZE });
    debug.detect = `camera guide crop, ${describe(found)}`;
  } else {
    onStatus?.('Finding the card…');
    await nextPaint();
    found = findCard(canvas);
    debug.detect = describe(found);
  }
  const todo = plan(canvas, guide, found);

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
  // A number read with its set size (or a promo's, "SWSH050"): a lone one ("041") may be
  // anything, upside-down text too.
  const numbered = () => bottom.numbers.some((n) => n.total || n.prefix);
  // A number or a clearly read name means this is the card, the right way up.
  const done = () => numbered() || isSure(name.best) || isSure(nameText);

  let first = null;
  let turned = false;
  if (todo.first) {
    const v = todo.first;
    onStatus?.('Reading card name…');
    await nextPaint();
    let n = await readName(v.card, ocr);
    if (!todo.light) n = await nameAgain(n, ocr, isKnown);
    onStatus?.('Reading card number…');
    let b = await readBottom(v.card, ocr);
    if (!todo.light) b = await bottomAgain(b, ocr);
    note(v, n, b);
    first = { n, b };
    use(v, n, b);
    debug.steps.push(`${v.how} name ${Math.round(n.conf)} bottom ${Math.round(b.conf)}`);
    // A whole photo read as is is only the card if it read like one.
    if (todo.light && !done()) card = null;
  }

  if (first && !numbered() && !upright(first) && todo.turns.length) {
    // Maybe the card is the other way round. Taken that way, a card name must read
    // clearly (or be the only one read at all); failing that, the way round whose text
    // reads with clearly higher OCR confidence wins. A bottom line that read clearly is
    // seldom upside down (the name area may still be unreadable: holo foil, a sticker):
    // then only a clearly read name turns the card.
    const legible = first.b.conf >= UPRIGHT.sureBottom;
    const probes = [];
    let turn = null;
    for (const v of todo.turns) {
      onStatus?.('Turning the card…');
      const n = await readName(v.card, ocr);
      note(v, n);
      probes.push({ v, n });
      if (isSure(n.name.best) || isSure(n.text) || (!legible && !named(first.n) && named(n))) {
        turn = probes.at(-1);
        break;
      }
    }
    if (!turn && !legible) {
      const p = probes.reduce((a, q) => (q.n.conf > a.n.conf ? q : a));
      p.b = await readBottom(p.v.card, ocr);
      note(p.v, null, p.b);
      if (p.n.conf + p.b.conf > first.n.conf + first.b.conf + 10) turn = p;
    }
    if (turn) {
      // It reads this way round: start over from here.
      onStatus?.('Reading card number…');
      const n = await nameAgain(turn.n, ocr, isKnown);
      const b = await bottomAgain(turn.b || (await readBottom(turn.v.card, ocr)), ocr);
      note(turn.v, n, b);
      use(turn.v, n, b);
      turned = true;
    }
    debug.steps.push(`turns: ${probes.map((p) => `${p.v.how} name ${Math.round(p.n.conf)}${p.b ? ` bottom ${Math.round(p.b.conf)}` : ''}`).join(', ')}${turned ? ' -> turned' : ''}`);
  }

  // Other outlines, unless the card was just found to be the other way round.
  if (!done() && !turned) {
    for (const v of todo.others()) {
      onStatus?.('Reading card name…');
      const n = await nameAgain(await readName(v.card, ocr), ocr, isKnown);
      const b = await readBottom(v.card, ocr);
      note(v, n, b);
      bottom = mergeBottom(bottom, b.bottom);
      if (!isKnown(name.best) && (isKnown(n.name.best) || !name.best)) {
        name = n.name;
        card = v.card;
      }
      nameText += `\n${n.text}`;
      debug.steps.push(`${v.how} name ${Math.round(n.conf)} bottom ${Math.round(b.conf)}`);
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
    const hit = [nameText, fullText].map(lookup).find((k) => k && k.score >= 0.75);
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

function mergeBottom(a, b) {
  const key = (n) => `${n.prefix}|${n.num}|${n.total}`;
  const seen = new Set(a.numbers.map(key));
  return {
    // Numbers read with their set size first: a lone one ("067") is more often something else.
    numbers: [...a.numbers, ...b.numbers.filter((n) => !seen.has(key(n)))].sort((x, y) => (x.total == null) - (y.total == null)),
    setCodes: [...new Set([...a.setCodes, ...b.setCodes])],
    codeCandidates: [...new Set([...a.codeCandidates, ...b.codeCandidates])],
  };
}
