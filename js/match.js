// Ranks cards from the local card index against clues parsed from OCR.
import { normalize } from './parse.js';

const compact = (s) => normalize(s).replace(/ /g, '');

function bigrams(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

/** Sørensen–Dice similarity on character bigrams, 0..1. */
export function dice(a, b) {
  if (a === b) return a ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  let inter = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const c = A.get(g);
    if (c) {
      inter++;
      A.set(g, c - 1);
    }
  }
  return (2 * inter) / (a.length - 1 + b.length - 1);
}

/**
 * How well `name` appears somewhere inside noisy OCR `text`, 0..1.
 * Spaces are ignored because OCR often drops or adds them.
 */
export function partialSimilarity(name, text) {
  const n = compact(name);
  const t = compact(text);
  if (!n || !t) return 0;
  if (t.includes(n)) return 1;
  if (n.length >= t.length || n.length < 2) return dice(n, t);
  // dice(n, window) for every window, with the name's bigrams counted once (by code).
  const want = new Uint8Array(36 * 36);
  for (let i = 0; i < n.length - 1; i++) want[gramCode(n, i)]++;
  const grams = new Uint16Array(t.length - 1);
  for (let i = 0; i < t.length - 1; i++) grams[i] = gramCode(t, i);
  const used = new Uint8Array(36 * 36);
  let best = 0;
  for (let w = Math.max(2, n.length - 1); w <= n.length + 1; w++) {
    for (let i = 0; i + w <= t.length; i++) {
      let inter = 0;
      for (let j = i; j < i + w - 1; j++) {
        const g = grams[j];
        if (used[g] < want[g]) {
          used[g]++;
          inter++;
        }
      }
      for (let j = i; j < i + w - 1; j++) used[grams[j]] = 0;
      const d = (2 * inter) / (n.length - 1 + w - 1);
      if (d > best) best = d;
    }
  }
  return best;
}

/** "TG05" -> { prefix: "TG", num: 5 }, "125" -> { prefix: "", num: 125 }. */
export function parseLocalId(localId) {
  const m = /^([A-Za-z]*)\s*0*(\d+)[a-z]?$/.exec(String(localId || '').trim());
  if (!m) return null;
  return { prefix: m[1].toUpperCase(), num: parseInt(m[2], 10) };
}

// Reprint collections copy an older card exactly, number and set size included ("4/102"), and
// add an anniversary logo to the artwork; TCGdex numbers them on their own (CC002, 001).
// Reprint -> the original it copies. Without this the printed number could only match the
// original, and the scanner would name a $5 reprint as the (much dearer) vintage card.
// (Legendary Collection, Base Set 2, Evolutions and the like print new numbers, so the number
// tells those apart.)
export const REPRINTS = {
  // Celebrations: Classic Collection (2021)
  'cel25cc-CC001': 'base1-2', 'cel25cc-CC002': 'base1-4', 'cel25cc-CC003': 'base1-15', 'cel25cc-CC004': 'base1-73',
  'cel25cc-CC005': 'base5-8', 'cel25cc-CC006': 'base5-15', 'cel25cc-CC007': 'gym2-15', 'cel25cc-CC008': 'basep-24',
  'cel25cc-CC009': 'neo1-20', 'cel25cc-CC010': 'neo3-66', 'cel25cc-CC011': 'ex4-9', 'cel25cc-CC012': 'ex7-86',
  'cel25cc-CC013': 'ex12-88', 'cel25cc-CC014': 'ex15-93', 'cel25cc-CC015': 'pop5-17', 'cel25cc-CC016': 'dp4-15',
  'cel25cc-CC017': 'pl2-109', 'cel25cc-CC018': 'pl3-145', 'cel25cc-CC019': 'hgss1-107', 'cel25cc-CC020': 'bw1-113',
  'cel25cc-CC021': 'bw1-114', 'cel25cc-CC022': 'bw4-54', 'cel25cc-CC023': 'xy1-97', 'cel25cc-CC024': 'xy6-76',
  'cel25cc-CC025': 'sm2-60',
  // 30th Celebration: Classic Collection (2026), matched to the original by name, HP, attacks and illustrator
  '30th-c-001': 'base1-4', '30th-c-002': 'ex1-5', '30th-c-003': 'ex11-11', '30th-c-004': 'bw10-11', '30th-c-005': 'gym1-18',
  '30th-c-006': 'ex7-19', '30th-c-007': 'neo1-25', '30th-c-008': 'sm9-33', '30th-c-009': 'xy9-41', '30th-c-010': 'dp6-43',
  '30th-c-011': 'pl1-47', '30th-c-012': 'swsh4-50', '30th-c-013': 'sm4-57', '30th-c-014': 'base1-58', '30th-c-015': 'gym2-69',
  '30th-c-016': 'bw6-85', '30th-c-017': 'sm1-89', '30th-c-018': 'hgss4-94', '30th-c-019': 'hgss4-100', '30th-c-020': 'hgss4-99',
  '30th-c-021': 'bw3-92', '30th-c-022': 'dp4-106', '30th-c-023': 'xy5-106', '30th-c-024': 'neo4-106', '30th-c-025': 'ex10-108',
  '30th-c-026': 'swsh8-114', '30th-c-027': 'swsh9-123', '30th-c-028': 'swsh1-138', '30th-c-029': 'ecard2-149', '30th-c-030': 'sv02-203',
};
/** The reprint collections, for the result sheet's note: the year they came out and their artwork logo. */
export const REPRINT_SETS = {
  cel25cc: { name: 'Celebrations', year: 2021, logo: '25th-anniversary' },
  '30th-c': { name: '30th Celebration', year: 2026, logo: '30th-anniversary' },
};

