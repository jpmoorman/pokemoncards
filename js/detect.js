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
  const out = new Uint8ClampedArray(width * height * 4);
  const sw = src.width;
  const sh = src.height;
  const d = src.data;
  let o = 0;
  for (let y = 0; y < height; y++) {
    const yc = y + 0.5;
    // Row start in homogeneous coordinates; step along x is (h0, h3, h6).
    let X = h[0] * 0.5 + h[1] * yc + h[2];
    let Y = h[3] * 0.5 + h[4] * yc + h[5];
    let W = h[6] * 0.5 + h[7] * yc + h[8];
    for (let x = 0; x < width; x++, o += 4) {
      const sx = X / W - 0.5;
      const sy = Y / W - 0.5;
      X += h[0];
      Y += h[3];
      W += h[6];
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) {
        out[o] = fill[0];
        out[o + 1] = fill[1];
        out[o + 2] = fill[2];
        out[o + 3] = 255;
        continue;
      }
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      out[o] = d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11;
      out[o + 1] = d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11;
      out[o + 2] = d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11;
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
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
 * the edge normal in whole degrees 0..179 and edge marks pixels kept as edges.
 */
export function edgeMap(img) {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const chans = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const tmp = new Float32Array(n);
  for (let c = 0; c < 3; c++) {
    const ch = chans[c];
    for (let i = 0; i < n; i++) ch[i] = data[i * 4 + c];
    blur121(ch, tmp, w, h);
  }
  const mag = new Float32Array(n);
  const gxA = new Float32Array(n);
  const gyA = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let best = -1;
      let bx = 0;
      let by = 0;
      for (let c = 0; c < 3; c++) {
        const p = chans[c];
        const gx = p[i - w + 1] + 2 * p[i + 1] + p[i + w + 1] - p[i - w - 1] - 2 * p[i - 1] - p[i + w - 1];
        const gy = p[i + w - 1] + 2 * p[i + w] + p[i + w + 1] - p[i - w - 1] - 2 * p[i - w] - p[i - w + 1];
        const m = gx * gx + gy * gy;
        if (m > best) {
          best = m;
          bx = gx;
          by = gy;
        }
      }
      mag[i] = Math.sqrt(best) / 4;
      gxA[i] = bx;
      gyA[i] = by;
    }
  }
  // Non-maximum suppression along the gradient, then an adaptive threshold.
  const ori = new Uint8Array(n);
  const edge = new Uint8Array(n);
  const kept = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < 4) continue;
      let a = Math.atan2(gyA[i], gxA[i]) / DEG;
      if (a < 0) a += 180;
      let o = Math.round(a);
      if (o >= 180) o -= 180;
      ori[i] = o;
      // Neighbours along the gradient direction (4 sectors).
      let j;
      if (a < 22.5 || a >= 157.5) j = 1;
      else if (a < 67.5) j = w + 1;
      else if (a < 112.5) j = w;
      else j = w - 1;
      if (m >= mag[i + j] && m > mag[i - j]) {
        edge[i] = 1;
        kept.push(m);
      }
    }
  }
  // Keep the stronger edges: carpets and wood grain make plenty of weak ones.
  kept.sort((a, b) => a - b);
  const thr = Math.max(6, kept.length ? kept[Math.floor(kept.length * 0.6)] * 0.8 : 0);
  for (let i = 0; i < n; i++) if (edge[i] && mag[i] < thr) edge[i] = 0;
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
      // Vote only near the pixel's own edge direction: fast and far less noisy.
      for (let d = -2; d <= 2; d++) {
        let t = o + d;
        if (t < 0) t += NT;
        else if (t >= NT) t -= NT;
        acc[t * nr + Math.round(x * COS[t] + y * SIN[t]) + diag]++;
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
  const dx = -line.ny;
  const dy = line.nx;
  const px = line.rho * line.nx;
  const py = line.rho * line.ny;
  for (let s = 0; s < n; s++) {
    const bx = px + (s - diag) * dx;
    const by = py + (s - diag) * dy;
    let hit = 0;
    for (let k = -2; k <= 2 && !hit; k++) {
      const x = Math.round(bx + k * line.nx);
      const y = Math.round(by + k * line.ny);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x;
      if (edge[i] && angDiff(ori[i], line.t) <= 12) hit = 1;
    }
    cum[s + 1] = cum[s] + hit;
  }
  return { cum, diag, dx, dy, px, py };
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
  const pick = preferCard(quads, img);
  const ordered = [pick, ...quads.filter((q) => q !== pick)];
  ordered[0] = refineQuad(em, ordered[0]);
  return ordered;
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
  // Cards are nearly always photographed upright; a sideways card-shaped box is
  // more often a text box or the artwork.
  const score =
    support * (1 - (0.6 * aspectError) / o.maxAspectError) * (0.9 + 0.1 * Math.sqrt(area)) * (0.85 + 0.15 * minS) * (landscape ? 0.75 : 1);
  return { corners, score, support, sides, aspectError, area, landscape, lines: sideLine.map((i) => lines[i]) };
}

/**
 * Cards are often photographed in a toploader or sleeve, whose edges also form a
 * card-shaped rectangle; and the card's own inner frame forms a smaller one.
 * Walk inwards while the outer rectangle looks see-through (the band between it and
 * the next rectangle inside looks like the background outside it), then outwards
 * while the band looks like a card border (uniform and unlike what's outside).
 */
