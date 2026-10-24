// App shell: tabs, the Scan and Search views, and start-up.
import { $, $$, el, on, toast, actionToast, setStatus, emit } from './ui.js';
import { initCatalog, catalog, catalogReady } from './catalog.js';
import { manualSearch } from './match.js';
import { startCamera, stopCamera, captureGuide, fileToCanvas, warmUp, setTorch, torchSupported } from './ocr.js';
import { identify } from './identify.js';
import { loadRate } from './fx.js';
import { initSheet, showResults, openCard, closeSheet, fillSetSelect, parseNumberInput } from './sheet.js';
import { cardTile } from './components.js';
import { mountSetPicker } from './setpicker.js';
import { initCollection, renderCollection } from './collection.js';
import { initBatch, renderBatch, enqueueCanvas, enqueueFiles, batchCount } from './batch.js';
import { initTrade, renderTrade } from './trade.js';
import { startOffline } from './offline.js';

const state = {
  stream: null,
  wantCamera: false,
  torch: false,
  busy: false,
  batchMode: false,
  resumeBatch: false, // batch mode was on before adding cards to a trade
  tradeSide: null, // 'give' | 'get' while scanning cards for a trade
  ready: null, // a finished scan not shown yet: { ranked, clues, debug, opts, at }
  offer: null, // its "Scan ready · View" toast
};

const READY_MS = 3 * 60 * 1000; // a scan not looked at is dropped after this

const VIEWS = ['scan', 'batch', 'trade', 'search', 'collection'];

async function init() {
  document.querySelectorAll('.setpick').forEach(mountSetPicker);
  bindTabs();
  bindScan();
  bindSearch();
  initSheet();
  initCollection();
  initBatch();
  initTrade();
  renderCollection();

  initCatalog((m) => setStatus('#scan-status', m))
    .then(() => {
      setStatus('#scan-status', state.stream ? 'Line the card up with the frame, then tap the button.' : '');
      fillSetSelect('q-set', $('#q-set').value);
      emit('catalog:ready', {});
    })
    .catch((e) => {
      console.error(e);
      setStatus('#scan-status', 'Could not download the card database. Check your connection and reload.', true);
    });
  // Refill set pickers once set codes are known.
  import('./catalog.js').then(({ abbrReady }) => abbrReady().then(() => fillSetSelect('q-set', $('#q-set').value)));

  loadRate().then((info) => emit('fx:ready', info));

  // Get text recognition ready in the background so the first scan is quick: once the card
  // list is in (on a first visit both download; the list comes first), after a paint. A scan
  // started meanwhile waits for the same start-up.
  catalogReady()
    .catch(() => {})
    .then(() => requestAnimationFrame(() => setTimeout(warmUp, 300)));

  // Start the camera straight away if permission was already granted.
  try {
    const p = await navigator.permissions?.query({ name: 'camera' });
    if (p?.state === 'granted') openCamera();
  } catch {
    /* permissions API not available (iOS) */
  }

  startOffline(); // service worker: works offline, keeps the big files (offline.js)
}

// ---------------- tabs ----------------
function bindTabs() {
  $$('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      // Tapping a tab yourself ends "adding cards to a trade".
      setTradeSide(null);
      state.searchTradeSide = null;
      $('#search-target').hidden = true;
      showView(t.dataset.view);
    }),
  );
  on('card:action', ({ action }) => {
    // Picked a card from Search for a trade: go back to the trade.
    if (action.startsWith('trade-') && state.searchTradeSide && $('#view-search').classList.contains('active')) {
      state.searchTradeSide = null;
      $('#search-target').hidden = true;
      showView('trade');
    }
  });
  on('app:navigate', ({ view, tradeSide, batchMode }) => {
    if (view === 'scan') {
      setTradeSide(tradeSide || null);
      if (batchMode && !state.batchMode) {
        state.batchMode = true;
        updateModeButton();
      }
    }
    showView(view);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) closeCamera();
    else if ($('#view-scan').classList.contains('active') && state.wantCamera) openCamera();
  });
}

function showView(name) {
  if (!VIEWS.includes(name)) return;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'scan') {
    if (state.wantCamera) openCamera();
    if (readyScan() && $('#sheet').hidden) showOrOffer(state.ready);
  } else {
    closeCamera();
  }
  if (name === 'collection') renderCollection();
  if (name === 'batch') renderBatch();
  if (name === 'trade') renderTrade();
}

