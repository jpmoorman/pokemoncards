// "Batch" tab: take many photos now, identify them later.
// Photos stay on the phone (IndexedDB) until cleared, so a batch survives closing the app.
// Public API (used by app.js):
//   initBatch()                 once at start-up (loads the saved batch, then emits 'batch:changed')
//   renderBatch()               draw #view-batch
//   enqueueCanvas(canvas, opts) save a cropped camera frame; resolves to the number saved (0 or 1)
//   enqueueFiles(files, opts)   save picked photos and toast how it went; resolves to the number saved
//                               opts: { tradeSide: 'give' | 'get' } marks the photos as cards for that side
//   batchCount()                photos not identified yet (sync)
// Emits 'batch:changed' when the batch changes.
//
// Saved item: { id, added, source: 'camera'|'photo', status, entry, alts, clues, debug, conf,
//               check, reviewed, saved, traded, forTrade, versions, error }
//   status   - 'waiting' | 'processing' | 'matched' | 'nomatch' | 'error'
//   entry    - entry.makeEntry() of the chosen card + version
//   alts     - [{ id, score }] ranked matches (top first) so the review sheet works after a restart
//   check    - low/medium confidence; cleared once the user reviews the item
//   saved    - added to the collection; traded - side it was sent to ('give' | 'get'), kept in step with Swap sides
//   tradeKey - entryKey of its trade line when that line's version was changed on the Trade tab
//   forTrade - side it was photographed for (Scan in "Adding cards to" mode), until it is sent
import { $, el, emit, on, toast, actionToast, confirmDialog, navigate, restack } from './ui.js';
import { kvGet, getCard } from './api.js';
import { fileToCanvas, holdReader } from './ocr.js';
import { identify } from './identify.js';
import { confidence } from './match.js';
import { catalog, catalogReady } from './catalog.js';
import { variantPrices, formatMoney } from './prices.js';
import { chooseVariant } from './stamps.js';
import { makeEntry, entryKey, entryThumb, entryNumber, unitUsd, totalUsd } from './entry.js';
import { cardImg } from './components.js';
import { showResults, openCard } from './sheet.js';
import { addToCollection } from './collection.js';
import { inTrade } from './trade.js';
import { zoomable } from './zoom.js';

const INDEX = 'batch:items';
const photoKey = (id) => `batch:photo:${id}`;
const thumbKey = (id) => `batch:thumb:${id}`;
const MAX_SIDE = 3000; // whole photos are downscaled to this; camera crops are kept as-is
const THUMB_SIDE = 320;
const ALTS = 13; // best match + the 12 alternates the sheet shows
const SIDES = { give: 'You give', get: 'You get' };

let items = [];
let loadState = 'loading'; // 'loading' | 'ok' | 'failed' (the saved list couldn't be read)
let loadP = Promise.resolve();
const thumbs = new Map(); // item id -> object URL of its thumbnail
const run = { active: false, stop: false, index: 0, total: 0, msg: '' };
let reviewing = null; // { id } while that item's review sheet is open; also the sheet's owner token
let gen = 0; // bumped by Clear all, so saves and undos started before it are dropped

const isPending = (it) => it.status === 'waiting' || it.status === 'error';
const needsCheck = (it) => it.status === 'nomatch' || (it.status === 'matched' && it.check && !it.reviewed);
const find = (id) => items.find((i) => i.id === id);
// The trade line a sent item went into: its own card + version, unless the line's version was changed on the Trade tab.
const tradeKey = (it) => it.tradeKey || entryKey(it.entry);
// Sent to the trade and still there (the trade may have been cleared since).
const isTraded = (it) => !!it.traded && !!it.entry && inTrade(tradeKey(it));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function batchCount() {
  return items.filter((i) => isPending(i) || i.status === 'processing').length;
}

function changed() {
  emit('batch:changed', {});
}

