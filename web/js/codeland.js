// Inside the computer: each project's real scripts, drawn as blocks and splayed in 3D.
// Every project becomes a curved wall of code, arranged in a spiral around where you arrive.
import * as THREE from 'three';
import { pose, Rig } from './engine.js';
import { api, canvas, canvasTexture, CATEGORY_COLORS, el, fitText, labelSprite, num, plural, pool, roundRect, seeded } from './util.js';

const ATLAS = 2048;
const ROW = 30;
const INDENT = 18;
const PX = 0.0072;         // world metres per canvas pixel
const FONT = '600 17px Fredoka';
const BATCH = 14;

const shade = (hex, f) => '#' + new THREE.Color(hex).multiplyScalar(f).getHexString();

/** Draw one script like a stack of blocks. Returns its size, or draws when ctx is given. */
function measure(g, script) {
  g.font = FONT;
  let w = 180;
  for (const r of script.rows) w = Math.max(w, g.measureText(r.t).width + 34 + r.d * INDENT);
  const rows = script.rows.length + (script.more ? 1 : 0);
  return { w: Math.min(Math.ceil(w) + 6, 470), h: rows * ROW + 16 };
}

function drawScript(g, script, x, y, w) {
  g.font = FONT;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  let cy = y + 8;
  // C-block arms first, so they sit behind the rows.
  const open = [];
  script.rows.forEach((r, i) => {
    while (open.length && open[open.length - 1].d >= r.d) {
      const o = open.pop();
      g.fillStyle = CATEGORY_COLORS.control;
      g.fillRect(x + o.d * INDENT, y + 8 + (o.i + 1) * ROW - 2, INDENT, (i - o.i - 1) * ROW + 4);
    }
    const nextDeeper = script.rows[i + 1] && script.rows[i + 1].d > r.d;
    if (nextDeeper) open.push({ d: r.d, i });
  });
  while (open.length) {
    const o = open.pop();
    g.fillStyle = CATEGORY_COLORS.control;
    g.fillRect(x + o.d * INDENT, y + 8 + (o.i + 1) * ROW - 2, INDENT, (script.rows.length - o.i - 1) * ROW + 4);
  }
  for (const r of script.rows) {
    const color = CATEGORY_COLORS[r.c] || CATEGORY_COLORS.extension;
    const left = x + r.d * INDENT;
    const width = w - r.d * INDENT - 4;
    g.fillStyle = color;
    roundRect(g, left, cy, width, ROW - 2, r.k === 'hat' ? [12, 12, 4, 4] : 5);
    g.fill();
    g.fillStyle = shade(color, 0.72);
    g.fillRect(left + 12, cy + ROW - 3, 18, 3);
    g.fillStyle = '#fff';
    g.fillText(fitText(g, r.t, width - 22), left + 11, cy + ROW / 2);
    cy += ROW;
  }
  if (script.more) {
    g.fillStyle = '#ffffffcc';
    g.fillText(`… and ${script.more} more blocks`, x + 10, cy + ROW / 2);
  }
}

/** Shelf-pack scripts into a texture. Longest first; whatever doesn't fit is reported. */
function pack(scripts) {
  const [c, g] = canvas(ATLAS, ATLAS);
  const placed = [];
  const sized = scripts.map((s) => ({ s, ...measure(g, s.script) })).sort((a, b) => b.h - a.h);
  let x = 0, y = 0, shelf = 0, dropped = 0;
  for (const item of sized) {
    if (x + item.w > ATLAS) { x = 0; y += shelf + 4; shelf = 0; }
    if (y + item.h > ATLAS) { dropped++; continue; }
    drawScript(g, item.s.script, x + 2, y, item.w - 4);
    placed.push({ ...item, x, y });
    x += item.w + 4;
    shelf = Math.max(shelf, item.h);
  }
  return { canvas: c, placed, dropped };
}

