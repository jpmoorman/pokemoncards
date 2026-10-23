// Realistic synthetic phone photos of a card, for testing card finding + OCR:
// the card (from harness makeCard) on carpet / wood / a table, turned and tilted,
// optionally inside a toploader, with a price sticker over a corner, holo glare,
// blur and JPEG compression. Returns the true card corners so tests can check
// how well detect.js found it.
//   const photo = await makePhoto(page, CARDS.aurorus, { rotate: 6, toploader: true, sticker: true });
//   photo.buffer (JPEG bytes), photo.corners [TL, TR, BR, BL] in photo pixels
import { makeCard } from './harness.mjs';

export const PHOTO_DEFAULTS = {
  width: 1512,
  height: 2016,
  background: 'carpet', // 'carpet' | 'wood' | 'table'
  fill: 0.6, // card width / photo width
  rotate: 0, // degrees, clockwise
  tilt: 0, // keystone: top edge this much narrower than the bottom (0–0.15)
  offset: { x: 0, y: 0 }, // card centre shift, fraction of photo size
  toploader: false,
  sticker: false, // white "$25" price sticker over the top-right corner
  glare: null, // { at: 0..1 along the card, angle: deg, strength: 0..1, width: fraction }
  blur: 0.6, // px, applied to the whole photo
  quality: 0.82,
  seed: 1,
  noCard: false,
};

/** Named photo set-ups used by the tests. */
export const PHOTOS = {
  flat: { rotate: 0, background: 'table' },
  turned: { rotate: 9, tilt: 0.06, background: 'wood' },
  toploader: { rotate: -4, tilt: 0.05, toploader: true, sticker: true, glare: { at: 0.55, angle: 35, strength: 0.45, width: 0.12 } },
  steep: { rotate: 14, tilt: 0.1, fill: 0.55, offset: { x: 0.04, y: -0.03 }, background: 'carpet', glare: { at: 0.3, angle: -20, strength: 0.35, width: 0.1 } },
};

export async function makePhoto(page, cardSpec, photoSpec = {}) {
  const o = { ...PHOTO_DEFAULTS, ...photoSpec };
  const cardPng = o.noCard ? null : (await makeCard(page, { ...cardSpec, scale: 2 })).toString('base64');
  const res = await page.evaluate(renderPhoto, { o, cardPng });
  return { buffer: Buffer.from(res.dataUrl.split(',')[1], 'base64'), corners: res.corners, width: o.width, height: o.height };
}