export function initBatch() {
  loadP = load().catch((e) => {
    // Show that the batch couldn't be opened rather than an empty one; nothing is deleted or overwritten.
    console.warn(e);
    loadState = 'failed';
    changed();
    render();
  });
  on('sheet:closed', () => (reviewing = null));
  on('card:action', ({ action, entry, owner }) => {
    // A button in this item's own review sheet: remember it so the bulk buttons don't repeat it.
    const it = owner && owner === reviewing && entry && find(owner.id);
    if (!it) return;
    setChoice(it, entry);
    if (action === 'collection') it.saved = true;
    else markTraded(it, action === 'trade-give' ? 'give' : 'get');
    persist();
    render();
  });
  // The trade changes after these listeners ran, or on the Trade tab: redraw the "In trade" tags and counts.
  on('trade:changed', ({ side, from, to, swapped }) => {
    let moved = false;
    for (const it of items) {
      if (!it.traded) continue;
      if (swapped) it.traded = it.traded === 'give' ? 'get' : 'give';
      else if (from && it.traded === side && it.entry && tradeKey(it) === from) it.tradeKey = to === entryKey(it.entry) ? undefined : to;
      else continue;
      moved = true;
    }
    if (moved) persist();
    renderSoon();
  });
  on('scan:busy', scanBusy);
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

/** Read the saved list; unlike kvGet, a failed read rejects instead of looking like "no batch". */
async function readIndex() {
  const d = await idb();
  return new Promise((resolve, reject) => {
    try {
      const req = d.transaction('kv').objectStore('kv').get(INDEX);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('storage error'));
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Load the saved list (a few tries, on a new connection each time). Until it has been read,
 * nothing may write it or clean up photos: that would replace or delete the saved batch.
 */
let loading = null;
function load() {
  if (loadState === 'ok') return Promise.resolve();
  if (!loading) {
    const attempt = (n) =>
      readIndex().catch((e) => {
        dbP?.then((d) => d.close(), () => {});
        dbP = null;
        if (n >= 2) throw e;
        return new Promise((r) => setTimeout(r, 300 * (n + 1))).then(() => attempt(n + 1));
      });
    loading = attempt(0)
      .then((saved) => {
        // A photo that was mid-way when the app closed goes back in the queue.
        items = (Array.isArray(saved) ? saved : []).filter((i) => i?.id).map((i) => (i.status === 'processing' ? { ...i, status: 'waiting' } : i));
        loadState = 'ok';
        changed();
        render();
        if (Array.isArray(saved)) dropOrphans(); // only against a list that was really read
      })
      .finally(() => (loading = null));
  }
  return loading;
}

function unreadable() {
  const e = new Error("Couldn't open the batch saved on this phone, so the photo wasn't added (nothing was deleted). Close the app completely, open it again and retry.");
  e.unreadable = true;
  return e;
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
  if (loadState !== 'ok') return Promise.resolve(); // never replace a saved list that wasn't read
  if (!indexQueued) {
    indexQueued = queued(() => {
      indexQueued = null;
      return tx((s) => s.put(items, INDEX));
    }).catch(saveFailed);
  }
  return indexQueued;
}

/** Delete photos no item points to (the app closed while a deleted photo could still be undone). */
function dropOrphans() {
  const keep = new Set(items.map((i) => i.id));
  return queued(() =>
    tx((s) => {
      const req = s.getAllKeys(IDBKeyRange.bound('batch:photo:', 'batch:thumb:\uffff'));
      req.onsuccess = () => {
        for (const k of req.result) {
          const m = /^batch:(?:photo|thumb):(.+)$/.exec(k);
          if (m && !keep.has(m[1])) s.delete(k);
        }
      };
    }),
  ).catch(() => {});
}

let alerting = false;
function saveFailed(e) {
  console.warn(e);
  if (alerting) return;
  alerting = true;
  const full = /quota|space/i.test(`${e?.name} ${e?.message}`);
  const msg = e?.unreadable
    ? e.message
    : full
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

/** Save one photo; resolves false if Clear all ran since generation g (nothing is kept then). */
async function addPhoto(canvas, source, forTrade, g = gen) {
  const [blob, thumb] = await Promise.all([jpeg(canvas, 0.9), thumbnail(canvas)]);
  await loadP;
  // The write below replaces the saved list, so it must have been read: try again, else refuse.
  if (loadState !== 'ok') await load().catch(() => Promise.reject(unreadable()));
  const it = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, added: Date.now(), source, status: 'waiting' };
  if (forTrade) it.forTrade = forTrade;
  let kept = false;
  await queued(async () => {
    if (g !== gen) return;
    await tx((s) => {
      s.put(blob, photoKey(it.id));
      s.put(thumb, thumbKey(it.id));
      s.put([...items, it], INDEX);
    });
    // Cleared while writing: Clear all's delete, queued behind this write, removes it again.
    if (g !== gen) return;
    items.push(it);
    kept = true;
  });
  if (!kept) return false;
  changed();
  render();
  return true;
}

export async function enqueueCanvas(canvas, { tradeSide = null } = {}) {
  try {
    if (!(await addPhoto(canvas, 'camera', tradeSide))) return 0;
    askPersistence();
    return 1;
  } catch (e) {
    saveFailed(e);
    return 0;
  } finally {
    release(canvas);
  }
}

export async function enqueueFiles(files, { tradeSide = null } = {}) {
  const list = [...files];
  const pill = list.length > 1 ? el('div', { class: 'toast b-saving', role: 'status' }) : null;
  if (pill) document.body.append(pill);
  const g = gen;
  let added = 0;
  let unreadable = 0;
  for (const [i, f] of list.entries()) {
    if (g !== gen) break; // Clear all: stop saving the rest
    if (pill) pill.textContent = `Saving photo ${i + 1} of ${list.length}…`;
    let canvas;
    try {
      canvas = await fileToCanvas(f, MAX_SIDE);
    } catch {
      unreadable++;
      continue;
    }
    try {
      if (await addPhoto(canvas, 'photo', tradeSide, g)) added++;
    } catch (e) {
      saveFailed(e);
      break; // storage is full: the rest would fail too
    } finally {
      release(canvas);
    }
  }
  pill?.remove();
  restack();
  if (g !== gen) return 0; // cleared: the photos saved so far are gone too
  // One message, so the warning isn't replaced by the count.
  const msg = [
    added && `${plural(added, 'photo')} added to batch${tradeSide ? ` for “${SIDES[tradeSide]}”` : ''}`,
    unreadable && `${plural(unreadable, 'photo')} couldn't be opened`,
  ].filter(Boolean);
  if (msg.length) toast(msg.join(' · '), unreadable ? 4500 : 2200);
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

/** ✕ on a row (or Delete on the photo): gone at once, but the photo is kept until Undo has expired. */
const removing = new Map(); // item id -> token of its latest removal that can still be undone
function removeOne(id) {
  const it = find(id);
  if (!it) return;
  const at = items.indexOf(it);
  const g = gen;
  const token = {};
  removing.set(id, token);
  items = items.filter((i) => i !== it);
  changed();
  render();
  persist();
  const undo = () => {
    if (g !== gen || removing.get(id) !== token) return;
    removing.delete(id);
    items.splice(Math.min(at, items.length), 0, it);
    changed();
    render();
    persist();
  };
  const purge = () => {
    if (removing.get(id) !== token) return; // undone, or removed again since
    removing.delete(id);
    forgetThumb(id);
    queued(() =>
      tx((s) => {
        s.delete(photoKey(id));
        s.delete(thumbKey(id));
      }),
    ).catch(saveFailed);
  };
  actionToast(`Deleted photo ${at + 1}`, 'Undo', undo, { ms: 5000, onEnd: purge });
}

// ---------------- processing ----------------
let wakeLock = null;
async function keepAwake(yes) {
  // Keep the screen on while a long batch runs (a locked phone pauses the page).
  try {
    if (yes && !wakeLock && navigator.wakeLock) {
      const lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => wakeLock === lock && (wakeLock = null));
      if (run.active) wakeLock = lock;
      else lock.release(); // the run ended while we waited
    } else if (!yes && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  } catch {
    /* not supported or not allowed */
  }
}

/**
 * Identify waiting photos (or just `only`) strictly one at a time: text recognition is CPU heavy.
 * Photos added while it runs are picked up too; each photo is tried once per run.
 */
async function processAll(only) {
  if (run.active) return;
  const tried = new Set();
  const untried = () => (only ? [only] : items).filter((i) => items.includes(i) && isPending(i) && !tried.has(i.id));
  if (!untried().length) return;
  Object.assign(run, { active: true, stop: false, index: 0, total: untried().length, msg: 'Loading the card list…' });
  render();
  try {
    await catalogReady();
  } catch {
    // Without the card list every photo would be read and then fail; stop early instead.
    Object.assign(run, { active: false, msg: '' });
    render();
    toast("Couldn't load the card list. Check your connection and try again.", 3500);
    return;
  }
  keepAwake(true);
  // The text reader stays up between photos, also with the app in the background.
  const release = holdReader();
  const before = new Set(items.filter(needsCheck).map((i) => i.id));
  let found = 0;
  let failed = 0;
  try {
    for (let it = untried()[0]; it && !run.stop; it = untried()[0]) {
      if (scanDone) {
        // A scan on the Scan tab goes first (text recognition is shared); the list may change meanwhile.
        progress('Paused while your scan finishes…');
        // Stop works during the pause too, not only once the scan ends.
        await new Promise((resolve) => {
          run.wake = resolve;
          scanDone.then(resolve);
        });
        run.wake = null;
        continue;
      }
      tried.add(it.id);
      run.index = tried.size;
      run.total = tried.size + untried().length;
      await processItem(it);
      if (!items.includes(it)) continue; // deleted meanwhile
      if (it.status === 'matched') found++;
      if (it.status === 'error') failed++;
      persist();
      changed();
      render();
    }
  } finally {
    release();
  }
  const stopped = run.stop;
  Object.assign(run, { active: false, stop: false, msg: '' });
  keepAwake(false);
  render();
  if (!items.length) return; // cleared while running
  const check = items.filter((i) => needsCheck(i) && !before.has(i.id)).length;
  const parts = [`${found} identified`, check && `${check} to check`, failed && `${failed} failed`].filter(Boolean);
  toast(`${stopped ? 'Stopped' : 'Done'}: ${parts.join(', ')}`, 3000);
}

// Resolves when the scan running on the Scan tab ('scan:busy') is done; null while none runs.
let scanDone = null;
let scanEnd = null;
function scanBusy({ busy }) {
  if (busy && !scanDone) scanDone = new Promise((r) => (scanEnd = r));
  else if (!busy && scanDone) {
    scanDone = null;
    scanEnd();
  }
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
    const msg = e.message || String(e);
    Object.assign(it, { status: 'error', error: /fetch|network|HTTP \d/i.test(msg) ? 'No connection. Check your internet.' : msg });
  }
}

function stop() {
  run.stop = true;
  run.wake?.();
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
  const owner = { id: it.id };
  const opts = {
    owner,
    onPick: (card, row) => pick(it.id, card, row),
    pickLabel: 'Use this card',
    preferred: it.entry?.variantId || it.entry?.variant || undefined,
  };
  reviewing = owner;
  if (!ranked.length && it.entry) openCard(it.entry.id, opts);
  else showResults(ranked, it.clues || null, it.debug || null, opts);
}

function setChoice(it, entry, versions) {
  if (!it.entry || entryKey(it.entry) !== entryKey(entry)) Object.assign(it, { saved: false, traded: null, tradeKey: undefined });
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

function markTraded(it, side) {
  it.traded = side;
  delete it.tradeKey; // sent as its own card + version
  delete it.forTrade;
}

function sendList(list, side) {
  // Entry-only payload: trade.js reads `entry` (card/row are null for batch results).
  for (const it of list) {
    emit('card:action', { action: `trade-${side}`, card: null, row: null, entry: { ...it.entry } });
    markTraded(it, side);
  }
  persist();
  render();
}

const checkNote = (list) => {
  const n = list.filter(needsCheck).length;
  return n ? ` ${n === 1 ? '1 of them is' : `${n} of them are`} marked “Check” and may be the wrong card or version.` : '';
};

/** Cards already in the trade are left out; sending them again has to be asked for. */
async function sendToTrade() {
  const matched = items.filter((i) => i.status === 'matched' && i.entry);
  if (!matched.length) return;
  const fresh = matched.filter((i) => !isTraded(i));
  const inAlready = matched.length - fresh.length;
  const again = !fresh.length;
  const list = again ? matched : fresh;
  const msg = again
    ? `${matched.length === 1 ? 'This card is' : `All ${matched.length} cards are`} already in the trade. Add ${matched.length === 1 ? 'it' : 'them'} again as another copy?`
    : inAlready
      ? `Add ${plural(fresh.length, 'new card')} to the trade as: (${inAlready} already in the trade ${inAlready === 1 ? 'is' : 'are'} left out)`
      : `Add ${list.length === 1 ? 'the identified card' : `all ${list.length} identified cards`} to the trade as:`;
  const side = await dialog(msg + checkNote(list), [
    { label: 'Cancel', value: null },
    { label: again ? 'Again: You give' : 'You give', value: 'give', primary: true },
    { label: again ? 'Again: You get' : 'You get', value: 'get', primary: true },
  ]);
  if (!side) return;
  sendList(list, side);
  const to = `“${SIDES[side]}”`;
  toast(
    again
      ? `${plural(list.length, 'card')} added to ${to} again`
      : inAlready
        ? `Sent ${plural(fresh.length, 'new card')} to ${to}; ${inAlready} ${inAlready === 1 ? 'was' : 'were'} already in the trade`
        : `${plural(list.length, 'card')} added to ${to}`,
    3500,
  );
  navigate('trade');
}

/** The cards photographed for one side of the trade (Scan in "Adding cards to" mode). */
async function sendForTrade(side) {
  const list = items.filter((i) => i.forTrade === side && i.status === 'matched' && i.entry);
  if (!list.length) return;
  const unsure = list.filter(needsCheck).length;
  if (unsure) {
    const ok = await confirmDialog(
      `${unsure === 1 ? '1 card is' : `${unsure} cards are`} marked “Check” and may be the wrong card or version. Add all ${list.length} to “${SIDES[side]}” anyway?`,
      'Add all',
    );
    if (!ok) return;
  }
  sendList(list, side);
  toast(`${plural(list.length, 'card')} added to “${SIDES[side]}”`);
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
  gen++; // photos still being saved, and undos, are dropped
  removing.clear();
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
  const img = zoomable(el('img', { class: 'b-viewer-img', src: url, alt: `Photo ${n}` }));
  const choice = await dialog(null, buttons, img, 'b-viewer');
  URL.revokeObjectURL(url);
  if (!items.includes(it)) return;
  if (choice === 'process') processAll(it);
  if (choice === 'review') review(it);
  if (choice === 'delete') removeOne(id);
}

// ---------------- view ----------------
const isActive = () => $('#view-batch')?.classList.contains('active');

function render() {
  if (isActive()) renderBatch();
}

// Sending N cards changes the trade N times: draw once afterwards.
let renderQueued = false;
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    render();
  });
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
  const c = { pending: 0, waiting: 0, matched: 0, unsaved: 0, untraded: 0, check: 0 };
  for (const it of items) {
    if (isPending(it)) c.pending++;
    if (isPending(it) || it.status === 'processing') c.waiting++;
    if (it.status === 'matched') {
      c.matched++;
      if (!it.saved) c.unsaved++;
      if (!isTraded(it)) c.untraded++;
    }
    if (needsCheck(it)) c.check++;
  }
  return c;
}

// One input, moved into whichever "Add photos" button is on screen (a <label>, which iOS handles best).
let fileInput = null;
function addPhotosButton(label, cls = 'btn') {
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
        if (files.length) await enqueueFiles(files);
      },
    });
  }
  return el('label', { class: cls, id: 'batch-add-photos' }, label, fileInput);
}

