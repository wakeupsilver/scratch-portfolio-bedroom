// Everything that's HTML rather than 3D: hover card, project sheet, lists, HUD.
import { api, assetURL, avatarImage, BUNDLE, el, initialAvatar, isPlaceholder, longDate, num, plural, setThumb, clamp } from './util.js';

const $ = (id) => document.getElementById(id);

function statRow(p) {
  return el('div', { class: 'stats' },
    el('span', { style: { '--c': '#3aa0ff' }, text: `${num(p.views)} views` }),
    el('span', { style: { '--c': '#ff5a3c' }, text: `${num(p.loves)} loves` }),
    el('span', { style: { '--c': '#ffc531' }, text: `${num(p.favorites)} faves` }),
  );
}

export class UI {
  constructor(engine, sound) {
    this.engine = engine;
    this.sound = sound;
    this.card = $('card');
    this.modal = $('modal');
    this.hud = $('hud');
    this.fade = $('fade');
    this.toastEl = $('toast');
    this.cardKey = null;
    this.actions = {};
    engine.onHover = (info, xy) => this.showCard(info, xy);
    engine.paused = () => !this.modal.hidden;
    addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closeModal(); });
    this.modal.addEventListener('pointerdown', (e) => { if (e.target === this.modal) this.closeModal(); });
  }

  // ---------- hover card
  showCard(info, xy) {
    if (!info) {
      if (!this.card.hidden) { this.card.hidden = true; this.cardKey = null; }
      return;
    }
    const key = info.project ? 'p' + info.project.id : 't' + info.title + (info.sub || '');
    if (key !== this.cardKey) {
      this.cardKey = key;
      const kids = [];
      if (info.project) {
        const img = el('img');
        setThumb(img, info.project);
        kids.push(img, el('b', { text: info.project.title }));
        if (info.project.date) kids.push(el('small', { text: info.badge || longDate(info.project.date) }));
        kids.push(statRow(info.project));
      } else {
        if (info.image) kids.push(info.image);
        kids.push(el('b', { text: info.title }));
        if (info.sub) kids.push(el('small', { text: info.sub }));
      }
      this.card.replaceChildren(...kids);
      this.card.hidden = false;
    }
    if (xy) {
      const w = this.card.offsetWidth, h = this.card.offsetHeight;
      const x = xy[0] + 18 + w > innerWidth ? xy[0] - w - 14 : xy[0] + 18;
      const y = clamp(xy[1] - h / 2, 8, innerHeight - h - 8);
      this.card.style.transform = `translate(${x}px, ${y}px)`;
      this.card.style.left = 0; this.card.style.top = 0;
    }
  }

  // ---------- modal
  sheet(wide, ...kids) {
    const sheet = el('section', { class: 'sheet' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' },
      el('button', { class: 'close', 'aria-label': 'Close', text: '×', onclick: () => this.closeModal() }), ...kids);
    this.modal.replaceChildren(sheet);
    this.modal.hidden = false;
    this.card.hidden = true; this.cardKey = null;
    this.engine.keys.clear();
    sheet.querySelector('.close').focus({ preventScroll: true });
    return sheet;
  }

  closeModal() {
    if (this.modal.hidden) return;
    this.modal.replaceChildren();   // removing the iframe also stops a running project
    this.modal.hidden = true;
  }

  openProject(p) {
    this.sound.chime();
    const url = `https://scratch.mit.edu/projects/${p.id}/`;
    const stage = el('div', { class: 'stage' });
    const img = el('img');
    setThumb(img, p, '480x360');
    stage.append(img);
    const play = el('button', { class: 'btn go', text: 'Play it here', onclick: () => {
      const frame = el('iframe', { src: `https://scratch.mit.edu/projects/${p.id}/embed`, title: `Scratch project: ${p.title}`, allowfullscreen: '', allowtransparency: 'true' });
      stage.replaceChildren(frame);
      stage.classList.add('playing');
      play.hidden = true;
    } });
    const actions = el('div', { class: 'actions' }, BUNDLE ? null : play,
      el('a', { class: BUNDLE ? 'btn go' : 'btn', href: url, target: '_blank', rel: 'noopener', text: BUNDLE ? 'Play on Scratch' : 'Open on Scratch' }));
    const stripTitle = el('p', { class: 'strip-title', text: 'Looking inside…' });
    const strip = el('div', { class: 'strip' });
    const when = p.date ? `Shared ${longDate(p.date)}` : '';
    const tag = p.isFavorite ? 'One of their favorites' : p.isRemix ? 'Remix' : '';
    this.sheet(false,
      el('h2', { text: p.title }),
      el('p', { class: 'when', text: [when, tag].filter(Boolean).join(' · ') }),
      stage, statRow(p), actions, stripTitle, strip);

    api.code(p.id).then((code) => {
      if (code.format === 'sb1') {
        stripTitle.textContent = 'Time capsule: this project uses the 2007-era file format, so its costumes and code stay sealed for now. You can still play it.';
        stripTitle.style.fontWeight = 400;
        strip.remove();
        return;
      }
      const costumes = code.sprites.flatMap((s) => s.costumes).filter((c) => c.md5 && assetURL(c.md5)).slice(0, 24);
      stripTitle.textContent = BUNDLE ? `${plural(code.blockCount, 'block')} of code` : `${plural(costumes.length, 'costume')} and backdrops · ${plural(code.blockCount, 'block')} of code`;
      if (!costumes.length) strip.remove();
      strip.replaceChildren(...costumes.map((c) => el('img', { src: assetURL(c.md5), alt: c.name, title: c.name, loading: 'lazy' })));
      if (this.actions.showCode && !p.isFavorite && code.blockCount) {
        actions.append(el('button', { class: 'btn sun', text: 'Walk through its code', onclick: () => { this.closeModal(); this.actions.showCode(p); } }));
      }
    }).catch(() => { stripTitle.textContent = ''; strip.remove(); });
  }

  openFriend(f) {
    this.sound.chime();
    const av = el('img', { src: avatarImage(f.id) || initialAvatar(f.username).toDataURL(), alt: '', style: { width: '90px', height: '90px', borderRadius: '18px', border: '3px solid #1d2145' } });
    av.onload = () => { if (isPlaceholder(av)) av.src = initialAvatar(f.username).toDataURL(); };
    const rel = f.neighbor ? 'Another room on this street.' : f.mutual ? 'You follow each other.' : f.role === 'follower' ? 'Follows this Scratcher.' : 'This Scratcher follows them.';
    this.sheet(false,
      el('h2', { text: f.username }),
      el('p', { class: 'when', text: rel }),
      av,
      el('div', { class: 'actions' },
        f.neighbor
          ? el('button', { class: 'btn go', text: `Visit ${f.username}'s room`, onclick: () => { this.closeModal(); this.actions.visit(f.username); } })
          : BUNDLE ? null : el('a', { class: 'btn go', href: `/u/${encodeURIComponent(f.username)}`, text: `Visit ${f.username}'s room` }),
        el('a', { class: 'btn', href: `https://scratch.mit.edu/users/${encodeURIComponent(f.username)}/`, target: '_blank', rel: 'noopener', text: 'Open on Scratch' })));
  }

  openList(title, projects, note) {
    const list = el('ul', { class: 'list' });
    const render = (q) => {
      const shown = projects.filter((p) => !q || p.title.toLowerCase().includes(q)).slice(0, 300);
      list.replaceChildren(...shown.map((p) => {
        const img = el('img', { loading: 'lazy' });
        setThumb(img, p, '144x108');
        return el('li', {}, el('button', { onclick: () => this.openProject(p) },
          img, el('b', { text: p.title }), el('small', { text: `${p.date.getFullYear()} · ${num(p.loves)} loves` })));
      }));
    };
    render('');
    const kids = [el('h2', { text: title })];
    if (note) kids.push(el('p', { class: 'when', text: note }));
    if (projects.length > 8) kids.push(el('input', { class: 'list-search', type: 'search', placeholder: 'Search titles', 'aria-label': 'Search project titles', oninput: (e) => render(e.target.value.trim().toLowerCase()) }));
    kids.push(list);
    this.sheet(true, ...kids);
  }

  toast(text, ms = 3500) {
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.toastEl.hidden = true; }, ms);
  }

  fadeOut(dark = false) {
    this.fade.classList.toggle('dark', dark);
    this.fade.classList.add('on');
    return new Promise((r) => setTimeout(r, 620));
  }

  fadeIn() { this.fade.classList.remove('on'); }

  // ---------- HUD
  clearHud() { this.hud.hidden = false; this.hud.replaceChildren(); }

  plate(data) {
    const img = el('img', { src: avatarImage(data.profile.id) || initialAvatar(data.profile.username).toDataURL(), alt: '' });
    img.onload = () => { if (isPlaceholder(img)) { img.onload = null; img.src = initialAvatar(data.profile.username).toDataURL(); } };
    const since = new Date(data.profile.joined).getFullYear();
    return el('div', { class: 'plate' }, img, el('div', {},
      el('b', { text: `${data.profile.username}'s room` }),
      el('small', { text: `${plural(data.projects.length, 'project')} · ${num(data.totals.views)} views · since ${since}` })));
  }

  muteChip() {
    const b = el('button', { class: 'chip', 'aria-pressed': String(this.sound.muted), text: this.sound.muted ? 'Sound off' : 'Sound on', onclick: () => {
      this.sound.unlock();
      this.sound.setMuted(!this.sound.muted);
      b.textContent = this.sound.muted ? 'Sound off' : 'Sound on';
      b.setAttribute('aria-pressed', String(this.sound.muted));
    } });
    return b;
  }

  /** Touch-only walking stick. */
  joystick() {
    if (!matchMedia('(pointer: coarse)').matches) return null;
    const knob = el('i');
    const pad = el('div', { id: 'joystick', 'aria-hidden': 'true' }, knob);
    const stop = () => { this.engine.stick.x = 0; this.engine.stick.z = 0; knob.style.transform = ''; };
    const move = (e) => {
      const r = pad.getBoundingClientRect();
      let x = (e.clientX - r.left - r.width / 2) / (r.width / 2);
      let y = (e.clientY - r.top - r.height / 2) / (r.height / 2);
      const m = Math.hypot(x, y);
      if (m > 1) { x /= m; y /= m; }
      this.engine.stick.x = x; this.engine.stick.z = y;
      knob.style.transform = `translate(${x * 34}px, ${y * 34}px)`;
    };
    pad.addEventListener('pointerdown', (e) => { pad.setPointerCapture(e.pointerId); move(e); });
    pad.addEventListener('pointermove', (e) => { if (pad.hasPointerCapture(e.pointerId)) move(e); });
    pad.addEventListener('pointerup', stop);
    pad.addEventListener('pointercancel', stop);
    return pad;
  }
}
