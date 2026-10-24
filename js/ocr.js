// Camera capture, finding and straightening the card, and reading its text on the device:
// PaddleOCR (PP-OCRv6 tiny) models in a worker (ocr-worker.js), or Tesseract.js
// (ocr-tesseract.js) on phones that can't run them.
import { parseBottomText, parseLabelNumbers, pickName, normalize } from './parse.js';
import { CARD_ASPECT, detectCard, warpCard, rotateCorners } from './detect.js';
import { catalog } from './catalog.js';

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
// Just the number's own spot in each (read again by the Tesseract fallback).
export const NUMBER_SPOTS = [
  { x: 0.1, y: 0.9, w: 0.3, h: 0.08 },
  { x: 0.66, y: 0.91, w: 0.32, h: 0.075 },
];
// Artwork window; set-logo and other stamps sit in its lower part.
export const ART_REGION = { x: 0.04, y: 0.09, w: 0.92, h: 0.42 };
// Lower artwork plus the strip under it, read for stamps: set logos sit in the art's
// lower-right corner (often over its edge), the 1st Edition stamp just below its lower-left.
export const STAMP_REGION = { x: 0.03, y: 0.25, w: 0.97, h: 0.34 };

// ---------- camera ----------

let camerasOpen = 0;

export async function startCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open the camera. Use "Photo" instead.');
  // Get the text reader ready while the card is lined up.
  warmUp();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play();
  camerasOpen++;
  stream.getVideoTracks()[0]?.addEventListener('ended', () => cameraClosed(stream));
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

const closed = new WeakSet();
function cameraClosed(stream) {
  if (!stream || closed.has(stream)) return;
  closed.add(stream);
  camerasOpen = Math.max(0, camerasOpen - 1);
  idle();
}

export function stopCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
  cameraClosed(stream);
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
  bmp.close?.();
  return c;
}

/** The picture turned upside down (shrunk to at most `maxPixels`). */
function turnAround(canvas, maxPixels = Infinity) {
  const k = Math.min(1, Math.sqrt(maxPixels / (canvas.width * canvas.height)));
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * k);
  c.height = Math.round(canvas.height * k);
  const ctx = c.getContext('2d');
  ctx.translate(c.width, c.height);
  ctx.rotate(Math.PI);
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  return c;
}

/** Let the browser paint the latest status before a long synchronous step. */
export function nextPaint() {
  if (typeof document === 'undefined' || document.hidden) return Promise.resolve();
  // requestAnimationFrame waits while the page is hidden: the timeout covers that.
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
    setTimeout(resolve, 100);
  });
}

// ---------- the text reader ----------

// PP-OCR runs on onnxruntime-web, which needs WebAssembly SIMD (Safari from iOS 16.4, every
// current Chrome); without it the Tesseract fallback reads instead. This is the smallest
// module using a SIMD instruction.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
// The worker is stopped after this long without a read, to give its memory back (the
// runtime's memory only grows); longer while the camera is open, as more scans are coming,
// and soon once the app is in the background (a phone keeps a page with less memory, and a
// batch going on in the background keeps reading).
const IDLE_MS = { camera: 5 * 60e3, none: 60e3, hidden: 5e3 };
// A read that hasn't come back after this long never will (the worker was stopped by the
// browser): the worker is restarted. Starting up fails after STALL_MS without progress: a
// first download on a slow connection (the service worker may hand a file over only once it
// has all of it) gets `download`, setting up the runtime once the files are in gets `runtime`.
const READ_TIMEOUT_MS = 45e3;
const STALL_MS = { download: 5 * 60e3, runtime: 60e3 };

let reader = null; // Promise of { kind: 'ppocr', worker } or { kind: 'tesseract', mod }
let progressCb = null;
let worker = null;
let nextId = 1;
const waiting = new Map(); // job id -> { w (the worker it went to), resolve, reject }
let idleTimer = null;
let busy = 0;

