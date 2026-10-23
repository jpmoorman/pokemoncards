// Synthetic stamps drawn on a harness card (tests/harness.mjs makeCard), for testing
// stamp detection. Positions are on the 630 × 880 card, like the real stamps:
//   set-logo     "MEGA EVOLUTION / PERFECT ORDER" badge over the art's lower-right corner
//   1st-edition  black "1 EDITION" circle just under the art's lower-left corner
//   player-rewards-program  "PLAY! POKéMON" badge in the art's lower right
//   const png = await makeStampedCard(page, CARDS.aurorus, 'set-logo');
//   const photo = await makePhoto(page, CARDS.aurorus, { ...PHOTOS.toploader, cardImage: png });
import { makeCard } from './harness.mjs';

export async function makeStampedCard(page, cardSpec, stamp, { scale = 2 } = {}) {
  const png = await makeCard(page, { ...cardSpec, scale });
  if (!stamp) return png;
  const dataUrl = await page.evaluate(drawStamp, { b64: png.toString('base64'), stamp, scale });
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

// Runs in the page.
async function drawStamp({ b64, stamp, scale }) {
  const img = new Image();
  img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const c = canvas.getContext('2d');
  c.drawImage(img, 0, 0);
  c.scale(scale, scale);
  c.textAlign = 'center';
  c.lineJoin = 'round';
  const text = (t, x, y, font, fill, outline) => {
    c.font = font;
    if (outline) {
      c.lineWidth = 4;
      c.strokeStyle = outline;
      c.strokeText(t, x, y);
    }
    c.fillStyle = fill;
    c.fillText(t, x, y);
  };
  const shape = (points, cx, cy) => {
    c.beginPath();
    points.forEach(([x, y], i) => (i ? c.lineTo(cx + x, cy + y) : c.moveTo(cx + x, cy + y)));
    c.closePath();
  };

  if (stamp === 'set-logo') {
    const cx = 505;
    const cy = 384;
    shape([[-100, 0], [-80, -44], [80, -44], [100, 0], [80, 44], [-80, 44]], cx, cy);
    c.fillStyle = '#2e3729';
    c.fill();
    c.lineWidth = 4;
    c.strokeStyle = '#b9a35a';
    c.stroke();
    text('MEGA EVOLUTION', cx, cy - 27, 'bold 11px sans-serif', '#d8b64c');
    text('PERFECT', cx, cy + 4, 'bold 31px sans-serif', '#f3ead0', '#1b1f18');
    text('ORDER', cx, cy + 36, 'bold 31px sans-serif', '#f3ead0', '#1b1f18');
  } else if (stamp === '1st-edition') {
    const cx = 84;
    const cy = 448;
    c.beginPath();
    c.arc(cx, cy, 24, 0, 2 * Math.PI);
    c.fillStyle = '#111';
    c.fill();
    text('1', cx, cy + 6, 'bold 22px sans-serif', '#fff');
    c.fillStyle = '#111';
    c.fillRect(cx - 34, cy + 9, 68, 12);
    text('EDITION', cx, cy + 19, 'bold 11px sans-serif', '#fff');
  } else if (stamp === 'player-rewards-program') {
    const cx = 490;
    const cy = 386;
    text('PLAY!', cx, cy + 4, 'italic bold 34px sans-serif', '#fdfdfb', '#1d3f8f');
    text('POKéMON', cx, cy + 26, 'bold 15px sans-serif', '#fdfdfb', '#1d3f8f');
  }
  return canvas.toDataURL('image/png');
}
