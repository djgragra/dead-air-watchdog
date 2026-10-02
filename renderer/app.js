// Dead Air Watchdog — window logic. The window never touches audio or secrets directly:
// it talks to the main process through window.api (see preload.cjs).
// © 2026 Graziano Melzi · OnAir Garage — MIT License
import { LANGS, makeT } from './i18n.js';
import { formatDuration, formatDateTime, formatDb, localeFor } from '../src/core/format.js';

const api = window.api;
const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';

const METER_MIN = -80;
const METER_MAX = 0;
const MAX_INPUTS = 32;
const FAULTS = ['device-ended', 'stream-error', 'stream-ended', 'stream-stalled', 'NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'ChannelsUnavailable'];

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
let updateState = null;
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
  $('clockTime').textContent = $('wallClock').textContent = time;
  $('clockDate').textContent = $('wallDate').textContent = date;
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
  let sub = '';
  if (overall === 'idle') sub = t('st.sub.idle');
  else if (overall === 'starting') sub = t('st.sub.starting');
  else if (overall === 'ok') sub = t('overall.sub.ok', { n: status.counts.ok || 0 });
  else if (overall === 'counting') sub = t('overall.sub.counting', { names: namesOf('counting') });
  else if (overall === 'alarm') sub = t('overall.sub.alarm', { names: namesOf('alarm') });
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

function tileFor(input) {
  let tile = tiles.get(input.id);
  if (tile) return tile;
  const root = el('article', 'tile');
  const head = el('div', 'tile__head');
  const name = el('div', 'tile__name');
  const type = el('span', 'tile__type');
  const logo = el('img', 'tile__logo hidden');
  logo.alt = '';
  head.append(el('span', 'tile__dot'), logo, name, type);
  const state = el('div', 'tile__state');
  const sub = el('div', 'tile__sub');
  const fault = el('div', 'tile__fault');
  root.append(head, state, sub, fault);
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
    root.appendChild(row);
    return { ch, fill, peak, thr, num, hold: { db: -120, at: 0 } };
  });
  tile = { root, logo, name, type, state, sub, fault, rows };
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
    tile.name.textContent = inp.name;
    const logoSrc = logos[inp.id] || '';
    if (tile.logoSrc !== logoSrc) {
      tile.logoSrc = logoSrc;
      if (logoSrc) tile.logo.src = logoSrc;
      else tile.logo.removeAttribute('src');
      tile.logo.classList.toggle('hidden', !logoSrc);
    }
    tile.type.textContent = t(inp.type === 'device' ? 'tile.device' : 'tile.stream');
    tile.state.textContent = t(`st.${inp.state}`);
    let sub = '';
    if (inp.state === 'counting') sub = t('st.sub.counting', { elapsed: formatDuration(inp.elapsedMs), remaining: formatDuration(inp.remainingMs) });
    else if (inp.state === 'alarm') sub = t('st.sub.alarm', { cause: t(`cause.${inp.cause || 'silence'}`), since: new Date(inp.silenceStart).toLocaleTimeString(localeFor(lang), { hour12: false }), elapsed: formatDuration(inp.elapsedMs) });
    else if (inp.state === 'ok') sub = t('meter.threshold', { db: inp.thresholdDb });
    tile.sub.textContent = sub;
    tile.fault.textContent = inp.fault ? t('st.fault', { reason: faultText(inp.fault) }) : '';
    const pair = inp.type === 'device' ? inp.channelPair || 0 : 0;
    tile.rows[0].ch.textContent = pair ? String(pair * 2 + 1) : t('meter.ch1');
    tile.rows[1].ch.textContent = pair ? String(pair * 2 + 2) : t('meter.ch2');
    for (const r of tile.rows) r.thr.style.left = `${pctOf(inp.thresholdDb)}%`;
    if (!['ok', 'counting', 'alarm', 'starting'].includes(inp.state)) resetTileMeter(tile);
  });
}