// How far ahead of every other match the best must be for a "high" confidence.
const CONFIDENT_GAP = 1.5;

/**
 * Build the in-memory search index.
 * cards: [{ id, localId, name, image? }], sets: [{ id, name, cardCount: {official,total}, ... }]
 * A reprint-collection card also gets reprintOf (the original's id) and printed: what it
 * copies, { prefix, num, total, setId } (number, set size and the original's set); it is found
 * under both numbers.
 */
export function buildIndex(cards, sets) {
  const setsById = new Map();
  // Pokémon TCG Pocket (the mobile game) sets use ids like "A1", "B2a", "P-A"; skip them.
  sets.forEach((s, i) => !/^[A-Z]/.test(s.id) && setsById.set(s.id, { ...s, order: i }));
  const entries = [];
  const byId = new Map();
  const byNum = new Map();
  const byName = new Map();
  const addNum = (num, e) => {
    if (!byNum.has(num)) byNum.set(num, []);
    byNum.get(num).push(e);
  };
  for (const c of cards) {
    const setId = c.id.slice(0, c.id.length - String(c.localId).length - 1);
    if (!setsById.has(setId)) continue;
    const parsed = parseLocalId(c.localId);
    const e = { ...c, setId, prefix: parsed?.prefix ?? '', num: parsed?.num ?? null };
    entries.push(e);
    byId.set(e.id, e);
    if (e.num != null) addNum(e.num, e);
    const key = compact(c.name);
    if (!byName.has(key)) {
      const core = coreName(c.name);
      byName.set(key, { name: c.name, core: compact(core), parts: core.includes('&') ? core.split('&').map(compact) : null, cards: [] });
    }
    byName.get(key).cards.push(e);
  }
  for (const [id, of] of Object.entries(REPRINTS)) {
    const e = byId.get(id);
    const o = byId.get(of);
    if (!e || !o || o.num == null) continue;
    e.reprintOf = of;
    e.printed = { prefix: o.prefix, num: o.num, total: setsById.get(o.setId).cardCount?.official || null, setId: o.setId };
    if (o.num !== e.num) addNum(o.num, e);
  }
  return { entries, byNum, byName, setsById };
}

/**
 * The reprint-collection copies (or the original) of the top match that the evidence can't
 * rule out: they print the same text and number, only an anniversary logo on the artwork
 * differs. Returns those ranked entries (often none). Ruled out means scored clearly lower
 * (the gap a "high" confidence needs), e.g. once "Wizards" was read in the copyright line,
 * which no reprint prints.
 */
export function reprintRivals(ranked) {
  const [a] = ranked;
  if (!a) return [];
  const twin = (r) => (a.card.reprintOf && (r.card.id === a.card.reprintOf || r.card.reprintOf === a.card.reprintOf)) || r.card.reprintOf === a.card.id;
  return ranked.filter((r) => r !== a && twin(r) && r.score > a.score - CONFIDENT_GAP);
}

// Marks printed as a logo or symbol next to the name ("Charizard ex", "Umbreon V",
// "Garchomp C", "M Gengar EX"): OCR often drops or garbles them.
const NAME_MARK = /\s+(ex|EX|GX|V|VMAX|VSTAR|V-UNION|BREAK|LV\.X|LEGEND|G|GL|E4|C|FB|◇|☆|δ)$/;

