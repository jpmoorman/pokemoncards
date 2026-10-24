// Turns raw OCR text from a card photo into structured clues:
// collector number(s), printed set total, set code (e.g. "OBF") and a name guess.

// Characters OCR commonly confuses with digits.
const DIGIT_FIX = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', i: '1', '|': '1', L: '1', S: '5', s: '5', B: '8', Z: '2', z: '2', G: '6' };

function fixDigits(s) {
  let out = '';
  for (const ch of s) out += /\d/.test(ch) ? ch : (DIGIT_FIX[ch] ?? '');
  return out;
}

function hasDigit(s) {
  return /\d/.test(s);
}

// Words printed on the card frame that are never part of a card name
// (only dropped when they make up a whole line, so "Item Finder" survives).
const FRAME_WORDS = new Set([
  'basic', 'stage', 'stage1', 'stage2', 'stage 1', 'stage 2', 'trainer', 'item', 'supporter',
  'stadium', 'tool', 'pokemon tool', 'energy', 'special energy', 'basic energy', 'restored',
  'level up', 'break', 'vmax', 'vstar', 'tera', 'ace spec', 'pokemon', 'trainer item',
  'trainer supporter', 'trainer stadium', 'basic pokemon', 'evolves', 'put',
]);

const PROMO_PREFIXES = ['SWSH', 'HGSS', 'SVP', 'MEP', 'SM', 'XY', 'BW', 'DP', 'SV', 'ME'];
const SUBSET_PREFIXES = ['TG', 'GG', 'SV', 'RC', 'H'];

/**
 * Collector numbers OCR mangled past the regular patterns, found by the set size printed
 * after them: with `totals` (every printed set size, from the catalog) "12/1014" (the
 * rarity star read as a digit), "IS/111" or "E5261/236" (letters around it) still give
 * 12/101, 15/111 and 261/236; a 3-digit number whose slash was lost or read as 7 or 1
 * ("1837165", "105123") gives 183/165 and 105/123. A 1- or 2-digit number whose slash was
 * misread or lost counts only with the rarity mark right after the set size, as older cards
 * print it ("10164★" for 10/64★, "1664*" for 16/64), and only when nothing else was found:
 * every reading that fits is given ("41102★": 4/102 or 41/102), for the name to decide.
 * Returns up to `max` [rawNum, rawTotal], most likely first.
 */
