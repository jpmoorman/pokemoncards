// Finds a Pokémon card in a photo and straightens it (perspective correction).
// Pure JS on ImageData, no OpenCV: colour Sobel edges -> Hough lines -> the best
// card-shaped quadrilateral -> homography warp to an upright card.
//   const found = detectCard(photoCanvas);           // null when no confident card
//   const card = found && warpCard(photoCanvas, found.corners);
// The pure helpers (findCardQuads, homography, warpImageData, …) take plain
// { width, height, data } objects so they also run (and are tested) in Node.

export const CARD_ASPECT = 63 / 88;

const DEG = Math.PI / 180;
const NT = 180; // Hough angle bins, 1° each
const COS = new Float32Array(NT);
const SIN = new Float32Array(NT);
for (let i = 0; i < NT; i++) {
  COS[i] = Math.cos(i * DEG);
  SIN[i] = Math.sin(i * DEG);
}

const DEFAULTS = {
  detectSize: 512, // long side of the copy used for detection
  minArea: 0.03, // smallest card, as a fraction of the photo
  maxAspectError: 0.2, // |ln(found aspect / card aspect)|
  maxLines: 40,
};

// ---------------- geometry ----------------

/** Sort four points into [top-left, top-right, bottom-right, bottom-left]. */
export function orderCorners(pts) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  // Clockwise on screen (y down), then start from the top-left-most point.
  const ring = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let first = 0;
  ring.forEach((p, i) => p.x + p.y < ring[first].x + ring[first].y && (first = i));
  return ring.map((_, i) => ({ x: ring[(i + first) % 4].x, y: ring[(i + first) % 4].y }));
}

/** Rotate corner labels by k quarter turns (k=2 turns the card upside down). */
export function rotateCorners(corners, k) {
  const n = ((k % 4) + 4) % 4;
  return corners.map((_, i) => corners[(i + n) % 4]);
}

/**
 * 3×3 homography (row-major, h[8] = 1) mapping each `from` point onto the matching `to` point.
 * Solves the standard 8×8 linear system (direct linear transform).
 */
export function homography(from, to) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      if (f) for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  h.push(1);
  return h;
}

