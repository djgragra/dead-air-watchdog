// Dead Air Watchdog — window logic. The window never touches audio or secrets directly:
// it talks to the main process through window.api (see preload.cjs).
// © 2026 Graziano Melzi · OnAir Garage — MIT License
import { LANGS, makeT, tipUrl } from './i18n.js';
import { TEMPLATE_KINDS, TEMPLATE_VARS } from '../src/messages.js';
import { parseAddresses } from '../src/addresses.js';
import { moveItem } from '../src/core/order.js';
import { wallGrid } from '../src/core/wall-grid.js';
import { formatDuration, formatDateTime, formatDb, localeFor } from '../src/core/format.js';
import { hasTransparentEdge } from '../src/core/logo-alpha.js';
import { findCommonProblems } from '../src/core/report.js';

const api = window.api;
const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';

const METER_MIN = -80;
const METER_MAX = 0;
const MAX_INPUTS = 32;
const FAULTS = ['device-ended', 'stream-error', 'stream-ended', 'stream-stalled', 'stream-nostart', 'NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'ChannelsUnavailable'];

let settings = null;
let status = { running: false, overall: 'idle', counts: {}, inputs: [] };
let lang = 'en';
let t = makeT('en');
let info = { version: '' };
let chartDays = 7;
let chartInput = '';
let logInput = '';
let daily = [];
let events = [];
let logFilter = 'all';
let dirty = false;
let devices = [];
let devicesDenied = false;
let startError = null;
let upd = { view: null, phase: 'idle', pct: 0, got: 0, total: 0, error: '', after: '' }; // guided update: view from the main process + what the window is doing
let activeTab = 'inputs';
let wall = false;
let cursorTimer = null;
let logos = {}; // input id -> PNG data URL
const tiles = new Map(); // input id -> { root, name, type, state, sub, fault, rows }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
// element whose text follows the language (re-translated by applyI18n)
function tel(tag, cls, key) {
  const e = el(tag, cls, t(key));
  e.dataset.i18n = key;
  return e;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// A logo with a transparent edge gets no box behind it; one that fills its picture keeps a light box (data-alpha="no").
const alphaCache = new Map(); // data URL -> true (transparent edge) | false
function markAlpha(img, src) {
  if (!img) return;
  if (!src) {
    img.removeAttribute('data-alpha');
    return;
  }
  if (alphaCache.has(src)) {
    img.dataset.alpha = alphaCache.get(src) ? 'yes' : 'no';
    return;
  }
  const probe = new Image();
  probe.onload = () => {
    let transparent = false;
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(probe, 0, 0, 64, 64);
      transparent = hasTransparentEdge(ctx.getImageData(0, 0, 64, 64).data, 64, 64);
    } catch {
      /* unreadable: keeps the box */
    }
    alphaCache.set(src, transparent);
    if (img.getAttribute('src') === src) img.dataset.alpha = transparent ? 'yes' : 'no';
  };
  probe.src = src;
}

// A password (or an address that carries one) with an eye button; it opens hidden every time.
function addEye(input, { url = false } = {}) {
  if (input.parentElement?.classList.contains('pw')) return input.parentElement.querySelector('.pw__eye');
  const wrap = el('span', 'pw');
  input.replaceWith(wrap);
  const btn = el('button', 'pw__eye');
  btn.type = 'button';
  btn.append(el('span', 'ico ico--eye'));
  wrap.append(input, btn);
  const hide = (on) => {
    if (url) input.classList.toggle('is-masked', on);
    else input.type = on ? 'password' : 'text';
    btn.firstChild.className = `ico ${on ? 'ico--eye' : 'ico--eyeoff'}`;
    const label = t(on ? (url ? 'pw.showUrl' : 'pw.show') : url ? 'pw.hideUrl' : 'pw.hide');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', on ? 'false' : 'true');
  };
  btn.addEventListener('click', () => {
    const masked = url ? input.classList.contains('is-masked') : input.type === 'password';
    hide(!masked);
  });
  btn._reset = () => hide(true);
  btn._reset();
  return btn;
}
const resetEyes = () => document.querySelectorAll('.pw__eye').forEach((b) => b._reset?.());
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
const hostOf = (u) => {
  try {
    return new URL(u).host.replace(/^.*@/, '');
  } catch {
    return '';
  }
};

// ---- language and theme -------------------------------------------------------------------
function applyI18n() {
  document.documentElement.lang = lang;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  $('aboutText').textContent = t('help.pAbout', { v: info.version });
  document.title = t('app.title');
  for (const b of document.querySelectorAll('.pw__eye')) b._reset?.();
}

const media = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const pref = settings?.theme || 'dark';
  document.documentElement.dataset.theme = pref === 'auto' ? (media.matches ? 'dark' : 'light') : pref;
}
media.addEventListener('change', applyTheme);

