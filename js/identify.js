// Photo -> ranked card matches. Used by the live scanner and by batch processing.
import { getWorker, readCard } from './ocr.js';
import { rankCandidates } from './match.js';
import { catalog, catalogReady, abbrReady } from './catalog.js';

/**
 * Read a card image and rank matching cards.
 * Returns { ranked: [{ card, set, score, reasons }], clues, debug }.
 */
export async function identify(canvas, onStatus) {
  onStatus?.('Loading text recognition…');
  await getWorker((m) => {
    if (m.status && m.progress != null && m.progress < 1 && /load|init/i.test(m.status)) {
      onStatus?.(`Preparing scanner (first time only)… ${Math.round(m.progress * 100)}%`);
    }
  });
  const { clues, debug } = await readCard(canvas, onStatus);
  onStatus?.('Matching card…');
  await catalogReady();
  if (clues.setCodes.length || clues.codeCandidates.length) await abbrReady();
  const ranked = rankCandidates(catalog.index, clues, catalog.setAbbr);
  return { ranked, clues, debug };
}