export function applyHomography(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

/**
 * Perspective-warp `src` (RGBA { width, height, data }) into a new width×height image.
 * `h` maps output pixel coordinates to source coordinates. Bilinear sampling;
 * pixels that fall outside the source are filled with `fill`.
 */
export function warpImageData(src, h, width, height, fill = [245, 245, 245]) {
  const data = new Uint8ClampedArray(width * height * 4);
  const out = new Uint32Array(data.buffer); // one write per pixel (little-endian RGBA)
  const blank = (255 << 24) | (fill[2] << 16) | (fill[1] << 8) | fill[0];
  const sw = src.width;
  const sh = src.height;
  const d = src.data;
  const SPAN = 16; // exact perspective every 16 px, linear in between (error ≪ 0.1 px)
  let o = 0;
  for (let y = 0; y < height; y++) {
    const yc = y + 0.5;
    let W = h[6] * 0.5 + h[7] * yc + h[8];
    let ax = (h[0] * 0.5 + h[1] * yc + h[2]) / W - 0.5;
    let ay = (h[3] * 0.5 + h[4] * yc + h[5]) / W - 0.5;
    for (let x0 = 0; x0 < width; x0 += SPAN) {
      const n = Math.min(SPAN, width - x0);
      const xe = x0 + n + 0.5;
      W = h[6] * xe + h[7] * yc + h[8];
      const bx = (h[0] * xe + h[1] * yc + h[2]) / W - 0.5;
      const by = (h[3] * xe + h[4] * yc + h[5]) / W - 0.5;
      const stepX = (bx - ax) / n;
      const stepY = (by - ay) / n;
      let sx = ax;
      let sy = ay;
      for (let k = 0; k < n; k++, o++, sx += stepX, sy += stepY) {
        const ix = sx | 0;
        const iy = sy | 0;
        if (sx < 0 || sy < 0 || ix >= sw - 1 || iy >= sh - 1) {
          out[o] = blank;
          continue;
        }
        const fx = sx - ix;
        const fy = sy - iy;
        const i00 = (iy * sw + ix) << 2;
        const i01 = i00 + (sw << 2);
        const w11 = fx * fy;
        const w10 = fx - w11;
        const w01 = fy - w11;
        const w00 = 1 - fx - w01;
        const r = d[i00] * w00 + d[i00 + 4] * w10 + d[i01] * w01 + d[i01 + 4] * w11;
        const g = d[i00 + 1] * w00 + d[i00 + 5] * w10 + d[i01 + 1] * w01 + d[i01 + 5] * w11;
        const b = d[i00 + 2] * w00 + d[i00 + 6] * w10 + d[i01 + 2] * w01 + d[i01 + 6] * w11;
        out[o] = 0xff000000 | ((b + 0.5) << 16) | ((g + 0.5) << 8) | (r + 0.5);
      }
      ax = bx;
      ay = by;
    }
  }
  return { width, height, data };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function polygonArea(c) {
  let s = 0;
  for (let i = 0; i < c.length; i++) {
    const a = c[i];
    const b = c[(i + 1) % c.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** Card width/height in pixels as seen in the photo (averages opposite sides). */
export function quadSize(c) {
  return { w: (dist(c[0], c[1]) + dist(c[3], c[2])) / 2, h: (dist(c[0], c[3]) + dist(c[1], c[2])) / 2 };
}

function insideQuad(c, p, margin = 0) {
  // Clockwise quad: point is inside when it is on the inner side of every edge.
  for (let i = 0; i < 4; i++) {
    const a = c[i];
    const b = c[(i + 1) % 4];
    const len = dist(a, b) || 1;
    const cross = ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len;
    if (cross < -margin) return false;
  }
  return true;
}

// ---------------- edges ----------------

/**
 * Thin edges of an RGBA image: Sobel on each colour channel (so a yellow border on a
 * brown table counts even at equal brightness), strongest channel wins, then
 * non-maximum suppression. Returns { width, height, mag, ori, edge } where ori is
 * the edge normal in whole degrees 0..179 and edge is 0 (none) or 1..3 (strength).
 */
export function edgeMap(img) {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    r[i] = data[j];
    g[i] = data[j + 1];
    b[i] = data[j + 2];
  }
  const tmp = new Float32Array(n);
  blur121(r, tmp, w, h);
  blur121(g, tmp, w, h);
  blur121(b, tmp, w, h);
  const mag = new Float32Array(n);
  const gxA = new Float32Array(n);
  const gyA = new Float32Array(n);
  const hist = new Uint32Array(256);
  hist[0] = 2 * w + 2 * h - 4; // border pixels
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1, i = y * w + 1; x < w - 1; x++, i++) {
      const a = i - w;
      const c = i + w;
      let gx = r[a + 1] + 2 * r[i + 1] + r[c + 1] - r[a - 1] - 2 * r[i - 1] - r[c - 1];
      let gy = r[c - 1] + 2 * r[c] + r[c + 1] - r[a - 1] - 2 * r[a] - r[a + 1];
      let m = gx * gx + gy * gy;
      const gx2 = g[a + 1] + 2 * g[i + 1] + g[c + 1] - g[a - 1] - 2 * g[i - 1] - g[c - 1];
      const gy2 = g[c - 1] + 2 * g[c] + g[c + 1] - g[a - 1] - 2 * g[a] - g[a + 1];
      const m2 = gx2 * gx2 + gy2 * gy2;
      if (m2 > m) {
        m = m2;
        gx = gx2;
        gy = gy2;
      }
      const gx3 = b[a + 1] + 2 * b[i + 1] + b[c + 1] - b[a - 1] - 2 * b[i - 1] - b[c - 1];
      const gy3 = b[c - 1] + 2 * b[c] + b[c + 1] - b[a - 1] - 2 * b[a] - b[a + 1];
      const m3 = gx3 * gx3 + gy3 * gy3;
      if (m3 > m) {
        m = m3;
        gx = gx3;
        gy = gy3;
      }
      const v = Math.sqrt(m) / 4;
      mag[i] = v;
      gxA[i] = gx;
      gyA[i] = gy;
      hist[v < 255 ? v | 0 : 255]++;
    }
  }
  // Keep edges well above the scene's own texture: a carpet or wood grain raises the
  // bar, a plain table lets a faint silver border through.
  let median = 0;
  for (let acc = 0; median < 255 && (acc += hist[median]) < n / 2; median++);
  const thr = Math.max(5, 3 * median);
  // Non-maximum suppression along the gradient (4 sectors, tan 22.5° = 0.4142).
  // Skip a 3 px frame: the picture's own border (scans, blur at the edges) isn't a card.
  const ori = new Uint8Array(n);
  const edge = new Uint8Array(n);
  for (let y = 3; y < h - 3; y++) {
    for (let x = 3, i = y * w + 3; x < w - 3; x++, i++) {
      const m = mag[i];
      if (m < thr) continue;
      const gx = gxA[i];
      const gy = gyA[i];
      const ax = Math.abs(gx);
      const ay = Math.abs(gy);
      const j = ay <= 0.4142 * ax ? 1 : ax <= 0.4142 * ay ? w : gx * gy > 0 ? w + 1 : w - 1;
      if (m < mag[i + j] || m <= mag[i - j]) continue;
      edge[i] = m < 2 * thr ? 1 : m < 3 * thr ? 2 : 3; // strength, for weighted Hough votes
      let o = Math.round(Math.atan2(gy, gx) / DEG);
      if (o < 0) o += 180;
      ori[i] = o >= 180 ? o - 180 : o;
    }
  }
  return { width: w, height: h, mag, ori, edge };
}

function blur121(p, tmp, w, h) {
  for (let y = 0; y < h; y++) {
    const r = y * w;
    tmp[r] = p[r];
    tmp[r + w - 1] = p[r + w - 1];
    for (let x = 1; x < w - 1; x++) tmp[r + x] = (p[r + x - 1] + 2 * p[r + x] + p[r + x + 1]) / 4;
  }
  for (let x = 0; x < w; x++) {
    p[x] = tmp[x];
    p[(h - 1) * w + x] = tmp[(h - 1) * w + x];
  }
  for (let y = 1; y < h - 1; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) p[r + x] = (tmp[r + x - w] + 2 * tmp[r + x] + tmp[r + x + w]) / 4;
  }
}

const angDiff = (a, b) => {
  const d = Math.abs(a - b) % 180;
  return d > 90 ? 180 - d : d;
};

// ---------------- lines ----------------

/** Straight lines through the edge pixels: [{ t (normal angle, deg), rho, nx, ny, votes }], strongest first. */
export function houghLines(em, { maxLines = 40, minVotes } = {}) {
  const { width: w, height: h, edge, ori } = em;
  const diag = Math.ceil(Math.hypot(w, h));
  const nr = 2 * diag + 1;
  const acc = new Uint16Array(NT * nr);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!edge[i]) continue;
      const o = ori[i];
      const v = edge[i]; // strong edges (a card against the table) outvote texture
      // Vote only near the pixel's own edge direction: fast and far less noisy.
      for (let d = -2; d <= 2; d++) {
        let t = o + d;
        if (t < 0) t += NT;
        else if (t >= NT) t -= NT;
        acc[t * nr + Math.round(x * COS[t] + y * SIN[t]) + diag] += v;
      }
    }
  }
  const minV = minVotes ?? Math.max(12, Math.round(Math.min(w, h) * 0.08));
  const at = (t, r) => {
    if (t < 0) {
      t += NT;
      r = 2 * diag - r;
    } else if (t >= NT) {
      t -= NT;
      r = 2 * diag - r;
    }
    return r < 0 || r >= nr ? 0 : acc[t * nr + r];
  };
  const peaks = [];
  for (let t = 0; t < NT; t++) {
    for (let r = 0; r < nr; r++) {
      const v = acc[t * nr + r];
      if (v < minV) continue;
      let isMax = true;
      for (let dt = -3; dt <= 3 && isMax; dt++) {
        for (let dr = -4; dr <= 4; dr++) {
          if (!dt && !dr) continue;
          const u = at(t + dt, r + dr);
          // Ties go to the first cell so a flat-topped peak is reported once.
          if (u > v || (u === v && (dt < 0 || (dt === 0 && dr < 0)))) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) peaks.push({ t, rho: r - diag, votes: v });
    }
  }
  peaks.sort((a, b) => b.votes - a.votes);
  return peaks.slice(0, maxLines).map((p) => ({ ...p, nx: COS[p.t], ny: SIN[p.t] }));
}

