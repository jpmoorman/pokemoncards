// Second ranking pass. The first pass (match.js) only uses the name, number, set size and
// set code, so a card read without its number ties with every other printing of its name.
// This pass re-scores the best candidates with everything else the camera saw:
//  - hints that need no download: the border colour (yellow until Sword & Shield, silver
//    from Scarlet & Violet), the copyright year, wording used in one era only ("Wizards",
//    "Pokémon Power", "Poké-Body", "Ability", "LV. 76 #6") and the rule box ("Pokémon ex
//    rule", "TAG TEAM rule": OCR often loses the name's "ex"/"V"/"GX" logo);
//  - for the best few candidates, the card's own details: HP, attack and ability names,
//    illustrator, regulation mark and trainer text, looked up in everything OCR read.
// The functions are pure: the app feeds it details from api.getCard (see identify.js), the
// offline scorer (tests/rank-eval.mjs) from a catalog snapshot, so both run the same code.
import { normalize } from './parse.js';
import { dice, editDistance, nameMarks, REPRINT_SETS } from './match.js';

/** Weights, in the same units as match.js scores (a name read right is worth 5). */
export const W = {
  // no download needed
  yellowNew: 2, // yellow border, card from Scarlet & Violet on (silver borders)
  silverOld: 0.3, // silver/grey border, regular card from before (holders and sleeves look grey too)
  yearOff: 2, // copyright year printed later than the card came out
  yearEarly: 0.6, // copyright year well before the card came out (reprints keep the old one)
  yearOk: 0.3,
  eraWord: 1.5, // "Wizards", "Pokémon Power", "Poké-Body", "Ability" printed outside its era
  reprintWizards: 2, // "Wizards" read: not a reprint collection's copy (they print no Wizards copyright)
  fetchGap: 2.5, // only look up candidates within this much of the best
  rule: 1.5, // rule box read ("Pokémon ex rule", "TAG TEAM rule"…): the name has that mark
  prizes: 0.7, // "your opponent takes 2 Prize cards": some marked (rule box) Pokémon
  // details of the best few
  hpExact: 1.5, // "120 HP" read, and the card has 120 HP
  hpWrong: 1, // "120 HP" read, the card has another HP
  hpLoose: 0.5, // a bare "120" in the name area
  attack: 1.2, // per attack/ability name found (fuzzy)
  attackMax: 2.4,
  phraseMin: 0.75, // how alike (0..1) a phrase must be to count as found
  illus: 1,
  effect: 1,
  regMark: 0.7,
  fullArtGrey: 0.3,
};

// ---------- what was read ----------

/** First year each set came out in; every set after it in catalog (release) order shares the year. */
const YEAR_STARTS = [
  ['base1', 1999], ['base4', 2000], ['neo2', 2001], ['neo4', 2002], ['ecard2', 2003], ['ex4', 2004],
  ['ex8', 2005], ['ex12', 2006], ['ex16', 2007], ['dp4', 2008], ['pl1', 2009], ['hgss1', 2010],
  ['col1', 2011], ['bw4', 2012], ['bw8', 2013], ['xy0', 2013], ['xy1', 2014], ['xy5', 2015], ['xy9', 2016],
  ['sm1', 2017], ['sm5', 2018], ['sm9', 2019], ['swsh1', 2020], ['swsh4.5', 2021], ['swsh9', 2022],
  ['swsh12.5', 2023], ['sv01', 2023], ['sv04.5', 2024], ['sv08.5', 2025], ['me02.5', 2026],
];
// Promo series and reprint collections span several years (reprints keep the old copyright).
const YEAR_SPANS = {
  basep: [1999, 2003], np: [2003, 2007], dpp: [2007, 2010], hgssp: [2010, 2011], bwp: [2011, 2013],
  xyp: [2013, 2016], smp: [2016, 2019], swshp: [2019, 2023], svp: [2023, 2025], mep: [2025, 2027],
  cel25cc: [1999, 2021], '30th-c': [1999, 2026],
};

const spans = new WeakMap();
/** Map setId -> [first year, last year] its cards can print, from the index's set order. */
export function setYears(index) {
  let m = spans.get(index);
  if (m) return m;
  m = new Map();
  const starts = new Map(YEAR_STARTS);
  let year = null;
  for (const s of [...index.setsById.values()].sort((a, b) => a.order - b.order)) {
    if (starts.has(s.id)) year = starts.get(s.id);
    if (YEAR_SPANS[s.id]) m.set(s.id, YEAR_SPANS[s.id]);
    else if (year) m.set(s.id, [year, year]);
  }
  spans.set(index, m);
  return m;
}