// ---------------- scanning ----------------
function bindScan() {
  $('#btn-start-camera').addEventListener('click', openCamera);
  $('#btn-scan').addEventListener('click', scanFromCamera);
  $('#video').addEventListener('click', scanFromCamera);
  $('#file-input').addEventListener('change', onFiles);
  $('#file-input-library').addEventListener('change', onFiles);
  $('#btn-torch').addEventListener('click', async () => {
    state.torch = !state.torch;
    await setTorch(state.stream, state.torch).catch(() => {});
    $('#btn-torch').classList.toggle('primary', state.torch);
  });
  $('#btn-mode').addEventListener('click', () => {
    state.batchMode = !state.batchMode;
    state.resumeBatch = false; // the user's own choice stays
    updateModeButton();
    setStatus(
      '#scan-status',
      state.batchMode
        ? 'Batch mode: every photo is saved for later. Open the Batch tab to process them.'
        : 'Single mode: each photo is identified right away.',
    );
  });
  $('#btn-target-done').addEventListener('click', () => {
    setTradeSide(null);
    showView('trade');
  });
  on('batch:changed', updateModeButton);
  updateModeButton();
}

function updateModeButton() {
  const n = batchCount();
  const b = $('#btn-mode');
  b.classList.toggle('on', state.batchMode);
  b.textContent = state.batchMode ? `Batch mode: On · ${n} saved` : `Batch mode: Off${n ? ` · ${n} waiting` : ''}`;
  b.setAttribute('aria-pressed', state.batchMode ? 'true' : 'false');
  const badge = $('#batch-count');
  badge.hidden = !n;
  badge.textContent = n;
}

function setTradeSide(side) {
  // Scanning cards for a trade starts afresh: an earlier scan not looked at isn't for it.
  if (side && state.ready && state.ready.opts.tradeSide !== side) dropReady();
  if (side && !state.tradeSide) {
    // Cards for a trade are identified one by one; batch mode comes back afterwards.
    state.resumeBatch = state.batchMode;
    if (state.batchMode) {
      state.batchMode = false;
      updateModeButton();
      toast('Batch mode is paused while you add cards to the trade', 3000);
    }
  } else if (!side && state.tradeSide && state.resumeBatch) {
    state.resumeBatch = false;
    state.batchMode = true;
    updateModeButton();
    setStatus('#scan-status', 'Batch mode is on again: every photo is saved for later.');
  }
  state.tradeSide = side;
  const banner = $('#scan-target');
  banner.hidden = !side;
  if (side) $('#scan-target-label').textContent = `Adding cards to: ${side === 'give' ? 'You give' : 'You get'}`;
}

async function openCamera() {
  state.wantCamera = true;
  if (state.stream) return;
  try {
    state.stream = await startCamera($('#video'));
    $('#camera-off').hidden = true;
    $('#btn-scan').disabled = false;
    $('#btn-torch').hidden = !torchSupported(state.stream);
    if (!state.busy) setStatus('#scan-status', 'Line the card up with the frame, then tap the button.');
  } catch (e) {
    console.warn(e);
    $('#camera-off').hidden = false;
    setStatus('#scan-status', e.name === 'NotAllowedError' ? 'Camera permission was denied. You can still use Photo.' : e.message, true);
  }
}

function closeCamera() {
  stopCamera(state.stream);
  state.stream = null;
  $('#btn-scan').disabled = true;
}

async function scanFromCamera() {
  if (state.busy || !state.stream) return;
  const canvas = captureGuide($('#video'), $('#guide'));
  if (state.batchMode) {
    flashGuide();
    if (await enqueueCanvas(canvas, { tradeSide: state.tradeSide })) toast(`Saved for later · ${batchCount()} in batch`, 1400);
    return;
  }
  await runScan(canvas);
}

function flashGuide() {
  const g = $('#guide');
  g.classList.remove('flash');
  void g.offsetWidth; // restart the animation
  g.classList.add('flash');
}

async function onFiles(e) {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length || state.busy) return;
  if (state.batchMode || files.length > 1) {
    // Several photos go to the batch (it says how many were saved). For a trade they are
    // marked with the side, so the Batch tab offers to send just those.
    const n = await enqueueFiles(files, { tradeSide: state.tradeSide });
    if (!state.batchMode && n) showView('batch');
    return;
  }
  try {
    await runScan(await fileToCanvas(files[0]));
  } catch (err) {
    setStatus('#scan-status', err.message, true);
  }
}

