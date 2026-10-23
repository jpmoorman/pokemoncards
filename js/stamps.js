// Picks which printed version (normal / reverse / stamped / 1st Edition …) a scanned card is.
// Stamps are read from the artwork (ocr.js puts that text in clues.artText). Holo vs reverse
// holo vs cosmos holo can't be told from text, so those are never guessed.

// What each TCGdex stamp says on the card: `words` are read as one word, `phrases` may be
// split over lines. Stamp text is printed in capitals; card text (attacks, "Evolves from",
// the Pokédex line) is mixed case, which keeps it from matching.
const STAMP_TEXT = [
  { stamp: '1st-edition', label: '1st Edition', words: ['EDITION'] },
  { stamp: 'prerelease', label: 'Prerelease', words: ['PRERELEASE'], phrases: ['PRE RELEASE'] },
  { stamp: 'staff', label: 'Staff', words: ['STAFF'] },
  { stamp: 'pokemon-center', label: 'Pokémon Center', phrases: ['POKEMON CENTER'] },
  { stamp: 'player-rewards-program', label: 'Play! Pokémon', phrases: ['PLAY! POKEMON'] },
];

// OCR mixes these up inside capital words.
const DIGIT_AS_LETTER = { 0: 'O', 1: 'I', 5: 'S', 8: 'B' };
const plain = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const squash = (s) => plain(s).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/[0158]/g, (d) => DIGIT_AS_LETTER[d]);
// Stamp ids are compared loosely ("prerelease" / "pre-release").
const stampKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Edits allowed when reading stylized logo text ("PERFECT DRDER", "PERFFCT ORDER"). */
function maxEdits(len) {
  return len >= 10 ? Math.floor(len / 4) : len >= 7 ? 1 : 0;
}

/** Mostly capitals, like stamp text (OCR sometimes lower-cases a letter). */
function inCapitals(s) {
  const upper = (s.match(/[A-Z]/g) || []).length;
  const lower = (s.match(/[a-z]/g) || []).length;
  return upper >= 3 && upper >= (upper + lower) * 0.7;
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), prev[j] + 1, cur[j - 1] + 1));
    prev = cur;
  }
  return prev[b.length];
}

/** A word of OCR `text` that reads as `word` (in capitals, up to `allowed` letters off). Returns { edits, read } or null. */
export function findWord(text, word, allowed = maxEdits(squash(word).length)) {
  const want = squash(word);
  if (want.length < 5) return null;
  let best = null;
  for (const token of plain(text).split(/[^A-Za-z0-9]+/)) {
    if (Math.abs(token.length - want.length) > allowed || !inCapitals(token)) continue;
    const edits = editDistance(squash(token), want);
    if (edits <= allowed && (!best || edits < best.edits)) best = { edits, read: token };
  }
  return best;
}

/**
 * Where `phrase` appears in OCR `text`, allowing a few wrong, missing or extra letters;
 * spaces and line breaks are ignored ("PERFECT\nDRDER"). Returns { edits, read } or null.
 */
export function findPhrase(text, phrase) {
  const want = squash(phrase);
  const allowed = maxEdits(want.length);
  if (want.length < 5) return null;
  const src = plain(text);
  const chars = [];
  for (let k = 0; k < src.length; k++) {
    const c = squash(src[k]);
    if (c) chars.push({ c, k });
  }
  // Semi-global edit distance: the phrase may start and end anywhere in the text.
  const m = want.length;
  let prev = Array.from({ length: m + 1 }, (_, i) => i);
  let prevStart = new Array(m + 1).fill(0);
  let best = null;
  for (let j = 1; j <= chars.length; j++) {
    const cur = [0];
    const curStart = [j];
    for (let i = 1; i <= m; i++) {
      let d = prev[i - 1] + (want[i - 1] === chars[j - 1].c ? 0 : 1);
      let s = prevStart[i - 1];
      if (prev[i] + 1 < d) [d, s] = [prev[i] + 1, prevStart[i]];
      if (cur[i - 1] + 1 < d) [d, s] = [cur[i - 1] + 1, curStart[i - 1]];
      cur.push(d);
      curStart.push(s);
    }
    if (cur[m] <= allowed && (!best || cur[m] < best.edits)) {
      const span = src.slice(chars[curStart[m]].k, chars[j - 1].k + 1);
      if (inCapitals(span)) best = { edits: cur[m], read: span.replace(/\s+/g, ' ').trim() };
    }
    prev = cur;
    prevStart = curStart;
  }
  return best;
}

