// End-to-end test in real Chrome, driving the real Scratch data through the local server.
// Usage: BASE=http://127.0.0.1:8642 OUT=/some/dir node tests/e2e.mjs [username]
// Needs playwright-core (npm i playwright-core) and an installed Chrome.
import { chromium } from 'playwright-core';

const BASE = process.env.BASE || 'http://127.0.0.1:8642';
const OUT = process.env.OUT || '.';
const USER = process.argv[2] || 'jay';

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
let passed = 0, failed = 0;
const problems = [];
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok    ${name}`); } else { failed++; console.log(`  FAIL  ${name} ${detail}`); }
}
function watch(page) {
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) problems.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message + ' ' + (e.stack || '').slice(0, 400)));
}
const waitRoom = (page) => page.waitForFunction(() => window.__blockroom && document.getElementById('loader').hidden, null, { timeout: 60000, polling: 500 });

/** Screen position of a world point, using the live camera. */
const screenOf = (page, p) => page.evaluate(([x, y, z]) => {
  const cam = window.__blockroom.engine.world.rig.camera;
  cam.updateMatrixWorld();
  const v = cam.position.clone().set(x, y, z).project(cam);
  return [(v.x + 1) / 2 * innerWidth, (1 - v.y) / 2 * innerHeight];
}, p);

/** Sweep the mouse across the screen until a 3D object reports this hover title, then really click it. */
async function clickObject(page, title) {
  const at = await page.evaluate((want) => {
    const e = window.__blockroom.engine;
    for (let y = 0.9; y > -0.9; y -= 0.04) for (let x = -0.95; x < 0.95; x += 0.04) {
      e.mouse.set(x, y);
      const f = e.pick();
      if (f?.pick?.hover?.(f.hit)?.title === want) return [(x + 1) / 2 * innerWidth, (1 - y) / 2 * innerHeight];
    }
    return null;
  }, title);
  if (!at) return false;
  await page.mouse.move(at[0], at[1]);
  await page.waitForTimeout(250);
  await page.mouse.click(at[0], at[1]);
  return true;
}

// ---------------------------------------------------------------- landing
console.log('landing');
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  watch(page);
  await page.goto(BASE + '/');
  await page.waitForSelector('#username', { timeout: 20000 });
  check('landing shows', await page.isVisible('#username'));
  await page.waitForFunction(() => [...document.querySelectorAll('.quilt i')].filter((t) => t.style.backgroundImage).length > 100, null, { timeout: 60000, polling: 500 });
  check('front page tiles show real projects', true);
  await page.screenshot({ path: `${OUT}/t-landing.png` });
  await page.fill('#username', 'not a name!');
  await page.click('#door-form button');
  check('rejects invalid username', (await page.textContent('#door-error')).includes('letters'));
  await page.click('text=Visit jay');
  await page.waitForURL('**/u/jay', { timeout: 10000 });
  const t0 = Date.now();
  await waitRoom(page);
  console.log(`        jay's room opened in ${Date.now() - t0} ms`);
  check("jay button opens jay's room", (await page.evaluate(() => window.__blockroom.data.projects.length)) > 0);
  await page.goto(BASE + '/u/nosuchuser__zzq');
  await page.waitForFunction(() => document.getElementById('door-error')?.textContent.length > 0, null, { timeout: 20000, polling: 300 });
  check('unknown user returns to landing with a message', (await page.textContent('#door-error')).includes("couldn't find"));
  await page.close();
}