function preferCard(quads, img) {
  let best = quads[0];
  const strong = quads.filter((q) => q.score >= best.score * 0.5 && !q.landscape);
  const nested = (outer, inner, lo, hi) =>
    inner !== outer &&
    inner.area / outer.area > lo &&
    inner.area / outer.area < hi &&
    inner.corners.every((p) => insideQuad(outer.corners, p, 2));
  // Inwards: out of a toploader / sleeve.
  for (let step = 0; step < 3; step++) {
    const holderOf = strong
      .filter((q) => q.aspectError < 0.12 && nested(best, q, 0.4, 0.88))
      .sort((a, b) => b.score - a.score)
      .find((q) => bandLooksLikeOutside(img, best.corners, q.corners, true) === true);
    if (!holderOf) break;
    best = holderOf;
  }
  // Outwards: the card's inner frame often scores a little higher than its outer edge
  // (a sticker or glare hides part of the edge). A nearly-as-good rectangle just
  // around it that doesn't look see-through is the card itself.
  const edgeOf = strong
    .filter((q) => q.score >= best.score * 0.85 && q.aspectError < 0.12 && nested(q, best, 0.72, 0.97))
    .sort((a, b) => b.score - a.score)
    .find((q) => bandLooksLikeOutside(img, q.corners, best.corners, false) !== true);
  return edgeOf || best;
}

/** Mean colour of `img` at points p(s) for s along each of the 4 sides. */
function sideMeans(img, pointsOnSide) {
  const { width: w, height: h, data } = img;
  return pointsOnSide.map((pts) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (const p of pts) {
      const x = Math.round(p.x);
      const y = Math.round(p.y);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = (y * w + x) * 4;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
    return n >= 4 ? [r / n, g / n, b / n] : null;
  });
}

/**
 * Is the band between `outer` and `inner` (both TL,TR,BR,BL) the same stuff as what
 * lies just outside `outer`? true = outer is a clear holder, false = outer is the
 * card edge (a border band), null = can't tell. `allSides` demands a band on every
 * side (a holder surrounds the card; an inner frame may share sides with the edge).
 */
export function bandLooksLikeOutside(img, outer, inner, allSides = false) {
  const band = [];
  const outside = [];
  const widths = [];
  for (let k = 0; k < 4; k++) {
    const o0 = outer[k];
    const o1 = outer[(k + 1) % 4];
    const i0 = inner[k];
    const i1 = inner[(k + 1) % 4];
    const bs = [];
    const os = [];
    let wsum = 0;
    const N = 24;
    for (let s = 1; s < N; s++) {
      const f = 0.15 + (0.7 * s) / N; // skip the corners
      const op = { x: o0.x + (o1.x - o0.x) * f, y: o0.y + (o1.y - o0.y) * f };
      const ip = { x: i0.x + (i1.x - i0.x) * f, y: i0.y + (i1.y - i0.y) * f };
      const dx = op.x - ip.x;
      const dy = op.y - ip.y;
      const bw = Math.hypot(dx, dy);
      wsum += bw;
      if (bw < 2) continue;
      // A few pixels away from either edge so blur at the edges doesn't leak in.
      bs.push({ x: ip.x + dx * 0.5, y: ip.y + dy * 0.5 });
      const out = Math.max(3, Math.min(bw * 0.5, 12)) / bw;
      os.push({ x: op.x + dx * out, y: op.y + dy * out });
    }
    band.push(bs);
    outside.push(os);
    widths.push(wsum / (N - 1));
  }
  const bm = sideMeans(img, band);
  const om = sideMeans(img, outside);
  const minW = Math.max(2, 0.012 * (quadSize(outer).w + quadSize(outer).h));
  let same = 0;
  let differ = 0;
  for (let k = 0; k < 4; k++) {
    if (!bm[k] || !om[k] || widths[k] < minW) {
      if (allSides) return null;
      continue;
    }
    const d = Math.hypot(bm[k][0] - om[k][0], bm[k][1] - om[k][1], bm[k][2] - om[k][2]);
    if (d < 40) same++;
    else differ++;
  }
  if (same + differ < 2) return null;
  if (allSides) return same >= 3 ? true : differ >= 3 ? false : null;
  return same > differ ? true : differ > same ? false : null;
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
  return {
    corners: up(best.corners),
    score: best.score,
    area: best.area,
    landscape: best.landscape,
    candidates: quads.slice(1, 4).map((q) => up(q.corners)),
    ms,
  };
}

/**
 * Cut the card out of `canvas` and straighten it. corners: [TL, TR, BR, BL].
 * The output is card-shaped, `width` px wide (default: the card's size in the
 * photo, kept between 600 and 1000 px). A landscape quad comes out turned upright.
 */
export function warpCard(canvas, corners, { width } = {}) {
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
  const k = Math.min(1, (outW / srcW) * 1.15);
  const x0 = Math.max(0, Math.floor(Math.min(...c.map((p) => p.x))) - 2);
  const y0 = Math.max(0, Math.floor(Math.min(...c.map((p) => p.y))) - 2);
  const x1 = Math.min(canvas.width, Math.ceil(Math.max(...c.map((p) => p.x))) + 2);
  const y1 = Math.min(canvas.height, Math.ceil(Math.max(...c.map((p) => p.y))) + 2);
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
  const from = [
    { x: 0, y: 0 },
    { x: outW, y: 0 },
    { x: outW, y: outH },
    { x: 0, y: outH },
  ];
  const h = homography(from, to);
  const out = makeCanvas(outW, outH);
  if (!h) return out;
  const warped = warpImageData(src, h, outW, outH);
  out.getContext('2d').putImageData(new ImageData(warped.data, outW, outH), 0, 0);
  return out;
}
