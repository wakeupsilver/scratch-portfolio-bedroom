// The contribution floor. One tile per project, laid oldest to newest in a snake so
// consecutive projects always touch: you can literally walk your own history.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { labelSprite, yearColor } from './util.js';

const TILE_THICK = 0.1;
const THUMB_FRACTION = 0.74;

/** Largest tile size that still leaves a free cell for every project (furniture covers some). */
function layout(n, room, blocked) {
  const goal = Math.ceil(n * 1.04);
  let size = 1.3;
  for (;;) {
    const cols = Math.floor(room.width / size);
    const rows = Math.floor(room.depth / size);
    const stepX = room.width / cols;
    const stepZ = room.depth / rows;
    const free = [];
    // Row 0 is by the door, where you start, so walking forward is walking forward in time.
    for (let r = 0; r < rows; r++) {
      const line = [];
      for (let c = 0; c < cols; c++) {
        const x = -room.width / 2 + stepX * (c + 0.5);
        const z = room.depth / 2 - stepZ * (r + 0.5);
        const covered = blocked.some((b) => x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1);
        line.push({ c, r, x, z, covered });
      }
      if (r % 2) line.reverse();
      free.push(...line);
    }
    if (free.filter((t) => !t.covered).length >= goal || size < 0.1) return { cells: free, stepX, stepZ, cols, rows };
    size *= 0.97;
  }
}

