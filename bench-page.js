// The hidden speed test page (bench.html, not linked from the app): how fast scanning runs on
// this phone, so the owner can send the numbers back. One tap on Run measures, in order:
//   - this phone and browser: model and versions where the browser tells, processor cores,
//     memory (Android), WebAssembly SIMD (the text reader needs it), cross-origin isolation,
//     WebGPU, storage, which of the app's big files are saved;
//   - the camera, opened the way the scanner opens it: the resolution it really gives;
//   - loading: the card list, set codes, the card details file, the text reader's start-up;
//   - scans of a few sample cards (public TCGdex pictures, or drawn ones offline), each as a
//     camera scan (cut out of a frame the camera's size, as the scanner cuts out its guide)
//     and as a phone photo (a 12-megapixel JPEG, as the Photo button gets it), twice: the
//     first time through and again. Each with the same identify() the scanner runs, timed
//     tap to result and per step (finding the card, reading text, matching), plus the stamp
//     check the result sheet runs for cards that come stamped;
//   - memory: the text reader's (WebAssembly) memory, also after six whole-card reads, and
//     the JavaScript heap where the browser tells (Chrome);
//   - the text reader restarting (it is stopped when idle), and a search speed test sized
//     like a planned picture-matching index.
// Works with either text reader (PP-OCR, or Tesseract where PP-OCR can't run, and older app
// versions that only have Tesseract) and says which one ran. "Copy results" copies a short
// summary plus the full results as one line of JSON.
// URL options: ?samples=N (how many sample cards, default all), ?passes=N (default 2),
// ?camera=0 (skip the camera), ?reader=tesseract (measure the Tesseract reader the app used
// before PP-OCR, still its fallback: the baseline), ?auto=1 (start without a tap, for
// automated runs; the results are always in window.benchResults too).
import * as ocr from './js/ocr.js';
import { identify } from './js/identify.js';
import { catalog, initCatalog, abbrReady } from './js/catalog.js';
import * as api from './js/api.js';
import { rankCandidates, confidence } from './js/match.js';

const loadedAt = performance.now();
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const now = () => performance.now();
const ms = (t) => Math.round(now() - t);
const sleep = (t) => new Promise((resolve) => setTimeout(resolve, t));
const MB = (bytes) => (bytes == null ? null : Math.round(bytes / 2 ** 20));
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[s.length >> 1] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};
/** A promise that gives up after `t` ms (resolving to `fallback`). */
const within = (p, t, fallback = null) => Promise.race([p, sleep(t).then(() => fallback)]);

// The same smallest module using a WebAssembly SIMD instruction as ocr.js checks.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
const validate = typeof WebAssembly === 'object' ? WebAssembly.validate.bind(WebAssembly) : null;
// ?reader=tesseract: ocr.js's check for PP-OCR (only that exact probe) says no, so the app reads
// with its Tesseract fallback (Tesseract's own SIMD check still passes: its fast build runs).
const FORCE_TESSERACT = params.get('reader') === 'tesseract';
if (FORCE_TESSERACT && validate) {
  const probe = (b) => {
    const a = b instanceof ArrayBuffer ? new Uint8Array(b) : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : null;
    return !!a && a.length === SIMD_PROBE.length && a.every((x, i) => x === SIMD_PROBE[i]);
  };
  WebAssembly.validate = (b) => (probe(b) ? false : validate(b));
}
// What the scanner asks the camera for (ocr.startCamera).
const CAMERA = { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } };
// A frame to cut camera scans from when the camera can't be opened here.
const DEFAULT_FRAME = { width: 1080, height: 1920 };
// A phone photo (12 MP, portrait), as the Photo button gets it.
const PHOTO = { width: 3024, height: 4032 };
const SAVED = 'card-scanner-bench'; // the run so far, kept in case the page is reloaded mid-run

// Public card pictures from TCGdex (the pictures the app shows), from different eras: where the
// number and set code sit and how the text looks differ. `draw`: the drawn stand-in.
const SAMPLES = [
  { id: 'base1-4', path: 'base/base1/4', name: 'Charizard, Base Set (1999)' },
  { id: 'sv03-125', path: 'sv/sv03/125', name: 'Charizard ex, Obsidian Flames (2023)' },
  { id: 'swsh4-25', path: 'swsh/swsh4/25', name: 'Charizard, Vivid Voltage (2020)' },
  { id: 'sm115-7', path: 'sm/sm115/7', name: 'Charmander, Hidden Fates (2019)' },
  { id: 'dp1-1', path: 'dp/dp1/1', name: 'Dialga, Diamond & Pearl (2007)' },
];
// Drawn cards (as the app's tests draw them), used when a picture can't be downloaded.
const DRAWN = [
  { id: 'base1-4', name: 'Charizard (drawn)', border: '#f0cc3a', inner: '#e9e4d4', title: 'Charizard', hp: '120 HP', evolves: 'Evolves from Charmeleon', bottomRight: '4/102 ★', illus: 'Illus. Mitsuhiro Arita', nameSize: 34 },
  { id: 'sv03-125', name: 'Charizard ex (drawn)', border: '#c9ccd1', inner: '#f1ede3', stage: 'STAGE 2', title: 'Charizard ex', hp: 'HP 330', evolves: 'Evolves from Charmeleon', bottomLeft: 'G  OBF EN  125/197 ★', attack: 'Burning Darkness' },
  { id: 'me03-024', name: 'Aurorus (drawn)', border: '#c9ccd1', inner: '#bfe0f2', stage: 'STAGE 2', title: 'Aurorus', hp: 'HP 170', evolves: 'Evolves from Amaura', bottomLeft: 'J  POR EN  024/088 ★', attack: 'Freezing Chill', illus: 'Illus. HACCAN' },
];

