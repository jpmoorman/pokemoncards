// Unit tests for the PP-OCR helpers (js/ppocr.js) on plain arrays: no runtime, no models.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDict, toTensor, detSize, detScale, textBoxes, ctcDecode, recGroups, readingOrder, createReader, DET, REC, MAX_SIDE } from '../js/ppocr.js';

/** An RGBA image w × h filled by f(x, y) -> [r, g, b]. */
function image(w, h, f) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([...f(x, y), 255], (y * w + x) * 4);
  return { width: w, height: h, data };
}

test('dictionary: blank first, one class per line, space last', () => {
  assert.deepEqual(parseDict('a\nb\n★\n'), ['', 'a', 'b', '★', ' ']);
  assert.deepEqual(parseDict('a\nb'), ['', 'a', 'b', ' ']);
});

test('tensor: planar blue, green, red, scaled to -1..1', () => {
  const img = image(2, 1, (x) => (x ? [255, 0, 0] : [0, 0, 255]));
  const t = toTensor(img, 0, 0, 2, 1, 2, 1);
  // planes: B, G, R; pixel 0 is blue, pixel 1 red
  assert.deepEqual([...t], [1, -1, -1, -1, -1, 1]);
});

test('tensor: zero padding on the right, and written into a batch at an offset', () => {
  const img = image(1, 1, () => [255, 255, 255]);
  const t = toTensor(img, 0, 0, 1, 1, 1, 1, 3);
  assert.deepEqual([...t], [1, 0, 0, 1, 0, 0, 1, 0, 0]);
  const batch = new Float32Array(18);
  toTensor(img, 0, 0, 1, 1, 1, 1, 3, batch, 9);
  assert.deepEqual([...batch.slice(0, 9)], new Array(9).fill(0));
  assert.deepEqual([...batch.slice(9)], [1, 0, 0, 1, 0, 0, 1, 0, 0]);
});

test('tensor: bilinear resize of an area', () => {
  // A horizontal ramp 0, 100, 200 (red only), its middle two pixels read at twice the size.
  const img = image(3, 1, (x) => [x * 100, 0, 0]);
  const t = toTensor(img, 1, 0, 1, 1, 2, 1);
  const red = [...t.slice(4, 6)].map((v) => Math.round((v + 1) * 127.5));
  assert.deepEqual(red, [75, 125]);
});

test('detector size: multiples of 32, at least 32; scale capped by the long side', () => {
  assert.deepEqual(detSize(860, 238, 960 / 860), [960, 256]);
  assert.deepEqual(detSize(10, 10, 1), [32, 32]);
  assert.equal(detScale(500, 100, { width: 800 }), 1.6);
  assert.equal(detScale(1000, 1400), MAX_SIDE / 1400);
  assert.equal(detScale(400, 300), 1);
});

test('text boxes: one box per blob, grown by unclip, in source pixels', () => {
  const W = 64;
  const H = 32;
  const prob = new Float32Array(W * H);
  const fill = (x0, y0, x1, y1, v) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) prob[y * W + x] = v;
  };
  fill(10, 10, 29, 15, 0.9); // a line of text
  fill(40, 20, 50, 25, 0.4); // above thresh, but its pixels average under boxThresh
  fill(60, 2, 60, 2, 0.95); // too small
  const boxes = textBoxes(prob, W, H, { x: 100, y: 50, w: 128, h: 64 });
  assert.equal(boxes.length, 1);
  // The blob plus the 1 px dilation: x 10..30, y 10..16 (21 × 7); unclip d = 21·7·1.6 / (2·28).
  const d = (21 * 7 * DET.unclip) / (2 * 28);
  const want = [100 + (10 - d) * 2, 50 + (10 - d) * 2, 100 + (31 + d) * 2, 50 + (17 + d) * 2];
  boxes[0].forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-9, `${v} vs ${want[i]}`));
});

test('text boxes: clipped to the area', () => {
  const prob = new Float32Array(32 * 32).fill(0.9);
  assert.deepEqual(textBoxes(prob, 32, 32, { x: 0, y: 0, w: 32, h: 32 }), [[0, 0, 32, 32]]);
});

