// The room: shell, furniture, station placement and the walk-around world object.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { pose, Rig } from './engine.js';
import { buildFloor } from './floor.js';
import { buildCalendar, buildPanel, buildPoster } from './wallart.js';
import { buildDisco } from './disco.js';
import { buildOutside } from './outside.js';
import { canvas, canvasTexture, CATEGORY_COLORS, clamp, isPlaceholder, labelSprite, loadImage, projectImage, roundRect, seeded, drawCover } from './util.js';

const WIDTH = 14, DEPTH = 11, HEIGHT = 4.4;
const X = WIDTH / 2, Z = DEPTH / 2;
const WIN = { x0: -2.4, x1: 2.4, y0: 1.05, y1: 3.45 };

// Footprints of solid furniture. Tiles aren't placed under these, and you can't walk through.
const BED = { x0: -6.9, x1: -3.6, z0: -5.4, z1: -1.5 };
const DESK = { x0: 3.3, x1: 6.9, z0: -5.4, z1: -3.8 };

function rbox(w, h, d, color, r = 0.05, mat = {}) {
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, r), new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...mat }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function wallpaper(paint, seed) {
  const [c, g] = canvas(512, 512);
  g.fillStyle = paint.wall;
  g.fillRect(0, 0, 512, 512);
  const rnd = seeded(seed + 3);
  g.fillStyle = paint.spot;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    const x = 64 + i * 128 + (j % 2 ? 64 : 0), y = 64 + j * 128;
    const kind = Math.floor(rnd() * 3);
    g.beginPath();
    if (kind === 0) g.arc(x % 512, y, 15, 0, 7);
    else if (kind === 1) { roundRect(g, (x % 512) - 14, y - 14, 28, 28, 7); } else { g.rect((x % 512) - 5, y - 18, 10, 36); g.rect((x % 512) - 18, y - 5, 36, 10); }
    g.fill();
  }
  const t = canvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function buildShell(ctx) {
  const { scene, data } = ctx;
  const paint = data.paint;
  const paper = wallpaper(paint, data.seed);
  const pieces = [];
  const wall = (w, h, x, y, z, rotY = 0) => {
    const tex = paper.clone();
    tex.repeat.set(w / 2.4, h / 2.4);
    tex.needsUpdate = true;
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.3), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 }));
    m.position.set(x, y, z);
    m.rotation.y = rotY;
    m.receiveShadow = true;
    pieces.push(m);
    scene.add(m);
    return m;
  };
  const backZ = -Z - 0.15;
  const sideW = X - WIN.x1;
  wall(sideW, HEIGHT, -X + sideW / 2, HEIGHT / 2, backZ);
  wall(sideW, HEIGHT, X - sideW / 2, HEIGHT / 2, backZ);
  wall(WIN.x1 - WIN.x0, WIN.y0, 0, WIN.y0 / 2, backZ);
  wall(WIN.x1 - WIN.x0, HEIGHT - WIN.y1, 0, (HEIGHT + WIN.y1) / 2, backZ);
  wall(WIDTH + 0.6, HEIGHT, 0, HEIGHT / 2, Z + 0.15);
  wall(DEPTH, HEIGHT, -X - 0.15, HEIGHT / 2, 0, Math.PI / 2);
  wall(DEPTH, HEIGHT, X + 0.15, HEIGHT / 2, 0, Math.PI / 2);

  // Glow-in-the-dark stars, one more thing that belongs on a kid's ceiling.
  const [starC, starG] = canvas(1024, 1024);
  starG.fillStyle = paint.spot;
  starG.fillRect(0, 0, 1024, 1024);
  const starRnd = seeded(data.seed + 5);
  starG.fillStyle = paint.ceil;
  for (let i = 0; i < 46; i++) {
    const cx = starRnd() * 1024, cy = starRnd() * 1024, r = 7 + starRnd() * 13;
    starG.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2, q = k % 2 ? r * 0.45 : r;
      starG.lineTo(cx + Math.cos(a) * q, cy + Math.sin(a) * q);
    }
    starG.fill();
  }
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(WIDTH + 0.6, DEPTH + 0.6).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ map: canvasTexture(starC), toneMapped: false }));
  ceil.position.y = HEIGHT;
  pieces.push(ceil);
  scene.add(ceil);
  const under = new THREE.Mesh(new THREE.PlaneGeometry(WIDTH, DEPTH).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#2a2f62' }));
  under.position.y = -0.11;
  under.raycast = () => {};
  scene.add(under);

  // Trim along the walls.
  const trim = new THREE.MeshStandardMaterial({ color: paint.trim, roughness: 0.5 });
  const addTrim = (w, x, z, rot) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, 0.05), trim);
    b.position.set(x, 0.08, z);
    b.rotation.y = rot;
    b.raycast = () => {};
    scene.add(b);
  };
  addTrim(WIDTH, 0, -Z + 0.02, 0); addTrim(WIDTH, 0, Z - 0.02, 0);
  addTrim(DEPTH, -X + 0.02, 0, Math.PI / 2); addTrim(DEPTH, X - 0.02, 0, Math.PI / 2);

  // Window frame.
  const wx = (WIN.x0 + WIN.x1) / 2, wy = (WIN.y0 + WIN.y1) / 2, ww = WIN.x1 - WIN.x0, wh = WIN.y1 - WIN.y0;
  const bar = (w, h, x, y, depth = 0.34) => {
    const b = rbox(w, h, depth, '#ffffff', 0.03);
    b.position.set(x, y, backZ + 0.03);
    b.castShadow = false;
    pieces.push(b);
    scene.add(b);
  };
  bar(ww + 0.32, 0.18, wx, WIN.y0, 0.6); bar(ww + 0.32, 0.14, wx, WIN.y1);
  bar(0.14, wh + 0.14, WIN.x0, wy); bar(0.14, wh + 0.14, WIN.x1, wy);
  bar(ww, 0.06, wx, WIN.y0 + wh * 0.8, 0.1);
  ctx.pickables.push(...pieces);
}

