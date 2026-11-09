// Falling asleep: a kaleidoscope sky that morphs between project thumbnails, real costumes
// drifting past, and the projects' own sounds mixed into a slow ambient wash.
import * as THREE from 'three';
import { Rig } from './engine.js';
import { api, assetURL, canvas, canvasTexture, el, loadImage, pool, seeded } from './util.js';

const SKY_FRAG = `
  uniform sampler2D map; uniform float time; uniform float blend;
  uniform vec4 rectA; uniform vec4 rectB;
  varying vec3 vDir;

  float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
  }
  float fbm(vec2 p){ float a=.5, s=0.; for(int i=0;i<4;i++){ s+=a*noise(p); p*=2.03; a*=.5; } return s; }
  vec3 sampleCell(vec4 r, vec2 uv){
    vec2 m = abs(fract(uv*0.5)*2.0-1.0);   // mirror-repeat stays inside the cell
    return texture2D(map, r.xy + m*r.zw).rgb;
  }
  void main(){
    vec3 d = normalize(vDir);
    float ang = atan(d.z, d.x), lat = acos(clamp(d.y,-1.,1.));
    float seg = 6.2831853/6.0;                     // six-fold kaleidoscope
    float a = mod(ang + time*0.02, seg); a = abs(a - seg*0.5);
    vec2 p = vec2(a*1.15, lat*0.8 - time*0.012);
    vec2 flow = vec2(fbm(p*2.0 + time*0.04), fbm(p*2.0 - time*0.03 + 7.3)) - 0.5;
    vec2 uv = p + flow*0.14;                       // gentle wobble, pictures stay readable
    vec3 ca = sampleCell(rectA, uv);
    vec3 cb = sampleCell(rectB, uv + 0.2);
    float mask = smoothstep(-0.2, 0.2, blend*1.4 - 0.7 + (fbm(p*2.6 + time*0.03) - 0.5)*0.9);
    vec3 col = mix(ca, cb, mask);
    // Night-sky wash: dusky at the top and bottom, pastel through the middle.
    vec3 wash = mix(vec3(0.20,0.16,0.52), vec3(0.98,0.62,0.78), sin(lat)*sin(lat));
    wash = mix(wash, vec3(0.45,0.75,0.95), 0.5 + 0.5*sin(time*0.05 + lat*2.0));
    col = mix(col, wash, 0.5);
    float clouds = smoothstep(0.42, 0.72, fbm(vec2(ang*1.5, lat*3.0) + time*0.015));
    col = mix(col, vec3(1.0,0.96,0.98), clouds*0.32);
    gl_FragColor = vec4(col, 1.0);
  }`;