export function buildFloor(ctx, room, blocked) {
  const { data, atlas, scene, ui, sound } = ctx;
  const projects = data.projects;
  const { cells, stepX, stepZ, cols, rows } = layout(projects.length, room, blocked);
  const count = cells.length;
  const firstYear = projects[0]?.year ?? 2007;
  const lastYear = projects[projects.length - 1]?.year ?? firstYear;

  let next = 0;
  for (const cell of cells) cell.project = !cell.covered && next < projects.length ? projects[next++] : null;
  const grid = new Array(cols * rows);
  cells.forEach((cell) => { grid[cell.r * cols + cell.c] = cell; });
  const withProject = cells.filter((c) => c.project);

  const gap = 0.94;
  const tileGeo = new RoundedBoxGeometry(1, TILE_THICK, 1, 2, 0.035);
  const tiles = new THREE.InstancedMesh(tileGeo, new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.02 }), count);
  tiles.receiveShadow = true;
  tiles.raycast = () => {};
  const blank = new THREE.Color(data.paint.spot).lerp(new THREE.Color('#ffffff'), 0.25);
  const blank2 = blank.clone().multiplyScalar(0.93);
  const color = new THREE.Color();
  const baseColors = [];
  cells.forEach((cell, i) => {
    if (cell.project) color.copy(yearColor(cell.project.year, firstYear, lastYear));
    else color.copy((cell.c + cell.r) % 2 ? blank : blank2);
    baseColors.push(color.clone());
    tiles.setColorAt(i, color);
  });

  const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const thumbs = atlas.instances(plane, withProject.length, (k) => withProject[k].project.index);
  thumbs.raycast = () => {};
  thumbs.frustumCulled = false;
  scene.add(tiles, thumbs);

  // Decorations: gems for the most-loved projects, rings for remixes.
  const gemCells = withProject.filter((c) => c.project.tier > 0).slice(0, 400);
  const gems = gemCells.length ? new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ roughness: 0.15, metalness: 0.35, flatShading: true }), gemCells.length) : null;
  if (gems) {
    gemCells.forEach((c, i) => gems.setColorAt(i, color.set(c.project.tier === 3 ? '#ffc531' : '#ff5fa8')));
    gems.raycast = () => {};
    gems.frustumCulled = false;
    gems.castShadow = true;
    scene.add(gems);
  }
  const ringCells = withProject.filter((c) => c.project.isRemix);
  const rings = ringCells.length ? new THREE.InstancedMesh(new THREE.TorusGeometry(1, 0.3, 8, 18).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.4 }), ringCells.length) : null;
  if (rings) { rings.raycast = () => {}; rings.frustumCulled = false; scene.add(rings); }

  // A little flag on the first tile of each year.
  const flags = [];
  let flagYear = null;
  const tileMin = Math.min(stepX, stepZ);
  for (const cell of withProject) {
    if (cell.project.year !== flagYear) {
      flagYear = cell.project.year;
      const s = labelSprite(String(flagYear), { bg: '#' + yearColor(flagYear, firstYear, lastYear).multiplyScalar(0.55).getHexString(), height: Math.max(0.14, Math.min(0.2, tileMin * 0.2)) });
      s.position.set(cell.x, 0.26, cell.z);
      flags.push({ s, cell });
      scene.add(s);
    }
  }

  // Heights animate between 0 and each tile's tower height (see setHeights).
  cells.forEach((cell) => { cell.h = 0; cell.target = 0; });
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const writeTile = (i) => {
    const c = cells[i];
    const press = c.press || 0;
    const top = c.h - press;
    const height = TILE_THICK + c.h;
    pos.set(c.x, top - height / 2, c.z);
    scl.set(stepX * gap, height / TILE_THICK, stepZ * gap);
    m.compose(pos, q.identity(), scl);
    tiles.setMatrixAt(i, m);
  };
  const writeThumb = (k) => {
    const c = withProject[k];
    pos.set(c.x, c.h - (c.press || 0) + 0.003, c.z);
    scl.set(stepX * gap * THUMB_FRACTION, 1, stepZ * gap * THUMB_FRACTION);
    m.compose(pos, q.identity(), scl);
    thumbs.setMatrixAt(k, m);
  };
  const writeRing = (k) => {
    const c = ringCells[k];
    const r = tileMin * 0.05;
    pos.set(c.x - stepX * 0.385, c.h + r * 0.3, c.z - stepZ * 0.385);
    scl.setScalar(r);
    m.compose(pos, q.identity(), scl);
    rings.setMatrixAt(k, m);
  };
  const writeGem = (k, t) => {
    const c = gemCells[k];
    const r = tileMin * (c.project.tier === 3 ? 0.13 : 0.085);
    pos.set(c.x + stepX * 0.37, c.h + r * 1.5 + Math.sin(t * 2 + k) * r * 0.25, c.z - stepZ * 0.37);
    q.setFromAxisAngle(up, t * 1.2 + k);
    scl.set(r, r * 1.35, r);
    m.compose(pos, q, scl);
    gems.setMatrixAt(k, m);
    q.identity();
  };
  const writeAll = () => {
    cells.forEach((_, i) => writeTile(i));
    withProject.forEach((_, k) => writeThumb(k));
    ringCells.forEach((_, k) => writeRing(k));
    tiles.instanceMatrix.needsUpdate = true;
    thumbs.instanceMatrix.needsUpdate = true;
    if (rings) rings.instanceMatrix.needsUpdate = true;
  };
  writeAll();

  const cellAt = (x, z) => {
    const c = Math.floor((x + room.width / 2) / stepX);
    const r = Math.floor((room.depth / 2 - z) / stepZ);
    return c >= 0 && c < cols && r >= 0 && r < rows ? grid[r * cols + c] : null;
  };
  const indexOfCell = new Map(cells.map((c, i) => [c, i]));

  let hover = null;
  const tint = (cell, amount) => {
    const i = indexOfCell.get(cell);
    tiles.setColorAt(i, color.copy(baseColors[i]).lerp(new THREE.Color('#ffffff'), amount));
    tiles.instanceColor.needsUpdate = true;
  };
  const setHoverCell = (cell) => {
    if (hover === cell) return;
    if (hover) tint(hover, 0);
    hover = cell;
    if (hover) tint(hover, 0.55);
  };

  // Invisible plane: cheaper to pick against than 1000+ instanced boxes.
  const proxy = new THREE.Mesh(new THREE.PlaneGeometry(room.width, room.depth).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial());
  proxy.visible = false;
  proxy.userData.pick = {
    hover(hit) {
      const cell = cellAt(hit.point.x, hit.point.z);
      setHoverCell(cell?.project ? cell : null);
      return cell?.project ? { project: cell.project } : null;
    },
    leave() { setHoverCell(null); },
    click(hit) {
      const cell = cellAt(hit.point.x, hit.point.z);
      if (cell?.project) ui.openProject(cell.project);
    },
  };
  scene.add(proxy);

  let underfoot = null;
  let animating = false;
  const pressed = new Set();

  return {
    proxy,
    cellAt,
    cells,
    /** Raise tiles by value (0..1 of the tallest), or flatten with null. */
    setHeights(valueOf) {
      for (const c of cells) c.target = c.project && valueOf ? valueOf(c.project) * 1.35 : 0;
      animating = true;
    },
    update(dt, t, camera) {
      if (gems) {
        gemCells.forEach((_, k) => writeGem(k, t));
        gems.instanceMatrix.needsUpdate = true;
      }
      const cell = camera.position.y < 2.2 ? cellAt(camera.position.x, camera.position.z) : null;
      if (cell !== underfoot) {
        underfoot = cell;
        if (cell?.project) {
          sound.step(cell.project.index / Math.max(1, projects.length - 1));
          cell.press = 0.035;
          pressed.add(cell);
          tint(cell, 0.4);
          ctx.onStep?.(cell.project);
        }
      }
      for (const c of pressed) {
        if (c === underfoot) continue;
        c.press = Math.max(0, c.press - dt * 0.12);
        if (c.press === 0) { pressed.delete(c); if (c !== hover) tint(c, 0); }
      }
      let changed = pressed.size > 0;
      if (animating) {
        let still = false;
        for (const c of cells) {
          const d = c.target - c.h;
          if (Math.abs(d) > 0.002) { c.h += d * (1 - Math.exp(-dt * 5)); still = true; } else c.h = c.target;
        }
        animating = still;
        changed = true;
        for (const f of flags) f.s.position.y = f.cell.h + 0.26;
      }
      if (changed) writeAll();
    },
  };
}