function onLevels(batch) {
  if (!status.running) return;
  const now = performance.now();
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
function typeBadge(e) {
  return el('span', `badge ${e.kind === 'gap' ? 'badge--gap' : 'badge--dead'}`, t(`cause.${e.cause}`));
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

function renderLog() {
  const box = $('logTable');
  box.replaceChildren();
  const rows = events.filter((e) => (logFilter === 'all' || e.kind === logFilter) && (!logInput || e.inputId === logInput));
  if (!rows.length) {
    box.appendChild(el('p', 'empty-msg', t('log.none')));
    return;
  }
  const table = el('table');
  const head = el('tr');
  for (const k of ['start', 'end', 'dur', 'type', 'input', 'note']) head.appendChild(el('th', '', t(`log.col.${k}`)));
  const thead = el('thead');
  thead.appendChild(head);
  table.appendChild(thead);
  const body = el('tbody');
  for (const e of rows) {
    const tr = el('tr', e.kind === 'gap' ? 'is-gap' : '');
    tr.appendChild(el('td', '', formatDateTime(e.start, lang)));
    tr.appendChild(el('td', '', e.end ? formatDateTime(e.end, lang) : t('log.ongoing')));
    tr.appendChild(el('td', 'mono', e.end ? formatDuration(e.end - e.start) : formatDuration(Date.now() - e.start) + ' …'));
    const c = el('td');
    c.appendChild(typeBadge(e));
    tr.appendChild(c);
    tr.appendChild(el('td', '', e.input || ''));
    tr.appendChild(el('td', '', [e.kind === 'gap' ? t('log.gapNote') : '', e.interrupted ? t('log.interrupted') : ''].filter(Boolean).join(' · ')));
    body.appendChild(tr);
  }
  table.appendChild(body);
  box.appendChild(table);
}

async function refreshEvents() {
  events = await api.events.list();
  renderRecent();
  renderLog();
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

function fillDeviceSelect(sel, selectedId, selectedLabel) {
  sel.replaceChildren(new Option(t('set.dev.default'), ''));
  for (const d of devices) {
    // "default" and "communications" are virtual entries some systems add for the same device
    if (d.deviceId === 'default' || d.deviceId === 'communications') continue;
    sel.appendChild(new Option(d.label || d.deviceId.slice(0, 8), d.deviceId));
  }
  if (selectedId && ![...sel.options].some((o) => o.value === selectedId)) sel.appendChild(new Option(selectedLabel || selectedId.slice(0, 8), selectedId));
  sel.value = selectedId || '';
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
  return sel.value ? sel.selectedOptions[0]?.textContent || t('set.in.sound') : t('set.in.sound');
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

function buildInputCard(inp, open) {
  const card = el('details', 'input');
  card.dataset.id = inp.id;
  card.dataset.type = inp.type;
  card.open = open;
  const summary = el('summary');
  const title = el('span', 'input__title');
  const sumLogo = el('img', 'input__logo hidden');
  sumLogo.alt = '';
  summary.append(sumLogo, title, tel('span', 'input__kind', inp.type === 'device' ? 'tile.device' : 'tile.stream'));
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
    body.append(labelled('set.url.label', url), tel('p', 'hint', 'set.url.hint'), tel('p', 'warn hidden in-bad', 'set.url.bad'));
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

  const remove = tel('button', 'btn btn--small btn--danger in-remove', 'set.in.remove');
  remove.type = 'button';
  const foot = el('div', 'input__foot');
  foot.appendChild(remove);
  body.appendChild(foot);
  card.append(summary, body);
  title.textContent = inputTitle(card);
  refreshCardLogo(card);
  return card;
}

function updateInputsFooter() {
  const cards = $('inputsList').querySelectorAll('.input');
  $('addStream').disabled = cards.length >= MAX_INPUTS;
  $('addDevice').disabled = cards.length >= MAX_INPUTS || !!$('inputsList').querySelector('.input[data-type="device"]');
  $('inputsMax').textContent = t('set.inputs.max', { n: MAX_INPUTS });
  $('inputsEmpty').classList.toggle('hidden', cards.length > 0);
}

function renderInputsList() {
  const list = $('inputsList');
  list.replaceChildren();
  settings.inputs.forEach((inp) => list.appendChild(buildInputCard(inp, settings.inputs.length <= 2)));
  updateInputsFooter();
}

function addInput(type) {
  const base = { id: uuid(), name: '', type, deviceId: '', deviceLabel: '', channelPair: 0, streamUrl: '', thresholdDb: -50, minSilenceSec: 30, enabled: true };
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
      deviceLabel: deviceId ? sel.selectedOptions[0]?.textContent || '' : '',
      channelPair: type === 'device' ? Number(card.querySelector('.in-chan').value) || 0 : 0,
      thresholdDb: Number(card.querySelector('.in-thr').value),
      minSilenceSec: Number(card.querySelector('.in-min').value)
    };
  });
}

function onInputsEvent(e) {
  const card = e.target.closest?.('.input');
  if (!card) return;
  const tg = e.target;
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
  if (tg.classList.contains('in-remove')) {
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
  $('mTo').value = m.to;
  const tg = s.notifications.telegram;
  $('tEnable').checked = tg.enabled;
  $('tToken').value = tg.botToken;
  renderRecipients(tg.recipients);
  $('gBoot').checked = s.general.startOnBoot;
  $('gMin').checked = s.general.startMinimized;
  $('gAuto').checked = s.general.autoStartMonitoring;
  $('gAwake').checked = s.general.keepAwake;
  $('gUpd').checked = s.general.checkUpdates;
  $('gRet').value = s.general.retentionDays;
  $('dGlow').value = s.display.edgeGlow;
  $('dWall').checked = s.display.startInWall;
  setDirty(false);
}

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
      email: { enabled: $('mEnable').checked, host: $('mHost').value.trim(), port: Number($('mPort').value) || 587, secure: $('mSecure').checked, user: $('mUser').value.trim(), pass: $('mPass').value, from: $('mFrom').value.trim(), to: $('mTo').value.trim() },
      telegram: { enabled: $('tEnable').checked, botToken: $('tToken').value.trim(), recipients }
    },
    heartbeat: { enabled: $('hEnable').checked, url: $('hUrl').value.trim(), intervalMin: Number($('hMin').value) || 5 },
    display: { edgeGlow: $('dGlow').value, startInWall: $('dWall').checked },
    general: { startOnBoot: $('gBoot').checked, startMinimized: $('gMin').checked, autoStartMonitoring: $('gAuto').checked, keepAwake: $('gAwake').checked, checkUpdates: $('gUpd').checked, retentionDays: Number($('gRet').value) || 365 }
  };
}

