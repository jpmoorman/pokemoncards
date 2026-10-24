// Card details shipped with the app (data/details-*.json, built by tools/build-details.mjs from
// a snapshot of the TCGdex API): HP, attack and ability names, illustrator, rarity, regulation
// mark, the start of the trainer text and the printed versions of every English card. With it
// the second ranking pass (rerank.js) needs no download, so a scan ranks the same offline.
//
// The file is one short line of text per card, sorted by card id, and stays that way in memory
// (about 2 MB for 21,000 cards, where the same data as objects takes about 8 MB): a card's line
// is found by binary search and only unpacked when asked for.
//   line: id|hp|stage|rarity|illustrator|regulationMark|attacks|abilities|effect|variants
//   stage, rarity and illustrator are indexes (base 36) into the file's lists of names;
//   attacks and abilities are names joined by "~"; variants are joined by ";", each
//   "type,subtype,stamp+stamp,foil,size" (size left empty for standard); empty fields at the
//   end of a line are left out.

export const FORMAT = 'card-details-1';
const FIELDS = 'id|hp|stage|rarity|illustrator|regulationMark|attacks|abilities|effect|variants';
// rerank.js compares only the trainer text's first sentence, up to 60 characters.
const EFFECT_CHARS = 60;

const clean = (s) => (s == null || s === 'null' || s === 'None' ? '' : String(s));
// Characters the line format uses as separators can't appear in a value.
const safe = (s, extra = '') => clean(s).replace(new RegExp(`[|~${extra}]`, 'g'), ' ');
const names = (list) => (list || []).map((a) => safe(typeof a === 'string' ? a : a?.name)).filter(Boolean);
const effectStart = (s) => clean(s).split(/[.!]/)[0].slice(0, EFFECT_CHARS);

/**
 * Pack a snapshot, { cardId: { hp, stage, attacks, abilities, effect, illustrator, rarity,
 * regulationMark, variants: [{ type, subtype, stamp: [], foil, size }] } } (the private test
 * repo's catalog/details.json.gz; attacks may also be TCGdex's [{ name }]), into the shipped
 * file's JSON object. The same snapshot always gives the same file.
 */
export function packDetails(snapshot) {
  const ids = Object.keys(snapshot).sort();
  // Name lists, most used first (shortest index), ties by name.
  const list = (key) => {
    const n = new Map();
    for (const id of ids) {
      const v = safe(snapshot[id]?.[key]);
      if (v) n.set(v, (n.get(v) || 0) + 1);
    }
    const sorted = [...n.keys()].sort((a, b) => n.get(b) - n.get(a) || (a < b ? -1 : a > b ? 1 : 0));
    return { names: sorted, at: new Map(sorted.map((s, i) => [s, i.toString(36)])) };
  };
  const stages = list('stage');
  const rarities = list('rarity');
  const illustrators = list('illustrator');
  const variant = (v) =>
    [v.type, v.subtype, (v.stamp || []).map((s) => safe(s, ',;+')).join('+'), v.foil, v.size === 'standard' ? '' : v.size]
      .map((x, i) => (i === 2 ? x : safe(x, ',;+')))
      .join(',')
      .replace(/,+$/, '');
  const cards = ids.map((id) => {
    const d = snapshot[id] || {};
    const hp = parseInt(d.hp, 10);
    return [
      safe(id),
      hp > 0 ? hp : '',
      stages.at.get(safe(d.stage)) ?? '',
      rarities.at.get(safe(d.rarity)) ?? '',
      illustrators.at.get(safe(d.illustrator)) ?? '',
      safe(d.regulationMark),
      names(d.attacks).join('~'),
      names(d.abilities).join('~'),
      safe(effectStart(d.effect)),
      (d.variants || []).filter((v) => v?.type).map(variant).join(';'),
    ]
      .join('|')
      .replace(/\|+$/, '');
  });
  return {
    format: FORMAT,
    source: 'TCGdex (https://tcgdex.dev): card details',
    fields: FIELDS,
    stages: stages.names,
    rarities: rarities.names,
    illustrators: illustrators.names,
    cards,
  };
}

/**
 * Read the shipped file (its parsed JSON). Returns { size, card(id) } where card(id) gives a
 * card's details shaped like the TCGdex card the app downloads (attacks [{ name }], variants,
 * variants_detailed; no name, set, picture or prices: those come from the card list and the
 * API), or null if the file doesn't have that card. Returns null for a file in another format.
 */
export function readDetails(json) {
  if (json?.format !== FORMAT || !Array.isArray(json.cards)) return null;
  const { cards, stages = [], rarities = [], illustrators = [] } = json;
  const idOf = (line) => {
    const end = line.indexOf('|');
    return end < 0 ? line : line.slice(0, end);
  };
  const find = (id) => {
    let lo = 0;
    let hi = cards.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const at = idOf(cards[mid]);
      if (at === id) return cards[mid];
      if (at < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  };
  const pick = (names, i) => (i ? names[parseInt(i, 36)] : undefined);
  const card = (id) => {
    const line = find(String(id));
    if (!line) return null;
    const [, hp, stage, rarity, illus, reg, attacks, abilities, effect, variants] = line.split('|');
    const detailed = (variants || '')
      .split(';')
      .filter(Boolean)
      .map((v) => {
        const [type, subtype, stamp, foil, size] = v.split(',');
        return { type, ...(subtype && { subtype }), ...(stamp && { stamp: stamp.split('+') }), ...(foil && { foil }), size: size || 'standard' };
      });
    const has = (type, stamp) => detailed.some((v) => v.type === type && (!stamp || (v.stamp || []).includes(stamp)));
    return {
      id,
      hp: hp ? +hp : undefined,
      stage: pick(stages, stage),
      rarity: pick(rarities, rarity),
      illustrator: pick(illustrators, illus),
      regulationMark: reg || undefined,
      attacks: attacks ? attacks.split('~').map((name) => ({ name })) : [],
      abilities: abilities ? abilities.split('~').map((name) => ({ type: 'Ability', name })) : [],
      effect: effect || undefined,
      variants: { normal: has('normal'), reverse: has('reverse'), holo: has('holo'), firstEdition: has('holo', '1st-edition') || has('normal', '1st-edition') },
      variants_detailed: detailed,
    };
  };
  return { size: cards.length, card };
}
