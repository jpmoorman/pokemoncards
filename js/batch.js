// "Batch" tab: take many photos now, identify them later.
// Photos stay on the phone (IndexedDB) until cleared, so a batch survives closing the app.
// Public API (used by app.js):
//   initBatch()                 once at start-up (loads the saved batch, then emits 'batch:changed')
//   renderBatch()               draw #view-batch
//   enqueueCanvas(canvas)       save a cropped camera frame; resolves to the number saved (0 or 1)
//   enqueueFiles(files)         save picked photos; resolves to the number saved
//   batchCount()                photos not identified yet (sync)
// Emits 'batch:changed' when the batch changes.
//
// Saved item: { id, added, source: 'camera'|'photo', status, entry, alts, clues, debug, conf,
//               check, reviewed, saved, versions, error }
//   status  - 'waiting' | 'processing' | 'matched' | 'nomatch' | 'error'
//   entry   - entry.makeEntry() of the chosen card + version
//   alts    - [{ id, score }] ranked matches (top first) so the review sheet works after a restart
//   check   - low/medium confidence; cleared once the user reviews the item
import { $, el, emit, on, toast, confirmDialog, navigate } from './ui.js';
import { kvGet, getCard } from './api.js';
import { fileToCanvas } from './ocr.js';
import { identify } from './identify.js';
import { confidence } from './match.js';
import { catalog, catalogReady } from './catalog.js';
import { variantPrices, formatMoney } from './prices.js';
import { chooseVariant } from './stamps.js';
import { makeEntry, entryKey, entryThumb, entryNumber, unitUsd, totalUsd } from './entry.js';
import { cardImg } from './components.js';
import { showResults, openCard } from './sheet.js';
import { addToCollection } from './collection.js';

const INDEX = 'batch:items';
const photoKey = (id) => `batch:photo:${id}`;
const thumbKey = (id) => `batch:thumb:${id}`;
const MAX_SIDE = 3000; // whole photos are downscaled to this; camera crops are kept as-is
const THUMB_SIDE = 320;
const ALTS = 13; // best match + the 12 alternates the sheet shows

let items = [];
let loaded = false;
let loadP = Promise.resolve();
const thumbs = new Map(); // item id -> object URL of its thumbnail
const run = { active: false, stop: false, index: 0, total: 0, msg: '' };
let reviewing = null; // item id while its review sheet is open

const isPending = (it) => it.status === 'waiting' || it.status === 'error';
const needsCheck = (it) => it.status === 'nomatch' || (it.status === 'matched' && it.check && !it.reviewed);
const find = (id) => items.find((i) => i.id === id);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function batchCount() {
  return items.filter((i) => isPending(i) || i.status === 'processing').length;
}

function changed() {
  emit('batch:changed', {});
}

export function initBatch() {
  loadP = kvGet(INDEX).then((saved) => {
    // A photo that was mid-way when the app closed goes back in the queue.
    items = (Array.isArray(saved) ? saved : []).filter((i) => i?.id).map((i) => (i.status === 'processing' ? { ...i, status: 'waiting' } : i));
    loaded = true;
    changed();
    render();
  });
  on('sheet:closed', () => (reviewing = null));
  on('card:action', ({ action, entry }) => {
    // "Add to collection" tapped in a review sheet: remember it so "Add all" won't add it twice.
    const it = reviewing && action === 'collection' && entry && find(reviewing);
    if (!it) return;
    setChoice(it, entry);
    it.saved = true;
    persist();
    render();
  });
  document.addEventListener('visibilitychange', () => !document.hidden && run.active && keepAwake(true));
}

// ---------------- storage ----------------
// Own connection to the app's database (api.js's 'kv' store) so a failed write,
// usually a full phone, can be reported instead of silently dropped.
let dbP = null;
function idb() {
  if (!dbP) {
    dbP = new Promise((resolve, reject) => {
      const req = indexedDB.open('pokecard-scanner');
      req.onupgradeneeded = () => req.result.objectStoreNames.contains('kv') || req.result.createObjectStore('kv');
      req.onsuccess = () => {
        const d = req.result;
        d.onversionchange = () => {
          d.close(); // never block api.js upgrading the database
          dbP = null;
        };
        resolve(d);
      };
      req.onerror = () => reject(req.error);
    });
    dbP.catch(() => (dbP = null));
  }
  return dbP;
}

