// The slide-up result sheet: what the camera read, the matched card, its versions and prices.
import { $, $$, el, emit, toast } from './ui.js';
import { getCard, lookupCard, setSymbol } from './api.js';
import { rankCandidates, confidence, reprintRivals, REPRINT_SETS } from './match.js';
import { rerank, borderColor, setYears } from './rerank.js';
import { variantPrices, headlinePrice, formatMoney, marketLinks, printedNumber, variantImage, eurToUsd } from './prices.js';
import { catalog, catalogReady, abbrReady } from './catalog.js';
import { setPickerValue } from './setpicker.js';
import { pickVariant } from './stamps.js';
import { readStamps, nextPaint } from './ocr.js';
import { cardTile } from './components.js';
import { makeEntry } from './entry.js';
import { fx } from './fx.js';

// Current sheet state.
const sheet = {
  current: null, // { card, rows, rowIdx }
  opts: {}, // see showResults
  clues: null,
  debug: null,
  twins: [], // the best match and its reprint-collection twins the scan can't tell apart (match.reprintRivals)
};
const RERANK_WAIT = 600; // Re-match: how long to wait for card details (most were looked up by the scan)

// The artwork of a live scan's card is read for stamps only once a card shown comes in
// stamped versions (a second on a phone): one read per scanned card, kept for the
// alternates and re-matches of the same scan. canvas -> { text: string|null, read: Promise }.
const artReads = new WeakMap();
function artwork(canvas) {
  let a = artReads.get(canvas);
  if (!a) {
    a = { text: null };
    a.read = readStamps(canvas)
      .catch((e) => {
        console.warn('artwork read failed', e);
        return '';
      })
      .then((text) => (a.text = text));
    artReads.set(canvas, a);
  }
  return a;
}

export function initSheet() {
  $$('#sheet [data-close]').forEach((b) => b.addEventListener('click', closeSheet));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('#sheet').hidden && closeSheet());
  $('#clue-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('#clue-form [type=submit]');
    button.disabled = true;
    try {
      const clues = cluesFromForm();
      await catalogReady();
      await abbrReady();
      const { debug, opts } = sheet;
      showResults(await rematch(clues, debug, opts, sheet.clues), clues, debug, opts);
    } finally {
      button.disabled = false;
    }
  });
}

/**
 * Rank again with corrected clues, the same two passes as a scan: the second pass also uses
 * the rest of what was read (debug: OCR text and the border colour). A number the user typed
 * (not the one read, `before`) is what the card prints: only cards printing it are kept, if any.
 */
async function rematch(clues, debug, opts, before) {
  let first = rankCandidates(catalog.index, clues, catalog.setAbbr, 150);
  const typed = clues.numbers.filter((n) => !before?.numbers?.some((b) => b.num === n.num && b.prefix === n.prefix && (b.total ?? null) === n.total));
  const prints = (r) => typed.some((n) => n.num === r.card.num || n.num === r.card.printed?.num);
  if (typed.length && first.some(prints)) first = first.filter(prints);
  if (!debug) return first.slice(0, 40);
  const border = debug.border ?? (opts.canvas ? borderColor(opts.canvas) : null);
  try {
    const ranked = await rerank(first, { clues, debug, border }, { index: catalog.index, getCard: lookupCard, timeoutMs: RERANK_WAIT });
    return ranked.slice(0, 40);
  } catch (e) {
    console.warn('second pass failed', e);
    return first.slice(0, 40);
  }
}

/** Parse "125/197", "TG05/TG30", "SWSH050", "024" into a number clue. */
export function parseNumberInput(text) {
  const m = /^([A-Z]*)\s*(\d{1,3})\s*(?:\/\s*[A-Z]*\s*(\d{1,3}))?$/.exec(String(text || '').trim().toUpperCase());
  return m ? { prefix: m[1], num: parseInt(m[2], 10), total: m[3] ? parseInt(m[3], 10) : null } : null;
}

function cluesFromForm() {
  const name = $('#clue-name').value.trim();
  const n = parseNumberInput($('#clue-number').value);
  const setId = $('#clue-set').value;
  const code = setId ? catalog.setAbbr[setId] : null;
  return {
    nameBest: name,
    nameAll: '',
    numbers: n ? [n] : [],
    setCodes: code ? [code] : [],
    codeCandidates: [],
    setIds: setId ? [setId] : [],
    // keep what the scanner saw on the artwork (stamps) when re-matching
    artText: sheet.clues?.artText || '',
  };
}

