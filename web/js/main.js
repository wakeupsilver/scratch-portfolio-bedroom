// App flow: landing page -> load a Scratcher -> walk their room -> dip into Code Land or a dream.
import { Engine } from './engine.js';
import { Atlas } from './atlas.js';
import { Sound } from './audio.js';
import { UI } from './ui.js';
import { buildRoom } from './room.js';
import { CodeLand } from './codeland.js';
import { Dream } from './dream.js';
import { api, avatarImage, BUNDLE, el, initialAvatar, isPlaceholder, loadImage, num, plural, pool, projectImage, seeded, shapeData, unpackSheets } from './util.js';

const $ = (id) => document.getElementById(id);
const USERNAME = /^[A-Za-z0-9_-]{1,40}$/;

function buildQuilt() {
  const rnd = seeded(2007);
  const colors = ['#ff5a3c', '#ffc531', '#12bfa0', '#3aa0ff', '#ff6fb5', '#8a5cf6', '#ff8a1f', '#59c059', '#2a2f62', '#343a78'];
  const q = $('quilt');
  q.replaceChildren(...Array.from({ length: 24 * 24 }, () => {
    const c = colors[Math.floor(rnd() * colors.length)];
    return el('i', { style: { background: c, aspectRatio: '1', '--d': (rnd() * 7).toFixed(2) } });
  }));
}

const FEATURED = ['jay', 'griffpatch', 'mres', 'ericr'];
const THUMBS_PER_PERSON = 30;

/** The page's images are inline text; a blob URL lets many tiles share one decoded copy. */
function tileImageURL(id) {
  const src = projectImage(id);
  if (!src.startsWith('data:')) return src;
  const [head, body] = src.split(',');
  const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: head.slice(5).split(';')[0] }));
}

/** Put real projects on the front page's breathing tiles, leaving some colours between them. */
async function fillQuilt(quilt) {
  const users = BUNDLE
    ? Object.values(BUNDLE.rooms).map((r) => r.user)
    : (await Promise.allSettled(FEATURED.map((n) => api.get(`/api/user/${n}`)))).filter((r) => r.value).map((r) => r.value);
  const lists = users.map((u) => [...u.projects].sort((a, b) => b.loves - a.loves).filter((p) => projectImage(p.id)).slice(0, THUMBS_PER_PERSON));
  const mixed = [];
  for (let i = 0; i < THUMBS_PER_PERSON; i++) for (const list of lists) if (list[i]) mixed.push(list[i]);
  if (!mixed.length) return;
  const rnd = seeded(2013);
  const tiles = [...quilt.children].sort(() => rnd() - 0.5).filter((_, i) => i % 6);
  const groups = mixed.map(() => []);
  tiles.forEach((tile, i) => groups[i % mixed.length].push(tile));
  await pool(mixed, 6, async (p, i) => {
    const url = tileImageURL(p.id);
    const img = await loadImage(url, false);
    if (!img || isPlaceholder(img)) return;   // that tile just stays a colour
    for (const tile of groups[i]) tile.style.backgroundImage = `url("${url}")`;
  });
}

let landingWired = false;

function landing(error) {
  $('landing').hidden = false;
  $('loader').hidden = true;
  document.title = 'Scratch Portfolio Bedroom';
  $('door-error').textContent = error || '';
  $('door-error').classList.remove('note');
  if (landingWired) return;
  landingWired = true;
  buildQuilt();
  fillQuilt($('quilt'));
  const input = $('username');
  const notice = $('door-error');
  const go = (name) => {
    notice.classList.remove('note');
    const clean = name.trim().replace(/^@/, '');
    if (!USERNAME.test(clean)) {
      notice.textContent = 'Scratch usernames only use letters, numbers, - and _.';
      return;
    }
    if (BUNDLE) {
      const room = Object.keys(BUNDLE.rooms).find((r) => r.toLowerCase() === clean.toLowerCase());
      if (room) { navigate(room); return; }
      notice.classList.add('note');
      notice.textContent = 'This feature is not implemented yet for all Scratchers.';
      return;
    }
    navigate(clean);
  };
  // Handled directly, not with the form's submit event: sandboxed frames can block that event.
  $('door-form').addEventListener('submit', (e) => e.preventDefault());
  document.querySelector('#door-form button').addEventListener('click', (e) => { e.preventDefault(); go(input.value); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(input.value); } });
  if (BUNDLE) {
    // The static edition has a fixed set of rooms ready to pick.
    document.querySelector('.or span').textContent = 'or try another username';
    document.querySelector('.tag').textContent = "Walk into a room built from a Scratcher's projects.";
    document.querySelector('.instant').hidden = true;
    const picker = el('div', { class: 'picker' });
    for (const [name, room] of Object.entries(BUNDLE.rooms)) {
      const id = room.user.profile.id;
      picker.append(el('button', { type: 'button', 'data-room': name, onclick: () => navigate(name) },
        el('img', { alt: '', src: avatarImage(id) || initialAvatar(name).toDataURL() }),
        el('span', {}, el('b', { text: name }), el('small', { text: plural(room.user.projects.length, 'project') }))));
    }
    // Ready-made rooms come first; the name box sits below them.
    const form = $('door-form');
    form.before(picker);
    form.before(document.querySelector('.or'));
    return;
  }
  input.focus();
  document.querySelector('[data-try]').addEventListener('click', (e) => go(e.currentTarget.dataset.try));
}