function buildLights(scene) {
  scene.add(new THREE.HemisphereLight('#ffffff', '#fff0dc', 2.1));
  const key = new THREE.DirectionalLight('#fff6e6', 1.15);
  key.position.set(4, 9, 5);
  key.target.position.set(0, 0, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 22 });
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.02;
  scene.add(key, key.target);
  const fill = new THREE.PointLight('#fff0dd', 8, 16);
  fill.position.set(0, 3.5, 0);
  scene.add(fill);
}

function buildBed(ctx, onDream) {
  const { scene, data, atlas } = ctx;
  const g = new THREE.Group();
  const w = BED.x1 - BED.x0 - 0.25, len = BED.z1 - BED.z0 - 0.15;
  const cx = (BED.x0 + BED.x1) / 2 - 0.05, cz = (BED.z0 + BED.z1) / 2;
  g.position.set(cx, 0, cz);
  const frame = rbox(w, 0.42, len, data.paint.trim, 0.06);
  frame.position.y = 0.21;
  const head = rbox(w, 1.5, 0.18, data.paint.trim, 0.08);
  head.position.set(0, 0.75, -len / 2 + 0.03);
  const mattress = rbox(w - 0.12, 0.26, len - 0.22, '#fffaf0', 0.1);
  mattress.position.set(0, 0.54, 0.05);
  const pillow = rbox(w * 0.62, 0.22, 0.62, '#ffffff', 0.1);
  pillow.position.set(0, 0.76, -len / 2 + 0.56);
  g.add(frame, head, mattress, pillow);

  // A quilt stitched from project thumbnails.
  const n = data.projects.length;
  const quiltBack = rbox(w - 0.02, 0.1, len * 0.62, data.paint.accent, 0.04);
  quiltBack.position.set(0, 0.66, len * 0.17);
  g.add(quiltBack);
  if (n) {
    const qc = 6, qr = 6;
    const qw = (w - 0.2) / qc, qd = (len * 0.62 - 0.2) / qr;
    const squares = atlas.instances(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), qc * qr, (k) => data.byLoves[k % n].index);
    const m = new THREE.Matrix4();
    for (let k = 0; k < qc * qr; k++) {
      const c = k % qc, r = Math.floor(k / qc);
      m.makeScale(qw * 0.92, 1, qd * 0.92);
      m.setPosition((c - (qc - 1) / 2) * qw, 0.715, len * 0.17 + (r - (qr - 1) / 2) * qd);
      squares.setMatrixAt(k, m);
    }
    squares.raycast = () => {};
    g.add(squares);
  }
  g.userData.pick = {
    hover: () => ({ title: 'Climb into bed', sub: 'Your projects blend into a dream, with their real sounds.' }),
    click: onDream,
  };
  scene.add(g);
  ctx.pickables.push(g);
  return { lookAt: [cx, 0.8, cz] };
}

