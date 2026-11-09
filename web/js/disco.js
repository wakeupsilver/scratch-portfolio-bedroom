// The globe, reimagined: a disco ball is already a sphere of little square tiles,
// so every facet is a project thumbnail. Hover one and it pops out. It also throws
// coloured light around the room.
import * as THREE from 'three';
import { canvas, canvasTexture, reducedMotion, seeded } from './util.js';

const ROWS = 15;

export function buildDisco(ctx, center, radius) {
  const { data, atlas, ui, scene } = ctx;
  const n = data.projects.length;
  const group = new THREE.Group();
  group.position.copy(center);
  scene.add(group);

  const spinner = new THREE.Group();
  group.add(spinner);

  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(radius * 0.975, 4), new THREE.MeshStandardMaterial({ color: '#c9d4ff', metalness: 0.75, roughness: 0.25 }));
  core.castShadow = true;
  spinner.add(core);

  const ceilingY = ctx.room.height;
  const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1, 6), new THREE.MeshStandardMaterial({ color: '#555b88' }));
  chain.raycast = () => {};
  scene.add(chain);

  // Rows of upright tiles from pole to pole, exactly how a mirror ball is built.
  const dummy = new THREE.Object3D();
  const placed = [];
  const rowHeight = (Math.PI * radius) / (ROWS + 1);
  for (let row = 0; row < ROWS; row++) {
    const lat = -Math.PI / 2 + ((row + 1) / (ROWS + 1)) * Math.PI;
    const ringR = Math.cos(lat) * radius;
    const count = Math.max(4, Math.round((2 * Math.PI * ringR) / (rowHeight * 4 / 3)));
    for (let i = 0; i < count; i++) {
      const a = ((i + (row % 2) * 0.5) / count) * Math.PI * 2;
      placed.push({
        dir: new THREE.Vector3(Math.cos(a) * Math.cos(lat), Math.sin(lat), Math.sin(a) * Math.cos(lat)),
        w: ((2 * Math.PI * ringR) / count) * 0.93,
        h: rowHeight * 0.93,
      });
    }
  }
  const FACETS = placed.length;

  // Shuffle which project sits where, so neighbours on the ball aren't all the same year.
  const rnd = seeded(data.seed);
  const order = data.projects.map((p) => p.index).sort(() => rnd() - 0.5);
  const facets = n ? atlas.instances(new THREE.PlaneGeometry(1, 1), FACETS, (k) => order[k % n]) : null;

  if (facets) {
    const setFacet = (k, scale) => {
      const f = placed[k];
      dummy.position.copy(f.dir).multiplyScalar(radius * (scale > 1 ? 1.12 : 1));
      dummy.lookAt(f.dir.clone().multiplyScalar(radius * 3));
      dummy.scale.set(f.w * scale, f.h * scale, 1);
      dummy.updateMatrix();
      facets.setMatrixAt(k, dummy.matrix);
    };
    placed.forEach((_, k) => setFacet(k, 1));
    spinner.add(facets);

    let hovered = -1;
    const setHovered = (k) => {
      if (k === hovered) return;
      if (hovered >= 0) setFacet(hovered, 1);
      hovered = k;
      if (k >= 0) setFacet(k, 2.2);
      facets.instanceMatrix.needsUpdate = true;
    };
    const pick = {
      hover(hit) {
        if (hit.instanceId === undefined || hit.object !== facets) { setHovered(-1); return { title: 'Disco ball', sub: 'Every tile is one of your projects.' }; }
        setHovered(hit.instanceId);
        return { project: data.projects[order[hit.instanceId % n]] };
      },
      leave() { setHovered(-1); },
      click(hit) {
        if (hit.instanceId !== undefined && hit.object === facets) ui.openProject(data.projects[order[hit.instanceId % n]]);
      },
    };
    group.userData.pick = pick;
    group.isHovered = () => hovered >= 0;
    facets.computeBoundingSphere();
  }
  ctx.pickables.push(group);

  // Light spots: an inside-out sphere of soft dots drawn over everything at low strength.
  const [c, g] = canvas(2048, 1024);
  const colors = ['#ff5a3c', '#ffc531', '#12bfa0', '#3aa0ff', '#ff6fb5', '#8a5cf6', '#ffffff'];
  for (let i = 0; i < 120; i++) {
    const x = rnd() * 2048, lat = Math.acos(rnd() * 2 - 1);
    const y = (lat / Math.PI) * 1024;
    const r = 6 + rnd() * 8;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    const col = colors[Math.floor(rnd() * colors.length)];
    grad.addColorStop(0, col); grad.addColorStop(0.65, col); grad.addColorStop(1, col + '00');
    g.fillStyle = grad;
    // Stretch near the poles to cancel the equirectangular squeeze.
    g.save();
    g.translate(x, y);
    g.scale(1 / Math.max(0.25, Math.sin(lat)), 1);
    g.translate(-x, -y);
    g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    g.restore();
  }
  const dots = new THREE.Mesh(new THREE.SphereGeometry(30, 32, 20), new THREE.MeshBasicMaterial({
    map: canvasTexture(c), side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending,
    depthTest: false, depthWrite: false, opacity: 0.11, toneMapped: false,
  }));
  dots.renderOrder = 1;
  dots.raycast = () => {};
  group.add(dots);

  const spin = reducedMotion ? 0.03 : 0.16;
  const eyeRest = center.y;
  return {
    group,
    update(dt, t, camera) {
      if (!group.isHovered?.()) {
        spinner.rotation.y += spin * dt;
        dots.rotation.y -= spin * dt * 0.7;
      }
      spinner.rotation.z = Math.sin(t * 0.25) * 0.05;
      // The ball lowers to meet you when you walk up to it.
      const d = Math.hypot(camera.position.x - center.x, camera.position.z - center.z);
      const want = eyeRest - THREE.MathUtils.smoothstep(4.2 - d, 0, 2.2) * 0.85;
      group.position.y += (want - group.position.y) * (1 - Math.exp(-dt * 2));
      const len = ceilingY - group.position.y - radius;
      chain.scale.y = Math.max(0.01, len);
      chain.position.set(center.x, group.position.y + radius + len / 2, center.z);
    },
  };
}