async function saveForm(e) {
  e?.preventDefault();
  const patch = readForm();
  let bad = false;
  for (const card of $('inputsList').querySelectorAll('.input')) {
    const inp = patch.inputs.find((i) => i.id === card.dataset.id);
    const invalid = inp.type === 'stream' && inp.enabled && !validUrl(inp.streamUrl);
    card.querySelector('.in-bad')?.classList.toggle('hidden', !invalid);
    if (invalid) {
      card.open = true;
      bad = true;
    }
  }
  const hbBad = patch.heartbeat.enabled && !validUrl(patch.heartbeat.url);
  $('hBad').classList.toggle('hidden', !hbBad);
  if (bad || hbBad) return;
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
    const label = sel.selectedOptions[0]?.textContent || '';
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
  const form = readForm();
  const out = $(channel === 'email' ? 'mRes' : 'tRes');
  out.className = 'testres';
  out.textContent = t('set.test.sending');
  const r = await api.notifications.test(channel, channel === 'email' ? form.notifications.email : form.notifications.telegram);
  out.textContent = r.ok ? t('set.test.ok') : t('set.test.fail', { error: r.error });
  out.classList.add(r.ok ? 'is-ok' : 'is-fail');
}

// ---- updates ------------------------------------------------------------------------------------------
function renderUpdates() {
  $('updCurrent').textContent = t('upd.current', { v: info.version });
  const res = $('updRes');
  const actions = $('updActions');
  res.className = 'testres';
  actions.classList.add('hidden');
  $('updReveal').classList.add('hidden');
  const u = updateState;
  if (!u) {
    res.textContent = '';
    return;
  }
  if (u.busy) res.textContent = u.busy;
  else if (!u.ok) {
    res.textContent = t('upd.fail', { error: u.error });
    res.classList.add('is-fail');
  } else if (!u.available) res.textContent = t('upd.none');
  else {
    res.textContent = u.message || t('upd.available', { v: u.latest });
    actions.classList.remove('hidden');
    $('updDownload').classList.toggle('hidden', !u.installer || !u.sumsUrl);
    if (!u.installer || !u.sumsUrl) res.textContent = `${t('upd.available', { v: u.latest })} ${t('upd.nomatch')}`;
    if (u.file) $('updReveal').classList.remove('hidden');
  }
}