function canRunPpocr() {
  try {
    return typeof Worker === 'function' && typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

function ask(type, data = {}, transfer = []) {
  const w = worker;
  if (!w) return Promise.reject(new Error('The text reader stopped. Try again.'));
  return new Promise((resolve, reject) => {
    const id = nextId++;
    // Starting (init) may take a first download: no time limit.
    const timer =
      type !== 'init' &&
      setTimeout(() => {
        if (!waiting.has(id)) return;
        if (worker === w) stopReader();
        reject(new Error('The text reader stopped. Try again.'));
      }, READ_TIMEOUT_MS);
    waiting.set(id, {
      w,
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    w.postMessage({ id, type, ...data }, transfer);
  });
}

/** Fail the jobs sent to worker w (it stopped); a newer worker's jobs carry on. */
function dropJobs(w, err) {
  for (const [id, p] of waiting) {
    if (p.w !== w) continue;
    waiting.delete(id);
    p.reject(err);
  }
}

/** Start the PP-OCR worker; rejects with err.runtime set when it can't run here. */
function startPpocr() {
  return new Promise((resolve, reject) => {
    let w;
    try {
      w = new Worker(new URL('./ocr-worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      e.runtime = true;
      return reject(e);
    }
    worker = w;
    const fail = (err) => {
      dropJobs(w, err);
      if (worker === w) {
        worker = null;
        reader = null;
      }
      w.terminate();
    };
    let stall = null;
    const waitForProgress = (ms) => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        const err = new Error('text reader start-up stalled');
        fail(err);
        reject(err);
      }, ms);
    };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.loaded) return waitForProgress(STALL_MS.runtime);
      if (m.progress != null) {
        waitForProgress(STALL_MS.download);
        return progressCb?.({ status: 'loading text recognition', progress: m.progress });
      }
      const p = waiting.get(m.id);
      if (!p) return;
      waiting.delete(m.id);
      if (m.error) {
        const err = new Error(m.error);
        err.runtime = m.stage === 'runtime';
        p.reject(err);
      } else p.resolve(m.ok);
    };
    // A worker that dies (a browser without module workers, out of memory) takes its jobs with it.
    w.onerror = (e) => {
      e.preventDefault?.();
      const err = new Error(`text reader stopped: ${e.message || 'worker error'}`);
      err.runtime = true;
      fail(err);
    };
    waitForProgress(STALL_MS.download);
    ask('init').then(
      () => {
        clearTimeout(stall);
        resolve({ kind: 'ppocr' });
      },
      (err) => {
        clearTimeout(stall);
        fail(err);
        reject(err);
      },
    );
  });
}

async function start() {
  if (canRunPpocr()) {
    try {
      return await startPpocr();
    } catch (e) {
      // Only a runtime that can't run here falls back; a failed download (offline on the
      // first visit) is retried on the next scan, as is a start stopped on purpose.
      if (e.stopped) throw new Error('The text reader stopped. Try again.');
      if (!e.runtime) throw new Error('Could not load the text-recognition engine. Check your connection.');
      console.warn('PP-OCR cannot run here, reading with Tesseract instead', e);
    }
  }
  const mod = await import('./ocr-tesseract.js');
  await mod.getWorker((m) => progressCb?.(m));
  return { kind: 'tesseract', mod };
}

/**
 * The text reader, started on first use (downloads the models once, then they come from
 * the cache). `onProgress({ status, progress })` hears how the first download is going.
 */
export function getWorker(onProgress) {
  if (onProgress) progressCb = onProgress;
  if (!reader) {
    const r = start();
    reader = r;
    r.catch(() => {
      if (reader === r) reader = null;
    });
    r.then(() => idle(), () => {});
  }
  return reader;
}

/** Start the text reader in the background (app start, camera opened), if it isn't running. */
export function warmUp() {
  getWorker().catch(() => {});
}

/** Stop the PP-OCR worker now, freeing its memory; the next read starts it again. */
export function stopReader() {
  clearTimeout(idleTimer);
  if (!worker) return;
  const w = worker;
  worker = null;
  reader = null;
  const err = new Error('text reader stopped');
  err.stopped = true;
  dropJobs(w, err);
  w.terminate();
}

/** Arm the idle stop (see IDLE_MS). */
function idle() {
  clearTimeout(idleTimer);
  if (!worker) return;
  const ms = typeof document !== 'undefined' && document.hidden ? IDLE_MS.hidden : camerasOpen ? IDLE_MS.camera : IDLE_MS.none;
  idleTimer = setTimeout(() => (busy ? idle() : stopReader()), ms);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    idle();
    // Back with the camera open: ready again while the card is lined up.
    if (!document.hidden && camerasOpen) warmUp();
  });
}

