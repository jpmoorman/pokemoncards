import { loadCatalog, getCard, getSetAbbreviations, cardImage, setSymbol } from './api.js';
import { buildIndex, rankCandidates, confidence, manualSearch } from './match.js';
import { variantPrices, headlinePrice, formatMoney, marketLinks } from './prices.js';
import { startCamera, stopCamera, captureGuide, fileToCanvas, readCard, getWorker, setTorch, torchSupported } from './ocr.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}

function toast(msg, ms = 2200) {
  const t = el('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

// ---------------- state ----------------
const state = {
  index: null,
  setAbbr: {},
  stream: null,
  torch: false,
  busy: false,
  current: null, // { card, rows, rowIdx }
  lastClues: null,
};

let catalogReady;
let abbrReady = Promise.resolve({});

function setStatus(id, msg, isError = false) {
  const s = $(id);
  s.textContent = msg || '';
  s.classList.toggle('error', !!isError);
}

async function init() {
  bindTabs();
  bindScan();
  bindSearch();
  bindSheet();
  bindCollection();
  renderCollection();

  catalogReady = loadCatalog({ onStatus: (m) => setStatus('#scan-status', m) })
    .then(({ cards, sets }) => {
      state.index = buildIndex(cards, sets);
      setStatus('#scan-status', '');
      abbrReady = getSetAbbreviations(sets)
        .then((m) => (state.setAbbr = m))
        .catch(() => state.setAbbr);
      return state.index;
    })
    .catch((e) => {
      console.error(e);
      setStatus('#scan-status', 'Could not download the card database. Check your connection and reload.', true);
      throw e;
    });

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
    t.addEventListener('click', () => showView(t.dataset.view)),
  );
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) closeCamera();
    else if ($('#view-scan').classList.contains('active') && state.wantCamera) openCamera();
  });
}

function showView(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'scan') {
    if (state.wantCamera) openCamera();
  } else {
    closeCamera();
  }
  if (name === 'collection') renderCollection();
}

// ---------------- camera + scanning ----------------
function bindScan() {
  $('#btn-start-camera').addEventListener('click', openCamera);
  $('#btn-scan').addEventListener('click', scanFromCamera);
  $('#file-input').addEventListener('change', onFile);
  $('#file-input-library').addEventListener('change', onFile);
  $('#btn-torch').addEventListener('click', async () => {
    state.torch = !state.torch;
    await setTorch(state.stream, state.torch).catch(() => {});
    $('#btn-torch').classList.toggle('primary', state.torch);
  });
  $('#video').addEventListener('click', scanFromCamera);
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
  await runScan(canvas);
}

async function onFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || state.busy) return;
  try {
    const canvas = await fileToCanvas(file);
    await runScan(canvas);
  } catch (err) {
    setStatus('#scan-status', err.message, true);
  }
}

async function runScan(canvas) {
  state.busy = true;
  $('#guide').classList.add('busy');
  $('#btn-scan').disabled = true;
  const status = (m) => setStatus('#scan-status', m);
  try {
    status('Loading text recognition…');
    await getWorker((m) => {
      if (m.status && m.progress != null && m.progress < 1 && /load|init/i.test(m.status)) {
        status(`Preparing scanner (first time only)… ${Math.round(m.progress * 100)}%`);
      }
    });
    const { clues, debug } = await readCard(canvas, status);
    status('Matching card…');
    await catalogReady;
    if (clues.setCodes.length || clues.codeCandidates.length) await abbrReady;
    state.lastClues = clues;
    const ranked = rankCandidates(state.index, clues, state.setAbbr);
    status('');
    showResults(ranked, clues, debug);
  } catch (e) {
    console.error(e);
    setStatus('#scan-status', `Scan failed: ${e.message}`, true);
  } finally {
    state.busy = false;
    $('#guide').classList.remove('busy');
    $('#btn-scan').disabled = !state.stream;
  }
}

// ---------------- result sheet ----------------
function bindSheet() {
  $$('[data-close]').forEach((b) => b.addEventListener('click', closeSheet));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeSheet());
  $('#clue-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#clue-name').value.trim();
    const number = $('#clue-number').value.trim().toUpperCase();
    const code = $('#clue-set').value.trim().toUpperCase();
    const clues = { nameBest: name, nameAll: '', numbers: [], setCodes: code ? [code] : [], codeCandidates: [] };
    const m = /^([A-Z]*)\s*(\d{1,3})\s*(?:\/\s*[A-Z]*\s*(\d{1,3}))?$/.exec(number);
    if (m) clues.numbers.push({ prefix: m[1], num: parseInt(m[2], 10), total: m[3] ? parseInt(m[3], 10) : null });
    await catalogReady;
    if (code) await abbrReady;
    showResults(rankCandidates(state.index, clues, state.setAbbr), clues, null);
  });
}