/** Show a set in a picker by its hidden input id; '' = any set. */
export function fillSetSelect(hiddenOrId, selectedId = '') {
  const id = typeof hiddenOrId === 'string' ? hiddenOrId : hiddenOrId?.id;
  if (id) setPickerValue(id, selectedId);
}

/** The set whose code was read; when sets share it ("30C"), the best match's, else the first released. */
function selectedSetFromClues(clues, best) {
  if (clues.setIds?.length) return clues.setIds[0];
  const key = (c) => String(c || '').toUpperCase().replace(/O/g, '0');
  const codes = (clues.setCodes || []).map(key);
  const read = (id) => codes.includes(key(catalog.setAbbr[id]));
  if (best && read(best.card.setId)) return best.card.setId;
  const order = (id) => catalog.index?.setsById.get(id)?.order ?? 1e9;
  return Object.keys(catalog.setAbbr).filter(read).sort((a, b) => order(a) - order(b))[0] || '';
}

function openSheet() {
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
}

export function closeSheet() {
  $('#sheet').hidden = true;
  document.body.style.overflow = '';
  emit('sheet:closed', { owner: sheet.opts.owner });
}

/**
 * Show match results.
 *   ranked - [{ card, set }] best first (may be empty)
 *   clues  - what OCR read (null hides the "what the camera read" box)
 *   debug  - raw OCR text (null hides it)
 *   opts   - { onPick(card, row), pickLabel, preferred, tradeSide, owner, canvas }
 *            onPick adds a primary "Use this card" button (batch review).
 *            canvas is the scanned card (identify's `card`) when its artwork wasn't read
 *            yet (clues.artText empty): it is read for stamps when a card shown has
 *            stamped versions, and the version picked again.
 *            owner is any token naming who opened the sheet; it comes back as detail.owner
 *            in 'card:action' and 'sheet:closed', so a view only acts on its own sheet.
 */
export function showResults(ranked, clues, debug, opts = {}) {
  sheet.opts = opts;
  sheet.clues = clues;
  sheet.debug = debug;
  sheet.twins = [];
  openSheet();
  $('#sheet .sheet-panel').scrollTop = 0;
  $('#detected').hidden = !clues;
  if (clues) {
    $('#clue-name').value = clues.nameBest || clues.nameAll || '';
    const n = clues.numbers?.[0];
    $('#clue-number').value = n ? n.text || `${n.prefix}${n.num}${n.total ? `/${n.prefix}${n.total}` : ''}` : '';
    fillSetSelect('clue-set', selectedSetFromClues(clues, ranked[0]));
    const conf = confidence(ranked);
    const confEl = $('#confidence');
    confEl.className = `conf ${conf}`;
    confEl.textContent = { high: 'Confident match', medium: 'Likely match', low: 'Unsure — check below', none: 'No match' }[conf];
  }

  renderDebug();

  const detail = $('#card-detail');
  detail.replaceChildren();
  if (!ranked.length) {
    detail.append(
      el(
        'p',
        { class: 'muted' },
        clues
          ? "Couldn't identify this card. Fix the name or number above, or pick the set, then tap Re-match. Or try again with the card flat, well lit and filling the frame."
          : 'No card to show.',
      ),
    );
    $('#alternates-wrap').hidden = true;
    return;
  }
  sheet.twins = [ranked[0], ...reprintRivals(ranked)];
  showCard(ranked[0].card.id, { ...opts, clues });
  const alts = ranked.slice(1, 13);
  $('#alternates-wrap').hidden = !alts.length;
  $('#alternates').replaceChildren(...alts.map((r) => cardTile(r, () => showCard(r.card.id, { ...opts, clues, scroll: true }))));
}