/** Go to a room, or to the front page with null. A full page load except in the static edition. */
function navigate(name) {
  if (!BUNDLE) { location.href = name ? `/u/${encodeURIComponent(name)}` : '/'; return; }
  try { location.hash = name || ''; } catch { /* some frames refuse: the room still opens */ }
  show(name);
}

let current = null;
function show(name) {
  if (name === current) return;
  current = name;
  closeRoom();
  if (name) enter(name);
  else landing();
}

let engine, ui, sound;
let closeRoom = () => {};

function textOnlyFallback(ui, data) {
  ui.openList(`${data.profile.username}'s projects`, [...data.projects].reverse(),
    "This browser can't show the 3D room, so here's the list instead.");
}

async function enter(name) {
  $('landing').hidden = true;
  $('loader').hidden = false;
  const say = (t) => { $('loader-text').textContent = t; };
  say(`Opening ${name}'s room…`);
  document.title = `${name}'s room · Scratch Portfolio Bedroom`;
  // Building a room blocks the page, so let the loading screen appear first. The timeout covers background tabs.
  await new Promise((resolve) => { requestAnimationFrame(() => setTimeout(resolve)); setTimeout(resolve, 400); });

  let raw;
  try {
    raw = await api.get(`/api/user/${encodeURIComponent(name)}`);
  } catch (e) {
    current = null;
    if (!BUNDLE) history.replaceState(null, '', '/');
    return landing(e.status === 404 ? `We couldn't find a Scratcher called "${name}". Check the spelling?` : e.message);
  }
  const data = shapeData(raw);
  say(`Found ${plural(data.projects.length, 'project')}. Laying the floor…`);
  await document.fonts.load('600 40px Fredoka');
  await document.fonts.load('700 40px Fredoka');

  if (!engine) {
    sound = new Sound();
    try {
      engine = new Engine($('gl'));
    } catch {
      engine = null;
      ui = new UI({ keys: new Set() }, sound);
      $('loader').hidden = true;
      return textOnlyFallback(ui, data);
    }
    ui = new UI(engine, sound);
    ui.actions.visit = navigate;
    addEventListener('pointerdown', () => sound.unlock(), { once: true });
    addEventListener('keydown', () => sound.unlock(), { once: true });
    engine.start();
  }
  performance.mark('room-start');
  const atlas = new Atlas(data.projects);
  const ctx = { data, atlas, ui, sound, leave: () => navigate(null) };

  let room, code, dream;
  let helpEl;

  const enterRoomHud = () => {
    ui.clearHud();
    const dock = el('div', { class: 'dock', role: 'navigation', 'aria-label': 'Places in the room' });
    for (const key of ['floor', 'disco', 'poster', 'calendar', 'panel', 'friends', 'bed', 'computer', 'shelf']) {
      const st = room.stations[key];
      if (key === 'shelf' && !data.favorites.length) continue;
      dock.append(el('button', { class: 'chip', text: st.label, 'data-station': key, onclick: () => {
        sound.unlock(); sound.click();
        room.rig.glide(st.pose, 1.2);
        if (st.toast) ui.toast(st.toast);
      } }));
    }
    const touch = matchMedia('(pointer: coarse)').matches;
    helpEl = el('div', { class: 'help', text: touch ? 'Use the stick to walk, drag to look, tap anything.' : 'WASD or arrow keys to walk. Drag to look. Click anything. Your steps play notes.' });
    ui.hud.append(
      ui.plate(data),
      el('div', { class: 'tools' }, ui.muteChip(), el('button', { class: 'chip', text: 'All projects', onclick: () => ui.openList(`${data.profile.username}'s projects`, [...data.projects].reverse()) })),
      helpEl, dock,
    );
    const stick = ui.joystick();
    if (stick) ui.hud.append(stick);
  };

  /** Fade across to another world. */
  let switching = false;
  const travel = async (world, { dark = false } = {}) => {
    if (switching) return;
    switching = true;
    await ui.fadeOut(dark);
    engine.setWorld(world);
    room.rig.locked = false;
    ui.fadeIn();
    switching = false;
  };

  const backToRoom = async (restore, dark) => {
    await travel(room, { dark });
    enterRoomHud();
    room.rig.place(restore);
  };

  const goCode = (project) => {
    if (switching || !room) return;
    sound.unlock(); sound.whoosh();
    const back = room.stations.computer.pose;
    const screen = room.desk.worldScreen;
    room.rig.locked = true;
    room.rig.glide({ x: screen[0], y: screen[1], z: screen[2] + 0.5, yaw: 0, pitch: 0 }, project ? 0.5 : 1.1, async () => {
      code ||= new CodeLand(ctx, { exit: () => { sound.whoosh(); backToRoom(back); } });
      await travel(code);
      if (project) code.focusProject(project);
    });
  };
  ui.actions.showCode = goCode;

  const goDream = () => {
    if (switching || !room) return;
    sound.unlock();
    const back = room.stations.bed.pose;
    room.rig.locked = true;
    room.rig.glide(room.bedPose, 1.5, async () => {
      dream ||= new Dream(ctx, { exit: () => backToRoom(back, true) });
      await travel(dream, { dark: true });
    });
  };

  room = buildRoom(ctx, { dream: goDream, code: () => goCode() });
  engine.setWorld(room);
  enterRoomHud();
  performance.measure('room-build', 'room-start');

  // Free this room's graphics memory when moving to another one without a page load.
  closeRoom = () => {
    closeRoom = () => {};
    ui.closeModal();
    ui.clearHud();
    ui.hud.hidden = true;
    engine.world?.onExit?.();
    engine.world = null;
    engine.setHover(null);
    for (const world of [room, code, dream]) {
      world?.scene.traverse((o) => {
        o.geometry?.dispose();
        for (const m of [o.material].flat()) { m?.map?.dispose(); m?.dispose(); }
      });
    }
    atlas.texture.dispose();
  };

  say('Hanging your projects…');
  let finished = false;
  const open = () => {
    if (finished) return;
    finished = true;
    $('loader').hidden = true;
    if (!data.projects.length) ui.toast(`${data.profile.username} hasn't shared a project yet, so the floor is ready and waiting.`, 7000);
    else if (data.truncated) ui.toast(`Showing ${num(data.projects.length)} projects. That's a lot of making!`, 6000);
  };
  // Don't hold the door shut for slow images: covers already fill the gaps.
  setTimeout(open, 3500);
  atlas.load((done, total) => {
    say(`Hanging your projects… ${done} of ${total}`);
    if (!BUNDLE && done >= Math.min(30, total)) open();   // built-in images finish fast, so wait for them all
  }).then(() => { atlas.flush(); performance.measure('room-images', 'room-start'); open(); });
  if (!data.projects.length) open();

  // Hooks for the automated browser test, and handy in the console.
  window.__blockroom = {
    data, engine, ui, room, atlas,
    goto: (key) => room.rig.place(room.stations[key].pose),
    code: goCode, dream: goDream,
    world: () => engine.world?.name,
    get codeland() { return code; },
    get dreamworld() { return dream; },
    wake: () => { const w = engine.world; if (w === dream) dream.handlers.exit(); else if (w === code) code.handlers.exit(); },
    press: (i) => room.panel.press(i),
    panelState: () => room.panel.state(),
  };
}

if (BUNDLE) {
  await unpackSheets();
  const fromHash = () => {
    const name = location.hash.slice(1);
    return BUNDLE.rooms[name] ? name : null;
  };
  addEventListener('hashchange', () => show(fromHash()));
  const first = fromHash();
  if (first) show(first);
  else landing();
} else {
  const match = location.pathname.match(/^\/u\/([^/]+)$/);
  const initial = match ? decodeURIComponent(match[1]) : null;
  if (initial && USERNAME.test(initial)) { current = initial; enter(initial); } else landing();
}
