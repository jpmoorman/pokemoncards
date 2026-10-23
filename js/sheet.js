// The slide-up result sheet: what the camera read, the matched card, its versions and prices.
import { $, $$, el, emit, toast } from './ui.js';
import { getCard, setSymbol } from './api.js';
import { rankCandidates, confidence } from './match.js';
import { variantPrices, headlinePrice, formatMoney, marketLinks, printedNumber, variantImage, eurToUsd } from './prices.js';
import { catalog, catalogReady, abbrReady, setOptions } from './catalog.js';
import { pickVariant } from './stamps.js';
import { cardTile } from './components.js';
import { makeEntry } from './entry.js';
import { fx } from './fx.js';

// Current sheet state.
const sheet = {
  current: null, // { card, rows, rowIdx }
  opts: {}, // see showResults
  clues: null,
};

export function initSheet() {
  $$('#sheet [data-close]').forEach((b) => b.addEventListener('click', closeSheet));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('#sheet').hidden && closeSheet());
  $('#clue-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const clues = cluesFromForm();
    await catalogReady();
    await abbrReady();
    showResults(rankCandidates(catalog.index, clues, catalog.setAbbr), clues, null, sheet.opts);
  });
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

/** Fill a <select> with every set: coded sets ("POR · Perfect Order") then older symbol-only sets. */
export function fillSetSelect(select, selectedId = '') {
  const { coded, older } = setOptions();
  select.replaceChildren(
    el('option', { value: '' }, 'Any set'),
    el('optgroup', { label: 'Set code printed on the card' }, ...coded.map((s) => el('option', { value: s.id }, `${s.code} · ${s.name}`))),
    el('optgroup', { label: 'Older sets (symbol only)' }, ...older.map((s) => el('option', { value: s.id }, s.name))),
  );
  select.value = selectedId || '';
}

function selectedSetFromClues(clues) {
  if (clues.setIds?.length) return clues.setIds[0];
  const codes = (clues.setCodes || []).map((c) => c.toUpperCase().replace(/O/g, '0'));
  for (const [id, code] of Object.entries(catalog.setAbbr)) {
    if (codes.includes(code.toUpperCase().replace(/O/g, '0'))) return id;
  }
  return '';
}

function openSheet() {
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
}

export function closeSheet() {
  $('#sheet').hidden = true;
  document.body.style.overflow = '';
  emit('sheet:closed', {});
}

/**
 * Show match results.
 *   ranked - [{ card, set }] best first (may be empty)
 *   clues  - what OCR read (null hides the "what the camera read" box)
 *   debug  - raw OCR text (null hides it)
 *   opts   - { onPick(card, row), pickLabel, preferred }
 *            onPick adds a primary "Use this card" button (batch review).
 */
export function showResults(ranked, clues, debug, opts = {}) {
  sheet.opts = opts;
  sheet.clues = clues;
  openSheet();
  $('#sheet .sheet-panel').scrollTop = 0;
  $('#detected').hidden = !clues;
  if (clues) {
    $('#clue-name').value = clues.nameBest || clues.nameAll || '';
    const n = clues.numbers?.[0];
    $('#clue-number').value = n ? n.text || `${n.prefix}${n.num}${n.total ? `/${n.prefix}${n.total}` : ''}` : '';
    fillSetSelect($('#clue-set'), selectedSetFromClues(clues));
    const conf = confidence(ranked);
    const confEl = $('#confidence');
    confEl.className = `conf ${conf}`;
    confEl.textContent = { high: 'Confident match', medium: 'Likely match', low: 'Unsure — check below', none: 'No match' }[conf];
  }

  if (debug) {
    $('#debug-wrap').hidden = false;
    $('#debug').textContent = Object.entries({ 'NAME AREA': debug.name, 'BOTTOM AREA': debug.bottom, ARTWORK: debug.art, 'WHOLE CARD': debug.full })
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}:\n${v}`)
      .join('\n\n');
  } else {
    $('#debug-wrap').hidden = true;
  }

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
  showCard(ranked[0].card.id, { ...opts, clues });
  const alts = ranked.slice(1, 13);
  $('#alternates-wrap').hidden = !alts.length;
  $('#alternates').replaceChildren(...alts.map((r) => cardTile(r, () => showCard(r.card.id, { ...opts, clues, scroll: true }))));
}

/** Open the sheet on one card (from search, collection, trade…). opts as showResults plus { preferred }. */
export function openCard(id, opts = {}) {
  sheet.opts = opts;
  sheet.clues = null;
  openSheet();
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
  const pick = pickVariant(rows, { card, clues: opts.clues || null, preferred: opts.preferred });
  sheet.current = { card, rows, rowIdx: pick.index, pick };
  renderDetail();
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
  const pick = sheet.current.pick;
  if (pick?.reason && rowIdx === pick.index) chips.after(el('p', { class: `small variant-reason${pick.stamps.length ? ' found' : ''}` }, pick.reason));

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

  // Actions.
  const actions = $('.actions', node);
  const act = (action, label, primary) =>
    el(
      'button',
      {
        class: `btn${primary ? ' primary' : ''}`,
        type: 'button',
        onclick: () => {
          const entry = makeEntry(card, row);
          emit('card:action', { action, card, row, entry });
          toast({ collection: 'Added to collection', 'trade-give': 'Added to "You give"', 'trade-get': 'Added to "You get"' }[action]);
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
