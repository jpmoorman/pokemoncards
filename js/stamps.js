// Picks which printed version (normal / reverse / stamped / 1st Edition …) a scanned card is.

/**
 * Index of the version row to show first.
 *   rows      - from prices.variantPrices(card)
 *   card      - full TCGdex card
 *   clues     - OCR clues from ocr.readCard (may be null when opened from search/collection)
 *   preferred - a saved entry's variantId or label to restore
 */
export function chooseVariant(rows, { card, clues, preferred } = {}) {
  if (!rows.length) return 0;
  if (preferred) {
    const i = rows.findIndex((r) => r.id === preferred || r.label === preferred);
    if (i >= 0) return i;
  }
  // Default: first standard-size version that has a price.
  const priced = rows.findIndex((r) => r.size === 'standard' && (r.tcg || r.cm));
  return priced >= 0 ? priced : 0;
}
