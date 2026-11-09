// Renderer, camera rig, input and picking. A "world" (room, code land, dream) plugs into this.
import * as THREE from 'three';
import { clamp, ease } from './util.js';

export class Rig {
  constructor(camera, opts = {}) {
    this.camera = camera;
    camera.rotation.order = 'YXZ';
    this.yaw = 0;
    this.pitch = 0;
    this.eye = opts.eye ?? 1.55;
    this.fly = !!opts.fly;
    this.speed = opts.speed ?? 3.6;
    this.limit = opts.limit ?? ((p) => p);
    this.vel = new THREE.Vector3();
    this.glideState = null;
    this.locked = false;
  }

  place({ x, y, z, yaw = 0, pitch = 0 }) {
    this.camera.position.set(x, y, z);
    this.yaw = yaw; this.pitch = pitch;
    this.apply();
  }

  apply() {
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  /** Glide smoothly to a pose. Takes the short way round when turning. */
  glide(to, dur = 1.1, done) {
    const from = { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z, yaw: this.yaw, pitch: this.pitch };
    let dy = (to.yaw ?? this.yaw) - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.glideState = { from, to: { ...from, ...to, yaw: this.yaw + dy }, t: 0, dur, done };
  }

  update(dt, move) {
    const moving = move.x !== 0 || move.z !== 0 || move.y !== 0;
    if (this.glideState && moving && !this.locked) this.glideState = null;
    if (this.glideState) {
      const g = this.glideState;
      g.t = Math.min(1, g.t + dt / g.dur);
      const k = ease(g.t);
      const lerp = (a, b) => a + (b - a) * k;
      this.camera.position.set(lerp(g.from.x, g.to.x), lerp(g.from.y, g.to.y), lerp(g.from.z, g.to.z));
      this.yaw = lerp(g.from.yaw, g.to.yaw);
      this.pitch = lerp(g.from.pitch, g.to.pitch);
      this.apply();
      if (g.t >= 1) { this.glideState = null; g.done && g.done(); }
      return;
    }
    if (this.locked) return;

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const speed = this.speed * (move.run ? 1.8 : 1);
    const want = new THREE.Vector3(
      (move.x * cos + move.z * sin) * speed,
      0,
      (-move.x * sin + move.z * cos) * speed,
    );
    if (this.fly) {
      const cp = Math.cos(this.pitch);
      want.set((move.x * cos - move.z * -sin * cp) * speed, (-move.z * Math.sin(this.pitch) + move.y) * speed, (-move.x * sin + move.z * cos * cp) * speed);
    }
    this.vel.lerp(want, 1 - Math.exp(-dt * 12));
    const p = this.camera.position;
    p.addScaledVector(this.vel, dt);
    if (!this.fly && this.vel.lengthSq() > 0.01) p.y += (this.eye - p.y) * (1 - Math.exp(-dt * 4));
    this.limit(p);
    this.apply();
  }
}

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.raycaster = new THREE.Raycaster();
    this.world = null;
    this.keys = new Set();
    this.stick = { x: 0, z: 0 };
    this.mouse = new THREE.Vector2();
    this.mouseFresh = false;
    this.hoverPick = null;
    this.onHover = () => {};
    this.paused = () => false;
    this.last = 0;
    this.time = 0;
    this.frames = 0;
    this.bind();
    this.resize();
  }

  bind() {
    addEventListener('resize', () => this.resize());
    addEventListener('keydown', (e) => {
      if (e.target.matches?.('input,textarea') || this.paused()) return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    const c = this.canvas;
    let down = null;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      down = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: 0, id: e.pointerId };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      this.pointerType = e.pointerType;
      this.mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
      this.mouseXY = [e.clientX, e.clientY];
      this.mouseFresh = true;
      if (down && e.pointerId === down.id) {
        const dx = e.clientX - down.lastX, dy = e.clientY - down.lastY;
        down.lastX = e.clientX; down.lastY = e.clientY;
        down.moved += Math.abs(dx) + Math.abs(dy);
        const rig = this.world?.rig;
        if (down.moved > 6 && rig && !rig.locked && !rig.glideState && !this.paused()) {
          rig.yaw += dx * 0.0042;
          rig.pitch = clamp(rig.pitch + dy * 0.0042, -1.45, 1.45);
          rig.apply();
          c.style.cursor = 'grabbing';
        }
      }
    });
    c.addEventListener('pointerup', (e) => {
      c.style.cursor = '';
      const wasClick = down && down.moved <= 6;
      down = null;
      if (!wasClick || this.paused()) return;
      this.mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
      this.mouseXY = [e.clientX, e.clientY];
      const hit = this.pick();
      this.world?.onAnyClick?.();
      if (hit?.pick?.click) hit.pick.click(hit.hit);
      else this.world?.onEmptyClick?.(hit?.hit);
    });
    c.addEventListener('pointerleave', () => { this.mouseFresh = false; this.setHover(null); });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rig = this.world?.rig;
      if (!rig || rig.locked || this.paused()) return;
      rig.glideState = null;
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.camera.quaternion);
      if (!rig.fly) dir.y = 0;
      rig.camera.position.addScaledVector(dir.normalize(), clamp(-e.deltaY * 0.004, -0.8, 0.8));
      rig.limit(rig.camera.position);
    }, { passive: false });
  }

  resize() {
    this.renderer.setSize(innerWidth, innerHeight, false);
    if (this.world) this.fitCamera(this.world.rig.camera);
  }

  fitCamera(camera) {
    camera.aspect = innerWidth / innerHeight;
    // Keep a sensible horizontal view on phones held upright.
    camera.fov = camera.aspect < 1 ? 82 : (camera.baseFov ?? 66);
    camera.updateProjectionMatrix();
  }

  setWorld(world) {
    this.world?.onExit?.();
    this.setHover(null);
    this.world = world;
    this.fitCamera(world.rig.camera);
    world.onEnter?.();
  }

  pick() {
    const w = this.world;
    if (!w) return null;
    this.raycaster.setFromCamera(this.mouse, w.rig.camera);
    const hits = this.raycaster.intersectObjects(w.pickables, true);
    if (!hits.length) return null;
    const hit = hits[0];
    let o = hit.object;
    while (o) {
      if (o.userData.pick) return { pick: o.userData.pick, hit };
      o = o.parent;
    }
    return { pick: null, hit };
  }

  setHover(info) {
    this.onHover(info, this.mouseXY);
  }

  updateHover() {
    if (!this.mouseFresh || this.paused() || this.world?.rig.locked) {
      if (this.hoverPick) { this.hoverPick.leave?.(); this.hoverPick = null; this.setHover(null); this.canvas.style.cursor = ''; }
      return;
    }
    const found = this.pick();
    const pick = found?.pick || null;
    if (this.hoverPick && this.hoverPick !== pick) this.hoverPick.leave?.();
    this.hoverPick = pick;
    const info = pick?.hover ? pick.hover(found.hit) : null;
    this.setHover(info);
    this.canvas.style.cursor = pick?.click && info !== null ? 'pointer' : '';
  }

  input() {
    const k = this.keys;
    const paused = this.paused();
    const on = (...codes) => !paused && codes.some((c) => k.has(c));
    return {
      x: (on('KeyD', 'ArrowRight') ? 1 : 0) - (on('KeyA', 'ArrowLeft') ? 1 : 0) + this.stick.x,
      z: (on('KeyS', 'ArrowDown') ? 1 : 0) - (on('KeyW', 'ArrowUp') ? 1 : 0) + this.stick.z,
      y: (on('KeyE', 'Space') ? 1 : 0) - (on('KeyQ') ? 1 : 0),
      run: on('ShiftLeft', 'ShiftRight'),
    };
  }

  start() {
    const tick = (now) => {
      requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - this.last) / 1000 || 0);
      this.last = now;
      this.time += dt;
      this.frames++;
      const w = this.world;
      if (!w) return;
      w.rig.update(dt, this.input());
      w.update?.(dt, this.time);
      this.updateHover();
      this.renderer.render(w.scene, w.rig.camera);
    };
    requestAnimationFrame(tick);
  }
}

/** Yaw and pitch that make a camera at `from` look at `to`. */
export function lookAngles(from, to) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

/** One clean pose object for a station. */
export function pose(pos, target) {
  return { x: pos[0], y: pos[1], z: pos[2], ...lookAngles(pos, target) };
}
