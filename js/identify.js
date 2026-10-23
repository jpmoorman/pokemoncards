// Photo -> ranked card matches. Used by the live scanner and by batch processing.
import { getWorker, readCard, readStamps } from './ocr.js';
import { rankCandidates, findNamesInText } from './match.js';
import { catalog, catalogReady, abbrReady } from './catalog.js';
import { getCard } from './api.js';
import { variantPrices } from './prices.js';

/**
 * Read a card image (camera guide crop or a whole photo) and rank matching cards.
 * Returns { ranked: [{ card, set, score, reasons }], clues, debug, card } where
 * `card` is the straightened card canvas (null if no card was found), see ocr.readCard.
 */
export async function identify(canvas, onStatus) {
  onStatus?.('Loading text recognition…');
  const ready = catalogReady();
  ready.catch(() => {}); // reported below, after reading
  await getWorker((m) => {
    if (m.status && m.progress != null && m.progress < 1 && /load|init/i.test(m.status)) {
      onStatus?.(`Preparing scanner (first time only)… ${Math.round(m.progress * 100)}%`);
    }
  });
  // Lets the reader check names against every known card (undefined until the catalog is in).
  const findName = (text) => (catalog.index ? findNamesInText(catalog.index, text, { limit: 1 })[0] || null : undefined);
  const { clues, debug, card } = await readCard(canvas, onStatus, { findName });
  onStatus?.('Matching card…');
  await ready;
  if (clues.setCodes.length || clues.codeCandidates.length) await abbrReady();
  const ranked = rankCandidates(catalog.index, clues, catalog.setAbbr);
  // Stamps (set logo, 1st Edition, Play! Pokémon…) tell versions apart: worth an extra
  // read only when the best match comes with any.
  if (card && ranked.length && (await mayBeStamped(ranked[0].card.id))) {
    onStatus?.('Checking for stamps…');
    try {
      clues.artText = await readStamps(card);
    } catch (e) {
      console.warn('artwork read failed', e);
    }
    debug.art = clues.artText;
  }
  return { ranked, clues, debug, card };
}

/** False only when card `id` is known to have no stamped version (its prices are needed next anyway). */
async function mayBeStamped(id) {
  const details = await Promise.race([getCard(id).catch(() => null), new Promise((r) => setTimeout(r, 2500, null))]);
  return !details || variantPrices(details).some((r) => r.stamps.length);
}