// ---------------------------------------------------------------- room
console.log(`room for ${USER}`);
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
watch(page);
await page.goto(`${BASE}/u/${USER}`);
await waitRoom(page);
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/t-start.png` });

const stats = await page.evaluate(() => {
  const b = window.__blockroom;
  return {
    projects: b.data.projects.length,
    tilesWithProject: b.room.floor.cells.filter((c) => c.project).length,
    uniqueOnFloor: new Set(b.room.floor.cells.filter((c) => c.project).map((c) => c.project.id)).size,
    coveredWithProject: b.room.floor.cells.filter((c) => c.project && c.covered).length,
    frames: b.engine.frames,
  };
});
check('every project has exactly one floor tile', stats.tilesWithProject === stats.projects && stats.uniqueOnFloor === stats.projects, JSON.stringify(stats));
check('no project tile hidden under furniture', stats.coveredWithProject === 0);
check('render loop is running', stats.frames > 2);
check('HUD visible with dock', await page.isVisible('.dock') && await page.isVisible('.plate'));
check('nameplate names the user', (await page.textContent('.plate b')).includes("'s room"));

// Walk.
const pos = () => page.evaluate(() => { const p = window.__blockroom.room.rig.camera.position; return [p.x, p.y, p.z]; });
const before = await pos();
await page.mouse.move(640, 700);
await page.keyboard.down('w');
await page.waitForTimeout(1500);
await page.keyboard.up('w');
const after = await pos();
check('W walks forward', after[2] < before[2] - 0.2, `${before[2]} -> ${after[2]}`);
await page.evaluate(() => { const r = window.__blockroom.room.rig; r.camera.position.set(0, 1.55, -5); });
await page.keyboard.down('w');
await page.waitForTimeout(1500);
await page.keyboard.up('w');
check('wall stops you', (await pos())[2] >= -5.2, String((await pos())[2]));
await page.evaluate(() => { const r = window.__blockroom.room.rig; r.place({ x: -5, y: 1.55, z: -3.4, yaw: 0, pitch: 0 }); r.camera.position.x = -5.2; r.limit(r.camera.position); });
const pushed = await pos();
check('bed is solid', !(pushed[0] > -6.9 && pushed[0] < -3.6 && pushed[2] > -5.4 && pushed[2] < -1.5), String(pushed));

// Drag to look.
await page.evaluate(() => window.__blockroom.goto('start'));
const yaw0 = await page.evaluate(() => window.__blockroom.room.rig.yaw);
await page.mouse.move(640, 300);
await page.mouse.down();
await page.mouse.move(800, 300, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(300);
check('dragging turns the view', Math.abs(await page.evaluate(() => window.__blockroom.room.rig.yaw) - yaw0) > 0.1);
check('a drag is not a click', await page.isHidden('#modal'));

// Hover and click a floor tile.
await page.evaluate(() => window.__blockroom.goto('floor'));
await page.waitForTimeout(600);
const tile = await page.evaluate(() => {
  const cells = window.__blockroom.room.floor.cells.filter((c) => c.project);
  const c = cells[Math.floor(cells.length / 2)];
  return { x: c.x, z: c.z, title: c.project.title };
});
const [tx, ty] = await screenOf(page, [tile.x, 0, tile.z]);
await page.mouse.move(tx, ty);
await page.waitForTimeout(1200);
check('hovering a tile shows its thumbnail card', await page.isVisible('#card img'));
check('card names the right project', (await page.textContent('#card b')) === tile.title, await page.textContent('#card b'));
await page.screenshot({ path: `${OUT}/t-hover.png` });
await page.mouse.click(tx, ty);
await page.waitForTimeout(1500);
check('clicking a tile opens its sheet', await page.isVisible('.sheet h2') && (await page.textContent('.sheet h2')) === tile.title);
await page.screenshot({ path: `${OUT}/t-sheet.png` });
await page.click('text=Play it here');
const src = await page.getAttribute('.stage iframe', 'src');
check('Play embeds the real project', /^https:\/\/scratch\.mit\.edu\/projects\/\d+\/embed$/.test(src), src);
await page.keyboard.press('Escape');
check('Esc closes the sheet and stops the project', await page.isHidden('#modal') && (await page.locator('iframe').count()) === 0);

// Walking onto a tile.
const stepped = await page.evaluate(() => new Promise((res) => {
  const b = window.__blockroom;
  const c = b.room.floor.cells.filter((q) => q.project)[3];
  b.room.rig.camera.position.set(c.x, 1.55, c.z);
  setTimeout(() => res(c.press > 0), 500);
}));
check('stepping on a tile presses it', stepped);

// Disco ball.
await page.evaluate(() => window.__blockroom.goto('disco'));
await page.waitForTimeout(2600);
const ballCentre = await page.evaluate(() => {
  const r = window.__blockroom.room.rig;
  return [0, 2.3, 0];
});
const [bx, by] = await screenOf(page, ballCentre);
await page.mouse.move(bx, by);
await page.waitForTimeout(1200);
check('hovering the disco ball shows a project', await page.isVisible('#card img'));
await page.screenshot({ path: `${OUT}/t-disco.png` });
await page.mouse.move(5, 300);

// Poster, calendar.
for (const [station, point, shot] of [['poster', [-6.9, 2.0, 1.0], 't-poster'], ['calendar', [6.9, 2.0, -1.4], 't-calendar']]) {
  await page.evaluate((k) => window.__blockroom.goto(k), station);
  await page.waitForTimeout(800);
  const [sx, sy] = await screenOf(page, point);
  await page.mouse.move(sx, sy);
  await page.waitForTimeout(900);
  check(`${station} responds to hover`, await page.isVisible('#card'));
  await page.screenshot({ path: `${OUT}/${shot}.png` });
}

// Control panel. One real mouse click on a 3D button, then the direct hook for speed.
await page.evaluate(() => window.__blockroom.goto('panel'));
await page.mouse.move(5, 300);
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/t-panel0.png` });
const pressLabel = async (i) => { await page.evaluate((n) => window.__blockroom.press(n), i); };
const towers = () => page.evaluate(() => Math.max(...window.__blockroom.room.floor.cells.map((c) => c.h)));
check('a real click finds the Views button', await clickObject(page, 'Most views'));
await page.waitForTimeout(1200);
check('that click lights the Views leaderboard', (await page.evaluate(() => window.__blockroom.panelState().current)) === 'views');
await pressLabel(1);
await page.waitForTimeout(2500);
let st = await page.evaluate(() => window.__blockroom.panelState());
check('Loves button lists 5 projects', st.current === 'loves' && st.rows.length === Math.min(5, stats.projects), JSON.stringify(st));
const expectedTop = await page.evaluate(() => window.__blockroom.data.byLoves[0].title);
check('top of the list is truly the most loved', st.rows[0] === expectedTop, st.rows[0]);
check('floor rises into towers', (await towers()) > 1, String(await towers()));
await page.screenshot({ path: `${OUT}/t-panel-loves.png` });
await page.evaluate(() => window.__blockroom.room.rig.place({ x: -5.8, y: 2.6, z: 4.8, yaw: -2.2 + Math.PI / 2 - 0.5, pitch: -0.28 }));
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/t-skyline.png` });
await page.evaluate(() => window.__blockroom.goto('panel'));
await pressLabel(3);
await page.waitForFunction(() => window.__blockroom.panelState().current === 'comments' && window.__blockroom.panelState().rows.length > 0, null, { timeout: 90000, polling: 500 });
await page.waitForTimeout(1500);
check('Comments button fetches and lists counts', true);
await page.screenshot({ path: `${OUT}/t-panel-comments.png` });
await pressLabel(3);
await page.waitForTimeout(3000);
check('pressing a lit button flattens the floor', (await towers()) < 0.05, String(await towers()));

// Friends.
await page.evaluate(() => window.__blockroom.goto('friends'));
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/t-friends.png` });
const friendCount = await page.evaluate(() => window.__blockroom.data.friends.length);
if (friendCount) {
  const hit = await page.evaluate(() => {
    const cam = window.__blockroom.room.rig.camera;
    const e = window.__blockroom.engine;
    // Find a screen point over a friend by scanning across the window.
    for (let y = 0.05; y > -0.55; y -= 0.05) for (let x = -0.9; x < 0.9; x += 0.03) {
      e.mouse.set(x, y);
      const f = e.pick();
      if (f?.pick?.hover && f.pick.hover(f.hit)?.sub?.includes('Click to visit')) return [(x + 1) / 2 * innerWidth, (1 - y) / 2 * innerHeight];
    }
    return null;
  });
  check('friends can be found through the window', !!hit);
  if (hit) {
    await page.mouse.click(hit[0], hit[1]);
    await page.waitForTimeout(600);
    const href = await page.getAttribute('.sheet a.btn.go', 'href');
    check('friend sheet links to their room', /^\/u\//.test(href || ''), href);
    await page.screenshot({ path: `${OUT}/t-friend-sheet.png` });
    await page.keyboard.press('Escape');
  }
}

// All-projects list.
await page.click('text=All projects');
await page.waitForTimeout(800);
check('list shows every project', (await page.locator('.list li').count()) === Math.min(300, stats.projects));
await page.fill('.list-search', 'zzzqqq');
check('list search filters', (await page.locator('.list li').count()) === 0);
await page.keyboard.press('Escape');

// Code Land.
console.log('code land');
await page.evaluate(() => window.__blockroom.goto('computer'));
await page.waitForTimeout(500);
check('a real click finds the computer', await clickObject(page, 'Your computer'));
await page.waitForFunction(() => window.__blockroom.world() === 'code', null, { timeout: 15000, polling: 300 });
await page.waitForFunction(() => window.__blockroom.codeland?.islands.length >= 6, null, { timeout: 120000, polling: 1000 });
await page.waitForTimeout(3500);
await page.screenshot({ path: `${OUT}/t-code.png` });
const code = await page.evaluate(() => {
  const c = window.__blockroom.codeland;
  return { islands: c.islands.length, blocks: c.blockTotal, kinds: c.islands.map((i) => i.kind), hud: document.querySelector('.code-hud .now')?.textContent };
});
check('real code loaded', code.blocks > 0, JSON.stringify(code));
await page.click('text=Next project');
await page.waitForTimeout(2600);
await page.screenshot({ path: `${OUT}/t-code2.png` });
await page.evaluate(() => { const c = window.__blockroom.codeland; const i = c.islands.findIndex((q) => q.kind === 'capsule'); if (i >= 0) c.show(i); });
await page.waitForTimeout(2600);
await page.screenshot({ path: `${OUT}/t-code-capsule.png` });
await page.evaluate(() => { const c = window.__blockroom.codeland; c.rig.place({ x: 0, y: 14, z: 0, yaw: 0.7, pitch: -0.42 }); });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/t-code-wide.png` });
await page.keyboard.down('w');
await page.waitForTimeout(800);
await page.keyboard.up('w');
await page.click('text=Back to the room');
await page.waitForFunction(() => window.__blockroom.world() === 'room', null, { timeout: 8000, polling: 300 });
await page.waitForTimeout(800);
check('back to the room from Code Land', await page.isVisible('.dock .chip'));

// Dream.
console.log('dream');
await page.evaluate(() => window.__blockroom.goto('bed'));
await page.waitForTimeout(500);
check('a real click finds the bed', await clickObject(page, 'Climb into bed'));
await page.waitForFunction(() => window.__blockroom.world() === 'dream', null, { timeout: 15000, polling: 300 });
await page.waitForFunction(() => window.__blockroom.dreamworld?.floaters.length >= 20, null, { timeout: 40000, polling: 800 });
await page.waitForTimeout(9000);
await page.screenshot({ path: `${OUT}/t-dream.png` });
const dream = await page.evaluate(() => {
  const d = window.__blockroom.dreamworld;
  const s = window.__blockroom.ui.sound;
  return { floaters: d.floaters.length, audio: !!s.dream, sampled: s.dreamBuffers?.length ?? 0 };
});
check('dream has floating images', dream.floaters >= 20, JSON.stringify(dream));
check('dream audio is playing', dream.audio, JSON.stringify(dream));
check('dream mixes real project sounds', dream.sampled > 0, JSON.stringify(dream));
await page.waitForTimeout(6000);
await page.screenshot({ path: `${OUT}/t-dream2.png` });
await page.click('text=Wake up');
await page.waitForFunction(() => window.__blockroom.world() === 'room', null, { timeout: 8000, polling: 300 });
check('waking up returns to the room and stops the audio', !(await page.evaluate(() => !!window.__blockroom.ui.sound.dream)));

// Open-project-to-code shortcut.
await page.evaluate(() => {
  const b = window.__blockroom;
  b.ui.openProject(b.data.projects.filter((p) => p.year >= 2015)[0]);
});
await page.waitForSelector('text=Walk through its code', { timeout: 20000 });
await page.waitForFunction(() => document.querySelector('.stage img')?.complete, null, { timeout: 20000, polling: 300 });
await page.waitForTimeout(3000);
const sheetImages = await page.evaluate(() => ({
  stage: document.querySelector('.stage img').naturalWidth,
  strip: [...document.querySelectorAll('.strip img')].map((i) => i.naturalWidth > 0).filter(Boolean).length,
  stripTotal: document.querySelectorAll('.strip img').length,
}));
check('sheet shows the large thumbnail', sheetImages.stage > 60, JSON.stringify(sheetImages));
check('sheet shows real costumes', sheetImages.strip > 0, JSON.stringify(sheetImages));
await page.screenshot({ path: `${OUT}/t-sheet-code.png` });
await page.click('text=Walk through its code');
await page.waitForFunction(() => window.__blockroom.world() === 'code', null, { timeout: 15000, polling: 300 });
check('sheet jumps straight into that project\'s code', true);
await page.close();

// ---------------------------------------------------------------- phone
console.log('phone layout');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  watch(p);
  await p.goto(`${BASE}/`);
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/t-phone-landing.png` });
  await p.goto(`${BASE}/u/${USER}`);
  await waitRoom(p);
  await p.waitForTimeout(3000);
  check('joystick appears on touch', await p.isVisible('#joystick'));
  await p.screenshot({ path: `${OUT}/t-phone.png` });
  const box = await p.locator('#joystick').boundingBox();
  const start = await p.evaluate(() => window.__blockroom.room.rig.camera.position.z);
  await p.evaluate(() => { const b = window.__blockroom.engine; b.stick.z = -1; });
  await p.waitForTimeout(1500);
  await p.evaluate(() => { const b = window.__blockroom.engine; b.stick.z = 0; });
  const end = await p.evaluate(() => window.__blockroom.room.rig.camera.position.z);
  check('stick input walks', end < start - 0.2, `${start} -> ${end}`);
  check('joystick has a real size', box.width > 60);
  await ctx.close();
}

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (problems.length) console.log('console problems:\n' + [...new Set(problems)].slice(0, 15).join('\n'));
else console.log('no console errors');
process.exit(failed ? 1 : 0);