/** The name without its logo marks: "M Charizard EX" -> "Charizard"; same name if it has none. */
export function coreName(name) {
  return splitName(name).core;
}

/** A name's logo marks, lowercase: "M Charizard EX" -> ['ex', 'm'], "Reshiram & Zekrom GX" -> ['gx', '&']. */
export function nameMarks(name) {
  return splitName(name).marks;
}

function splitName(name) {
  let s = String(name || '').trim();
  const marks = [];
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(NAME_MARK, (_, m) => (marks.push(m.toLowerCase()), '')).replace(/^M\s+(?=\S)/, () => (marks.push('m'), ''));
  }
  if (s.includes('&')) marks.push('&');
  return { core: s || String(name || ''), marks };
}

/** Weights of the first pass, next to a name read right (5) and a number found (3). */
export const RANK = {
  markLost: 1, // a name read without its logo mark ("Charizard" for "Charizard ex")
  totalWrong: 1, // number found, but the set size read doesn't match the set
  dictionary: 0.9, // name found by the dictionary somewhere in the text, not read in the name area
  partner: 0.9, // one name of a TAG TEAM read ("Lunala" for "Solgaleo & Lunala GX")
  length: 0.06, // per letter of the name matched: of two similar names, the longer explains more of the read
};

/**
 * Rank candidate cards.
 * clues: { nameBest, nameAll, numbers: [{prefix,num,total}], setCodes: [], codeCandidates: [] }
 *        (nameFrom: 'dictionary' when nameBest was found in the text, not read in the name area)
 * setAbbr: Map/obj setId -> official code ("OBF")
 * Returns [{ card, set, score, reasons }] best first.
 */
// OCR mixes up O and 0 ("3OC" for "30C"), so compare codes with both folded to 0.
const codeKey = (c) => String(c || '').toUpperCase().replace(/O/g, '0');