/**
 * For a line, which 1-px steps along it are backed by an edge pixel of the same
 * direction (within ±2 px). Stored as a prefix sum so any segment's support is O(1).
 */
function lineCoverage(em, line) {
  const { width: w, height: h, edge, ori } = em;
  const diag = Math.ceil(Math.hypot(w, h));
  const n = 2 * diag + 1;
  const cum = new Uint16Array(n + 1);
  const strict = new Uint16Array(n + 1); // ±1 px, ±6°: for "does the line run on past the corner"
  const dx = -line.ny;
  const dy = line.nx;
  const px = line.rho * line.nx;
  const py = line.rho * line.ny;
  for (let s = 0; s < n; s++) {
    const bx = px + (s - diag) * dx;
    const by = py + (s - diag) * dy;
    let hit = 0;
    let tight = 0;
    for (let k = -2; k <= 2; k++) {
      const x = Math.round(bx + k * line.nx);
      const y = Math.round(by + k * line.ny);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x;
      if (!edge[i]) continue;
      const da = angDiff(ori[i], line.t);
      if (da <= 12) hit = 1;
      if (da <= 6 && k >= -1 && k <= 1) tight = 1;
    }
    cum[s + 1] = cum[s] + hit;
    strict[s + 1] = strict[s] + tight;
  }
  return { cum, strict, diag, dx, dy, px, py };
}

/** Fraction of the segment a→b (both on the line) backed by edges, ignoring the rounded corners. */
function segmentSupport(cov, a, b) {
  let sa = (a.x - cov.px) * cov.dx + (a.y - cov.py) * cov.dy + cov.diag;
  let sb = (b.x - cov.px) * cov.dx + (b.y - cov.py) * cov.dy + cov.diag;
  if (sa > sb) [sa, sb] = [sb, sa];
  const trim = (sb - sa) * 0.08;
  const lo = Math.max(0, Math.min(cov.cum.length - 1, Math.round(sa + trim)));
  const hi = Math.max(0, Math.min(cov.cum.length - 1, Math.round(sb - trim)));
  return hi > lo ? (cov.cum[hi] - cov.cum[lo]) / (hi - lo) : 0;
}