/** How the reader is doing, for the bench page: { engine, wasmBytes }. */
export async function readerStats() {
  const r = await getWorker();
  if (r.kind !== 'ppocr') return { engine: r.kind, wasmBytes: null };
  return { engine: r.kind, ...(await ask('stats')) };
}

// A picture goes to the worker at most this big (the whole photo when no card was found in
// it; a straightened card is about a megapixel).
const SEND_PIXELS = 2.6e6;

/**
 * Read areas of a canvas with PP-OCR. Areas are { x, y, w, h } in fractions of the canvas,
 * plus `width` or `maxSide` (how big to search it for text, see ppocr.detScale). Only the
 * part they cover is sent. Returns per area { lines: [{ text, score, box }], ms }, boxes
 * [x0, y0, x1, y1] in canvas pixels.
 */
async function readAreas(canvas, areas) {
  await getWorker();
  busy++;
  clearTimeout(idleTimer);
  try {
    const W = canvas.width;
    const H = canvas.height;
    const sx = Math.max(0, Math.floor(Math.min(...areas.map((a) => a.x)) * W));
    const sy = Math.max(0, Math.floor(Math.min(...areas.map((a) => a.y)) * H));
    const sw = Math.max(1, Math.min(W, Math.ceil(Math.max(...areas.map((a) => a.x + a.w)) * W)) - sx);
    const sh = Math.max(1, Math.min(H, Math.ceil(Math.max(...areas.map((a) => a.y + a.h)) * H)) - sy);
    const k = Math.min(1, Math.sqrt(SEND_PIXELS / (sw * sh)));
    let img;
    if (k < 1) {
      const c = document.createElement('canvas');
      c.width = Math.round(sw * k);
      c.height = Math.round(sh * k);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, c.width, c.height);
      img = ctx.getImageData(0, 0, c.width, c.height);
    } else {
      img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(sx, sy, sw, sh);
    }
    const sent = areas.map((a) => ({ ...a, x: (a.x * W - sx) / sw, y: (a.y * H - sy) / sh, w: (a.w * W) / sw, h: (a.h * H) / sh }));
    const res = await ask('read', { image: { width: img.width, height: img.height, data: img.data }, areas: sent }, [img.data.buffer]);
    const fx = sw / img.width;
    const fy = sh / img.height;
    for (const a of res) for (const l of a.lines) l.box = [sx + l.box[0] * fx, sy + l.box[1] * fy, sx + l.box[2] * fx, sy + l.box[3] * fy];
    return res;
  } finally {
    busy--;
    idle();
  }
}

/** Text in areas of a canvas, for checks and the bench page: see readAreas (PP-OCR only). */
export async function readText(canvas, areas) {
  if ((await getWorker()).kind !== 'ppocr') throw new Error('PP-OCR is not running here');
  return readAreas(canvas, areas);
}

// What PP-OCR reads, as the spike measured it: text searched for at 960 px across the name
// area and 800 px across each number area; a whole card or picture at most 960 px.
const NAME_AREA = { ...NAME_REGION, width: 960 };
const NUMBER_AREAS = NUMBER_REGIONS.map((r) => ({ ...r, width: 800 }));
const STAMP_AREA = { ...STAMP_REGION, width: 960 };
const WHOLE_AREA = { x: 0, y: 0, w: 1, h: 1, maxSide: 960 };