function startBatchScanning() {
  navigate('scan', { batchMode: true });
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
          el(
            'div',
            { class: 'b-run-title', id: 'batch-progress' },
            run.stop ? 'Stopping after this photo…' : run.index ? `Processing ${run.index} of ${run.total}…` : 'Getting ready…',
          ),
          el('div', { class: 'muted small', id: 'batch-progress-msg' }, run.msg),
        ),
        el('button', { class: 'btn small', id: 'batch-stop', type: 'button', disabled: run.stop, onclick: stop }, 'Stop'),
      ),
      el('div', { class: 'b-bar' }, el('span', { style: `width:${pct}%` })),
      el(
        'div',
        { class: 'b-run-foot' },
        el('span', { class: 'muted small' }, 'You can switch tabs or review finished cards while this runs.'),
        addPhotosButton('+ Photos', 'btn small'),
      ),
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
    el('button', { class: 'btn', id: 'batch-trade', type: 'button', onclick: sendToTrade }, c.untraded && c.untraded < c.matched ? `Send ${c.untraded} new to trade…` : 'Send to trade…'),
  );
}

/** Photos taken for one side of the trade: one button sends just those. */
function tradeNotes() {
  return Object.keys(SIDES).map((side) => {
    const list = items.filter((i) => i.forTrade === side);
    if (!list.length) return null;
    const ready = list.filter((i) => i.status === 'matched' && i.entry).length;
    const left = list.length - ready;
    return el(
      'div',
      { class: `b-trade-note ${side}` },
      el(
        'span',
        {},
        el('b', {}, `${plural(list.length, 'photo')} for “${SIDES[side]}”`),
        left ? el('span', { class: 'muted small' }, ` · ${left} not identified yet`) : null,
      ),
      ready ? el('button', { class: 'btn small primary', id: `batch-send-${side}`, type: 'button', onclick: () => sendForTrade(side) }, `Send ${ready} to ${SIDES[side]}`) : null,
    );
  });
}

