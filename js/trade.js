// "Trade" tab: compare what you give with what you get, all in US dollars.
// Public API (used by app.js):
//   initTrade()    once at start-up; listens for 'card:action' trade-give / trade-get
//   renderTrade()  draw #view-trade
// The current trade is kept on the device in localStorage ('trade.v1').
import { $, el, on, toast, confirmDialog, navigate } from './ui.js';
import { formatMoney } from './prices.js';
import { makeEntry, entryKey, refreshEntry, unitUsd, totalUsd, entryNumber } from './entry.js';
import { entryRow } from './components.js';
import { openCard, closeSheet } from './sheet.js';
import { loadCollection } from './collection.js';

const KEY = 'trade.v1';
const SIDES = { give: 'You give', get: 'You get' };
const OTHER = { give: 'get', get: 'give' };

let trade = load();
let editing = null; // { side, key } while the sheet is open on one of the trade's cards
let refreshing = ''; // progress label while prices refresh

// ---------------- maths ----------------

const cents = (usd) => Math.round((usd || 0) * 100);
const cardsLabel = (n) => `${n} card${n === 1 ? '' : 's'}`;
const fmtPct = (p) => `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;

/**
 * Totals and verdict. Cards without a price count as $0.
 * Returns { give, get: { usd, cards, unpriced }, diff (get − give, USD), pct (of the bigger side), unpriced, verdict: { kind, text } }
 *   kind: 'empty' | 'unknown' | 'fair' | 'ahead' | 'behind'
 */
export function evaluateTrade({ give = [], get = [] } = {}) {
  const side = (list) => ({
    usd: cents(totalUsd(list)) / 100,
    cards: list.reduce((s, e) => s + (e.qty || 1), 0),
    unpriced: list.reduce((s, e) => s + (unitUsd(e) == null ? e.qty || 1 : 0), 0),
  });
  const g = side(give);
  const r = side(get);
  const diffC = cents(r.usd) - cents(g.usd);
  const bigC = Math.max(cents(g.usd), cents(r.usd));
  const pct = bigC ? (Math.abs(diffC) / bigC) * 100 : 0;
  const diff = diffC / 100;
  let verdict;
  if (!g.cards && !r.cards) verdict = { kind: 'empty', text: "Add the cards you'd give and get to see if it's fair." };
  else if (!g.cards) verdict = { kind: 'empty', text: 'Now add the cards you give.' };
  else if (!r.cards) verdict = { kind: 'empty', text: 'Now add the cards you get.' };
  else if (!bigC) verdict = { kind: 'unknown', text: 'No prices to compare — check eBay sold listings.' };
  else if (Math.abs(diffC) * 20 <= bigC) verdict = { kind: 'fair', text: 'Fair trade (within 5%)' };
  else if (diffC > 0) verdict = { kind: 'ahead', text: `You come out ahead by ${formatMoney(diff)}` };
  else verdict = { kind: 'behind', text: `You'd lose ${formatMoney(-diff)}` };
  return { give: g, get: r, diff, pct, unpriced: g.unpriced + r.unpriced, verdict };
}

// ---------------- storage ----------------

function load() {
  try {
    const t = JSON.parse(localStorage.getItem(KEY));
    const list = (a) => (Array.isArray(a) ? a.filter((e) => e && e.id) : []);
    return { give: list(t?.give), get: list(t?.get) };
  } catch {
    return { give: [], get: [] };
  }
}

function commit() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ give: trade.give, get: trade.get, updated: Date.now() }));
  } catch {
    toast('Could not save the trade — phone storage is full');
  }
  renderTrade();
}

// ---------------- changes ----------------

function clean(e) {
  const { key, ...rest } = e; // collection rows carry a cached key
  return { ...rest, qty: e.qty || 1, added: Date.now() };
}

/** Add to a side; the same card in the same version just bumps the quantity. */
function addEntry(side, e) {
  const same = trade[side].find((x) => entryKey(x) === entryKey(e));
  if (same) {
    same.qty = (same.qty || 1) + (e.qty || 1);
    same.price = e.price || same.price;
  } else {
    trade[side].push(clean(e));
  }
  commit();
}

/** Swap one line for another version of the card, keeping its place and quantity. */
function replaceLine(side, key, e) {
  const list = trade[side];
  const i = list.findIndex((x) => entryKey(x) === key);
  if (i < 0) return addEntry(side, e);
  const next = { ...clean(e), qty: list[i].qty || 1 };
  const dup = list.findIndex((x, j) => j !== i && entryKey(x) === entryKey(next));
  if (dup >= 0) {
    list[dup].qty = (list[dup].qty || 1) + next.qty;
    list[dup].price = next.price || list[dup].price;
    list.splice(i, 1);
  } else {
    list[i] = next;
  }
  commit();
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
  undoToast(`Removed ${removed.name}`, () => {
    const same = trade[side].find((x) => entryKey(x) === entryKey(removed));
    if (same) same.qty = (same.qty || 1) + (removed.qty || 1);
    else trade[side].splice(Math.min(i, trade[side].length), 0, removed);
    commit();
  });
}