const textOf = (lines) => lines.map((l) => l.text).join('\n');
// PP-OCR lines as parse.js takes them (height in pixels, confidence 0–100).
const asLines = (lines) => lines.map((l) => ({ text: l.text, height: l.box[3] - l.box[1], conf: l.score * 100, y: l.box[1] }));

/**
 * Text on the lower artwork, where set logos, 1st Edition and other stamps sit (for stamps.js).
 * Read once the result sheet shows a card that comes stamped (live scans), or by identify.
 */
export async function readStamps(card) {
  const r = await getWorker();
  if (r.kind === 'tesseract') return r.mod.readStamps(card);
  const [a] = await readAreas(card, [STAMP_AREA]);
  return textOf(a.lines);
}

// ---------- finding the card ----------

// Printed set sizes, from the card list once it is in: a number OCR mangled is still found
// next to one of them (see parse.js).
// (`cut`: 3-digit ones without their last digit.)
let sizes = { of: null, set: undefined, cut: undefined };
export function setSizes() {
  const sets = catalog.index?.setsById;
  if (sets && sizes.of !== sets) {
    const set = new Set([...sets.values()].map((s) => s.cardCount?.official).filter((n) => n >= 20));
    sizes = { of: sets, set, cut: new Set([...set].filter((n) => n >= 100).map((n) => Math.floor(n / 10))) };
  }
  return sizes.set;
}

/**
 * A number read with a set size that exists, or one that lost its last digit (see
 * sizeRank), or a promo's ("SWSH050"): a lone one ("041") may be anything, upside-down text
 * too, and "11/59" read off "Illus." is no number.
 */
export function numberFound(bottom) {
  return bottom.numbers.some((n) => n.prefix || sizeRank(n.total) < 2);
}

/**
 * How sure a number's set size is: 0 one that exists, 1 one whose last digit was lost (a
 * thin "1" at the end: "16/11" for 16/111), 2 another, 3 none.
 */
function sizeRank(total) {
  const known = setSizes();
  if (total == null) return 3;
  if (!known || known.has(total)) return 0;
  return sizes.cut.has(total) ? 1 : 2;
}

export function mergeBottom(a, b) {
  const key = (n) => `${n.prefix}|${n.num}|${n.total}`;
  const seen = new Set(a.numbers.map(key));
  return {
    // Numbers read with a set size that exists first: a lone one ("067") is more often
    // something else (see sizeRank).
    numbers: [...a.numbers, ...b.numbers.filter((n) => !seen.has(key(n)))].sort((x, y) => sizeRank(x.total) - sizeRank(y.total)),
    setCodes: [...new Set([...a.setCodes, ...b.setCodes])],
    codeCandidates: [...new Set([...a.codeCandidates, ...b.codeCandidates])],
  };
}

// A dictionary match this good (see match.findNamesInText) counts as a known card name.
export const KNOWN = 0.75;

// Keep a sliver around a found card, in case an edge was found on its inner frame.
const WARP_MARGIN = 0.015;

function looksLikeCard(canvas) {
  const a = canvas.width / canvas.height;
  return a > CARD_ASPECT * 0.85 && a < CARD_ASPECT * 1.18;
}

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
 *   first:  the card as found (or the camera guide crop)
 *   turns:  the same card other ways up, tried when the first read doesn't look the right
 *           way up
 *   others: other outlines, tried when no number or clear name was read yet
 *   light:  no card found: a card-shaped picture read as is, once
 * A camera guide crop is the card already (upright, or held upside down) when the card
 * fills it. When the card found in it (quickly, on a small copy) clearly doesn't, that
 * card is straightened and read instead, the crop as is only if that fails.
 * In a photo the card is found first; a whole photo is read as is only when no card was
 * found in it.
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
 * Find the card in a picture (see plan): shows that the tap was taken first, notes how the
 * card was found in debug.detect. Returns { guide, found, todo }.
 */