/** One read-write transaction on the kv store; rejects if it doesn't commit. */
async function tx(fn) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    let t;
    try {
      t = d.transaction('kv', 'readwrite');
      t.oncomplete = () => resolve();
      t.onabort = () => reject(t.error || new Error('storage error'));
      fn(t.objectStore('kv'));
    } catch (e) {
      if (e.name === 'InvalidStateError') dbP = null;
      try {
        t?.abort();
      } catch {
        /* already finished */
      }
      reject(e);
    }
  });
}

// Writes run one after another so the saved list always matches the saved photos.
let writing = Promise.resolve();
function queued(fn) {
  const p = writing.then(fn);
  writing = p.catch(() => {});
  return p;
}

let indexQueued = null;
function persist() {
  if (!indexQueued) {
    indexQueued = queued(() => {
      indexQueued = null;
      return tx((s) => s.put(items, INDEX));
    }).catch(saveFailed);
  }
  return indexQueued;
}

let alerting = false;
function saveFailed(e) {
  console.warn(e);
  if (alerting) return;
  alerting = true;
  const full = /quota|space/i.test(`${e?.name} ${e?.message}`);
  const msg = full
    ? 'Your phone is out of space for batch photos. Process the photos you have, add them to your collection, tap Clear done, then try again.'
    : `Couldn't save the photo on this phone (${e?.message || e}). In a private browsing window photos can't be kept.`;
  dialog(msg, [{ label: 'OK', value: true, primary: true }]).then(() => (alerting = false));
}

let askedPersist = false;
function askPersistence() {
  // Ask the browser not to clear saved photos when space runs low.
  if (askedPersist) return;
  askedPersist = true;
  navigator.storage?.persist?.().catch(() => {});
}

// ---------------- adding photos ----------------
function release(canvas) {
  canvas.width = canvas.height = 0; // frees memory right away (matters on iPhone)
}

function jpeg(canvas, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not compress the photo'))), 'image/jpeg', quality),
  );
}

