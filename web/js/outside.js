// The yard beyond the window. Friends hang out here, and you can visit their rooms.
import * as THREE from 'three';
import { avatarImage, BUNDLE, canvas, canvasTexture, hashString, initialAvatar, isPlaceholder, labelSprite, loadImage, pool, seeded } from './util.js';

const MAX_SHOWN = 22;

function sky(hour) {
  if (hour >= 7 && hour < 17) return { top: '#3aa0ff', bottom: '#d9f4ff', ground: '#6fd36a', sun: '#fff6c9', stars: 0, name: 'day' };
  if (hour >= 17 && hour < 20) return { top: '#5b4bd6', bottom: '#ffb37a', ground: '#7fb65c', sun: '#ffd28a', stars: 0.15, name: 'sunset' };
  if (hour >= 5 && hour < 7) return { top: '#5a8fe6', bottom: '#ffd0c0', ground: '#6fbf73', sun: '#ffe4c0', stars: 0.1, name: 'sunrise' };
  return { top: '#0c1140', bottom: '#2c3a7a', ground: '#2f6b57', sun: '#dfe8ff', stars: 1, name: 'night' };
}

export function buildOutside(ctx, windowZ) {
  const { data, scene, ui } = ctx;
  const look = sky(new Date().getHours());
  const rnd = seeded(data.seed + 7);

  const dome = new THREE.Mesh(new THREE.SphereGeometry(140, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { top: { value: new THREE.Color(look.top) }, bottom: { value: new THREE.Color(look.bottom) }, stars: { value: look.stars } },
    vertexShader: 'varying vec3 d; void main(){ d = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec3 d; uniform vec3 top; uniform vec3 bottom; uniform float stars;
      float h(vec3 p){ return fract(sin(dot(p, vec3(12.9,78.2,37.7))) * 43758.5); }
      void main(){ float k = smoothstep(-0.02, 0.55, d.y); vec3 c = mix(bottom, top, k);
        vec3 q = floor(d * 170.0); float s = step(0.994, h(q)) * stars * step(0.02, d.y); gl_FragColor = vec4(c + s, 1.0); }`,
  }));
  dome.raycast = () => {};
  scene.add(dome);

  const ground = new THREE.Mesh(new THREE.CircleGeometry(135, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: look.ground, roughness: 1 }));
  ground.position.y = -0.3;
  ground.raycast = () => {};
  scene.add(ground);

  const addHill = (x, z, r, tint) => {
    const hill = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 12), new THREE.MeshStandardMaterial({ color: new THREE.Color(look.ground).multiplyScalar(tint), roughness: 1 }));
    hill.scale.y = 0.35;
    hill.position.set(x, -0.3, z);
    hill.raycast = () => {};
    scene.add(hill);
  };
  addHill(-26, -62, 30, 0.9); addHill(24, -70, 36, 0.82); addHill(0, -92, 44, 0.74);

  const trunkMat = new THREE.MeshStandardMaterial({ color: '#8a5a33' });
  const leaves = ['#2fae62', '#3cc46e', '#1f9a78', '#7ccc4a'].map((c) => new THREE.MeshStandardMaterial({ color: c, flatShading: true }));
  for (let i = 0; i < 16; i++) {
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 1.4, 7), trunkMat);
    trunk.position.y = 0.4;
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1.15 + rnd() * 0.5, 0), leaves[i % 4]);
    crown.position.y = 1.8;
    tree.add(trunk, crown);
    const side = i % 2 ? 1 : -1;
    tree.position.set(side * (9 + rnd() * 18), -0.3, windowZ - 12 - rnd() * 28);
    tree.traverse((o) => { o.raycast = () => {}; });
    scene.add(tree);
  }

  const clouds = [];
  const cloudMat = new THREE.MeshStandardMaterial({ color: look.name === 'night' ? '#55609a' : '#ffffff', roughness: 1, flatShading: true });
  for (let i = 0; i < 7; i++) {
    const cloud = new THREE.Group();
    for (let b = 0; b < 4; b++) {
      const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(1 + rnd() * 1.2, 1), cloudMat);
      puff.position.set((b - 1.5) * 1.6, rnd() * 0.5, rnd());
      puff.raycast = () => {};
      cloud.add(puff);
    }
    cloud.position.set(-40 + rnd() * 80, 13 + rnd() * 9, windowZ - 34 - rnd() * 22);
    cloud.speed = 0.25 + rnd() * 0.3;
    clouds.push(cloud);
    scene.add(cloud);
  }

  // Friends: mutuals come closest to the window.
  const friends = data.friends.slice(0, MAX_SHOWN);
  const crowd = new THREE.Group();
  scene.add(crowd);
  ctx.pickables.push(crowd);
  const actors = [];
  friends.forEach((f, i) => {
    const r = seeded(hashString(f.username));
    const hue = r();
    const actor = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.62, 4, 12), new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue, 0.75, 0.58), roughness: 0.6 }));
    body.position.y = 0.72;
    actor.add(body);
    const armMat = body.material;
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.42, 3, 8), armMat);
      arm.position.set(side * 0.52, 0.85, 0);
      arm.rotation.z = side * 0.5;
      actor.add(arm);
      actor[side < 0 ? 'armL' : 'armR'] = arm;
    }
    const [c, g] = canvas(200, 200);
    const tex = canvasTexture(c);
    const paintHead = (img) => {
      g.clearRect(0, 0, 200, 200);
      g.save();
      g.beginPath(); g.arc(100, 100, 92, 0, 7); g.clip();
      g.drawImage(img, 8, 8, 184, 184);
      g.restore();
      g.lineWidth = 12; g.strokeStyle = '#fff';
      g.beginPath(); g.arc(100, 100, 92, 0, 7); g.stroke();
      tex.needsUpdate = true;
    };
    paintHead(initialAvatar(f.username));
    const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, toneMapped: false }));
    head.scale.set(1.08, 1.08, 1);
    head.position.y = 1.72;
    actor.add(head);
    const tag = labelSprite(f.username, { height: 0.3, bg: f.mutual ? '#ff5a3c' : '#1d2145' });
    tag.position.y = 2.5;
    actor.add(tag);

    // Rows fan out wider with distance, so everyone stays in view from the window.
    const row = i < 5 ? 0 : i < 11 ? 1 : i < 17 ? 2 : 3;
    const inRow = [5, 6, 6, 6][row];
    const slot = row === 0 ? i : row === 1 ? i - 5 : row === 2 ? i - 11 : i - 17;
    const z = windowZ - 5 - row * 3.2;
    const spread = 5.5 + row * 2.6;
    const x = -spread + (slot + 0.5) * (spread * 2 / inRow) + (r() - 0.5) * 0.7;
    actor.position.set(x, -0.3, z + (r() - 0.5));
    actor.home = actor.position.clone();
    actor.phase = r() * 10;
    actor.mode = Math.floor(r() * 3);
    actor.friend = f;
    actor.userData.pick = {
      hover: () => ({ title: f.username, sub: f.neighbor ? 'Another room on this street. Click to visit.' : BUNDLE ? (f.mutual ? 'Friends: they follow each other.' : f.role === 'follower' ? 'A follower.' : 'Someone they follow.') + ' Click for their Scratch profile.' : f.mutual ? 'Friends: you follow each other. Click to visit.' : f.role === 'follower' ? 'A follower. Click to visit.' : 'Someone they follow. Click to visit.' }),
      click: () => ui.openFriend(f),
    };
    crowd.add(actor);
    actors.push({ actor, paintHead, f });
  });
  pool(actors, 4, async ({ paintHead, f }) => {
    const img = await loadImage(avatarImage(f.id));
    if (img && !isPlaceholder(img)) paintHead(img);
  });

  return {
    count: friends.length,
    update(dt, t) {
      for (const c of clouds) {
        c.position.x += c.speed * dt;
        if (c.position.x > 50) c.position.x = -50;
      }
      for (const { actor } of actors) {
        const p = t * 2.2 + actor.phase;
        if (actor.mode === 0) {          // hopping
          actor.position.y = actor.home.y + Math.abs(Math.sin(p)) * 0.42;
        } else if (actor.mode === 1) {   // waving
          actor.position.y = actor.home.y;
          actor.armR.rotation.z = -2.3 + Math.sin(p * 2.4) * 0.5;
          actor.armR.position.y = 1.32;
        } else {                         // strolling
          actor.position.x = actor.home.x + Math.sin(p * 0.2) * 0.8;
          actor.position.y = actor.home.y + Math.abs(Math.sin(p * 1.4)) * 0.07;
        }
      }
    },
  };
}