export async function cardViews(canvas, onStatus, debug) {
  const guide = guideCrops.has(canvas);
  // Show that the tap was taken before the first long step (a guide crop is mostly card:
  // it is looked for quickly, on a small copy).
  onStatus?.(guide ? 'Reading card…' : 'Finding the card…');
  await nextPaint();
  let found = null;
  if (guide) {
    found = findCard(canvas, { detectSize: GUIDE_DETECT_SIZE });
    debug.detect = `camera guide crop, ${describe(found)}`;
  } else {
    found = findCard(canvas);
    debug.detect = describe(found);
  }
  return { guide, found, todo: plan(canvas, guide, found) };
}

// ---------- reading a card ----------

/**
 * Read a card image: the camera guide crop, or any photo with a card in it
 * (the card is found, straightened and then read; turned around or sideways cards too).
 *   opts.findName(text) -> { name, score } | null | undefined
 *     optional dictionary lookup (identify.js passes the catalog). Finds a known card
 *     name inside OCR text; undefined means "can't tell" (catalog not loaded yet).
 * Returns {
 *   clues: { nameBest, nameAll, numbers, setCodes, codeCandidates, artText: '' },
 *          artText is for readStamps(card) to fill in (identify.js, or the result sheet
 *          for a live scan once a card shown comes stamped)
 *   debug: { name, bottom, full, detect, reads, steps } raw OCR text per area, how the card
 *          was found, how many areas were read (text found and read in each) and what was
 *          read in which order,
 *   card:  the card as read, as a canvas: straightened (portrait, ~600–1000 px wide, 1.5%
 *          margin), or the camera guide crop; null when no card was found or read in a
 *          photo. Areas are fractions of it (NAME_REGION, NUMBER_REGIONS, ART_REGION).
 * }
 * The name and number areas are read first; the whole card only when they gave no number
 * or no known name. Which way up the card is comes from what was read: a number, or a
 * clearly read card name (never from how sure the reader was of its letters: upside-down
 * text reads as confidently as the right way up).
 */
