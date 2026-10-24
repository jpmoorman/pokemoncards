// Printing-level scoring for the accuracy benches (tests/bench.mjs, tests/rank-eval.mjs).
// Prices depend on the printed version (1st Edition, shadowless, reverse holo, stamps…), not
// just the card, so besides "right card" the benches score "right card AND right printing":
// the version the result sheet (and the batch list) shows first for the best match, exactly
// as the app picks it (prices.variantPrices + stamps.pickVariant, with the stamps read off
// the artwork in clues.artText), against the photo's labelled version (labels.json `version`).
//
// The card's printings come from the details snapshot (catalog/details.json.gz: TCGdex's
// variants_detailed, in TCGdex's order). The snapshot has no prices, so every printing counts
// as priced: on the phone a printing with no price at all is passed over for the next one.
//
// Also the bench's dev / holdout split, by photo (the default) or by card.
import { variantPrices } from '../js/prices.js';
import { pickVariant } from '../js/stamps.js';

/** FNV-1a hash of a string, 32 bits. */
export function hash(s) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** Which half a photo id (or card id) falls in: "dev" (tune on it) or "holdout". */
export function half(id) {
  return hash(id) % 2 ? 'holdout' : 'dev';
}

/**
 * The half of a photo: by its photo id (by = 'photo', the split every number so far used), or
 * by its card's id (by = 'card'): every photo of a card then falls in the same half, so a
 * holdout card was never seen in tuning, not even in another photo. `photo` is a labels.json
 * entry ({ id, tcgdexId }) or a bench row ({ id, truth }).
 */
export function splitOf(photo, by = 'photo') {
  if (by === 'card') return half(`card:${photo.tcgdexId ?? photo.truth}`);
  if (by !== 'photo') throw new Error(`--split-by ${by}: use photo or card`);
  return half(photo.id);
}

/**
 * The card as the result sheet gets it from TCGdex (name, set, printings), from the bench's
 * catalog snapshot: { cardById, setById, details } (cards.json, sets.json and
 * details.json.gz by id). null if the snapshot doesn't have the card's printings.
 */
export function sheetCard(id, { cardById, setById, details }) {
  const c = cardById.get(id);
  const d = details[id];
  if (!c || !d) return null;
  const set = setById.get(id.slice(0, id.length - String(c.localId).length - 1));
  return {
    ...c,
    set: set && { id: set.id, name: set.name, cardCount: set.cardCount },
    // One made-up TCGplayer price each: see the note at the top.
    variants_detailed: (d.variants || []).map((v) => ({ ...v, pricing: { tcgplayer: { price: { marketPrice: 1 } } } })),
  };
}

/** The version row the app shows first for `card` (see prices.variantPrices), given what was read. */
export function chosenPrinting(card, clues) {
  if (!card) return null;
  const rows = variantPrices(card);
  if (!rows.length) return null;
  return rows[pickVariant(rows, { card, clues: clues || null }).index] || null;
}

// What a stamp the labeller only called "other-stamp" is, when their notes name it.
const STAMP_WORDS = {
  'pokemon-center': /pok[eé]mon center/i,
  'player-rewards-program': /play!? ?pok[eé]mon/i,
  'pre-release': /pre-?release/i,
  prerelease: /pre-?release/i,
  staff: /\bstaff\b/i,
  gamestop: /game ?stop/i,
  'eb-games': /\beb games\b/i,
  '25th-celebration': /25th/i,
};
const hasStamp = (r, s) => (r.stamps || []).includes(s);
const plainHolo = (r) => !r.stamps.length && !r.foil;

/**
 * Which printings a labelled version names, as a test on a version row (prices.variantPrices),
 * or null when the version says nothing about the printing ("unknown", "other", or
 * "full-art/special": that is in the card id).
 */
export function versionTest(version, notes = '') {
  switch (version) {
    case '1st-edition':
      return (r) => hasStamp(r, '1st-edition');
    case 'shadowless':
      return (r) => r.subtypeRaw === 'shadowless' && !hasStamp(r, '1st-edition');
    case 'reverse-holo':
      return (r) => r.type === 'reverse' && !r.stamps.length;
    case 'holo':
      return (r) => r.type === 'holo' && plainHolo(r) && r.subtypeRaw !== 'shadowless';
    case 'unlimited': // not 1st Edition, not shadowless (Wizards of the Coast sets)
      return (r) => r.type !== 'reverse' && plainHolo(r) && r.subtypeRaw !== 'shadowless';
    case 'normal':
      return (r) => r.type === 'normal' && plainHolo(r);
    case 'cosmos-holo':
      return (r) => r.foil === 'cosmos' && !r.stamps.length;
    case 'set-logo-stamp':
      return (r) => hasStamp(r, 'set-logo') && r.stamps.length === 1;
    case 'other-stamp': {
      const named = Object.keys(STAMP_WORDS).filter((s) => STAMP_WORDS[s].test(notes));
      const other = (r) => r.stamps.some((s) => s !== '1st-edition' && s !== 'set-logo');
      return named.length ? (r) => other(r) && named.some((s) => hasStamp(r, s)) : other;
    }
    default:
      return null;
  }
}