const results = { bench: 1, started: null, finished: false, step: '', steps: {}, scans: [] };
window.benchResults = results;

// ---------- small helpers ----------

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.round(w);
  c.height = Math.round(h);
  return c;
}
/** Give a canvas's memory back now (iPhones limit the total canvas memory of a page). */
function free(c) {
  if (c && c.width) {
    c.width = 0;
    c.height = 0;
  }
}
const size = (c) => (c?.width ? `${c.width}x${c.height}` : null);
const errorText = (e) => String(e?.message || e || 'failed').slice(0, 200);

function setStatus(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

function save() {
  try {
    localStorage.setItem(SAVED, JSON.stringify(results));
  } catch {
    /* private browsing: the run just isn't kept */
  }
}

/** Run one step: its result (or error) goes in results.steps[key]; saved and shown as it goes. */
async function step(key, label, fn) {
  results.step = label;
  setStatus(`${label}…`);
  save();
  try {
    results.steps[key] = await fn();
  } catch (e) {
    console.warn(key, e);
    results.steps[key] = { error: errorText(e) };
  }
  save();
  render();
  await sleep(30);
}

// ---------- this phone ----------

async function device() {
  const ua = navigator.userAgent;
  const ios = /(?:iPhone|iPad|iPod).*? OS (\d+)[_.](\d+)(?:[_.](\d+))?/.exec(ua);
  const ipadAsMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const safari = /Version\/([\d.]+).*Safari/.exec(ua);
  const chrome = /(?:Chrome|CriOS)\/([\d.]+)/.exec(ua);
  const firefox = /(?:Firefox|FxiOS)\/([\d.]+)/.exec(ua);
  const android = /Android ([\d.]+)/.exec(ua);
  const out = {
    ua,
    os: null,
    browser: safari && !chrome ? `Safari ${safari[1]}` : chrome ? `${/CriOS/.test(ua) ? 'Chrome (iOS)' : 'Chrome'} ${chrome[1]}` : firefox ? `Firefox ${firefox[1]}` : null,
    model: null,
    cores: navigator.hardwareConcurrency ?? null,
    memoryGB: navigator.deviceMemory ?? null,
    screen: `${screen.width}x${screen.height}`,
    pixelRatio: devicePixelRatio,
    viewport: `${innerWidth}x${innerHeight}`,
    homeScreen: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
    crossOriginIsolated: self.crossOriginIsolated === true,
    sharedMemory: typeof SharedArrayBuffer === 'function',
    wasmSimd: false,
    webgpu: null,
    serviceWorker: !!navigator.serviceWorker?.controller,
    pageLoadMs: Math.round(loadedAt),
  };
  if (ios) {
    // Since iOS 26 Safari's user agent keeps saying iOS 18.6; Safari's own version is the iOS version.
    const fromUa = `${ios[1]}.${ios[2]}${ios[3] ? `.${ios[3]}` : ''}`;
    const sv = safari && parseFloat(safari[1]);
    out.os = sv >= 26 && +ios[1] < sv ? `iOS ${safari[1]} (user agent says ${fromUa})` : `iOS ${fromUa}`;
  } else if (ipadAsMac) out.os = `iPadOS (desktop mode)${safari ? `, Safari ${safari[1]}` : ''}`;
  else if (android) out.os = `Android ${android[1]}`;
  else if (/Macintosh/.test(ua)) out.os = 'macOS';
  else out.os = navigator.userAgentData?.platform || navigator.platform || null;
  try {
    // Chrome (Android) tells the model and the real Android version when asked.
    const hi = await within(navigator.userAgentData?.getHighEntropyValues?.(['model', 'platformVersion']) ?? Promise.resolve(null), 2000);
    if (hi?.model) out.model = hi.model;
    if (hi?.platformVersion && android) out.os = `Android ${hi.platformVersion.split('.')[0]}`;
  } catch {
    /* not offered */
  }
  try {
    out.wasmSimd = !!validate && validate(SIMD_PROBE);
  } catch {
    out.wasmSimd = false;
  }
  out.webgpu = await within(webgpu(), 3000, 'no answer');
  try {
    const est = await within(navigator.storage?.estimate?.() ?? Promise.resolve(null), 2000);
    if (est) out.storage = { usedMB: MB(est.usage), quotaMB: MB(est.quota) };
    out.storageKept = (await within(navigator.storage?.persisted?.() ?? Promise.resolve(null), 2000)) ?? null;
  } catch {
    /* not offered */
  }
  out.appFiles = await savedFiles();
  return out;
}

async function webgpu() {
  if (!navigator.gpu) return 'not available';
  try {
    const a = await navigator.gpu.requestAdapter();
    if (!a) return 'no adapter';
    const info = a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : {});
    const parts = [info.vendor, info.architecture, info.device || info.description].filter(Boolean);
    return `yes${parts.length ? ` (${parts.join(', ')})` : ''}${a.features?.has('shader-f16') ? ', 16-bit floats' : ''}`;
  } catch (e) {
    return `error: ${errorText(e)}`;
  }
}