export async function readCard(canvas, onStatus, opts = {}) {
  const r0 = await getWorker();
  if (r0.kind === 'tesseract') return r0.mod.readCard(canvas, onStatus, opts);
  const debug = { name: '', bottom: '', full: '', detect: '', reads: 0, steps: [], engine: 'ppocr' };
  const read = (card, areas) => {
    debug.reads += areas.length;
    return readAreas(card, areas);
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
  // Upside-down or sideways text can read as a short name with a letter or two off; read
  // the right way up, names nearly always come out whole.
  const isSure = (text) => isKnown(text, 0.9);

  const { todo } = await cardViews(canvas, onStatus, debug);

  /** A view's name and number areas, read in one go. */
  const readView = async (v) => {
    const [n, ...b] = await read(v.card, [NAME_AREA, ...NUMBER_AREAS]);
    const bottomText = textOf(b.flatMap((a) => a.lines));
    return { v, name: pickName(asLines(n.lines)), text: textOf(n.lines), bottom: parseBottomText(bottomText, { totals: setSizes() }), bottomText };
  };
  // A name line that reads clearly as a card name, and is mostly that name: upside-down text
  // often holds a short one ("Paras" in "ANppara", "Inkay" in a line of junk, or "MEW" read
  // off an upside-down "MEW EN" set code).
  const letters = (t) => normalize(t).replace(/ /g, '').length;
  const clearName = (t) => {
    const k = lookup(t);
    return k === undefined ? !!t : !!k && k.score >= 0.9 && letters(k.name) >= 0.6 * letters(t);
  };
  // The right way up: a number, or the name line read clearly.
  const upright = (r) => numberFound(r.bottom) || clearName(r.name.best);
  const knownName = (r) => isKnown(r.name.best) || isKnown(r.text);
  const summary = (r) => `${r.v.how}: name "${r.name.best}"${knownName(r) ? ' (known)' : ''}, ${numberFound(r.bottom) ? `number ${r.bottom.numbers[0].text}` : 'no number'}`;

  const tried = [];
  let card = null;
  let bottom = { numbers: [], setCodes: [], codeCandidates: [] };
  let name = { best: '', all: '' };
  let nameText = '';
  const use = (r) => {
    card = r.v.card;
    name = { ...r.name };
    nameText = r.text;
    bottom = r.bottom;
  };
  const numbered = () => numberFound(bottom);
  // A number or a clearly read name means this is the card, the right way up.
  const done = () => numbered() || isSure(name.best) || isSure(nameText);

  let turned = false;
  if (todo.first) {
    onStatus?.('Reading card name and number…');
    await nextPaint();
    const first = await readView(todo.first);
    tried.push(first);
    use(first);
    debug.steps.push(summary(first));
    if (!upright(first) && todo.turns.length) {
      // Maybe the card is the other way round: taken that way, it must read clearly (a
      // number or a clear name); failing that, a known name read only that way round.
      onStatus?.('Turning the card…');
      let turn = null;
      for (const v of todo.turns) {
        const t = await readView(v);
        tried.push(t);
        debug.steps.push(summary(t));
        if (upright(t)) {
          turn = t;
          break;
        }
      }
      if (!turn && !knownName(first)) turn = tried.slice(1).find(knownName) || null;
      if (turn) {
        use(turn);
        turned = true;
        debug.steps.push(`-> ${turn.v.how}`);
      }
    }
    // A whole photo read as is is only the card if it read like one.
    if (todo.light && !done()) card = null;
  }

  // Other outlines (the card in a toploader when the toploader was taken, or the other way
  // round), unless the card was just found to be the other way round.
  if (!done() && !turned) {
    for (const v of todo.others()) {
      onStatus?.('Reading card name and number…');
      const r = await readView(v);
      tried.push(r);
      debug.steps.push(summary(r));
      bottom = mergeBottom(bottom, r.bottom);
      if (!isKnown(name.best) && !isKnown(nameText)) {
        if (isKnown(r.name.best) || !name.best) {
          name = { ...r.name };
          card = v.card;
        }
        nameText += `\n${r.text}`;
      }
      if (done()) break;
    }
  }
  const label = (r) => (tried.length > 1 ? `[${r.v.how}]\n` : '');
  debug.name = tried.map((r) => label(r) + r.text).join('\n');
  debug.bottom = tried.map((r) => label(r) + r.bottomText).join('\n');

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
    const whole = async (src) => {
      const [res] = await read(src, [WHOLE_AREA]);
      const text = textOf(res.lines);
      return { src, res, text, bottom: parseBottomText(text, { totals: setSizes() }) };
    };
    // The whole card: at that scale the reader often gets a number (or name) its own
    // area's read missed. No card found or read: the whole picture.
    let w = await whole(card || canvas);
    debug.steps.push(card ? 'read card' : 'read picture');
    // Nothing usable either way round, nor in the whole card: maybe it is upside down after
    // all (or the picture is): the whole of it the other way round.
    const nothing = (x) => !numberFound(x.bottom) && !isKnown(x.text);
    if (!numbered() && !nameKnown && nothing(w)) {
      const back = card ? tried.slice(0, 1 + todo.turns.length).map((r) => r.v.card).find((c) => c !== card) : turnAround(canvas, SEND_PIXELS);
      if (back) {
        const w2 = await whole(back);
        debug.steps.push(`read ${card ? 'card' : 'picture'} the other way round`);
        if (!nothing(w2)) {
          w = w2;
          if (card) card = back;
        }
      }
    }
    debug.full = fullText = w.text;
    bottom = mergeBottom(bottom, w.bottom);
    if (!name.best) {
      // Name is the tallest text in the top half of the picture.
      const top = w.res.lines.filter((l) => l.box[1] < w.src.height * 0.5);
      const picked = pickName(asLines(top.length ? top : w.res.lines));
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
