// PaddleOCR (PP-OCR) text reading, minus the runtime: an image area to the detector's input,
// text boxes from the detector's output, text from the recognizer's output. No DOM and no
// ONNX runtime here: ocr-worker.js runs the models, the unit tests run these on plain arrays.
// Text on a straightened card runs level, so text boxes are plain rectangles.
//   const reader = createReader(run, chars);   // run(model, data, dims) -> { data, dims }
//   const [area] = await reader.read(image, [{ x: 0, y: 0, w: 1, h: 0.17, width: 960 }]);
//   area.lines  // [{ text, score, box: [x0, y0, x1, y1] }] in image pixels, reading order

// Text finding (DB post-processing, as RapidOCR does it): a pixel is text above `thresh`;
// a box is kept when its pixels average `boxThresh` or more and it is `minSize` px or more
// both ways, then grown by area × `unclip` / perimeter (the model's boxes hug the letters).
export const DET = { thresh: 0.3, boxThresh: 0.5, unclip: 1.6, minSize: 3 };
// The recognizer reads one line 48 px tall, at least 320 px wide, a few lines at a time.
export const REC = { height: 48, minWidth: 320, batch: 6 };
// A whole card or picture is searched for text at most this big (long side): reading time
// and memory grow with it, and reads came out the same as at 1440 px.
export const MAX_SIDE = 960;

/** The recognizer's classes from its dictionary file: blank first, then one per line, then a space. */
export function parseDict(text) {
  const keys = String(text).split('\n');
  if (keys.at(-1) === '') keys.pop();
  return ['', ...keys, ' '];
}

/**
 * The model input for an area (sx, sy, sw, sh in pixels) of an RGBA image
 * ({ width, height, data }, e.g. ImageData), resized (bilinear) to W × H and padded with
 * zeros to padW wide: planar blue, green, red, each (v / 255 - 0.5) / 0.5.
 * Written into `out` at `offset` when given (a batch), else into a new array.
 */
export function toTensor(src, sx, sy, sw, sh, W, H, padW = W, out = null, offset = 0) {
  const plane = H * padW;
  out ||= new Float32Array(3 * plane);
  const { width: iw, height: ih, data: d } = src;
  const fx = sw / W;
  const fy = sh / H;
  const xs = new Int32Array(2 * W);
  const tx = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const u = Math.min(iw - 1, Math.max(0, sx + (x + 0.5) * fx - 0.5));
    const x0 = u | 0;
    xs[2 * x] = x0 * 4;
    xs[2 * x + 1] = Math.min(iw - 1, x0 + 1) * 4;
    tx[x] = u - x0;
  }
  for (let y = 0; y < H; y++) {
    const v = Math.min(ih - 1, Math.max(0, sy + (y + 0.5) * fy - 0.5));
    const y0 = v | 0;
    const r0 = y0 * iw * 4;
    const r1 = Math.min(ih - 1, y0 + 1) * iw * 4;
    const ty = v - y0;
    const o = offset + y * padW;
    for (let x = 0; x < W; x++) {
      const a = r0 + xs[2 * x];
      const b = r0 + xs[2 * x + 1];
      const c = r1 + xs[2 * x];
      const e = r1 + xs[2 * x + 1];
      const t = tx[x];
      for (let ch = 0; ch < 3; ch++) {
        const top = d[a + ch] + (d[b + ch] - d[a + ch]) * t;
        const bottom = d[c + ch] + (d[e + ch] - d[c + ch]) * t;
        out[(2 - ch) * plane + o + x] = (top + (bottom - top) * ty) / 127.5 - 1;
      }
    }
  }
  return out;
}

/** Detector input size for an area w × h px shown `scale` times as big: multiples of 32, at least 32. */
export function detSize(w, h, scale) {
  return [Math.max(32, Math.round((w * scale) / 32) * 32), Math.max(32, Math.round((h * scale) / 32) * 32)];
}

/**
 * How much to scale an area w × h px for text finding: to `width` px wide when given, else
 * as is; never more than `maxSide` px on its long side.
 */
export function detScale(w, h, { width = 0, maxSide = MAX_SIDE } = {}) {
  return Math.min(width ? width / w : 1, maxSide / Math.max(w, h));
}

/**
 * Text boxes from the detector's text probability map `prob` (W × H) of an area `rect`
 * ({ x, y, w, h } in source pixels): the map thresholded and grown by a pixel (like
 * PaddleOCR's dilation), 8-connected parts, each part's bounding box grown (unclip).
 * Returns [[x0, y0, x1, y1], …] in source pixels.
 */
