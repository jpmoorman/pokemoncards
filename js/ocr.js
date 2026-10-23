// Camera capture, image clean-up and on-device text recognition (Tesseract.js).
import { parseBottomText, pickName } from './parse.js';
import { CARD_ASPECT, detectCard, warpCard, rotateCorners } from './detect.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';

// A Pokémon card is 63 × 88 mm.
export { CARD_ASPECT };

// Regions of a straightened card, as fractions of its width/height.
export const NAME_REGION = { x: 0.0, y: 0.0, w: 0.86, h: 0.17 };
export const BOTTOM_REGION = { x: 0.0, y: 0.84, w: 1.0, h: 0.16 };
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

/** Crop a region (fractions) and scale it so its width is ~targetW px. */
function crop(src, r, targetW) {
  const sx = Math.round(src.width * r.x);
  const sy = Math.round(src.height * r.y);
  const sw = Math.max(1, Math.round(src.width * r.w));
  const sh = Math.max(1, Math.round(src.height * r.h));
  const scale = Math.min(4, Math.max(1, targetW / sw));
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
 * light-on-dark text into dark-on-light first.
 */
function enhance(canvas, invert = false) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const w = canvas.width;
  const h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) {
    const v = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
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

function copy(canvas) {
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  c.getContext('2d').drawImage(canvas, 0, 0);
  return c;
}

async function recognize(worker, canvas, psm) {
  await worker.setParameters({ tessedit_pageseg_mode: String(psm), preserve_interword_spaces: '1' });
  const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
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
 * For stamp detection: readRegion(result.card, ART_REGION).
 */
export async function readRegion(card, region, { psm = 11, invert = false, targetW = 1600 } = {}) {
  const worker = await getWorker();
  return recognize(worker, enhance(crop(card, region, targetW), invert), psm);
}

/**
 * Name + bottom-line OCR of one card-shaped image. `isKnown(name)` says whether a
 * read is a real card name; when it isn't, the name area is read again as one
 * block of text (sparse-text mode gets lost on some name bars).
 */
async function readAreas(worker, card, onStatus, isKnown) {
  onStatus?.('Reading card name…');
  const nameImg = enhance(crop(card, NAME_REGION, 1600));
  const nameRes = await recognize(worker, nameImg, 11);
  let name = pickName(nameRes.lines);
  let nameText = nameRes.text;
  if (!isKnown(name.best) && !isKnown(nameRes.text)) {
    const again = await recognize(worker, nameImg, 6);
    nameText += `\n---block---\n${again.text}`;
    const n2 = pickName(again.lines);
    if (isKnown(n2.best) || isKnown(again.text) || !name.best) name = n2;
  }
  onStatus?.('Reading card number…');
  const bottomBase = crop(card, BOTTOM_REGION, 2200);
  const b1 = await recognize(worker, enhance(copy(bottomBase)), 11);
  let bottomText = b1.text;
  let bottom = parseBottomText(b1.text);
  if (!bottom.numbers.length) {
    // White text on dark full-art cards reads better inverted.
    const b2 = await recognize(worker, enhance(copy(bottomBase), true), 11);
    bottomText += `\n---inverted---\n${b2.text}`;
    bottom = mergeBottom(bottom, parseBottomText(b2.text));
  }
  return { name, nameText, bottom, bottomText };
}

// Keep a sliver around a found card, in case an edge was found on its inner frame.
const WARP_MARGIN = 0.015;

/** Card-shaped images to read, best guess first: straightened card(s), then the picture as is. */
function cardViews(canvas, found) {
  const views = [];
  if (found) {
    views.push({ card: warpCard(canvas, found.corners, { margin: WARP_MARGIN }), how: 'found' });
    if (found.landscape) views.push({ card: warpCard(canvas, rotateCorners(found.corners, 2), { margin: WARP_MARGIN }), how: 'turned' });
    // Next-best outline (e.g. the toploader when we picked the card, or the other way round).
    const alt = found.candidates[0];
    if (alt) views.push({ card: warpCard(canvas, alt, { margin: WARP_MARGIN }), how: 'alternative' });
  }
  // Camera guide crops are already the card.
  if (looksLikeCard(canvas) && !(found && found.area > 0.8)) views.push({ card: canvas, how: 'as is' });
  return views.slice(0, 3);
}

/**
 * Read a card image: the camera guide crop, or any photo with a card in it
 * (the card is found, straightened and then read).
 *   opts.findName(text) -> { name, score } | null | undefined
 *     optional dictionary lookup (identify.js passes the catalog). Finds a known card
 *     name inside OCR text; undefined means "can't tell" (catalog not loaded yet).
 * Returns {
 *   clues: { nameBest, nameAll, numbers, setCodes, codeCandidates, artText },
 *          artText: what was read on the lower artwork (STAMP_REGION), for stamps.js
 *   debug: { name, bottom, full, art, detect } raw OCR text per area + how the card was found,
 *   card:  the straightened card as a canvas (portrait, ~600–1000 px wide, 1.5% margin);
 *          a camera guide crop with no outline found is used as is; null when no card
 *          was found in a photo. Areas are fractions of it (NAME_REGION, BOTTOM_REGION,
 *          ART_REGION); OCR more of it with readRegion(card, region), e.g. for stamps.
 * }
 */
export async function readCard(canvas, onStatus, opts = {}) {
  const worker = await getWorker();
  const debug = { name: '', bottom: '', full: '', detect: '' };
  onStatus?.('Finding the card…');
  let found = null;
  try {
    found = detectCard(canvas);
  } catch (e) {
    console.warn('card detection failed', e);
  }
  debug.detect = found ? `card found (score ${found.score.toFixed(2)}, ${found.ms} ms)` : 'no card outline found';
  const views = cardViews(canvas, found);

  const seen = new Map();
  const lookup = (text) => {
    if (!opts.findName || !text) return undefined;
    if (!seen.has(text)) seen.set(text, opts.findName(text));
    return seen.get(text);
  };
  const isKnown = (text) => {
    const k = lookup(text);
    return k === undefined ? !!text : !!k && k.score >= 0.75;
  };
  let card = views[0]?.card || null;
  let bottom = { numbers: [], setCodes: [], codeCandidates: [] };
  let name = { best: '', all: '' };
  let nameText = '';
  for (const [i, v] of views.entries()) {
    const r = await readAreas(worker, v.card, onStatus, isKnown);
    const label = views.length > 1 ? `[${v.how}]\n` : '';
    debug.name += (i ? '\n' : '') + label + r.nameText;
    debug.bottom += (i ? '\n' : '') + label + r.bottomText;
    bottom = mergeBottom(bottom, r.bottom);
    if (!isKnown(name.best) && (isKnown(r.name.best) || !name.best)) {
      name = r.name;
      card = v.card;
    }
    nameText += `\n${r.nameText}`;
    // A number or a real name means this outline is the card; stop trying others.
    if (bottom.numbers.length || isKnown(name.best) || isKnown(r.nameText)) break;
  }

  let fullText = '';
  if (!bottom.numbers.length || !isKnown(name.best)) {
    onStatus?.('Reading whole card…');
    // Nothing usable from any outline: maybe it wasn't the card, so read the whole picture.
    const src = bottom.numbers.length || isKnown(name.best) ? card || canvas : canvas;
    const full = enhance(crop(src, { x: 0, y: 0, w: 1, h: 1 }, Math.min(2000, Math.max(1200, src.width))));
    const res = await recognize(worker, full, 11);
    debug.full = res.text;
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

  // Stamps (set logo, 1st Edition, Play! Pokémon…) tell the versions apart; stamps.js reads them.
  let artText = '';
  if (card) {
    onStatus?.('Checking for stamps…');
    try {
      const res = await recognize(worker, enhance(crop(card, STAMP_REGION, 1400)), 11);
      artText = res.text.replace(/\n\s*\n/g, '\n').trim();
    } catch (e) {
      console.warn('artwork read failed', e);
    }
    debug.art = artText;
  }

  return {
    clues: { nameBest: name.best, nameAll: name.all, ...bottom, artText },
    debug,
    card,
  };
}

function mergeBottom(a, b) {
  const key = (n) => `${n.prefix}|${n.num}|${n.total}`;
  const seen = new Set(a.numbers.map(key));
  return {
    numbers: [...a.numbers, ...b.numbers.filter((n) => !seen.has(key(n)))],
    setCodes: [...new Set([...a.setCodes, ...b.setCodes])],
    codeCandidates: [...new Set([...a.codeCandidates, ...b.codeCandidates])],
  };
}
