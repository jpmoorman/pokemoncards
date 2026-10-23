// Reusable pieces of UI: card tiles and saved-card rows.
import { el } from './ui.js';
import { cardImage } from './api.js';
import { formatMoney, printedNumber } from './prices.js';
import { entryNumber, entryThumb, unitUsd } from './entry.js';

/** Grid tile for a search/match result { card, set }. */
export function cardTile(r, onclick) {
  const img = r.card.image
    ? el('img', { src: cardImage(r.card), alt: r.card.name, loading: 'lazy' })
    : el('div', { class: 'noimg' }, 'No image');
  const number = printedNumber({ localId: r.card.localId, official: r.set?.cardCount?.official });
  return el(
    'button',
    { class: 'tile', type: 'button', onclick },
    img,
    el('span', { class: 't-name' }, r.card.name),
    el('span', { class: 't-sub' }, `${r.set?.name || ''} · ${number}`),
  );
}

/** <img> that falls back to a second URL (TCGplayer photo -> TCGdex scan). */
export function cardImg(src, fallback, attrs = {}) {
  const img = el('img', { alt: '', loading: 'lazy', ...attrs });
  img.addEventListener('error', () => {
    if (fallback && img.src !== fallback) img.src = fallback;
  });
  if (src || fallback) img.src = src || fallback;
  return img;
}

/**
 * Row for a saved card. opts:
 *   onOpen()          tap on picture/name
 *   onQty(delta)      show − ×n + controls
 *   right             extra node(s) under the price
 */
export function entryRow(e, { onOpen, onQty, right } = {}) {
  const unit = unitUsd(e);
  const qty = e.qty || 1;
  return el(
    'li',
    { class: 'citem' },
    cardImg(entryThumb(e), e.fallbackImage, { onclick: onOpen }),
    el(
      'div',
      { class: 'c-main', onclick: onOpen },
      el('div', { class: 'c-name' }, e.name),
      el('div', { class: 'c-sub' }, [e.setName, entryNumber(e)].filter(Boolean).join(' · ')),
      e.variant ? el('div', { class: 'c-sub' }, e.variant) : null,
    ),
    el(
      'div',
      { class: 'c-right' },
      el('div', { class: 'c-price' }, unit != null ? formatMoney(unit * qty) : '—'),
      qty > 1 && unit != null ? el('div', { class: 'c-sub' }, `${formatMoney(unit)} each`) : null,
      onQty
        ? el(
            'div',
            { class: 'qty' },
            el('button', { type: 'button', 'aria-label': 'Remove one', onclick: () => onQty(-1) }, '−'),
            el('span', {}, `×${qty}`),
            el('button', { type: 'button', 'aria-label': 'Add one', onclick: () => onQty(1) }, '+'),
          )
        : null,
      right,
    ),
  );
}