function describe(it) {
  const name = (t) => el('span', { class: 'b-name' }, t);
  const sub = (...t) => el('span', { class: 'b-sub' }, ...t);
  const tags = el(
    'span',
    { class: 'b-tags' },
    needsCheck(it) ? el('span', { class: 'b-tag check' }, 'Check') : null,
    it.saved ? el('span', { class: 'b-tag saved' }, 'In collection') : null,
    isTraded(it) ? el('span', { class: 'b-tag traded' }, `In trade · ${SIDES[it.traded]}`) : null,
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
      it.status === 'processing' ? null : el('button', { class: 'b-remove', type: 'button', 'aria-label': `Delete photo ${n}`, onclick: () => removeOne(it.id) }, '✕'),
    ),
  );
}

/** The saved batch couldn't be read: say so (an empty batch would look like the photos are gone). */
function unreadableState() {
  const retry = (e) => {
    e.currentTarget.disabled = true;
    load().catch(() => {
      toast("Still couldn't open the batch. Close the app completely and open it again.", 4000);
      render();
    });
  };
  return el(
    'div',
    { class: 'b-empty b-unread' },
    el('h2', {}, 'Couldn’t open your batch'),
    el('p', { class: 'muted' }, 'The photos saved on this phone couldn’t be read just now. Nothing has been deleted.'),
    el('div', { class: 'b-empty-actions' }, el('button', { class: 'btn primary', id: 'batch-retry', type: 'button', onclick: retry }, 'Try again')),
  );
}

export function renderBatch() {
  const view = $('#view-batch');
  if (loadState === 'loading') {
    view.replaceChildren(el('p', { class: 'muted center' }, 'Loading…'));
    return;
  }
  if (loadState === 'failed') {
    view.replaceChildren(unreadableState());
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
    ...tradeNotes(),
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