/** Set-logo stamps print the card's set name ("MEGA EVOLUTION / PERFECT ORDER"). */
function setLogoRule(card) {
  const name = card?.set?.name;
  if (!name || squash(name).length < 6) return null;
  const words = plain(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 1) return { stamp: 'set-logo', label: `${name} set logo`, words };
  // The whole name, or one long word of it read cleanly: the rest of a logo often reads as
  // junk ("PERFECT" + "DER"), and capitals like these don't otherwise appear on the art.
  const long = words.filter((w) => w.length >= 7).map((w) => ({ word: w, allowed: w.length >= 9 ? 1 : 0 }));
  return { stamp: 'set-logo', label: `${name} set logo`, phrases: [name], words: long };
}

/** Stamps whose text was read on the artwork: [{ stamp, label, read }], best evidence first. */
export function findStamps(artText, card) {
  if (!artText) return [];
  const rules = [...STAMP_TEXT, setLogoRule(card)].filter(Boolean);
  const found = [];
  for (const r of rules) {
    const hits = [
      ...(r.phrases || []).map((p) => findPhrase(artText, p)),
      ...(r.words || []).map((w) => (typeof w === 'string' ? findWord(artText, w) : findWord(artText, w.word, w.allowed))),
    ].filter(Boolean);
    // The whole phrase, when read, is the fuller evidence to show.
    if (hits.length) found.push({ stamp: r.stamp, label: r.label, read: hits[0].read, edits: hits[0].edits });
  }
  return found.sort((a, b) => a.edits - b.edits).map(({ edits, ...f }) => f);
}

/** Stamp ids read on the artwork, e.g. ['set-logo']. */
export function detectStamps(artText, card) {
  return findStamps(artText, card).map((f) => f.stamp);
}

const firstIndex = (rows, tests) => {
  for (const t of tests) {
    const i = rows.findIndex(t);
    if (i >= 0) return i;
  }
  return -1;
};
const standard = (r) => r.size === 'standard';
const priced = (r) => !!(r.tcg || r.cm);
const stamped = (r) => !!r.stamps?.length;
const hasStamp = (r, s) => (r.stamps || []).some((x) => stampKey(x) === stampKey(s));

/**
 * Which version row to show first, and why.
 *   rows      - from prices.variantPrices(card)
 *   card      - full TCGdex card
 *   clues     - OCR clues from ocr.readCard (null when opened from search/collection)
 *   preferred - a saved entry's variantId or label to restore
 * Returns { index, stamps: [{ stamp, label, read }], reason } where reason is a sentence
 * for the user (a stamp was spotted, or other stamped versions exist) or null.
 */
export function pickVariant(rows, { card, clues, preferred } = {}) {
  if (!rows.length) return { index: 0, stamps: [], reason: null };
  const auto = autoPick(rows, card, clues);
  if (preferred) {
    const i = rows.findIndex((r) => r.id === preferred || r.label === preferred);
    // Keep the scanner's explanation only when the saved version is the one it picked.
    if (i >= 0) return i === auto.index && clues ? auto : { index: i, stamps: [], reason: null };
  }
  return auto;
}

function autoPick(rows, card, clues) {
  // Only stamps this card is actually printed with count.
  const stamps = findStamps(clues?.artText, card).filter((f) => rows.some((r) => hasStamp(r, f.stamp)));
  if (stamps.length) {
    const score = (r) => stamps.filter((f) => hasStamp(r, f.stamp)).length;
    const top = Math.max(...rows.map(score));
    const index = firstIndex(rows, [(r) => score(r) === top && standard(r) && priced(r), (r) => score(r) === top && standard(r), (r) => score(r) === top]);
    const what = stamps.filter((f) => hasStamp(rows[index], f.stamp)).map((f) => f.label);
    const seen = what.length > 1 ? `${what.join(' and ')} stamps` : `a ${what[0]} stamp`;
    return { index, stamps, reason: `Spotted ${seen} on the card, so this is the ${rows[index].label} version. Wrong? Tap another version.` };
  }
  // No stamp seen: the plain version (first standard-size one with a price).
  let index = firstIndex(rows, [(r) => standard(r) && priced(r) && !stamped(r), (r) => standard(r) && priced(r), (r) => standard(r) && !stamped(r)]);
  if (index < 0) index = 0;
  const others = [...new Set(rows.filter((r, i) => i !== index && standard(r) && stamped(r)).map((r) => r.label))];
  if (!others.length || stamped(rows[index])) return { index, stamps: [], reason: null };
  return { index, stamps: [], reason: `This card also comes as ${others.join(', ')}. If yours has a stamp or logo on it, tap that version: prices can differ a lot.` };
}

/** Index of the version row to show first (see pickVariant). */
export function chooseVariant(rows, opts = {}) {
  return pickVariant(rows, opts).index;
}