export class Dream {
  constructor(ctx, handlers) {
    this.ctx = ctx;
    this.handlers = handlers;
    this.name = 'dream';
    this.scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 200);
    camera.baseFov = 72;
    this.rig = new Rig(camera, { fly: true, speed: 0 });
    this.pickables = [];
    this.floaters = [];
    const { atlas, data } = ctx;
    this.rnd = seeded(data.seed + (Date.now() & 0xffff));
    this.uniforms = {
      map: { value: atlas.texture }, time: { value: 0 }, blend: { value: 0 },
      rectA: { value: new THREE.Vector4() }, rectB: { value: new THREE.Vector4() },
    };
    const sky = new THREE.Mesh(new THREE.SphereGeometry(90, 48, 32), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, uniforms: this.uniforms, fragmentShader: SKY_FRAG,
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    }));
    sky.raycast = () => {};
    this.scene.add(sky);
    this.pickRects();
    this.morphT = 0;
    this.morphing = false;
    this.pending = true;
  }

  pickProject() {
    const { data, atlas } = this.ctx;
    const withThumbs = data.projects.filter((p) => atlas.images[p.index]);
    const from = withThumbs.length ? withThumbs : data.projects;
    return from.length ? from[Math.floor(this.rnd() * from.length)] : null;
  }

  pickRects() {
    const set = (u) => {
      const p = this.pickProject();
      if (p) u.value.set(...this.ctx.atlas.rect(p.index));
    };
    if (this.uniforms.rectA.value.z === 0) set(this.uniforms.rectA);
    else this.uniforms.rectA.value.copy(this.uniforms.rectB.value);
    set(this.uniforms.rectB);
    this.uniforms.blend.value = 0;
  }

  addFloater(canvasEl, project, kind) {
    const tex = canvasTexture(canvasEl);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, toneMapped: false, depthWrite: false, opacity: 0 }));
    const r = this.rnd;
    const big = kind === 'thumb';
    const size = big ? 2.3 + r() * 1.4 : 1.1 + r() * 1.4;
    const aspect = canvasEl.width / canvasEl.height;
    s.scale.set(aspect >= 1 ? size : size * aspect, aspect >= 1 ? size / aspect : size, 1);   // longest side = size
    const f = { s, a: r() * 6.28, rad: 8 + r() * 12, y: -5 + r() * 12, va: (r() < 0.5 ? -1 : 1) * (0.03 + r() * 0.05), bob: r() * 6, base: size, spinAmt: big ? 0.05 : 0.3, born: this.t || 0 };
    this.floaters.push(f);
    if (project) {
      s.userData.pick = {
        hover: () => ({ project }),
        click: () => { this.ctx.sound.chime(); this.ctx.ui.openProject(project); },
      };
      this.pickables.push(s);
    }
    this.scene.add(s);
  }

  async gather() {
    if (this.gathered) return;
    this.gathered = true;
    const { data, atlas } = this.ctx;
    // Thumbnails first: rounded cards cut from the images we already have.
    const thumbs = [...data.projects].sort(() => this.rnd() - 0.5).slice(0, 26);
    for (const p of thumbs) {
      const [c, g] = canvas(240, 180);
      g.beginPath(); g.roundRect(0, 0, 240, 180, 26); g.clip();
      atlas.draw(g, p.index, 0, 0, 240, 180);
      this.addFloater(c, p, 'thumb');
    }
    // Then costumes and sounds from up to 10 projects with readable files.
    const source = data.byLoves.filter((p) => p.year >= 2013 && api.hasCode(p.id)).slice(0, 14).sort(() => this.rnd() - 0.5).slice(0, 10);
    const sounds = [];
    const costumes = [];
    await pool(source, 3, async (p) => {
      const code = await api.code(p.id);
      for (const s of code.sprites) {
        sounds.push(...s.sounds);
        if (!s.isStage) costumes.push(...s.costumes.slice(0, 3).map((c) => ({ ...c, project: p })));
      }
    });
    this.ctx.sound.addDreamSounds(sounds.sort(() => this.rnd() - 0.5));
    const unique = [...new Map(costumes.map((c) => [c.md5, c])).values()].sort(() => this.rnd() - 0.5).slice(0, 30);
    this.costumeCount = unique.length;
    await pool(unique, 4, async (c) => {
      const img = await loadImage(assetURL(c.md5));
      if (!img || !img.naturalWidth) return;
      const k = 220 / Math.max(img.naturalWidth, img.naturalHeight, 1);
      const [cv, g] = canvas(Math.max(8, Math.round(img.naturalWidth * k)), Math.max(8, Math.round(img.naturalHeight * k)));
      g.drawImage(img, 0, 0, cv.width, cv.height);
      this.addFloater(cv, c.project, 'costume');   // an unreadable image throws, and pool() skips it
    });
  }

  onEnter() {
    const { ui, sound } = this.ctx;
    ui.clearHud();
    ui.hud.append(
      el('div', { class: 'tools' }, ui.muteChip()),
      el('div', { class: 'dock' }, el('button', { class: 'chip', text: 'Wake up', style: { fontSize: '19px', padding: '8px 22px' }, onclick: () => this.handlers.exit() })),
      el('div', { class: 'help', style: { background: '#0d0e2bbb' }, text: 'Sweet dreams. Drag to look around. Click anything that floats by.' }),
    );
    this.rig.place({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0.05 });
    sound.startDream();
    this.gather();
  }

  onExit() { this.ctx.sound.stopDream(); }

  update(dt, t) {
    this.t = t;
    this.ctx.atlas.flush(t);
    const u = this.uniforms;
    u.time.value = t;
    this.morphT += dt;
    if (this.morphT > 9) {
      this.morphT = 0;
      this.pickRects();
    }
    u.blend.value = THREE.MathUtils.smoothstep(this.morphT, 3, 8);
    for (const f of this.floaters) {
      f.a += f.va * dt;
      f.s.position.set(Math.cos(f.a) * f.rad, f.y + Math.sin(t * 0.3 + f.bob) * 1.3, Math.sin(f.a) * f.rad);
      f.s.material.rotation = Math.sin(t * 0.25 + f.bob) * f.spinAmt;
      f.s.material.opacity = Math.min(1, (t - f.born) / 2.5);
    }
  }
}