/** The app's big files (models, runtime, card details) saved on this phone: { saved, of, MB } or null. */
async function savedFiles() {
  let list = null;
  try {
    list = (await import('./js/assets.js')).ASSETS;
  } catch {
    return null; // an app version without them
  }
  const paths = Object.keys(list || {});
  const out = { saved: null, of: paths.length, MB: MB(paths.reduce((s, p) => s + (list[p].bytes || 0), 0)), versions: [...new Set(paths.map((p) => p.split('/')[1]))] };
  if (typeof caches === 'undefined') return out;
  try {
    let saved = 0;
    for (const p of paths) if (await caches.match(new URL(p, location.href).href)) saved++;
    out.saved = saved;
  } catch {
    /* storage blocked */
  }
  return out;
}

// ---------- the camera ----------

async function camera() {
  if (params.get('camera') === '0') return { skipped: true };
  if (!navigator.mediaDevices?.getUserMedia) return { error: 'this browser cannot open the camera' };
  let permission = null;
  try {
    permission = (await within(navigator.permissions?.query({ name: 'camera' }) ?? Promise.resolve(null), 1000))?.state ?? null;
  } catch {
    /* not offered */
  }
  const t = now();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: CAMERA });
  } catch (e) {
    return { error: e?.name === 'NotAllowedError' ? 'camera permission was denied' : `${e?.name || 'error'}: ${errorText(e)}` };
  }
  try {
    const track = stream.getVideoTracks()[0];
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.srcObject = stream;
    await within(video.play().catch(() => {}), 5000);
    for (let i = 0; i < 50 && !video.videoWidth; i++) await sleep(100);
    const startMs = ms(t);
    const s = track.getSettings?.() || {};
    const caps = track.getCapabilities?.() || {};
    const out = {
      permissionBefore: permission,
      startMs,
      asked: '3840x2160',
      given: s.width ? `${s.width}x${s.height}` : null,
      frame: video.videoWidth ? `${video.videoWidth}x${video.videoHeight}` : null,
      fps: s.frameRate ? Math.round(s.frameRate) : null,
      facing: s.facingMode || null,
      largest: caps.width?.max ? `${caps.width.max}x${caps.height?.max}` : null,
      torch: !!caps.torch,
      focus: caps.focusMode || null,
      zoom: caps.zoom ? `${caps.zoom.min}-${caps.zoom.max}` : null,
      takePhoto: typeof ImageCapture === 'function',
      label: track.label || null,
    };
    if (out.takePhoto) {
      try {
        const pc = await within(new ImageCapture(track).getPhotoCapabilities(), 3000);
        if (pc?.imageWidth?.max) out.photo = `${pc.imageWidth.max}x${pc.imageHeight?.max}`;
      } catch (e) {
        out.photo = `error: ${errorText(e)}`;
      }
    }
    if (video.videoWidth) frameSize = { width: video.videoWidth, height: video.videoHeight };
    video.srcObject = null;
    return out;
  } finally {
    stream.getTracks().forEach((tr) => tr.stop());
  }
}
let frameSize = null; // the camera's frame as the scanner sees it, once known

// ---------- loading ----------

async function loading() {
  const out = {};
  let t = now();
  let downloaded = false;
  await initCatalog((m) => {
    if (/download/i.test(m)) downloaded = true;
  });
  out.cardListMs = ms(t);
  out.cardListFrom = downloaded ? 'downloaded' : 'saved on this phone';
  out.cards = catalog.index?.entries?.length ?? null;
  t = now();
  await abbrReady();
  out.setCodesMs = ms(t);
  if (typeof api.loadDetails === 'function') {
    t = now();
    const d = await api.loadDetails();
    out.detailsFileMs = ms(t);
    out.detailsFile = d ? `${d.size} cards` : 'could not be loaded';
  } else out.detailsFile = 'not in this app version';
  return out;
}

/** The sample cards' pictures: TCGdex's, else drawn. */
async function pictures() {
  const n = Math.max(1, Math.min(SAMPLES.length, +params.get('samples') || SAMPLES.length));
  const t = now();
  let bytes = 0;
  const got = await Promise.all(
    SAMPLES.slice(0, n).map(async (s, i) => {
      for (const ext of ['webp', 'png']) {
        try {
          const res = await within(fetch(`https://assets.tcgdex.net/en/${s.path}/high.${ext}`, { mode: 'cors' }), 15000);
          if (!res?.ok) continue;
          const blob = await res.blob();
          const img = await createImageBitmap(blob);
          bytes += blob.size;
          return { id: s.id, name: s.name, from: 'TCGdex', img };
        } catch {
          /* the other format, else a drawn card */
        }
      }
      const d = DRAWN[i % DRAWN.length];
      return { id: d.id, name: d.name, from: 'drawn', img: drawCard(d) };
    }),
  );
  samples = got;
  return { ms: ms(t), downloadedKB: Math.round(bytes / 1024), cards: got.map((s) => `${s.id} (${s.from})`) };
}
let samples = [];

