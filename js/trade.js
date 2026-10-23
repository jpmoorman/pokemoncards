// "Trade" tab: compare what you give with what you get, all in US dollars.
// Public API (used by app.js):
//   initTrade()    once at start-up; listens for 'card:action' trade-give / trade-get
//   renderTrade()  draw #view-trade
// The current trade is kept on the device in localStorage ('trade.v1'). Lines are saved
// entries (see entry.js) plus pricedAt: when the card data their price comes from was
// downloaded (ms). Collection and Batch entries don't have it; their price may be months old.
// The trade also keeps a trade-value percentage (rate, 80–100) and the side it applies to
// (rateSide): a shop crediting your cards at 80% of market is rate 80 on 'give'.
import { $, el, on, emit, toast, confirmDialog, navigate } from './ui.js';
import { getCard, cardFetchedAt } from './api.js';
import { formatMoney } from './prices.js';
import { makeEntry, entryKey, refreshEntry, unitUsd, totalUsd, entryNumber } from './entry.js';
import { entryRow } from './components.js';
import { openCard, closeSheet } from './sheet.js';
import { loadCollection } from './collection.js';

const KEY = 'trade.v1';
const SIDES = { give: 'You give', get: 'You get' };
const OTHER = { give: 'get', get: 'give' };
export const MIN_RATE = 80; // lowest trade value % (defined before load() runs below)

let trade = load();
let editing = null; // { side, key } while the sheet is open on one of the trade's cards
let refreshing = ''; // progress label while prices refresh
let pendingUndo = null; // { side, line, i, toast } while "Removed … Undo" is showing

// ---------------- maths ----------------

const cents = (usd) => Math.round((usd || 0) * 100);
const cardsLabel = (n) => `${n} card${n === 1 ? '' : 's'}`;
const fmtPct = (p) => `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;

/**
 * Totals and verdict. Cards without a price count as $0, but a side where no card
 * has a price can't be judged ('unknown').
 * Returns { give, get: { usd, cards, unpriced }, diff (get − give, USD), pct (of the bigger side), unpriced, verdict: { kind, text } }
 *   kind: 'empty' | 'unknown' | 'fair' | 'ahead' | 'behind'
 */
export function evaluateTrade({ give = [], get = [], rate = 100, rateSide = 'give' } = {}) {
  const pct = clampRate(rate);
  const side = (list, s) => {
    const market = cents(totalUsd(list));
    const counted = s === rateSide && pct < 100 ? Math.round((market * pct) / 100) : market;
    return {
      usd: counted / 100, // what this side counts for in the trade
      market: market / 100, // full market value
      rate: s === rateSide ? pct : 100,
      cards: list.reduce((n, e) => n + (e.qty || 1), 0),
      unpriced: list.reduce((n, e) => n + (unitUsd(e) == null ? e.qty || 1 : 0), 0),
    };
  };
  const g = side(give, 'give');
  const r = side(get, 'get');
  const diffC = cents(r.usd) - cents(g.usd);
  const bigC = Math.max(cents(g.usd), cents(r.usd));
  const diffPct = bigC ? (Math.abs(diffC) / bigC) * 100 : 0;
  const diff = diffC / 100;
  const blind = g.unpriced === g.cards ? 'give' : r.unpriced === r.cards ? 'get' : null; // no card on that side has a price
  let verdict;
  if (!g.cards && !r.cards) verdict = { kind: 'empty', text: "Add the cards you'd give and get to see if it's fair." };
  else if (!g.cards) verdict = { kind: 'empty', text: 'Now add the cards you give.' };
  else if (!r.cards) verdict = { kind: 'empty', text: 'Now add the cards you get.' };
  else if (!bigC) verdict = { kind: 'unknown', text: 'No prices to compare — check eBay sold listings.' };
  else if (blind) verdict = { kind: 'unknown', text: unpricedSide(blind, blind === 'give' ? g.cards : r.cards) };
  else if (Math.abs(diffC) * 20 <= bigC) verdict = { kind: 'fair', text: 'Fair trade (within 5%)' };
  else if (diffC > 0) verdict = { kind: 'ahead', text: `You come out ahead by ${formatMoney(diff)}` };
  else verdict = { kind: 'behind', text: `You'd lose ${formatMoney(-diff)}` };
  return { give: g, get: r, diff, pct: diffPct, unpriced: g.unpriced + r.unpriced, verdict };
}