const SV_FIRST = 'sv01';
// Reprints of vintage cards, printed with the old yellow border.
const CLASSIC = new Set(Object.keys(REPRINT_SETS));

/** The set a card looks like it's from: a reprint-collection card's original (match.REPRINTS). */
const printedSet = (card) => card.printed?.setId || card.setId;

/** Is the set from Scarlet & Violet on (silver borders)? */
function isModern(setId, index) {
  if (CLASSIC.has(setId)) return false;
  const set = index.setsById.get(setId);
  const sv = index.setsById.get(SV_FIRST);
  return set && sv ? set.order >= sv.order : false;
}

/**
 * Border colour class from the average [r, g, b] of the card's outer edge:
 * 'yellow' (regular cards up to Sword & Shield), 'silver' (Scarlet & Violet on, many
 * full-art cards, or a grey holder) or null.
 */
export function borderClass(rgb) {
  if (!rgb || rgb.length < 3) return null;
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max ? (max - min) / max : 0;
  if (max < 60) return null; // too dark to tell (black sleeve, shadow)
  let hue = 0;
  if (max !== min) {
    if (max === r) hue = (((g - b) / (max - min)) % 6) * 60;
    else if (max === g) hue = ((b - r) / (max - min) + 2) * 60;
    else hue = ((r - g) / (max - min) + 4) * 60;
    if (hue < 0) hue += 360;
  }
  if (sat >= 0.38 && hue >= 30 && hue <= 62) return 'yellow';
  if (sat <= 0.15) return 'silver';
  return null;
}

/**
 * Average colour of the outer edge of a card canvas (3/63 of its width all round), as
 * [r, g, b], or null. Browser only (needs a canvas).
 */