function looseNumbers(t, totals, max = 2) {
  const found = [];
  const short = [];
  // Runs of digits, slashes and letters OCR confuses with them. A comma or full stop inside
  // one is a stray mark ("1997,165"), or the slash before a zero-padded set size ("Q24,
  // 0886"; not in a list of years: "©1995, 96, 98"): both are tried.
  const runs = [];
  for (const m of t.matchAll(/[0-9OoQIilLSBDZ|/\\]+(?:[,.]\s?[0-9OoQIilLSBDZ|/\\]+)*/g)) {
    const r = m[0].replace(/\\/g, '/').replace(/\s/g, '');
    runs.push([m, r.replace(/[,.]/g, '')]);
    if (/^(?=[^,./]*\d)[^,./]{1,3}[,.][^,./]{3,}$/.test(r)) runs.push([m, r.replace(/[,.]/, '/')]);
  }
  for (const [m, s] of runs) {
    if (s.length < 4 || s.length > 14) continue;
    // Not a Pokédex number ("#157", "NO. 0699"), level, HP, damage, weight or year (none of
    // them has a slash).
    const pre = t.slice(Math.max(0, m.index - 4), m.index);
    const post = t.slice(m.index + m[0].length);
    if (!m[0].includes('/') && (/(#|N[oO0]\.?\s*|L[vV]\.?\s*|HP\s*|[-+×©])$/.test(pre) || /^\s*(lbs|HP|[+×,-])/.test(post))) continue;
    // A 1- or 2-digit number, the slash read as 1 (or 7, l, I, |) or lost, the set size, then
    // the rarity mark: "15164★", "4130*". Older cards print no zero in front of either.
    if (!/[/,.]/.test(m[0]) && /^\s?[★☆*•●◆]/.test(post) && /^[1-9]\d?[71lI|]?[1-9]\d{1,2}$/.test(s)) {
      for (const k of [1, 2]) {
        for (const slash of [1, 0]) {
          const [raw, sep, tot] = [s.slice(0, k), s.slice(k, k + slash), s.slice(k + slash)];
          if (!/^\d+$/.test(raw) || (slash && !/[71lI|]/.test(sep)) || !/^[1-9]\d{1,2}$/.test(tot) || !totals.has(+tot) || +raw > +tot) continue;
          // The slash read as a character first, then a 3-digit size.
          short.push({ raw, tot, score: slash + tot.length });
        }
      }
    }
    for (let i = 1; i < s.length; i++) {
      // The set size: 3 digits, or 2 (modern sets print "088" for 88, which reads either way).
      for (const len of [3, 2]) {
        const tot = s.slice(i, i + len);
        if (tot.length < len || !/^\d+$/.test(tot) || !totals.has(parseInt(tot, 10))) continue;
        // After the size: nothing, or the rarity mark read as a character or a few.
        const after = s.length - (i + len);
        const sep = s[i - 1];
        // The number before it: with the slash read, or (3 digits only) the slash read as 7,
        // 1, l, I or | ("1837165"), or lost ("105123").
        let raw = '';
        let how = 0;
        // With the slash read, a 2-digit size goes with a number of 1 or 2 digits ("189/20" is
        // no number: "/203" lost its last digit).
        const before = s.slice(0, i - 1);
        if (sep === '/' && after <= 2 && (len === 3 || !/\d{3}$/.test(before))) [raw, how] = [before.slice(-len), 4];
        else if (len === 3 && after <= 3) {
          const misread = /[71lI|]/.test(sep) ? s.slice(Math.max(0, i - 4), i - 1) : '';
          const lost = s.slice(Math.max(0, i - 3), i);
          [raw, how] = [[misread, 1], [lost, 0]].find(([x]) => x.length === 3 && /^\d+$/.test(fixDigits(x)) && /\d{2}/.test(x)) || [''];
        }
        // Letters alone pass for digits only before a slash that was read ("IS/111").
        if (!raw || (how < 4 && !/\d/.test(raw))) continue;
        const num = parseInt(fixDigits(raw), 10);
        const total = parseInt(tot, 10);
        // Secret rares run past the set size, but not by much without a slash to tell.
        if (!(num > 0 && num <= total + 150 && (how === 4 || num <= total * 1.6))) continue;
        // A read slash first, then a misread one, a 3-digit size, little after it.
        found.push({ raw, tot, score: how + len - after / 2 });
      }
    }
  }
  return (found.length ? found : short)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((f) => [f.raw, f.tot]);
}

/**
 * Extract collector numbers and set codes from the text found near the
 * bottom of a card (or the whole card when that's all we have).
 * `totals`: optional Set of printed set sizes; numbers that only read with one of them are
 * found too (see looseNumbers), and numbers with a known size come first.
 * Returns { numbers: [{prefix, num, total, text}], setCodes: [string], codeCandidates: [string] }.
 */
export function parseBottomText(text, { totals } = {}) {
  let t = (text || '').replace(/[–—−]/g, '-').replace(/[⁄∕]/g, '/');
  // A set size split by a space ("189/20 3"): joined again when only that makes it a known
  // size the number fits (numbers run at most 150 past their set size).
  if (totals?.size) {
    const fits = (n, tot) => totals.has(tot) && n <= tot + 150;
    t = t.replace(/(\d{1,3})(\s?\/\s?)(\d{1,2}) (\d)/g, (m, n, sl, a, b) => (!fits(+n, +a) && fits(+n, +(a + b)) ? `${n}${sl}${a}${b}` : m));
  }
  const numbers = [];
  const seen = new Set();
  const push = (prefix, rawNum, rawTotal) => {
    const num = parseInt(fixDigits(rawNum), 10);
    const total = rawTotal == null ? null : parseInt(fixDigits(rawTotal), 10);
    if (!Number.isFinite(num) || num <= 0 || num > 999) return;
    if (total != null && (!Number.isFinite(total) || total < 5 || num > total + 150)) return;
    const key = `${prefix}|${num}|${total}`;
    if (seen.has(key)) return;
    seen.add(key);
    // `text` keeps leading zeros the way the card prints them ("024/088").
    const text = `${prefix || ''}${fixDigits(rawNum)}${total != null ? `/${prefix || ''}${fixDigits(rawTotal)}` : ''}`;
    numbers.push({ prefix: prefix || '', num, total, text });
  };

  // Subset numbers like TG05/TG30, GG12/GG70, SV045/SV122, RC5/RC32.
  const subsetRe = new RegExp(
    `\\b(${SUBSET_PREFIXES.join('|')})\\s*([0-9OIl]{1,3})\\s*[/\\\\|]\\s*(?:${SUBSET_PREFIXES.join('|')})?\\s*([0-9OIl]{1,3})\\b`,
    'gi',
  );
  for (const m of t.matchAll(subsetRe)) {
    if (hasDigit(m[2]) && hasDigit(m[3])) push(m[1].toUpperCase(), m[2], m[3]);
  }

  // Standard "125/197". Allows a few letters OCR mistakes for digits.
  const stdRe = /(?<![0-9A-Za-z])([0-9OIlSBD]{1,3})\s*\/\s*([0-9OIlSBD]{2,3})(?![0-9])/g;
  for (const m of t.matchAll(stdRe)) {
    if (hasDigit(m[1]) && hasDigit(m[2])) push('', m[1], m[2]);
  }

  // Known set sizes: a number with none of them read may be mangled beyond the patterns.
  const known = (n) => n.total != null && !!totals?.has(n.total);
  if (totals?.size && !numbers.some(known)) {
    for (const [rawNum, rawTotal] of looseNumbers(t, totals)) push('', rawNum, rawTotal);
  }

  // Slash misread as "1", "l" or "|" ("1251197"): only try when nothing else matched.
  if (!numbers.length) {
    const looseRe = /(?<![0-9])(\d{1,3})\s*[|\\lI]\s*(\d{2,3})(?![0-9])/g;
    for (const m of t.matchAll(looseRe)) push('', m[1], m[2]);
    // ...or as "," / "." in a zero-padded modern number ("024,088", "Q24, 088").
    for (const m of t.matchAll(/(?<![0-9])([0-9OQD]{3})\s?[,.]\s?([0-9OQD]{3})(?![0-9])/g)) {
      if (/\d\d/.test(m[1].replace(/\D/g, '')) && /\d\d/.test(m[2].replace(/\D/g, ''))) push('', m[1], m[2]);
    }
  }

  // Set codes printed on Scarlet & Violet / Mega Evolution era cards: "OBF EN".
  const setCodes = [];
  for (const m of t.matchAll(/\b([A-Z0-9]{3})\s*[·•.:\-]?\s*EN\b/g)) {
    const code = m[1].toUpperCase();
    if (/[A-Z]/.test(code) && !setCodes.includes(code)) setCodes.push(code);
  }

  // Promos without a total: "SWSH050", "SM210", "SVP EN 045", "MEP 012" (a zero read as
  // "O" too: "HGSSO8").
  if (!numbers.some((n) => n.total)) {
    const promoRe = new RegExp(`\\b(${PROMO_PREFIXES.join('|')})\\s*(?:EN)?\\s*[-:#]?\\s*([0-9O]{1,3})\\b`, 'g');
    for (const m of t.matchAll(promoRe)) if (hasDigit(m[2])) push(m[1].toUpperCase(), m[2], null);
    // Number right after a set code: "OBF EN 125" when the "/197" got lost.
    for (const m of t.matchAll(/\b[A-Z]{3}\s*EN\s*(\d{1,3})\b/g)) push('', m[1], null);
    // Else a number printed zero-padded ("067": Mega Evolution promos print no set size),
    // standing alone.
    if (!numbers.length) for (const m of t.matchAll(/(?<![\w/.,])[0O]\d{2}(?![\d/])/g)) push('', m[0], null);
  }

  // Loose 3-letter uppercase tokens; matched against known set codes later.
  const codeCandidates = [];
  for (const m of t.matchAll(/\b([A-Z0-9]{3})\b/g)) {
    if (/[A-Z]/.test(m[1]) && !setCodes.includes(m[1]) && !codeCandidates.includes(m[1])) codeCandidates.push(m[1]);
  }

  // Numbers with a real set size first.
  if (totals?.size) numbers.sort((a, b) => known(b) - known(a));
  return { numbers, setCodes, codeCandidates };
}

/**
 * The collector number on a grading company's slab label ("2023 SCARLET & VIOLET 151
 * #199 CHARIZARD EX", "2026 POKEMON PERFECT ORDER #024/088"), read with the name area
 * when the slab was taken for the card.
 * Returns numbers like parseBottomText's.
 */
export function parseLabelNumbers(text) {
  const out = [];
  // A label starts with the card's year; a name area without one has no label in it.
  if (!/\b(199[6-9]|20[0-4]\d)\b/.test(text || '')) return out;
  for (const m of (text || '').matchAll(/#\s?(TG|GG|SWSH|SM|XY|BW|SVP|SV)?\s?(\d{1,3})(?:\s?\/\s?(?:TG|GG)?(\d{2,3}))?(?![\d/])/g)) {
    const num = parseInt(m[2], 10);
    const total = m[3] ? parseInt(m[3], 10) : null;
    if (num > 0 && !out.some((n) => n.num === num)) out.push({ prefix: m[1] || '', num, total, text: `${m[1] || ''}${m[2]}${m[3] ? `/${m[3]}` : ''}` });
  }
  return out;
}

/** Lowercase, strip accents and punctuation. "Pokémon Catcher!" -> "pokemon catcher" */
export function normalize(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Remove HP values, evolution text and frame labels from one OCR line. */
export function cleanNameLine(line) {
  let s = (line || '')
    .replace(/\bHP\s*[0-9OIlSB]{2,3}\b/gi, ' ')
    .replace(/\b[0-9OIlSB]{2,3}\s*HP\b/gi, ' ')
    .replace(/\bevol\w*\s+from\b.*$/i, ' ')
    // ...also when "Evolves" got mangled or lost: "plves rom Haunter", "rom Charmeleon".
    .replace(/(?:^|\s)(?:\S*ves\s+)?f?r[o0]m\s+\S.*$/i, ' ')
    .replace(/\bput\s+.*\bon the\b.*$/i, ' ')
    .replace(/\bstage\s*[12]\b/gi, ' ')
    .replace(/[0-9]+/g, ' ')
    .replace(/[^A-Za-zÀ-ÿ'’.\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const n = normalize(s);
  if (!n || FRAME_WORDS.has(n)) return '';
  // Needs at least one real word; artwork often reads as junk like "EE a".
  if (!/[a-z]{3,}/i.test(s)) return '';
  // Strip leading frame labels glued to the name ("BASIC Pikachu"). Labels are
  // printed in capitals, which keeps names like "Item Finder" intact.
  s = s.replace(/^(BASIC|STAGE|TRAINER|SUPPORTER|ITEM|STADIUM)\s+/, '');
  return s;
}

/**
 * Pick the most likely name text from OCR lines of the top of the card.
 * lines: [{ text, height, conf? }]. The card name is printed in the biggest font;
 * OCR confidence (0-100) damps tall-but-garbled reads of the artwork.
 * Returns { best, all } where `all` joins every cleaned line.
 */
export function pickName(lines) {
  const cleaned = (lines || [])
    .map((l) => {
      const conf = l.conf == null ? 100 : l.conf;
      return { text: cleanNameLine(l.text), score: (l.height || 0) * Math.min(1, Math.max(0.2, conf / 90)) };
    })
    .filter((l) => l.text);
  if (!cleaned.length) return { best: '', all: '' };
  const tallest = [...cleaned].sort((a, b) => b.score - a.score)[0];
  return { best: tallest.text, all: cleaned.map((l) => l.text).join(' ') };
}
