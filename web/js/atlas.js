// One big texture holding every project's thumbnail, filled in as images arrive.
// All thumbnail surfaces (floor, disco ball, quilt, dream) sample this with per-instance UVs.
import * as THREE from 'three';
import { BUNDLE, canvas, drawCover, isPlaceholder, loadImage, pool, projectImage } from './util.js';

const CELL_W = 120;
const CELL_H = 90;

export class Atlas {
  constructor(projects) {
    this.projects = projects;
    const size = projects.length * CELL_W * CELL_H > 2048 * 2048 * 0.85 ? 4096 : 2048;
    [this.canvas, this.g] = canvas(size, size);
    this.size = size;
    this.cols = Math.floor(size / CELL_W);
    this.rows = Math.floor(size / CELL_H);
    this.images = new Array(projects.length).fill(null);   // real thumbnails only
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.dirty = false;
    this.lastFlush = 0;
    this.loaded = 0;
    this.listeners = [];
    // Draw covers straight away so nothing is ever blank while the real images load.
    // In the static edition real images arrive at once, so only the ones without an image need one.
    projects.forEach((p, i) => { if (!BUNDLE || !projectImage(p.id)) drawCover(this.g, ...this.cell(i), CELL_W, CELL_H, p); });
    this.texture.needsUpdate = true;
  }

  cell(i) {
    return [(i % this.cols) * CELL_W, Math.floor(i / this.cols) * CELL_H];
  }

  /** [u, v, width, height] of a thumbnail, inset to stop mipmap bleed between neighbours. */
  rect(i) {
    const [x, y] = this.cell(i);
    const inset = 2;
    return [
      (x + inset) / this.size,
      1 - (y + CELL_H - inset) / this.size,
      (CELL_W - inset * 2) / this.size,
      (CELL_H - inset * 2) / this.size,
    ];
  }

  onChange(fn) { this.listeners.push(fn); }

  async load(onProgress) {
    const order = [...this.projects].sort((a, b) => b.loves - a.loves);
    await pool(order, 6, async (p) => {
      const img = await loadImage(projectImage(p.id));
      if (img && !isPlaceholder(img)) {
        this.images[p.index] = img;
        const [x, y] = this.cell(p.index);
        this.g.drawImage(img, x, y, CELL_W, CELL_H);
        this.dirty = true;
      }
      this.loaded++;
      onProgress?.(this.loaded, this.projects.length);
    });
    this.dirty = true;
  }

  /** Called every frame. Re-uploading a big texture is costly, so it's throttled. */
  flush() {
    const now = performance.now() / 1000;
    if (!this.dirty || now - this.lastFlush < (this.size > 2048 ? 2 : 0.8)) return;
    this.dirty = false;
    this.lastFlush = now;
    this.texture.needsUpdate = true;
    for (const fn of this.listeners) fn();
  }

  /** Draw project i into any canvas, real thumbnail or generated cover. */
  draw(g, i, x, y, w, h) {
    const img = this.images[i];
    if (img) g.drawImage(img, x, y, w, h);
    else drawCover(g, x, y, w, h, this.projects[i]);
  }

  /** InstancedMesh whose instances each show one thumbnail. */
  instances(geometry, count, indexOf, materialOpts = {}) {
    const geo = geometry.clone();
    const auv = new Float32Array(count * 4);
    for (let k = 0; k < count; k++) auv.set(this.rect(indexOf(k)), k * 4);
    geo.setAttribute('auv', new THREE.InstancedBufferAttribute(auv, 4));
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false, ...materialOpts });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = 'attribute vec4 auv;\n' + shader.vertexShader.replace(
        '#include <uv_vertex>',
        '#include <uv_vertex>\n  vMapUv = auv.xy + uv * auv.zw;',
      );
    };
    mat.customProgramCacheKey = () => 'atlas-thumb';
    return new THREE.InstancedMesh(geo, mat, count);
  }
}
