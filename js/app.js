// App shell: tabs, the Scan and Search views, and start-up.
import { $, $$, el, on, toast, setStatus, emit } from './ui.js';
import { initCatalog, catalog, catalogReady } from './catalog.js';
import { manualSearch } from './match.js';
import { startCamera, stopCamera, captureGuide, fileToCanvas, getWorker, setTorch, torchSupported } from './ocr.js';
import { identify } from './identify.js';
import { loadRate } from './fx.js';
import { initSheet, showResults, openCard, fillSetSelect, parseNumberInput } from './sheet.js';
import { cardTile } from './components.js';
import { initCollection, renderCollection } from './collection.js';
import { initBatch, renderBatch, enqueueCanvas, enqueueFiles, batchCount } from './batch.js';
import { initTrade, renderTrade } from './trade.js';

const state = {
  stream: null,
  wantCamera: false,
  torch: false,
  busy: false,
  batchMode: false,
  tradeSide: null, // 'give' | 'get' while scanning cards for a trade
};

const VIEWS = ['scan', 'batch', 'trade', 'search', 'collection'];

async function init() {
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
      fillSetSelect($('#q-set'));
      emit('catalog:ready', {});
    })
    .catch((e) => {
      console.error(e);
      setStatus('#scan-status', 'Could not download the card database. Check your connection and reload.', true);
    });
  // Refill set pickers once set codes are known.
  import('./catalog.js').then(({ abbrReady }) => abbrReady().then(() => fillSetSelect($('#q-set'), $('#q-set').value)));

  loadRate().then((info) => emit('fx:ready', info));

  // Warm up text recognition in the background so the first scan is quick.
  setTimeout(() => getWorker().catch(() => {}), 1500);

  // Start the camera straight away if permission was already granted.
  try {
    const p = await navigator.permissions?.query({ name: 'camera' });
    if (p?.state === 'granted') openCamera();
  } catch {
    /* permissions API not available (iOS) */
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
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
  on('app:navigate', ({ view, tradeSide }) => {
    if (view === 'scan') setTradeSide(tradeSide || null);
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
  state.tradeSide = side;
  const banner = $('#scan-target');
  banner.hidden = !side;
  if (side) {
    $('#scan-target-label').textContent = `Adding cards to: ${side === 'give' ? 'You give' : 'You get'}`;
    if (state.batchMode) {
      state.batchMode = false;
      updateModeButton();
    }
  }
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
    await enqueueCanvas(canvas);
    toast(`Saved for later · ${batchCount()} in batch`, 1400);
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
    await enqueueFiles(files);
    toast(`${files.length} photo${files.length > 1 ? 's' : ''} added to batch`);
    if (!state.batchMode) showView('batch');
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
  $('#guide').classList.add('busy');
  $('#btn-scan').disabled = true;
  try {
    const { ranked, clues, debug } = await identify(canvas, (m) => setStatus('#scan-status', m));
    setStatus('#scan-status', '');
    showResults(ranked, clues, debug, { tradeSide: state.tradeSide });
  } catch (e) {
    console.error(e);
    setStatus('#scan-status', `Scan failed: ${e.message}`, true);
  } finally {
    state.busy = false;
    $('#guide').classList.remove('busy');
    $('#btn-scan').disabled = !state.stream;
  }
}

on('sheet:closed', () => {
  if ($('#view-scan').classList.contains('active') && state.stream && !state.busy) {
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