/** Tap on a trade card: open its sheet; "Use this version" (or the same side's trade button) changes the line. */
function openLine(side, e) {
  const key = entryKey(e);
  editing = { side, key };
  openCard(e.id, {
    preferred: e.variantId || e.variant,
    pickLabel: 'Use this version',
    onPick: (card, row) => {
      const next = makeEntry(card, row);
      if (entryKey(next) === key) return;
      replaceLine(side, key, next);
      toast(`Changed to ${next.variant || 'that version'}`);
    },
  });
}

function onCardAction(detail) {
  const { action, card, row, entry } = detail;
  const side = { 'trade-give': 'give', 'trade-get': 'get' }[action];
  if (!side) return;
  // Batch results send only `entry`; the sheet sends card + row too.
  const e = entry || (card ? makeEntry(card, row) : null);
  if (!e?.id) return;
  const ed = editing;
  const line = ed && trade[ed.side].find((x) => entryKey(x) === ed.key);
  if (line && ed.side === side && line.id === e.id && entryKey(e) !== ed.key) {
    replaceLine(side, ed.key, e);
    detail.toast = `Changed to ${e.variant || 'that version'}`;
  } else addEntry(side, e);
  // Opened from a trade line: go straight back to the updated trade.
  if (ed) closeSheet();
}

function swapSides() {
  trade = { give: trade.get, get: trade.give };
  commit();
  toast('Sides swapped');
}

async function clearTrade() {
  if (!trade.give.length && !trade.get.length) return;
  if (!(await confirmDialog('Remove every card from this trade?', 'Clear trade'))) return;
  trade = { give: [], get: [] };
  commit();
}

async function refreshPrices() {
  const all = [...trade.give.map((e) => ['give', e]), ...trade.get.map((e) => ['get', e])];
  if (!all.length || refreshing) return;
  for (const [n, [side, e]] of all.entries()) {
    refreshing = `Refreshing ${n + 1}/${all.length}…`;
    const btn = $('#trade-refresh');
    if (btn) btn.textContent = refreshing;
    const fresh = await refreshEntry(e);
    // The trade may have changed meanwhile (swap, qty): update by key.
    const line = trade[side].find((x) => entryKey(x) === entryKey(e));
    if (line) line.price = fresh.price;
  }
  refreshing = '';
  commit();
  toast('Prices updated');
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
  const side = (s) => [`${SIDES[s]}: ${formatMoney(ev[s].usd)} (${cardsLabel(ev[s].cards)})`, ...trade[s].map(line)];
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
          addEntry(side, { ...i, qty: 1 });
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

function undoToast(msg, undo) {
  const onclick = () => {
    t.remove();
    undo();
  };
  const t = el('div', { class: 'toast trade-undo', role: 'status' }, el('span', {}, msg), el('button', { type: 'button', onclick }, 'Undo'));
  document.body.append(t);
  setTimeout(() => t.remove(), 5000);
}

function summary(ev) {
  const total = ev.give.usd + ev.get.usd;
  const giveShare = total ? (ev.give.usd / total) * 100 : 50;
  // Keep a sliver of each priced side visible.
  const width = ev.give.usd && ev.get.usd ? Math.min(98.5, Math.max(1.5, giveShare)) : giveShare;
  const sideBox = (s) =>
    el('div', { class: `ts-side ${s}` }, el('span', { class: 'ts-label' }, SIDES[s]), el('b', { class: 'ts-amount' }, formatMoney(ev[s].usd)), el('span', { class: 'ts-count' }, cardsLabel(ev[s].cards)));
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
        { class: `ts-bar${total ? '' : ' empty'}`, role: 'img', 'aria-label': `Value split: you give ${Math.round(giveShare)}%, you get ${Math.round(100 - giveShare)}%` },
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

function sideSection(side, ev) {
  const list = trade[side];
  const btn = (label, onclick) => el('button', { class: 'btn small', type: 'button', onclick }, label);
  return el(
    'section',
    { class: `trade-side ${side}`, id: `trade-${side}`, 'aria-labelledby': `trade-${side}-title` },
    el('div', { class: 'tside-head' }, el('h2', { id: `trade-${side}-title` }, SIDES[side]), el('span', { class: 'tside-total' }, formatMoney(ev[side].usd))),
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
