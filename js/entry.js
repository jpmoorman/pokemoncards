// One saved card (collection, trade or batch result). Same shape everywhere:
// { id, name, setId, setName, number, variant, variantId, image, fallbackImage, price, qty, added }
//   number  - as printed, "024/088"
//   variant - version label, "Set Logo Stamp"; variantId - row id from prices.variantPrices
//   price   - { value, currency: 'USD', source, converted, original? } (older saves may be EUR)
import { getCard } from './api.js';
import { variantPrices, headlinePrice, printedNumber, variantImage, priceInUsd, eurToUsd } from './prices.js';
import { fx } from './fx.js';

export function makeEntry(card, row) {
  const img = variantImage(card, row);
  return {
    id: card.id,
    name: card.name,
    setId: card.set?.id || '',
    setName: card.set?.name || '',
    number: printedNumber(card),
    variant: row?.label || '',
    variantId: row?.id || '',
    image: img?.src || '',
    fallbackImage: card.image ? `${card.image}/low.webp` : '',
    price: headlinePrice(row, fx().rate),
    qty: 1,
    added: Date.now(),
  };
}

/** Key that identifies "the same card in the same version". */
export function entryKey(e) {
  return `${e.id}|${e.variantId || e.variant || ''}`;
}

/** Find the version row an entry refers to. */
export function findRow(rows, entry) {
  return rows.find((r) => entry.variantId && r.id === entry.variantId) || rows.find((r) => r.label === entry.variant) || rows[0] || null;
}

/** Re-fetch prices for an entry. Returns a new entry object (unchanged on failure). */
export async function refreshEntry(entry) {
  try {
    const card = await getCard(entry.id);
    if (!card) return entry;
    const row = findRow(variantPrices(card), entry);
    return { ...entry, price: headlinePrice(row, fx().rate) || entry.price };
  } catch {
    return entry;
  }
}

/** Unit price in USD (converts prices saved in EUR by older versions). */
export function unitUsd(entry) {
  const p = entry.price;
  // Converted from euros: recompute with today's rate rather than the rate on the day it was saved.
  if (p?.converted && p.original?.currency === 'EUR') return eurToUsd(p.original.value, fx().rate);
  return priceInUsd(p, fx().rate);
}

export function totalUsd(entries) {
  return entries.reduce((s, e) => s + (unitUsd(e) || 0) * (e.qty || 1), 0);
}

/** Display number, also for entries saved before numbers were stored as printed. */
export function entryNumber(e) {
  if (String(e.number || '').includes('/') || !e.official) return e.number || '';
  return printedNumber({ localId: e.number, official: e.official });
}

/** Thumbnail URL, also for entries saved before full image URLs were stored. */
export function entryThumb(e) {
  const img = e.image || '';
  if (img && /^https:\/\/assets\.tcgdex\.net\//.test(img) && !/\.(webp|png|jpg)$/.test(img)) return `${img}/low.webp`;
  return img || e.fallbackImage || '';
}