export class CodeLand {
  constructor(ctx, handlers) {
    this.ctx = ctx;
    this.handlers = handlers;
    this.name = 'code';
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0d0f2e');
    this.scene.fog = new THREE.FogExp2('#0d0f2e', 0.0052);
    const camera = new THREE.PerspectiveCamera(66, innerWidth / innerHeight, 0.05, 700);
    camera.baseFov = 66;
    this.rig = new Rig(camera, { fly: true, speed: 9 });
    this.pickables = [];
    this.islands = [];
    this.totals = {};
    this.blockTotal = 0;
    this.scriptTotal = 0;
    this.cursor = 0;
    this.focus = -1;
    this.spotCount = 0;
    this.buildBackdrop();
    this.queue = this.chooseOrder();
    this.queued = 0;
  }

  /** Newer files hold readable code, and many views means more people have seen it. */
  chooseOrder() {
    const projects = this.ctx.data.projects.filter((p) => api.hasCode(p.id));
    const readable = projects.filter((p) => p.year >= 2013).sort((a, b) => b.views - a.views);
    const old = projects.filter((p) => p.year < 2013).sort((a, b) => b.views - a.views);
    const merged = [];
    let i = 0, j = 0;
    while (i < readable.length || j < old.length) {   // roughly 3 readable to 1 older
      for (let k = 0; k < 3 && i < readable.length; k++) merged.push(readable[i++]);
      if (j < old.length) merged.push(old[j++]);
    }
    return merged;
  }

  buildBackdrop() {
    const { scene } = this;
    const rnd = seeded(this.ctx.data.seed + 21);
    const geo = new THREE.BufferGeometry();
    const pts = new Float32Array(3000 * 3);
    for (let i = 0; i < pts.length; i++) pts[i] = (rnd() - 0.5) * 520;
    geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    this.stars = new THREE.Points(geo, new THREE.PointsMaterial({ color: '#cfd8ff', size: 0.55, fog: false }));
    this.stars.raycast = () => {};
    scene.add(this.stars);

    const grid = new THREE.GridHelper(700, 70, '#5a44d8', '#2a2c7a');
    grid.position.y = -9;
    grid.raycast = () => {};
    scene.add(grid);

    // Loose blocks drifting past, in the real block colours.
    const colors = Object.values(CATEGORY_COLORS);
    const floaters = new THREE.InstancedMesh(new THREE.BoxGeometry(1.4, 0.34, 0.5), new THREE.MeshBasicMaterial({ fog: true }), 220);
    const d = new THREE.Object3D();
    const c = new THREE.Color();
    this.floaterData = [];
    for (let i = 0; i < 220; i++) {
      const a = rnd() * 6.28, r = 12 + rnd() * 190;
      const f = { x: Math.cos(a) * r, y: -8 + rnd() * 50, z: Math.sin(a) * r, s: 0.6 + rnd() * 1.6, ry: rnd() * 6.28, v: 0.1 + rnd() * 0.5 };
      this.floaterData.push(f);
      d.position.set(f.x, f.y, f.z);
      d.rotation.y = f.ry;
      d.scale.setScalar(f.s);
      d.updateMatrix();
      floaters.setMatrixAt(i, d.matrix);
      floaters.setColorAt(i, c.set(colors[i % colors.length]));
    }
    floaters.raycast = () => {};
    floaters.frustumCulled = false;
    this.floaters = floaters;
    scene.add(floaters);
  }

  spot() {
    // Golden-angle spiral: a new wall always has clear space and faces the middle.
    const i = this.spotCount++;
    const a = i * 2.39996;
    const r = 13 + i * 4.6;
    return new THREE.Vector3(Math.cos(a) * r, Math.sin(i * 1.3) * 3 + 0.5, Math.sin(a) * r);
  }

  addIsland(project, code) {
    const at = this.spot();
    if (code.format === 'sb1' || !code.blockCount) this.addCapsule(project, at, code);
    else this.addCodeWall(project, code, at);
    for (const [k, v] of Object.entries(code.blockTotals)) this.totals[k] = (this.totals[k] || 0) + v;
    this.blockTotal += code.blockCount;
    this.scriptTotal += code.scriptCount;
    this.renderDna();
  }