/** A simplified card, drawn as the app's tests draw one (tests/harness.mjs makeCard). */
function drawCard(spec) {
  const W = 630;
  const H = 880;
  const k = 2;
  const card = canvas(W * k, H * k);
  const c = card.getContext('2d');
  c.scale(k, k);
  c.fillStyle = spec.border;
  c.fillRect(0, 0, W, H);
  c.fillStyle = spec.inner;
  c.fillRect(22, 22, W - 44, H - 44);
  const g = c.createLinearGradient(0, 100, W, 420);
  g.addColorStop(0, '#d2553a');
  g.addColorStop(0.5, '#3a3550');
  g.addColorStop(1, '#f2b24a');
  c.fillStyle = g;
  c.fillRect(48, 104, W - 96, 320);
  for (let i = 0; i < 400; i++) {
    c.fillStyle = `hsla(${(i * 37) % 360},70%,50%,.25)`;
    c.fillRect(((i * 97) % 520) + 48, ((i * 61) % 300) + 110, 18, 14);
  }
  c.fillStyle = '#111';
  if (spec.stage) {
    c.font = 'bold 15px sans-serif';
    c.fillText(spec.stage, 44, 52);
  }
  c.font = `bold ${spec.nameSize || 38}px sans-serif`;
  c.fillText(spec.title, spec.stage ? 110 : 50, 72);
  c.font = 'bold 30px sans-serif';
  c.textAlign = 'right';
  c.fillText(spec.hp, W - 50, 72);
  c.textAlign = 'left';
  if (spec.evolves) {
    c.font = '13px sans-serif';
    c.fillText(spec.evolves, 60, 96);
  }
  c.font = 'bold 22px sans-serif';
  c.fillText(spec.attack || 'Fire Spin', 120, 520);
  c.font = '15px sans-serif';
  ['Discard 2 Energy attached to this Pokémon in order', 'to use this attack. This attack does 100 damage.'].forEach((t, i) => c.fillText(t, 60, 560 + i * 22));
  c.font = '14px sans-serif';
  c.fillText('weakness ×2   resistance -30   retreat', 60, 760);
  c.font = '12px sans-serif';
  c.fillText(spec.illus || 'Illus. 5ban Graphics', 50, 812);
  c.font = 'bold 15px sans-serif';
  if (spec.bottomLeft) c.fillText(spec.bottomLeft, 50, 840);
  if (spec.bottomRight) {
    c.textAlign = 'right';
    c.fillText(spec.bottomRight, W - 50, 840);
    c.textAlign = 'left';
  }
  c.font = '9px sans-serif';
  c.fillText('©2023 Pokémon/Nintendo/Creatures/GAME FREAK', 230, 862);
  return card;
}

/** A table top, then the card on it: centred at (cx, cy), `w` wide, turned `deg` degrees. */
function scene(target, img, cx, cy, w, deg) {
  const g = target.getContext('2d');
  g.fillStyle = '#6e5238';
  g.fillRect(0, 0, target.width, target.height);
  const step = Math.max(2, Math.round(target.width / 300));
  for (let i = 0; i < 3000; i++) {
    g.fillStyle = `rgba(0,0,0,${(i % 7) / 60})`;
    g.fillRect((i * 131) % target.width, (i * 89) % target.height, step * 13, step);
  }
  const iw = img.width;
  const ih = img.height;
  g.save();
  g.translate(cx, cy);
  g.rotate((deg * Math.PI) / 180);
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, -w / 2, (-w * ih) / iw / 2, w, (w * ih) / iw);
  g.restore();
}

/** A phone photo of the card on a table (JPEG, as the Photo button gets it). */
function photoOf(img) {
  const c = canvas(PHOTO.width, PHOTO.height);
  scene(c, img, c.width / 2, c.height / 2, c.width * 0.55, 4);
  return new Promise((resolve, reject) =>
    c.toBlob(
      (b) => {
        free(c);
        b ? resolve(b) : reject(new Error('could not make the photo'));
      },
      'image/jpeg',
      0.9,
    ),
  );
}

/**
 * A camera frame (the camera's size) with the card lined up in the scanner's guide, laid out
 * off screen like the scanner's camera view (the guide sized by the same rule as the app's
 * .guide: 56 px clear above and below, at most the screen's width less 48 px). Returns
 * { video, guide, stage }: `video` is a canvas standing in for the camera's video element.
 */