/** Fraction of the line from `from` to `to` px past point `a` (along the side's direction) tightly backed by edges. */
function rangeSupport(cov, a, ux, uy, from, to) {
  const s0 = (a.x - cov.px) * cov.dx + (a.y - cov.py) * cov.dy + cov.diag;
  const dir = ux * cov.dx + uy * cov.dy; // ±1: which way the side runs along the line
  let lo = s0 + dir * from;
  let hi = s0 + dir * to;
  if (lo > hi) [lo, hi] = [hi, lo];
  const n = cov.strict.length - 1;
  const l = Math.max(0, Math.min(n, Math.round(lo)));
  const h = Math.max(0, Math.min(n, Math.round(hi)));
  return hi - lo >= 1 ? (cov.strict[h] - cov.strict[l]) / (hi - lo) : 0;
}

/**
 * How much the side lines run on past the corners (0..1). A real card's edges stop at
 * its corners; an outline mixing a toploader's edges with the card's doesn't.
 */
function overshoot(covs, sideLine, corners) {
  let sum = 0;
  for (let k = 0; k < 4; k++) {
    const a = corners[k];
    const b = corners[(k + 1) % 4];
    const len = dist(a, b);
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const cov = covs[sideLine[k]];
    const past = rangeSupport(cov, b, ux, uy, 0.04 * len, 0.16 * len);
    const before = rangeSupport(cov, a, ux, uy, -0.16 * len, -0.04 * len);
    sum += Math.max(past, before);
  }
  return sum / 4;
}

function intersect(a, b) {
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 1e-6) return null;
  return { x: (a.rho * b.ny - b.rho * a.ny) / det, y: (a.nx * b.rho - b.nx * a.rho) / det };
}

// ---------------- quads ----------------

/**
 * Card-shaped quadrilaterals in an RGBA image, best first:
 * [{ corners: [TL, TR, BR, BL], score, support, aspectError, area, landscape }].
 * Coordinates are in `img` pixels.
 */
export function findCardQuads(img, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const em = edgeMap(img);
  const { width: w, height: h } = img;
  const lines = houghLines(em, { maxLines: o.maxLines });
  const covs = lines.map((l) => lineCoverage(em, l));
  const minSide = Math.sqrt(o.minArea * w * h * CARD_ASPECT);
  const cx = w / 2;
  const cy = h / 2;
  const margin = 0.04 * Math.max(w, h);

  // Pairs of roughly parallel lines far enough apart to be two sides of a card.
  const pairs = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i];
      const b = lines[j];
      const dot = a.nx * b.nx + a.ny * b.ny;
      if (Math.abs(dot) < Math.cos(14 * DEG)) continue;
      const sgn = dot < 0 ? -1 : 1;
      const sep = Math.abs(a.rho - (a.nx * cx + a.ny * cy) - sgn * (b.rho - (b.nx * cx + b.ny * cy)));
      if (sep < minSide) continue;
      pairs.push({ i, j, nx: a.nx + sgn * b.nx, ny: a.ny + sgn * b.ny });
    }
  }

  const quads = [];
  for (let p = 0; p < pairs.length; p++) {
    for (let q = p + 1; q < pairs.length; q++) {
      const A = pairs[p];
      const B = pairs[q];
      const cos = Math.abs(A.nx * B.nx + A.ny * B.ny) / (Math.hypot(A.nx, A.ny) * Math.hypot(B.nx, B.ny));
      if (cos > Math.cos(62 * DEG)) continue;
      const quad = scoreQuad(lines, covs, A, B, w, h, margin, o);
      if (quad) quads.push(quad);
    }
  }
  quads.sort((a, b) => b.score - a.score);
  if (!quads.length) return [];
  // A card's edge separates two different things (card vs. table). Wood grain or a
  // clear toploader's edge has much the same on both sides: rescore the leaders.
  const top = quads.slice(0, 30);
  for (const q of top) {
    q.contrast = q.corners.reduce((sum, a, k) => sum + sideContrast(img, a, q.corners[(k + 1) % 4], q.corners), 0) / 4;
    q.score *= 0.5 + 0.5 * q.contrast;
  }
  top.sort((a, b) => b.score - a.score);
  quads.splice(0, top.length, ...top);
  const pick = preferCard(quads, img, em, o.trace);
  const ordered = [pick, ...quads.filter((q) => q !== pick)];
  ordered[0] = refineQuad(em, pushOut(ordered[0], lines, covs, img, em, o.trace));
  return ordered;
}

/**
 * Could colour `c` be colour `bg` seen through clear plastic? Plastic haze blends the
 * background towards white by the same factor in every channel; a card border's colour
 * practically never fits that.
 */
export function looksHazed(c, bg) {
  if (Math.hypot(c[0] - bg[0], c[1] - bg[1], c[2] - bg[2]) < 6) return true;
  const alphas = [];
  for (let k = 0; k < 3; k++) if (255 - bg[k] >= 20) alphas.push((255 - c[k]) / (255 - bg[k]));
  if (!alphas.length) return false;
  const lo = Math.min(...alphas);
  const hi = Math.max(...alphas);
  return lo >= 0.5 && hi <= 1.08 && hi - lo <= 0.15;
}

