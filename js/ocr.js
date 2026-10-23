// Camera capture, image clean-up and on-device text recognition (Tesseract.js).
import { parseBottomText, pickName } from './parse.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';

// A Pokémon card is 63 × 88 mm.
export const CARD_ASPECT = 63 / 88;

// Regions of a card, as fractions of its width/height.
const NAME_REGION = { x: 0.0, y: 0.0, w: 0.86, h: 0.17 };
const BOTTOM_REGION = { x: 0.0, y: 0.84, w: 1.0, h: 0.16 };

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

/** Grayscale + contrast stretch (1st–99th percentile), optionally inverted. */
function enhance(canvas, invert = false) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    d[i] = g;
    hist[g | 0]++;
  }
  const n = d.length / 4;
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255 && (acc += hist[lo]) < n * 0.01; lo++);
  for (let acc = 0; hi > 0 && (acc += hist[hi]) < n * 0.01; hi--);
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    let v = ((d[i] - lo) * 255) / range;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    if (invert) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
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
 * Read a card image. `canvas` should be the card filling the frame (camera guide),
 * or any photo (we fall back to reading the whole picture).
 * Returns { clues, debug }.
 */
export async function readCard(canvas, onStatus) {
  const worker = await getWorker();
  const debug = { name: '', bottom: '', full: '' };
  let nameLines = [];
  let bottom = { numbers: [], setCodes: [], codeCandidates: [] };

  if (looksLikeCard(canvas)) {
    onStatus?.('Reading card name…');
    const nameImg = enhance(crop(canvas, NAME_REGION, 1600));
    const nameRes = await recognize(worker, nameImg, 11);
    nameLines = nameRes.lines;
    debug.name = nameRes.text;

    onStatus?.('Reading card number…');
    const bottomBase = crop(canvas, BOTTOM_REGION, 2200);
    const b1 = await recognize(worker, enhance(copy(bottomBase)), 11);
    debug.bottom = b1.text;
    bottom = parseBottomText(b1.text);
    if (!bottom.numbers.length) {
      // White text on dark full-art cards reads better inverted.
      const b2 = await recognize(worker, enhance(copy(bottomBase), true), 11);
      debug.bottom += `\n---inverted---\n${b2.text}`;
      bottom = mergeBottom(bottom, parseBottomText(b2.text));
    }
  }

  const name = pickName(nameLines);
  if (!bottom.numbers.length || !name.best) {
    onStatus?.('Reading whole card…');
    const full = enhance(crop(canvas, { x: 0, y: 0, w: 1, h: 1 }, Math.min(2000, Math.max(1200, canvas.width))));
    const res = await recognize(worker, full, 11);
    debug.full = res.text;
    bottom = mergeBottom(bottom, parseBottomText(res.text));
    if (!name.best) {
      // Name is the tallest text in the top half of the picture.
      const top = res.lines.filter((l) => l.y < full.height * 0.5);
      const picked = pickName(top.length ? top : res.lines);
      name.best = picked.best;
      name.all = picked.all;
    }
  }

  return {
    clues: { nameBest: name.best, nameAll: name.all, ...bottom },
    debug,
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