function openSheet() {
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeSheet() {
  $('#sheet').hidden = true;
  document.body.style.overflow = '';
  if ($('#view-scan').classList.contains('active') && state.stream) {
    setStatus('#scan-status', 'Ready for the next card.');
  }
}

function fillClueForm(clues) {
  $('#clue-name').value = clues.nameBest || clues.nameAll || '';
  const n = clues.numbers?.[0];
  $('#clue-number').value = n ? `${n.prefix}${n.num}${n.total ? `/${n.prefix}${n.total}` : ''}` : '';
  $('#clue-set').value = clues.setCodes?.[0] || '';
}

function showResults(ranked, clues, debug) {
  openSheet();
  $('#sheet .sheet-panel').scrollTop = 0;
  $('#detected').hidden = !clues;
  if (clues) fillClueForm(clues);
  const conf = confidence(ranked);
  const confEl = $('#confidence');
  confEl.className = `conf ${conf}`;
  confEl.textContent = { high: 'Confident match', medium: 'Likely match', low: 'Unsure — check below', none: 'No match' }[conf];

  if (debug) {
    $('#debug-wrap').hidden = false;
    $('#debug').textContent = `NAME AREA:\n${debug.name}\n\nBOTTOM AREA:\n${debug.bottom}${debug.full ? `\n\nWHOLE CARD:\n${debug.full}` : ''}`;
  } else {
    $('#debug-wrap').hidden = true;
  }

  const detail = $('#card-detail');
  detail.replaceChildren();
  if (!ranked.length) {
    detail.append(
      el('p', { class: 'muted' }, "Couldn't identify this card. Fix the name or number above and tap Re-match, or try again with the card flat, well lit and filling the frame."),
    );
    $('#alternates-wrap').hidden = true;
    return;
  }
  showCard(ranked[0].card.id);
  const alts = ranked.slice(1, 13);
  $('#alternates-wrap').hidden = !alts.length;
  $('#alternates').replaceChildren(...alts.map((r) => tile(r, () => showCard(r.card.id, true))));
}

function tile(r, onclick) {
  const img = r.card.image
    ? el('img', { src: cardImage(r.card), alt: r.card.name, loading: 'lazy' })
    : el('div', { class: 'noimg' }, 'No image');
  const official = r.set?.cardCount?.official;
  return el(
    'button',
    { class: 'tile', type: 'button', onclick },
    img,
    el('span', { class: 't-name' }, r.card.name),
    el('span', { class: 't-sub' }, `${r.set?.name || ''} · ${r.card.localId}${official && /^\d+$/.test(r.card.localId) ? `/${official}` : ''}`),
  );
}

async function showCard(id, scroll = false) {
  const detail = $('#card-detail');
  detail.replaceChildren(el('p', { class: 'muted' }, 'Loading prices…'));
  if (scroll) $('#sheet .sheet-panel').scrollTo({ top: 0, behavior: 'smooth' });
  let card;
  try {
    card = await getCard(id);
  } catch (e) {
    detail.replaceChildren(el('p', { class: 'status error' }, `Couldn't load prices (${e.message}).`));
    return;
  }
  if (!card) {
    detail.replaceChildren(el('p', { class: 'muted' }, 'Card not found.'));
    return;
  }
  const rows = variantPrices(card);
  // Default to the first standard-size version that has a price.
  let rowIdx = rows.findIndex((r) => r.size === 'standard' && headlinePrice(r));
  if (rowIdx < 0) rowIdx = 0;
  state.current = { card, rows, rowIdx };
  renderDetail();
}

function renderDetail() {
  const { card, rows, rowIdx } = state.current;
  const row = rows[rowIdx];
  const node = $('#tpl-card-detail').content.cloneNode(true);
  const img = $('.detail-img', node);
  if (card.image) {
    img.src = cardImage(card, 'high');
    img.alt = card.name;
  } else img.removeAttribute('src');
  $('.detail-name', node).textContent = card.name;
  const sym = $('.set-symbol', node);
  if (card.set?.symbol) sym.src = setSymbol(card.set);
  else sym.remove();
  const official = card.set?.cardCount?.official;
  $('.set-name', node).textContent = card.set?.name || '';
  $('.detail-meta', node).textContent = [
    `#${card.localId}${official && /^\d+$/.test(card.localId) ? `/${official}` : ''}`,
    card.rarity,
    card.illustrator && `Illus. ${card.illustrator}`,
  ]
    .filter(Boolean)
    .join(' · ');

  const hp = headlinePrice(row);
  const anyPrice = rows.some((r) => headlinePrice(r));
  $('.headline-price', node).textContent = hp ? formatMoney(hp.value, hp.currency) : 'No price yet';
  $('.headline-source', node).textContent = hp
    ? `${hp.source} · ${row?.label || ''}`
    : anyPrice
      ? 'No price for this version. Try another version or eBay sold listings.'
      : 'Price sites have no data for this card yet (common for brand-new sets). Check eBay sold listings below.';

  // Variant chips (dedupe identical labels).
  const chips = $('.variant-chips', node);
  const seen = {};
  rows.forEach((r, i) => {
    seen[r.label] = (seen[r.label] || 0) + 1;
    const label = seen[r.label] > 1 ? `${r.label} #${seen[r.label]}` : r.label;
    const p = headlinePrice(r);
    chips.append(
      el(
        'button',
        {
          class: `chip${i === rowIdx ? ' active' : ''}`,
          type: 'button',
          onclick: () => {
            state.current.rowIdx = i;
            renderDetail();
          },
        },
        label,
        p ? el('span', { class: 'chip-price' }, formatMoney(p.value, p.currency)) : null,
      ),
    );
  });
  if (!rows.length) chips.append(el('span', { class: 'muted small' }, 'No version data for this card.'));

  // Price tables.
  const tables = $('.price-tables', node);
  const dl = (pairs, cur) =>
    el('dl', {}, ...pairs.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, formatMoney(v, cur))]));
  const date = (s) => (s ? new Date(s).toLocaleDateString() : '');
  tables.append(
    el(
      'div',
      { class: 'ptable' },
      el('h4', {}, 'TCGplayer (USD)', el('span', { class: 'muted small' }, date(row?.tcg?.updated))),
      row?.tcg
        ? dl([['Market', row.tcg.market], ['Low', row.tcg.low], ['Mid', row.tcg.mid], ['High', row.tcg.high]], 'USD')
        : el('div', { class: 'none' }, 'No TCGplayer price for this version.'),
    ),
    el(
      'div',
      { class: 'ptable' },
      el('h4', {}, 'Cardmarket (EUR)', el('span', { class: 'muted small' }, date(row?.cm?.updated))),
      row?.cm
        ? dl([['Trend', row.cm.trend], ['Avg', row.cm.avg], ['7-day', row.cm.avg7], ['30-day', row.cm.avg30]], 'EUR')
        : el('div', { class: 'none' }, 'No Cardmarket price for this version.'),
    ),
  );

  const links = marketLinks(card, row);
  const a = (href, text) => el('a', { class: 'btn link', href, target: '_blank', rel: 'noopener' }, text);
  $('.links', node).append(
    a(links.ebaySold, 'eBay sold ↗'),
    a(links.tcgplayer, 'TCGplayer ↗'),
    a(links.ebayActive, 'eBay listings ↗'),
    a(links.pricecharting, 'Graded (PriceCharting) ↗'),
  );

  $('.add-btn', node).addEventListener('click', () => {
    addToCollection(card, row);
    toast('Added to collection');
  });

  $('#card-detail').replaceChildren(node);
}