async function runScan(canvas) {
  state.busy = true;
  dropReady(); // a new scan replaces one not looked at
  emit('scan:busy', { busy: true }); // Batch processing waits between photos meanwhile
  const opts = { tradeSide: state.tradeSide, owner: 'scan' };
  $('#guide').classList.add('busy');
  $('#btn-scan').disabled = true;
  try {
    // The artwork (stamps) is read by the result sheet, and only for a card that comes stamped.
    const { ranked, clues, debug, card } = await identify(canvas, (m) => setStatus('#scan-status', m), { stamps: false });
    setStatus('#scan-status', '');
    deliver({ ranked, clues, debug, opts: { ...opts, canvas: card } });
  } catch (e) {
    console.error(e);
    setStatus('#scan-status', `Scan failed: ${e.message}`, true);
  } finally {
    state.busy = false;
    emit('scan:busy', { busy: false });
    $('#guide').classList.remove('busy');
    $('#btn-scan').disabled = !state.stream;
  }
}

const scanActive = () => $('#view-scan').classList.contains('active');
// Taken in the scanner's current mode (single, or adding cards to that side of a trade)?
const sameMode = (res) => (res.opts.tradeSide || null) === (state.tradeSide || null);

/** Show a finished scan, unless the user moved on (another tab, sheet or scanner mode): then keep it and offer it. */
function deliver(res) {
  res.at = Date.now();
  if (scanActive() && $('#sheet').hidden && sameMode(res)) return showScan(res);
  state.ready = res;
  offerScan(); // and again when the sheet in the way closes
}

/** The scan waiting to be looked at, if any; after a few minutes it is dropped. */
function readyScan() {
  if (state.ready && Date.now() - state.ready.at > READY_MS) dropReady();
  return state.ready;
}

function dropReady() {
  state.ready = null;
  state.offer?.close();
  state.offer = null;
}

/** On the Scan tab: open the waiting scan by itself only in the mode it was taken in, else offer it. */
function showOrOffer(res) {
  if (sameMode(res)) showScan(res);
  else offerScan();
}

function showScan(res) {
  dropReady();
  showResults(res.ranked, res.clues, res.debug, res.opts);
}

function offerScan() {
  const res = state.ready;
  const name = res.ranked[0]?.card.name;
  state.offer?.close();
  state.offer = actionToast(name ? `Scan ready: ${name}` : 'Scan finished', 'View', () => {
    if (state.ready !== res) return; // dropped meanwhile
    dropReady(); // before closing a sheet, so closing doesn't offer it again
    if (!$('#sheet').hidden) closeSheet();
    showScan(res);
  }, { ms: 8000 });
}

on('sheet:closed', () => {
  if (readyScan()) {
    if (scanActive()) showOrOffer(state.ready);
    else offerScan();
    return;
  }
  if (scanActive() && state.stream && !state.busy) {
    setStatus('#scan-status', state.tradeSide ? 'Ready for the next card for this trade.' : 'Ready for the next card.');
  }
});

// ---------------- search ----------------
function bindSearch() {
  $('#search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#q-name').value.trim();
    const number = $('#q-number').value.trim();
    const setId = $('#q-set').value;
    if (!name && !number && !setId) return;
    if (number && !parseNumberInput(number)) {
      setStatus('#search-status', 'Number should look like 125, 125/197 or TG05.', true);
      return;
    }
    setStatus('#search-status', 'Searching…');
    try {
      await catalogReady();
    } catch {
      setStatus('#search-status', 'Card database not loaded. Check your connection.', true);
      return;
    }
    const ranked = manualSearch(catalog.index, name, number, catalog.setAbbr, setId);
    setStatus('#search-status', ranked.length ? `${ranked.length} card${ranked.length === 1 ? '' : 's'}` : 'No cards found.');
    $('#search-results').replaceChildren(...ranked.map((r) => cardTile(r, () => openCard(r.card.id, { tradeSide: state.searchTradeSide }))));
  });
  on('app:navigate', ({ view, tradeSide }) => {
    if (view !== 'search') return;
    state.searchTradeSide = tradeSide || null;
    const hint = $('#search-target');
    hint.hidden = !tradeSide;
    if (tradeSide) hint.textContent = `Pick a card for: ${tradeSide === 'give' ? 'You give' : 'You get'}`;
    setTimeout(() => $('#q-name').focus(), 50);
  });
}

// Expose for debugging in the browser console.
window.cardScanner = { catalog, el };

init();