export function textBoxes(prob, W, H, rect, o = DET) {
  const bin = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (prob[i] > o.thresh || (x > 0 && prob[i - 1] > o.thresh) || (y > 0 && prob[i - W] > o.thresh) || (x > 0 && y > 0 && prob[i - W - 1] > o.thresh)) bin[i] = 1;
    }
  }
  const seen = new Uint8Array(W * H);
  const boxes = [];
  const stack = [];
  const sx = rect.w / W;
  const sy = rect.h / H;
  for (let s = 0; s < W * H; s++) {
    if (!bin[s] || seen[s]) continue;
    let x0 = W;
    let y0 = H;
    let x1 = 0;
    let y1 = 0;
    let sum = 0;
    let n = 0;
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      const x = i % W;
      const y = (i - x) / W;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      sum += prob[i];
      n++;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const j = yy * W + xx;
          if (bin[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    if (Math.min(bw, bh) < o.minSize || sum / n < o.boxThresh) continue;
    const d = (bw * bh * o.unclip) / (2 * (bw + bh));
    boxes.push([rect.x + Math.max(0, x0 - d) * sx, rect.y + Math.max(0, y0 - d) * sy, rect.x + Math.min(W, x1 + 1 + d) * sx, rect.y + Math.min(H, y1 + 1 + d) * sy]);
  }
  return boxes;
}

/**
 * Best path through the recognizer's output for line `i` of a batch (`data`: N × T × C
 * class scores): repeats and blanks dropped. Returns { text, score }, score the mean of the
 * kept characters' scores (0 when none).
 */
export function ctcDecode(data, T, C, chars, i = 0) {
  let text = '';
  let conf = 0;
  let kept = 0;
  let prev = -1;
  for (let t = 0; t < T; t++) {
    const base = (i * T + t) * C;
    let best = 0;
    let bp = -Infinity;
    for (let c = 0; c < C; c++) {
      if (data[base + c] > bp) {
        bp = data[base + c];
        best = c;
      }
    }
    if (best !== 0 && best !== prev) {
      text += chars[best] ?? '';
      conf += bp;
      kept++;
    }
    prev = best;
  }
  return { text, score: kept ? conf / kept : 0 };
}

/**
 * Boxes in recognizer batches: sorted by width to height (less padding), `batch` per
 * group, each group padded to its widest line (at least REC.minWidth).
 * Returns [{ items: [{ box, w }], padW }].
 */
export function recGroups(boxes, batch = REC.batch) {
  const items = boxes.map((box) => ({ box, ratio: (box[2] - box[0]) / Math.max(1, box[3] - box[1]) })).sort((a, b) => a.ratio - b.ratio);
  const groups = [];
  for (let k = 0; k < items.length; k += batch) {
    const g = items.slice(k, k + batch);
    const maxRatio = Math.max(REC.minWidth / REC.height, ...g.map((x) => x.ratio));
    const padW = Math.ceil(REC.height * maxRatio);
    groups.push({ padW, items: g.map((x) => ({ box: x.box, w: Math.min(padW, Math.ceil(REC.height * x.ratio)) })) });
  }
  return groups;
}

/** Lines in reading order: top to bottom (in 20 px bands), then left to right. */
export function readingOrder(lines) {
  return lines.sort((a, b) => Math.round(a.box[1] / 20) - Math.round(b.box[1] / 20) || a.box[0] - b.box[0]);
}

/**
 * Text reading with the two models behind `run(model, data, dims)` ('det' or 'rec'; resolves
 * to the output { data, dims }) and the recognizer's classes `chars` (parseDict).
 */
export function createReader(run, chars) {
  /** Text boxes in an area `r` (source pixels) of `src`, searched at `scale`. */
  async function detect(src, r, scale) {
    const [W, H] = detSize(r.w, r.h, scale);
    const out = await run('det', toTensor(src, r.x, r.y, r.w, r.h, W, H), [1, 3, H, W]);
    return textBoxes(out.data, W, H, r);
  }

  /** Each box read as one line of text. */
  async function recognize(src, boxes) {
    const lines = [];
    for (const g of recGroups(boxes)) {
      const size = 3 * REC.height * g.padW;
      const data = new Float32Array(g.items.length * size);
      g.items.forEach(({ box, w }, i) => toTensor(src, box[0], box[1], box[2] - box[0], box[3] - box[1], w, REC.height, g.padW, data, i * size));
      const out = await run('rec', data, [g.items.length, 3, REC.height, g.padW]);
      const [, T, C] = out.dims;
      g.items.forEach(({ box }, i) => {
        const { text, score } = ctcDecode(out.data, T, C, chars, i);
        if (text.trim()) lines.push({ text, score, box });
      });
    }
    return readingOrder(lines);
  }

  return {
    /**
     * Read areas of an RGBA image ({ width, height, data }). Each area is
     * { x, y, w, h } in fractions of the image, plus `width` (search for text at that width)
     * or `maxSide` (see detScale). Returns per area { lines, ms: { det, rec } }.
     */
    async read(src, areas) {
      const out = [];
      for (const a of areas) {
        const r = { x: a.x * src.width, y: a.y * src.height, w: a.w * src.width, h: a.h * src.height };
        const t0 = performance.now();
        const boxes = await detect(src, r, detScale(r.w, r.h, a));
        const t1 = performance.now();
        const lines = await recognize(src, boxes);
        out.push({ lines, ms: { det: Math.round(t1 - t0), rec: Math.round(performance.now() - t1) } });
      }
      return out;
    },
  };
}
