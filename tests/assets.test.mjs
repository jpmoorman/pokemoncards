// The files the service worker keeps: js/assets.js must list exactly the big files on disk
// (models/, vendor/, data/) with their sizes and hashes, and sw.js's SHELL every file the
// page itself loads.
//   node --test tests/assets.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root, listAssets, renderAssets } from '../tools/assets.mjs';

test('js/assets.js lists the big files as they are on disk (run `node tools/assets.mjs`)', () => {
  assert.equal(fs.readFileSync(path.join(root, 'js/assets.js'), 'utf8'), renderAssets(listAssets()));
});

test('sw.js can read the list from its saved copy of js/assets.js (plain JSON after "ASSETS = ")', async () => {
  const text = fs.readFileSync(path.join(root, 'js/assets.js'), 'utf8');
  const at = text.indexOf('ASSETS = ');
  const parsed = JSON.parse(text.slice(at + 'ASSETS = '.length, text.lastIndexOf('}') + 1));
  assert.deepEqual(parsed, (await import('../js/assets.js')).ASSETS);
});

test('licence and notice files next to the big files are published but not downloaded by the app', () => {
  const listed = listAssets().map((a) => a.path);
  for (const f of ['models/ppocr-v6tiny-1/LICENSE', 'vendor/onnxruntime-web-1.30.0/LICENSE', 'vendor/onnxruntime-web-1.30.0/ThirdPartyNotices.txt', 'data/LICENSE', 'data/README.md']) {
    assert.ok(fs.existsSync(path.join(root, f)), `${f} is missing`);
    assert.ok(!listed.includes(f), `${f} is listed as a big file`);
  }
});

test('big files are only under models/, vendor/ and data/, each version in its own name', () => {
  for (const a of listAssets()) {
    assert.match(a.path, /^(models|vendor|data)\/[\w.@+-]+(\/[\w.@+-]+)*$/, a.path);
    assert.match(a.integrity, /^sha256-[A-Za-z0-9+/]{43}=$/);
  }
});

const SHELL = (() => {
  const src = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  return [...src.match(/const SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
})();

test("sw.js SHELL: every file exists, and every script, style and icon the page uses is in it", () => {
  for (const f of SHELL) assert.ok(fs.existsSync(path.join(root, f)), `${f} is in SHELL but not on disk`);
  const want = new Set(['index.html', 'manifest.webmanifest']);
  for (const dir of ['js', 'css']) for (const f of fs.readdirSync(path.join(root, dir))) if (/\.(js|css)$/.test(f)) want.add(`${dir}/${f}`);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const m of html.matchAll(/(?:href|src)="([^"#?:]+)"/g)) want.add(m[1]);
  for (const icon of JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'))).icons) want.add(icon.src);
  for (const f of want) assert.ok(SHELL.includes(f), `add '${f}' to SHELL in sw.js (it works offline only if it is there)`);
  for (const f of SHELL) assert.ok(!/^(models|vendor|data)\//.test(f), `${f}: big files are kept by the asset cache, not SHELL`);
});

test('every big file the text reader loads (js/ocr-worker.js) is listed, so the service worker keeps it', async () => {
  const src = fs.readFileSync(path.join(root, 'js/ocr-worker.js'), 'utf8');
  const dirs = Object.fromEntries([...src.matchAll(/const (\w+_DIR) = '([^']+)'/g)].map((m) => [m[1], m[2]]));
  const files = [...src.matchAll(/`\$\{(\w+_DIR)\}([^`]+)`/g)].map((m) => dirs[m[1]] + m[2]);
  const { ASSETS } = await import('../js/assets.js');
  assert.ok(files.length >= 5, `found ${files.length} files in js/ocr-worker.js`);
  for (const f of files) assert.ok(ASSETS[f], `${f} is loaded by the text reader but not in js/assets.js`);
});