export function borderColor(card) {
  if (!card?.width || typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 63;
  c.height = 88;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(card, 0, 0, 63, 88);
  const px = g.getImageData(0, 0, 63, 88).data;
  let r = 0;
  let gg = 0;
  let b = 0;
  let n = 0;
  for (let y = 0; y < 88; y++) {
    for (let x = 0; x < 63; x++) {
      if (!(x < 3 || x > 59 || y < 3 || y > 84)) continue;
      const i = (y * 63 + x) * 4;
      r += px[i];
      gg += px[i + 1];
      b += px[i + 2];
      n++;
    }
  }
  return [Math.round(r / n), Math.round(gg / n), Math.round(b / n)];
}

const LAST_YEAR = new Date().getFullYear() + 1;

/** Copyright year printed on the card (the latest year in a "©… Nintendo/Pokémon/Wizards" line), or null. */
export function copyrightYear(text) {
  let best = null;
  for (const line of String(text || '').split('\n')) {
    if (!/nint|pok[eé]mon\s*\/|wizar|creat|game\s?fr|©/i.test(line)) continue;
    // "©1995, 96, 98 Nintendo", "©1995-2000 Nintendo", "©2023 Pokémon / Nintendo".
    for (const m of line.matchAll(/(?<!\d)((?:19|20)\d\d)((?:\s*[,.\-]\s*(?:\d\d|(?:19|20)\d\d)(?!\d))*)/g)) {
      const y = +m[1];
      if (y < 1995 || y > LAST_YEAR) continue;
      let top = y;
      for (const t of m[2].matchAll(/\d+/g)) {
        const v = t[0].length === 2 ? 1900 + +t[0] + (+t[0] < 50 ? 100 : 0) : +t[0];
        if (v > top && v <= LAST_YEAR && v - y <= 10) top = v;
      }
      if (!best || top > best) best = top;
    }
  }
  return best;
}

// Wording used in one era only: [pattern on normalized text, first year, last year].
const ERA_WORDS = [
  [/\bwizards\b/, 1999, 2003],
  [/\bpokemon power\b/, 1999, 2002],
  [/\bpoke (?:power|body)\b/, 2002, 2011],
  [/\bability\b/, 2011, 2100],
  [/\bdelta species\b/, 2005, 2007],
  [/\blv ?\d{1,3} \d{1,3}\b/, 1999, 2003], // "LV. 76 #6" (level and Pokédex number) in the flavor-text box
];

// Rule boxes and what they say about the name's marks (see match.nameMarks), on normalized text.
const RULES = [
  [/\bpokemon [eo€]?x rule\b|\b[eo]x rule\b|\bpokemon ex has been\b/, ['ex']],
  [/\bgx rule\b|\bpokemon gx\b/, ['gx']],
  [/\btag team\b|\bteam rule\b/, ['&']],
  [/\bvmax rule\b/, ['vmax']],
  [/\bvstar rule\b/, ['vstar']],
  [/\bv union\b/, ['v-union']],
  [/\bpokemon v (?:is|rule)\b|\bv ?rule\b/, ['v']],
  [/\bdelta species\b/, ['δ']],
];
// Marks whose Pokémon give up 2 or 3 Prize cards ("Mega … ex" gives 3, a TAG TEAM 3).
const PRIZE_MARKS = {
  2: ['ex', 'gx', 'v', 'vstar', 'legend', 'm'],
  3: ['vmax', '&', 'ex', 'v-union'],
};

/** Everything the reranker uses from one read, computed once per scan. */
export function readFeatures(read) {
  const clues = read?.clues || {};
  const debug = read?.debug || {};
  const nameText = [clues.nameBest, clues.nameAll, debug.name].filter(Boolean).join('\n');
  const full = debug.full || '';
  // The top third of a whole-card read is where the name and HP are.
  const fullTop = full.split('\n').slice(0, Math.ceil(full.split('\n').length / 3)).join('\n');
  const all = [nameText, debug.bottom, full, debug.art || clues.artText].filter(Boolean).join('\n');
  const hpExact = new Set();
  const hpLoose = new Set();
  const hpPart = new Set();
  for (const t of [nameText, fullTop]) {
    for (const m of t.matchAll(/(?<!\d)(\d{2,3})\s*HP|HP\s*(\d{2,3})(?!\d)/gi)) {
      const v = m[1] || m[2];
      // HP is a multiple of 10 from 30 up; anything else is a digit lost or misread ("33" for 330).
      if (+v % 10 === 0 && +v >= 30) hpExact.add(+v);
      else hpPart.add(v);
    }
    for (const m of t.matchAll(/(?<![\d/])(\d{2,3})(?![\d/])/g)) if (+m[1] % 10 === 0 && +m[1] >= 30 && +m[1] <= 400) hpLoose.add(+m[1]);
  }
  const words = normalize(all);
  const eras = ERA_WORDS.filter(([re]) => re.test(words)).map(([, a, b]) => [a, b]);
  // "©1999 Wizards." (also read "Wiards", "Wizaros"…): a card printed by Wizards of the Coast.
  const wizards = words.split(' ').some((w) => w[0] === 'w' && w.length >= 6 && w.length <= 8 && editDistance(w, 'wizards', 1) <= 1);
  // Regulation mark: one capital letter right before the set code ("G MEW EN").
  const reg = /(?:^|\s)([D-K])\s+[A-Z0-9]{3}\s*EN\b/.exec(debug.bottom || '');
  const marks = new Set(RULES.filter(([re]) => re.test(words)).flatMap(([, m]) => m));
  const prizes = /\btakes ([23]) prize/.exec(words);
  return {
    words: words.split(' ').filter(Boolean),
    marks,
    prizes: prizes ? +prizes[1] : 0,
    phraseCache: new Map(),
    hpExact,
    hpLoose,
    hpPart,
    year: copyrightYear(`${debug.bottom || ''}\n${full}`),
    eras,
    wizards,
    regMark: reg ? reg[1] : null,
    border: borderClass(read?.border),
  };
}

const compact = (s) => normalize(s).replace(/ /g, '');

/**
 * How well a phrase (attack name, illustrator…) appears among the words read, 0..1.
 * Compares it with every run of words of about its length, so OCR noise elsewhere
 * doesn't matter. Short phrases must appear exactly.
 */
export function phraseScore(f, phrase) {
  const key = compact(phrase);
  if (key.length < 4) return 0;
  if (f.phraseCache.has(key)) return f.phraseCache.get(key);
  const k = normalize(phrase).split(' ').length;
  let best = 0;
  const { words } = f;
  for (let i = 0; i < words.length && best < 1; i++) {
    let win = '';
    for (let w = 1; w <= k + 1 && i + w <= words.length; w++) {
      win += words[i + w - 1];
      if (w < k - 1) continue;
      if (win.length > key.length + 3) break;
      if (win.length < key.length - 3) continue;
      let s = win === key ? 1 : dice(key, win);
      if (s < 1 && key.length >= 6) {
        const e = editDistance(key, win, 2);
        if (e <= 2) s = Math.max(s, 1 - e / key.length);
      }
      if (key.length < 6 && s < 1) s = 0;
      if (s > best) best = s;
    }
  }
  f.phraseCache.set(key, best);
  return best;
}

// ---------- card details ----------

/**
 * The details this pass uses, from either a TCGdex card (api.getCard: attacks [{ name }])
 * or the compact catalog snapshot (attacks ['name']):
 * { hp, stage, attacks: [name], abilities: [name], illustrator, rarity, regulationMark, effect }.
 */
export function cardDetails(card) {
  if (!card) return null;
  const names = (list) => (list || []).map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean);
  const clean = (s) => (s && s !== 'null' && s !== 'None' ? String(s) : '');
  return {
    hp: +card.hp || null,
    stage: clean(card.stage),
    attacks: names(card.attacks),
    abilities: names(card.abilities),
    illustrator: clean(card.illustrator),
    rarity: clean(card.rarity),
    regulationMark: clean(card.regulationMark).toUpperCase(),
    effect: clean(card.effect),
  };
}

