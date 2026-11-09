// The flat stations: poster, calendar, and the control panel with its leaderboard.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { api, canvas, projectImage, canvasTexture, fitText, MONTHS, num, plural, roundRect, seeded, yearColor } from './util.js';

function framedPlane(w, h, texture, frameColor, depth = 0.1) {
  const group = new THREE.Group();
  const frame = new THREE.Mesh(new RoundedBoxGeometry(w + 0.22, h + 0.22, depth, 2, 0.05), new THREE.MeshStandardMaterial({ color: frameColor, roughness: 0.5 }));
  frame.castShadow = true;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
  face.position.z = depth / 2 + 0.004;
  group.add(frame, face);
  return { group, face };
}

// ------------------------------------------------------------ poster
/** Mosaic with the most-loved project biggest. Returns rectangles for hit-testing. */
function posterLayout(data, W, H, top) {
  const ranked = data.byLoves.slice(0, 480);
  const sizeOf = (i) => (i === 0 ? 4 : i < 5 ? 2 : 1);
  const units = ranked.reduce((s, _, i) => s + sizeOf(i) ** 2, 0) || 1;
  const areaH = H - top;
  const aspect = (W / areaH) / (4 / 3);
  let cols = Math.max(4, Math.ceil(Math.sqrt(units * aspect)));
  let rows, cells, rects;
  for (;; cols++) {
    rows = Math.max(4, Math.ceil(cols / aspect));
    cells = new Array(rows * cols).fill(false);
    rects = [];
    let ok = true;
    for (let i = 0; i < ranked.length && ok; i++) {
      const s = sizeOf(i);
      let placed = false;
      for (let r = 0; r <= rows - s && !placed; r++) {
        for (let c = 0; c <= cols - s && !placed; c++) {
          let free = true;
          for (let a = 0; a < s && free; a++) for (let b = 0; b < s && free; b++) if (cells[(r + a) * cols + c + b]) free = false;
          if (free) {
            for (let a = 0; a < s; a++) for (let b = 0; b < s; b++) cells[(r + a) * cols + c + b] = true;
            rects.push({ p: ranked[i], c, r, s });
            placed = true;
          }
        }
      }
      ok = placed;
    }
    if (ok) break;
  }
  const cw = W / cols, ch = areaH / rows;
  const out = rects.map((q) => ({ p: q.p, big: q.s > 1, x: q.c * cw, y: top + q.r * ch, w: q.s * cw, h: q.s * ch }));
  const gaps = [];
  cells.forEach((used, i) => { if (!used) gaps.push({ x: (i % cols) * cw, y: top + Math.floor(i / cols) * ch, w: cw, h: ch }); });
  return { rects: out, gaps };
}

