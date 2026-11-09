// All sound is made here: floor notes, clicks, and the dream's ambient mix.
import { assetURL } from './util.js';

const SCALE = [0, 2, 4, 7, 9];  // major pentatonic: any order of tiles sounds pleasant

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.dream = null;
  }

  /** Browsers only allow audio after a user gesture, so call this from one. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.02);
  }

  tone(freq, { type = 'triangle', dur = 0.25, vol = 0.12, slide = 0, delay = 0 } = {}) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** Tile step: pitch climbs through the portfolio, oldest low, newest high. */
  step(fraction) {
    const n = Math.floor(fraction * 15);
    const semis = SCALE[n % 5] + 12 * Math.floor(n / 5);
    this.tone(196 * Math.pow(2, semis / 12), { dur: 0.32, vol: 0.09 });
  }

  click() { this.tone(520, { type: 'square', dur: 0.07, vol: 0.05 }); }
  press() { this.tone(180, { type: 'square', dur: 0.09, vol: 0.08 }); this.tone(660, { dur: 0.2, vol: 0.08, delay: 0.07 }); }
  whoosh() { this.tone(180, { type: 'sawtooth', dur: 0.7, vol: 0.05, slide: 1100 }); }
  chime() { [0, 4, 7].forEach((s, i) => this.tone(523 * Math.pow(2, s / 12), { dur: 0.5, vol: 0.05, delay: i * 0.07 })); }

  /** Soft pad plus the project's own sounds, drifting through a long echo. */
  startDream() {
    this.unlock();
    if (!this.ctx || this.dream) return;
    const ctx = this.ctx;
    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.gain.linearRampToValueAtTime(1, ctx.currentTime + 2.5);
    bus.connect(this.master);

    const seconds = 3.5;
    const impulse = ctx.createBuffer(2, ctx.sampleRate * seconds, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = impulse.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.6);
    }
    const reverb = ctx.createConvolver();
    reverb.buffer = impulse;
    reverb.connect(bus);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 600;
    filter.connect(reverb);
    const padGain = ctx.createGain();
    padGain.gain.value = 0.05;
    padGain.connect(filter);
    const oscillators = [];
    [0, 7, 12, 16].forEach((semi, i) => {
      for (const detune of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = i % 2 ? 'triangle' : 'sine';
        o.frequency.value = 110 * Math.pow(2, semi / 12);
        o.detune.value = detune;
        o.connect(padGain);
        o.start();
        oscillators.push({ o, semi });
      }
    });
    const chords = [0, -3, 5, 2];
    let chord = 0;
    const chordTimer = setInterval(() => {
      chord = (chord + 1) % chords.length;
      for (const { o, semi } of oscillators) {
        o.frequency.setTargetAtTime(110 * Math.pow(2, (semi + chords[chord]) / 12), ctx.currentTime, 1.4);
      }
      filter.frequency.setTargetAtTime(400 + Math.random() * 700, ctx.currentTime, 2);
    }, 7000);

    this.dreamBuffers ||= [];
    const state = { bus, oscillators, chordTimer, sampleTimer: null, stopped: false };
    this.dream = state;

    const rates = [0.5, 0.75, 1, 1.125, 1.5];
    state.sampleTimer = setInterval(() => {
      if (!this.dreamBuffers.length || state.stopped) return;
      const src = ctx.createBufferSource();
      src.buffer = this.dreamBuffers[Math.floor(Math.random() * this.dreamBuffers.length)];
      src.playbackRate.value = rates[Math.floor(Math.random() * rates.length)];
      const g = ctx.createGain();
      g.gain.value = 0.32;
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) { pan.pan.value = Math.random() * 1.6 - 0.8; src.connect(g).connect(pan).connect(reverb); } else src.connect(g).connect(reverb);
      src.start();
      src.stop(ctx.currentTime + 8);
    }, 3200);
  }

  /** Decode a project's sounds into the running dream. Fetched once, then kept for later naps. */
  async addDreamSounds(sounds) {
    this.dreamBuffers ||= [];
    // Old Scratch sounds use a compressed WAV type browsers can't decode, so skip those up front.
    const usable = sounds.filter((s) => !s.adpcm && s.secs > 0 && s.secs < 25).slice(0, 10);
    await Promise.all(usable.map(async (s) => {
      try {
        const buf = await (await fetch(assetURL(s.md5))).arrayBuffer();
        this.dreamBuffers.push(await this.ctx.decodeAudioData(buf));
      } catch { /* a sound that won't decode just doesn't join the mix */ }
    }));
  }

  stopDream() {
    const d = this.dream;
    if (!d) return;
    this.dream = null;
    d.stopped = true;
    clearInterval(d.chordTimer);
    clearInterval(d.sampleTimer);
    const ctx = this.ctx;
    d.bus.gain.cancelScheduledValues(ctx.currentTime);
    d.bus.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
    setTimeout(() => {
      for (const { o } of d.oscillators) { try { o.stop(); } catch { /* already stopped */ } }
      d.bus.disconnect();
    }, 2000);
  }
}
