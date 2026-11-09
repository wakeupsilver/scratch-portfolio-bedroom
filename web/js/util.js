// Small shared helpers: DOM building, seeded randomness, canvas drawing, data shaping.
import * as THREE from 'three';

// The static edition (tools/build_static.py) carries its rooms inside the page instead of using server.py.
const bundleEl = document.getElementById('bundle');
export const BUNDLE = bundleEl ? JSON.parse(bundleEl.textContent) : null;

/** Where a project image lives. Empty string means there isn't one, so a cover gets drawn. */
export function projectImage(id, size = '144x108') {
  if (!BUNDLE) return `/img/p/${id}/${size}`;
  return (size !== '144x108' && BUNDLE.img[`P/${id}`]) || BUNDLE.img[`p/${id}`] || '';
}

/** The static edition packs thumbnails into a few sprite sheets. Cut them back into single images. */
export async function unpackSheets() {
  for (const sheet of BUNDLE?.sheets || []) {
    const img = await loadImage(sheet.src, false);
    if (!img) continue;
    const [c, g] = canvas(sheet.w, sheet.h);
    sheet.keys.forEach((key, i) => {
      g.drawImage(img, (i % sheet.cols) * sheet.w, Math.floor(i / sheet.cols) * sheet.h, sheet.w, sheet.h, 0, 0, sheet.w, sheet.h);
      BUNDLE.img[key] = c.toDataURL('image/jpeg', 0.9);
    });
    sheet.src = '';   // free the packed copy
  }
}

export const avatarImage = (id) => (BUNDLE ? BUNDLE.img[`u/${id}`] || '' : `/img/u/${id}/90x90`);

/** Build a DOM element. Text always goes through textContent: project titles are user-written. */
export function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'style') for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) n.style.setProperty(sk, sv); else n.style[sk] = sv; }
    else n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) n.append(kid);
  return n;
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const num = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
export const plural = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const longDate = (d) => d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

export const CATEGORY_COLORS = {
  motion: '#4c97ff', looks: '#9966ff', sound: '#cf63cf', event: '#ffbf00', control: '#ffab19',
  sensing: '#5cb1d6', operator: '#59c059', data: '#ff8c1a', procedures: '#ff6680', extension: '#0fbd8c',
};

export const PAINTS = [
  { wall: '#ffd76e', spot: '#ffc53d', trim: '#ff6b4a', accent: '#12bfa0', ceil: '#fff3d6' },
  { wall: '#8fe8d2', spot: '#6fdcc1', trim: '#2b6fe0', accent: '#ff6fb5', ceil: '#e9fbf5' },
  { wall: '#9fd2ff', spot: '#7fc0fb', trim: '#ff8a1f', accent: '#8a5cf6', ceil: '#edf6ff' },
  { wall: '#ffb3cf', spot: '#ff98bd', trim: '#7b49e6', accent: '#ffc531', ceil: '#fff0f5' },
  { wall: '#c9b6ff', spot: '#b59ffa', trim: '#0fae94', accent: '#ff5a3c', ceil: '#f4efff' },
  { wall: '#ffb98f', spot: '#ffa671', trim: '#1aa7d8', accent: '#e8368f', ceil: '#fff0e6' },
];

/** Reshape the server payload: oldest first, with the fields every station needs. */
export function shapeData(raw) {
  const when = (p) => {
    const d = new Date(p.shared && !p.shared.startsWith('1900') ? p.shared : p.created);
    return isNaN(d) ? new Date(p.created || 0) : d;
  };
  const projects = raw.projects.map((p) => ({ ...p, date: when(p) })).sort((a, b) => a.date - b.date);
  projects.forEach((p, i) => { p.index = i; p.year = p.date.getFullYear(); p.month = p.date.getMonth(); });
  const byLoves = [...projects].sort((a, b) => b.loves - a.loves);
  byLoves.forEach((p, rank) => {
    p.tier = p.loves === 0 ? 0 : rank < Math.max(1, projects.length * 0.05) ? 3 : rank < projects.length * 0.2 ? 2 : 0;
  });
  const followingNames = new Set(raw.following.map((f) => f.username));
  const followerNames = new Set(raw.followers.map((f) => f.username));
  const friends = [
    ...raw.following.filter((f) => followerNames.has(f.username)).map((f) => ({ ...f, mutual: true })),
    ...raw.followers.filter((f) => !followingNames.has(f.username)).map((f) => ({ ...f, role: 'follower' })),
    ...raw.following.filter((f) => !followerNames.has(f.username)).map((f) => ({ ...f, role: 'following' })),
  ];
  return {
    profile: raw.profile, projects, byLoves, friends: raw.neighbors ? [...raw.neighbors, ...friends.filter((f) => !raw.neighbors.some((n) => n.username === f.username))] : friends, truncated: raw.truncated,
    favorites: raw.favorites.map((p) => ({ ...p, date: when(p), isFavorite: true })),
    totals: projects.reduce((t, p) => ({ views: t.views + p.views, loves: t.loves + p.loves }), { views: 0, loves: 0 }),
    paint: PAINTS[hashString(raw.profile.username.toLowerCase()) % PAINTS.length],
    seed: hashString(raw.profile.username.toLowerCase()),
  };
}

/** Year hue walks the rainbow so the floor reads as a timeline. */
export function yearColor(year, firstYear, lastYear) {
  const f = lastYear > firstYear ? (year - firstYear) / (lastYear - firstYear) : 0.3;
  return new THREE.Color().setHSL((8 + f * 300) / 360, 0.78, 0.6);
}