function renderDebug() {
  const { debug } = sheet;
  $('#debug-wrap').hidden = !debug;
  if (!debug) return;
  $('#debug').textContent = Object.entries({ 'CARD OUTLINE': debug.detect, 'NAME AREA': debug.name, 'BOTTOM AREA': debug.bottom, ARTWORK: debug.art, 'WHOLE CARD': debug.full })
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}:\n${v}`)
    .join('\n\n');
}

/** Open the sheet on one card (from search, collection, trade…). opts as showResults plus { preferred }. */
export function openCard(id, opts = {}) {
  sheet.opts = opts;
  sheet.clues = null;
  sheet.debug = null;
  sheet.twins = [];
  openSheet();
  $('#sheet .sheet-panel').scrollTop = 0; // the panel keeps the last sheet's scroll position
  $('#detected').hidden = true;
  $('#debug-wrap').hidden = true;
  $('#alternates-wrap').hidden = true;
  showCard(id, opts);
}

async function showCard(id, opts = {}) {
  const detail = $('#card-detail');
  detail.replaceChildren(el('p', { class: 'muted' }, 'Loading prices…'));
  if (opts.scroll) $('#sheet .sheet-panel').scrollTo({ top: 0, behavior: 'smooth' });
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
  const clues = opts.clues || null;
  const read = opts.canvas && artReads.get(opts.canvas);
  if (clues && !clues.artText && read?.text != null) clues.artText = read.text;
  // A live scan's artwork is read only now, for a card that comes stamped.
  const checking = !!(clues && !clues.artText && opts.canvas && rows.some((r) => r.size === 'standard' && r.stamps?.length));
  const pick = pickVariant(rows, { card, clues, preferred: opts.preferred });
  const cur = { card, rows, rowIdx: pick.index, pick, checking };
  sheet.current = cur;
  renderDetail();
  if (!checking) return;
  await nextPaint(); // show the card first: the read starts with a long image clean-up
  if (sheet.current !== cur) return; // another card is shown now (it reads the artwork if it needs to)
  const text = await artwork(opts.canvas).read;
  clues.artText ||= text;
  if (sheet.clues === clues && sheet.debug && !sheet.debug.art) {
    sheet.debug.art = text;
    renderDebug();
  }
  if (sheet.current !== cur) return; // another card is shown now
  const again = pickVariant(rows, { card, clues, preferred: opts.preferred });
  // Keep a version the user picked meanwhile.
  if (cur.rowIdx === pick.index) cur.rowIdx = again.index;
  Object.assign(cur, { pick: again, checking: false });
  renderDetail();
}

/** One line offering the twin the scan can't rule out, as a button that shows it. */
function twinNote(twin) {
  const { setId } = twin.card;
  const reprint = REPRINT_SETS[setId];
  const year = catalog.index && setYears(catalog.index).get(setId)?.[0];
  const text = reprint
    ? `Could also be the ${reprint.name} (${reprint.year}) reprint — it has a ${reprint.logo} logo on the artwork. Tap to switch`
    : `Could also be the original ${twin.set?.name || 'printing'}${year ? ` (${year})` : ''} card — it has no anniversary logo on the artwork. Tap to switch`;
  const show = () => showCard(twin.card.id, { ...sheet.opts, clues: sheet.clues, scroll: true });
  return el('button', { class: 'reprint-note', type: 'button', onclick: show }, text);
}

function renderDetail() {
  const { card, rows, rowIdx } = sheet.current;
  const row = rows[rowIdx];
  const rate = fx().rate;
  const node = $('#tpl-card-detail').content.cloneNode(true);

  // Picture of this exact version when the marketplace has one.
  const img = $('.detail-img', node);
  const pic = variantImage(card, row);
  const fallback = card.image ? `${card.image}/high.webp` : '';
  img.alt = `${card.name}${row ? ` (${row.label})` : ''}`;
  img.addEventListener('error', () => {
    if (fallback && img.src !== fallback) {
      img.src = fallback;
      $('.img-note', img.parentNode).textContent = 'Standard picture (no marketplace photo for this version)';
    }
  });
  if (pic) img.src = pic.src;
  $('.img-note', node).textContent = pic?.source === 'tcgplayer' ? 'Photo: TCGplayer listing for this version' : pic ? 'Standard picture of this card' : 'No picture available';

  $('.detail-name', node).textContent = card.name;
  const sym = $('.set-symbol', node);
  if (card.set?.symbol) sym.src = setSymbol(card.set);
  else sym.remove();
  $('.set-name', node).textContent = card.set?.name || '';
  const code = catalog.setAbbr[card.set?.id];
  $('.detail-meta', node).textContent = [
    `#${printedNumber(card)}`,
    code,
    card.rarity,
    card.illustrator && `Illus. ${card.illustrator}`,
  ]
    .filter(Boolean)
    .join(' · ');
  // The scan can't tell this card from its reprint-collection twin (or the original): offer it.
  const twins = sheet.twins.some((t) => t.card.id === card.id) ? sheet.twins.filter((t) => t.card.id !== card.id) : [];
  $('.detail-top', node).after(...twins.map(twinNote));

  const hp = headlinePrice(row, rate);
  const anyPrice = rows.some((r) => headlinePrice(r, rate));
  $('.headline-price', node).textContent = hp ? formatMoney(hp.value) : 'No price yet';
  $('.headline-source', node).textContent = hp
    ? `${hp.source}${hp.converted ? ' (converted to USD)' : ''} · ${row?.label || ''}`
    : anyPrice
      ? 'No price for this version. Try another version or eBay sold listings.'
      : 'Price sites have no data for this card yet (common for brand-new sets). Check eBay sold listings below.';

  // Version chips (dedupe identical labels).
  const chips = $('.variant-chips', node);
  const seen = {};
  rows.forEach((r, i) => {
    seen[r.label] = (seen[r.label] || 0) + 1;
    const label = seen[r.label] > 1 ? `${r.label} #${seen[r.label]}` : r.label;
    const p = headlinePrice(r, rate);
    chips.append(
      el(
        'button',
        {
          class: `chip${i === rowIdx ? ' active' : ''}`,
          type: 'button',
          'aria-pressed': i === rowIdx ? 'true' : 'false',
          onclick: () => {
            sheet.current.rowIdx = i;
            renderDetail();
          },
        },
        label,
        p ? el('span', { class: 'chip-price' }, formatMoney(p.value)) : null,
      ),
    );
  });
  if (!rows.length) chips.append(el('span', { class: 'muted small' }, 'No version data for this card.'));
  // Why this version: a stamp spotted on the card, or stamped versions worth checking.
  const { pick, checking } = sheet.current;
  if (checking) chips.after(el('p', { class: 'small variant-reason checking' }, 'Checking the card for a stamp or set logo…'));
  else if (pick?.reason && rowIdx === pick.index) chips.after(el('p', { class: `small variant-reason${pick.stamps.length ? ' found' : ''}` }, pick.reason));

  // Price tables, all USD.
  const tables = $('.price-tables', node);
  const dl = (pairs) => el('dl', {}, ...pairs.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, formatMoney(v))]));
  const date = (s) => (s ? new Date(s).toLocaleDateString() : '');
  const usd = (v) => eurToUsd(v, rate);
  const info = fx();
  tables.append(
    el(
      'div',
      { class: 'ptable' },
      el('h4', {}, 'TCGplayer', el('span', { class: 'muted small' }, date(row?.tcg?.updated))),
      row?.tcg
        ? dl([['Market', row.tcg.market], ['Low', row.tcg.low], ['Mid', row.tcg.mid], ['High', row.tcg.high]])
        : el('div', { class: 'none' }, 'No TCGplayer price for this version. Tap TCGplayer below to see current listings.'),
    ),
    el(
      'div',
      { class: 'ptable' },
      el('h4', {}, 'Cardmarket (converted to USD)', el('span', { class: 'muted small' }, date(row?.cm?.updated))),
      row?.cm
        ? dl([['Trend', usd(row.cm.trend)], ['Avg', usd(row.cm.avg)], ['7-day', usd(row.cm.avg7)], ['30-day', usd(row.cm.avg30)]])
        : el('div', { class: 'none' }, 'No Cardmarket price for this version.'),
      row?.cm
        ? el('div', { class: 'muted small fx-note' }, `€1 = $${info.rate.toFixed(4)}${info.fallback ? ' (estimate, offline)' : info.date ? ` · rate from ${String(info.date).slice(0, 16)}` : ''}`)
        : null,
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

  // Actions (until the stamp check is done, the version may still change).
  const actions = $('.actions', node);
  const act = (action, label, primary) =>
    el(
      'button',
      {
        class: `btn${primary ? ' primary' : ''}`,
        type: 'button',
        disabled: checking,
        onclick: () => {
          const entry = makeEntry(card, row);
          // Listeners may set detail.toast to describe what they actually did.
          const detail = { action, card, row, entry, owner: sheet.opts.owner, toast: null };
          emit('card:action', detail);
          toast(detail.toast || { collection: 'Added to collection', 'trade-give': 'Added to "You give"', 'trade-get': 'Added to "You get"' }[action]);
          // Scanning cards for a trade: close so the next card can be scanned straight away.
          if (sheet.opts.tradeSide && action.startsWith('trade-')) closeSheet();
        },
      },
      label,
    );
  if (sheet.opts.onPick) {
    actions.append(
      el(
        'button',
        {
          class: 'btn primary wide',
          type: 'button',
          disabled: checking,
          onclick: () => {
            sheet.opts.onPick(card, row);
            closeSheet();
          },
        },
        sheet.opts.pickLabel || 'Use this card',
      ),
    );
  }
  actions.append(
    act('collection', 'Add to collection', !sheet.opts.onPick && !sheet.opts.tradeSide),
    act('trade-give', 'Trade: I give', sheet.opts.tradeSide === 'give'),
    act('trade-get', 'Trade: I get', sheet.opts.tradeSide === 'get'),
  );

  $('#card-detail').replaceChildren(node);
}
