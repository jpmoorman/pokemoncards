// Unit tests for photo scanning: card finding / straightening (detect.js), the
// card-name dictionary (match.findNamesInText) and number parsing tweaks.
//   node --test tests/detect.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { orderCorners, rotateCorners, homography, applyHomography, warpImageData, findCardQuads, quadSize, CARD_ASPECT } from '../js/detect.js';
import { buildIndex, findNamesInText, editDistance } from '../js/match.js';
import { parseBottomText } from '../js/parse.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);

// ---------- synthetic scenes ----------

function rng(seed) {
  let s = seed * 9301 + 49297;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

/**
 * Corners of a card centred at (cx, cy), `w` px wide, tipped back by `tilt` degrees
 * (pinhole camera, focal length 400 px) and turned by `deg`. `sx`/`sy` stretch it
 * (for a toploader around the card).
 */
function cardCorners(cx, cy, w, deg = 0, tilt = 0, sx = 1, sy = 1) {
  const h = w / CARD_ASPECT;
  const a = (deg * Math.PI) / 180;
  const t = (tilt * Math.PI) / 180;
  const f = 400;
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([x0, y0]) => {
    const x = x0 * sx;
    const y = y0 * sy;
    const z = f - y * Math.sin(t);
    const px = (f * x) / z;
    const py = (f * y * Math.cos(t)) / z;
    return { x: cx + px * Math.cos(a) - py * Math.sin(a), y: cy + px * Math.sin(a) + py * Math.cos(a) };
  });
}

/**
 * Rasterise a photo-like RGBA scene: textured background, optional toploader, the card
 * (border, inner panel, name and number text blocks, artwork) and an optional sticker
 * over the top-right corner. 2×2 supersampled so edges are soft like a real photo.
 */
