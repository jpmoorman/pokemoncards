// Photo -> ranked card matches. Used by the live scanner and by batch processing.
import { getWorker, readCard, readStamps } from './ocr.js';
import { rankCandidates, findNamesInText } from './match.js';
import { rerank, lookupIds, borderColor } from './rerank.js';
import { catalog, catalogReady, abbrReady } from './catalog.js';
import { lookupCard } from './api.js';

// The second pass looks up the details (HP, attacks, illustrator…) of the best few
// candidates. The downloads start before the artwork is read; what hasn't come this long
// after they started (or a little while after the artwork is read) is skipped: a slow or
// missing connection costs at most about half a second.
const DETAILS_WAIT = 600;
const DETAILS_WAIT_AFTER = 150; // at least, after the artwork: copies saved on the device come that fast

/**
 * Read a card image (camera guide crop or a whole photo) and rank matching cards.
 * Returns { ranked: [{ card, set, score, reasons }], clues, debug, card, border } where
 * `card` is the straightened card canvas (null if no card was found), see ocr.readCard,
 * and `border` the average colour of its edge ([r, g, b] or null).
 *   opts.stamps (default true): also read the artwork for stamps (clues.artText), which
 *     only tells versions apart and takes about a second on a phone. A live scan passes
 *     false and keeps `card`: the result sheet reads it when a card shown comes stamped.
 * Never waits long for the network beyond the card list: the best few candidates' details
 * are looked up (while the artwork is read, if it is), and skipped if they don't come in
 * time (offline).
 */
export async function identify(canvas, onStatus, { stamps = true } = {}) {
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
  // A name the dictionary found somewhere in the text counts less than one read in its place.
  if (debug.nameFrom) clues.nameFrom = debug.nameFrom;
  onStatus?.('Matching card…');
  await ready;
  if (clues.setCodes.length || clues.codeCandidates.length) await abbrReady();
  const first = rankCandidates(catalog.index, clues, catalog.setAbbr, 150);
  const border = borderColor(card);
  // Kept with what was read, so the result sheet's Re-match can run the second pass again.
  debug.border = border;
  const ctx = { index: catalog.index, getCard: lookupCard };
  // Start looking up the details the second pass will want (saved copies, else one download
  // each, none offline; the result sheet and the batch queue then ask for the best match's
  // prices: api.js shares the download), while the stamps are read.
  const asked = performance.now();
  for (const id of lookupIds(first, { clues, debug, border }, ctx)) lookupCard(id).catch(() => {});
  // Stamps (set logo, 1st Edition, Play! Pokémon…) tell versions apart. Read whatever the
  // best match is: the user may pick another match (or re-match) that has stamped versions.
  if (card && stamps) {
    onStatus?.('Checking for stamps…');
    try {
      clues.artText = await readStamps(card);
    } catch (e) {
      console.warn('artwork read failed', e);
    }
    debug.art = clues.artText;
  }
  let ranked = first;
  try {
    const left = navigator.onLine === false ? 0 : DETAILS_WAIT - (performance.now() - asked);
    ranked = await rerank(first, { clues, debug, border }, { ...ctx, timeoutMs: Math.max(DETAILS_WAIT_AFTER, left) });
  } catch (e) {
    console.warn('second pass failed', e);
  }
  return { ranked: ranked.slice(0, 40), clues, debug, card, border };
}
