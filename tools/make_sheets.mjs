// Pack dist/index.html's small thumbnails and avatars into sprite sheets, because claude.ai's
// public-sharing review rejects pages with too many separate images. Run after rasterize.mjs:
// node tools/make_sheets.mjs dist/index.html     (needs playwright-core and Chrome)
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const file = process.argv[2];
let html = readFileSync(file, 'utf8');
const m = html.match(/(<script type="application\/json" id="bundle">)([\s\S]*?)(<\/script>)/);
const bundle = JSON.parse(m[2]);
const COLS = 16;

const groups = [];
const used = new Set();
for (const room of Object.values(bundle.rooms)) {
  const keys = room.user.projects.map((p) => `p/${p.id}`).filter((k) => bundle.img[k] && !used.has(k));
  keys.forEach((k) => used.add(k));
  groups.push({ keys, w: 144, h: 108 });
}
const rest = Object.keys(bundle.img).filter((k) => k.startsWith('p/') && !used.has(k));
if (rest.length) groups.push({ keys: rest, w: 144, h: 108 });
groups.push({ keys: Object.keys(bundle.img).filter((k) => k.startsWith('u/')), w: 90, h: 90 });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const sheets = await page.evaluate(async ([list, images, cols]) => {
  const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  const out = [];
  for (const { keys, w, h } of list) {
    const c = document.createElement('canvas');
    c.width = Math.min(cols, keys.length) * w;
    c.height = Math.ceil(keys.length / cols) * h;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    const placed = [];
    for (const key of keys) {
      const img = await load(images[key]);
      if (!img) continue;
      const i = placed.length;
      g.drawImage(img, (i % cols) * w, Math.floor(i / cols) * h, w, h);
      placed.push(key);
    }
    out.push({ keys: placed, w, h, cols, src: c.toDataURL('image/jpeg', 0.78), pixels: `${c.width}x${c.height}` });
  }
  return out;
}, [groups, bundle.img, COLS]);
await browser.close();

for (const s of sheets) {
  for (const k of s.keys) delete bundle.img[k];
  console.log(`sheet ${s.pixels}: ${s.keys.length} images, ${(s.src.length / 1048576).toFixed(2)} MiB`);
  delete s.pixels;
}
bundle.sheets = sheets;
const payload = JSON.stringify(bundle).replaceAll('</', '<\\/');
html = html.slice(0, m.index) + m[1] + payload + m[3] + html.slice(m.index + m[0].length);
writeFileSync(file, html);
const count = (html.match(/data:image\//g) || []).length;
console.log(`page now holds ${count} images, ${(Buffer.byteLength(html) / 1048576).toFixed(1)} MiB`);