export function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

export function fitText(g, text, maxWidth) {
  if (g.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && g.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
  return t + '…';
}

export function wrapText(g, text, maxWidth, maxLines) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (g.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else line = test;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  return lines.slice(0, maxLines).map((l) => fitText(g, l, maxWidth));
}

export function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

export function canvasTexture(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** A floating text pill, always facing the camera. */
export function labelSprite(text, { bg = '#1d2145', fg = '#fff7e8', height = 0.34, font = 600 } = {}) {
  const [probe, pg] = canvas(4, 4);
  pg.font = `${font} 44px Fredoka`;
  const w = Math.ceil(Math.min(pg.measureText(text).width, 900)) + 48;
  const [c, g] = canvas(w, 72);
  g.fillStyle = bg;
  roundRect(g, 0, 0, w, 72, 26);
  g.fill();
  g.fillStyle = fg;
  g.font = `${font} 44px Fredoka`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(fitText(g, text, w - 40), w / 2, 38);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: canvasTexture(c), transparent: true, toneMapped: false, depthWrite: false }));
  s.scale.set(height * (w / 72), height, 1);
  s.raycast = () => {};
  return s;
}

/** A project with no stored thumbnail still gets a cover: colourful shapes and its title. */
export function drawCover(g, x, y, w, h, project) {
  const rnd = seeded(hashString(project.title + project.id));
  const hue = rnd() * 360;
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.fillStyle = `hsl(${hue} 80% 62%)`;
  g.fillRect(x, y, w, h);
  for (let i = 0; i < 7; i++) {
    g.fillStyle = `hsl(${(hue + 40 + rnd() * 200) % 360} 85% ${50 + rnd() * 25}%)`;
    const cx = x + rnd() * w, cy = y + rnd() * h, s = (0.12 + rnd() * 0.3) * h;
    g.beginPath();
    if (rnd() < 0.5) g.arc(cx, cy, s, 0, 7);
    else g.roundRect(cx - s, cy - s, s * 2, s * 2, s * 0.25);
    g.fill();
  }
  const size = Math.round(h * 0.17);
  g.font = `700 ${size}px Fredoka`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const lines = wrapText(g, project.title, w * 0.9, 3);
  lines.forEach((l, i) => {
    const ly = y + h / 2 + (i - (lines.length - 1) / 2) * size * 1.12;
    g.lineWidth = size * 0.28; g.lineJoin = 'round'; g.strokeStyle = '#1d2145';
    g.strokeText(l, x + w / 2, ly);
    g.fillStyle = '#fff'; g.fillText(l, x + w / 2, ly);
  });
  g.restore();
}

/** Scratch answers with a 60px placeholder when a thumbnail or avatar doesn't exist. */
export const isPlaceholder = (img) => img.naturalWidth > 0 && img.naturalWidth <= 60;

export function loadImage(src, cors = true) {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return; }
    const img = new Image();
    if (cors) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

const coverCache = new Map();
/** A data URL for HTML <img>, used when the real thumbnail is missing. */
export function coverURL(project) {
  if (!coverCache.has(project.id)) {
    const [c, g] = canvas(320, 240);
    drawCover(g, 0, 0, 320, 240, project);
    coverCache.set(project.id, c.toDataURL('image/png'));
  }
  return coverCache.get(project.id);
}

export function setThumb(imgEl, project, size = '216x163') {
  imgEl.alt = '';
  imgEl.onload = () => { imgEl.onload = null; if (isPlaceholder(imgEl)) imgEl.src = coverURL(project); };
  imgEl.onerror = () => { imgEl.onerror = null; imgEl.src = coverURL(project); };
  imgEl.src = projectImage(project.id, size) || coverURL(project);
}

export function initialAvatar(name) {
  const [c, g] = canvas(120, 120);
  const hue = hashString(name) % 360;
  g.fillStyle = `hsl(${hue} 75% 62%)`;
  g.fillRect(0, 0, 120, 120);
  g.fillStyle = '#fff';
  g.font = '700 74px Fredoka';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(name[0].toUpperCase(), 60, 66);
  return c;
}

export const assetURL = (md5) => (BUNDLE ? BUNDLE.costumes[md5] || '' : `https://assets.scratch.mit.edu/internalapi/asset/${md5}/get/`);

export const api = {
  hasCode: (id) => !BUNDLE || id in BUNDLE.code,
  async get(path) {
    if (BUNDLE) {
      const [, , kind, arg] = path.split('/');
      const found = kind === 'code' ? BUNDLE.code[arg] : BUNDLE.rooms[decodeURIComponent(arg)]?.[kind];
      if (found) return found;
      throw Object.assign(new Error('Not in this edition.'), { status: 404 });
    }
    const r = await fetch(path);
    let body = null;
    try { body = await r.json(); } catch { /* handled below */ }
    if (!r.ok) {
      const e = new Error((body && body.error) || 'Something went wrong.');
      e.status = r.status;
      throw e;
    }
    return body;
  },
  codeCache: new Map(),
  code(id) {
    if (!this.codeCache.has(id)) {
      this.codeCache.set(id, this.get(`/api/code/${id}`).catch((e) => { this.codeCache.delete(id); throw e; }));
    }
    return this.codeCache.get(id);
  },
};

/** Run async tasks with a concurrency limit. */
export async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { await fn(items[i], i); } catch { /* one failed item never stops the rest */ }
    }
  }));
}