const FULL_ART = /ultra|secret|illustration|hyper|shiny|full art|gallery|amazing|radiant/i;

/**
 * Score from a card's details against what was read: { score, reasons }.
 * modern: the card is from Scarlet & Violet on (silver borders).
 */
export function detailScore(f, d, modern = false) {
  let score = 0;
  const reasons = [];
  if (!d) return { score, reasons };
  const part = d.hp && [...f.hpPart].some((v) => String(d.hp).startsWith(v) || String(d.hp).endsWith(v));
  if (d.hp && f.hpExact.size && !part) {
    if (f.hpExact.has(d.hp)) {
      score += W.hpExact;
      reasons.push(`HP ${d.hp}`);
    } else if (!f.hpLoose.has(d.hp)) score -= W.hpWrong;
  } else if (d.hp && (f.hpLoose.has(d.hp) || part)) {
    score += W.hpLoose;
    reasons.push(`HP ${d.hp}?`);
  }
  let atk = 0;
  for (const name of [...d.attacks, ...d.abilities]) {
    const s = phraseScore(f, name);
    if (s >= W.phraseMin) {
      atk += W.attack * Math.min(1, (s - 0.6) / 0.4);
      reasons.push(name);
    }
  }
  score += Math.min(atk, W.attackMax);
  if (d.illustrator) {
    const s = phraseScore(f, d.illustrator);
    if (s >= W.phraseMin) {
      score += W.illus * Math.min(1, (s - 0.6) / 0.4);
      reasons.push(`illus. ${d.illustrator}`);
    }
  }
  if (d.effect) {
    const s = phraseScore(f, d.effect.split(/[.!]/)[0].slice(0, 60));
    if (s >= 0.7) {
      score += W.effect * s;
      reasons.push('trainer text');
    }
  }
  if (f.regMark && d.regulationMark) score += f.regMark === d.regulationMark ? W.regMark : -W.regMark / 2;
  // Full-art cards from before Scarlet & Violet often have a silver border too.
  if (f.border === 'silver' && !modern && FULL_ART.test(d.rarity)) score += W.fullArtGrey;
  // Gold "hyper rare" cards from Scarlet & Violet on look yellow: take back the border penalty.
  if (f.border === 'yellow' && modern && /hyper/i.test(d.rarity)) score += W.yellowNew;
  return { score, reasons };
}

/**
 * Score from hints that need no download (border, copyright year, era wording, rule box)
 * for a card { setId, name } of the index: { score, reasons }.
 */
export function hintScore(f, card, index) {
  let score = 0;
  const reasons = [];
  // A reprint-collection card copies its original, copyright and border included.
  const setId = printedSet(card);
  if (f.marks.size || f.prizes) {
    const marks = nameMarks(card.name);
    if (f.marks.size) {
      const hit = marks.some((m) => f.marks.has(m));
      score += hit ? W.rule : -W.rule;
      if (hit) reasons.push('rule box');
    } else {
      score += marks.some((m) => PRIZE_MARKS[f.prizes].includes(m)) ? W.prizes : -W.prizes;
    }
  }
  const modern = isModern(setId, index);
  if (f.border === 'yellow') {
    if (modern) score -= W.yellowNew;
  } else if (f.border === 'silver') {
    if (!modern) score -= W.silverOld;
  }
  const span = setYears(index).get(setId);
  if (span && f.year) {
    if (f.year > span[1] + 1) score -= W.yearOff;
    else if (f.year < span[0] - 1) score -= W.yearEarly;
    else {
      score += W.yearOk;
      reasons.push(`© ${f.year}`);
    }
  }
  if (span) {
    for (const [a, b] of f.eras) if (span[1] < a - 1 || span[0] > b + 1) score -= W.eraWord;
  }
  // The reprint collections copy Wizards-era cards without the "©… Wizards" line.
  if (f.wizards && CLASSIC.has(card.setId)) score -= W.reprintWizards;
  return { score, reasons };
}