/** Version rows of a card, each with its TCGdex subtype kept (variantPrices only folds it into the label). */
function rowsOf(card) {
  const rows = variantPrices(card);
  // variantPrices keeps TCGdex's order (standard sizes first, then jumbo): match rows back by label and type.
  const detailed = card.variants_detailed || [];
  return rows.map((r) => {
    const i = +String(r.id).split('-').pop();
    return { ...r, subtypeRaw: detailed[i]?.subtype || null };
  });
}

/**
 * The printings of the true card that the photo's label names: { rows: [version row ids] }
 * for a specific label, { implied: true } when the card has a single standard printing (the
 * card is the printing, whatever the label calls it), or { why } when the label can't be
 * scored: it doesn't name a printing, the two labellers disagree, or TCGdex doesn't list
 * the printing it names.
 *   label: a labels.json entry ({ version, versionAgreed, versionAlt, notes })
 */
export function wantedPrinting(card, label) {
  if (!card) return { why: 'no printings in the snapshot' };
  const rows = rowsOf(card).filter((r) => r.size === 'standard');
  if (rows.length === 1) return { implied: true };
  const versions = [label.version];
  if (label.versionAgreed === false) {
    // The second labeller couldn't tell, or said nothing: not specific enough.
    if (!label.versionAlt || [label.version, label.versionAlt].some((v) => v === 'unknown' || v === 'other')) return { why: 'labellers disagree' };
    versions.push(label.versionAlt);
  }
  // Each version that names printings TCGdex has; two that disagree can't be scored.
  const named = versions
    .map((v) => versionTest(v, label.notes))
    .filter(Boolean)
    .map((test) => rows.filter(test).map((r) => r.id))
    .filter((ids) => ids.length);
  if (!named.length) return { why: versions.some((v) => versionTest(v)) ? 'printing not in TCGdex' : 'label names no printing' };
  if (named.some((ids) => ids.join() !== named[0].join())) return { why: 'labellers disagree' };
  return { rows: named[0] };
}

/**
 * Score one scan's printing. `top` is the best match's card id, `card` the true card (see
 * sheetCard), `clues` what was read (clues.artText: the stamp read). Returns
 *   { ok: true | false | null, printing: label shown first (for the best match, if the right
 *     card), wanted: [labels the photo's version allows], why }
 * ok is null when the label can't be scored (see wantedPrinting), false for the wrong card.
 */
export function scorePrinting(top, card, clues, label) {
  const want = wantedPrinting(card, label);
  if (want.why) return { ok: null, printing: null, wanted: [], why: want.why };
  const rows = rowsOf(card);
  const wanted = want.implied ? [] : rows.filter((r) => want.rows.includes(r.id)).map((r) => r.label);
  if (top !== card.id) return { ok: false, printing: null, wanted, why: 'wrong card' };
  const shown = chosenPrinting(card, clues);
  if (want.implied) return { ok: true, printing: shown?.label ?? null, wanted, why: 'one printing' };
  return { ok: !!shown && want.rows.includes(shown.id), printing: shown?.label ?? null, wanted, why: '' };
}

/**
 * Printing scores of many scans, overall and per labelled version:
 * { all: { photos, scored, card, printing }, byVersion: { version: {...same} } } where
 * `scored` counts photos whose label could be scored, `card` those with the right card among
 * them and `printing` those with the right card and printing. `scans` are { version, score }.
 */
export function printingSummary(scans) {
  const blank = () => ({ photos: 0, scored: 0, card: 0, printing: 0, choice: 0, choiceRight: 0 });
  const all = blank();
  const byVersion = {};
  for (const { version, score } of scans) {
    for (const g of [all, (byVersion[version] ||= blank())]) {
      g.photos++;
      if (score.ok == null) continue;
      g.scored++;
      if (score.why !== 'wrong card') g.card++;
      if (score.ok) g.printing++;
      // Right card, and a card printed more than one way: the version pick mattered.
      if (score.why === '') {
        g.choice++;
        if (score.ok) g.choiceRight++;
      }
    }
  }
  return { all, byVersion };
}

/** One line per version for a console report. */
export function printingReport({ all, byVersion }, indent = '  ') {
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');
  const line = (k, g) =>
    `${indent}${k.padEnd(26)} ${String(g.photos).padStart(4)} photos  scored ${String(g.scored).padStart(4)}  right card ${String(g.card).padStart(4)}  ` +
    `right card + printing ${String(g.printing).padStart(4)} (${pct(g.printing, g.scored).padStart(6)})  version picked right ${g.choiceRight}/${g.choice}`;
  return [line('all', all), ...Object.entries(byVersion).sort((a, b) => b[1].photos - a[1].photos).map(([k, g]) => line(k, g))].join('\n');
}