function cameraFrame(img) {
  const { width: fw, height: fh } = frameSize || DEFAULT_FRAME;
  const vw = Math.min(innerWidth, 760);
  const vh = Math.round(Math.max(innerHeight * 0.68, 420));
  const gh = Math.min(vh - 112, ((vw - 48) * 88) / 63);
  const gw = (gh * 63) / 88;
  const stage = document.createElement('div');
  stage.className = 'stage';
  Object.assign(stage.style, { width: `${vw}px`, height: `${vh}px` });
  const video = canvas(fw, fh);
  Object.defineProperty(video, 'videoWidth', { value: fw });
  Object.defineProperty(video, 'videoHeight', { value: fh });
  const guide = document.createElement('div');
  Object.assign(guide.style, { left: `${(vw - gw) / 2}px`, top: `${(vh - gh) / 2}px`, width: `${gw}px`, height: `${gh}px` });
  stage.append(video, guide);
  document.body.append(stage);
  // Where the guide falls in the frame (the video fills the view, cropped: object-fit cover).
  const scale = Math.max(vw / fw, vh / fh);
  const gx = ((vw - gw) / 2 - (vw - fw * scale) / 2) / scale;
  const gy = ((vh - gh) / 2 - (vh - fh * scale) / 2) / scale;
  // Lined up by hand: a little smaller than the guide, a little off centre, turned a little.
  scene(video, img, gx + (gw / scale) * 0.51, gy + (gh / scale) * 0.5, (gw / scale) * 0.92, 1.5);
  return { video, guide, stage };
}

// ---------- scanning ----------

const FIND = /^(Finding the card|Reading card…)/;
const READ = /^(Reading card (name|number)|Turning|Reading whole card)/;
const MATCH = /^Matching card/;

/** One timed scan of a sample: 'camera' (a guide cut-out) or 'photo' (a JPEG through fileToCanvas). */
async function scanOnce(sample, how, pass) {
  let input;
  let frame = null;
  let photo = null;
  if (how === 'camera') frame = cameraFrame(sample.img);
  else photo = sample.photo || (sample.photo = await photoOf(sample.img));
  const marks = [];
  const t0 = now();
  try {
    if (frame) {
      input = ocr.captureGuide(frame.video, frame.guide);
      free(frame.video);
      frame.stage.remove();
    } else input = await ocr.fileToCanvas(photo);
    const t1 = now();
    const res = await identify(input, (m) => marks.push([m, now()]), { stamps: false });
    const t2 = now();
    const at = (re, after = 0) => marks.find(([m, t]) => re.test(m) && t >= after)?.[1];
    const tFind = at(FIND);
    const tRead = tFind != null ? at(READ, tFind) : undefined;
    const tMatch = at(MATCH);
    const detectMs = +(/(\d+) ms\)/.exec(res.debug?.detect || '')?.[1] ?? NaN);
    const row = {
      card: sample.id,
      from: sample.from,
      how,
      pass,
      input: size(input),
      cardSize: size(res.card),
      ms: Math.round(t2 - t0),
      prep: Math.round(t1 - t0),
      wait: tFind != null ? Math.round(tFind - t1) : null,
      find: tFind != null && tRead != null ? Math.round(tRead - tFind) : Number.isFinite(detectMs) ? detectMs : null,
      detect: Number.isFinite(detectMs) ? detectMs : null,
      read: tMatch != null ? Math.round(tMatch - (tRead ?? tFind ?? t1)) : null,
      match: tMatch != null ? Math.round(t2 - tMatch) : null,
      reads: res.debug?.reads ?? null,
      engine: res.debug?.engine || null,
      top: res.ranked[0]?.card.id || null,
      right: res.ranked[0]?.card.id === sample.id,
      conf: confidence(res.ranked),
    };
    // The first ranking pass alone (the matching step also looks up details and re-ranks).
    let t = now();
    rankCandidates(catalog.index, res.clues, catalog.setAbbr, 150);
    row.rank1 = ms(t);
    // The result sheet reads the artwork for stamps when the card shown comes stamped.
    if (res.card) {
      t = now();
      try {
        await ocr.readStamps(res.card);
        row.stamps = ms(t);
      } catch {
        row.stamps = null;
      }
    }
    await memory(row);
    if (res.card !== input) free(res.card);
    return row;
  } catch (e) {
    return { card: sample.id, from: sample.from, how, pass, input: size(input), ms: ms(t0), error: errorText(e) };
  } finally {
    free(input);
    if (frame) {
      free(frame.video);
      frame.stage.remove();
    }
  }
}

/** Memory figures where the browser tells: the text reader's WebAssembly memory and the JS heap. */
async function memory(into) {
  if (typeof ocr.readerStats === 'function') {
    try {
      into.wasmMB = MB((await within(ocr.readerStats(), 3000))?.wasmBytes);
    } catch {
      /* no figure */
    }
  }
  if (performance.memory?.usedJSHeapSize) into.heapMB = MB(performance.memory.usedJSHeapSize);
  return into;
}

async function readerStart() {
  // (Its files come from the internet the first time, then from the phone: see appFiles.)
  const t = now();
  const r = await ocr.getWorker();
  const out = { ms: ms(t), forced: FORCE_TESSERACT ? 'tesseract' : null };
  out.engine = r?.kind || (typeof ocr.readerStats === 'function' ? (await ocr.readerStats()).engine : 'tesseract');
  return memory(out);
}

async function scans() {
  const passes = Math.max(1, Math.min(5, +params.get('passes') || 2));
  const total = passes * samples.length * 2;
  for (let pass = 1; pass <= passes; pass++) {
    for (const s of samples) {
      for (const how of ['camera', 'photo']) {
        setStatus(`Scan ${results.scans.length + 1} of ${total}: ${s.name}, ${how === 'camera' ? 'camera' : 'photo'}…`);
        results.scans.push(await scanOnce(s, how, pass));
        save();
        render();
        await sleep(50);
      }
    }
  }
  return { passes, total };
}