test('CTC decoding: repeats merged, blanks dropped, mean score', () => {
  const chars = ['', 'A', 'B', ' '];
  // 6 steps: A A blank A B B -> "AAB"
  const steps = [1, 1, 0, 1, 2, 2];
  const data = new Float32Array(steps.length * 4);
  steps.forEach((c, t) => {
    data.fill(0.1, t * 4, t * 4 + 4);
    data[t * 4 + c] = c ? 0.8 : 0.9;
  });
  data[1 * 4 + 1] = 0.6; // a repeat's score doesn't count
  const r = ctcDecode(data, 6, 4, chars);
  assert.equal(r.text, 'AAB');
  assert.ok(Math.abs(r.score - 0.8) < 1e-6, String(r.score));
  // Second line of a batch.
  const two = new Float32Array(2 * 6 * 4);
  two.set(data, 24);
  assert.equal(ctcDecode(two, 6, 4, chars, 1).text, 'AAB');
  assert.deepEqual(ctcDecode(new Float32Array(8).fill(0).map((_, i) => (i % 4 ? 0 : 1)), 2, 4, chars), { text: '', score: 0 });
});

test('recognizer batches: by width, at most 6, padded to the widest (min 320 px)', () => {
  const boxes = [[0, 0, 480, 48], ...Array.from({ length: 6 }, (_, i) => [0, 0, 48 * (i + 1), 48])];
  const groups = recGroups(boxes);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].items.length, REC.batch);
  assert.equal(groups[0].padW, 320);
  assert.deepEqual(groups[0].items.map((x) => x.w), [48, 96, 144, 192, 240, 288]);
  assert.deepEqual(groups[1].items.map((x) => x.box), [[0, 0, 480, 48]]);
  assert.equal(groups[1].padW, 480);
});

test('reading order: top to bottom in bands, then left to right', () => {
  const lines = [{ box: [50, 101] }, { box: [0, 300] }, { box: [10, 95] }];
  assert.deepEqual(readingOrder(lines).map((l) => l.box[0]), [10, 50, 0]);
});

test('reader: finds the text block, reads it, boxes in image pixels', async () => {
  const chars = parseDict('A\nB\n');
  const calls = [];
  // A fake detector that sees text in the left half of the top rows, and a recognizer that
  // reads "AB" for every line.
  const run = async (model, data, dims) => {
    calls.push([model, dims]);
    if (model === 'det') {
      const [, , H, W] = dims;
      const p = new Float32Array(W * H);
      for (let y = 4; y < 12; y++) for (let x = 2; x < W / 2; x++) p[y * W + x] = 0.95;
      return { data: p, dims: [1, 1, H, W] };
    }
    const [n, , , w] = dims;
    const T = w / 8;
    const C = chars.length;
    const out = new Float32Array(n * T * C);
    for (let i = 0; i < n; i++) for (let t = 0; t < T; t++) out[(i * T + t) * C + (t === 1 ? 1 : t === 3 ? 2 : 0)] = 1;
    return { data: out, dims: [n, T, C] };
  };
  const img = image(200, 100, () => [255, 255, 255]);
  const [area] = await createReader(run, chars).read(img, [{ x: 0, y: 0.5, w: 1, h: 0.5, width: 320 }]);
  assert.deepEqual(calls.map((c) => c[0]), ['det', 'rec']);
  // 200 × 50 px searched at 320 px wide: 320 × 80, rounded to 96 rows.
  assert.deepEqual(calls[0][1], [1, 3, 96, 320]);
  assert.equal(area.lines.length, 1);
  assert.equal(area.lines[0].text, 'AB');
  // The left half of the area's top rows (grown a little), in image pixels.
  const [x0, y0, x1, y1] = area.lines[0].box;
  assert.ok(x0 < 5 && x1 > 95 && x1 < 110 && y0 >= 50 && y1 < 65, area.lines[0].box.join());
});