/** Hint-only order (no details), best first, as rerank starts from. */
function withHints(ranked, f, index) {
  return sortRanked(
    ranked.map((r) => {
      const h = index ? hintScore(f, r.card, index) : { score: 0, reasons: [] };
      return { ...r, base: r.score, score: r.score + h.score, reasons: [...r.reasons, ...h.reasons] };
    }),
  );
}

/** The candidates worth looking up: the best few, and only those close enough to the best for their details to matter. */
function pick(list, max) {
  return list
    .slice(0, max)
    .filter((r) => r.score >= list[0].score - W.fetchGap)
    .map((r) => r.card.id);
}

/**
 * Ids of the cards rerank will want details for, so a caller can start downloading them
 * early (while other work runs). Same arguments as rerank.
 */
export function lookupIds(ranked, read, ctx = {}) {
  if (!ranked?.length) return [];
  return pick(withHints(ranked, readFeatures(read), ctx.index), ctx.fetch ?? FETCH);
}

const FETCH = 10;

/**
 * Re-rank first-pass results (match.rankCandidates) with what else was read.
 * read: { clues, debug: { name, bottom, full, art }, border: [r, g, b] }
 * ctx: { index, getCard?: (id) => card | Promise<card> (TCGdex card or snapshot details),
 *        fetch?: how many candidates to look up at most (default 10),
 *        timeoutMs?: how long to wait for the details (default: no limit) }
 * Returns a new list, best first, each with { base: first-pass score, hinted: score without
 * details, unchecked: true if its details were wanted but didn't come }. Works without any
 * details (offline): then only the border, copyright and wording hints count; a card whose
 * details didn't come in time is scored without them (and keeps its place, see below).
 */
export async function rerank(ranked, read, ctx = {}) {
  if (!ranked?.length) return ranked || [];
  const { index } = ctx;
  const f = readFeatures(read);
  let out = withHints(ranked, f, index);
  const ids = ctx.getCard ? pick(out, ctx.fetch ?? FETCH) : [];
  const got = new Map();
  if (ids.length) {
    let timer;
    const late = new Promise((resolve) => (timer = ctx.timeoutMs ? setTimeout(resolve, ctx.timeoutMs) : null));
    const each = ids.map((id) =>
      Promise.resolve()
        .then(() => ctx.getCard(id))
        .then((card) => card && got.set(id, cardDetails(card)))
        .catch(() => {}), // offline or not found: no details for this one
    );
    await Promise.race([Promise.all(each), late]);
    clearTimeout(timer);
  }
  if (!ids.length) return out;
  // Every candidate keeps its score without details (hinted); one whose details were wanted
  // but didn't come is marked unchecked (match.confidence then says "high" only if the scan is
  // just as clear without any details).
  out = out.map((r) => {
    if (!got.has(r.card.id)) return { ...r, hinted: r.score, ...(ids.includes(r.card.id) && { unchecked: true }) };
    const s = detailScore(f, got.get(r.card.id), index ? isModern(printedSet(r.card), index) : false);
    return { ...r, hinted: r.score, score: r.score + s.score, reasons: [...r.reasons, ...s.reasons] };
  });
  if (got.size === ids.length) return sortRanked(out);
  // Details came for only some: only those candidates are re-ordered among themselves, into
  // the places they held without details; the others keep theirs. A sibling printing can't
  // jump ahead just because its details came first, so this is never worse than no details
  // at all. (Scores then don't always go down the list; the order is what counts.)
  const places = [];
  out.forEach((r, i) => got.has(r.card.id) && places.push(i));
  const checked = sortRanked(places.map((i) => out[i]));
  places.forEach((i, k) => (out[i] = checked[k]));
  return out;
}

// Sets beside the main expansions: promos, McDonald's, trainer kits, POP, reprint collections, galleries…
const SPECIAL = /^(?:.*p|\d{4}[a-z]+|tk-.*|pop\d+|cel25cc|30th-c|jumbo|miscp|fut2020|bog|ru1|si1|rc|mfb|.*tg|.*gg|sma|swsh4\.5sv)$/;
export const isSpecialSet = (id) => SPECIAL.test(id);

/**
 * Best first. When nothing tells candidates apart, a card from a main expansion before one
 * from a promo series, reprint collection or gallery; then the original printing before
 * later reprints (older set first); then the regular card before the secret rares (lower
 * number first).
 */
function sortRanked(list) {
  const special = (r) => (isSpecialSet(r.card.setId) ? 1 : 0);
  return list.sort(
    (a, b) =>
      b.score - a.score ||
      special(a) - special(b) ||
      (a.set?.order ?? 0) - (b.set?.order ?? 0) ||
      (a.card.num ?? 1e4) - (b.card.num ?? 1e4),
  );
}