/** Six whole-card text reads (the biggest text search, 960 px): time and the reader's memory after. */
async function wholeCards() {
  if (typeof ocr.readText !== 'function') return { skipped: 'only with the PP-OCR text reader' };
  if ((await ocr.getWorker())?.kind !== 'ppocr') return { skipped: 'only with the PP-OCR text reader' };
  const before = await memory({});
  const times = [];
  for (let i = 0; i < 6; i++) {
    const img = samples[i % samples.length].img;
    const card = canvas(1000, Math.round((1000 * img.height) / img.width));
    card.getContext('2d').drawImage(img, 0, 0, card.width, card.height);
    const t = now();
    await ocr.readText(card, [{ x: 0, y: 0, w: 1, h: 1, maxSide: 960 }]);
    times.push(ms(t));
    free(card);
  }
  const after = await memory({});
  return { times, median: median(times), wasmMBBefore: before.wasmMB ?? null, wasmMBAfter: after.wasmMB ?? null };
}

/** The text reader stopped (as when idle) and started again: files from the cache, set up again. */
async function restart() {
  if (typeof ocr.stopReader !== 'function') return { skipped: 'not in this app version' };
  // Only the PP-OCR reader is stopped when idle (Tesseract stays loaded).
  if ((await ocr.getWorker())?.kind !== 'ppocr') return { skipped: 'only with the PP-OCR text reader' };
  ocr.stopReader();
  await sleep(200);
  const t = now();
  await ocr.getWorker();
  return { ms: ms(t) };
}

/**
 * Plain-JavaScript search over a picture index the size of a planned one: 19,938 cards × 2
 * areas × 256 numbers (8-bit), best 5 for one query. Median of 7 runs.
 */
function search() {
  const D = 256;
  const M = 19938 * 2;
  const codes = new Int8Array(M * D);
  for (let i = 0; i < codes.length; i++) codes[i] = ((i * 2654435761) >>> 24) - 128;
  const q = new Float32Array(D).map((_, i) => Math.sin(i));
  const times = [];
  for (let rep = 0; rep < 7; rep++) {
    const t = now();
    const best = [-1e9, -1e9, -1e9, -1e9, -1e9];
    for (let m = 0; m < M; m++) {
      let s = 0;
      const o = m * D;
      for (let k = 0; k < D; k++) s += codes[o + k] * q[k];
      if (s > best[4]) {
        best[4] = s;
        best.sort((a, b) => b - a);
      }
    }
    times.push(now() - t);
  }
  return { first: Math.round(times[0]), median: Math.round(median(times)) };
}

// ---------- the run ----------

let running = false;
let ranInPage = false; // a second run in the same page finds everything loaded and started
let hiddenDuringRun = false;
document.addEventListener('visibilitychange', () => {
  if (running && document.hidden) hiddenDuringRun = true;
});

async function run() {
  if (running) return;
  running = true;
  $('run').disabled = true;
  $('copy').disabled = true;
  $('share').disabled = true;
  delete results.restored;
  Object.assign(results, { bench: 1, started: new Date().toISOString(), finished: false, step: '', steps: {}, scans: [], firstRunInPage: !ranInPage });
  ranInPage = true;
  hiddenDuringRun = document.hidden;
  let lock = null;
  try {
    lock = await within(navigator.wakeLock?.request('screen') ?? Promise.resolve(null), 2000);
  } catch {
    /* the screen may dim: keep tapping it */
  }
  const t = now();
  // The camera first, straight after the tap (a browser may only ask for it then).
  await step('camera', 'Checking the camera', camera);
  await step('device', 'Checking this phone', device);
  await step('loading', 'Loading the card list', loading);
  await step('pictures', 'Getting the sample cards', pictures);
  await step('reader', 'Starting the text reader', readerStart);
  if (samples.length) await step('scanning', 'Scanning', scans);
  await step('wholeCards', 'Reading whole cards (memory test)', wholeCards);
  await step('restart', 'Restarting the text reader', restart);
  await step('search', 'Search speed test', async () => search());
  results.totalSeconds = Math.round(ms(t) / 100) / 10;
  results.backgrounded = hiddenDuringRun;
  results.finished = true;
  results.step = '';
  save();
  render();
  lock?.release?.().catch?.(() => {});
  running = false;
  $('run').disabled = false;
  $('run').textContent = 'Run again';
  $('copy').disabled = false;
  $('share').disabled = false;
  setStatus(`Done in ${results.totalSeconds} s. Tap "Copy results" and paste them into the chat.`);
}

// ---------- results ----------

const yes = (v) => (v == null ? '—' : v ? 'yes' : 'no');
const secs = (v) => (v == null ? '—' : `${(v / 1000).toFixed(2)} s`);
const val = (v) => (v == null || v === '' ? '—' : String(v));

/** First, median and slowest times of scans (in ms). */
function timing(rows) {
  const ok = rows.filter((r) => !r.error);
  if (!ok.length) return null;
  const later = ok.slice(1).map((r) => r.ms);
  return { n: ok.length, first: ok[0].ms, median: median(later.length ? later : [ok[0].ms]), slowest: Math.max(...ok.map((r) => r.ms)), right: ok.filter((r) => r.right).length };
}