function buildDesk(ctx, onCode) {
  const { scene, data } = ctx;
  const g = new THREE.Group();
  const cx = (DESK.x0 + DESK.x1) / 2, cz = (DESK.z0 + DESK.z1) / 2 - 0.1;
  g.position.set(cx, 0, cz);
  const top = rbox(3.3, 0.1, 1.25, '#e9b77a', 0.03);
  top.position.y = 0.88;
  g.add(top);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = rbox(0.09, 0.84, 0.09, data.paint.trim, 0.02);
    leg.position.set(sx * 1.52, 0.42, sz * 0.5);
    g.add(leg);
  }
  const monitor = rbox(1.72, 1.12, 0.1, '#23274f', 0.06);
  monitor.position.set(0, 1.62, -0.3);
  const stand = rbox(0.16, 0.34, 0.09, '#23274f', 0.02);
  stand.position.set(0, 1.03, -0.3);
  const base = rbox(0.56, 0.04, 0.32, '#23274f', 0.015);
  base.position.set(0, 0.95, -0.28);
  const keys = rbox(0.96, 0.04, 0.3, '#fffaf0', 0.015);
  keys.position.set(0, 0.95, 0.24);
  g.add(monitor, stand, base, keys);

  const SW = 512, SH = 320;
  const [c, sg] = canvas(SW, SH);
  const tex = canvasTexture(c);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.58, 0.98), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  screen.position.set(0, 1.62, -0.246);
  g.add(screen);

  const rnd = seeded(data.seed + 11);
  const colors = Object.values(CATEGORY_COLORS);
  const lines = Array.from({ length: 30 }, () => ({ c: colors[Math.floor(rnd() * colors.length)], d: Math.floor(rnd() * 3), w: 110 + rnd() * 240 }));
  const paintScreen = (t) => {
    sg.fillStyle = '#10132f';
    sg.fillRect(0, 0, SW, SH);
    const offset = (t * 26) % 28;
    lines.forEach((l, i) => {
      const y = ((i * 28 - offset + 840) % 840) - 28;
      if (y > SH) return;
      sg.fillStyle = l.c;
      roundRect(sg, 28 + l.d * 26, y, l.w, 23, 6);
      sg.fill();
    });
    sg.fillStyle = '#10132fcc';
    sg.fillRect(0, SH - 74, SW, 74);
    sg.fillStyle = '#fff';
    sg.font = '700 40px Fredoka';
    sg.textAlign = 'center';
    sg.textBaseline = 'middle';
    sg.fillText('Enter Code Land', SW / 2, SH - 36);
    tex.needsUpdate = true;
  };
  paintScreen(0);

  const chair = new THREE.Group();
  const seat = rbox(0.72, 0.1, 0.72, data.paint.accent, 0.05);
  seat.position.y = 0.52;
  const chairBack = rbox(0.72, 0.72, 0.1, data.paint.accent, 0.05);
  chairBack.position.set(0, 0.92, 0.34);
  const post = rbox(0.09, 0.5, 0.09, '#23274f', 0.02);
  post.position.y = 0.25;
  chair.add(seat, chairBack, post);
  chair.position.set(1.15, 0, 1.0);
  chair.rotation.y = -0.5;
  g.add(chair);

  g.userData.pick = {
    hover: () => ({ title: 'Your computer', sub: 'Dive inside to see your code spread out in 3D.' }),
    click: onCode,
  };
  scene.add(g);
  ctx.pickables.push(g);
  let last = 0;
  return {
    worldScreen: [cx, 1.62, cz - 0.24],
    update(t) { if (t - last > 0.12) { last = t; paintScreen(t); } },
  };
}

function buildDoor(ctx) {
  const { scene, data } = ctx;
  const g = new THREE.Group();
  g.position.set(3.6, 0, Z - 0.03);
  g.rotation.y = Math.PI;
  const door = rbox(1.6, 3, 0.1, data.paint.accent, 0.04);
  door.position.y = 1.5;
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), new THREE.MeshStandardMaterial({ color: '#ffc531', metalness: 0.5, roughness: 0.3 }));
  knob.position.set(0.58, 1.35, 0.1);
  const [c, sg] = canvas(512, 140);
  sg.fillStyle = '#fff7e8';
  roundRect(sg, 0, 0, 512, 140, 34);
  sg.fill();
  sg.fillStyle = '#1d2145';
  sg.font = '700 58px Fredoka';
  sg.textAlign = 'center';
  sg.textBaseline = 'middle';
  sg.fillText(`${data.profile.username}'s room`.slice(0, 18), 256, 74);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 0.34), new THREE.MeshBasicMaterial({ map: canvasTexture(c), transparent: true, toneMapped: false }));
  sign.position.set(0, 2.3, 0.056);
  g.add(door, knob, sign);
  g.userData.pick = {
    hover: () => ({ title: 'The door', sub: "Leave and visit someone else's room." }),
    click: () => ctx.leave(),
  };
  scene.add(g);
  ctx.pickables.push(g);
}