/** Trade value %: a whole number from 80 to 100. (A function declaration: load() uses it at start-up.) */
export function clampRate(r) {
  return Math.min(100, Math.max(MIN_RATE, Math.round(Number(r) || 100)));
}

function unpricedSide(side, n) {
  const what = n === 1 ? `the card you ${side} has no price` : `none of the ${n} cards you ${side} have a price`;
  return `Can't judge: ${what} — check eBay sold listings.`;
}

// ---------------- storage ----------------

function load() {
  try {
    const t = JSON.parse(localStorage.getItem(KEY));
    const list = (a) => (Array.isArray(a) ? a.filter((e) => e && e.id) : []);
    return { give: list(t?.give), get: list(t?.get), rate: clampRate(t?.rate ?? 100), rateSide: t?.rateSide === 'get' ? 'get' : 'give' };
  } catch {
    return { give: [], get: [], rate: 100, rateSide: 'give' };
  }
}

/** Save and redraw, then tell other views ('trade:changed', see ui.js) what changed. */
function commit(change = {}) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ give: trade.give, get: trade.get, rate: trade.rate, rateSide: trade.rateSide, updated: Date.now() }));
  } catch {
    toast('Could not save the trade — phone storage is full');
  }
  renderTrade();
  emit('trade:changed', change);
}

// ---------------- changes ----------------

/** An entry priced from the card data the sheet just loaded. */
const fromSheet = (card, row, entry) => ({ ...(entry || makeEntry(card, row)), pricedAt: cardFetchedAt(card.id) || Date.now() });

function clean(e) {
  const { key, ...rest } = e; // collection rows carry a cached key
  return { ...rest, qty: e.qty || 1, added: Date.now() };
}

/** Another copy of a line's card: add the quantity; its price replaces the line's only if known to be newer. */
function merge(line, e) {
  line.qty = (line.qty || 1) + (e.qty || 1);
  if (e.price && (!line.price || (e.pricedAt && e.pricedAt >= (line.pricedAt || 0)))) {
    line.price = e.price;
    line.pricedAt = e.pricedAt;
  }
}

/** Add to a side; the same card in the same version just bumps the quantity. */
function addEntry(side, e) {
  const same = trade[side].find((x) => entryKey(x) === entryKey(e));
  if (same) merge(same, e);
  else trade[side].push(clean(e));
  commit();
}

/** A line added from saved data (collection, batch) may carry an old price: look up today's. */
async function freshen(e) {
  const fresh = await refreshEntry(e);
  const at = cardFetchedAt(e.id);
  if (fresh.price === e.price || !at) return; // offline, or no newer price for this version
  let changed = false;
  for (const line of [...trade.give, ...trade.get]) {
    if (entryKey(line) !== entryKey(e) || (line.pricedAt || 0) > at) continue; // a Refresh finished first
    line.price = fresh.price;
    line.pricedAt = at;
    changed = true;
  }
  if (changed) commit();
}

/** Swap one line for another version of the card, keeping its place and quantity. */
function replaceLine(side, key, e) {
  const list = trade[side];
  const i = list.findIndex((x) => entryKey(x) === key);
  if (i < 0) return addEntry(side, e);
  const next = { ...clean(e), qty: list[i].qty || 1 };
  const dup = list.findIndex((x, j) => j !== i && entryKey(x) === entryKey(next));
  if (dup >= 0) {
    merge(list[dup], next);
    list.splice(i, 1);
  } else {
    list[i] = next;
  }
  commit({ side, from: key, to: entryKey(next) });
}

function changeQty(side, e, delta) {
  const list = trade[side];
  const i = list.findIndex((x) => entryKey(x) === entryKey(e));
  if (i < 0) return;
  const qty = (list[i].qty || 1) + delta;
  if (qty > 0) {
    list[i].qty = qty;
    commit();
    return;
  }
  const [removed] = list.splice(i, 1);
  commit();
  offerUndo(side, removed, i);
}