/** How clearly the side a→b separates two different things, 0..1 (thin strips just inside vs. just outside). */
function sideContrast(img, a, b, corners) {
  const { width: w, height: h, data } = img;
  const len = dist(a, b) || 1;
  let nx = -(b.y - a.y) / len;
  let ny = (b.x - a.x) / len;
  const c = corners.reduce((s, p) => ({ x: s.x + p.x / 4, y: s.y + p.y / 4 }), { x: 0, y: 0 });
  if ((c.x - a.x) * nx + (c.y - a.y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const inside = [[], [], []];
  const outside = [[], [], []];
  for (let s = 0; s <= 24; s++) {
    const f = 0.12 + (0.76 * s) / 24;
    const px = a.x + (b.x - a.x) * f;
    const py = a.y + (b.y - a.y) * f;
    for (const d of [3, 5, -3, -5]) {
      const x = Math.round(px + nx * d);
      const y = Math.round(py + ny * d);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = (y * w + x) * 4;
      const to = d > 0 ? inside : outside;
      to[0].push(data[i]);
      to[1].push(data[i + 1]);
      to[2].push(data[i + 2]);
    }
  }
  if (inside[0].length < 8 || outside[0].length < 8) return 0;
  const cin = inside.map(median);
  const cout = outside.map(median);
  if (looksHazed(cin, cout)) return 0.2; // a clear holder's edge, or grain on both sides
  return Math.min(1, Math.hypot(cin[0] - cout[0], cin[1] - cout[1], cin[2] - cout[2]) / 45);
}

function scoreQuad(lines, covs, A, B, w, h, margin, o) {
  // Corners in cycle order: (A.i,B.i) (A.i,B.j) (A.j,B.j) (A.j,B.i).
  const ids = [
    [A.i, B.i],
    [A.i, B.j],
    [A.j, B.j],
    [A.j, B.i],
  ];
  const pts = [];
  for (const [a, b] of ids) {
    const p = intersect(lines[a], lines[b]);
    if (!p || p.x < -margin || p.y < -margin || p.x > w + margin || p.y > h + margin) return null;
    pts.push({ ...p, a, b });
  }
  const corners = orderCorners(pts);
  // Keep track of which line forms each side (corner k -> k+1).
  const sideLine = [];
  for (let k = 0; k < 4; k++) {
    const p = pts.find((t) => t.x === corners[k].x && t.y === corners[k].y);
    const q = pts.find((t) => t.x === corners[(k + 1) % 4].x && t.y === corners[(k + 1) % 4].y);
    const shared = [p.a, p.b].find((l) => l === q.a || l === q.b);
    if (shared == null) return null;
    sideLine.push(shared);
  }
  // Interior angles 55°–125°, opposite sides of similar length (mild perspective only).
  for (let k = 0; k < 4; k++) {
    const a = corners[(k + 3) % 4];
    const b = corners[k];
    const c = corners[(k + 1) % 4];
    const cosA = ((a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y)) / (dist(a, b) * dist(c, b) || 1);
    if (Math.abs(cosA) > Math.cos(55 * DEG)) return null;
  }
  const top = dist(corners[0], corners[1]);
  const bottom = dist(corners[3], corners[2]);
  const left = dist(corners[0], corners[3]);
  const right = dist(corners[1], corners[2]);
  if (Math.min(top, bottom) / Math.max(top, bottom) < 0.65 || Math.min(left, right) / Math.max(left, right) < 0.65) return null;
  const qw = (top + bottom) / 2;
  const qh = (left + right) / 2;
  const landscape = qw > qh;
  const aspect = Math.min(qw, qh) / Math.max(qw, qh);
  const aspectError = Math.abs(Math.log(aspect / CARD_ASPECT));
  if (aspectError > o.maxAspectError) return null;
  const area = polygonArea(corners) / (w * h);
  if (area < o.minArea) return null;

  const sides = [];
  for (let k = 0; k < 4; k++) sides.push(segmentSupport(covs[sideLine[k]], corners[k], corners[(k + 1) % 4]));
  const minS = Math.min(...sides);
  if (minS < 0.2) return null;
  const support = sides.reduce((s, v) => s + v, 0) / 4;
  if (support < 0.45) return null;
  const over = overshoot(covs, sideLine, corners);
  // Cards are nearly always photographed upright; a sideways card-shaped box is
  // more often a text box or the artwork.
  const score =
    support *
    // Perspective skews the measured aspect a little, so small errors are free.
    (1 - (0.6 * Math.max(0, aspectError - 0.04)) / (o.maxAspectError - 0.04)) *
    (0.9 + 0.1 * Math.sqrt(area)) *
    (0.85 + 0.15 * minS) *
    (1 - 0.6 * over) *
    (landscape ? 0.75 : 1);
  return { corners, score, support, sides, over, aspectError, area, landscape, ids: sideLine, lines: sideLine.map((i) => lines[i]) };
}

/**
 * Cards are often photographed in a toploader, whose edges also form a card-shaped
 * rectangle. Start from the best-scoring outline; if it surrounds a strong, complete
 * card outline at 45–80% of its area and the band between them looks like what's
 * outside (background seen through plastic), it's a holder: take the card inside.
 * (The opposite mistake, the card's inner frame instead of its edge, is fixed side
 * by side in pushOut.)
 */
function preferCard(quads, img, em, trace) {
  const name = (q) => `${q.corners.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(' ')} (score ${q.score.toFixed(2)})`;
  const portrait = quads.filter((q) => !q.landscape);
  let best = portrait[0] && portrait[0].score >= quads[0].score * 0.8 ? portrait[0] : quads[0];
  const pool = portrait.filter((q) => q.aspectError < 0.1 && q.score >= best.score * 0.5);
  const within = (outer, inner, lo, hi, margin) =>
    inner !== outer &&
    inner.area / outer.area > lo &&
    inner.area / outer.area < hi &&
    inner.corners.every((p) => insideQuad(outer.corners, p, margin));
  for (let step = 0; step < 2; step++) {
    const margin = -0.01 * quadSize(best.corners).h;
    const card = pool
      .filter((q) => q.score >= best.score * 0.7 && Math.min(...q.sides) >= 0.5 && within(best, q, 0.45, 0.8, margin))
      .sort((a, b) => b.score - a.score)
      .find((q) => {
        const r = compareBand(img, em, best.corners, q.corners, trace && ((m) => trace.push(`${name(best)} around ${name(q)}: ${m}`)));
        return r.valid >= 3 && r.like >= 3;
      });
    if (!card) break;
    trace?.push(`${name(best)}: holder; card inside is ${name(card)}`);
    best = card;
  }
  trace?.push(`chosen ${name(best)}`);
  return best;
}

/** Median by quickselect (reorders `a`). */
function median(a) {
  const k = a.length >> 1;
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        [a[i], a[j]] = [a[j], a[i]];
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a.length ? a[k] : 0;
}

/**
 * Compare the band between `outer` and `inner` with what lies just outside `outer`,
 * side by side. Returns { valid: sides with a band wide enough to judge, like: sides
 * where the band looks like the outside }.
 */
export function compareBand(img, em, outer, inner, log) {
  let valid = 0;
  let like = 0;
  for (let k = 0; k < 4; k++) {
    const r = sideBand(img, em, outer[k], outer[(k + 1) % 4], inner[k], inner[(k + 1) % 4]);
    if (r.like == null) continue;
    valid++;
    if (r.like) like++;
    log?.(`side ${k} ${r.msg}`);
  }
  return { valid, like };
}

/**
 * One side of a band: does the strip between segment i0-i1 (inner) and o0-o1 (outer)
 * look like what lies beyond o0-o1? Median colour and texture, so a sticker over part
 * of the side doesn't matter. like: true / false / null (band too thin to judge).
 */
function sideBand(img, em, o0, o1, i0, i1) {
  const { width: w, height: h, data } = img;
  const stats = (pts) => {
    const r = [];
    const g = [];
    const b = [];
    const t = [];
    for (const p of pts) {
      const x = Math.round(p.x);
      const y = Math.round(p.y);
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      const i = y * w + x;
      r.push(data[i * 4]);
      g.push(data[i * 4 + 1]);
      b.push(data[i * 4 + 2]);
      t.push(em.mag[i]);
    }
    return r.length >= 6 ? { c: [median(r), median(g), median(b)], tex: median(t) } : null;
  };
  const band = [];
  const out = [];
  let wsum = 0;
  let wide = 0;
  const N = 40;
  // Walk along the inner side; at each point go straight out (along its normal) to
  // the outer side's line: that's the band; a little further is the outside.
  const len = dist(i0, i1) || 1;
  const ux = (i1.x - i0.x) / len;
  const uy = (i1.y - i0.y) / len;
  const olen = dist(o0, o1) || 1;
  const mx = -(o1.y - o0.y) / olen;
  const my = (o1.x - o0.x) / olen;
  const mn = mx * -uy + my * ux; // outer normal · inner normal
  for (let s = 0; s <= N && Math.abs(mn) > 0.5; s++) {
    const f = 0.12 + (0.76 * s) / N; // skip the corners
    const ip = { x: i0.x + (i1.x - i0.x) * f, y: i0.y + (i1.y - i0.y) * f };
    const t = (mx * (o0.x - ip.x) + my * (o0.y - ip.y)) / mn; // signed distance to the outer line
    const bw = Math.abs(t);
    const dx = (-uy * t) / (bw || 1);
    const dy = (ux * t) / (bw || 1);
    wsum += bw;
    // Stay 3 px clear of both lines: the edges' own blur isn't texture.
    if (bw < 8) continue;
    wide++;
    for (let k = 3; k <= bw - 3; k += 2) band.push({ x: ip.x + dx * k, y: ip.y + dy * k });
    for (let k = 3; k <= Math.max(7, Math.min(bw, 14)); k += 2) out.push({ x: ip.x + dx * (bw + k), y: ip.y + dy * (bw + k) });
  }
  const bs = stats(band);
  const os = stats(out);
  if (!bs || !os || wide < N / 2) return { like: null, card: null, msg: `band ${Math.round(wsum / (N + 1))}px: too thin to judge` };
  const dc = Math.hypot(bs.c[0] - os.c[0], bs.c[1] - os.c[1], bs.c[2] - os.c[2]);
  // Through clear plastic the background looks a little lighter and softer.
  const texLike = (Math.min(bs.tex, os.tex) + 2) / (Math.max(bs.tex, os.tex) + 2) > 0.35;
  const like = texLike && looksHazed(bs.c, os.c);
  const verdict = like ? 'background through plastic' : 'part of the card';
  return { like, card: !like, msg: `band ${Math.round(wsum / (N + 1))}px texture ${bs.tex.toFixed(1)}/${os.tex.toFixed(1)} colour diff ${Math.round(dc)} -> ${verdict}` };
}

/**
 * Move each side out to a parallel line just beyond it when the strip in between is
 * part of the card: the inner frame, the name bar or the artwork's top often make a
 * stronger line than the card's own edge (more so with a sticker or glare on it).
 * A side may move up to 8% of the card, the top 13% (the name area is tall).
 */
function pushOut(quad, lines, covs, img, em, trace) {
  const ids = [...quad.ids];
  const L = (k) => lines[ids[(k + 4) % 4]];
  const corner = (k) => intersect(L(k - 1), L(k));
  const c = { x: 0, y: 0 };
  quad.corners.forEach((p) => {
    c.x += p.x / 4;
    c.y += p.y / 4;
  });
  const size = quadSize(quad.corners);
  for (let k = 0; k < 4; k++) {
    const budget = k % 2 ? 0.08 * size.w : (k ? 0.08 : 0.13) * size.h;
    let moved = 0;
    for (let step = 0; step < 4; step++) {
      const cur = L(k);
      const a = corner(k);
      const b = corner(k + 1);
      if (!a || !b) break;
      const curSupport = segmentSupport(covs[ids[k]], a, b);
      let next = null;
      for (let j = 0; j < lines.length; j++) {
        const l = lines[j];
        if (j === ids[k] || angDiff(l.t, cur.t) > 4) continue;
        // Both ends of the side must lie between the centre and line j.
        const inSign = Math.sign(c.x * l.nx + c.y * l.ny - l.rho);
        const da = (a.x * l.nx + a.y * l.ny - l.rho) * inSign;
        const db = (b.x * l.nx + b.y * l.ny - l.rho) * inSign;
        const d = (da + db) / 2;
        if (Math.min(da, db) < 1 || moved + d > budget) continue;
        if (next && d >= next.d) continue;
        const a2 = intersect(L(k - 1), l);
        const b2 = intersect(l, L(k + 1));
        if (!a2 || !b2) continue;
        const sup = segmentSupport(covs[j], a2, b2);
        if (sup < 0.5 || sup < curSupport * 0.6) continue;
        next = { j, d, a2, b2 };
      }
      if (!next) break;
      const band = sideBand(img, em, next.a2, next.b2, a, b);
      trace?.push(`side ${k}: line ${next.d.toFixed(1)}px further out, ${band.msg}`);
      if (band.card === false) break; // background between: that's a holder's edge
      ids[k] = next.j;
      moved += next.d;
    }
  }
  if (ids.every((id, k) => id === quad.ids[k])) return quad;
  const corners = [0, 1, 2, 3].map((k) => corner(k));
  if (corners.some((p) => !p)) return quad;
  return { ...quad, corners, ids, lines: ids.map((i) => lines[i]) };
}

/** Re-fit each side by least squares on the edge pixels along it (sub-pixel corners). */
function refineQuad(em, quad) {
  const { width: w, ori, edge } = em;
  const lines = quad.lines.map((line, k) => {
    const a = quad.corners[k];
    const b = quad.corners[(k + 1) % 4];
    let fit = line;
    for (let pass = 0; pass < 2; pass++) {
      const tol = pass ? 1.5 : 2.5;
      const len = dist(a, b);
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      let n = 0;
      for (let s = len * 0.08; s <= len * 0.92; s += 0.5) {
        const bx = a.x + ux * s;
        const by = a.y + uy * s;
        for (let k2 = -Math.ceil(tol); k2 <= Math.ceil(tol); k2++) {
          const x = Math.round(bx + k2 * fit.nx);
          const y = Math.round(by + k2 * fit.ny);
          if (x < 0 || y < 0 || x >= w || y >= em.height) continue;
          const i = y * w + x;
          if (!edge[i] || angDiff(ori[i], line.t) > 12) continue;
          if (Math.abs(x * fit.nx + y * fit.ny - fit.rho) > tol) continue;
          sx += x;
          sy += y;
          sxx += x * x;
          syy += y * y;
          sxy += x * y;
          n++;
        }
      }
      if (n < 12) break;
      // Total least squares: the normal is the eigenvector of the smaller eigenvalue.
      const mx = sx / n;
      const my = sy / n;
      const cxx = sxx / n - mx * mx;
      const cyy = syy / n - my * my;
      const cxy = sxy / n - mx * my;
      const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy); // direction of the line
      let nx = -Math.sin(th);
      let ny = Math.cos(th);
      if (nx * line.nx + ny * line.ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      fit = { ...line, nx, ny, rho: mx * nx + my * ny };
    }
    return fit;
  });
  const pts = [];
  for (let k = 0; k < 4; k++) {
    const p = intersect(lines[(k + 3) % 4], lines[k]);
    if (!p) return quad;
    pts.push(p);
  }
  // Only accept a refinement that stays close to the Hough estimate.
  const moved = Math.max(...pts.map((p, k) => dist(p, quad.corners[k])));
  if (moved > 0.04 * Math.max(quadSize(quad.corners).w, 1)) return quad;
  return { ...quad, corners: pts, lines };
}

/** Quads that differ from every better one by more than 5% of the card's width at some corner. */
function distinctOutlines(quads) {
  const kept = [];
  for (const q of quads) {
    const w = quadSize(q.corners).w;
    if (kept.every((k) => Math.max(...k.corners.map((p, i) => dist(p, q.corners[i]))) > 0.05 * w)) kept.push(q);
    if (kept.length >= 4) break;
  }
  return kept;
}

// ---------------- canvas helpers (browser only) ----------------

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Find the card in a canvas. Returns null when there is no confident card, else
 * { corners: [TL, TR, BR, BL] in canvas pixels, score, area (fraction of the photo),
 *   landscape (card lies sideways), candidates: [corners, …] (next-best guesses), ms }.
 */
export function detectCard(canvas, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const t0 = performance.now();
  const s = Math.min(1, o.detectSize / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * s));
  const h = Math.max(1, Math.round(canvas.height * s));
  const small = makeCanvas(w, h);
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, w, h);
  const quads = findCardQuads(ctx.getImageData(0, 0, w, h), o);
  const ms = Math.round(performance.now() - t0);
  const best = quads[0];
  if (!best || best.score < (o.minScore ?? 0.45)) return null;
  const up = (c) => c.map((p) => ({ x: p.x / s, y: p.y / s }));
  if (o.trace) o.trace.push(...quads.slice(0, 12).map((q) => `cand ${q.corners.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(' ')} score ${q.score.toFixed(3)} sides ${q.sides.map((v) => v.toFixed(2))} over ${q.over.toFixed(2)} contrast ${q.contrast?.toFixed(2)} ae ${q.aspectError.toFixed(3)} area ${q.area.toFixed(3)}${q.landscape ? ' landscape' : ''}`));
  return {
    corners: up(best.corners),
    score: best.score,
    area: best.area,
    landscape: best.landscape,
    candidates: distinctOutlines(quads).slice(1, 4).map((q) => up(q.corners)),
    ms,
  };
}