function buildShelf(ctx) {
  const { scene, data, ui } = ctx;
  const favs = data.favorites.slice(0, 12);
  if (!favs.length) return null;
  const g = new THREE.Group();
  g.position.set(-3.6, 0, Z - 0.02);
  g.rotation.y = Math.PI;
  scene.add(g);
  ctx.pickables.push(g);

  const cols = 4;
  const fw = 0.86, fh = 0.65, gapX = 1.05, rowH = 1.06;
  const rowCount = Math.ceil(favs.length / cols);
  const bottom = 1.15;
  for (let r = 0; r < rowCount; r++) {
    const shelf = rbox(cols * gapX + 0.2, 0.07, 0.34, '#e9b77a', 0.02);
    shelf.position.set(0, bottom + r * rowH - 0.02, 0.16);
    g.add(shelf);
  }
  const [lc, lg] = canvas(512, 72);
  lg.fillStyle = '#1d2145';
  roundRect(lg, 76, 0, 360, 72, 24);
  lg.fill();
  lg.fillStyle = '#fff7e8';
  lg.font = '600 42px Fredoka';
  lg.textAlign = 'center';
  lg.textBaseline = 'middle';
  lg.fillText('Their favorites', 256, 38);
  const label = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.253), new THREE.MeshBasicMaterial({ map: canvasTexture(lc), transparent: true, toneMapped: false }));
  label.position.set(0, bottom + rowCount * rowH - 0.05, 0.02);
  label.raycast = () => {};
  g.add(label);

  favs.forEach((p, i) => {
    const r = Math.floor(i / cols), col = i % cols;
    const [c, cg] = canvas(240, 180);
    drawCover(cg, 0, 0, 240, 180, p);
    const tex = canvasTexture(c);
    loadImage(projectImage(p.id, '216x163')).then((img) => {
      if (img && !isPlaceholder(img)) { cg.drawImage(img, 0, 0, 240, 180); tex.needsUpdate = true; }
    });
    const frame = rbox(fw + 0.08, fh + 0.08, 0.05, '#ffffff', 0.02);
    const pic = new THREE.Mesh(new THREE.PlaneGeometry(fw, fh), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    pic.position.z = 0.03;
    const item = new THREE.Group();
    item.add(frame, pic);
    item.position.set((col - (cols - 1) / 2) * gapX, bottom + r * rowH + fh / 2 + 0.05, 0.14);
    item.rotation.x = -0.06;
    item.userData.pick = { hover: () => ({ project: p, badge: 'One of their favorites' }), click: () => ui.openProject(p) };
    g.add(item);
  });
  return g;
}

function hint(scene, text, x, y, z, color) {
  const s = labelSprite(text, { bg: color, height: 0.3 });
  s.position.set(x, y, z);
  s.baseY = y;
  scene.add(s);
  return s;
}