// ---------------- search ----------------
function bindSearch() {
  $('#search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#q-name').value.trim();
    const number = $('#q-number').value.trim();
    if (!name && !number) return;
    setStatus('#search-status', 'Searching…');
    try {
      await catalogReady;
    } catch {
      setStatus('#search-status', 'Card database not loaded. Check your connection.', true);
      return;
    }
    const ranked = manualSearch(state.index, name, number, state.setAbbr);
    setStatus('#search-status', ranked.length ? `${ranked.length} card${ranked.length === 1 ? '' : 's'}` : 'No cards found.');
    $('#search-results').replaceChildren(
      ...ranked.map((r) =>
        tile(r, () => {
          showResults([r], null, null);
          $('#alternates-wrap').hidden = true;
        }),
      ),
    );
  });
}

// ---------------- collection ----------------
const COLLECTION_KEY = 'collection.v1';

function loadCollection() {
  try {
    return JSON.parse(localStorage.getItem(COLLECTION_KEY)) || [];
  } catch {
    return [];
  }
}

function saveCollection(items) {
  localStorage.setItem(COLLECTION_KEY, JSON.stringify(items));
  renderCount(items);
}

function addToCollection(card, row) {
  const items = loadCollection();
  const key = `${card.id}|${row?.label || ''}`;
  const existing = items.find((i) => i.key === key);
  const price = headlinePrice(row);
  if (existing) {
    existing.qty += 1;
    existing.price = price;
  } else {
    items.unshift({
      key,
      id: card.id,
      name: card.name,
      setName: card.set?.name || '',
      number: card.localId,
      official: card.set?.cardCount?.official || null,
      variant: row?.label || '',
      image: card.image || '',
      price,
      qty: 1,
      added: Date.now(),
    });
  }
  saveCollection(items);
}