function scene({ w = 384, h = 512, corners, holder, sticker = false, background = [140, 118, 92], noise = 60, border = [201, 204, 209], seed = 1 }) {
  const rand = rng(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  const unit = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const toCard = corners && homography(corners, unit);
  const toHolder = holder && homography(holder, unit);
  const bg = new Float32Array(w * h);
  for (let i = 0; i < bg.length; i++) bg[i] = (rand() - 0.5) * noise;
  const colour = (x, y) => {
    const n = bg[Math.min(h - 1, y | 0) * w + Math.min(w - 1, x | 0)];
    let c = [background[0] + n, background[1] + n * 0.9, background[2] + n * 0.8];
    if (toHolder) {
      const q = applyHomography(toHolder, x, y);
      if (q.x >= 0 && q.x <= 1 && q.y >= 0 && q.y <= 1) c = c.map((v) => v * 0.75 + 255 * 0.25); // hazy plastic
    }
    if (toCard) {
      const { x: u, y: v } = applyHomography(toCard, x, y);
      if (sticker && u > 0.72 && u < 1.12 && v > -0.06 && v < 0.12) return [246, 245, 240];
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
        if (u < 0.045 || u > 0.955 || v < 0.032 || v > 0.968) return border;
        if (v > 0.05 && v < 0.09 && u > 0.2 && u < 0.55 && Math.sin(u * 160) > -0.2) return [20, 20, 20]; // name
        if (v > 0.93 && v < 0.95 && u > 0.08 && u < 0.4 && Math.sin(u * 300) > 0) return [30, 30, 30]; // number
        if (v > 0.12 && v < 0.48 && u > 0.08 && u < 0.92) return [200 * u + 40, 90, 220 * v + 40]; // artwork
        if (v > 0.55 && v < 0.85 && u > 0.1 && u < 0.85 && Math.sin(v * 220) > 0.6 && Math.sin(u * 200) > -0.3) return [40, 40, 40]; // text
        return [241, 237, 227];
      }
    }
    return c;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const [dx, dy] of [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ]) {
        const c = colour(x + dx, y + dy);
        r += c[0];
        g += c[1];
        b += c[2];
      }
      const i = (y * w + x) * 4;
      data[i] = r / 4;
      data[i + 1] = g / 4;
      data[i + 2] = b / 4;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** Largest corner distance as a fraction of the card width. */
function cornerError(found, truth) {
  const w = quadSize(truth).w;
  return Math.max(...found.map((p, i) => Math.hypot(p.x - truth[i].x, p.y - truth[i].y))) / w;
}

// ---------- geometry ----------

test('orderCorners: any order in, top-left first and clockwise out', () => {
  const truth = cardCorners(200, 250, 180, 12);
  for (const perm of [
    [2, 0, 3, 1],
    [3, 2, 1, 0],
    [1, 3, 0, 2],
  ]) {
    const got = orderCorners(perm.map((i) => truth[i]));
    got.forEach((p, i) => assert.deepEqual(p, { x: truth[i].x, y: truth[i].y }));
  }
  // A wide (landscape) box too.
  const wide = orderCorners([
    { x: 300, y: 100 },
    { x: 20, y: 30 },
    { x: 290, y: 20 },
    { x: 30, y: 110 },
  ]);
  assert.deepEqual(wide, [
    { x: 20, y: 30 },
    { x: 290, y: 20 },
    { x: 300, y: 100 },
    { x: 30, y: 110 },
  ]);
  assert.deepEqual(rotateCorners([1, 2, 3, 4], 1), [2, 3, 4, 1]);
  assert.deepEqual(rotateCorners([1, 2, 3, 4], -1), [4, 1, 2, 3]);
});

test('homography maps the four points exactly and in between consistently', () => {
  const from = [
    { x: 0, y: 0 },
    { x: 630, y: 0 },
    { x: 630, y: 880 },
    { x: 0, y: 880 },
  ];
  const to = [
    { x: 105, y: 80 },
    { x: 330, y: 120 },
    { x: 300, y: 450 },
    { x: 60, y: 400 },
  ];
  const H = homography(from, to);
  from.forEach((p, i) => {
    const q = applyHomography(H, p.x, p.y);
    near(q.x, to[i].x, 1e-6);
    near(q.y, to[i].y, 1e-6);
  });
  // Lines stay lines: the card centre maps to where the diagonals cross.
  const c = applyHomography(H, 315, 440);
  const d1 = (t) => ({ x: to[0].x + (to[2].x - to[0].x) * t, y: to[0].y + (to[2].y - to[0].y) * t });
  const t = ((c.x - to[0].x) * (to[2].x - to[0].x) + (c.y - to[0].y) * (to[2].y - to[0].y)) / ((to[2].x - to[0].x) ** 2 + (to[2].y - to[0].y) ** 2);
  near(Math.hypot(d1(t).x - c.x, d1(t).y - c.y), 0, 1e-6, 'centre on diagonal');
  // Round trip.
  const back = homography(to, from);
  const r = applyHomography(back, c.x, c.y);
  near(r.x, 315, 1e-6);
  near(r.y, 440, 1e-6);
  // Degenerate (source points on one line) -> null.
  const line = [0, 1, 2, 3].map((i) => ({ x: i * 10, y: i * 5 }));
  assert.equal(homography(line, to), null);
});

test('warpImageData samples the source through the homography (bilinear)', () => {
  // Source: R = x, G = y, so every pixel says where it came from.
  const sw = 200;
  const sh = 160;
  const data = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) data.set([x, y, 0, 255], (y * sw + x) * 4);
  // Output 50×40 pixels covering the source rectangle (40,30)-(140,110): scale 2 + shift.
  const H = homography(
    [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 40 },
      { x: 0, y: 40 },
    ],
    [
      { x: 40, y: 30 },
      { x: 140, y: 30 },
      { x: 140, y: 110 },
      { x: 40, y: 110 },
    ],
  );
  const out = warpImageData({ width: sw, height: sh, data }, H, 50, 40);
  const px = (x, y) => [...out.data.subarray((y * 50 + x) * 4, (y * 50 + x) * 4 + 3)];
  // Output pixel centre (x+0.5) -> source 40 + 2(x+0.5) = pixel centre value 40 + 2x + 0.5.
  near(px(0, 0)[0], 40.5, 1);
  near(px(0, 0)[1], 30.5, 1);
  near(px(25, 20)[0], 90.5, 1);
  near(px(25, 20)[1], 70.5, 1);
  near(px(49, 39)[0], 138.5, 1);
  // Outside the source: fill colour.
  const off = warpImageData({ width: sw, height: sh, data }, homography(
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
    [
      { x: 500, y: 500 },
      { x: 510, y: 500 },
      { x: 510, y: 510 },
      { x: 500, y: 510 },
    ],
  ), 10, 10, [1, 2, 3]);
  assert.deepEqual([...off.data.subarray(0, 4)], [1, 2, 3, 255]);
});