// Runs in the page.
async function renderPhoto({ o, cardPng }) {
  let seed = o.seed * 9301 + 49297;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const W = o.width;
  const H = o.height;
  const photo = document.createElement('canvas');
  photo.width = W;
  photo.height = H;
  const p = photo.getContext('2d', { willReadFrequently: true });

  // ---- background ----
  const base = { carpet: [148, 124, 96], wood: [122, 86, 54], table: [214, 212, 206] }[o.background];
  const bg = p.createImageData(W, H);
  const amp = { carpet: 70, wood: 18, table: 10 }[o.background];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let v = (rnd() - 0.5) * amp;
      if (o.background === 'wood') v += 22 * Math.sin(y / 9 + Math.sin(x / 140) * 3) + 10 * Math.sin(y / 2.7);
      if (o.background === 'table') v += (x / W - 0.5) * 18 - (y / H) * 12;
      bg.data[i] = base[0] + v;
      bg.data[i + 1] = base[1] + v * 0.9;
      bg.data[i + 2] = base[2] + v * 0.8;
      bg.data[i + 3] = 255;
    }
  }
  p.putImageData(bg, 0, 0);
  if (o.background === 'carpet') {
    // Tufts: clumps of lighter/darker fibre.
    for (let k = 0; k < 9000; k++) {
      const l = rnd() < 0.5 ? 0 : 255;
      p.fillStyle = `rgba(${l},${l},${l},${0.05 + rnd() * 0.12})`;
      p.beginPath();
      p.ellipse(rnd() * W, rnd() * H, 3 + rnd() * 9, 2 + rnd() * 6, rnd() * Math.PI, 0, 2 * Math.PI);
      p.fill();
    }
  }

  // ---- the card's corners in the photo ----
  const cw = W * o.fill;
  const ch = (cw * 88) / 63;
  const cx = W * (0.5 + o.offset.x);
  const cy = H * (0.5 + o.offset.y);
  const a = (o.rotate * Math.PI) / 180;
  const place = (x, y) => {
    // Keystone first (top edge narrower by `tilt`), then rotate about the centre.
    const px = x * (1 - o.tilt * (0.5 - y / ch));
    return { x: cx + px * Math.cos(a) - y * Math.sin(a), y: cy + px * Math.sin(a) + y * Math.cos(a) };
  };
  const corners = [place(-cw / 2, -ch / 2), place(cw / 2, -ch / 2), place(cw / 2, ch / 2), place(-cw / 2, ch / 2)];

  if (cardPng) {
    const img = new Image();
    img.src = `data:image/png;base64,${cardPng}`;
    await img.decode();
    // ---- flat scene: toploader + card + sticker, in card pixels ----
    const CW = img.width;
    const CH = img.height;
    const mx = Math.round(CW * 0.12);
    const my = Math.round(CH * 0.09);
    const scene = document.createElement('canvas');
    scene.width = CW + 2 * mx;
    scene.height = CH + 2 * my;
    const s = scene.getContext('2d', { willReadFrequently: true });
    const rr = (x, y, w, h, r) => {
      s.beginPath();
      s.roundRect(x, y, w, h, r);
    };
    if (o.toploader) {
      rr(mx * 0.15, my * 0.15, scene.width - mx * 0.3, scene.height - my * 0.3, CW * 0.03);
      s.fillStyle = 'rgba(235,240,246,0.22)';
      s.fill();
      s.lineWidth = 7;
      s.strokeStyle = 'rgba(255,255,255,0.55)';
      s.stroke();
      rr(mx * 0.15 + 9, my * 0.15 + 9, scene.width - mx * 0.3 - 18, scene.height - my * 0.3 - 18, CW * 0.03);
      s.lineWidth = 3;
      s.strokeStyle = 'rgba(40,40,40,0.18)';
      s.stroke();
    }
    // Soft contact shadow under the card.
    s.save();
    s.shadowColor = 'rgba(0,0,0,0.35)';
    s.shadowBlur = 14;
    s.shadowOffsetX = 3;
    s.shadowOffsetY = 6;
    rr(mx, my, CW, CH, CW * 0.045);
    s.fillStyle = '#888';
    s.fill();
    s.restore();
    s.save();
    rr(mx, my, CW, CH, CW * 0.045);
    s.clip();
    s.drawImage(img, mx, my);
    s.restore();
    if (o.toploader) {
      // Plastic haze over the card.
      s.fillStyle = 'rgba(255,255,255,0.07)';
      s.fillRect(mx, my, CW, CH);
    }
    if (o.sticker) {
      s.save();
      s.translate(mx + CW * 0.86, my + CH * 0.03);
      s.rotate(-0.03);
      s.shadowColor = 'rgba(0,0,0,0.25)';
      s.shadowBlur = 8;
      s.fillStyle = '#f7f6f1';
      s.fillRect(-CW * 0.2, -CH * 0.075, CW * 0.42, CH * 0.15);
      s.shadowBlur = 0;
      s.fillStyle = '#2a2a2a';
      s.font = `italic ${Math.round(CH * 0.07)}px serif`;
      s.fillText('$25', -CW * 0.12, CH * 0.03);
      s.restore();
    }

    // ---- warp the scene into the photo (inverse mapping, bilinear) ----
    const from = [
      { x: mx, y: my },
      { x: mx + CW, y: my },
      { x: mx + CW, y: my + CH },
      { x: mx, y: my + CH },
    ];
    const Hm = solveHomography(corners, from); // photo -> scene
    const sd = s.getImageData(0, 0, scene.width, scene.height).data;
    const SW = scene.width;
    const SH = scene.height;
    const sceneCorners = [
      { x: 0, y: 0 },
      { x: SW, y: 0 },
      { x: SW, y: SH },
      { x: 0, y: SH },
    ].map((q) => apply(solveHomography(from, corners), q.x, q.y));
    const x0 = Math.max(0, Math.floor(Math.min(...sceneCorners.map((q) => q.x))));
    const x1 = Math.min(W, Math.ceil(Math.max(...sceneCorners.map((q) => q.x))));
    const y0 = Math.max(0, Math.floor(Math.min(...sceneCorners.map((q) => q.y))));
    const y1 = Math.min(H, Math.ceil(Math.max(...sceneCorners.map((q) => q.y))));
    const out = p.getImageData(0, 0, W, H);
    const d = out.data;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const q = apply(Hm, x + 0.5, y + 0.5);
        const sx = q.x - 0.5;
        const sy = q.y - 0.5;
        const ix = Math.floor(sx);
        const iy = Math.floor(sy);
        if (ix < 0 || iy < 0 || ix >= SW - 1 || iy >= SH - 1) continue;
        const fx = sx - ix;
        const fy = sy - iy;
        const i00 = (iy * SW + ix) * 4;
        const ws = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
        const is = [i00, i00 + 4, i00 + SW * 4, i00 + SW * 4 + 4];
        let al = 0;
        for (let k = 0; k < 4; k++) al += (sd[is[k] + 3] / 255) * ws[k];
        if (al <= 0) continue;
        const o4 = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) {
          let v = 0;
          for (let k = 0; k < 4; k++) v += sd[is[k] + c] * (sd[is[k] + 3] / 255) * ws[k];
          d[o4 + c] = d[o4 + c] * (1 - al) + v;
        }
      }
    }
    p.putImageData(out, 0, 0);
  }

  // ---- glare streak across the card ----
  if (o.glare && !o.noCard) {
    const g = o.glare;
    const gx = corners[0].x + (corners[2].x - corners[0].x) * g.at;
    const gy = corners[0].y + (corners[2].y - corners[0].y) * g.at;
    const ga = (g.angle * Math.PI) / 180;
    p.save();
    p.translate(gx, gy);
    p.rotate(ga);
    const gw = cw * (g.width || 0.1);
    const grad = p.createLinearGradient(0, -gw, 0, gw);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, `rgba(255,255,255,${g.strength})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    p.fillStyle = grad;
    p.fillRect(-cw, -gw, 2 * cw, 2 * gw);
    p.restore();
  }

  // ---- lens: blur + vignette, then JPEG ----
  const fin = document.createElement('canvas');
  fin.width = W;
  fin.height = H;
  const f = fin.getContext('2d');
  f.filter = o.blur ? `blur(${o.blur}px)` : 'none';
  f.drawImage(photo, 0, 0);
  f.filter = 'none';
  const v = f.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.28)');
  f.fillStyle = v;
  f.fillRect(0, 0, W, H);
  return { dataUrl: fin.toDataURL('image/jpeg', o.quality), corners };

  function solveHomography(src, dst) {
    const A = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = src[i];
      const { x: u, y: w } = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
      A.push([0, 0, 0, x, y, 1, -w * x, -w * y, w]);
    }
    for (let c = 0; c < 8; c++) {
      let piv = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      for (let r = 0; r < 8; r++) {
        if (r === c) continue;
        const k = A[r][c] / A[c][c];
        for (let j = c; j < 9; j++) A[r][j] -= k * A[c][j];
      }
    }
    return [...A.map((row, i) => row[8] / row[i]), 1];
  }
  function apply(h, x, y) {
    const w = h[6] * x + h[7] * y + h[8];
    return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
  }
}

/** Largest distance between found and true corners, as a fraction of the card's width. */
export function cornerError(found, truth) {
  if (!found) return Infinity;
  const w = Math.hypot(truth[1].x - truth[0].x, truth[1].y - truth[0].y);
  return Math.max(...found.map((p, i) => Math.hypot(p.x - truth[i].x, p.y - truth[i].y))) / w;
}