function showUpdateBanner(u) {
  updateState = u;
  $('updateText').textContent = t('upd.banner', { v: u.latest });
  $('updateBanner').classList.remove('hidden');
  renderUpdates();
}

// ---- navigation and wiring -----------------------------------------------------------------------------
function showView(name) {
  for (const v of ['dashboard', 'log', 'settings', 'help']) $(`view-${v}`).classList.toggle('hidden', v !== name);
  for (const b of document.querySelectorAll('.nav__item')) b.classList.toggle('is-active', b.dataset.view === name);
  if (name === 'dashboard') refreshStats();
  if (name === 'log') refreshEvents();
  if (name === 'settings' && !dirty) fillForm();
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
  renderUpdates();
  updateInputsFooter();
  if (!dirty) fillForm();
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
    if (e.key === 'Escape' && wall) setWall(false);
  });
  document.addEventListener('mousemove', wakeCursor);
  $('setupBtn').addEventListener('click', () => showView('settings'));
  $('allLogBtn').addEventListener('click', () => showView('log'));
  $('updateGo').addEventListener('click', () => {
    showView('settings');
    $('updCard').scrollIntoView();
  });
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
    onInputsEvent(e);
    setDirty(true);
  });
  form.addEventListener('change', (e) => {
    onInputsEvent(e);
    setDirty(true);
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
  $('mTest').addEventListener('click', () => testChannel('email'));
  $('tTest').addEventListener('click', () => testChannel('telegram'));

  $('updCheck').addEventListener('click', async () => {
    updateState = { busy: t('upd.checking') };
    renderUpdates();
    const r = await api.updates.check();
    updateState = r;
    renderUpdates();
  });
  $('updDownload').addEventListener('click', async () => {
    const base = updateState;
    updateState = { ...base, busy: t('upd.downloading', { pct: 0 }), ok: true, available: true };
    renderUpdates();
    const r = await api.updates.download();
    updateState = { ...base, ok: true, available: true, message: r.ok ? t('upd.done') : t('upd.dlfail', { error: r.error }), file: r.ok ? r.file : null };
    renderUpdates();
  });
  $('updReveal').addEventListener('click', () => updateState?.file && api.updates.reveal(updateState.file));
  $('updPage').addEventListener('click', () => api.updates.openPage());
  for (const b of document.querySelectorAll('[data-ext]')) b.addEventListener('click', () => api.app.openExternal(b.dataset.ext));

  api.on.status((st) => {
    status = st;
    renderStatus();
  });
  api.on.levels(onLevels);
  api.on.wallExit(() => setWall(false, false));
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
  api.on.updateAvailable(showUpdateBanner);
  api.on.updateProgress(({ got, total }) => {
    if (updateState?.busy && total) {
      updateState.busy = t('upd.downloading', { pct: Math.round((got / total) * 100) });
      renderUpdates();
    }
  });
}

async function init() {
  [settings, info, status, logos] = await Promise.all([api.settings.get(), api.app.info(), api.monitor.status(), api.logos.all()]);
  lang = settings.language;
  t = makeT(lang);
  $('ver').textContent = `v${info.version}`;
  applyTheme();
  wire();
  renderAll();
  await Promise.all([refreshEvents(), refreshStats()]);
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(() => {
    if (!$('view-log').classList.contains('hidden')) renderLog(); // ongoing durations
  }, 1000);
  if (settings.display.startInWall) setWall(true);
}

init();