/** "Removed X · Undo" for 5 s. Swap sides moves the pending undo along; Clear trade or a newer removal drops it. */
function offerUndo(side, line, i) {
  dropUndo();
  const u = { side, line, i };
  const onclick = () => {
    if (pendingUndo !== u) return;
    dropUndo();
    const list = trade[u.side];
    const same = list.find((x) => entryKey(x) === entryKey(line));
    if (same) merge(same, line);
    else list.splice(Math.min(i, list.length), 0, line);
    commit();
  };
  u.toast = el('div', { class: 'toast trade-undo', role: 'status' }, el('span', {}, `Removed ${line.name}`), el('button', { type: 'button', onclick }, 'Undo'));
  pendingUndo = u;
  document.body.append(u.toast);
  setTimeout(() => pendingUndo === u && dropUndo(), 5000);
}

function dropUndo() {
  pendingUndo?.toast.remove();
  pendingUndo = null;
}

/** Tap on a trade card: open its sheet; "Use this version" (or the same side's trade button) changes the line. */
function openLine(side, e) {
  const key = entryKey(e);
  editing = { side, key };
  openCard(e.id, {
    owner: editing,
    preferred: e.variantId || e.variant,
    pickLabel: 'Use this version',
    onPick: (card, row) => {
      const next = fromSheet(card, row);
      if (entryKey(next) === key) return;
      replaceLine(side, key, next);
      toast(`Changed to ${next.variant || 'that version'}`);
    },
  });
}

function onCardAction(detail) {
  const { action, card, row, entry, owner } = detail;
  const side = { 'trade-give': 'give', 'trade-get': 'get' }[action];
  if (!side) return;
  // Batch results send only `entry`; the sheet sends card + row too.
  const e = card ? fromSheet(card, row, entry) : entry;
  if (!e?.id) return;
  const ed = editing && owner === editing ? editing : null; // only the trade line's own sheet edits it
  const line = ed && trade[ed.side].find((x) => entryKey(x) === ed.key);
  if (line && ed.side === side && line.id === e.id && entryKey(e) !== ed.key) {
    replaceLine(side, ed.key, e);
    detail.toast = `Changed to ${e.variant || 'that version'}`;
  } else {
    addEntry(side, e);
    if (!card) freshen(e); // the Batch tab priced it when the photo was processed
  }
  // Opened from a trade line: go straight back to the updated trade.
  if (ed) closeSheet();
}

function swapSides() {
  trade = { ...trade, give: trade.get, get: trade.give };
  if (pendingUndo) pendingUndo.side = OTHER[pendingUndo.side]; // the removed card belongs with its old list
  commit({ swapped: true });
  toast('Sides swapped');
}

async function clearTrade() {
  if (!trade.give.length && !trade.get.length) return;
  if (!(await confirmDialog('Remove every card from this trade?', 'Clear trade'))) return;
  trade = { ...trade, give: [], get: [] }; // the trade-value setting stays
  dropUndo();
  commit();
}

/** Download every card in the trade again (once per card) and re-price its lines. */
async function refreshPrices() {
  const ids = [...new Set([...trade.give, ...trade.get].map((e) => e.id))];
  if (!ids.length || refreshing) return;
  const started = Date.now();
  let fetched = 0;
  for (const [n, id] of ids.entries()) {
    refreshing = `Refreshing ${n + 1}/${ids.length}…`;
    const btn = $('#trade-refresh');
    if (btn) btn.textContent = refreshing;
    await getCard(id, { fresh: true }).catch(() => null);
    if (cardFetchedAt(id) >= started) fetched++;
  }
  // The trade may have changed meanwhile (swap, qty, adds): go through the lines as they are now.
  for (const line of [...trade.give, ...trade.get]) {
    const at = cardFetchedAt(line.id);
    if (at < started) continue; // not downloaded: keep its price
    line.price = (await refreshEntry(line)).price;
    line.pricedAt = at;
  }
  refreshing = '';
  commit();
  if (fetched === ids.length) toast('Prices updated');
  else if (fetched) toast(`Updated ${fetched} of ${cardsLabel(ids.length)} — couldn't reach the price server for the rest`, 4000);
  else toast("Couldn't reach the price server — prices not updated", 4000);
}

/** Is this card + version (entryKey) on either side of the current trade? */
export function inTrade(key) {
  return trade.give.some((x) => entryKey(x) === key) || trade.get.some((x) => entryKey(x) === key);
}

// ---------------- share ----------------