export function buildRoom(ctx, handlers) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#d9f4ff');
  const camera = new THREE.PerspectiveCamera(66, innerWidth / innerHeight, 0.05, 300);
  camera.baseFov = 66;
  const solid = [
    { x0: BED.x0, x1: BED.x1, z0: BED.z0, z1: BED.z1 },
    { x0: DESK.x0, x1: DESK.x1, z0: DESK.z0, z1: DESK.z1 },
  ];
  const limit = (p) => {
    const pad = 0.35;
    p.x = clamp(p.x, -X + pad, X - pad);
    p.z = clamp(p.z, -Z + pad, Z - pad);
    for (const b of solid) {
      if (p.x > b.x0 - pad && p.x < b.x1 + pad && p.z > b.z0 - pad && p.z < b.z1 + pad) {
        const out = [
          [p.x - (b.x0 - pad), 'x', b.x0 - pad], [b.x1 + pad - p.x, 'x', b.x1 + pad],
          [p.z - (b.z0 - pad), 'z', b.z0 - pad], [b.z1 + pad - p.z, 'z', b.z1 + pad],
        ].sort((a, c) => a[0] - c[0])[0];
        p[out[1]] = out[2];
      }
    }
    return p;
  };
  const rig = new Rig(camera, { eye: 1.55, speed: 3.8, limit });

  Object.assign(ctx, { scene, pickables: [], room: { width: WIDTH, depth: DEPTH, height: HEIGHT } });
  buildLights(scene);
  buildShell(ctx);

  const floor = buildFloor(ctx, { width: WIDTH, depth: DEPTH }, [
    { x0: BED.x0 - 0.1, x1: BED.x1 + 0.1, z0: BED.z0 - 0.1, z1: BED.z1 + 0.1 },
    { x0: DESK.x0 - 0.1, x1: DESK.x1 + 0.1, z0: DESK.z0 - 0.1, z1: DESK.z1 + 0.1 },
  ]);
  ctx.pickables.push(floor.proxy);
  const disco = buildDisco(ctx, new THREE.Vector3(0, 3.25, 0.4), 0.88);
  buildPoster(ctx, { width: 7.8, position: new THREE.Vector3(-X + 0.06, 2.15, 1.35), rotationY: Math.PI / 2 });
  buildCalendar(ctx, { width: 4.2, position: new THREE.Vector3(X - 0.05, 2.1, -1.4), rotationY: -Math.PI / 2 });
  const panel = buildPanel(ctx, { width: 3.6, position: new THREE.Vector3(X - 0.09, 2.15, 3.2), rotationY: -Math.PI / 2 }, floor);
  const bed = buildBed(ctx, handlers.dream);
  const desk = buildDesk(ctx, handlers.code);
  buildDoor(ctx);
  buildShelf(ctx);
  const outside = buildOutside(ctx, -Z);

  const hints = [
    hint(scene, 'Dream', -5.2, 1.75, -2.4, '#8a5cf6'),
    hint(scene, 'Code Land', 5.1, 2.5, -4.2, '#0f8f79'),
    hint(scene, 'Friends outside', 0, 3.72, -Z + 0.12, '#ff5a3c'),
  ];

  const stations = {
    start: { label: 'Middle', pose: pose([0, 1.55, 4.4], [0, 1.72, 0]) },
    floor: { label: 'Floor', pose: pose([0, 3.9, 5.1], [0, 0, -1.3]), toast: 'Each tile is one project: oldest by the door, newest by the window. Colour is the year, gems are the most loved, rings are remixes.' },
    disco: { label: 'Disco ball', pose: pose([0, 1.45, 3.1], [0, 2.3, 0.4]) },
    poster: { label: 'Poster', pose: pose([-2.4, 1.85, 1.35], [-7, 2.15, 1.35]) },
    calendar: { label: 'Calendar', pose: pose([2.8, 1.85, -1.4], [7, 2.1, -1.4]) },
    panel: { label: 'Control panel', pose: pose([3.5, 1.85, 3.2], [7, 2.15, 3.2]) },
    friends: { label: 'Window', pose: pose([0, 1.75, -3.7], [0, 1.72, -9]), toast: outside.count ? 'Click someone to say hi.' : 'Nobody is out there yet.' },
    bed: { label: 'Bed', pose: pose([-2.3, 1.9, 0.1], bed.lookAt) },
    computer: { label: 'Computer', pose: pose([cxDesk(), 1.6, -1.55], desk.worldScreen) },
    shelf: { label: 'Favorites', pose: pose([-3.6, 1.7, 1.2], [-3.6, 1.7, Z]) },
  };
  function cxDesk() { return (DESK.x0 + DESK.x1) / 2; }

  const world = {
    name: 'room',
    scene,
    rig,
    pickables: ctx.pickables,
    floor,
    panel,
    desk,
    stations,
    bedPose: { x: (BED.x0 + BED.x1) / 2 - 0.05, y: 1.0, z: BED.z0 + 1.1, yaw: Math.PI, pitch: 0.3 },
    update(dt, t) {
      ctx.atlas.flush(t);
      floor.update(dt, t, camera);
      disco.update(dt, t, camera);
      panel.update(dt);
      outside.update(dt, t);
      desk.update(t);
      hints.forEach((h, i) => { h.position.y = h.baseY + Math.sin(t * 1.6 + i) * 0.05; });
    },
  };
  rig.place(stations.start.pose);
  return world;
}