function summary() {
  const s = results.steps;
  const by = (how) => timing(results.scans.filter((r) => r.how === how));
  // Typical step times: every scan but the very first.
  const steps = (key) => median(results.scans.slice(1).filter((r) => !r.error && r[key] != null).map((r) => r[key]));
  return {
    engine: s.reader?.engine || results.scans.find((r) => r.engine)?.engine || null,
    camera: by('camera'),
    photo: by('photo'),
    later: { wait: steps('wait'), find: steps('find'), read: steps('read'), match: steps('match'), stamps: steps('stamps'), rank1: steps('rank1') },
  };
}

function table(head, rows, cls = '') {
  const t = document.createElement('table');
  const tr = (cells, tag) => {
    const r = document.createElement('tr');
    for (const c of cells) {
      const cell = document.createElement(tag);
      const [text, cls] = Array.isArray(c) ? c : [c];
      cell.textContent = text;
      if (cls) cell.className = cls;
      r.append(cell);
    }
    return r;
  };
  if (head) t.append(tr(head, 'th'));
  for (const r of rows) t.append(tr(r, 'td'));
  const wrap = document.createElement('div');
  wrap.className = `scroll ${cls}`.trim();
  wrap.append(t);
  return wrap;
}

function section(title, ...nodes) {
  const h = document.createElement('h2');
  h.textContent = title;
  return [h, ...nodes];
}

function para(text, cls = '') {
  const p = document.createElement('p');
  p.textContent = text;
  if (cls) p.className = cls;
  return p;
}

function render() {
  const s = results.steps;
  const out = [];
  if (results.restored) out.push(para(`The last run stopped during "${results.restored}" and this page was opened again. That can mean the phone ran out of memory and reloaded the page. What it measured before that is below, and "Copy results" copies it.`, 'warn'));
  if (s.device) {
    const d = s.device;
    if (d.error) out.push(...section('This phone', para(`Couldn't check: ${d.error}`)));
    else {
      out.push(
        ...section(
          'This phone',
          table(null, [
            ['System', val(d.os)],
            ['Browser', val(d.browser)],
            ...(d.model ? [['Model', d.model]] : []),
            ['Processor cores', val(d.cores)],
            ['Memory', d.memoryGB ? `${d.memoryGB} GB (as the browser rounds it)` : 'not told by this browser'],
            ['Screen', `${d.screen} points, ${d.pixelRatio}× pixels`],
            ['Opened from the Home Screen', yes(d.homeScreen)],
            ['WebAssembly SIMD (needed by the new text reader)', yes(d.wasmSimd)],
            ['Cross-origin isolation (threads)', yes(d.crossOriginIsolated)],
            ['WebGPU', val(d.webgpu)],
            ['Storage used / available', d.storage ? `${d.storage.usedMB} MB / ${d.storage.quotaMB} MB` : '—'],
            ['Storage kept for sure', yes(d.storageKept)],
            ['App files saved for offline use', d.appFiles ? `${val(d.appFiles.saved)} of ${d.appFiles.of} (${d.appFiles.MB} MB)` : 'not in this app version'],
            ['Service worker running', yes(d.serviceWorker)],
          ]),
        ),
      );
    }
  }
  if (s.camera) {
    const c = s.camera;
    out.push(
      ...section(
        'Camera',
        c.skipped
          ? para('Skipped.')
          : c.error
            ? para(`Couldn't open the camera: ${c.error}. The camera scans below assume a ${DEFAULT_FRAME.width}×${DEFAULT_FRAME.height} picture.`)
            : table(null, [
                ['Resolution the scanner asks for', c.asked],
                ['Resolution given', val(c.given)],
                ['Picture as the scanner sees it', val(c.frame)],
                ['Frames per second', val(c.fps)],
                ['Largest resolution offered', val(c.largest)],
                ['Full photos (takePhoto)', c.takePhoto ? `yes${c.photo ? `, ${c.photo}` : ''}` : 'no'],
                ['Torch', yes(c.torch)],
                ['Focus modes', c.focus ? c.focus.join(', ') : '—'],
                ['Time to open', `${secs(c.startMs)}${c.permissionBefore === 'granted' ? '' : ' (may include the permission question)'}`],
              ]),
      ),
    );
  }
  if (s.loading || s.pictures || s.reader) {
    const l = s.loading || {};
    const p = s.pictures || {};
    const r = s.reader || {};
    out.push(
      ...section(
        'Loading',
        table(null, [
          ['Card list', l.error ? `error: ${l.error}` : l.cardListMs != null ? `${secs(l.cardListMs)} (${l.cardListFrom}, ${val(l.cards)} cards)` : '—'],
          ['Set codes', secs(l.setCodesMs)],
          ['Card details file (after the card list)', l.detailsFileMs != null ? `${secs(l.detailsFileMs)} (${l.detailsFile})` : val(l.detailsFile)],
          ['Sample cards', p.error ? `error: ${p.error}` : p.ms != null ? `${secs(p.ms)}, ${p.downloadedKB} KB: ${p.cards.join(', ')}` : '—'],
          ['Text reader start-up', r.error ? `error: ${r.error}` : r.ms != null ? `${secs(r.ms)} (${r.engine}${r.forced ? ', as asked by ?reader=tesseract' : ''})` : '—'],
        ]),
      ),
    );
  }
  if (results.scans.length) {
    const sum = summary();
    const line = (t, what) => (t ? `${what}: first ${secs(t.first)}, then typically ${secs(t.median)} (slowest ${secs(t.slowest)}); right card ${t.right} of ${t.n}.` : '');
    out.push(
      ...section(
        `Scans (text reader: ${sum.engine || '—'})`,
        para(line(sum.camera, 'Camera scans')),
        para(line(sum.photo, 'Photo scans')),
        para('Times are from the tap to the result list (the prices then load from the internet). "Stamp check" runs only when the card shown also comes stamped.', 'muted small'),
        table(
          ['Card', 'How', 'Picture', ['Total', 'n'], ['Find card', 'n'], ['Read text', 'n'], ['Match', 'n'], ['Stamp check', 'n'], 'Right card'],
          results.scans.map((x) => [
            `${x.card}${x.pass > 1 ? ` (again)` : ''}`,
            x.how,
            val(x.input),
            [secs(x.ms), 'n'],
            [x.error ? 'error' : secs(x.find), 'n'],
            [secs(x.read), 'n'],
            [secs(x.match), 'n'],
            [secs(x.stamps), 'n'],
            x.error ? [x.error, 'bad'] : [x.right ? 'yes' : `no (${val(x.top)})`, x.right ? 'good' : 'bad'],
          ]),
          'wide',
        ),
      ),
    );
  }
  const w = s.wholeCards;
  const last = [...results.scans].reverse().find((x) => x.wasmMB != null || x.heapMB != null) || {};
  if (w || s.restart || s.search) {
    out.push(
      ...section(
        'Memory and other speed tests',
        table(null, [
          ['Text reader memory after the scans', last.wasmMB != null ? `${last.wasmMB} MB` : 'not measurable here'],
          ['…after 6 whole-card reads', w?.wasmMBAfter != null ? `${w.wasmMBAfter} MB` : w?.skipped || '—'],
          ['Whole-card read', w?.median != null ? `${secs(w.median)} (typical of 6)` : w?.skipped || '—'],
          ['JavaScript memory', last.heapMB != null ? `${last.heapMB} MB` : 'not told by this browser'],
          ['Text reader restart (it stops when idle)', s.restart?.ms != null ? secs(s.restart.ms) : val(s.restart?.skipped || s.restart?.error)],
          ['Search speed test (40,000 × 256)', s.search?.median != null ? `${s.search.median} ms (first ${s.search.first} ms)` : val(s.search?.error)],
        ]),
      ),
    );
  }
  if (results.finished && results.backgrounded) out.push(para('The page was in the background during the run, so some times may be too long. Run it again with the screen on.', 'warn'));
  $('out').replaceChildren(...out);
}