// ---- clock ---------------------------------------------------------------------------------
function tickClock() {
  const now = new Date();
  const time = now.toLocaleTimeString(localeFor(lang), { hour12: false });
  const date = now.toLocaleDateString(localeFor(lang), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const longDate = now.toLocaleDateString(localeFor(lang), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('clockTime').textContent = $('wallClock').textContent = time;
  $('clockDate').textContent = date;
  $('wallDate').textContent = longDate;
  $('uptime').textContent = status.running && status.startedAt ? formatDuration(Date.now() - status.startedAt) : '—';
}

// ---- status: overall light, tiles, edge glow ------------------------------------------------
const usable = (i) => i.enabled && (i.type === 'device' ? settings.micExplained : /^https?:\/\//i.test(i.streamUrl));
const configured = () => !!settings && settings.inputs.some(usable);

function faultText(reason) {
  return FAULTS.includes(reason) ? t(`fault.${reason}`) : t('fault.other', { reason });
}

const namesOf = (state) => status.inputs.filter((i) => i.state === state).map((i) => i.name).join(', ');

function renderStatus() {
  const overall = status.running ? status.overall : 'idle';
  document.body.dataset.overall = overall;
  $('hero').dataset.state = overall;
  const word = overall === 'ok' ? t('overall.ok') : t(`st.${overall}`);
  $('heroState').textContent = word;
  $('statePill').dataset.state = overall;
  $('pillText').textContent = word;
  let sub = '';
  if (overall === 'idle') sub = t('st.sub.idle');
  else if (overall === 'starting') sub = t('st.sub.starting');
  else if (overall === 'ok') sub = t('overall.sub.ok', { n: status.counts.ok || 0 });
  else if (overall === 'counting') sub = t('overall.sub.counting', { names: namesOf('counting') });
  else if (overall === 'alarm') sub = t('overall.sub.alarm', { names: namesOf('alarm') });
  else if (overall === 'paused') sub = t('overall.sub.paused');
  $('heroSub').textContent = sub;
  $('wallState').textContent = overall === 'alarm' ? `${word} · ${namesOf('alarm')}` : overall === 'counting' ? `${word} · ${namesOf('counting')}` : word;

  const faulty = status.running ? status.inputs.filter((i) => i.fault) : [];
  const msg = startError || faulty.map((i) => `${i.name}: ${faultText(i.fault)}`).join(' · ');
  const fault = $('heroFault');
  fault.textContent = msg ? (startError ? msg : t('st.fault', { reason: msg })) : '';
  fault.classList.toggle('hidden', !msg);

  $('muteBtn').classList.toggle('hidden', !(status.running && status.soundPlaying));
  const btn = $('startBtn');
  btn.textContent = status.running ? t('top.stop') : t('top.start');
  btn.classList.toggle('btn--primary', !status.running);
  btn.classList.toggle('btn--stop', status.running);

  $('inputName').textContent = settings?.inputs.length ? t('tile.summary', { n: settings.inputs.length }) : t('top.notSet');
  $('setupCard').classList.toggle('hidden', configured() || status.running);

  const edge = $('edge');
  const glow = settings?.display.edgeGlow || 'wall';
  edge.dataset.state = overall;
  edge.classList.toggle('is-on', glow === 'always' || (glow === 'wall' && wall));
  renderTiles();
  tickClock();
}

// Wall display: long names. 'auto' shrinks each name (at most to half) until it fits in two lines;
// the other sizes are fixed (see style.css). Runs on every status change and on resize.
function applyDisplay() {
  const d = settings?.display || {};
  document.body.dataset.walllogo = d.wallLogo || 'large';
  document.body.dataset.wallclock = d.wallClock || 'max';
  document.body.style.setProperty('--logo-op', String(d.wallLogoOpacity ?? 0.2));
}

function fitWallNames() {
  const mode = settings?.display.wallNameSize || 'auto';
  document.body.dataset.wallname = mode;
  const shrink = (n) => {
    n.style.removeProperty('--name-scale');
    if (!wall || mode !== 'auto') return;
    let scale = 1;
    while (scale > 0.4 && n.scrollHeight > n.clientHeight + 1) {
      scale = Math.round((scale - 0.05) * 100) / 100;
      n.style.setProperty('--name-scale', scale);
    }
  };
  for (const tile of tiles.values()) shrink(tile.name);
  if (!fitWallStatus()) shrink($('wallState')); // the big line at the top ("DEAD AIR · <name>") carries a name too
}

// Wall display: the short status ("ALL OK") grows to fill the width the clock leaves free, up to the height of the
// clock; the long ones ("DEAD AIR · name") keep the size above, which shrinks the names to fit.
function fitWallStatus() {
  const n = $('wallState');
  const head = $('wallHead');
  const short = !!wall && !['alarm', 'counting'].includes(document.body.dataset.overall);
  n.classList.toggle('is-big', short);
  head.classList.remove('is-stacked');
  n.style.removeProperty('font-size');
  if (!short) return false;
  const clock = $('wallClock');
  const cap = Math.max(32, Math.round((clock.getBoundingClientRect().height || window.innerHeight * 0.17) * 1.05));
  const grow = () => {
    let size = Math.min(cap, Math.round(window.innerHeight * 0.3));
    n.style.fontSize = `${size}px`;
    while (size > 24 && n.scrollWidth > n.clientWidth + 1) {
      size = Math.floor(size * 0.95);
      n.style.fontSize = `${size}px`;
    }
    return size;
  };
  // a narrow screen (4:3) leaves little room next to the clock: the status goes on a line of its own
  if (grow() < cap * 0.55) {
    head.classList.add('is-stacked');
    grow();
  }
  return true;
}

// Wall display: puts every tile on screen. Picks the number of columns (and so rows) that gives the biggest
// tiles for what is in the window, for 1 to 32 inputs; the tile text scales with the tile (style.css).
function fitWallGrid() {
  const box = $('tiles');
  if (!wall) {
    box.style.removeProperty('grid-template-columns');
    box.style.removeProperty('grid-template-rows');
    return;
  }
  const { cols, rows } = wallGrid(tiles.size, box.clientWidth, box.clientHeight);
  box.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  box.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
}

function tileFor(input) {
  let tile = tiles.get(input.id);
  if (tile) return tile;
  const root = el('article', 'tile');
  const head = el('div', 'tile__head');
  const name = el('div', 'tile__name');
  const type = el('span', 'tile__type');
  const logo = el('img', 'tile__logo hidden');
  logo.alt = '';
  const art = el('div', 'tile__art'); // the big logo of the wall display ("Large")
  const artImg = el('img');
  artImg.alt = '';
  art.appendChild(artImg);
  const pause = el('button', 'tile__pause');
  pause.type = 'button';
  pause.append(el('span', 'ico ico--pause'));
  head.append(el('span', 'tile__dot'), logo, name, type, pause);
  const state = el('div', 'tile__state');
  const sub = el('div', 'tile__sub');
  const fault = el('div', 'tile__fault');
  const blips = el('button', 'tile__blips hidden');
  blips.type = 'button';
  const body = el('div', 'tile__body');
  body.append(head, state, sub, fault, blips);
  root.append(art, body);
  const rows = [0, 1].map(() => {
    const row = el('div', 'meter__row');
    const ch = el('span', 'meter__ch');
    const track = el('div', 'meter__track');
    const fill = el('div', 'meter__fill');
    const peak = el('div', 'meter__peak');
    const thr = el('div', 'meter__thrline');
    track.append(fill, peak, thr);
    const num = el('span', 'meter__num', '—');
    row.append(ch, track, num);
    body.appendChild(row);
    return { ch, fill, peak, thr, num, hold: { db: -120, at: 0 } };
  });
  pause.addEventListener('click', (e) => openPauseMenu(root.dataset.id, pause, e));
  blips.addEventListener('click', () => showMicroLog(root.dataset.id));
  tile = { root, logo, artImg, art, pause, blips, name, type, state, sub, fault, rows };
  tiles.set(input.id, tile);
  return tile;
}

const pctOf = (db) => clamp(((db - METER_MIN) / (METER_MAX - METER_MIN)) * 100, 0, 100);

function resetTileMeter(tile) {
  for (const r of tile.rows) {
    r.fill.style.width = '0%';
    r.peak.style.left = '0%';
    r.num.textContent = '—';
    r.hold = { db: -120, at: 0 };
  }
}

function renderTiles() {
  const box = $('tiles');
  const list = status.inputs;
  for (const id of [...tiles.keys()]) {
    if (!list.some((i) => i.id === id)) {
      tiles.get(id).root.remove();
      tiles.delete(id);
    }
  }
  list.forEach((inp, idx) => {
    const tile = tileFor(inp);
    if (box.children[idx] !== tile.root) box.insertBefore(tile.root, box.children[idx] || null);
    tile.root.dataset.state = inp.state;
    tile.root.dataset.id = inp.id;
    tile.name.textContent = inp.name;
    tile.name.title = inp.name; // the full name, when a long one is cut
    const logoSrc = logos[inp.id] || '';
    if (tile.logoSrc !== logoSrc) {
      tile.logoSrc = logoSrc;
      for (const img of [tile.logo, tile.artImg]) {
        if (logoSrc) img.src = logoSrc;
        else img.removeAttribute('src');
        markAlpha(img, logoSrc);
      }
      tile.logo.classList.toggle('hidden', !logoSrc);
      tile.root.classList.toggle('has-logo', !!logoSrc);
      if (logoSrc) tile.root.style.setProperty('--tile-logo', `url("${logoSrc}")`);
      else tile.root.style.removeProperty('--tile-logo');
    }
    const devName = inp.type === 'device' ? settings.inputs.find((i) => i.id === inp.id)?.deviceLabel : '';
    tile.type.textContent = t(inp.type === 'device' ? 'tile.device' : 'tile.stream') + (devName ? ` · ${devName}` : '');
    tile.state.textContent = t(`st.${inp.state}`);
    const paused = inp.state === 'paused';
    tile.pause.title = t('pause.btn');
    tile.pause.setAttribute('aria-label', t('pause.btn'));
    tile.pause.classList.toggle('hidden', !status.running || !!inp.scheduled || !['ok', 'counting', 'alarm', 'starting', 'paused'].includes(inp.state));
    renderTileBlips(tile, inp.id);
    let sub = '';
    if (paused && inp.scheduled) sub = t('st.sub.scheduled', { until: new Date(inp.pausedUntil).toLocaleTimeString(localeFor(lang), { hour: '2-digit', minute: '2-digit', hour12: false }) });
    else if (paused) sub = t('st.sub.paused', { until: new Date(inp.pausedUntil).toLocaleTimeString(localeFor(lang), { hour: '2-digit', minute: '2-digit', hour12: false }) });
    else if (inp.state === 'counting') sub = t('st.sub.counting', { elapsed: formatDuration(inp.elapsedMs), remaining: formatDuration(inp.remainingMs) });
    else if (inp.state === 'alarm') sub = t('st.sub.alarm', { cause: t(`cause.${inp.cause || 'silence'}`), since: new Date(inp.silenceStart).toLocaleTimeString(localeFor(lang), { hour12: false }), elapsed: formatDuration(inp.elapsedMs) });
    else if (inp.state === 'ok') sub = t('meter.threshold', { db: inp.thresholdDb });
    tile.sub.textContent = sub;
    tile.fault.textContent = inp.fault ? t('st.fault', { reason: faultText(inp.fault) }) : '';
    const pair = inp.type === 'device' ? inp.channelPair || 0 : 0;
    tile.rows[0].ch.textContent = pair ? String(pair * 2 + 1) : t('meter.ch1');
    tile.rows[1].ch.textContent = pair ? String(pair * 2 + 2) : t('meter.ch2');
    for (const r of tile.rows) r.thr.style.left = `${pctOf(inp.thresholdDb)}%`;
    if (!['ok', 'counting', 'alarm', 'starting', 'paused'].includes(inp.state)) resetTileMeter(tile);
  });
  fitWallGrid();
  fitWallNames();
}

// ---- micro-silences and pauses on the tiles ------------------------------------------------------------------
const startOfToday = () => new Date().setHours(0, 0, 0, 0);
function blipsOf(inputId) {
  const from = startOfToday();
  return events.filter((e) => e.kind === 'blip' && e.start >= from && (!inputId || e.inputId === inputId));
}

function renderTileBlips(tile, inputId) {
  const list = blipsOf(inputId);
  const b = tile.blips;
  b.classList.toggle('hidden', !list.length);
  if (!list.length) return;
  const last = list[0]; // events come newest first
  b.textContent = t('tile.blipsLast', { n: list.length, time: new Date(last.start).toLocaleTimeString(localeFor(lang), { hour: '2-digit', minute: '2-digit', hour12: false }), cause: t(`cause.${last.cause}`) });
}

function showMicroLog(inputId) {
  logFilter = 'blip';
  logInput = inputId || '';
  for (const x of document.querySelectorAll('[data-filter]')) x.classList.toggle('is-active', x.dataset.filter === 'blip');
  showView('log');
  $('logInput').value = logInput;
}

// the small menu of the pause button (maintenance): 1 hour, until tomorrow 06:00, or resume
let openMenu = null;
function closePauseMenu() {
  openMenu?.remove();
  openMenu = null;
}
function openPauseMenu(inputId, anchor, ev) {
  ev?.stopPropagation();
  const had = openMenu && openMenu._for === anchor;
  closePauseMenu();
  if (had) return;
  const inp = status.inputs.find((i) => i.id === inputId);
  if (!inp) return;
  const menu = el('div', 'menu');
  menu.setAttribute('role', 'menu');
  menu._for = anchor;
  menu.appendChild(el('div', 'menu__title', t('pause.menuTitle')));
  const item = (icon, key, mode) => {
    const b = el('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.append(el('span', `ico ico--${icon}`), el('span', '', t(key)));
    b.addEventListener('click', async () => {
      closePauseMenu();
      await api.monitor.pause(inputId, mode);
    });
    menu.appendChild(b);
  };
  if (inp.state === 'paused') item('play', 'pause.off', 'off');
  else {
    item('pause', 'pause.1h', '1h');
    item('pause', 'pause.tomorrow', 'tomorrow');
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 6)}px`;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth))}px`;
  openMenu = menu;
}

function onLevels(batch) {
  if (!status.running) return;
  const now = performance.now();
  // In Settings each input shows its level, so that "which card is which" can be found by playing something into one.
  if (!$('view-settings').classList.contains('hidden')) {
    for (const [id, lv] of Object.entries(batch)) {
      const live = $('inputsList').querySelector(`.input__live[data-live="${CSS.escape(id)}"]`);
      const db = Math.max(lv.rms[0] ?? -Infinity, lv.rms[1] ?? -Infinity);
      if (live) {
        live.textContent = Number.isFinite(db) ? `${formatDb(db)} dB` : '';
        live.classList.toggle('is-active', db > -60);
      }
    }
  }
  for (const [id, lv] of Object.entries(batch)) {
    const tile = tiles.get(id);
    const inp = status.inputs.find((i) => i.id === id);
    if (!tile || !inp) continue;
    tile.rows.forEach((r, c) => {
      const db = lv.rms[c] ?? lv.rms[0];
      const pk = lv.peak[c] ?? lv.peak[0];
      if (db === undefined) return;
      r.fill.style.width = `${pctOf(db)}%`;
      r.fill.classList.toggle('is-low', db < inp.thresholdDb);
      r.fill.classList.toggle('is-hot', db > -3);
      r.num.textContent = formatDb(db);
      if (pk >= r.hold.db) r.hold = { db: pk, at: now };
      else if (now - r.hold.at > 1200) r.hold = { db: Math.max(pk, r.hold.db - 3), at: r.hold.at }; // hold 1.2 s, then fall
      r.peak.style.left = `${pctOf(r.hold.db)}%`;
    });
  }
}

// ---- wall display ----------------------------------------------------------------------------
// The Save bar of Settings sticks under the top bar (which can wrap onto more lines), not behind it.
function trackTopbarHeight() {
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  const apply = () => {
    const h = getComputedStyle(bar).position === 'sticky' ? bar.offsetHeight : 0; // on a narrow window the top bar scrolls away
    document.documentElement.style.setProperty('--topbar-h', `${h}px`);
  };
  apply();
  if (typeof ResizeObserver === 'function') new ResizeObserver(apply).observe(bar);
  window.addEventListener('resize', apply);
}

async function setWall(on, tell = true) {
  wall = on;
  document.body.classList.toggle('wall', on);
  if (on) showView('dashboard');
  if (tell) await api.wall.set(on);
  document.body.classList.remove('idle-cursor');
  wakeCursor();
  renderStatus();
}

function wakeCursor() {
  document.body.classList.remove('idle-cursor');
  clearTimeout(cursorTimer);
  if (wall) cursorTimer = setTimeout(() => document.body.classList.add('idle-cursor'), 4000);
}

// ---- statistics and chart -----------------------------------------------------------------------
function compact(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round((s / 3600) * 10) / 10}h`;
}

const NICE_MS = [30e3, 60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3, 6 * 3600e3, 12 * 3600e3, 24 * 3600e3];

function renderChart() {
  const box = $('chart');
  box.replaceChildren();
  const W = 720;
  const H = 230;
  const m = { l: 46, r: 8, t: 10, b: 26 };
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  const total = daily.reduce((n, d) => n + d.totalMs, 0);
  const count = daily.reduce((n, d) => n + d.count, 0);
  svg.setAttribute('aria-label', `${t('chart.title')}: ${count} · ${formatDuration(total)}`);
  const max = Math.max(...daily.map((d) => d.totalMs), 0);
  const top = NICE_MS.find((v) => v >= max) || NICE_MS.at(-1);
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const mk = (name, attrs, text) => {
    const n = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    return n;
  };
  for (const f of [0, 0.5, 1]) {
    const y = m.t + ph - f * ph;
    svg.appendChild(mk('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: y, y2: y }));
    svg.appendChild(mk('text', { class: 'axis', x: m.l - 6, y: y + 4, 'text-anchor': 'end' }, f === 0 ? '0' : compact(top * f)));
  }
  const n = daily.length;
  const step = pw / n;
  const bw = Math.min(40, step * 0.68);
  const every = n <= 7 ? 1 : n <= 14 ? 2 : 5;
  daily.forEach((d, i) => {
    const x = m.l + i * step + (step - bw) / 2;
    if (d.count > 0) {
      const h = Math.max(3, (d.totalMs / top) * ph);
      const bar = mk('rect', { class: 'bar', x, y: m.t + ph - h, width: bw, height: h, rx: 2 });
      bar.appendChild(mk('title', {}, t('chart.tip', { date: d.date, count: d.count, total: formatDuration(d.totalMs) })));
      svg.appendChild(bar);
    }
    if ((n - 1 - i) % every === 0) svg.appendChild(mk('text', { class: 'axis', x: x + bw / 2, y: H - 8, 'text-anchor': 'middle' }, `${d.date.slice(8, 10)}/${d.date.slice(5, 7)}`));
  });
  if (count === 0) svg.appendChild(mk('text', { class: 'empty', x: W / 2, y: m.t + ph / 2 }, t('chart.empty')));
  box.appendChild(svg);
}

function renderKpis() {
  const today = daily.at(-1) || { count: 0, totalMs: 0, longestMs: 0 };
  const count = daily.reduce((n, d) => n + d.count, 0);
  const total = daily.reduce((n, d) => n + d.totalMs, 0);
  const longest = daily.reduce((m, d) => Math.max(m, d.longestMs), 0);
  const evText = (c) => (c === 1 ? t('kpi.event') : t('kpi.events', { n: c }));
  $('kpiToday').textContent = today.count ? formatDuration(today.totalMs) : t('kpi.none');
  $('kpiTodaySub').textContent = today.count ? evText(today.count) : '';
  $('kpiPeriodLabel').textContent = t('kpi.period', { n: chartDays });
  $('kpiPeriod').textContent = count ? formatDuration(total) : t('kpi.none');
  $('kpiPeriodSub').textContent = count ? evText(count) : '';
  $('kpiLongest').textContent = longest ? formatDuration(longest) : t('kpi.none');
  $('kpiLongestSub').textContent = '';
  $('kpiMicro').textContent = String(blipsOf('').length);
}

async function refreshStats() {
  daily = await api.stats.daily(chartDays, chartInput || undefined);
  renderChart();
  renderKpis();
}

function inputName(i) {
  return i.name || (i.type === 'stream' ? hostOf(i.streamUrl) || t('set.in.newStream') : i.deviceLabel || t('set.in.sound'));
}

function fillInputSelect(sel, current) {
  sel.replaceChildren(new Option(t('filter.allInputs'), ''));
  for (const i of settings.inputs) sel.appendChild(new Option(inputName(i), i.id));
  sel.value = settings.inputs.some((i) => i.id === current) ? current : '';
  return sel.value;
}

// ---- events (recent list and log) ---------------------------------------------------------------
const shortDuration = (ms) => (ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : formatDuration(ms));

function typeBadge(e) {
  if (e.kind === 'blip') return el('span', 'badge badge--blip', t('kind.blip'));
  if (e.kind === 'pause') return el('span', 'badge badge--pause', t('kind.pause'));
  return el('span', `badge ${e.kind === 'gap' ? 'badge--gap' : 'badge--dead'}`, t(`cause.${e.cause}`));
}

const LOG_LIMIT = 1000;

function noteOf(e) {
  const clock = (ts) => new Date(ts).toLocaleTimeString(localeFor(lang), { hour: '2-digit', minute: '2-digit', hour12: false });
  if (e.kind === 'gap') return t('log.gapNote');
  if (e.kind === 'blip') return [t(`cause.${e.cause}`), t('log.blipNote')].join(' · ');
  if (e.kind === 'pause') return e.end ? (e.expired ? t('log.pauseExpired') : t('log.pauseNote', { until: clock(e.end) })) : t('log.pauseNote', { until: clock(e.until) });
  return [e.interrupted ? t('log.interrupted') : '', e.pausedBy ? t('log.pausedBy') : '', e.scheduled ? t('log.scheduled') : ''].filter(Boolean).join(' · ');
}

function renderRecent() {
  const box = $('recent');
  box.replaceChildren();
  const rows = events.filter((e) => e.kind === 'dead-air' && (!chartInput || e.inputId === chartInput)).slice(0, 6);
  if (!rows.length) {
    box.appendChild(el('p', 'empty-msg', t('recent.none')));
    return;
  }
  const table = el('table');
  const body = el('tbody');
  for (const e of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', '', formatDateTime(e.start, lang)));
    tr.appendChild(el('td', '', e.input || ''));
    tr.appendChild(el('td', 'mono', e.end ? formatDuration(e.end - e.start) : t('log.ongoing')));
    const c = el('td');
    c.appendChild(typeBadge(e));
    tr.appendChild(c);
    body.appendChild(tr);
  }
  table.appendChild(body);
  box.appendChild(table);
}

// events that belong to a moment when several inputs went down together (probable problem of the network or of this computer)
let commonIds = new Set();

function renderLog() {
  const box = $('logTable');
  box.replaceChildren();
  const all = events.filter((e) => (logFilter === 'all' || e.kind === logFilter) && (!logInput || e.inputId === logInput || (e.kind === 'gap' && !logInput)));
  if (!all.length) {
    box.appendChild(el('p', 'empty-msg', t('log.none')));
    return;
  }
  const rows = all.slice(0, LOG_LIMIT);
  const table = el('table');
  const head = el('tr');
  for (const k of ['start', 'end', 'dur', 'type', 'input', 'note']) head.appendChild(el('th', '', t(`log.col.${k}`)));
  const thead = el('thead');
  thead.appendChild(head);
  table.appendChild(thead);
  const body = el('tbody');
  for (const e of rows) {
    const tr = el('tr', e.kind === 'gap' ? 'is-gap' : e.kind === 'blip' ? 'is-blip' : '');
    tr.appendChild(el('td', '', formatDateTime(e.start, lang)));
    tr.appendChild(el('td', '', e.end ? formatDateTime(e.end, lang) : t('log.ongoing')));
    tr.appendChild(el('td', 'mono', e.end ? shortDuration(e.end - e.start) : formatDuration(Date.now() - e.start) + ' …'));
    const c = el('td');
    c.appendChild(typeBadge(e));
    tr.appendChild(c);
    tr.appendChild(el('td', '', e.input || ''));
    const note = el('td', '', noteOf(e));
    if (commonIds.has(e.id)) {
      const b = el('span', 'badge badge--common', t('log.common'));
      b.title = t('log.commonTip');
      note.append(note.textContent ? ' · ' : '', b);
    }
    tr.appendChild(note);
    body.appendChild(tr);
  }
  table.appendChild(body);
  box.appendChild(table);
  if (all.length > rows.length) box.appendChild(el('p', 'hint', t('log.limited', { n: LOG_LIMIT })));
}

async function refreshEvents() {
  events = await api.events.list();
  commonIds = findCommonProblems(events, { totalInputs: settings?.inputs.length || 0 }).eventIds;
  renderRecent();
  renderLog();
  refreshReport();
  renderKpis();
  renderTiles(); // the micro-silence counters
}

// ---- summary (availability per input, common problems) -----------------------------------------------------------------
let reportPeriod = 'thisMonth';

const pctText = (v) => (v === null ? '—' : `${v.toFixed(v >= 99.995 ? 0 : 2)}%`);

async function refreshReport() {
  const box = $('reportBox');
  if (!box || !settings) return;
  const r = await api.report.get(reportPeriod);
  const day = (ts) => new Date(ts).toLocaleDateString(localeFor(lang), { day: '2-digit', month: '2-digit', year: 'numeric' });
  $('reportRange').textContent = `${day(r.from)} – ${day(r.to)}`;
  box.replaceChildren();
  if (!r.rows.length) {
    box.appendChild(el('p', 'empty-msg', t('report.noInputs')));
  } else {
    const table = el('table');
    const head = el('tr');
    for (const k of ['input', 'avail', 'alarms', 'down', 'longest', 'micro', 'common']) head.appendChild(el('th', '', t(`report.col.${k}`)));
    const thead = el('thead');
    thead.appendChild(head);
    table.appendChild(thead);
    const body = el('tbody');
    for (const row of r.rows) {
      const tr = el('tr');
      tr.appendChild(el('td', '', row.input));
      const a = el('td', 'mono', pctText(row.availability));
      if (row.availability !== null && row.commonAlarms > 0) a.title = t('report.withoutCommon', { pct: pctText(row.availabilityWithoutCommon) });
      tr.appendChild(a);
      tr.appendChild(el('td', 'mono', String(row.alarms)));
      tr.appendChild(el('td', 'mono', row.downMs ? formatDuration(row.downMs) : '—'));
      tr.appendChild(el('td', 'mono', row.longestMs ? formatDuration(row.longestMs) : '—'));
      tr.appendChild(el('td', 'mono', String(row.micro)));
      tr.appendChild(el('td', 'mono', row.commonAlarms ? `${row.commonAlarms} (${pctText(row.availabilityWithoutCommon)})` : '—'));
      body.appendChild(tr);
    }
    table.appendChild(body);
    box.appendChild(table);
    box.appendChild(el('p', 'hint', t('report.note')));
  }
  const cbox = $('reportCommon');
  cbox.replaceChildren();
  if (r.common.length) {
    cbox.appendChild(el('h3', '', t('report.commonTitle', { n: r.common.length })));
    cbox.appendChild(el('p', 'hint', t('report.commonHint', { n: r.minInputs, s: Math.round(r.windowMs / 1000) })));
    const ul = el('ul', 'common__list');
    for (const g of r.common.slice(0, 50)) ul.appendChild(el('li', '', `${formatDateTime(g.start, lang)} · ${t('report.commonLine', { n: g.inputs.length })}: ${g.inputs.join(', ')}`));
    cbox.appendChild(ul);
    if (r.common.length > 50) cbox.appendChild(el('p', 'hint', t('log.limited', { n: 50 })));
  }
}

async function doExportReport() {
  const r = await api.report.export(reportPeriod);
  if (r.ok) {
    const n = $('logNotice');
    n.textContent = `${t('report.exported', { n: r.count })} ${r.file}`;
    n.classList.remove('hidden');
  }
}

async function doExport(format) {
  const r = await api.events.export(format);
  if (r.ok) {
    const n = $('logNotice');
    n.textContent = `${t('log.exported', { n: r.count })} ${r.file}`;
    n.classList.remove('hidden');
  }
}

// ---- settings form: inputs --------------------------------------------------------------------------
function setDirty(v) {
  dirty = v;
  const s = $('saveState');
  s.textContent = v ? t('set.unsaved') : '';
  s.classList.toggle('is-dirty', v);
}

const validUrl = (u) => /^https?:\/\/[^\s/$.?#][^\s]*$/i.test(u);

// Names of the devices as shown: two devices with the same name (two identical USB cards) get a number, in the
// order the system lists them, so they can be told apart. The real identity is always the device id.
function deviceNames() {
  const real = devices.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications');
  const total = new Map();
  for (const d of real) total.set(d.label, (total.get(d.label) || 0) + 1);
  const seen = new Map();
  const names = new Map();
  for (const d of real) {
    const base = d.label || d.deviceId.slice(0, 8);
    const n = (seen.get(d.label) || 0) + 1;
    seen.set(d.label, n);
    names.set(d.deviceId, total.get(d.label) > 1 ? `${base} (${n})` : base);
  }
  return names;
}
const optionName = (o) => o?.dataset.base || o?.textContent || '';

function fillDeviceSelect(sel, selectedId, selectedLabel) {
  const none = new Option(t('set.dev.default'), '');
  none.dataset.base = none.textContent;
  sel.replaceChildren(none);
  for (const [id, name] of deviceNames()) {
    const o = new Option(name, id);
    o.dataset.base = name;
    sel.appendChild(o);
  }
  if (selectedId && ![...sel.options].some((o) => o.value === selectedId)) {
    const o = new Option(selectedLabel || selectedId.slice(0, 8), selectedId);
    o.dataset.base = selectedLabel || selectedId.slice(0, 8);
    o.dataset.missing = '1'; // the saved device is not in the list: it is kept (never swapped for another card) and marked
    sel.appendChild(o);
  }
  sel.value = selectedId || '';
  markUsedDevices();
}

// In every device list, a device already chosen by another input (with the same pair of channels) is marked.
function markUsedDevices() {
  const picks = [...$('inputsList').querySelectorAll('.input[data-type="device"]')].map((card) => ({ card, id: card.querySelector('.in-device')?.value ?? '', pair: card.querySelector('.in-chan')?.value ?? '0' }));
  for (const { card, id, pair } of picks) {
    const sel = card.querySelector('.in-device');
    if (!sel) continue;
    for (const o of sel.options) {
      if (!o.dataset.base) continue;
      const other = picks.find((p) => p.card !== card && p.id === o.value && p.pair === pair);
      const gone = o.dataset.missing && devices.length > 0;
      o.textContent = gone ? `${o.dataset.base} · ${t('set.dev.missing')}` : other ? `${o.dataset.base} · ${t('set.dev.used', { name: inputTitle(other.card) })}` : o.dataset.base;
    }
  }
}

function labelled(key, control, cls = 'field') {
  const l = el('label', cls);
  l.append(tel('span', '', key), control);
  return l;
}

function numberInput(cls, min, max, value) {
  const n = el('input', `num ${cls}`);
  n.type = 'number';
  n.min = min;
  n.max = max;
  n.step = 1;
  n.inputMode = 'numeric';
  n.value = value;
  return n;
}

function inputTitle(card) {
  const name = card.querySelector('.in-name').value.trim();
  if (name) return name;
  if (card.dataset.type === 'stream') return hostOf(card.querySelector('.in-url').value) || t('set.in.newStream');
  const sel = card.querySelector('.in-device');
  return sel.value ? optionName(sel.selectedOptions[0]) || t('set.in.sound') : t('set.in.sound');
}

function cardLogo(card) {
  return card._logo !== undefined ? card._logo : logos[card.dataset.id] || null;
}

function refreshCardLogo(card) {
  const data = cardLogo(card);
  const img = card.querySelector('.logo-box img');
  const small = card.querySelector('.input__logo');
  for (const i of [img, small]) {
    if (data) i.src = data;
    else i.removeAttribute('src');
  }
  markAlpha(img, data);
  markAlpha(small, data);
  img.classList.toggle('hidden', !data);
  small.classList.toggle('hidden', !data);
  card.querySelector('.in-logo-remove').disabled = !data;
}

// Shrinks a picture chosen by the user to at most 256 px and returns it as a PNG data URL.
function logoFromFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/') || file.size > 5 * 1024 * 1024) return reject(new Error('bad-logo'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('bad-logo'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('bad-logo'));
      img.onload = () => {
        const vector = file.type === 'image/svg+xml';
        const w = img.naturalWidth || 256;
        const h = img.naturalHeight || 256;
        const scale = vector ? 256 / Math.max(w, h) : Math.min(1, 256 / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---- per-input options: yellow delay, frozen audio, monitoring hours -------------------------------------------------------
const WEEK = [1, 2, 3, 4, 5, 6, 0]; // Monday first
const dayName = (d) => new Date(2026, 9, 18 + d).toLocaleDateString(localeFor(lang), { weekday: 'short' });

function decimalInput(cls, min, max, step, value) {
  const n = numberInput(cls, min, max, value);
  n.step = step;
  n.inputMode = 'decimal';
  return n;
}

function buildRule(rule) {
  const row = el('div', 'rule');
  const days = el('span', 'rule__days');
  for (const d of WEEK) {
    const l = el('label', 'daychip');
    const c = el('input', 'rule-day');
    c.type = 'checkbox';
    c.value = d;
    c.checked = rule.days.includes(d);
    l.append(c, el('span', '', dayName(d)));
    days.appendChild(l);
  }
  const from = el('input', 'rule-from');
  from.type = 'time';
  from.value = rule.from;
  from.required = true;
  const to = el('input', 'rule-to');
  to.type = 'time';
  to.value = rule.to;
  to.required = true;
  const mode = el('select', 'rule-mode');
  for (const m of ['off', 'custom']) {
    const o = new Option(t(`sched.mode.${m}`), m);
    o.dataset.i18n = `sched.mode.${m}`;
    mode.appendChild(o);
  }
  mode.value = rule.mode;
  const thr = numberInput('rule-thr', -90, -10, rule.thresholdDb);
  const min = numberInput('rule-min', 1, 3600, rule.minSilenceSec);
  const custom = el('span', 'rule__custom');
  custom.append(tel('span', '', 'sched.thr'), thr, tel('span', '', 'sched.min'), min);
  custom.classList.toggle('hidden', rule.mode !== 'custom');
  const rm = tel('button', 'btn btn--small btn--ghost rule-remove', 'sched.remove');
  rm.type = 'button';
  const when = el('span', 'rule__when');
  when.append(tel('span', '', 'sched.from'), from, tel('span', '', 'sched.to'), to, mode);
  row.append(days, when, custom, rm);
  return row;
}

function buildAdvanced(inp) {
  const box = el('details', 'input__adv');
  box.appendChild(tel('summary', '', 'adv.title'));
  const body = el('div', 'adv__body');

  // yellow delay
  const yellow = decimalInput('in-yellow', 0, 60, 0.5, inp.yellowDelaySec ?? 2);
  const yRow = el('div', 'row');
  yRow.append(yellow, tel('span', 'hint', 'adv.sec'));
  const yField = el('div', 'field');
  yField.append(tel('span', '', 'adv.yellow'), yRow, tel('p', 'hint', 'adv.yellow.hint'));

  // frozen audio
  const fOn = el('input', 'in-frozen-on');
  fOn.type = 'checkbox';
  fOn.checked = (inp.frozenSec || 0) > 0;
  const fLabel = el('label', 'check');
  fLabel.append(fOn, tel('span', '', 'adv.frozen'));
  const fSec = numberInput('in-frozen-sec', 10, 3600, inp.frozenSec > 0 ? inp.frozenSec : 60);
  const fTol = decimalInput('in-frozen-tol', 0.1, 6, 0.1, inp.frozenToleranceDb ?? 1);
  const fRow = el('div', 'row adv__frozen');
  fRow.append(tel('span', '', 'adv.frozen.for'), fSec, tel('span', 'hint', 'adv.sec'), tel('span', '', 'adv.frozen.tol'), fTol, tel('span', 'hint', 'adv.db'));
  fRow.classList.toggle('hidden', !fOn.checked);
  const fField = el('div', 'field');
  fField.append(fLabel, fRow, tel('p', 'hint', 'adv.frozen.hint'));

  // monitoring hours
  const sch = inp.schedule || { enabled: false, rules: [] };
  const sOn = el('input', 'in-sched-on');
  sOn.type = 'checkbox';
  sOn.checked = !!sch.enabled;
  const sLabel = el('label', 'check');
  sLabel.append(sOn, tel('span', '', 'sched.title'));
  const rules = el('div', 'rules');
  for (const r of sch.rules) rules.appendChild(buildRule(r));
  const add = tel('button', 'btn btn--small in-rule-add', 'sched.add');
  add.type = 'button';
  const sBox = el('div', 'sched__box');
  sBox.append(rules, add);
  sBox.classList.toggle('hidden', !sOn.checked);
  const sField = el('div', 'field');
  sField.append(sLabel, sBox, tel('p', 'hint', 'sched.hint'));

  body.append(yField, fField, sField);
  box.appendChild(body);
  return box;
}

function readSchedule(card) {
  return {
    enabled: card.querySelector('.in-sched-on').checked,
    rules: [...card.querySelectorAll('.rule')].map((r) => ({
      days: [...r.querySelectorAll('.rule-day:checked')].map((c) => Number(c.value)),
      from: r.querySelector('.rule-from').value,
      to: r.querySelector('.rule-to').value,
      mode: r.querySelector('.rule-mode').value,
      thresholdDb: Number(r.querySelector('.rule-thr').value),
      minSilenceSec: Number(r.querySelector('.rule-min').value)
    }))
  };
}

function buildInputCard(inp, open) {
  const card = el('details', 'input');
  card.dataset.id = inp.id;
  card.dataset.type = inp.type;
  card.open = open;
  const summary = el('summary');
  const title = el('span', 'input__title');
  const sumLogo = el('img', 'input__logo hidden');
  sumLogo.alt = '';
  const move = el('span', 'input__move');
  for (const [cls, glyph, key] of [['in-up', '▲', 'set.in.up'], ['in-down', '▼', 'set.in.down']]) {
    const b = el('button', `btn btn--small ${cls}`, glyph);
    b.type = 'button';
    b.title = t(key);
    b.setAttribute('aria-label', t(key));
    move.appendChild(b);
  }
  const live = el('span', 'input__live');
  live.dataset.live = inp.id;
  live.title = t('set.live.tip');
  summary.append(sumLogo, title, live, tel('span', 'input__kind', inp.type === 'device' ? 'tile.device' : 'tile.stream'), move);
  const body = el('div', 'input__body');

  const enabled = el('input', 'in-enabled');
  enabled.type = 'checkbox';
  enabled.checked = inp.enabled;
  const enabledLabel = el('label', 'check');
  enabledLabel.append(enabled, tel('span', '', 'set.in.enabled'));

  const name = el('input', 'in-name');
  name.type = 'text';
  name.value = inp.name;
  name.maxLength = 60;
  name.spellcheck = false;

  body.append(enabledLabel, labelled('set.in.name', name));

  // logo: _logo is undefined (unchanged), null (to be removed) or a PNG data URL (to be stored on save)
  const logoImg = el('img');
  logoImg.alt = '';
  const logoBox = el('div', 'logo-box');
  logoBox.appendChild(logoImg);
  const choose = tel('button', 'btn btn--small in-logo-choose', 'set.logo.choose');
  choose.type = 'button';
  const dropLogo = tel('button', 'btn btn--small btn--ghost in-logo-remove', 'set.logo.remove');
  dropLogo.type = 'button';
  const file = el('input', 'in-logo-file hidden');
  file.type = 'file';
  file.accept = 'image/*';
  const logoRow = el('div', 'logo-field');
  logoRow.append(logoBox, choose, dropLogo, file);
  const logoField = el('div', 'field');
  logoField.append(tel('span', '', 'set.logo.label'), logoRow, tel('p', 'hint', 'set.logo.hint'), tel('p', 'warn hidden in-logo-bad', 'set.logo.bad'));
  body.appendChild(logoField);

  if (inp.type === 'stream') {
    const url = el('input', 'in-url');
    url.type = 'url';
    url.value = inp.streamUrl;
    url.spellcheck = false;
    url.placeholder = 'https://stream.example.org/live.mp3';
    const urlLabel = labelled('set.url.label', url);
    body.append(urlLabel, tel('p', 'hint', 'set.url.hint'), tel('p', 'warn hidden in-bad', 'set.url.bad'));
    card._urlLabel = urlLabel;
  } else {
    const sel = el('select', 'in-device');
    fillDeviceSelect(sel, inp.deviceId, inp.deviceLabel);
    const refresh = tel('button', 'btn btn--small in-refresh', 'set.dev.refresh');
    refresh.type = 'button';
    const row = el('span', 'row');
    row.append(sel, refresh);
    const chan = el('select', 'in-chan');
    [0, 1, 2, 3].forEach((p) => {
      const o = new Option(t(`set.chan.p${p}`), String(p));
      o.dataset.i18n = `set.chan.p${p}`;
      chan.appendChild(o);
    });
    chan.value = String(inp.channelPair || 0);
    body.append(labelled('set.dev.label', row), tel('p', 'hint', 'set.dev.hint'), labelled('set.chan.label', chan), tel('p', 'hint', 'set.chan.hint'));
  }

  const range = el('input', 'in-thr-range');
  range.type = 'range';
  range.min = -90;
  range.max = -10;
  range.step = 1;
  range.value = inp.thresholdDb;
  range.setAttribute('aria-label', t('set.det.threshold'));
  const thr = numberInput('in-thr', -90, -10, inp.thresholdDb);
  const thrRow = el('div', 'row');
  thrRow.append(range, thr);
  const thrField = el('div', 'field');
  thrField.append(tel('span', '', 'set.det.threshold'), thrRow);

  const min = numberInput('in-min', 1, 3600, inp.minSilenceSec);
  const chips = el('span', 'chips');
  for (const [sec, label] of [[10, '10 s'], [30, '30 s'], [60, '60 s'], [300, '5 min']]) {
    const c = el('button', 'chip', label);
    c.type = 'button';
    c.dataset.sec = sec;
    chips.appendChild(c);
  }
  const minRow = el('div', 'row');
  minRow.append(min, chips);
  const minField = el('div', 'field');
  minField.append(tel('span', '', 'set.det.min'), minRow);
  const cols = el('div', 'cols');
  cols.append(thrField, minField);
  body.appendChild(cols);
  body.appendChild(buildAdvanced(inp));

  const remove = tel('button', 'btn btn--small btn--danger in-remove', 'set.in.remove');
  remove.type = 'button';
  const foot = el('div', 'input__foot');
  foot.appendChild(remove);
  body.appendChild(foot);
  card.append(summary, body);
  title.textContent = inputTitle(card);
  refreshCardLogo(card);
  if (card._urlLabel) syncUrlEye(card);
  return card;
}

// An address that carries "user:password@" starts masked and has an eye; one without credentials stays plain.
function syncUrlEye(card) {
  const url = card.querySelector('.in-url');
  const has = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(url.value);
  const first = !url.parentElement.classList.contains('pw');
  if (has && first) {
    addEye(url, { url: true });
    url.classList.add('is-masked');
  }
}

function updateInputsFooter() {
  markUsedDevices();
  const cards = $('inputsList').querySelectorAll('.input');
  $('addStream').disabled = cards.length >= MAX_INPUTS;
  $('addDevice').disabled = cards.length >= MAX_INPUTS;
  $('inputsMax').textContent = t('set.inputs.max', { n: MAX_INPUTS });
  $('inputsEmpty').classList.toggle('hidden', cards.length > 0);
  cards.forEach((c, i) => {
    c.querySelector('.in-up').disabled = i === 0;
    c.querySelector('.in-down').disabled = i === cards.length - 1;
  });
}

function renderInputsList() {
  const list = $('inputsList');
  list.replaceChildren();
  settings.inputs.forEach((inp) => list.appendChild(buildInputCard(inp, settings.inputs.length <= 2)));
  updateInputsFooter();
}

function addInput(type) {
  const base = { id: uuid(), name: '', type, deviceId: '', deviceLabel: '', channelPair: 0, streamUrl: '', thresholdDb: -50, minSilenceSec: 30, yellowDelaySec: 2, frozenSec: 0, frozenToleranceDb: 1, schedule: { enabled: false, rules: [] }, enabled: true };
  const card = buildInputCard(base, true);
  $('inputsList').appendChild(card);
  updateInputsFooter();
  setDirty(true);
  card.querySelector(type === 'stream' ? '.in-url' : '.in-name').focus();
}

function readInputs() {
  return [...$('inputsList').querySelectorAll('.input')].map((card) => {
    const type = card.dataset.type;
    const sel = card.querySelector('.in-device');
    const deviceId = sel ? sel.value : '';
    return {
      id: card.dataset.id,
      type,
      name: card.querySelector('.in-name').value.trim(),
      enabled: card.querySelector('.in-enabled').checked,
      streamUrl: type === 'stream' ? card.querySelector('.in-url').value.trim() : '',
      deviceId,
      deviceLabel: deviceId ? optionName(sel.selectedOptions[0]) : '',
      channelPair: type === 'device' ? Number(card.querySelector('.in-chan').value) || 0 : 0,
      thresholdDb: Number(card.querySelector('.in-thr').value),
      minSilenceSec: Number(card.querySelector('.in-min').value),
      yellowDelaySec: Number(card.querySelector('.in-yellow').value) || 0,
      frozenSec: card.querySelector('.in-frozen-on').checked ? Number(card.querySelector('.in-frozen-sec').value) || 60 : 0,
      frozenToleranceDb: Number(card.querySelector('.in-frozen-tol').value) || 1,
      schedule: readSchedule(card)
    };
  });
}

function onInputsEvent(e) {
  if (e.target.closest('#inputsList')) setTimeout(markUsedDevices, 0); // a device, a pair or a name changed: refresh the "already used" marks
  const card = e.target.closest?.('.input');
  if (!card) return;
  const tg = e.target;
  if (tg.classList.contains('in-url') && tg.classList.contains('is-invalid') && validUrl(tg.value.trim())) {
    markInvalid(tg, false);
    card.classList.remove('has-error');
    card.querySelector('.in-bad')?.classList.add('hidden');
  }
  if (tg.classList.contains('in-frozen-on')) card.querySelector('.adv__frozen').classList.toggle('hidden', !tg.checked);
  if (tg.classList.contains('in-sched-on')) card.querySelector('.sched__box').classList.toggle('hidden', !tg.checked);
  if (tg.classList.contains('rule-mode')) tg.closest('.rule').querySelector('.rule__custom').classList.toggle('hidden', tg.value !== 'custom');
  if (tg.classList.contains('in-thr-range')) card.querySelector('.in-thr').value = tg.value;
  if (tg.classList.contains('in-thr')) card.querySelector('.in-thr-range').value = clamp(Number(tg.value) || -50, -90, -10);
  card.querySelector('.input__title').textContent = inputTitle(card);
  if (tg.classList.contains('in-logo-file') && tg.files[0]) {
    const bad = card.querySelector('.in-logo-bad');
    logoFromFile(tg.files[0]).then(
      (data) => {
        card._logo = data;
        bad.classList.add('hidden');
        refreshCardLogo(card);
        setDirty(true);
      },
      () => bad.classList.remove('hidden')
    );
    tg.value = '';
  }
}

function onInputsClick(e) {
  const card = e.target.closest?.('.input');
  if (!card) return;
  const tg = e.target;
  const mv = tg.closest?.('.in-up, .in-down');
  if (mv) {
    e.preventDefault(); // a click inside the summary would open or close the card
    const list = $('inputsList');
    const ids = [...list.children].map((c) => c.dataset.id);
    const next = moveItem(ids, ids.indexOf(card.dataset.id), mv.classList.contains('in-up') ? -1 : 1);
    const byId = new Map([...list.children].map((c) => [c.dataset.id, c]));
    next.forEach((id) => list.appendChild(byId.get(id)));
    updateInputsFooter();
    setDirty(true);
    mv.focus();
    return;
  }
  if (tg.classList.contains('in-rule-add')) {
    const inp = readInputs().find((i) => i.id === card.dataset.id);
    card.querySelector('.rules').appendChild(buildRule({ days: [1, 2, 3, 4, 5], from: '00:00', to: '06:00', mode: 'off', thresholdDb: inp.thresholdDb, minSilenceSec: inp.minSilenceSec }));
    setDirty(true);
  } else if (tg.classList.contains('rule-remove')) {
    tg.closest('.rule').remove();
    setDirty(true);
  } else if (tg.classList.contains('in-remove')) {
    card.remove();
    updateInputsFooter();
    setDirty(true);
  } else if (tg.classList.contains('chip')) {
    card.querySelector('.in-min').value = tg.dataset.sec;
    setDirty(true);
  } else if (tg.classList.contains('in-logo-choose')) {
    card.querySelector('.in-logo-file').click();
  } else if (tg.classList.contains('in-logo-remove')) {
    card._logo = null;
    refreshCardLogo(card);
    setDirty(true);
  } else if (tg.classList.contains('in-refresh')) {
    loadDevices();
  }
}

function showTab(name) {
  activeTab = name;
  for (const b of document.querySelectorAll('.tab')) {
    const on = b.dataset.tab === name;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  for (const p of document.querySelectorAll('.tabpane')) p.classList.toggle('is-active', p.dataset.pane === name);
}

// ---- settings form: the rest -------------------------------------------------------------------------
function renderRecipients(list) {
  const box = $('tRecipients');
  box.replaceChildren();
  for (const r of list) addRecipientRow(r);
}

function addRecipientRow(r = { chatId: '', note: '' }) {
  const row = el('div', 'rec');
  const chat = el('input');
  chat.type = 'text';
  chat.value = r.chatId;
  chat.placeholder = t('set.tg.chat');
  chat.setAttribute('aria-label', t('set.tg.chat'));
  chat.spellcheck = false;
  const note = el('input');
  note.type = 'text';
  note.value = r.note || '';
  note.placeholder = t('set.tg.note');
  note.setAttribute('aria-label', t('set.tg.note'));
  const rm = tel('button', 'btn btn--small btn--ghost', 'set.tg.remove');
  rm.type = 'button';
  rm.addEventListener('click', () => {
    row.remove();
    setDirty(true);
  });
  row.append(chat, note, rm);
  $('tRecipients').appendChild(row);
}

function fillForm() {
  if (!settings) return;
  const s = settings;
  renderInputsList();
  $('nDesktop').checked = s.notifications.desktop;
  $('nReminder').value = s.notifications.reminderMin;
  $('nSound').checked = s.notifications.sound.enabled;
  $('nVol').value = Math.round(s.notifications.sound.volume * 100);
  $('hEnable').checked = s.heartbeat.enabled;
  $('hUrl').value = s.heartbeat.url;
  $('hMin').value = s.heartbeat.intervalMin;
  $('hBad').classList.add('hidden');
  const m = s.notifications.email;
  $('mEnable').checked = m.enabled;
  $('mHost').value = m.host;
  $('mPort').value = m.port;
  $('mSecure').checked = m.secure;
  $('mUser').value = m.user;
  $('mPass').value = m.pass;
  $('mFrom').value = m.from;
  $('mTo').value = m.recipients.join(', ');
  $('mToBad').classList.add('hidden');
  $('uAlert').checked = s.notifications.updateAlert;
  const tg = s.notifications.telegram;
  $('tEnable').checked = tg.enabled;
  $('tToken').value = tg.botToken;
  const wh = s.notifications.webhook;
  $('wEnable').checked = wh.enabled;
  $('wUrl').value = wh.url;
  $('wMethod').value = wh.method;
  $('wAuth').value = wh.authHeader;
  $('wBad').classList.add('hidden');
  renderRecipients(tg.recipients);
  $('gBoot').checked = s.general.startOnBoot;
  $('gMin').checked = s.general.startMinimized;
  $('gAuto').checked = s.general.autoStartMonitoring;
  $('gAwake').checked = s.general.keepAwake;
  $('gUpd').checked = s.general.checkUpdates;
  $('gRet').value = s.general.retentionDays;
  $('gMicro').value = s.general.microRetentionDays;
  $('gInst').value = s.installationName;
  $('gInst').placeholder = info.host || '';
  fillTemplates(s.notifications.templates);
  $('grEnable').checked = s.notifications.grouping.enabled;
  $('grWindow').value = s.notifications.grouping.windowSec;
  $('grFirst').checked = s.notifications.grouping.firstNow;
  $('dGlow').value = s.display.edgeGlow;
  $('dWall').checked = s.display.startInWall;
  $('dName').value = s.display.wallNameSize;
  $('dLogo').value = s.display.wallLogo;
  $('dLogoOp').value = Math.round(s.display.wallLogoOpacity * 100);
  $('dClock').value = s.display.wallClock;
  syncDisplayFields();
  resetEyes();
  setDirty(false);
}

// ---- wording of the alerts (Settings → Alerts) ---------------------------------------------------------
let tplDraft = {}; // { kind: { subject, body } } as edited, saved with the form
const tplIsGroup = (k) => k.startsWith('group');
function fillTemplates(templates) {
  tplDraft = {};
  for (const k of TEMPLATE_KINDS) tplDraft[k] = { subject: templates?.[k]?.subject || '', body: templates?.[k]?.body || '' };
  const sel = $('tplKind');
  const keep = sel.value || TEMPLATE_KINDS[0];
  sel.replaceChildren(...TEMPLATE_KINDS.map((k) => new Option(t(`set.tpl.kind.${k}`), k)));
  sel.value = keep;
  showTemplate();
}
function showTemplate() {
  const k = $('tplKind').value;
  $('tplSubject').value = tplDraft[k].subject;
  $('tplBody').value = tplDraft[k].body;
  const vars = (tplIsGroup(k) ? TEMPLATE_VARS.group : TEMPLATE_VARS.single).map((v) => `{${v}}`).join('  ');
  $('tplVars').textContent = `${t('set.tpl.vars')} ${vars}`;
}
function editTemplate() {
  const k = $('tplKind').value;
  tplDraft[k] = { subject: $('tplSubject').value, body: $('tplBody').value };
}

const syncDisplayFields = () => $('dLogoOpField').classList.toggle('hidden', $('dLogo').value !== 'faded');

function readForm() {
  const recipients = [...$('tRecipients').querySelectorAll('.rec')].map((row) => {
    const [chat, note] = row.querySelectorAll('input');
    return { chatId: chat.value.trim(), note: note.value.trim() };
  });
  return {
    inputs: readInputs(),
    notifications: {
      desktop: $('nDesktop').checked,
      reminderMin: Number($('nReminder').value) || 0,
      sound: { enabled: $('nSound').checked, volume: (Number($('nVol').value) || 60) / 100 },
      email: { enabled: $('mEnable').checked, host: $('mHost').value.trim(), port: Number($('mPort').value) || 587, secure: $('mSecure').checked, user: $('mUser').value.trim(), pass: $('mPass').value, from: $('mFrom').value.trim(), recipients: parseAddresses($('mTo').value).valid },
      telegram: { enabled: $('tEnable').checked, botToken: $('tToken').value.trim(), recipients },
      webhook: { enabled: $('wEnable').checked, url: $('wUrl').value.trim(), method: $('wMethod').value, authHeader: $('wAuth').value.trim() },
      updateAlert: $('uAlert').checked,
      templates: tplDraft,
      grouping: { enabled: $('grEnable').checked, windowSec: Number($('grWindow').value) || 60, firstNow: $('grFirst').checked }
    },
    installationName: $('gInst').value.trim(),
    heartbeat: { enabled: $('hEnable').checked, url: $('hUrl').value.trim(), intervalMin: Number($('hMin').value) || 5 },
    display: { edgeGlow: $('dGlow').value, startInWall: $('dWall').checked, wallNameSize: $('dName').value, wallLogo: $('dLogo').value, wallLogoOpacity: (Number($('dLogoOp').value) || 20) / 100, wallClock: $('dClock').value },
    general: { startOnBoot: $('gBoot').checked, startMinimized: $('gMin').checked, autoStartMonitoring: $('gAuto').checked, keepAwake: $('gAwake').checked, checkUpdates: $('gUpd').checked, retentionDays: Number($('gRet').value) || 365, microRetentionDays: Number($('gMicro').value) || 30 }
  };
}

// Shows the recipients as they will be used and says which typed addresses were left out.
function normaliseRecipients() {
  const { valid, dropped } = parseAddresses($('mTo').value);
  $('mTo').value = valid.join(', ');
  const bad = $('mToBad');
  bad.textContent = dropped.length ? t('set.mail.dropped', { list: dropped.join(', ') }) : '';
  bad.classList.toggle('hidden', !dropped.length);
}

// Red field + aria-invalid on a field that failed the check (cleared as soon as the text is valid again).
function markInvalid(field, on) {
  if (!field) return;
  field.classList.toggle('is-invalid', on);
  if (on) field.setAttribute('aria-invalid', 'true');
  else field.removeAttribute('aria-invalid');
}

async function saveForm(e) {
  e?.preventDefault();
  normaliseRecipients();
  const patch = readForm();
  let bad = false;
  for (const card of $('inputsList').querySelectorAll('.input')) {
    const inp = patch.inputs.find((i) => i.id === card.dataset.id);
    const invalid = inp.type === 'stream' && inp.enabled && !validUrl(inp.streamUrl);
    card.querySelector('.in-bad')?.classList.toggle('hidden', !invalid);
    markInvalid(card.querySelector('.in-url'), invalid); // the field itself turns red, not only the text under it
    card.classList.toggle('has-error', invalid);
    if (invalid) {
      card.open = true;
      bad = true;
    }
  }
  const hbBad = patch.heartbeat.enabled && !validUrl(patch.heartbeat.url);
  $('hBad').classList.toggle('hidden', !hbBad);
  markInvalid($('hUrl'), hbBad);
  const whBad = patch.notifications.webhook.enabled && !validUrl(patch.notifications.webhook.url);
  $('wBad').classList.toggle('hidden', !whBad);
  markInvalid($('wUrl'), whBad);
  if (bad || hbBad || whBad) {
    const st = $('saveState');
    st.textContent = t('set.notSaved');
    st.classList.add('is-dirty');
    const first = bad ? $('inputsList').querySelector('.in-url.is-invalid') : hbBad ? $('hUrl') : $('wUrl');
    first?.scrollIntoView({ block: 'center' });
    first?.focus({ preventScroll: true });
    return;
  }
  if (patch.inputs.some((i) => i.type === 'device' && i.enabled) && !settings.micExplained) {
    if (!(await askMic())) return;
    patch.micExplained = true;
  }
  for (const card of $('inputsList').querySelectorAll('.input')) {
    if (card._logo === undefined) continue;
    const r = card._logo ? await api.logos.set(card.dataset.id, card._logo) : await api.logos.remove(card.dataset.id);
    if (!r.ok) {
      card.open = true;
      card.querySelector('.in-logo-bad').classList.remove('hidden');
      return;
    }
  }
  logos = await api.logos.all();
  settings = await api.settings.update(patch);
  fillForm();
  startError = null;
  applyDisplay();
  renderAll();
  $('saveState').textContent = t('set.saved');
  setTimeout(() => {
    if (!dirty) $('saveState').textContent = '';
  }, 2500);
}

async function loadDevices() {
  if (!settings.micExplained && !(await askMic())) return;
  if (!settings.micExplained) settings = await api.settings.update({ micExplained: true });
  try {
    const r = await api.audio.devices();
    devices = r.devices;
    devicesDenied = !r.granted;
  } catch {
    devices = [];
    devicesDenied = true;
  }
  for (const sel of $('inputsList').querySelectorAll('.in-device')) {
    const label = optionName(sel.selectedOptions[0]);
    fillDeviceSelect(sel, sel.value, label);
  }
  $('devDenied').classList.toggle('hidden', !devicesDenied);
  renderStatus();
}

function askMic() {
  return new Promise((resolve) => {
    const dlg = $('micDlg');
    const done = (ok) => {
      dlg.close();
      $('micOk').removeEventListener('click', yes);
      $('micCancel').removeEventListener('click', no);
      dlg.removeEventListener('cancel', no);
      resolve(ok);
    };
    const yes = () => done(true);
    const no = () => done(false);
    $('micOk').addEventListener('click', yes);
    $('micCancel').addEventListener('click', no);
    dlg.addEventListener('cancel', no);
    dlg.showModal();
  });
}

async function testChannel(channel) {
  if (channel === 'email') normaliseRecipients();
  const form = readForm();
  const out = $({ email: 'mRes', telegram: 'tRes', webhook: 'wRes' }[channel]);
  out.className = 'testres';
  out.textContent = t('set.test.sending');
  const cfg = form.notifications[channel];
  if (channel === 'webhook' && !validUrl(cfg.url)) {
    $('wBad').classList.remove('hidden');
    out.textContent = '';
    return;
  }
  $('wBad').classList.add('hidden');
  const r = await api.notifications.test(channel, cfg);
  // The test uses what is on the screen; alerts use what is saved and only when the channel is switched on.
  const notes = [];
  if (r.ok && dirty) notes.push(t('set.test.unsaved'));
  if (r.ok && !cfg.enabled) notes.push(t('set.test.off'));
  out.textContent = r.ok ? [t('set.test.ok'), ...notes].join(' ') : t('set.test.fail', { error: r.error });
  out.classList.add(r.ok ? (notes.length ? 'is-warn' : 'is-ok') : 'is-fail');
}

// ---- alerts that could not be delivered ------------------------------------------------------------
function renderDelivery(list) {
  const box = $('deliveryWarn');
  const items = Array.isArray(list) ? list : [];
  box.textContent = items.map((f) => t(f.giveUp ? 'warn.delivery.giveup' : 'warn.delivery', { channel: t(`ch.${f.channel}`), error: f.error || '?' })).join(' · ');
  box.classList.toggle('hidden', !items.length);
}

// ---- configuration backup ----------------------------------------------------------------------------
function showBackupResult(text, ok) {
  const out = $('bkRes');
  out.className = 'testres ' + (ok ? 'is-ok' : 'is-fail');
  out.textContent = text;
}

function renderMissing(list) {
  const box = $('bkMissing');
  box.replaceChildren();
  box.classList.toggle('hidden', !list?.length);
  if (!list?.length) return;
  box.className = 'missing';
  const label = (m) => (m.kind === 'input' ? t('bk.missing.input', { name: m.name || '?' }) : t(`bk.missing.${m.kind.split('.')[0]}`));
  const ul = el('ul');
  for (const m of list) ul.appendChild(el('li', '', label(m)));
  box.append(el('strong', '', t('bk.missingTitle')), ul);
}

function askImportMode() {
  return new Promise((resolve) => {
    const dlg = $('bkDlg');
    const done = (v) => {
      dlg.close();
      $('bkDlgYes').removeEventListener('click', yes);
      $('bkDlgNo').removeEventListener('click', no);
      dlg.removeEventListener('cancel', no);
      resolve(v);
    };
    const yes = () => done(dlg.querySelector('input[name="bkMode"]:checked')?.value || 'replace');
    const no = () => done(null);
    $('bkDlgYes').addEventListener('click', yes);
    $('bkDlgNo').addEventListener('click', no);
    dlg.addEventListener('cancel', no);
    dlg.showModal();
  });
}

async function exportBackup() {
  renderMissing([]);
  if (dirty) return showBackupResult(t('bk.saveFirst'), false);
  const r = await api.backup.export($('bkSecrets').checked);
  if (r.canceled) return showBackupResult('', true);
  showBackupResult(r.ok ? t('bk.exported', { file: r.file }) : t('bk.failed', { error: r.error }), r.ok);
}

async function importBackup() {
  renderMissing([]);
  if (dirty) return showBackupResult(t('bk.saveFirst'), false);
  const mode = await askImportMode();
  if (!mode) return;
  const r = await api.backup.import(mode);
  if (r.canceled) return showBackupResult('', true);
  if (!r.ok) return showBackupResult(r.error in { invalid: 1, 'wrong-app': 1, 'too-big': 1 } ? t(`bk.err.${r.error}`) : t('bk.failed', { error: r.error }), false);
  settings = await api.settings.get();
  fillForm();
  renderAll();
  showBackupResult(t('bk.imported') + (r.added != null ? ' ' + t('bk.importedAdd', { n: r.added }) : ''), true);
  renderMissing(r.missing);
}

// ---- guided update: banner + Settings → Updates (apps/COMMON-FEATURES.md, section 4) ---------------------------------
const mb = (n) => (n / 1048576).toFixed(1);

function btn(key, cls, onClick, icon) {
  const b = el('button', `btn btn--small ${cls || ''}`.trim());
  b.type = 'button';
  if (icon) b.append(el('span', `ico ico--${icon}`));
  b.append(el('span', '', t(key)));
  b.addEventListener('click', onClick);
  return b;
}

// what the window is doing now: idle | downloading | ready | error | installing (the main process knows the rest)
function updPhase() {
  const v = upd.view;
  if (upd.phase === 'idle' && v?.downloaded && v.info?.available) return 'ready';
  return upd.phase;
}

function updateButtons(into, phase, v) {
  into.replaceChildren();
  const notes = btn('upd.notes', 'btn--ghost', () => api.updates.openPage());
  if (phase === 'downloading') into.append(btn('upd.cancel', '', () => api.updates.cancel()));
  else if (phase === 'ready') into.append(btn('upd.install', 'btn--primary', () => installNow(false)), notes);
  else if (phase === 'error') into.append(btn('upd.tryAgain', 'btn--primary', startDownload), notes);
  else if (phase === 'installing') return;
  else if (v?.info?.available) {
    if (v.info.canDownload) into.append(btn('upd.dlInstall', 'btn--primary', startDownload, 'download'));
    into.append(btn('upd.later', '', remindLater), btn('upd.skip', '', skipVersion), notes);
  }
}

function renderUpdateUi() {
  const v = upd.view;
  const u = v?.info;
  const phase = updPhase();
  const available = !!(u?.ok && u.available);
  const visible = phase !== 'idle' ? true : available && (v.banner === 'show' || upd.forceShow);
  const bar = $('updateBanner');
  bar.classList.toggle('hidden', !visible);
  if (visible) {
    let title = '';
    if (phase === 'ready') title = t('upd.ready', { v: u.latest });
    else if (phase === 'error') title = t('upd.error', { error: upd.error });
    else if (phase === 'installing') title = t(`upd.after.${upd.after}`);
    else title = t('upd.availFull', { v: u.latest, cur: u.current });
    $('updTitle').textContent = title;
    $('updNotes').textContent = phase === 'idle' ? [u.notes, u.installer ? '' : t('upd.nomatch')].filter(Boolean).join('\n') : '';
    const prog = $('updProgress');
    prog.classList.toggle('hidden', phase !== 'downloading');
    if (phase === 'downloading') paintProgress();
    updateButtons($('updBtns'), phase, v);
  }
  // Settings → Updates
  $('updCurrent').textContent = t('upd.current', { v: info.version });
  const lc = v?.lastCheck;
  $('updLast').textContent = lc ? t('upd.lastCheck', { when: formatDateTime(lc.at, lang), result: lc.ok ? t('upd.resultOk') : t('upd.resultFail', { error: lc.error }) }) : t('upd.never');
  const res = $('updRes');
  res.className = 'testres';
  if (upd.checking) res.textContent = t('upd.checking');
  else if (upd.message) res.textContent = upd.message;
  else if (u && !u.ok) {
    res.textContent = t('upd.fail', { error: u.error });
    res.classList.add('is-fail');
  } else if (available && !visible) {
    res.textContent = t(v.banner === 'skipped' ? 'upd.hidden.skipped' : 'upd.hidden.snoozed', { v: u.latest });
    res.classList.add('is-warn');
  } else if (available) res.textContent = t('upd.availFull', { v: u.latest, cur: u.current });
  else if (u?.ok) res.textContent = t('upd.none');
  else res.textContent = '';
  const cardBtns = $('updCardBtns');
  updateButtons(cardBtns, phase === 'idle' && available && !visible ? 'idle' : phase === 'idle' ? 'none' : phase, v);
  if (phase === 'idle' && available && !visible) cardBtns.prepend(btn('upd.show', '', () => { upd.forceShow = true; renderUpdateUi(); }));
  $('updCheck').disabled = !!upd.checking || phase === 'downloading';
}

function paintProgress() {
  const { got, total } = upd;
  const pct = total ? Math.min(100, Math.round((got / total) * 100)) : 0;
  $('updFill').style.width = `${total ? pct : 8}%`;
  $('updPct').textContent = total ? t('upd.progress', { pct, got: mb(got), total: mb(total) }) : t('upd.progressNoTotal', { got: mb(got) });
}

async function checkUpdates() {
  upd.checking = true;
  upd.message = '';
  renderUpdateUi();
  try {
    upd.view = await api.updates.check();
    upd.forceShow = !!upd.view.info?.available;
  } finally {
    upd.checking = false;
  }
  renderUpdateUi();
  return upd.view;
}

async function startDownload() {
  upd.phase = 'downloading';
  upd.got = upd.total = 0;
  upd.message = '';
  renderUpdateUi();
  const r = await api.updates.download();
  upd.view = await api.updates.state();
  if (r.ok) upd.phase = 'ready';
  else if (r.error === 'cancelled') {
    upd.phase = 'idle';
    upd.message = t('upd.cancelled');
  } else {
    upd.phase = 'error';
    upd.error = r.error;
  }
  renderUpdateUi();
}

async function installNow(confirmed) {
  const r = await api.updates.install(confirmed);
  if (!r.ok && r.error === 'confirm') {
    if (await askInstall()) installNow(true);
    return;
  }
  if (!r.ok) {
    upd.phase = 'error';
    upd.error = r.error;
  } else {
    upd.phase = 'installing';
    upd.after = r.kind;
  }
  renderUpdateUi();
}

function askInstall() {
  return new Promise((resolve) => {
    const dlg = $('updDlg');
    const done = (v) => {
      dlg.close();
      $('updDlgYes').removeEventListener('click', yes);
      $('updDlgNo').removeEventListener('click', no);
      dlg.removeEventListener('cancel', no);
      resolve(v);
    };
    const yes = () => done(true);
    const no = () => done(false);
    $('updDlgYes').addEventListener('click', yes);
    $('updDlgNo').addEventListener('click', no);
    dlg.addEventListener('cancel', no);
    dlg.showModal();
  });
}

async function remindLater() {
  upd.view = await api.updates.remind();
  upd.forceShow = false;
  renderUpdateUi();
}

async function skipVersion() {
  upd.view = await api.updates.skip();
  upd.forceShow = false;
  renderUpdateUi();
}

// "What's new" after an update: the bullets of this version from the bundled CHANGELOG, shown once
function inline(text) {
  const out = document.createDocumentFragment();
  for (const part of String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (!part) continue;
    if (part.startsWith('**')) out.append(el('strong', '', part.slice(2, -2)));
    else if (part.startsWith('`')) out.append(el('code', '', part.slice(1, -1)));
    else out.append(part);
  }
  return out;
}

async function showWhatsNew() {
  const nw = await api.updates.whatsNew();
  if (!nw) return;
  $('newDlgTitle').textContent = t('whatsnew.title', { v: nw.version });
  const list = $('newDlgList');
  list.replaceChildren();
  if (!nw.bullets.length) list.appendChild(el('li', '', t('whatsnew.none')));
  for (const b of nw.bullets) {
    const li = el('li');
    li.appendChild(inline(b));
    list.appendChild(li);
  }
  $('newDlgClose').onclick = async () => {
    $('newDlg').close();
    await api.updates.whatsNewSeen();
  };
  $('newDlg').addEventListener('cancel', () => api.updates.whatsNewSeen(), { once: true });
  $('newDlg').showModal();
}

// Help & about: support
async function copySupport() {
  const out = $('helpRes');
  out.className = 'testres';
  try {
    const text = await api.app.supportInfo();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    out.textContent = t('help.copied');
    out.classList.add('is-ok');
  } catch (err) {
    out.textContent = String(err.message || err);
    out.classList.add('is-fail');
  }
}

// ---- navigation and wiring -----------------------------------------------------------------------------
function showView(name) {
  for (const v of ['dashboard', 'log', 'settings', 'help']) $(`view-${v}`).classList.toggle('hidden', v !== name);
  for (const b of document.querySelectorAll('.nav__item')) b.classList.toggle('is-active', b.dataset.view === name);
  if (name === 'dashboard') refreshStats();
  if (name === 'log') refreshEvents();
  if (name === 'settings') {
    if (!dirty) fillForm();
    showTab(activeTab);
    resetEyes();
  }
  closePauseMenu();
  document.querySelector('.main').scrollTo(0, 0);
}

function renderAll() {
  applyI18n();
  buildLangSelect();
  $('themeSel').value = settings.theme;
  chartInput = fillInputSelect($('chartInput'), chartInput);
  logInput = fillInputSelect($('logInput'), logInput);
  renderStatus();
  renderChart();
  renderKpis();
  renderRecent();
  renderLog();
  renderUpdateUi();
  updateInputsFooter();
  applyDisplay();
  if (!dirty) fillForm();
  showTab(activeTab);
}

function buildLangSelect() {
  const sel = $('langSel');
  sel.replaceChildren();
  for (const [code, name] of Object.entries(LANGS)) sel.appendChild(new Option(name, code));
  sel.value = lang;
}

async function onStartClick() {
  startError = null;
  if (status.running) {
    await api.monitor.stop();
    return;
  }
  const needsMic = settings.inputs.some((i) => i.enabled && i.type === 'device');
  if (needsMic && !settings.micExplained) {
    if (!(await askMic())) return;
    settings = await api.settings.update({ micExplained: true });
  }
  if (!settings.inputs.some((i) => i.enabled)) {
    showView('settings');
    return;
  }
  const r = await api.monitor.start();
  if (!r.ok) {
    startError = r.reason === 'mic-denied' ? t('mic.denied') : t('start.noInput');
    renderStatus();
  }
}

function wire() {
  for (const b of document.querySelectorAll('.nav__item')) b.addEventListener('click', () => showView(b.dataset.view));
  $('startBtn').addEventListener('click', onStartClick);
  $('wallBtn').addEventListener('click', () => setWall(true));
  $('wallExit').addEventListener('click', () => setWall(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openMenu) closePauseMenu();
    else if (e.key === 'Escape' && wall) setWall(false);
  });
  document.addEventListener('mousemove', wakeCursor);
  $('setupBtn').addEventListener('click', () => showView('settings'));
  $('allLogBtn').addEventListener('click', () => showView('log'));
  for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => showTab(b.dataset.tab));
  document.addEventListener('click', (e) => {
    if (openMenu && !openMenu.contains(e.target)) closePauseMenu();
  });
  window.addEventListener('blur', closePauseMenu);
  addEye($('mPass'));
  addEye($('tToken'));
  $('dLogo').addEventListener('change', syncDisplayFields);
  for (const b of document.querySelectorAll('[data-days]')) {
    b.addEventListener('click', () => {
      chartDays = Number(b.dataset.days);
      for (const x of document.querySelectorAll('[data-days]')) x.classList.toggle('is-active', x === b);
      refreshStats();
    });
  }
  $('chartInput').addEventListener('change', (e) => {
    chartInput = e.target.value;
    refreshStats();
    renderRecent();
  });
  $('logInput').addEventListener('change', (e) => {
    logInput = e.target.value;
    renderLog();
  });
  for (const b of document.querySelectorAll('[data-filter]')) {
    b.addEventListener('click', () => {
      logFilter = b.dataset.filter;
      for (const x of document.querySelectorAll('[data-filter]')) x.classList.toggle('is-active', x === b);
      renderLog();
    });
  }
  $('exportCsv').addEventListener('click', () => doExport('csv'));
  $('reportPeriod').addEventListener('change', (e) => {
    reportPeriod = e.target.value;
    refreshReport();
  });
  $('reportCsv').addEventListener('click', doExportReport);
  $('exportJson').addEventListener('click', () => doExport('json'));
  $('clearLog').addEventListener('click', () => $('confirmDlg').showModal());
  $('confirmNo').addEventListener('click', () => $('confirmDlg').close());
  $('confirmYes').addEventListener('click', async () => {
    $('confirmDlg').close();
    await api.events.clear();
  });

  $('langSel').addEventListener('change', async (e) => {
    lang = e.target.value;
    t = makeT(lang);
    settings = await api.settings.update({ language: lang });
    renderAll();
  });
  $('themeSel').addEventListener('change', async (e) => {
    settings = await api.settings.update({ theme: e.target.value });
    applyTheme();
  });

  const form = $('settingsForm');
  form.addEventListener('submit', saveForm);
  form.addEventListener('input', (e) => {
    if (e.target.closest('#bkCard')) return; // the backup box is not a setting
    if (e.target.id === 'tplSubject' || e.target.id === 'tplBody') editTemplate();
    onInputsEvent(e);
    setDirty(true);
  });
  form.addEventListener('change', (e) => {
    if (e.target.closest('#bkCard')) return;
    if (e.target.id === 'tplKind') return showTemplate(); // choosing which message to edit is not a change of the settings
    onInputsEvent(e);
    setDirty(true);
  });
  $('tplDefault').addEventListener('click', () => {
    $('tplSubject').value = '';
    $('tplBody').value = '';
    editTemplate();
    setDirty(true);
  });
  $('mTo').addEventListener('change', normaliseRecipients);
  $('hUrl').addEventListener('input', () => {
    if ($('hUrl').classList.contains('is-invalid') && validUrl($('hUrl').value.trim())) {
      markInvalid($('hUrl'), false);
      $('hBad').classList.add('hidden');
    }
  });
  $('inputsList').addEventListener('click', onInputsClick);
  $('addStream').addEventListener('click', () => addInput('stream'));
  $('addDevice').addEventListener('click', () => {
    addInput('device');
    if (settings.micExplained) loadDevices();
  });
  $('revertBtn').addEventListener('click', () => fillForm());
  $('micWhy').addEventListener('click', () => askMic());
  $('tAdd').addEventListener('click', () => {
    addRecipientRow();
    setDirty(true);
  });
  $('sndTest').addEventListener('click', () => api.audio.testSound((Number($('nVol').value) || 60) / 100));
  $('muteBtn').addEventListener('click', () => api.monitor.muteAlarm());
  $('hTest').addEventListener('click', async () => {
    const out = $('hRes');
    out.className = 'testres';
    const url = $('hUrl').value.trim();
    if (!validUrl(url)) {
      $('hBad').classList.remove('hidden');
      return;
    }
    $('hBad').classList.add('hidden');
    out.textContent = t('set.test.sending');
    const r = await api.heartbeat.test(url);
    out.textContent = r.ok ? t('set.hb.ok') : t('set.hb.fail', { error: r.error });
    out.classList.add(r.ok ? 'is-ok' : 'is-fail');
  });
  $('bkSecrets').addEventListener('change', () => $('bkWarn').classList.toggle('hidden', !$('bkSecrets').checked));
  $('bkExport').addEventListener('click', exportBackup);
  $('bkImport').addEventListener('click', importBackup);
  $('mTest').addEventListener('click', () => testChannel('email'));
  $('tTest').addEventListener('click', () => testChannel('telegram'));
  $('wTest').addEventListener('click', () => testChannel('webhook'));

  $('updCheck').addEventListener('click', checkUpdates);
  $('helpCopy').addEventListener('click', copySupport);
  $('helpLogs').addEventListener('click', () => api.app.openLogs());
  $('helpCheck').addEventListener('click', async () => {
    const out = $('helpRes');
    out.className = 'testres';
    out.textContent = t('upd.checking');
    const v = await checkUpdates();
    const i = v.info;
    out.textContent = !i?.ok ? t('upd.fail', { error: i?.error || '?' }) : i.available ? t('upd.availFull', { v: i.latest, cur: i.current }) : t('upd.none');
    out.classList.add(i?.ok ? 'is-ok' : 'is-fail');
  });
  for (const b of document.querySelectorAll('[data-ext]')) b.addEventListener('click', () => api.app.openExternal(b.dataset.ext));
  // The jar is a second link to the same page; keyboard and screen readers keep the button.
  for (const id of ['tipBtn', 'tipJar']) $(id).addEventListener('click', () => api.app.openExternal(tipUrl(lang)));

  api.on.status((st) => {
    status = st;
    renderStatus();
  });
  api.on.levels(onLevels);
  api.on.wallExit(() => setWall(false, false));
  trackTopbarHeight();
  api.on.eventsChanged(() => {
    refreshEvents();
    refreshStats();
  });
  api.on.settingsChanged((s) => {
    settings = s;
    chartInput = fillInputSelect($('chartInput'), chartInput);
    logInput = fillInputSelect($('logInput'), logInput);
    if (!dirty) fillForm();
  });
  api.on.updateAvailable((view) => {
    upd.view = view;
    renderUpdateUi();
  });
  api.on.delivery(renderDelivery);
  window.addEventListener('resize', () => requestAnimationFrame(() => { fitWallGrid(); fitWallNames(); }));
  api.on.updateProgress(({ got, total }) => {
    if (upd.phase !== 'downloading') return;
    upd.got = got;
    upd.total = total;
    paintProgress();
  });
}

async function init() {
  [settings, info, status, logos, upd.view] = await Promise.all([api.settings.get(), api.app.info(), api.monitor.status(), api.logos.all(), api.updates.state()]);
  lang = settings.language;
  t = makeT(lang);
  $('ver').textContent = `v${info.version}`;
  applyTheme();
  wire();
  renderAll();
  await Promise.all([refreshEvents(), refreshStats()]);
  renderDelivery(await api.delivery.get());
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(() => {
    if (!$('view-log').classList.contains('hidden')) renderLog(); // ongoing durations
  }, 1000);
  if (settings.display.startInWall) setWall(true);
  showWhatsNew();
}

init();