/**
 * Cut the card out of `canvas` and straighten it. corners: [TL, TR, BR, BL].
 * The output is card-shaped, `width` px wide (default: the card's size in the
 * photo, kept between 600 and 1000 px), with an optional `margin` (fraction of the
 * card) of surroundings kept on every side. A landscape quad comes out turned upright.
 */
export function warpCard(canvas, corners, { width, margin = 0 } = {}) {
  let c = corners;
  const size = quadSize(c);
  if (size.w > size.h) {
    // Card lies sideways: start from the corner that makes it portrait.
    c = rotateCorners(c, 3);
  }
  const srcW = Math.min(size.w, size.h);
  const outW = Math.round(width || Math.max(600, Math.min(1000, srcW)));
  const outH = Math.round(outW / CARD_ASPECT);
  // Pre-shrink the card's bounding box on the GPU so the JS warp samples ~1:1.
  const k = Math.min(1, outW / srcW);
  const pad = 2 + margin * Math.max(size.w, size.h) * 1.3;
  const x0 = Math.max(0, Math.floor(Math.min(...c.map((p) => p.x)) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(...c.map((p) => p.y)) - pad));
  const x1 = Math.min(canvas.width, Math.ceil(Math.max(...c.map((p) => p.x)) + pad));
  const y1 = Math.min(canvas.height, Math.ceil(Math.max(...c.map((p) => p.y)) + pad));
  const bw = Math.max(1, Math.round((x1 - x0) * k));
  const bh = Math.max(1, Math.round((y1 - y0) * k));
  const mid = makeCanvas(bw, bh);
  const mctx = mid.getContext('2d', { willReadFrequently: true });
  mctx.imageSmoothingEnabled = true;
  mctx.imageSmoothingQuality = 'high';
  mctx.drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, bw, bh);
  const src = mctx.getImageData(0, 0, bw, bh);
  const sx = bw / (x1 - x0);
  const sy = bh / (y1 - y0);
  const to = c.map((p) => ({ x: (p.x - x0) * sx, y: (p.y - y0) * sy }));
  // With a margin, the corners land that far inside the output (in case an edge
  // was found on the card's inner frame rather than its outer edge).
  const mx = (outW * margin) / (1 + 2 * margin);
  const my = (outH * margin) / (1 + 2 * margin);
  const from = [
    { x: mx, y: my },
    { x: outW - mx, y: my },
    { x: outW - mx, y: outH - my },
    { x: mx, y: outH - my },
  ];
  const h = homography(from, to);
  const out = makeCanvas(outW, outH);
  if (!h) return out;
  const warped = warpImageData(src, h, outW, outH);
  out.getContext('2d').putImageData(new ImageData(warped.data, outW, outH), 0, 0);
  return out;
}