// ---------- finding the card ----------

test('finds an upright card on a textured background', () => {
  const truth = cardCorners(190, 260, 200);
  const quads = findCardQuads(scene({ corners: truth }));
  assert.ok(quads.length, 'no card found');
  assert.ok(cornerError(quads[0].corners, truth) < 0.02, `error ${cornerError(quads[0].corners, truth)}`);
});

test('finds a turned, tilted card', () => {
  for (const [deg, tilt] of [
    [8, 8],
    [-14, 16],
  ]) {
    const truth = cardCorners(195, 255, 190, deg, tilt);
    const quads = findCardQuads(scene({ corners: truth, seed: 3 }));
    assert.ok(quads.length, `no card at ${deg}°`);
    assert.ok(cornerError(quads[0].corners, truth) < 0.025, `${deg}°: error ${cornerError(quads[0].corners, truth)}`);
  }
});

test('prefers the card over the toploader around it', () => {
  const truth = cardCorners(192, 262, 190, -4, 6);
  const holder = cardCorners(192, 254, 190, -4, 6, 1.22, 1.16); // ~22% wider, 16% taller
  const quads = findCardQuads(scene({ corners: truth, holder, seed: 5 }));
  assert.ok(quads.length, 'nothing found');
  const err = cornerError(quads[0].corners, truth);
  assert.ok(err < 0.025, `picked the wrong outline (error ${err.toFixed(3)})`);
});

test('a sticker over a corner does not stop it', () => {
  const truth = cardCorners(190, 262, 200, 5);
  const quads = findCardQuads(scene({ corners: truth, sticker: true, seed: 7 }));
  assert.ok(quads.length, 'nothing found');
  const err = cornerError(quads[0].corners, truth);
  assert.ok(err < 0.03, `error ${err.toFixed(3)}`);
});

test('a faint silver border on a light table is still found', () => {
  // Border and table differ by ~15 levels, too close to tell the border from a clear
  // holder's margin, so the outline may land on the card's inner frame (~4% in on each
  // side, 7% at a corner). That still crops the name and number fine.
  const truth = cardCorners(190, 255, 210, 3);
  const quads = findCardQuads(scene({ corners: truth, background: [214, 212, 206], noise: 8, seed: 9 }));
  assert.ok(quads.length, 'nothing found');
  assert.ok(cornerError(quads[0].corners, truth) < 0.075, `error ${cornerError(quads[0].corners, truth)}`);
});

test('no card: nothing confident', () => {
  const quads = findCardQuads(scene({ seed: 11 }));
  assert.ok(!quads.length || quads[0].score < 0.45, `found ${JSON.stringify(quads[0]?.corners)} score ${quads[0]?.score}`);
});