export function rankCandidates(index, clues, setAbbr = {}, limit = 40) {
  const abbrOf = (setId) => (setAbbr instanceof Map ? setAbbr.get(setId) : setAbbr[setId]) || null;
  const codes = new Set((clues.setCodes || []).map(codeKey));
  const looseCodes = new Set((clues.codeCandidates || []).map(codeKey));
  // Sets the user picked explicitly; results are limited to them when any match.
  const setIds = new Set(clues.setIds || []);
  const nameBest = clues.nameBest || '';
  const nameAll = clues.nameAll || '';
  const hasName = !!(nameBest || nameAll);
  // A name the dictionary found somewhere in the text counts less than one read in the name area.
  const bestWeight = clues.nameFrom === 'dictionary' ? RANK.dictionary : 1;
  const nameCache = new Map();
  const similarity = (name) =>
    Math.max(nameBest ? bestWeight * partialSimilarity(name, nameBest) : 0, nameAll ? 0.85 * partialSimilarity(name, nameAll) : 0);
  // Name similarity, and how many letters of the name it matched (for ties, see below).
  const nameMatch = (card) => {
    if (!hasName) return { s: 0, len: 0 };
    let m = nameCache.get(card.name);
    if (!m) {
      const core = coreName(card.name);
      m = { s: similarity(card.name), len: compact(card.name).length };
      if (core !== card.name && m.s < 1) {
        const c = RANK.markLost * similarity(core);
        if (c > m.s) m = { s: c, len: compact(core).length };
      }
      // TAG TEAM cards ("Solgaleo & Lunala GX"): OCR may only get one of the names.
      if (core.includes('&') && m.s < 1) {
        for (const part of core.split('&')) {
          const c = RANK.partner * similarity(part);
          if (c > m.s) m = { s: c, len: compact(part).length };
        }
      }
      nameCache.set(card.name, m);
    }
    return m;
  };
  const nameScore = (card) => nameMatch(card).s;
  // printed: the number a reprint-collection card prints (its original's), whose set size counts.
  const setBonus = (card, total, reasons, printed = null) => {
    const set = index.setsById.get(card.setId);
    let s = 0;
    const abbr = abbrOf(card.setId);
    if (setIds.has(card.setId)) {
      s += 5;
      reasons.push('chosen set');
    } else if (abbr && codes.has(codeKey(abbr))) {
      s += 4;
      reasons.push(`set code ${abbr}`);
    } else if (abbr && looseCodes.has(codeKey(abbr))) {
      s += 2;
      reasons.push(`set code ${abbr}?`);
    }
    if (total) {
      if ((printed ? printed.total : set.cardCount?.official) === total) {
        s += 2.5;
        reasons.push(`set size ${total}`);
      } else if (!printed && set.cardCount?.total === total) {
        s += 1.5;
        reasons.push(`set size ${total}`);
      } else {
        s -= RANK.totalWrong;
      }
    }
    return s;
  };

  const results = new Map();
  const add = (card, score, reasons) => {
    const prev = results.get(card.id);
    if (!prev || prev.score < score) {
      results.set(card.id, { card, set: index.setsById.get(card.setId), score, reasons });
    }
  };

  for (const n of clues.numbers || []) {
    for (const card of index.byNum.get(n.num) || []) {
      // A reprint-collection card prints its original's number; its own (TCGdex) number
      // counts only typed in full ("CC002") or within a set the user picked.
      let p = card;
      if (card.printed) {
        if (card.printed.num === n.num && n.prefix === card.printed.prefix) p = card.printed;
        else if (!(n.prefix && n.prefix === card.prefix) && !setIds.has(card.setId)) continue;
      }
      const reasons = [`#${p === card ? card.localId : `${p.prefix}${p.num}`}`];
      let s = 3;
      if (n.prefix || p.prefix) {
        if (n.prefix === p.prefix) s += 1;
        else if (n.prefix && p.prefix) continue;
        else s -= 1.5;
      }
      s += setBonus(card, n.total, reasons, p === card ? null : p);
      const ns = nameScore(card);
      if (ns > 0.5) reasons.push(`name ${Math.round(ns * 100)}%`);
      s += 5 * ns;
      add(card, s, reasons);
    }
  }

  // Name-driven search: always run when we have a name, so a misread number
  // can't hide the right card.
  if (hasName) {
    const textBigrams = new Set();
    const t = compact(`${nameBest} ${nameAll}`);
    for (let i = 0; i < t.length - 1; i++) textBigrams.add(t.slice(i, i + 2));
    const hits = (k) => {
      let hit = 0;
      for (let i = 0; i < k.length - 1; i++) if (textBigrams.has(k.slice(i, i + 2))) hit++;
      return hit / Math.max(1, k.length - 1);
    };
    for (const [key, group] of index.byName) {
      if (key.length < 3) continue;
      // Cheap prefilter: most of the name's (or its core name's) bigrams must appear in the text.
      if (hits(key) < 0.5 && (group.core === key || hits(group.core) < 0.5) && !group.parts?.some((p) => hits(p) >= 0.5)) continue;
      const { s: ns, len } = nameMatch(group.cards[0]);
      if (ns < 0.6) continue;
      for (const card of group.cards) {
        const reasons = [`name ${Math.round(ns * 100)}%`];
        let s = 5 * ns;
        const total = (clues.numbers || []).find((n) => n.total)?.total;
        s += Math.max(0, setBonus(card, total, reasons, card.printed));
        // Of two similar names the longer one explains more of the read: "Charizard ex" over
        // "Charizard" for "Charizard ex", "Dark Charizard" over "Charizard" for "ark Charizard".
        s += RANK.length * Math.min(len, 20);
        add(card, s, reasons);
      }
    }
  }

  let out = [...results.values()];
  if (setIds.size) {
    const inSet = out.filter((r) => setIds.has(r.card.setId));
    if (inSet.length) out = inSet;
    else if (!hasName && !(clues.numbers || []).length) out = [];
  }
  // A set picked with nothing else: list that set's cards in number order.
  if (setIds.size && !hasName && !(clues.numbers || []).length) {
    return index.entries
      .filter((c) => setIds.has(c.setId))
      .sort((a, b) => (a.num ?? 1e9) - (b.num ?? 1e9) || String(a.localId).localeCompare(String(b.localId)))
      .slice(0, limit)
      .map((card) => ({ card, set: index.setsById.get(card.setId), score: 1, reasons: ['chosen set'] }));
  }
  return out
    .sort(byScore)
    .slice(0, limit);
}

// Best first; on a tie the newest set, but a reprint-collection copy after anything else.
const reprint = (r) => (r.card.reprintOf ? 1 : 0);
const byScore = (a, b) => b.score - a.score || reprint(a) - reprint(b) || b.set.order - a.set.order;

/** Is the top match as clear on the scores without card details (rerank.js `hinted`)? */
function clearWithout(ranked) {
  const [a, ...rest] = ranked;
  const without = (r) => r.hinted ?? r.score;
  return without(a) >= 8 && rest.every((r) => without(a) - without(r) >= CONFIDENT_GAP);
}

