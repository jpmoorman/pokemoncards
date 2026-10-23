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
  if (n.length >= t.length) return dice(n, t);
  let best = 0;
  for (let w = Math.max(2, n.length - 1); w <= n.length + 1; w++) {
    for (let i = 0; i + w <= t.length; i++) {
      const d = dice(n, t.slice(i, i + w));
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

/**
 * Build the in-memory search index.
 * cards: [{ id, localId, name, image? }], sets: [{ id, name, cardCount: {official,total}, ... }]
 */
export function buildIndex(cards, sets) {
  const setsById = new Map();
  // Pokémon TCG Pocket (the mobile game) sets use ids like "A1", "B2a", "P-A"; skip them.
  sets.forEach((s, i) => !/^[A-Z]/.test(s.id) && setsById.set(s.id, { ...s, order: i }));
  const entries = [];
  const byNum = new Map();
  const byName = new Map();
  for (const c of cards) {
    const setId = c.id.slice(0, c.id.length - String(c.localId).length - 1);
    if (!setsById.has(setId)) continue;
    const parsed = parseLocalId(c.localId);
    const e = { ...c, setId, prefix: parsed?.prefix ?? '', num: parsed?.num ?? null };
    entries.push(e);
    if (e.num != null) {
      if (!byNum.has(e.num)) byNum.set(e.num, []);
      byNum.get(e.num).push(e);
    }
    const key = compact(c.name);
    if (!byName.has(key)) byName.set(key, { name: c.name, cards: [] });
    byName.get(key).cards.push(e);
  }
  return { entries, byNum, byName, setsById };
}

/**
 * Rank candidate cards.
 * clues: { nameBest, nameAll, numbers: [{prefix,num,total}], setCodes: [], codeCandidates: [] }
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
  const nameCache = new Map();
  const nameScore = (card) => {
    if (!hasName) return 0;
    if (nameCache.has(card.name)) return nameCache.get(card.name);
    const s = Math.max(
      nameBest ? partialSimilarity(card.name, nameBest) : 0,
      nameAll ? 0.85 * partialSimilarity(card.name, nameAll) : 0,
    );
    nameCache.set(card.name, s);
    return s;
  };
  const setBonus = (card, total, reasons) => {
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
      if (set.cardCount?.official === total) {
        s += 2.5;
        reasons.push(`set size ${total}`);
      } else if (set.cardCount?.total === total) {
        s += 1.5;
        reasons.push(`set size ${total}`);
      } else {
        s -= 1;
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
      const reasons = [`#${card.localId}`];
      let s = 3;
      if (n.prefix || card.prefix) {
        if (n.prefix === card.prefix) s += 1;
        else if (n.prefix && card.prefix) continue;
        else s -= 1.5;
      }
      s += setBonus(card, n.total, reasons);
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
    for (const [key, group] of index.byName) {
      if (key.length < 3) continue;
      // Cheap prefilter: most of the name's bigrams must appear in the text.
      let hit = 0;
      for (let i = 0; i < key.length - 1; i++) if (textBigrams.has(key.slice(i, i + 2))) hit++;
      if (hit / Math.max(1, key.length - 1) < 0.5) continue;
      const ns = nameScore(group.cards[0]);
      if (ns < 0.6) continue;
      for (const card of group.cards) {
        const reasons = [`name ${Math.round(ns * 100)}%`];
        let s = 5 * ns;
        const total = (clues.numbers || []).find((n) => n.total)?.total;
        s += Math.max(0, setBonus(card, total, reasons));
        // Slight preference for longer names when equally similar ("Charizard ex" over "Charizard").
        s += Math.min(key.length, 20) / 200;
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
    .sort((a, b) => b.score - a.score || b.set.order - a.set.order)
    .slice(0, limit);
}

/** Rough confidence label for the top result. */
export function confidence(ranked) {
  if (!ranked.length) return 'none';
  const [a, b] = ranked;
  const gap = b ? a.score - b.score : a.score;
  if (a.score >= 8 && gap >= 1.5) return 'high';
  if (a.score >= 6) return 'medium';
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
          if (clues.numbers.length && !clues.numbers.some((n) => n.num === card.num)) continue;
          if (setId && card.setId !== setId) continue;
          ranked.push({ card, set: index.setsById.get(card.setId), score: 2 + nq.length / key.length, reasons: ['name contains'] });
        }
      }
    }
    if (clues.numbers.length) ranked = ranked.filter((r) => clues.numbers.some((n) => n.num === r.card.num));
    ranked.sort((a, b) => b.score - a.score || b.set.order - a.set.order);
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
  const evolves = (at) => {
    const before = t.slice(Math.max(0, at - 12), at);
    return before.includes('from') || dice('evolvesfrom', before.slice(-11)) >= 0.6;
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
          if (d >= minScore && (!best || d > best.score) && !evolves(s)) best = { name: entry.name, score: d, pos: s / t.length, len: L };
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