test('finding the card is fast enough for a phone', () => {
  const img = scene({ corners: cardCorners(190, 260, 200, 6, 6), seed: 13 });
  findCardQuads(img); // warm-up
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) findCardQuads(img);
  const ms = (performance.now() - t0) / 5;
  // Phones are ~3-4× slower than this machine; the target there is < 300 ms.
  assert.ok(ms < 80, `${ms.toFixed(1)} ms per photo`);
});

// ---------- card-name dictionary ----------

const fx = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const catalog = fx('catalog.json');
const index = buildIndex(catalog.cards, catalog.sets);
const names = (text) => findNamesInText(index, text).map((r) => r.name);

test('finds a known card name inside noisy OCR text', () => {
  assert.equal(names('a fs - i) pp Saag PRE Aur0rus')[0], 'Aurorus');
  assert.equal(names('PREC AUrorus ud] **/')[0], 'Aurorus');
  assert.equal(names('STAGE2 Aurorus HP 170 Evolves from Amaura')[0], 'Aurorus');
  assert.equal(names('Pokernon Catcher')[0], 'Pokémon Catcher');
  assert.deepEqual(names('PRE att Voy'), []);
});

test('skips the "Evolves from" name and short names inside other words', () => {
  assert.deepEqual(names('Evolves from Amaura'), []);
  assert.ok(!names('xx Evolves fram Amaura Tundra Wall').includes('Amaura'));
  // "Mew ex" must not be found inside "Mewtwo ex"; whole words only for short names.
  assert.deepEqual(names('Mewtwo ex HP 230'), ['Mewtwo ex']);
});

test('prefers the longer exact name ("Charizard ex" over "Charizard")', () => {
  assert.equal(names('STAGE 2 Charizard ex HP 330')[0], 'Charizard ex');
  assert.equal(names('Charlzard ex 330')[0], 'Charizard ex');
});

test('dictionary lookup is fast across ~20k card names', () => {
  const rand = rng(21);
  const syll = ['char', 'iz', 'ard', 'pi', 'ka', 'chu', 'mew', 'two', 'au', 'ro', 'rus', 'tin', 'ka', 'tink', 'ma', 'ra', 'saur', 'bul', 'ba', 'sa', 'ex', 'gx'];
  const cards = [];
  for (let i = 0; i < 20000; i++) {
    let n = '';
    for (let k = 0; k < 2 + Math.floor(rand() * 3); k++) n += syll[Math.floor(rand() * syll.length)];
    cards.push({ id: `sv01-${i}`, localId: String(i), name: n[0].toUpperCase() + n.slice(1) + (rand() < 0.2 ? ' ex' : '') });
  }
  cards.push({ id: 'sv01-99999', localId: '99999', name: 'Aurorus' });
  const big = buildIndex(cards, [{ id: 'sv01', name: 'Scarlet & Violet', cardCount: { official: 198, total: 258 } }]);
  const text = `${'All of your Pokémon that have any Energy attached take 50 less damage from attacks. '.repeat(10)} Aur0rus`;
  findNamesInText(big, text); // builds the name table once
  const t0 = performance.now();
  const hits = findNamesInText(big, text);
  const ms = performance.now() - t0;
  assert.ok(hits.some((h) => h.name === 'Aurorus'), JSON.stringify(hits));
  assert.ok(ms < 150, `${ms.toFixed(1)} ms`);
});

test('edit distance', () => {
  assert.equal(editDistance('aurorus', 'aur0rus'), 1);
  assert.equal(editDistance('aurorus', 'auroru'), 1);
  assert.equal(editDistance('abc', 'xyz', 1), 2); // gave up past the limit
});

test('number with the slash read as a comma or full stop', () => {
  assert.equal(parseBottomText('J Td 024.088 »').numbers[0].text, '024/088');
  assert.equal(parseBottomText('J dD 024,088 »').numbers[0].text, '024/088');
  // ...but not heights/weights or plain numbers.
  assert.equal(parseBottomText("HT 8.10 WT 496.0 lbs").numbers.length, 0);
});
