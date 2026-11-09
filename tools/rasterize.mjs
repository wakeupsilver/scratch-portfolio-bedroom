// Re-encode every image in dist/index.html for claude.ai's public-sharing review:
// thumbnails and avatars become still JPEGs, costumes become PNGs, SVG and animation are removed.
// Run after build_static.py: node tools/rasterize.mjs dist/index.html   (needs playwright-core and Chrome)
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const file = process.argv[2];
let html = readFileSync(file, 'utf8');
const m = html.match(/(<script type="application\/json" id="bundle">)([\s\S]*?)(<\/script>)/);
const bundle = JSON.parse(m[2]);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const encode = (items, opts) => page.evaluate(async ([list, { type, quality, maxSide, minSide }]) => {
  const out = {};
  for (const [key, src] of list) {
    out[key] = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth || 256, h = img.naturalHeight || 256;
        const k = Math.max(minSide / Math.min(w, h), Math.min(1, maxSide / Math.max(w, h)));
        const c = document.createElement('canvas');
        c.width = Math.max(minSide, Math.round(w * k));
        c.height = Math.max(minSide, Math.round(h * k));
        const g = c.getContext('2d');
        if (type === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
        try { g.drawImage(img, 0, 0, c.width, c.height); resolve(c.toDataURL(type, quality)); } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }
  return out;
}, [items, opts]);

const rename = (md5) => md5.replace(/\.svg$/, '.png');
const images = await encode(Object.entries(bundle.img), { type: 'image/jpeg', quality: 0.82, maxSide: 480, minSide: 32 });
const costumes = await encode(Object.entries(bundle.costumes), { type: 'image/png', maxSide: 256, minSide: 32 });
await browser.close();

let dropped = 0;
bundle.img = {};
for (const [k, v] of Object.entries(images)) { if (v) bundle.img[k] = v; else dropped++; }
bundle.costumes = {};
for (const [k, v] of Object.entries(costumes)) { if (v) bundle.costumes[rename(k)] = v; else dropped++; }
for (const code of Object.values(bundle.code)) {
  for (const sprite of code.sprites) {
    sprite.costumes = sprite.costumes.map((c) => ({ ...c, md5: rename(c.md5) })).filter((c) => bundle.costumes[c.md5]);
  }
}
const payload = JSON.stringify(bundle).replaceAll('</', '<\\/');
html = html.slice(0, m.index) + m[1] + payload + m[3] + html.slice(m.index + m[0].length);
html = html.replace(/<link rel="icon"[^>]*>\n?/, '');
writeFileSync(file, html);
console.log(`re-encoded ${Object.keys(bundle.img).length} images and ${Object.keys(bundle.costumes).length} costumes, dropped ${dropped}; page ${(Buffer.byteLength(html) / 1048576).toFixed(1)} MiB`);