/** What "Copy results" copies: a few plain lines, then everything as one line of JSON. */
function copyText() {
  const sum = summary();
  const d = results.steps.device || {};
  const c = results.steps.camera || {};
  const t = (x) => (x ? `first ${secs(x.first)}, typical ${secs(x.median)}, slowest ${secs(x.slowest)}, right ${x.right}/${x.n}` : '—');
  const lines = [
    `Card scanner speed test ${results.started || ''}${results.finished ? '' : ` (stopped during: ${results.restored || results.step})`}`,
    `Phone: ${val(d.os)}, ${val(d.browser)}${d.model ? `, ${d.model}` : ''}, ${val(d.cores)} cores, text reader ${val(sum.engine)}`,
    `Camera: ${c.error || c.skipped ? val(c.error || 'skipped') : `${val(c.given)} (picture ${val(c.frame)})`}`,
    `Camera scans: ${t(sum.camera)}`,
    `Photo scans: ${t(sum.photo)}`,
    `JSON: ${JSON.stringify({ ...results, summary: sum })}`,
  ];
  return lines.join('\n');
}

async function copy() {
  const text = copyText();
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Copied. Paste the results into the chat.');
    $('copy-box').hidden = true;
    return;
  } catch {
    /* shown to copy by hand */
  }
  $('copy-box').hidden = false;
  $('copy-text').value = text;
  $('copy-text').focus();
  $('copy-text').select();
  setStatus('Select the text below and copy it.');
}

async function share() {
  try {
    await navigator.share({ title: 'Card scanner speed test', text: copyText() });
  } catch {
    /* cancelled */
  }
}

// A run cut short (the phone reloaded the page): show what it had.
try {
  const last = JSON.parse(localStorage.getItem(SAVED) || 'null');
  if (last && !last.finished && last.started) {
    Object.assign(results, last, { restored: last.step || 'the start' });
    render();
    $('copy').disabled = false;
    $('share').disabled = false;
  }
} catch {
  /* storage blocked */
}

$('run').addEventListener('click', run);
$('copy').addEventListener('click', copy);
$('share').addEventListener('click', share);
$('share').hidden = typeof navigator.share !== 'function';
if (params.get('auto') === '1') run();