function shareText(ev = evaluateTrade(trade)) {
  const line = (e) => {
    const q = e.qty || 1;
    const unit = unitUsd(e);
    const price = unit == null ? 'no price' : q > 1 ? `${formatMoney(unit * q)} (${formatMoney(unit)} each)` : formatMoney(unit);
    const where = [e.setName, entryNumber(e)].filter(Boolean).join(' ');
    return `• ${q > 1 ? `${q}× ` : ''}${e.name}${where ? ` (${where})` : ''}${e.variant ? ` · ${e.variant}` : ''} — ${price}`;
  };
  const counted = (s) => (ev[s].rate < 100 ? ` — counted at ${ev[s].rate}%: ${formatMoney(ev[s].usd)}` : '');
  const side = (s) => [`${SIDES[s]}: ${formatMoney(ev[s].market)} (${cardsLabel(ev[s].cards)})${counted(s)}`, ...trade[s].map(line)];
  const out = ['Pokémon card trade', '', ...side('give'), '', ...side('get'), '', ev.verdict.text];
  if (ev.verdict.kind !== 'empty' && ev.verdict.kind !== 'unknown') out.push(`Difference: ${formatMoney(Math.abs(ev.diff))} (${fmtPct(ev.pct)} of the bigger side)`);
  if (ev.unpriced) out.push(`${cardsLabel(ev.unpriced)} without a price counted as $0.`);
  out.push('Prices in US dollars for raw Near Mint copies (TCGplayer market, or Cardmarket trend converted from euros).');
  return out.join('\n');
}

async function share() {
  const text = shareText();
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Pokémon card trade', text });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // closed the share sheet
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Trade copied — paste it in a message');
  } catch {
    textDialog(text);
  }
}

/** Last resort when neither sharing nor the clipboard works: show the text to copy by hand. */
function textDialog(text) {
  const close = () => wrap.remove();
  const area = el('textarea', { class: 'trade-text', readonly: true, rows: 10 }, text);
  const wrap = el(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
    el('div', { class: 'modal-backdrop', onclick: close }),
    el('div', { class: 'modal-panel' }, el('p', {}, 'Copy this and paste it in a message:'), area, el('div', { class: 'row modal-actions' }, el('button', { class: 'btn primary', type: 'button', onclick: close }, 'Close'))),
  );
  document.body.append(wrap);
  area.select();
}