export function buildPoster(ctx, place) {
  const { data, atlas, ui, scene } = ctx;
  const W = 2048, H = 1000, TOP = 130;
  const [c, g] = canvas(W, H);
  const tex = canvasTexture(c);
  const { rects, gaps } = posterLayout(data, W, H, TOP);
  const bigImages = new Map();
  const rnd = seeded(data.seed);
  const gapColors = gaps.map(() => [data.paint.trim, data.paint.accent, '#ffc531', '#ff6fb5', '#3aa0ff'][Math.floor(rnd() * 5)]);

  const draw = () => {
    g.fillStyle = data.paint.trim;
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#fff';
    g.font = '700 84px Fredoka';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillText(fitText(g, `${data.profile.username}'s greatest hits`, W - 620), 36, TOP / 2 + 4);
    g.textAlign = 'right';
    g.font = '500 44px Fredoka';
    g.fillText(`${plural(data.projects.length, 'project')} · biggest = most loved`, W - 36, TOP / 2 + 4);
    gaps.forEach((q, i) => { g.fillStyle = gapColors[i]; g.fillRect(q.x + 2, q.y + 2, q.w - 4, q.h - 4); });
    for (const r of rects) {
      const big = bigImages.get(r.p.id);
      if (big) g.drawImage(big, r.x + 2, r.y + 2, r.w - 4, r.h - 4);
      else atlas.draw(g, r.p.index, r.x + 2, r.y + 2, r.w - 4, r.h - 4);
    }
    tex.needsUpdate = true;
  };
  draw();
  atlas.onChange(draw);
  // The largest tiles deserve sharper images than the atlas holds.
  for (const r of rects.filter((q) => q.big)) {
    const img = new Image();
    img.onload = () => { if (img.naturalWidth > 60) { bigImages.set(r.p.id, img); atlas.dirty = true; } };
    img.src = projectImage(r.p.id, '480x360');
  }

  const { group, face } = framedPlane(place.width, place.width * (H / W), tex, data.paint.accent);
  group.position.copy(place.position);
  group.rotation.y = place.rotationY;
  scene.add(group);
  ctx.pickables.push(group);
  const at = (hit) => {
    const x = hit.uv.x * W, y = (1 - hit.uv.y) * H;
    return rects.find((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  };
  face.userData.pick = {
    hover(hit) { const r = at(hit); return r ? { project: r.p } : { title: 'Greatest hits', sub: 'The most-loved project gets the biggest spot.' }; },
    click(hit) { const r = at(hit); if (r) ui.openProject(r.p); },
  };
}

// ------------------------------------------------------------ calendar
export function buildCalendar(ctx, place) {
  const { data, ui, scene } = ctx;
  const projects = data.projects;
  const W = 1024, H = 800;
  const [c, g] = canvas(W, H);
  const first = projects.length ? projects[0].year : new Date().getFullYear();
  const last = Math.max(new Date().getFullYear(), first);
  const years = last - first + 1;
  const counts = new Map();
  for (const p of projects) {
    const key = p.year * 12 + p.month;
    if (!counts.has(key)) counts.set(key, []);
    counts.get(key).push(p);
  }
  const max = Math.max(1, ...[...counts.values()].map((v) => v.length));
  let busiest = null;
  for (const [key, v] of counts) if (!busiest || v.length > busiest.n) busiest = { n: v.length, key };

  const LEFT = 104, TOP = 158, RIGHT = 24, BOTTOM = 24;
  const cw = (W - LEFT - RIGHT) / 12;
  const ch = (H - TOP - BOTTOM) / years;

  g.fillStyle = '#fffdf6';
  g.fillRect(0, 0, W, H);
  g.fillStyle = data.paint.accent;
  g.fillRect(0, 0, W, 104);
  g.fillStyle = '#fff';
  g.font = '700 58px Fredoka';
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillText('Making calendar', 28, 56);
  g.textAlign = 'right';
  g.font = '500 28px Fredoka';
  if (busiest) g.fillText(`Busiest: ${MONTHS[busiest.key % 12]} ${Math.floor(busiest.key / 12)} (${busiest.n})`, W - 24, 56);
  g.fillStyle = '#1d2145';
  g.font = '600 24px Fredoka';
  g.textAlign = 'center';
  MONTHS.forEach((m, i) => g.fillText(m, LEFT + cw * (i + 0.5), TOP - 28));
  g.textAlign = 'right';
  g.font = `600 ${Math.min(26, ch * 0.72)}px Fredoka`;
  for (let y = 0; y < years; y++) {
    const year = first + y;
    g.fillStyle = '#1d2145';
    g.fillText(String(year), LEFT - 14, TOP + ch * (y + 0.5) + 1);
    for (let m = 0; m < 12; m++) {
      const list = counts.get(year * 12 + m);
      const x = LEFT + cw * m + 2, cy = TOP + ch * y + 2;
      if (list) {
        const col = yearColor(year, first, last);
        const k = Math.sqrt(list.length / max);
        g.fillStyle = '#' + col.clone().lerp(new THREE.Color('#fff3d6'), 0.62 - 0.62 * k).getHexString();
      } else g.fillStyle = '#efe9da';
      roundRect(g, x, cy, cw - 4, ch - 4, Math.min(8, ch / 4));
      g.fill();
      if (list && ch > 26) {
        g.fillStyle = '#1d2145';
        g.textAlign = 'center';
        g.font = `600 ${Math.min(22, ch * 0.55)}px Fredoka`;
        g.fillText(String(list.length), x + (cw - 4) / 2, cy + (ch - 4) / 2 + 1);
        g.textAlign = 'right';
        g.font = `600 ${Math.min(26, ch * 0.72)}px Fredoka`;
      }
    }
  }
  const { group, face } = framedPlane(place.width, place.width * (H / W), canvasTexture(c), '#fffdf6', 0.08);
  group.position.copy(place.position);
  group.rotation.y = place.rotationY;
  scene.add(group);
  ctx.pickables.push(group);
  const at = (hit) => {
    const x = hit.uv.x * W, y = (1 - hit.uv.y) * H;
    const m = Math.floor((x - LEFT) / cw), r = Math.floor((y - TOP) / ch);
    if (m < 0 || m > 11 || r < 0 || r >= years) return null;
    return { year: first + r, month: m, list: counts.get((first + r) * 12 + m) };
  };
  face.userData.pick = {
    hover(hit) {
      const q = at(hit);
      if (!q) return { title: 'Making calendar', sub: 'Every month you shared a project. Click a coloured month.' };
      const label = `${MONTHS[q.month]} ${q.year}`;
      if (!q.list) return { title: label, sub: 'Nothing shared this month' };
      if (q.list.length === 1) return { project: q.list[0], badge: label };
      return { project: q.list[0], badge: `${label}: ${q.list.length} projects. Click to see them all.` };
    },
    click(hit) {
      const q = at(hit);
      if (!q?.list) return;
      if (q.list.length === 1) ui.openProject(q.list[0]);
      else ui.openList(`${MONTHS[q.month]} ${q.year}`, q.list);
    },
  };
}

// ------------------------------------------------------------ control panel
const METRICS = [
  { key: 'views', label: 'VIEWS', color: '#3aa0ff' },
  { key: 'loves', label: 'LOVES', color: '#ff5a3c' },
  { key: 'favorites', label: 'FAVES', color: '#ffc531' },
  { key: 'comments', label: 'COMMENTS', color: '#12bfa0', scan: true },
  { key: 'remixes', label: 'REMIXES', color: '#8a5cf6', scan: true },
  { key: 'newest', label: 'NEWEST', color: '#ff6fb5' },
];

export function buildPanel(ctx, place, floor) {
  const { data, atlas, ui, scene, sound } = ctx;
  const group = new THREE.Group();
  group.position.copy(place.position);
  group.rotation.y = place.rotationY;
  scene.add(group);
  ctx.pickables.push(group);

  const w = place.width, h = 3.5;
  const back = new THREE.Mesh(new RoundedBoxGeometry(w, h, 0.16, 2, 0.08), new THREE.MeshStandardMaterial({ color: '#2a2f62', roughness: 0.45 }));
  back.castShadow = true;
  group.add(back);

  const DW = 1024, DH = 560;
  const [c, g] = canvas(DW, DH);
  const tex = canvasTexture(c);
  const screenW = w - 0.3, screenH = screenW * (DH / DW);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(screenW, screenH), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  screen.position.set(0, h / 2 - 0.15 - screenH / 2, 0.085);
  group.add(screen);

  const ROW_TOP = 78, ROW_H = 94;
  let rows = [];
  let current = null;
  let scan = null;
  let scanning = false;

  const valueOf = (p, m) => {
    if (m.key === 'newest') return p.index;
    if (m.scan) return scan?.get(p.id)?.[m.key] ?? -1;
    return p[m.key];
  };
  const showValue = (p, m) => {
    if (m.key === 'newest') return String(p.year);
    const v = valueOf(p, m);
    return num(v) + (m.key === 'comments' && scan?.get(p.id)?.commentsCapped ? '+' : '');
  };

  const draw = (message) => {
    g.fillStyle = '#10132f';
    g.fillRect(0, 0, DW, DH);
    if (!current) {
      g.fillStyle = '#fff7e8';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = '700 62px Fredoka';
      g.fillText('PICK A BUTTON', DW / 2, DH / 2 - 44);
      g.font = '500 34px Fredoka';
      g.fillStyle = '#b8c0ff';
      g.fillText('Watch the top projects here,', DW / 2, DH / 2 + 28);
      g.fillText('and watch your floor rise!', DW / 2, DH / 2 + 72);
      tex.needsUpdate = true;
      return;
    }
    g.fillStyle = current.color;
    g.fillRect(0, 0, DW, 66);
    g.fillStyle = '#10132f';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.font = '700 42px Fredoka';
    g.fillText(current.key === 'newest' ? 'NEWEST' : `MOST ${current.label}`, 22, 35);
    g.textAlign = 'right';
    g.font = '500 25px Fredoka';
    if (current.scan && scan) g.fillText(`checked the ${scan.size} most-viewed`, DW - 22, 35);
    if (message) {
      g.fillStyle = '#fff7e8';
      g.textAlign = 'center';
      g.font = '600 42px Fredoka';
      g.fillText(message, DW / 2, DH / 2 + 30);
      tex.needsUpdate = true;
      return;
    }
    rows.forEach((p, i) => {
      const y = ROW_TOP + i * ROW_H;
      g.fillStyle = i % 2 ? '#191d45' : '#22275a';
      roundRect(g, 10, y, DW - 20, ROW_H - 6, 12);
      g.fill();
      g.fillStyle = current.color;
      g.textAlign = 'center';
      g.font = '700 44px Fredoka';
      g.fillText(String(i + 1), 44, y + ROW_H / 2);
      atlas.draw(g, p.index, 78, y + 5, 104, ROW_H - 16);
      g.fillStyle = '#fff';
      g.textAlign = 'left';
      g.font = '600 35px Fredoka';
      g.fillText(fitText(g, p.title, DW - 200 - 200), 198, y + ROW_H / 2);
      g.textAlign = 'right';
      g.fillStyle = current.color;
      g.font = '700 44px Fredoka';
      g.fillText(showValue(p, current), DW - 26, y + ROW_H / 2);
    });
    tex.needsUpdate = true;
  };
  draw();
  atlas.onChange(() => draw());

  const rowAt = (hit) => {
    const y = (1 - hit.uv.y) * DH;
    const i = Math.floor((y - ROW_TOP) / ROW_H);
    return i >= 0 ? rows[i] : null;
  };
  screen.userData.pick = {
    hover(hit) { const p = current && rowAt(hit); return p ? { project: p } : { title: 'Leaderboard', sub: 'Push a button below.' }; },
    click(hit) { const p = current && rowAt(hit); if (p) ui.openProject(p); },
  };

  const apply = (m) => {
    const list = data.projects.filter((p) => valueOf(p, m) > 0 || m.key === 'newest');
    rows = [...list].sort((a, b) => valueOf(b, m) - valueOf(a, m)).slice(0, 5);
    draw();
    if (m.key === 'newest') {
      const n = Math.max(1, data.projects.length - 1);
      floor.setHeights((p) => Math.pow(p.index / n, 2));
    } else {
      const max = Math.max(1, ...list.map((p) => valueOf(p, m)));
      floor.setHeights((p) => Math.sqrt(Math.max(0, valueOf(p, m)) / max));
    }
  };

  const press = async (m, button) => {
    sound.unlock();
    sound.press();
    button.depress = 1;
    if (current === m) {   // pushing the lit button again flattens the floor
      current = null;
      rows = [];
      draw();
      floor.setHeights(null);
      refreshLights();
      return;
    }
    current = m;
    refreshLights();
    if (m.scan && !scan) {
      draw('Counting…');
      if (!scanning) {
        scanning = true;
        try {
          const res = await api.get(`/api/scan/${encodeURIComponent(data.profile.username)}`);
          scan = new Map(res.results.map((r) => [r.id, r]));
        } catch (e) {
          scanning = false;
          draw(e.message);
          return;
        }
        scanning = false;
      }
      if (current !== m && !current?.scan) return;
    }
    apply(current);
  };

  const buttons = [];
  const cols = 3;
  const bottomArea = h - screenH - 0.3;
  METRICS.forEach((m, i) => {
    const bx = (i % cols - 1) * (w / 3.1);
    const by = -h / 2 + bottomArea * (i < cols ? 0.75 : 0.27);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.23, 0.05, 28).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#111433' }));
    base.position.set(bx, by + 0.07, 0.09);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.18, 0.09, 28).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: m.color, roughness: 0.3, emissive: m.color, emissiveIntensity: 0.1 }));
    cap.position.set(bx, by + 0.07, 0.15);
    const [lc, lg] = canvas(256, 48);
    lg.fillStyle = '#fff';
    lg.font = '600 36px Fredoka';
    lg.textAlign = 'center';
    lg.textBaseline = 'middle';
    lg.fillText(m.label, 128, 26);
    const label = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.135), new THREE.MeshBasicMaterial({ map: canvasTexture(lc), transparent: true, toneMapped: false }));
    label.position.set(bx, by - 0.21, 0.085);
    label.raycast = () => {};
    group.add(base, cap, label);
    const button = { m, cap, base, depress: 0 };
    buttons.push(button);
    const pick = {
      hover: () => ({ title: `Most ${m.label.toLowerCase()}`.replace('Most newest', 'Newest'), sub: current === m ? 'Push again to flatten the floor.' : m.scan ? 'Counts on your top 30, since Scratch only shares these one project at a time.' : 'Push me!' }),
      click: () => press(m, button),
    };
    cap.userData.pick = pick;
    base.userData.pick = pick;
  });
  function refreshLights() {
    for (const b of buttons) b.cap.material.emissiveIntensity = b.m === current ? 0.9 : 0.1;
  }

  back.userData.pick = { hover: () => ({ title: 'Control panel', sub: 'Push a button to rank your projects.' }) };

  return {
    press: (i) => press(METRICS[i], buttons[i]),
    state: () => ({ current: current?.key ?? null, rows: rows.map((r) => r.title) }),
    update(dt) {
      for (const b of buttons) {
        if (b.depress > 0) b.depress = Math.max(0, b.depress - dt * 4);
        b.cap.position.z = 0.15 - Math.sin(Math.min(1, b.depress) * Math.PI) * 0.05;
      }
    },
  };
}