/**
 * Another card of the same name in the same set whose number is the top match's with a digit
 * doubled (dp6-5 and dp6-55 Gliscor): the text reader can merge a doubled digit ("55" read as
 * "5"), so the number read doesn't rule it out.
 */
function doubledDigitTwin(ranked) {
  const [a] = ranked;
  const n = String(a.card.num ?? '');
  const doubled = new Set([...n].map((_, i) => +(n.slice(0, i + 1) + n.slice(i))));
  return ranked.some((r) => r !== a && r.card.setId === a.card.setId && r.card.name === a.card.name && doubled.has(r.card.num));
}

/**
 * Rough confidence label for the top result: 'high' | 'medium' | 'low' | 'none'.
 * Never 'high' when the top match has a reprint-collection twin the evidence can't rule out
 * (see reprintRivals) or a same-name card a doubled digit away (doubledDigitTwin), nor when
 * card details came for only some of the close matches (rerank.js marks the others
 * `unchecked`) unless the scan is just as clear without any details. Tied with another card
 * (other than a reprint twin, which the result sheet offers in a note) it is a guess: 'low'.
 */
export function confidence(ranked) {
  if (!ranked.length) return 'none';
  const [a, b] = ranked;
  const gap = b ? a.score - b.score : a.score;
  const twins = reprintRivals(ranked);
  if (a.score >= 8 && gap >= CONFIDENT_GAP && !twins.length && !doubledDigitTwin(ranked) && (!ranked.some((r) => r.unchecked) || clearWithout(ranked))) return 'high';
  const tied = ranked.some((r) => r !== a && Math.abs(r.score - a.score) < 1e-9 && !twins.includes(r));
  if (a.score >= 6 && !tied) return 'medium';
  return 'low';
}

/** Manual search: name text and/or number like "125", "125/197", "TG05". */
export function manualSearch(index, nameQuery, numberQuery, setAbbr = {}, setId = '') {
  const clues = { nameBest: nameQuery || '', nameAll: '', numbers: [], setCodes: [], codeCandidates: [], setIds: setId ? [setId] : [] };
  const q = (numberQuery || '').trim().toUpperCase();
  if (q) {
    const m = /^([A-Z]*)\s*(\d{1,3})\s*(?:\/\s*[A-Z]*\s*(\d{1,3}))?$/.exec(q);
    if (m) clues.numbers.push({ prefix: m[1], num: parseInt(m[2], 10), total: m[3] ? parseInt(m[3], 10) : null });
  }
  let ranked = rankCandidates(index, clues, setAbbr, 200);
  if (nameQuery) {
    // Plain substring matches the fuzzy matcher might rank low ("pika" -> every Pikachu).
    const nq = compact(nameQuery);
    if (nq.length >= 2) {
      const have = new Set(ranked.map((r) => r.card.id));
      for (const [key, group] of index.byName) {
        if (!key.includes(nq)) continue;
        for (const card of group.cards) {
          if (have.has(card.id)) continue;
          if (clues.numbers.length && !clues.numbers.some((n) => n.num === card.num || n.num === card.printed?.num)) continue;
          if (setId && card.setId !== setId) continue;
          ranked.push({ card, set: index.setsById.get(card.setId), score: 2 + nq.length / key.length, reasons: ['name contains'] });
        }
      }
    }
    if (clues.numbers.length) ranked = ranked.filter((r) => clues.numbers.some((n) => n.num === r.card.num || n.num === r.card.printed?.num));
    ranked.sort(byScore);
  }
  return ranked.slice(0, 120);
}

// ---------- dictionary name lookup ----------
// Finds known card names inside noisy OCR text (e.g. the whole card read when the
// name area was hidden by glare). A bigram "diagonal" filter keeps it fast across
// every card name; only promising spots get the exact Dice comparison.

const gramCode = (s, i) => {
  const a = s.charCodeAt(i);
  const b = s.charCodeAt(i + 1);
  return (a >= 97 ? a - 97 : a - 22) * 36 + (b >= 97 ? b - 97 : b - 22); // a-z -> 0-25, 0-9 -> 26-35
};

/** Levenshtein distance, giving up (returns max + 1) once it exceeds `max`. */
export function editDistance(a, b, max = Infinity) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const nameTables = new WeakMap();
function nameTable(index) {
  let t = nameTables.get(index);
  if (!t) {
    t = [];
    for (const [key, group] of index.byName) {
      if (key.length < 3) continue;
      const grams = new Uint16Array(key.length - 1);
      for (let i = 0; i < key.length - 1; i++) grams[i] = gramCode(key, i);
      t.push({ key, name: group.name, words: normalize(group.name), grams });
    }
    nameTables.set(index, t);
  }
  return t;
}