function renderCount(items = loadCollection()) {
  const n = items.reduce((s, i) => s + i.qty, 0);
  const b = $('#collection-count');
  b.hidden = !n;
  b.textContent = n;
}

function totals(items) {
  const t = {};
  for (const i of items) if (i.price) t[i.price.currency] = (t[i.price.currency] || 0) + i.price.value * i.qty;
  return t;
}

function renderCollection() {
  const items = loadCollection();
  renderCount(items);
  const t = totals(items);
  const parts = Object.entries(t).map(([cur, v]) => formatMoney(v, cur));
  $('#collection-total').textContent = parts.length ? parts.join(' + ') : formatMoney(0, 'USD');
  $('#collection-empty').hidden = !!items.length;
  $('#collection-list').replaceChildren(
    ...items.map((i) => {
      const change = (d) => {
        const all = loadCollection();
        const it = all.find((x) => x.key === i.key);
        if (!it) return;
        it.qty += d;
        saveCollection(it.qty > 0 ? all : all.filter((x) => x.key !== i.key));
        renderCollection();
      };
      const open = () => {
        showResults([], null, null);
        showCard(i.id);
      };
      return el(
        'li',
        { class: 'citem' },
        i.image ? el('img', { src: `${i.image}/low.webp`, alt: '', loading: 'lazy', onclick: open }) : el('div', { class: 'noimg' }),
        el(
          'div',
          { onclick: open },
          el('div', { class: 'c-name' }, i.name),
          el('div', { class: 'c-sub' }, `${i.setName} · ${i.number}${i.official && /^\d+$/.test(i.number) ? `/${i.official}` : ''}`),
          el('div', { class: 'c-sub' }, i.variant),
        ),
        el(
          'div',
          { class: 'c-right' },
          el('div', { class: 'c-price' }, i.price ? formatMoney(i.price.value * i.qty, i.price.currency) : '—'),
          el(
            'div',
            { class: 'qty' },
            el('button', { type: 'button', 'aria-label': 'Remove one', onclick: () => change(-1) }, '−'),
            el('span', {}, `×${i.qty}`),
            el('button', { type: 'button', 'aria-label': 'Add one', onclick: () => change(1) }, '+'),
          ),
        ),
      );
    }),
  );
}

function bindCollection() {
  $('#btn-refresh-prices').addEventListener('click', async () => {
    const items = loadCollection();
    if (!items.length) return;
    const btn = $('#btn-refresh-prices');
    btn.disabled = true;
    let done = 0;
    for (const i of items) {
      btn.textContent = `Refreshing ${++done}/${items.length}…`;
      try {
        const card = await getCard(i.id);
        const rows = variantPrices(card);
        const row = rows.find((r) => r.label === i.variant) || rows[0];
        i.price = headlinePrice(row) || i.price;
      } catch {
        /* keep old price */
      }
    }
    saveCollection(items);
    renderCollection();
    btn.disabled = false;
    btn.textContent = 'Refresh prices';
    toast('Prices updated');
  });

  $('#btn-export').addEventListener('click', () => {
    const items = loadCollection();
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['Name', 'Set', 'Number', 'Version', 'Qty', 'Unit price', 'Currency', 'TCGdex id'].map(esc).join(','),
      ...items.map((i) =>
        [i.name, i.setName, i.official ? `${i.number}/${i.official}` : i.number, i.variant, i.qty, i.price?.value ?? '', i.price?.currency ?? '', i.id]
          .map(esc)
          .join(','),
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'pokemon-collection.csv' });
    document.body.append(a);
    a.click();
    a.remove();
  });
}

init();