function thumbnail(canvas) {
  const s = Math.min(1, THUMB_SIDE / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(canvas.width * s));
  c.height = Math.max(1, Math.round(canvas.height * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  return jpeg(c, 0.8).finally(() => release(c));
}

async function addPhoto(canvas, source) {
  const [blob, thumb] = await Promise.all([jpeg(canvas, 0.9), thumbnail(canvas)]);
  await loadP;
  const it = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, added: Date.now(), source, status: 'waiting' };
  await queued(async () => {
    await tx((s) => {
      s.put(blob, photoKey(it.id));
      s.put(thumb, thumbKey(it.id));
      s.put([...items, it], INDEX);
    });
    items.push(it);
  });
  changed();
  render();
}

export async function enqueueCanvas(canvas) {
  try {
    await addPhoto(canvas, 'camera');
    askPersistence();
    return 1;
  } catch (e) {
    saveFailed(e);
    return 0;
  } finally {
    release(canvas);
  }
}

export async function enqueueFiles(files) {
  const list = [...files];
  const pill = list.length > 1 ? el('div', { class: 'toast b-saving', role: 'status' }) : null;
  if (pill) document.body.append(pill);
  let added = 0;
  let unreadable = 0;
  for (const [i, f] of list.entries()) {
    if (pill) pill.textContent = `Saving photo ${i + 1} of ${list.length}…`;
    let canvas;
    try {
      canvas = await fileToCanvas(f, MAX_SIDE);
    } catch {
      unreadable++;
      continue;
    }
    try {
      await addPhoto(canvas, 'photo');
      added++;
    } catch (e) {
      saveFailed(e);
      break; // storage is full: the rest would fail too
    } finally {
      release(canvas);
    }
  }
  pill?.remove();
  if (unreadable) toast(`${plural(unreadable, 'photo')} couldn't be opened`, 3000);
  if (added) askPersistence();
  return added;
}

async function removeItems(ids) {
  const gone = new Set(ids);
  items = items.filter((i) => !gone.has(i.id));
  ids.forEach(forgetThumb);
  changed();
  render();
  await queued(() =>
    tx((s) => {
      for (const id of ids) {
        s.delete(photoKey(id));
        s.delete(thumbKey(id));
      }
      s.put(items, INDEX);
    }),
  ).catch(saveFailed);
}

// ---------------- processing ----------------
let wakeLock = null;
async function keepAwake(yes) {
  // Keep the screen on while a long batch runs (a locked phone pauses the page).
  try {
    if (yes && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!yes && wakeLock) {
      await wakeLock.release();
    }
  } catch {
    /* not supported or not allowed */
  }
}

/** Identify photos strictly one at a time (text recognition is CPU heavy). */
async function processAll(only) {
  if (run.active) return;
  const todo = only ? [only] : items.filter(isPending);
  if (!todo.length) return;
  Object.assign(run, { active: true, stop: false, index: 0, total: todo.length, msg: '' });
  keepAwake(true);
  render();
  const before = new Set(items.filter(needsCheck).map((i) => i.id));
  let found = 0;
  let failed = 0;
  for (const it of todo) {
    if (run.stop) break;
    if (!items.includes(it) || !isPending(it)) {
      run.total--;
      continue;
    }
    run.index++;
    await processItem(it);
    if (!items.includes(it)) continue; // deleted meanwhile
    if (it.status === 'matched') found++;
    if (it.status === 'error') failed++;
    persist();
    changed();
    render();
  }
  const stopped = run.stop;
  Object.assign(run, { active: false, stop: false, msg: '' });
  keepAwake(false);
  render();
  const check = items.filter((i) => needsCheck(i) && !before.has(i.id)).length;
  const parts = [`${found} identified`, check && `${check} to check`, failed && `${failed} failed`].filter(Boolean);
  toast(`${stopped ? 'Stopped' : 'Done'}: ${parts.join(', ')}`, 3000);
}

function progress(msg) {
  run.msg = msg;
  const m = $('#batch-progress-msg');
  if (m) m.textContent = msg;
  const live = $('#view-batch .bitem.processing .b-live');
  if (live) live.textContent = msg;
}

async function processItem(it) {
  it.status = 'processing';
  it.error = null;
  render();
  try {
    // Already read (only the price lookup failed last time)? Then skip the slow part.
    if (!it.alts?.length) {
      const blob = await kvGet(photoKey(it.id));
      if (!(blob instanceof Blob)) throw new Error('Photo is missing. Delete it and take it again.');
      const canvas = await fileToCanvas(blob, MAX_SIDE);
      let res;
      try {
        res = await identify(canvas, progress);
      } finally {
        release(canvas);
      }
      it.clues = res.clues;
      it.debug = res.debug;
      it.conf = confidence(res.ranked);
      it.alts = res.ranked.slice(0, ALTS).map((r) => ({ id: r.card.id, score: Math.round(r.score * 100) / 100 }));
      if (!it.alts.length) {
        Object.assign(it, { status: 'nomatch', entry: null });
        return;
      }
    }
    progress('Looking up prices…');
    let card;
    try {
      card = await getCard(it.alts[0].id);
    } catch {
      throw new Error("Couldn't load prices. Check your connection.");
    }
    if (!card) throw new Error('Card details not found.');
    const rows = variantPrices(card);
    const row = rows[chooseVariant(rows, { card, clues: it.clues })] || null;
    Object.assign(it, { status: 'matched', entry: makeEntry(card, row), versions: rows.length, check: it.conf !== 'high' });
  } catch (e) {
    console.warn(e);
    Object.assign(it, { status: 'error', error: e.message || String(e) });
  }
}

function stop() {
  run.stop = true;
  render();
}

// ---------------- review ----------------
let idMap = null;
function cardById(id) {
  const index = catalog.index;
  if (!index) return null;
  if (idMap?.index !== index) idMap = { index, map: new Map(index.entries.map((c) => [c.id, c])) };
  return idMap.map.get(id) || null;
}

/** Rebuild the sheet's ranked list from saved ids; the card the user settled on goes first. */
function rankedFor(it) {
  let alts = it.alts || [];
  if (it.entry && (it.reviewed || alts[0]?.id !== it.entry.id)) {
    const rest = alts.filter((a) => a.id !== it.entry.id);
    // A card the user picked counts as a confident match.
    alts = [{ id: it.entry.id, score: Math.max(10, (rest[0]?.score ?? 0) + 2) }, ...rest];
  }
  return alts
    .map(({ id, score }) => {
      const card = cardById(id);
      return card && { card, set: catalog.index.setsById.get(card.setId), score, reasons: [] };
    })
    .filter(Boolean);
}

async function review(it) {
  try {
    await catalogReady();
  } catch {
    /* offline without a card list: fall back to the saved card below */
  }
  const ranked = rankedFor(it);
  const opts = {
    onPick: (card, row) => pick(it.id, card, row),
    pickLabel: 'Use this card',
    preferred: it.entry?.variantId || it.entry?.variant || undefined,
  };
  reviewing = it.id;
  if (!ranked.length && it.entry) openCard(it.entry.id, opts);
  else showResults(ranked, it.clues || null, it.debug || null, opts);
}

function setChoice(it, entry, versions) {
  if (!it.entry || entryKey(it.entry) !== entryKey(entry)) it.saved = false;
  Object.assign(it, { entry, status: 'matched', reviewed: true, check: false, error: null });
  if (versions) it.versions = versions;
}

function pick(id, card, row) {
  const it = find(id);
  if (!it) return;
  setChoice(it, makeEntry(card, row), variantPrices(card).length);
  persist();
  changed();
  render();
  toast(`Photo ${items.indexOf(it) + 1}: ${card.name}${row ? ` · ${row.label}` : ''}`);
}

function openItem(id) {
  const it = find(id);
  if (!it) return;
  if (it.status === 'matched' || it.status === 'nomatch') review(it);
  else viewPhoto(id);
}

// ---------------- bulk actions ----------------
async function addAllToCollection() {
  const list = items.filter((i) => i.status === 'matched' && i.entry && !i.saved);
  if (!list.length) return;
  const unsure = list.filter(needsCheck).length;
  if (unsure) {
    const ok = await confirmDialog(
      `${unsure === 1 ? '1 card is' : `${unsure} cards are`} marked “Check” and may be the wrong card or version. Add all ${list.length} anyway?`,
      'Add all',
    );
    if (!ok) return;
  }
  for (const it of list) {
    addToCollection(it.entry);
    it.saved = true;
  }
  persist();
  render();
  toast(`Added ${plural(list.length, 'card')} to your collection`);
}

async function sendToTrade() {
  const list = items.filter((i) => i.status === 'matched' && i.entry);
  if (!list.length) return;
  const side = await dialog(`Add ${list.length === 1 ? 'the identified card' : `all ${list.length} identified cards`} to the trade as:`, [
    { label: 'Cancel', value: null },
    { label: 'You give', value: 'give', primary: true },
    { label: 'You get', value: 'get', primary: true },
  ]);
  if (!side) return;
  // Entry-only payload: trade.js reads `entry` (card/row are null for batch results).
  for (const it of list) emit('card:action', { action: `trade-${side}`, card: null, row: null, entry: { ...it.entry } });
  toast(`${plural(list.length, 'card')} added to “${side === 'give' ? 'You give' : 'You get'}”`);
  navigate('trade');
}

async function clearDone() {
  const done = items.filter((i) => i.status === 'matched');
  if (!done.length) return;
  const unsaved = done.filter((i) => !i.saved).length;
  if (unsaved) {
    const ok = await confirmDialog(
      `Remove ${plural(done.length, 'identified photo')} from the batch? ${unsaved === done.length ? (unsaved === 1 ? "It isn't" : "They aren't") : `${unsaved} of them ${unsaved === 1 ? "isn't" : "aren't"}`} in your collection yet.`,
      'Remove',
    );
    if (!ok) return;
  }
  await removeItems(done.map((i) => i.id));
  toast(`Removed ${plural(done.length, 'photo')}`);
}

async function clearAll() {
  if (!items.length) return;
  const ok = await confirmDialog(`Delete all ${plural(items.length, 'photo')} in this batch? Cards already in your collection stay there.`, 'Delete all');
  if (!ok) return;
  run.stop = true;
  items.forEach((i) => forgetThumb(i.id));
  items = [];
  changed();
  render();
  await queued(() => tx((s) => s.delete(IDBKeyRange.bound('batch:', 'batch:￿')))).catch(saveFailed);
}

// ---------------- dialogs ----------------
/** Modal with a message and buttons [{ label, value, primary }]; resolves the value (null if dismissed). */
function dialog(message, buttons, extra = null, cls = '') {
  return new Promise((resolve) => {
    const done = (v) => {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => e.key === 'Escape' && done(null);
    const wrap = el(
      'div',
      { class: `modal ${cls}`, role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'modal-backdrop', onclick: () => done(null) }),
      el(
        'div',
        { class: 'modal-panel' },
        extra,
        message ? el('p', {}, message) : null,
        el(
          'div',
          { class: 'row modal-actions' },
          buttons.map((b) => el('button', { class: `btn${b.primary ? ' primary' : ''}`, type: 'button', onclick: () => done(b.value) }, b.label)),
        ),
      ),
    );
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
  });
}

/** The original photo, large, to double-check a match. */
async function viewPhoto(id) {
  const it = find(id);
  const blob = it && (await kvGet(photoKey(id)));
  if (!(blob instanceof Blob)) {
    toast('Photo not found');
    return;
  }
  const url = URL.createObjectURL(blob);
  const n = items.indexOf(it) + 1;
  const buttons = [
    isPending(it) && !run.active ? { label: 'Identify now', value: 'process' } : null,
    it.status === 'matched' || it.status === 'nomatch' ? { label: 'Review match', value: 'review' } : null,
    it.status !== 'processing' ? { label: 'Delete', value: 'delete' } : null,
    { label: 'Close', value: null, primary: true },
  ].filter(Boolean);
  const img = el('img', { class: 'b-viewer-img', src: url, alt: `Photo ${n}` });
  const choice = await dialog(null, buttons, img, 'b-viewer');
  URL.revokeObjectURL(url);
  if (!items.includes(it)) return;
  if (choice === 'process') processAll(it);
  if (choice === 'review') review(it);
  if (choice === 'delete') removeItems([id]);
}

// ---------------- view ----------------
const isActive = () => $('#view-batch')?.classList.contains('active');

function render() {
  if (isActive()) renderBatch();
}

function forgetThumb(id) {
  const url = thumbs.get(id);
  if (url) URL.revokeObjectURL(url);
  thumbs.delete(id);
}

function thumbImg(it) {
  const img = el('img', { alt: '' });
  const show = () => (img.src = thumbs.get(it.id));
  if (thumbs.has(it.id)) show();
  else
    kvGet(thumbKey(it.id)).then((b) => {
      if (!(b instanceof Blob) || !items.includes(it)) return;
      if (!thumbs.has(it.id)) thumbs.set(it.id, URL.createObjectURL(b));
      show();
    });
  return img;
}

function counts() {
  const c = { pending: 0, waiting: 0, matched: 0, unsaved: 0, check: 0 };
  for (const it of items) {
    if (isPending(it)) c.pending++;
    if (isPending(it) || it.status === 'processing') c.waiting++;
    if (it.status === 'matched') {
      c.matched++;
      if (!it.saved) c.unsaved++;
    }
    if (needsCheck(it)) c.check++;
  }
  return c;
}

// One input, moved into whichever "Add photos" button is on screen (a <label>, which iOS handles best).
let fileInput = null;
function addPhotosButton(label) {
  if (!fileInput) {
    fileInput = el('input', {
      type: 'file',
      accept: 'image/*',
      multiple: true,
      hidden: true,
      id: 'batch-file-input',
      onchange: async (e) => {
        const files = [...(e.target.files || [])];
        e.target.value = '';
        if (!files.length) return;
        const n = await enqueueFiles(files);
        if (n) toast(`${plural(n, 'photo')} added to batch`);
      },
    });
  }
  return el('label', { class: 'btn', id: 'batch-add-photos' }, label, fileInput);
}

function startBatchScanning() {
  navigate('scan');
  const mode = $('#btn-mode');
  if (mode && mode.getAttribute('aria-pressed') !== 'true') mode.click();
}

const STACK_ICON =
  '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" aria-hidden="true"><rect x="10" y="14" width="28" height="40" rx="4" transform="rotate(-10 24 34)" opacity=".45"/><rect x="18" y="10" width="28" height="40" rx="4" opacity=".7"/><rect x="26" y="12" width="28" height="40" rx="4" transform="rotate(8 40 32)" fill="var(--bg)"/><circle cx="40" cy="30" r="6"/></svg>';

function emptyState() {
  const icon = el('div', { class: 'b-empty-icon' });
  icon.innerHTML = STACK_ICON;
  return el(
    'div',
    { class: 'b-empty' },
    icon,
    el('h2', {}, 'Snap now, price later'),
    el('p', { class: 'muted' }, 'Photograph a whole stack of cards quickly, then sit down and identify them all at once.'),
    el(
      'ol',
      { class: 'b-steps' },
      el('li', {}, el('span', {}, 'On the ', el('b', {}, 'Scan'), ' tab, turn on ', el('b', {}, 'Batch mode'), ' (top of the camera) and tap the shutter for each card. Nothing is identified yet, so it’s quick.')),
      el('li', {}, el('span', {}, 'Or pick several photos at once with ', el('b', {}, 'Library'), ' or ', el('b', {}, 'Add photos'), ' below.')),
      el('li', {}, el('span', {}, 'Come back here and tap ', el('b', {}, 'Process all'), '. Check anything marked ', el('span', { class: 'b-tag check' }, 'Check'), ', then add the cards to your collection or a trade.')),
    ),
    el(
      'div',
      { class: 'b-empty-actions' },
      el('button', { class: 'btn primary', type: 'button', onclick: startBatchScanning }, 'Start batch scanning'),
      addPhotosButton('Add photos'),
    ),
  );
}

function stats(c) {
  const stat = (n, label, cls = '') => el('div', { class: `b-stat ${cls}` }, el('b', {}, n), el('span', {}, label));
  const value = totalUsd(items.filter((i) => i.status === 'matched' && i.entry).map((i) => i.entry));
  return el(
    'div',
    { class: 'b-stats', id: 'batch-stats' },
    stat(c.waiting, 'waiting'),
    stat(c.matched, 'identified', c.matched ? 'good' : ''),
    stat(c.check, 'to check', c.check ? 'warn' : ''),
    stat(formatMoney(value), 'value', 'value'),
  );
}

function runBox(c) {
  if (run.active) {
    const pct = Math.round((100 * Math.max(0, run.index - 1)) / Math.max(1, run.total));
    return el(
      'div',
      { class: 'b-run', 'aria-live': 'polite' },
      el(
        'div',
        { class: 'b-run-top' },
        el(
          'div',
          { class: 'b-run-text' },
          el('div', { class: 'b-run-title', id: 'batch-progress' }, run.stop ? 'Stopping after this photo…' : `Processing ${run.index} of ${run.total}…`),
          el('div', { class: 'muted small', id: 'batch-progress-msg' }, run.msg),
        ),
        el('button', { class: 'btn small', id: 'batch-stop', type: 'button', disabled: run.stop, onclick: stop }, 'Stop'),
      ),
      el('div', { class: 'b-bar' }, el('span', { style: `width:${pct}%` })),
      el('p', { class: 'muted small b-run-note' }, 'You can switch tabs or review finished cards while this runs.'),
    );
  }
  return el(
    'div',
    { class: 'b-runbar' },
    c.pending
      ? el('button', { class: 'btn primary', id: 'batch-process', type: 'button', onclick: () => processAll() }, `Process all · ${plural(c.pending, 'photo')}`)
      : el('div', { class: 'b-all-done muted small' }, 'All photos processed.'),
    addPhotosButton('+ Photos'),
  );
}

function bulkActions(c) {
  if (!c.matched) return null;
  return el(
    'div',
    { class: 'b-actions' },
    el(
      'button',
      { class: 'btn', id: 'batch-add-all', type: 'button', disabled: !c.unsaved, onclick: addAllToCollection },
      c.unsaved ? `Add ${c.unsaved} to collection` : 'All in collection ✓',
    ),
    el('button', { class: 'btn', id: 'batch-trade', type: 'button', onclick: sendToTrade }, 'Send to trade…'),
  );
}

function describe(it) {
  const name = (t) => el('span', { class: 'b-name' }, t);
  const sub = (...t) => el('span', { class: 'b-sub' }, ...t);
  const tags = el(
    'span',
    { class: 'b-tags' },
    needsCheck(it) ? el('span', { class: 'b-tag check' }, 'Check') : null,
    it.saved ? el('span', { class: 'b-tag saved' }, 'In collection') : null,
  );
  const e = it.entry;
  switch (it.status) {
    case 'matched':
      return [
        name(e.name),
        sub([e.setName, entryNumber(e)].filter(Boolean).join(' · ')),
        sub(e.variant || 'Version unknown', it.versions > 1 && !it.reviewed ? el('span', { class: 'b-more' }, ` · ${it.versions} versions`) : null),
        tags.childNodes.length ? tags : null,
      ];
    case 'processing':
      return [name('Identifying…'), sub(el('span', { class: 'b-live' }, run.msg || 'Starting…'))];
    case 'nomatch':
      return [name('No match'), sub('Tap to type the name or number'), tags];
    case 'error':
      return [name('Couldn’t identify'), sub(it.error || ''), sub('Process all tries again')];
    default: {
      const t = new Date(it.added);
      const when = t.toDateString() === new Date().toDateString() ? t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : t.toLocaleDateString();
      return [name('Waiting'), sub(`Not identified yet · ${when}`)];
    }
  }
}

function row(it, n) {
  const e = it.entry;
  const unit = e ? unitUsd(e) : null;
  return el(
    'li',
    { class: `bitem ${it.status}${needsCheck(it) ? ' flag' : ''}`, 'data-id': it.id },
    el('button', { class: 'b-photo', type: 'button', 'aria-label': `View photo ${n}`, onclick: () => viewPhoto(it.id) }, thumbImg(it), el('span', { class: 'b-num' }, n)),
    el(
      'button',
      { class: 'b-main', type: 'button', onclick: () => openItem(it.id) },
      it.status === 'matched' ? cardImg(entryThumb(e), e.fallbackImage, { class: 'b-card' }) : null,
      el('span', { class: 'b-text' }, ...describe(it)),
    ),
    el(
      'span',
      { class: 'b-right' },
      it.status === 'matched' ? el('span', { class: 'b-price' }, unit != null ? formatMoney(unit) : 'No price') : null,
      it.status === 'processing' ? null : el('button', { class: 'b-remove', type: 'button', 'aria-label': `Delete photo ${n}`, onclick: () => removeItems([it.id]) }, '✕'),
    ),
  );
}

export function renderBatch() {
  const view = $('#view-batch');
  if (!loaded) {
    view.replaceChildren(el('p', { class: 'muted center' }, 'Loading…'));
    return;
  }
  if (!items.length) {
    view.replaceChildren(emptyState());
    return;
  }
  const c = counts();
  const parts = [
    stats(c),
    runBox(c),
    bulkActions(c),
    el('ol', { class: 'b-list', id: 'batch-list' }, items.map((it, i) => row(it, i + 1))),
    el(
      'div',
      { class: 'b-foot' },
      el('button', { class: 'btn small subtle', id: 'batch-clear-done', type: 'button', disabled: !c.matched, onclick: clearDone }, 'Clear done'),
      el('button', { class: 'btn small subtle', id: 'batch-clear-all', type: 'button', onclick: clearAll }, 'Clear all'),
    ),
  ];
  view.replaceChildren(...parts.filter(Boolean));
}