// ---------------- pick from collection ----------------

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function pickFromCollection(side) {
  const items = loadCollection();
  const added = {};
  const close = () => wrap.remove();
  const list = el('ul', { class: 'collection tp-list' });
  const none = el('p', { class: 'muted small center' }, items.length ? 'No saved cards match.' : 'No saved cards yet. Scan a card and tap Add to collection first.');
  const filter = el('input', { type: 'search', placeholder: 'Filter by name, set, number or version', 'aria-label': 'Filter saved cards', enterkeyhint: 'search' });

  const draw = () => {
    const words = fold(filter.value).split(/\s+/).filter(Boolean);
    const shown = items.filter((i) => {
      const hay = fold([i.name, i.setName, entryNumber(i), i.variant].join(' '));
      return words.every((w) => hay.includes(w));
    });
    none.hidden = !!shown.length;
    list.replaceChildren(
      ...shown.map((i) => {
        const k = entryKey(i);
        const add = () => {
          const e = { ...i, qty: 1 };
          addEntry(side, e);
          freshen(e); // the collection keeps the price from when the card was saved
          added[k] = (added[k] || 0) + 1;
          draw();
        };
        const btn = el('button', { class: `btn small${added[k] ? '' : ' primary'} tp-add`, type: 'button', onclick: add }, added[k] ? `Added ×${added[k]}` : 'Add');
        const row = entryRow({ ...i, qty: 1 }, { onOpen: add, right: btn });
        if (i.qty > 1) row.querySelector('.c-main').append(el('div', { class: 'c-sub' }, `You have ${i.qty}`));
        return row;
      }),
    );
  };
  filter.addEventListener('input', draw);

  const wrap = el(
    'div',
    { class: 'modal trade-picker', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tp-title' },
    el('div', { class: 'modal-backdrop', onclick: close }),
    el(
      'div',
      { class: `modal-panel tp-panel ${side}` },
      el('div', { class: 'tp-head' }, el('h3', { id: 'tp-title' }, 'Add to ', el('span', { class: 'tp-side' }, SIDES[side])), el('button', { class: 'btn small', type: 'button', onclick: close }, 'Done')),
      items.length ? filter : null,
      list,
      none,
    ),
  );
  draw();
  document.body.append(wrap);
}

// ---------------- view ----------------

function summary(ev) {
  const total = ev.give.usd + ev.get.usd;
  const known = total && ev.verdict.kind !== 'unknown';
  const giveShare = known ? (ev.give.usd / total) * 100 : 50;
  // Keep a sliver of each priced side visible.
  const width = ev.give.usd && ev.get.usd ? Math.min(98.5, Math.max(1.5, giveShare)) : giveShare;
  const sideBox = (s) =>
    el(
      'div',
      { class: `ts-side ${s}` },
      el('span', { class: 'ts-label' }, SIDES[s]),
      el('b', { class: 'ts-amount' }, formatMoney(ev[s].usd)),
      el('span', { class: 'ts-count' }, ev[s].rate < 100 ? `${ev[s].rate}% of ${formatMoney(ev[s].market)}` : cardsLabel(ev[s].cards)),
    );
  const compared = ev.verdict.kind !== 'empty' && ev.verdict.kind !== 'unknown';
  return el(
    'div',
    { class: 'trade-summary' },
    el(
      'div',
      { class: 'ts-card', 'aria-live': 'polite' },
      el('div', { class: 'ts-totals' }, sideBox('give'), el('span', { class: 'ts-vs', 'aria-hidden': 'true' }, 'vs'), sideBox('get')),
      el(
        'div',
        { class: `ts-bar${known ? '' : ' empty'}`, role: 'img', 'aria-label': known ? `Value split: you give ${Math.round(giveShare)}%, you get ${Math.round(100 - giveShare)}%` : 'Value split: not known' },
        el('span', { class: 'ts-give', style: `width: ${width.toFixed(2)}%` }),
        el('span', { class: 'ts-get' }),
        el('i', { class: 'ts-mid' }),
      ),
      el('p', { class: `ts-verdict ${ev.verdict.kind}` }, ev.verdict.text),
      compared ? el('p', { class: 'ts-diff' }, `Difference ${formatMoney(Math.abs(ev.diff))} · ${fmtPct(ev.pct)} of the bigger side`) : null,
      ev.unpriced
        ? el('p', { class: 'ts-warn' }, `${ev.unpriced === 1 ? '1 card has' : `${ev.unpriced} cards have`} no price — check eBay (counted as $0)`)
        : null,
    ),
  );
}

function sideTotal(s) {
  return s.rate < 100 ? `${formatMoney(s.market)} → ${formatMoney(s.usd)} at ${s.rate}%` : formatMoney(s.usd);
}

/** Trade-value slider: count one side at 80–100% of market (e.g. a shop's 80% trade-in credit). */
function rateControl() {
  const label = el('b', { class: 'tr-value' }, `${trade.rate}%`);
  const slider = el('input', {
    type: 'range', min: MIN_RATE, max: 100, step: 1, value: trade.rate, id: 'trade-rate', class: 'tr-slider',
    'aria-label': 'Trade value percentage', 'aria-valuetext': `${trade.rate}%`,
  });
  // While dragging only the numbers update, so the slider isn't redrawn under the finger.
  slider.addEventListener('input', () => {
    trade.rate = clampRate(slider.value);
    label.textContent = `${trade.rate}%`;
    slider.setAttribute('aria-valuetext', `${trade.rate}%`);
    updateNumbers();
  });
  slider.addEventListener('change', () => commit({ rate: trade.rate }));
  const sideBtn = (s) =>
    el(
      'button',
      {
        type: 'button', class: `chip${trade.rateSide === s ? ' active' : ''}`, 'aria-pressed': trade.rateSide === s ? 'true' : 'false',
        onclick: () => {
          if (trade.rateSide === s) return;
          trade.rateSide = s;
          commit({ rate: trade.rate });
        },
      },
      s === 'give' ? 'Your cards' : 'Their cards',
    );
  return el(
    'div',
    { class: 'trade-rate' },
    el('div', { class: 'tr-head' }, el('span', {}, 'Trade value'), label, trade.rate < 100 ? el('button', { type: 'button', class: 'tr-reset', onclick: () => ((trade.rate = 100), commit({ rate: 100 })) }, 'Reset to 100%') : null),
    slider,
    el('div', { class: 'tr-scale', 'aria-hidden': 'true' }, el('span', {}, '80%'), el('span', {}, '90%'), el('span', {}, '100%')),
    el('div', { class: 'tr-side' }, el('span', { class: 'muted small' }, 'Applies to'), sideBtn('give'), sideBtn('get')),
    el('p', { class: 'muted small tr-hint' }, trade.rate < 100 ? `${trade.rateSide === 'give' ? 'Your cards' : 'Their cards'} count at ${trade.rate}% of market value, like a shop's trade-in credit.` : 'At 100% every card counts at full market value. Slide down (to 80%) for trade-in offers.'),
  );
}

/** Refresh just the totals and verdict (used while the slider moves). */
function updateNumbers() {
  const ev = evaluateTrade(trade);
  $('#view-trade .trade-summary')?.replaceWith(summary(ev));
  for (const s of ['give', 'get']) {
    const t = $(`#trade-${s} .tside-total`);
    if (t) t.textContent = sideTotal(ev[s]);
  }
  const hint = $('#view-trade .tr-hint');
  if (hint) hint.textContent = trade.rate < 100 ? `${trade.rateSide === 'give' ? 'Your cards' : 'Their cards'} count at ${trade.rate}% of market value, like a shop's trade-in credit.` : 'At 100% every card counts at full market value. Slide down (to 80%) for trade-in offers.';
}

function sideSection(side, ev) {
  const list = trade[side];
  const btn = (label, onclick) => el('button', { class: 'btn small', type: 'button', onclick }, label);
  return el(
    'section',
    { class: `trade-side ${side}`, id: `trade-${side}`, 'aria-labelledby': `trade-${side}-title` },
    el('div', { class: 'tside-head' }, el('h2', { id: `trade-${side}-title` }, SIDES[side]), el('span', { class: 'tside-total' }, sideTotal(ev[side]))),
    list.length
      ? el(
          'ul',
          { class: 'collection trade-list' },
          ...list.map((e) =>
            entryRow(e, {
              onOpen: () => openLine(side, e),
              onQty: (d) => changeQty(side, e, d),
              right: unitUsd(e) == null ? el('span', { class: 'tline-noprice' }, 'No price') : null,
            }),
          ),
        )
      : el('p', { class: 'muted small tside-empty' }, side === 'give' ? "Add the cards you're handing over." : "Add the cards you'll receive."),
    el(
      'div',
      { class: 'trade-add' },
      btn('Scan', () => navigate('scan', { tradeSide: side })),
      btn('Search', () => navigate('search', { tradeSide: side })),
      btn('From collection', () => pickFromCollection(side)),
    ),
  );
}

export function renderTrade() {
  const view = $('#view-trade');
  if (!view) return;
  const ev = evaluateTrade(trade);
  const empty = !trade.give.length && !trade.get.length;
  view.style.setProperty('--trade-top', `${$('.topbar')?.offsetHeight || 0}px`);
  view.replaceChildren(
    summary(ev),
    rateControl(),
    el(
      'div',
      { class: 'trade-sides' },
      sideSection('give', ev),
      el('button', { class: 'btn small trade-swap', type: 'button', onclick: swapSides, disabled: empty, 'aria-label': 'Swap sides' }, '⇅ Swap sides'),
      sideSection('get', ev),
    ),
    el(
      'div',
      { class: 'trade-tools' },
      el('button', { class: 'btn small primary', type: 'button', id: 'trade-share', onclick: share, disabled: empty }, 'Share'),
      el('button', { class: 'btn small', type: 'button', id: 'trade-refresh', onclick: refreshPrices, disabled: empty || !!refreshing }, refreshing || 'Refresh prices'),
      el('button', { class: 'btn small', type: 'button', id: 'trade-clear', onclick: clearTrade, disabled: empty }, 'Clear trade'),
    ),
    el('p', { class: 'muted small fine' }, 'Prices are US dollars for raw Near Mint copies: TCGplayer market, or Cardmarket trend converted from euros. "Fair" means within 5% of the bigger side. Tap a card to change its version or check eBay sold listings.'),
  );
}

export function initTrade() {
  on('card:action', onCardAction);
  on('sheet:closed', () => (editing = null));
  on('fx:ready', renderTrade);
  window.addEventListener('resize', () => $('#view-trade')?.style.setProperty('--trade-top', `${$('.topbar')?.offsetHeight || 0}px`));
  renderTrade();
}