/**
 * Known card names that appear (fuzzily) in `text`, best first:
 * [{ name, score (0..1 similarity), pos (0..1 where in the text) }].
 * Names of 4 letters or fewer must appear as a whole word. Names right after
 * "Evolves from" are skipped (that's the previous stage, not this card).
 */
export function findNamesInText(index, text, { limit = 5, minScore = 0.75 } = {}) {
  const t = compact(text);
  if (t.length < 3 || !index?.byName) return [];
  // Text bigram positions, bucketed by code (CSR layout).
  const n = t.length - 1;
  const count = new Int32Array(36 * 36 + 1);
  const codes = new Uint16Array(n);
  for (let i = 0; i < n; i++) count[(codes[i] = gramCode(t, i)) + 1]++;
  for (let i = 1; i < count.length; i++) count[i] += count[i - 1];
  const pos = new Int32Array(n);
  const fill = count.slice();
  for (let i = 0; i < n; i++) pos[fill[codes[i]]++] = i;
  const words = ` ${normalize(text)} `;
  // Where words start and end in the compact text: a fuzzy match must line up with
  // them (±1 letter), so "from attacks" can't pass for "Exroma".
  const starts = new Uint8Array(t.length + 2);
  const ends = new Uint8Array(t.length + 2);
  let wordAt = 0;
  for (const word of words.trim().split(' ')) {
    starts[wordAt] = 1;
    wordAt += word.length;
    ends[wordAt] = 1;
  }
  const near = (marks, i) => marks[i] || (i > 0 && marks[i - 1]) || marks[i + 1];
  const evolves = (i) => {
    const before = t.slice(Math.max(0, i - 12), i);
    return /fr[o0]m.?$/.test(before) || dice('evolvesfrom', before.slice(-11)) >= 0.6;
  };

  const found = [];
  const diags = [];
  for (const entry of nameTable(index)) {
    const { key, grams } = entry;
    const L = key.length;
    if (L <= 4) {
      const at = words.indexOf(` ${entry.words} `);
      if (at >= 0) {
        const cAt = compact(words.slice(0, at)).length;
        if (!evolves(cAt)) found.push({ name: entry.name, score: 1, pos: cAt / t.length, len: L });
      }
      continue;
    }
    const edits = L >= 12 ? 2 : L >= 6 ? 1 : 0;
    const need = Math.max(2, Math.min(Math.ceil(0.75 * (L - 1)), L - 1 - 2 * edits));
    // Each shared bigram votes for an alignment (text position - name position).
    diags.length = 0;
    for (let i = 0; i < grams.length; i++) {
      for (let k = count[grams[i]]; k < count[grams[i] + 1]; k++) diags.push(pos[k] - i);
    }
    if (diags.length < need) continue;
    diags.sort((a, b) => a - b);
    let best = null;
    for (let a = 0, b = 0; b < diags.length; b++) {
      while (diags[b] - diags[a] > 2) a++;
      // Window of alignments within ±2 (OCR adds/drops a letter or two).
      if (b - a + 1 < need || (b + 1 < diags.length && diags[b + 1] - diags[a] <= 2)) continue;
      const start = diags[a];
      for (let s = start - 1; s <= diags[b] + 1; s++) {
        for (let w = L - 1; w <= L + 1; w++) {
          if (s < 0 || s + w > t.length) continue;
          const win = t.slice(s, s + w);
          let d = dice(key, win);
          // One wrong letter costs two bigrams; allow a letter or two by edit distance.
          if (edits && d < 1) {
            const e = editDistance(key, win, edits);
            if (e <= edits) d = Math.max(d, 1 - e / L);
          }
          if (d < minScore || (best && d <= best.score) || evolves(s)) continue;
          if (d < 1 && !(near(starts, s) && near(ends, s + w))) continue;
          best = { name: entry.name, score: d, pos: s / t.length, len: L };
        }
      }
    }
    if (best) found.push(best);
  }
  // Better match first; then earlier in the text (the name is printed at the top),
  // then longer names ("Charizard ex" over "Charizard").
  found.sort((a, b) => b.score - 0.1 * b.pos - (a.score - 0.1 * a.pos) || b.len - a.len);
  return found.slice(0, limit).map(({ name, score, pos }) => ({ name, score, pos }));
}