  addCodeWall(project, code, at) {
    const scripts = code.sprites.flatMap((sprite) => sprite.scripts.map((script) => ({ script, sprite: sprite.name })));
    const { canvas: c, placed, dropped } = pack(scripts);
    const tex = canvasTexture(c);
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;

    // Lay scripts into columns along a curve, centred on the direction back to the middle.
    const columns = [];
    let col = { items: [], w: 0, h: 0 };
    const maxH = 9.5;
    for (const item of placed) {
      const h = item.h * PX, w = item.w * PX;
      if (col.h + h > maxH && col.items.length) { columns.push(col); col = { items: [], w: 0, h: 0 }; }
      col.items.push(item);
      col.h += h + 0.14;
      col.w = Math.max(col.w, w);
    }
    if (col.items.length) columns.push(col);

    const totalW = columns.reduce((s, q) => s + q.w + 0.3, 0);
    const radius = Math.max(6, totalW / 2.4);
    const toMiddle = Math.atan2(-at.x, -at.z);
    const view = at.clone();

    const positions = [], uvs = [], index = [];
    const owners = [];
    let along = -totalW / 2;
    const quad = (cx, cy, cz, yaw, w, h, it) => {
      const n = positions.length / 3;
      const rx = Math.cos(yaw) * w / 2, rz = -Math.sin(yaw) * w / 2;
      positions.push(cx - rx, cy - h / 2, cz - rz, cx + rx, cy - h / 2, cz + rz, cx + rx, cy + h / 2, cz + rz, cx - rx, cy + h / 2, cz - rz);
      const u0 = it.x / ATLAS, u1 = (it.x + it.w) / ATLAS, v1 = 1 - it.y / ATLAS, v0 = 1 - (it.y + it.h) / ATLAS;
      uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
      index.push(n, n + 1, n + 2, n, n + 2, n + 3);
      owners.push(it, it);
    };
    for (const q of columns) {
      const mid = along + q.w / 2;
      along += q.w + 0.3;
      const angle = mid / radius;
      const yaw = toMiddle + angle + Math.PI;   // direction from the curve's centre out to this column
      const cx = view.x + Math.sin(yaw) * radius;
      const cz = view.z + Math.cos(yaw) * radius;
      let top = view.y + q.h / 2;
      for (const it of q.items) {
        const w = it.w * PX, h = it.h * PX;
        quad(cx, top - h / 2, cz, yaw + Math.PI, w, h, it);
        top -= h + 0.14;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(index);
    const wall = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.04, toneMapped: false, side: THREE.DoubleSide }));
    wall.userData.pick = {
      hover: (hit) => {
        const it = owners[hit.faceIndex];
        const first = it?.s.script.rows[0];
        return { title: it ? it.s.sprite : project.title, sub: first ? `${first.t} (${plural(it.s.script.rows.length + it.s.script.more, 'block')})` : project.title };
      },
      click: (hit) => {
        const it = owners[hit.faceIndex];
        if (!it) return;
        const dir = hit.face.normal.clone();
        const flip = dir.dot(this.rig.camera.position.clone().sub(hit.point)) < 0 ? -1 : 1;
        const eye = hit.point.clone().addScaledVector(dir, flip * 3.2);
        this.rig.glide(pose([eye.x, eye.y, eye.z], [hit.point.x, hit.point.y, hit.point.z]), 0.8);
      },
    };
    this.scene.add(wall);
    this.pickables.push(wall);

    const sign = this.signFor(project, view);
    const title = labelSprite(project.title, { height: 0.8, bg: '#ff5a3c' });
    title.position.set(view.x, view.y + maxH / 2 + 1.5, view.z);
    this.scene.add(title);
    const facing = new THREE.Vector3(-Math.sin(toMiddle), 0, -Math.cos(toMiddle));
    const curveMid = view.clone().addScaledVector(facing, radius);
    title.position.set(curveMid.x, view.y + maxH / 2 + 1.4, curveMid.z);
    sign.position.set(curveMid.x, view.y - maxH / 2 - 2.2, curveMid.z);

    // Stand so the whole curve fills the view.
    const standDist = Math.min(radius * 0.95, 8);
    const stand = curveMid.clone().addScaledVector(facing, -standDist);
    this.islands.push({
      project, kind: 'code', view: pose([stand.x, stand.y + 0.4, stand.z], [curveMid.x, curveMid.y + 0.2, curveMid.z]),
      summary: `${plural(code.blockCount, 'block')} in ${plural(code.scriptCount, 'script')}${dropped ? ' (biggest shown)' : ''}`,
    });
  }

  /** A framed thumbnail that opens the project. */
  signFor(project, at) {
    const { atlas, ui } = this.ctx;
    const [c, g] = canvas(240, 180);
    const tex = canvasTexture(c);
    const paint = () => { atlas.draw(g, project.index, 0, 0, 240, 180); tex.needsUpdate = true; };
    paint();
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.8), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, side: THREE.DoubleSide }));
    sign.position.copy(at);
    sign.onBeforeRender = (r, s, cam) => { sign.quaternion.copy(cam.quaternion); };
    sign.userData.pick = { hover: () => ({ project }), click: () => ui.openProject(project) };
    this.scene.add(sign);
    this.pickables.push(sign);
    return sign;
  }

  addCapsule(project, at, code) {
    const { atlas, ui } = this.ctx;
    const [c, g] = canvas(240, 180);
    atlas.draw(g, project.index, 0, 0, 240, 180);
    const tex = canvasTexture(c);
    const sealed = code.format === 'sb1';
    const crate = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), [
      new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
      new THREE.MeshBasicMaterial({ color: '#ffc531', toneMapped: false }), new THREE.MeshBasicMaterial({ color: '#ff8a1f', toneMapped: false }),
      new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
    ]);
    crate.position.copy(at);
    crate.userData.spin = true;
    crate.userData.pick = {
      hover: () => ({ project, badge: sealed ? `Time capsule from ${project.year}: code sealed in an old file format` : 'No code blocks in this one' }),
      click: () => ui.openProject(project),
    };
    this.scene.add(crate);
    this.pickables.push(crate);
    (this.spinners ||= []).push(crate);
    const title = labelSprite(sealed ? `Time capsule: ${project.title}` : project.title, { height: 0.56, bg: sealed ? '#8a5cf6' : '#1d2145' });
    title.position.set(at.x, at.y + 2.7, at.z);
    this.scene.add(title);
    const out = new THREE.Vector3(at.x, 0, at.z).normalize();
    const stand = at.clone().addScaledVector(out, -7.5);
    this.islands.push({ project, kind: 'capsule', view: pose([stand.x, stand.y + 0.9, stand.z], [at.x, at.y, at.z]),
      summary: sealed ? `Time capsule from ${project.year}. Its code is in an old file format.` : 'No code blocks' });
  }

  async loadMore(count = BATCH) {
    const batch = this.queue.slice(this.queued, this.queued + count);
    this.queued += batch.length;
    if (!batch.length) return;
    this.setStatus(`Opening ${plural(batch.length, 'project')}…`);
    await pool(batch, 3, async (p) => {
      const code = await api.code(p.id);
      this.addIsland(p, code);
      this.setStatus(`${plural(this.islands.length, 'project')} loaded`);
      if (this.islands.length === 1 && this.focus < 0) this.show(0);
    });
    this.renderHud();
  }

  async focusProject(project) {
    const i = this.islands.findIndex((q) => q.project.id === project.id);
    if (i >= 0) return this.show(i);
    const code = await api.code(project.id);
    this.addIsland(project, code);
    const j = this.queue.findIndex((q) => q.id === project.id);
    if (j >= this.queued) { this.queue.splice(j, 1); }
    this.show(this.islands.length - 1);
  }

  show(i) {
    if (!this.islands.length) return;
    this.focus = (i + this.islands.length) % this.islands.length;
    const q = this.islands[this.focus];
    this.rig.glide(q.view, 1.5);
    this.renderHud();
  }

  setStatus(text) { if (this.statusEl) this.statusEl.textContent = text; }

  renderDna() {
    if (!this.dnaEl) return;
    const total = Object.values(this.totals).reduce((a, b) => a + b, 0) || 1;
    const sorted = Object.entries(this.totals).sort((a, b) => b[1] - a[1]);
    this.dnaEl.replaceChildren(...sorted.map(([k, v]) => el('i', { title: `${k}: ${num(v)}`, style: { width: `${(v / total) * 100}%`, background: CATEGORY_COLORS[k] || '#0fbd8c' } })));
    this.legendEl.replaceChildren(...sorted.slice(0, 7).map(([k, v]) => el('span', {}, el('i', { style: { background: CATEGORY_COLORS[k] || '#0fbd8c' } }), `${k} ${num(v)}`)));
    this.totalEl.textContent = `Your code so far: ${plural(this.blockTotal, 'block')}, ${plural(this.scriptTotal, 'script')}`;
  }

  renderHud() {
    if (!this.nowEl) return;
    const q = this.islands[this.focus];
    this.nowEl.textContent = q ? `${q.project.title}: ${q.summary}` : 'Opening projects…';
    this.moreBtn.hidden = this.queued >= this.queue.length;
    this.moreBtn.textContent = `Load more (${this.queue.length - this.queued} left)`;
  }

  buildHud() {
    const { ui } = this.ctx;
    ui.clearHud();
    this.statusEl = el('small', { style: { color: '#fff' } });
    this.nowEl = el('div', { class: 'now' });
    this.totalEl = el('div', { class: 'now', style: { fontSize: '15px', fontWeight: 500 } });
    this.dnaEl = el('div', { class: 'dna', 'aria-hidden': 'true' });
    this.legendEl = el('div', { class: 'legend' });
    this.moreBtn = el('button', { class: 'chip', onclick: () => this.loadMore() });
    const prev = el('button', { class: 'chip', text: 'Previous', onclick: () => this.show(this.focus - 1) });
    const next = el('button', { class: 'chip on', text: 'Next project', onclick: () => this.show(this.focus + 1) });
    ui.hud.append(
      el('div', { class: 'plate', style: { padding: '8px 14px' } }, el('div', {}, el('b', { text: 'Code Land' }), el('small', { text: 'WASD to fly, drag to look, click a script to zoom in' }))),
      el('div', { class: 'tools' }, ui.muteChip(), el('button', { class: 'chip', text: 'Back to the room', onclick: () => this.handlers.exit() })),
      el('div', { class: 'code-hud' }, this.nowEl, el('div', { class: 'row' }, prev, next, this.moreBtn), this.dnaEl, this.legendEl, this.totalEl, this.statusEl),
    );
    const stick = ui.joystick();
    if (stick) { stick.style.bottom = '190px'; ui.hud.append(stick); }
    this.renderDna();
    this.renderHud();
  }

  onEnter() {
    this.buildHud();
    if (!this.started) {
      this.started = true;
      this.rig.place({ x: 0, y: 2, z: 0, yaw: 0, pitch: 0 });
      this.loadMore();
    }
  }

  update(dt, t) {
    this.ctx.atlas.flush(t);
    if (this.spinners) for (const s of this.spinners) { s.rotation.y += dt * 0.5; s.rotation.x = Math.sin(t * 0.4) * 0.15; }
    const d = new THREE.Object3D();
    if (Math.floor(t * 30) % 2 === 0) {
      this.floaterData.forEach((f, i) => {
        d.position.set(f.x, f.y + Math.sin(t * f.v + i) * 1.2, f.z);
        d.rotation.y = f.ry + t * f.v * 0.3;
        d.scale.setScalar(f.s);
        d.updateMatrix();
        this.floaters.setMatrixAt(i, d.matrix);
      });
      this.floaters.instanceMatrix.needsUpdate = true;
    }
  }
}
