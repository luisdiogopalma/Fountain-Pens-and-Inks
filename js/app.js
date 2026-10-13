import { db } from './db.js';
import * as drive from './drive.js';
import { openEditor, DEFAULT_LAYOUT, cropNorm, dominantHex } from './editor.js';

// ───────────────────────── constants ─────────────────────────
const CFG = window.INK_CONFIG || {};
const params = new URLSearchParams(location.search);
const VIEW_ID = params.get('view');
const RO = !!VIEW_ID; // read-only shared view

// rainbow order, then the neutrals
export const COLOURS = [
  ['Red', '#b02530'], ['Orange', '#df7426'], ['Yellow', '#dfb928'], ['Green', '#3c7a3a'], ['Turquoise', '#16999b'],
  ['Blue', '#2c55a8'], ['Purple', '#6a46a0'], ['Pink', '#df5f9b'], ['Brown', '#7a4c2c'], ['Grey', '#878c94'],
  ['Black', '#1d1d21'], ['Clear/White', '#ecebe4'],
];
const COLOUR_HEX = Object.fromEntries(COLOURS);
const PROPS = [['sheen', 'Sheen'], ['shimmer', 'Shimmer'], ['duochrome', 'Duo-chrome'], ['ironGall', 'Iron gall'], ['scented', 'Scented']];
const STATUS = [['owned', 'In collection'], ['empty', 'Finished'], ['lost', 'Lost'], ['gone', 'Given away / sold']];
const PEN_STATUS = [['owned', 'In collection'], ['gone', 'Sold / given away']];
const NIB_SIZES = ['EF', 'F', 'MF', 'M', 'B', 'BB', 'Stub', 'Italic', 'Architect', 'Fude', 'Flex', 'Music'];
const NIB_MATERIALS = ['Steel', 'Gold 14k', 'Gold 18k', 'Gold 21k', 'Titanium'];
const PEN_MATERIALS = ['Resin', 'Acrylic', 'Celluloid', 'Ebonite', 'Plastic', 'Aluminium', 'Brass', 'Stainless steel', 'Titanium', 'Wood', 'Urushi lacquer', 'Silver'];
const FILLING = ['Cartridge / converter', 'Piston', 'Vacuum', 'Eyedropper', 'Lever', 'Button'];

// ───────────────────────── state ─────────────────────────
const S = {
  inks: [], pens: [], fills: [],
  layout: DEFAULT_LAYOUT, layoutUpdatedAt: 0,
  title: 'Fountain Pens and Inks', titleUpdatedAt: 0,
  prefs: { cleanDays: 28, cleanDaysRisky: 14, currency: '€' }, prefsUpdatedAt: 0,
  compare: null, // Set of ink ids while choosing inks to compare
  period: null,  // usage-over-time view state
  imageMap: {}, // local image id -> Drive file id
  meta: {},     // local-only: folderId, photosId, catalogId, lastSync, public, trash[]
  view: 'inked',
  syncing: false, syncState: 'off', syncMsg: '',
};
const FKEY = 'ink.filters.v1';
const DEF_F = {
  inks: { q: '', brand: [], collection: [], colour: [], size: [], props: [], status: [], usage: '', photo: '', acquired: [], shop: [], sort: 'brand', layout: 'grid' },
  pens: { q: '', brand: [], nibSize: [], nibMaterial: [], material: [], inked: '', status: [], sort: 'brand' },
};
let F = JSON.parse(JSON.stringify(DEF_F));
try { const saved = JSON.parse(localStorage.getItem(FKEY) || 'null'); if (saved) F = { inks: { ...DEF_F.inks, ...saved.inks }, pens: { ...DEF_F.pens, ...saved.pens } }; } catch (e) {}
const saveF = () => { try { localStorage.setItem(FKEY, JSON.stringify(F)); } catch (e) {} };

// ───────────────────────── helpers ─────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtDate = s => s ? new Date(s + (s.length === 10 ? 'T12:00' : '')).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const daysSince = s => Math.max(0, Math.round((Date.now() - new Date(s + 'T12:00').getTime()) / 86400000));
const live = a => a.filter(x => !x.deleted);
const byId = (arr, id) => arr.find(x => x.id === id);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const inkTitle = i => i ? `${i.brand}${i.collection ? ' ' + i.collection : ''} ${i.name}` : 'Unknown ink';
const penTitle = p => p ? `${p.brand} ${p.model}`.trim() : 'Unknown pen';
const inkColor = i => i?.hex || COLOUR_HEX[i?.colourGroup] || '#c9c4b8';
const cmp = (a, b) => String(a || '').localeCompare(String(b || ''), 'en', { sensitivity: 'base', numeric: true });

const I = {
  drop: '<svg viewBox="0 0 24 24"><path d="M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11z"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M14.5 3.5l6 6L9 21H3v-6z"/><path d="M12 6l6 6"/></svg>',
  inked: '<svg viewBox="0 0 24 24"><path d="M5 19l4-1 10-10-3-3L6 15z"/><path d="M14 7l3 3"/><path d="M4 21h16"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  filter: '<svg viewBox="0 0 24 24"><path d="M3 5h18M6 12h12M10 19h4"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  grid: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>',
  done: '<svg viewBox="0 0 24 24"><path d="M12 3s5 5.5 5 9a5 5 0 0 1-10 0c0-3.5 5-9 5-9z"/><path d="M9.5 12.5l2 2 3.5-4"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/></svg>',
  compare: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="7" height="16" rx="1.5"/><rect x="14" y="4" width="7" height="16" rx="1.5"/></svg>',
  pipette: '<svg viewBox="0 0 24 24"><path d="M14 4l6 6M17 7l-9.5 9.5L5 19l-1-1 2.5-2.5L16 6"/><path d="M15 3.5l5.5 5.5"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  sync: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.6-4.5M4 13a8 8 0 0 0 14.6 4.5"/><path d="M5 3v4h4M19 21v-4h-4"/></svg>',
  cloudOff: '<svg viewBox="0 0 24 24"><path d="M7 18h10a4 4 0 0 0 .6-8A6 6 0 0 0 6.2 9 4.5 4.5 0 0 0 7 18z"/><path d="M3 3l18 18"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>',
  refill: '<svg viewBox="0 0 24 24"><path d="M12 3s5 5.5 5 9a5 5 0 0 1-10 0c0-3.5 5-9 5-9z"/><path d="M12 10v5M9.5 12.5h5"/></svg>',
  clean: '<svg viewBox="0 0 24 24"><path d="M12 3s5 5.5 5 9a5 5 0 0 1-10 0c0-3.5 5-9 5-9z"/><path d="M9.5 12.5h5"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
};

// ───────────────────────── derived data ─────────────────────────
const activeFills = () => live(S.fills).filter(f => !f.end);
const currentFill = penId => activeFills().filter(f => f.penId === penId).sort((a, b) => cmp(b.start, a.start))[0];
function usage(fills = live(S.fills)) {
  const u = { ink: {}, pen: {}, pair: {}, inkLast: {}, inkPens: {} };
  for (const f of fills) {
    u.ink[f.inkId] = (u.ink[f.inkId] || 0) + 1;
    u.pen[f.penId] = (u.pen[f.penId] || 0) + 1;
    const k = f.penId + '|' + f.inkId; u.pair[k] = (u.pair[k] || 0) + 1;
    if (!u.inkLast[f.inkId] || f.start > u.inkLast[f.inkId]) u.inkLast[f.inkId] = f.start;
  }
  for (const f of fills) if (!f.end) (u.inkPens[f.inkId] ||= []).push(f.penId);
  return u;
}

// ───────────────────────── persistence ─────────────────────────
const STORE = { ink: 'inks', pen: 'pens', fill: 'fills' };
const LIST = { ink: () => S.inks, pen: () => S.pens, fill: () => S.fills };
async function saveRec(kind, rec) {
  if (RO) return;
  rec.updatedAt = Date.now();
  if (!rec.createdAt) rec.createdAt = rec.updatedAt;
  const arr = LIST[kind]();
  const i = arr.findIndex(x => x.id === rec.id);
  if (i >= 0) arr[i] = rec; else arr.push(rec);
  await db.put(STORE[kind], rec);
  changed();
}
async function deleteRec(kind, rec) {
  for (const k of Object.keys(rec.photos || {})) trashImage(rec.photos[k]);
  await saveRec(kind, { id: rec.id, deleted: true, createdAt: rec.createdAt });
}
async function setMeta(k, v) { S.meta[k] = v; await db.setMeta('local', S.meta); }

let syncTimer = null;
function changed() {
  setMeta('dirty', true);
  rerender();
  if (drive.isConfigured() && drive.hasToken()) { clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(false), 2500); }
  else updateSyncBadge();
}

// images
const urlCache = new Map();
async function storeImage(blob) { const id = uid('img'); await db.put('images', { id, blob }); return id; }
function trashImage(id) { if (!id) return; const d = S.imageMap[id]; if (d) setMeta('trash', [...(S.meta.trash || []), d]); }
function applyLayoutCSS() {
  // ink tiles take the swatch's own proportions, so the whole swatch is visible
  const L = S.layout || DEFAULT_LAYOUT; const ar = (L.swatch[2] * L.aspect) / L.swatch[3];
  document.documentElement.style.setProperty('--sw-ar', String(Math.max(0.5, Math.min(2, ar)).toFixed(3)));
}
async function imageBlob(id) {
  if (!id) return null;
  let blob = null;
  if (!RO) { const rec = await db.get('images', id); blob = rec?.blob; }
  if (!blob && S.imageMap[id]) {
    if (RO) blob = await (await drive.publicDownload(S.imageMap[id])).blob();
    else if (drive.hasToken()) { blob = await (await drive.download(S.imageMap[id])).blob(); await db.put('images', { id, blob }); }
  }
  return blob;
}
async function imageURL(id) {
  if (!id) return null;
  if (urlCache.has(id)) return urlCache.get(id);
  let blob = null;
  if (!RO) { const rec = await db.get('images', id); blob = rec?.blob; }
  if (!blob && S.imageMap[id]) {
    try {
      if (RO) blob = await (await drive.publicDownload(S.imageMap[id])).blob();
      else if (drive.hasToken()) { blob = await (await drive.download(S.imageMap[id])).blob(); await db.put('images', { id, blob }); }
    } catch (e) { console.warn('image', e); }
  }
  if (!blob) return null;
  const u = URL.createObjectURL(blob); urlCache.set(id, u); return u;
}
const io = 'IntersectionObserver' in window ? new IntersectionObserver(ents => {
  for (const e of ents) if (e.isIntersecting) { io.unobserve(e.target); loadImg(e.target); }
}, { rootMargin: '300px' }) : null;
async function loadImg(img) {
  const u = await imageURL(img.dataset.img);
  if (u) { img.src = u; img.onload = () => img.classList.add('ok'); }
}
function hydrate(root = document) {
  for (const img of $$('img[data-img]:not([src])', root)) io ? io.observe(img) : loadImg(img);
}

// ───────────────────────── catalog file (sync / backup) ─────────────────────────
function buildCatalog() {
  return {
    app: 'fountain-pens-and-inks', version: 1,
    title: S.title, titleUpdatedAt: S.titleUpdatedAt,
    layout: S.layout, layoutUpdatedAt: S.layoutUpdatedAt,
    prefs: S.prefs, prefsUpdatedAt: S.prefsUpdatedAt,
    inks: S.inks, pens: S.pens, fills: S.fills, images: S.imageMap,
  };
}
async function mergeCatalog(remote) {
  let changedLocal = false;
  for (const kind of ['ink', 'pen', 'fill']) {
    const key = STORE[kind];
    const arr = LIST[kind]();
    const map = new Map(arr.map(x => [x.id, x]));
    const toSave = [];
    for (const r of remote[key] || []) {
      const l = map.get(r.id);
      if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) { map.set(r.id, r); toSave.push(r); }
    }
    if (toSave.length) { changedLocal = true; await db.putMany(key, toSave); S[key] = [...map.values()]; }
  }
  if (remote.images) { const before = Object.keys(S.imageMap).length; S.imageMap = { ...remote.images, ...S.imageMap }; if (Object.keys(S.imageMap).length !== before) await db.setMeta('imageMap', S.imageMap); }
  if ((remote.layoutUpdatedAt || 0) > S.layoutUpdatedAt) { S.layout = remote.layout; S.layoutUpdatedAt = remote.layoutUpdatedAt; await db.setMeta('layout', { layout: S.layout, at: S.layoutUpdatedAt }); applyLayoutCSS(); changedLocal = true; }
  if ((remote.prefsUpdatedAt || 0) > S.prefsUpdatedAt) { S.prefs = { ...S.prefs, ...remote.prefs }; S.prefsUpdatedAt = remote.prefsUpdatedAt; await db.setMeta('prefs', { prefs: S.prefs, at: S.prefsUpdatedAt }); changedLocal = true; }
  if ((remote.titleUpdatedAt || 0) > S.titleUpdatedAt) { S.title = remote.title; S.titleUpdatedAt = remote.titleUpdatedAt; await db.setMeta('title', { title: S.title, at: S.titleUpdatedAt }); changedLocal = true; }
  return changedLocal;
}
const stableJSON = o => JSON.stringify(o);

// ───────────────────────── Google Drive sync ─────────────────────────
async function sync(interactive) {
  if (RO || !drive.isConfigured()) return;
  if (S.syncing) { S.syncAgain = true; return; }
  try {
    if (!drive.hasToken()) {
      if (!interactive) { S.syncState = 'signin'; updateSyncBadge(); return; }
      await drive.signIn();
    }
    S.syncing = true; S.syncState = 'syncing'; updateSyncBadge();
    const m = S.meta;
    let folderId = m.folderId && (await drive.fileInfo(m.folderId));
    folderId = folderId && !folderId.trashed ? m.folderId : await drive.findOrCreateFolder('Fountain Pens and Inks');
    let photosId = m.photosId && (await drive.fileInfo(m.photosId));
    photosId = photosId && !photosId.trashed ? m.photosId : await drive.findOrCreateFolder('photos', folderId);
    await setMeta('folderId', folderId); await setMeta('photosId', photosId);

    let cat = m.catalogId ? await drive.fileInfo(m.catalogId) : null;
    if (!cat || cat.trashed) cat = await drive.findFile('fountain-pens-and-inks.json', folderId);
    let remoteStr = '';
    if (cat) {
      const remote = await (await drive.download(cat.id)).json();
      remoteStr = stableJSON(remote);
      if (await mergeCatalog(remote)) rerender();
    }
    // upload new photos
    const refs = new Set();
    for (const r of [...live(S.inks), ...live(S.pens)]) for (const v of Object.values(r.photos || {})) if (v) refs.add(v);
    let n = 0;
    for (const id of refs) {
      if (S.imageMap[id]) continue;
      const img = await db.get('images', id);
      if (!img) continue;
      S.syncMsg = `Uploading photos… ${++n}`; updateSyncBadge();
      const r = await drive.upload({ name: id + '.jpg', parent: photosId, mime: 'image/jpeg', body: img.blob });
      S.imageMap[id] = r.id;
      if (m.public) await drive.makePublic(r.id);
      await db.setMeta('imageMap', S.imageMap);
    }
    S.syncMsg = '';
    // trash replaced photos
    if (m.trash?.length) {
      for (const d of m.trash) await drive.trash(d);
      for (const [k, v] of Object.entries(S.imageMap)) if (m.trash.includes(v)) delete S.imageMap[k];
      await db.setMeta('imageMap', S.imageMap); await setMeta('trash', []);
    }
    // upload catalog if anything differs
    const localStr = stableJSON(buildCatalog());
    if (!cat || localStr !== remoteStr) {
      const r = await drive.upload({ id: cat?.id, name: 'fountain-pens-and-inks.json', parent: folderId, mime: 'application/json', body: localStr });
      cat = { id: r.id };
    }
    await setMeta('catalogId', cat.id);
    // public sharing state
    if (m.public && !m.publicApplied) {
      S.syncMsg = 'Sharing…'; updateSyncBadge();
      await drive.makePublic(cat.id);
      for (const d of Object.values(S.imageMap)) await drive.makePublic(d);
      await setMeta('publicApplied', true);
    } else if (!m.public && m.publicApplied) {
      S.syncMsg = 'Making private…'; updateSyncBadge();
      await drive.makePrivate(cat.id);
      for (const d of Object.values(S.imageMap)) await drive.makePrivate(d);
      await setMeta('publicApplied', false);
    }
    await setMeta('lastSync', Date.now()); await setMeta('dirty', false);
    S.syncState = 'ok'; S.syncMsg = '';
  } catch (e) {
    console.error(e);
    S.syncState = e.code === 'auth' ? 'signin' : 'error'; S.syncMsg = e.message;
    if (interactive) toast(e.message, true);
  } finally {
    S.syncing = false; updateSyncBadge();
    if (S.view === 'settings') rerender();
    if (S.syncAgain) { S.syncAgain = false; setTimeout(() => sync(false), 500); }
  }
}

function updateSyncBadge() {
  const b = $('#syncBadge'); if (!b) return;
  if (RO) { b.hidden = true; return; }
  let cls = 'off', label = 'Local only', icon = I.cloudOff;
  if (drive.isConfigured()) {
    if (S.syncState === 'syncing') { cls = 'busy'; label = S.syncMsg || 'Syncing…'; icon = I.sync; }
    else if (S.syncState === 'error') { cls = 'err'; label = 'Sync error'; icon = I.sync; }
    else if (!drive.hasToken()) { cls = 'warn'; label = S.meta.dirty ? 'Tap to sync · changes waiting' : 'Tap to sync'; icon = I.sync; }
    else { cls = 'ok'; label = S.meta.lastSync ? 'Synced ' + timeAgo(S.meta.lastSync) : 'Connected'; icon = I.check; }
  }
  b.className = 'sync ' + cls; b.innerHTML = icon + `<span>${esc(label)}</span>`; b.title = S.syncMsg || label;
}
function timeAgo(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago'; return new Date(t).toLocaleDateString('en-GB');
}

// ───────────────────────── UI: shell ─────────────────────────
const VIEWS = [['inked', 'Inked', I.inked], ['inks', 'Inks', I.drop], ['pens', 'Pens', I.pen], ['stats', 'Stats', I.chart], ['settings', RO ? 'About' : 'Settings', I.gear]];
function shell() {
  document.body.innerHTML = `
    <div class="app ${RO ? 'ro' : ''}">
      <nav class="nav">
        <div class="logo">${I.drop}<span class="logo-t">${esc(S.title)}</span></div>
        ${VIEWS.map(([k, n, ic]) => `<a href="#${k}" data-v="${k}">${ic}<span>${n}</span>${k === 'inked' ? '<b class="nb" id="dueBadge" hidden></b>' : ''}</a>`).join('')}
        <button id="syncBadge" class="sync off" type="button"></button>
      </nav>
      <main id="main"></main>
    </div>
    <div id="modals"></div><div id="toast" role="status"></div>`;
  $('#syncBadge').onclick = () => { if (!drive.isConfigured()) location.hash = 'settings'; else sync(true); };
  updateSyncBadge();
}
function setView() {
  const v = (location.hash || '#inked').slice(1);
  S.view = VIEWS.some(x => x[0] === v) ? v : 'inked';
  $$('.nav a').forEach(a => a.classList.toggle('on', a.dataset.v === S.view));
  renderView(); updateDueBadge();
  window.scrollTo(0, 0);
}
function updateDueBadge() {
  const b = $('#dueBadge'); if (!b) return;
  const n = activeFills().filter(f => cleanStatus(f).due).length;
  b.hidden = !n; b.textContent = n; b.title = `${n} pen${n === 1 ? '' : 's'} due for cleaning`;
}
function rerender() {
  updateDueBadge();
  // refresh the current view without losing the search box focus
  if (['inks', 'pens'].includes(S.view)) renderResults(); else renderView();
  $('.logo-t') && ($('.logo-t').textContent = S.title);
  const top = topModal(); if (top?.refresh) top.refresh();
}
function renderView() {
  const m = $('#main');
  ({ inked: viewInked, inks: viewInks, pens: viewPens, stats: viewStats, settings: viewSettings })[S.view](m);
  hydrate(m);
}

function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(t._t); t._t = setTimeout(() => t.className = '', 3500);
}

// ───────────────────────── modals ─────────────────────────
const modalStack = [];
const topModal = () => modalStack[modalStack.length - 1];
function openModal(html, { cls = '', onClose, refresh, wide } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal ' + cls + (wide ? ' wide' : '');
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  $('#modals').appendChild(wrap);
  document.body.classList.add('no-scroll');
  const m = { el: wrap, onClose, refresh: refresh ? () => refresh(m) : null };
  modalStack.push(m);
  history.pushState({ modal: modalStack.length }, '');
  wrap.addEventListener('click', e => { if (e.target === wrap) closeModal(); });
  $$('[data-close]', wrap).forEach(b => b.onclick = () => closeModal());
  requestAnimationFrame(() => wrap.classList.add('in'));
  hydrate(wrap);
  return m;
}
function closeModal(fromPop) {
  const m = modalStack.pop(); if (!m) return;
  m.el.remove(); m.onClose && m.onClose();
  if (!modalStack.length) document.body.classList.remove('no-scroll');
  if (!fromPop) { window.__skipPop = (window.__skipPop || 0) + 1; history.back(); }
  const t = topModal(); if (t?.refresh) t.refresh();
}
window.addEventListener('popstate', () => {
  if (window.__skipPop > 0) { window.__skipPop--; return; }
  if (document.querySelector('.ed')) return; // the photo editor handles its own back
  if (modalStack.length) closeModal(true);
});
function confirmBox(msg, ok = 'Delete') {
  return new Promise(res => {
    const m = openModal(`<div class="confirm"><p>${esc(msg)}</p><div class="row end"><button class="btn" data-close>Cancel</button><button class="btn danger" id="cOk">${esc(ok)}</button></div></div>`, { cls: 'small', onClose: () => res(false) });
    $('#cOk', m.el).onclick = () => { m.onClose = null; closeModal(); res(true); };
  });
}
function lightbox(imgId) {
  const m = openModal(`<div class="lb"><button class="icon-btn lb-x" data-close aria-label="Close">${I.x}</button><img data-img="${esc(imgId)}" alt=""></div>`, { cls: 'lbm' });
  m.el.querySelector('.lb').onclick = e => { if (e.target.tagName !== 'IMG') closeModal(); };
}

// ───────────────────────── view: Inked ─────────────────────────
// how long an ink may stay in a pen: stricter for shimmer and iron gall
function cleanStatus(f) {
  const ink = byId(S.inks, f.inkId);
  const risky = !!(ink && (ink.shimmer || ink.ironGall));
  const limit = Number(risky ? S.prefs.cleanDaysRisky : S.prefs.cleanDays) || 28;
  const days = daysSince(f.start);
  return { days, limit, risky, due: days >= limit, soon: days < limit && days >= limit - 3, left: limit - days };
}
function viewInked(m) {
  const act = activeFills().sort((a, b) => { const A = cleanStatus(a), B = cleanStatus(b); return (B.due - A.due) || (A.left - B.left) || cmp(b.start, a.start); });
  const dueN = act.filter(f => cleanStatus(f).due).length;
  const inkedPens = new Set(act.map(f => f.penId));
  const empty = live(S.pens).filter(p => p.status !== 'gone' && !inkedPens.has(p.id)).sort((a, b) => cmp(penTitle(a), penTitle(b)));
  m.innerHTML = `
    <header class="vh"><div><h1>Inked now</h1><p class="sub">${plural(act.length, 'pen')} inked${empty.length ? ` · ${empty.length} empty` : ''}${dueN ? ` · <b class="due-t">${dueN} due for cleaning</b>` : ''}</p></div>
      ${RO ? '' : `<div class="row"><button class="btn" id="suggestBtn">${I.spark}<span>Suggest an ink</span></button><button class="btn primary" id="inkBtn">${I.refill}<span>Ink a pen</span></button></div>`}</header>
    ${act.length ? `<div class="inked">${act.map(f => {
      const p = byId(S.pens, f.penId), i = byId(S.inks, f.inkId), cs = cleanStatus(f);
      return `<article class="inked-card ${cs.due ? 'due' : cs.soon ? 'soon' : ''}" style="--ink:${esc(inkColor(i))}">
        <button class="ic-pen" data-pen="${esc(f.penId)}">${p?.photos?.pen ? `<img data-img="${esc(p.photos.pen)}" alt="">` : `<span class="ph">${I.pen}</span>`}</button>
        <div class="ic-body">
          <button class="ic-t" data-pen="${esc(f.penId)}"><b>${esc(penTitle(p))}</b><span>${esc([p?.nibSize, p?.nibMaterial].filter(Boolean).join(' · '))}</span></button>
          <button class="ic-ink" data-ink="${esc(f.inkId)}"><span class="dot lg" style="background:${esc(inkColor(i))}">${i?.photos?.swatch ? `<img data-img="${esc(i.photos.swatch)}" alt="">` : ''}</span><span><b>${esc(i?.name || '?')}</b><small>${esc(i ? i.brand + (i.collection ? ' · ' + i.collection : '') : '')}</small></span></button>
          <p class="ic-d">Inked ${esc(fmtDate(f.start))} · ${daysSince(f.start) === 0 ? 'today' : plural(daysSince(f.start), 'day') + ' ago'}</p>
          ${cs.due ? `<p class="ic-warn due">${I.warn}<span><b>Time to clean</b> · limit ${cs.limit} days${cs.risky ? ' for shimmer / iron gall ink' : ''}</span></p>` : cs.soon ? `<p class="ic-warn soon">${I.warn}<span>Clean within ${plural(cs.left, 'day')}${cs.risky ? ' (shimmer / iron gall)' : ''}</span></p>` : ''}
          ${p?.careful && i && (i.shimmer || i.ironGall) ? `<p class="ic-warn soon">${I.warn}<span>${i.shimmer ? 'Shimmer' : 'Iron gall'} ink in a pen marked careful</span></p>` : ''}
          ${RO ? '' : `<div class="ic-a"><button class="btn small" data-refill="${esc(f.id)}">${I.refill}Refill</button><button class="btn small" data-change="${esc(f.penId)}">Change ink</button><button class="btn small ghost" data-clean="${esc(f.id)}">${I.clean}Clean</button></div>`}
        </div></article>`;
    }).join('')}</div>` : `<div class="empty">${I.inked}<p>${live(S.pens).length ? 'No pens are inked right now.' : 'Add your pens first, then record which ink goes in each one.'}</p>${RO ? '' : live(S.pens).length ? '<button class="btn primary" id="inkBtn2">Ink a pen</button>' : '<button class="btn primary" id="addPen0">Add a pen</button>'}</div>`}
    ${empty.length ? `<h2 class="h2">Empty pens</h2><div class="chips-row">${empty.map(p => `<button class="pill" data-fillpen="${esc(p.id)}">${p.photos?.pen ? `<img data-img="${esc(p.photos.pen)}" alt="">` : ''}${esc(penTitle(p))}${RO ? '' : ' <span class="muted">+ ink</span>'}</button>`).join('')}</div>` : ''}`;
  $('#inkBtn', m) && ($('#inkBtn', m).onclick = () => inkAPen({}));
  $('#suggestBtn', m) && ($('#suggestBtn', m).onclick = () => suggestInk());
  $('#inkBtn2', m) && ($('#inkBtn2', m).onclick = () => inkAPen({}));
  $('#addPen0', m) && ($('#addPen0', m).onclick = () => editPen());
  $$('[data-pen]', m).forEach(b => b.onclick = () => showPen(b.dataset.pen));
  $$('[data-ink]', m).forEach(b => b.onclick = () => showInk(b.dataset.ink));
  $$('[data-fillpen]', m).forEach(b => b.onclick = () => RO ? showPen(b.dataset.fillpen) : inkAPen({ penId: b.dataset.fillpen }));
  $$('[data-refill]', m).forEach(b => b.onclick = () => refill(b.dataset.refill));
  $$('[data-clean]', m).forEach(b => b.onclick = () => clean(b.dataset.clean));
  $$('[data-change]', m).forEach(b => b.onclick = () => inkAPen({ penId: b.dataset.change }));
}

// ───────────────────────── fills ─────────────────────────
async function startFill(penId, inkId, date, note) {
  const cur = currentFill(penId);
  if (cur) await saveRec('fill', { ...cur, end: date < cur.start ? cur.start : date, endReason: cur.inkId === inkId ? 'refilled' : 'changed' });
  await saveRec('fill', { id: uid('f'), penId, inkId, start: date, end: null, note: note || '' });
}
async function refill(fillId) {
  const f = byId(S.fills, fillId); if (!f) return;
  await startFill(f.penId, f.inkId, today());
  toast(`Refilled — ${inkTitle(byId(S.inks, f.inkId))} used ${usage().ink[f.inkId]}×`);
}
async function clean(fillId) {
  const f = byId(S.fills, fillId); if (!f) return;
  await saveRec('fill', { ...f, end: today(), endReason: 'cleaned' });
  toast(`${penTitle(byId(S.pens, f.penId))} is now empty`);
}

function inkAPen({ penId = '', inkId = '' }) {
  const st = { penId, inkId, q: '', pq: '', date: today(), note: '' };
  const pens = live(S.pens).filter(p => p.status !== 'gone').sort((a, b) => cmp(penTitle(a), penTitle(b)));
  if (!pens.length) { toast('Add a pen first'); return editPen(); }
  const m = openModal(`
    <div class="mh"><h2>Ink a pen</h2><button class="icon-btn" data-close aria-label="Close">${I.x}</button></div>
    <div class="mb fill-form">
      <label class="lbl">Pen</label><div id="penPick"></div>
      <label class="lbl">Ink</label><div class="search sm">${I.search}<input id="inkQ" type="search" placeholder="Search inks…" autocomplete="off"></div><div id="inkPick" class="pick-inks"></div>
      <div class="row2"><label class="lbl">Date<input type="date" id="fDate" value="${st.date}"></label><label class="lbl">Note<input id="fNote" placeholder="optional"></label></div>
    </div>
    <p class="warn-box" id="fWarn" hidden></p>
    <div class="mf"><span id="fSum" class="muted"></span><button class="btn primary" id="fOk" disabled>Save</button></div>`, { wide: true });
  const el = m.el;
  const u = usage();
  function drawPens() {
    $('#penPick', el).innerHTML = `<div class="pick-pens">${pens.map(p => {
      const cf = currentFill(p.id), ci = cf && byId(S.inks, cf.inkId);
      return `<button class="pp ${st.penId === p.id ? 'on' : ''}" data-p="${esc(p.id)}">${p.photos?.pen ? `<img data-img="${esc(p.photos.pen)}" alt="">` : `<span class="ph">${I.pen}</span>`}<span><b>${esc(penTitle(p))}</b><small>${ci ? `<i class="dot" style="background:${esc(inkColor(ci))}"></i>${esc(ci.name)}` : 'empty'}</small></span></button>`;
    }).join('')}</div>`;
    $$('[data-p]', el).forEach(b => b.onclick = () => { st.penId = b.dataset.p; drawPens(); upd(); });
    hydrate(el);
  }
  function drawInks() {
    const q = norm(st.q);
    let list = live(S.inks).filter(i => !['gone', 'lost', 'empty'].includes(i.status));
    if (q) list = list.filter(i => norm(`${i.brand} ${i.collection} ${i.name} ${i.colourGroup}`).includes(q));
    list.sort((a, b) => (b.id === st.inkId) - (a.id === st.inkId) || cmp(u.inkLast[b.id] || '', u.inkLast[a.id] || '') || cmp(inkTitle(a), inkTitle(b)));
    const shown = list.slice(0, 120);
    $('#inkPick', el).innerHTML = shown.map(i => `<button class="pi ${st.inkId === i.id ? 'on' : ''}" data-i="${esc(i.id)}"><span class="dot lg" style="background:${esc(inkColor(i))}">${i.photos?.swatch ? `<img data-img="${esc(i.photos.swatch)}" alt="">` : ''}</span><span><b>${esc(i.name)}</b><small>${esc(i.brand)}${u.ink[i.id] ? ` · ${u.ink[i.id]}×` : ''}</small></span></button>`).join('') + (list.length > shown.length ? `<p class="muted pad">${list.length - shown.length} more — refine the search</p>` : '') + (!list.length ? '<p class="muted pad">No inks match</p>' : '');
    $$('[data-i]', el).forEach(b => b.onclick = () => { st.inkId = b.dataset.i; $$('.pi', el).forEach(x => x.classList.toggle('on', x === b)); upd(); });
    hydrate(el);
  }
  function upd() {
    const ok = st.penId && st.inkId;
    $('#fOk', el).disabled = !ok;
    const cf = st.penId && currentFill(st.penId);
    $('#fSum', el).textContent = ok ? (cf ? (cf.inkId === st.inkId ? 'Counts as a refill of the same ink' : `Replaces ${byId(S.inks, cf.inkId)?.name || 'current ink'}`) : '') : 'Choose a pen and an ink';
    const pen = st.penId && byId(S.pens, st.penId), ink = st.inkId && byId(S.inks, st.inkId);
    const risk = pen?.careful && ink && (ink.shimmer || ink.ironGall);
    const w = $('#fWarn', el); w.hidden = !risk;
    if (risk) w.innerHTML = `${I.warn}<span><b>Heads-up:</b> ${esc(penTitle(pen))} is marked vintage / careful, and ${esc(ink.name)} is ${[ink.shimmer && 'a shimmer ink', ink.ironGall && 'an iron gall ink'].filter(Boolean).join(' and ')}. ${ink.shimmer ? 'Shimmer particles can clog the feed.' : ''} ${ink.ironGall ? 'Iron gall ink can corrode steel nibs and stain if left too long.' : ''}</span>`;
    $('#fOk', el).textContent = risk ? 'Ink anyway' : 'Save';
  }
  $('#inkQ', el).oninput = e => { st.q = e.target.value; drawInks(); };
  $('#fDate', el).onchange = e => st.date = e.target.value || today();
  $('#fNote', el).oninput = e => st.note = e.target.value;
  $('#fOk', el).onclick = async () => {
    await startFill(st.penId, st.inkId, st.date, st.note);
    closeModal();
    toast(`${penTitle(byId(S.pens, st.penId))} inked with ${byId(S.inks, st.inkId)?.name}`);
  };
  drawPens(); drawInks(); upd();
}

// ───────────────────────── view: Inks ─────────────────────────
function inkFacets() {
  const inks = live(S.inks);
  const count = fn => { const c = {}; for (const i of inks) for (const v of [].concat(fn(i))) c[v] = (c[v] || 0) + 1; return c; };
  return {
    brand: count(i => i.brand),
    collection: count(i => i.collection ? `${i.brand}|${i.collection}` : []),
    colour: count(i => i.colourGroup || '—'),
    size: count(i => i.size),
    props: count(i => PROPS.filter(([k]) => i[k]).map(([k]) => k)),
    status: count(i => i.status || 'owned'),
    acquired: count(i => i.acquired || '—'),
    shop: count(i => i.shop || []),
  };
}
function filterInks() {
  const f = F.inks, u = usage(), q = norm(f.q).trim();
  let list = live(S.inks).filter(i => {
    if (f.brand.length && !f.brand.includes(i.brand)) return false;
    if (f.collection.length && !f.collection.includes(`${i.brand}|${i.collection}`)) return false;
    if (f.colour.length && !f.colour.includes(i.colourGroup || '—')) return false;
    if (f.size.length && !f.size.includes(i.size)) return false;
    if (f.props.length && !f.props.every(k => i[k])) return false;
    if (f.status.length && !f.status.includes(i.status || 'owned')) return false;
    if (f.usage === 'inked' && !u.inkPens[i.id]) return false;
    if (f.usage === 'used' && !u.ink[i.id]) return false;
    if (f.usage === 'never' && u.ink[i.id]) return false;
    if (f.photo === 'has' && !i.photos?.swatch) return false;
    if (f.photo === 'missing' && i.photos?.swatch) return false;
    if (f.acquired?.length && !f.acquired.includes(i.acquired || '—')) return false;
    if (f.shop?.length && !f.shop.includes(i.shop)) return false;
    if (q) {
      const hay = norm(`${i.brand} ${i.collection} ${i.name} ${i.colourGroup} ${i.notes} ${PROPS.filter(([k]) => i[k]).map(p => p[1]).join(' ')} ${i.size}`);
      if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
    }
    return true;
  });
  const colIdx = c => { const k = COLOURS.findIndex(x => x[0] === c); return k < 0 ? 99 : k; };
  const sorts = {
    brand: (a, b) => cmp(a.brand, b.brand) || cmp(a.collection, b.collection) || cmp(a.name, b.name),
    name: (a, b) => cmp(a.name, b.name),
    used: (a, b) => (u.ink[b.id] || 0) - (u.ink[a.id] || 0) || cmp(a.name, b.name),
    recent: (a, b) => cmp(u.inkLast[b.id] || '', u.inkLast[a.id] || '') || cmp(a.name, b.name),
    added: (a, b) => (b.createdAt || 0) - (a.createdAt || 0) || cmp(a.name, b.name),
    colour: (a, b) => colIdx(a.colourGroup) - colIdx(b.colourGroup) || cmp(a.brand, b.brand) || cmp(a.name, b.name),
  };
  list.sort(sorts[f.sort] || sorts.brand);
  return { list, u };
}
function activeCount(f, keys) { return keys.reduce((n, k) => n + (Array.isArray(f[k]) ? f[k].length : f[k] ? 1 : 0), 0); }
const INK_FKEYS = ['brand', 'collection', 'colour', 'size', 'props', 'status', 'usage', 'photo', 'acquired', 'shop'];
const PEN_FKEYS = ['brand', 'nibSize', 'nibMaterial', 'material', 'inked', 'status'];

function viewInks(m) {
  const f = F.inks;
  m.innerHTML = `
    <header class="vh"><div><h1>Inks</h1><p class="sub" id="cnt"></p></div><div class="row"><button class="btn" id="ccBtn" title="Do I already have this colour?">${I.pipette}<span>Colour check</span></button><button class="btn" id="cmpBtn">${I.compare}<span>Compare</span></button>${RO ? '' : `<button class="btn primary" id="addInk">${I.plus}<span>Add ink</span></button>`}</div></header>
    <div class="cmp-bar" id="cmpBar" hidden></div>
    <div class="toolbar">
      <div class="search">${I.search}<input id="q" type="search" placeholder="Search name, brand, colour…" value="${esc(f.q)}" autocomplete="off"><button class="clr" id="qx" aria-label="Clear search">${I.x}</button></div>
      <button class="btn" id="fBtn">${I.filter}<span>Filters</span><b class="badge" id="fN"></b></button>
      <select id="sort" aria-label="Sort">${[['brand', 'Brand'], ['name', 'Name A–Z'], ['colour', 'Colour'], ['used', 'Most used'], ['recent', 'Recently used'], ['added', 'Recently added']].map(([k, n]) => `<option value="${k}" ${f.sort === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <div class="seg" role="group" aria-label="Layout"><button data-l="grid" class="${f.layout === 'grid' ? 'on' : ''}" aria-label="Grid">${I.grid}</button><button data-l="list" class="${f.layout === 'list' ? 'on' : ''}" aria-label="List">${I.list}</button></div>
    </div>
    <div class="qcolours" id="qc"></div>
    <div class="actchips" id="ac"></div>
    <div id="res"></div>`;
  $('#q', m).oninput = e => { f.q = e.target.value; saveF(); renderResults(); };
  $('#qx', m).onclick = () => { f.q = ''; $('#q', m).value = ''; saveF(); renderResults(); };
  $('#sort', m).onchange = e => { f.sort = e.target.value; saveF(); renderResults(); };
  $$('[data-l]', m).forEach(b => b.onclick = () => { f.layout = b.dataset.l; saveF(); $$('[data-l]', m).forEach(x => x.classList.toggle('on', x === b)); renderResults(); });
  $('#fBtn', m).onclick = () => filterSheet('inks');
  $('#ccBtn', m).onclick = () => colourCheck();
  $('#cmpBtn', m).onclick = () => { S.compare = S.compare ? null : new Set(); renderResults(); };
  $('#addInk', m) && ($('#addInk', m).onclick = () => editInk());
  renderResults();
}
function renderResults() {
  if (S.view === 'pens') return renderPens();
  if (S.view !== 'inks') return;
  const m = $('#main'), f = F.inks;
  const { list, u } = filterInks();
  const total = live(S.inks).length;
  $('#cnt', m).textContent = list.length === total ? `${total} inks · ${live(S.inks).filter(i => i.size === 'bottle').length} bottles · ${live(S.inks).filter(i => i.size === 'sample').length} samples` : `${list.length} of ${total} inks`;
  const n = activeCount(f, INK_FKEYS); $('#fN', m).textContent = n || ''; $('#fBtn', m).classList.toggle('on', !!n);
  $('#qx', m).hidden = !f.q;
  // quick colour row
  $('#qc', m).innerHTML = COLOURS.map(([c, h]) => `<button class="qc ${f.colour.includes(c) ? 'on' : ''}" data-c="${esc(c)}" title="${esc(c)}" aria-label="${esc(c)}" style="--c:${h}"></button>`).join('');
  $$('.qc', m).forEach(b => b.onclick = () => { toggleIn(f.colour, b.dataset.c); saveF(); renderResults(); });
  // active chips
  const chips = [];
  const lab = { size: { bottle: 'Bottles', sample: 'Samples' }, usage: { inked: 'In a pen now', used: 'Used', never: 'Never used' }, photo: { has: 'Has swatch photo', missing: 'No swatch photo' }, acquired: { bought: 'Bought', gift: 'Gift', free: 'Free', '—': 'Purchase not recorded' } };
  for (const k of INK_FKEYS) {
    for (const v of [].concat(f[k] || [])) {
      if (!v) continue;
      let t = v;
      if (k === 'collection') t = v.replace('|', ' · ');
      if (k === 'props') t = PROPS.find(p => p[0] === v)?.[1];
      if (k === 'status') t = STATUS.find(p => p[0] === v)?.[1];
      if (k === 'colour' && v === '—') t = 'No colour group';
      if (lab[k]) t = lab[k][v];
      chips.push(`<button class="chip x" data-k="${k}" data-v="${esc(v)}">${esc(t)} ${I.x}</button>`);
    }
  }
  if (chips.length) chips.push('<button class="link" id="clrAll">Clear all</button>');
  $('#ac', m).innerHTML = chips.join('');
  $$('#ac .chip', m).forEach(b => b.onclick = () => { const k = b.dataset.k; if (Array.isArray(f[k])) f[k] = f[k].filter(x => x !== b.dataset.v); else f[k] = ''; saveF(); renderResults(); });
  $('#clrAll', m) && ($('#clrAll', m).onclick = () => { F.inks = { ...JSON.parse(JSON.stringify(DEF_F.inks)), q: f.q, sort: f.sort, layout: f.layout }; saveF(); renderResults(); });

  const res = $('#res', m);
  if (!list.length) { res.innerHTML = `<div class="empty">${I.search}<p>No inks match.</p></div>`; return; }
  const tile = i => {
    const uses = u.ink[i.id] || 0, inPens = u.inkPens[i.id];
    const props = PROPS.filter(([k]) => i[k]).map(([, n]) => n);
    const size = i.size === 'sample' ? 'Sample' : (i.ml ? `${i.ml} ml` : 'Bottle');
    if (f.layout === 'list') return `<button class="row-ink" data-open="${esc(i.id)}"><span class="dot lg" style="background:${esc(inkColor(i))}">${i.photos?.swatch ? `<img data-img="${esc(i.photos.swatch)}" alt="">` : ''}</span><span class="ri-t"><b>${esc(i.name)}</b><small>${esc(i.brand)}${i.collection ? ' · ' + esc(i.collection) : ''}</small></span><span class="ri-m">${esc(size)}${i.qty > 1 ? ` ×${i.qty}` : ''}</span><span class="ri-p">${props.map(p => `<i class="tag">${esc(p)}</i>`).join('')}</span><span class="ri-u">${inPens ? `<i class="inpen" title="In a pen now"></i>` : ''}${uses ? `${uses}×` : ''}</span></button>`;
    return `<button class="tile" data-open="${esc(i.id)}">
      <span class="sw" style="--c:${esc(inkColor(i))}">${i.photos?.swatch ? `<img data-img="${esc(i.photos.swatch)}" alt="">` : `<span class="sw-ph">${i.colourGroup ? '' : '?'}</span>`}
        ${inPens ? `<i class="inpen" title="In ${inPens.length} pen${inPens.length > 1 ? 's' : ''} now"></i>` : ''}${i.status && i.status !== 'owned' ? `<i class="st">${esc(STATUS.find(s => s[0] === i.status)?.[1] || '')}</i>` : ''}</span>
      <span class="t-b"><b>${esc(i.name)}</b><small>${esc(i.brand)}${i.collection ? ' · ' + esc(i.collection) : ''}</small>
      <span class="t-m"><i>${esc(size)}${i.qty > 1 ? ` ×${i.qty}` : ''}</i>${props.map(p => `<i class="tag">${esc(p)}</i>`).join('')}${uses ? `<i class="uses">${uses}×</i>` : ''}</span></span></button>`;
  };
  let html = '';
  if (f.sort === 'brand' || f.sort === 'colour') {
    const key = f.sort === 'brand' ? (i => i.brand) : (i => i.colourGroup || 'No colour group');
    let cur = null, buf = [];
    const flush = () => { if (cur !== null) html += `<section class="grp"><h3>${f.sort === 'colour' ? `<i class="dot" style="background:${COLOUR_HEX[cur] || '#ccc'}"></i>` : ''}${esc(cur)} <span>${buf.length}</span></h3><div class="${f.layout}">${buf.map(tile).join('')}</div></section>`; };
    for (const i of list) { const k = key(i); if (k !== cur) { flush(); cur = k; buf = []; } buf.push(i); }
    flush();
  } else html = `<div class="${f.layout}">${list.map(tile).join('')}</div>`;
  res.innerHTML = html;
  $$('[data-open]', res).forEach(b => b.onclick = () => {
    if (!S.compare) return showInk(b.dataset.open);
    const id = b.dataset.open;
    if (S.compare.has(id)) S.compare.delete(id); else if (S.compare.size >= 4) return toast('Compare up to 4 inks'); else S.compare.add(id);
    renderResults();
  });
  const bar = $('#cmpBar', m);
  bar.hidden = !S.compare; $('#cmpBtn', m).classList.toggle('on', !!S.compare);
  if (S.compare) {
    $$('[data-open]', res).forEach(b => b.classList.toggle('picked', S.compare.has(b.dataset.open)));
    res.classList.add('picking');
    bar.innerHTML = `<span>${S.compare.size ? `${S.compare.size} selected` : 'Tap 2–4 inks to compare'}</span><button class="btn ghost small" id="cmpX">Cancel</button><button class="btn primary small" id="cmpGo" ${S.compare.size < 2 ? 'disabled' : ''}>Compare</button>`;
    $('#cmpX', bar).onclick = () => { S.compare = null; renderResults(); };
    $('#cmpGo', bar).onclick = () => compareInks([...S.compare]);
  } else res.classList.remove('picking');
  hydrate(res);
}
const toggleIn = (arr, v) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); };

function filterSheet(which) {
  const f = F[which];
  const m = openModal(`<div class="mh"><h2>Filters</h2><button class="icon-btn" data-close aria-label="Close">${I.x}</button></div><div class="mb" id="fb"></div><div class="mf"><button class="link" id="fReset">Reset filters</button><button class="btn primary" data-close id="fShow">Show results</button></div>`, { cls: 'side' });
  const el = m.el;
  const group = (title, key, opts, multi = true) => `<fieldset class="fg"><legend>${title}</legend><div class="chips">${opts.map(([v, label, extra = '', n]) => {
    const on = multi ? f[key].includes(v) : f[key] === v;
    return `<button class="chip ${on ? 'on' : ''}" data-k="${key}" data-v="${esc(v)}" data-m="${multi ? 1 : 0}">${extra}${esc(label)}${n != null ? ` <small>${n}</small>` : ''}</button>`;
  }).join('')}</div></fieldset>`;
  function draw() {
    let h = '';
    if (which === 'inks') {
      const fc = inkFacets();
      const brands = Object.keys(fc.brand).sort(cmp);
      const colls = Object.keys(fc.collection).filter(k => !f.brand.length || f.brand.includes(k.split('|')[0])).sort(cmp);
      h += group('Colour group', 'colour', [...COLOURS.map(([c, hx]) => [c, c, `<i class="dot" style="background:${hx}"></i>`, fc.colour[c] || 0]), ['—', 'Not set', '', fc.colour['—'] || 0]]);
      h += group('Properties <small>(all selected must match)</small>', 'props', PROPS.map(([k, n]) => [k, n, '', fc.props[k] || 0]));
      h += group('Type', 'size', [['bottle', 'Bottle', '', fc.size.bottle || 0], ['sample', 'Sample', '', fc.size.sample || 0]]);
      h += group('Usage', 'usage', [['inked', 'In a pen now'], ['used', 'Used at least once'], ['never', 'Never used']], false);
      h += group('Brand', 'brand', brands.map(b => [b, b, '', fc.brand[b]]));
      if (colls.length) h += group('Collection', 'collection', colls.map(c => [c, c.split('|')[1] + (f.brand.length === 1 ? '' : ` (${c.split('|')[0]})`), '', fc.collection[c]]));
      h += group('Status', 'status', STATUS.map(([k, n]) => [k, n, '', fc.status[k] || 0]));
      if (!RO) h += group('Swatch photo', 'photo', [['has', 'Has photo'], ['missing', 'Missing photo']], false);
      h += group('How you got it', 'acquired', [...ACQ.map(([k, n]) => [k, n, '', fc.acquired[k] || 0]), ['—', 'Not recorded', '', fc.acquired['—'] || 0]]);
      const shops = Object.keys(fc.shop).sort(cmp); if (shops.length) h += group('Shop', 'shop', shops.map(s => [s, s, '', fc.shop[s]]));
    } else {
      const pens = live(S.pens);
      const cnt = fn => { const c = {}; for (const p of pens) { const v = fn(p); if (v) c[v] = (c[v] || 0) + 1; } return c; };
      const opts = c => Object.keys(c).sort(cmp).map(k => [k, k, '', c[k]]);
      h += group('Brand', 'brand', opts(cnt(p => p.brand)));
      h += group('Nib size', 'nibSize', opts(cnt(p => p.nibSize)));
      h += group('Nib material', 'nibMaterial', opts(cnt(p => p.nibMaterial)));
      h += group('Pen material', 'material', opts(cnt(p => p.material)));
      h += group('Ink', 'inked', [['yes', 'Inked now'], ['no', 'Empty']], false);
      h += group('Status', 'status', PEN_STATUS.map(([k, n]) => [k, n]));
    }
    $('#fb', el).innerHTML = h;
    $$('#fb .chip', el).forEach(b => b.onclick = () => {
      const k = b.dataset.k, v = b.dataset.v;
      if (b.dataset.m === '1') toggleIn(f[k], v); else f[k] = f[k] === v ? '' : v;
      if (k === 'brand' && which === 'inks') f.collection = f.collection.filter(c => !f.brand.length || f.brand.includes(c.split('|')[0]));
      saveF(); renderResults(); draw(); upd();
    });
  }
  function upd() { const n = (which === 'inks' ? filterInks().list : filterPens().list).length; $('#fShow', el).textContent = `Show ${n} ${which === 'inks' ? 'ink' : 'pen'}${n === 1 ? '' : 's'}`; }
  $('#fReset', el).onclick = () => { const keep = { q: f.q, sort: f.sort, layout: f.layout }; Object.assign(f, JSON.parse(JSON.stringify(DEF_F[which])), keep); saveF(); renderResults(); draw(); upd(); };
  draw(); upd();
}

// ───────────────────────── ink detail / edit ─────────────────────────
function showInk(id) {
  const render = mm => {
    const i = byId(S.inks, id);
    if (!i || i.deleted) { closeModal(); return; }
    const u = usage();
    const hist = live(S.fills).filter(f => f.inkId === id).sort((a, b) => cmp(b.start, a.start));
    const pensNow = u.inkPens[id] || [];
    const pairCounts = {}; hist.forEach(f => pairCounts[f.penId] = (pairCounts[f.penId] || 0) + 1);
    const props = PROPS.filter(([k]) => i[k]);
    const ph = i.photos || {};
    const html = `
      <div class="mh"><div><h2>${esc(i.name)}</h2><p class="sub">${esc(i.brand)}${i.collection ? ' · ' + esc(i.collection) : ''}</p></div><button class="icon-btn" data-close aria-label="Close">${I.x}</button></div>
      <div class="mb detail">
        <div class="photos">
          ${ph.swatch ? `<button class="ph-main ink" data-lb="${esc(ph.swatch)}"><img data-img="${esc(ph.swatch)}" alt="Swatch"></button>` : `<div class="ph-main colour" style="background:${esc(inkColor(i))}">${RO ? '' : `<div class="ph-add"><span>Add the swatch card</span><div class="row wrap center">${photoBtns('addPh', 'small')}</div></div>`}</div>`}
          ${ph.writing ? `<button class="ph-wr" data-lb="${esc(ph.writing)}"><img data-img="${esc(ph.writing)}" alt="Writing sample"></button>` : ''}
          ${ph.card ? `<button class="link sm" data-lb="${esc(ph.card)}">${I.eye} View whole card</button>` : ''}
        </div>
        <dl class="facts">
          <div><dt>Type</dt><dd>${i.size === 'sample' ? 'Sample' : 'Bottle'}${i.ml ? ` · ${esc(i.ml)} ml` : ''}${i.qty > 1 ? ` · ×${esc(i.qty)}` : ''}</dd></div>
          <div><dt>Colour group</dt><dd>${i.colourGroup ? `<i class="dot" style="background:${COLOUR_HEX[i.colourGroup]}"></i>${esc(i.colourGroup)}` : '<span class="muted">Not set</span>'}${i.hex ? ` <span class="hex"><i class="dot" style="background:${esc(i.hex)}"></i>${esc(i.hex)}</span>` : ''}</dd></div>
          <div><dt>Properties</dt><dd>${props.length ? props.map(([, n]) => `<i class="tag">${esc(n)}</i>`).join(' ') : '<span class="muted">None</span>'}</dd></div>
          <div><dt>Status</dt><dd>${esc(STATUS.find(s => s[0] === (i.status || 'owned'))?.[1])}${i.status === 'empty' && i.finishedAt ? ` on ${esc(fmtDate(i.finishedAt))}` : ''}${i.finished?.length && i.status !== 'empty' ? ` <span class="muted">· ${plural(i.finished.length, (i.size === 'sample' ? 'sample' : 'bottle'))} finished before</span>` : ''}</dd></div>
          <div><dt>Used</dt><dd><b>${u.ink[id] || 0}×</b>${u.inkLast[id] ? ` · last ${esc(fmtDate(u.inkLast[id]))}` : ''}</dd></div>
          ${purchaseText(i) ? `<div><dt>Purchase</dt><dd>${esc(purchaseText(i))}</dd></div>` : ''}
          ${pensNow.length ? `<div><dt>In now</dt><dd>${pensNow.map(p => `<button class="link" data-pen="${esc(p)}">${esc(penTitle(byId(S.pens, p)))}</button>`).join(', ')}</dd></div>` : ''}
        </dl>
        ${i.notes ? `<p class="notes">${esc(i.notes)}</p>` : ''}
        ${(() => { const sim = similarInks(i.hex, i.id, 5); return i.hex ? `<h3 class="h3">Similar inks you own</h3>${sim.length ? similarList(sim) : '<p class="muted">None close — this colour is unique in your measured inks.</p>'}${sim.length ? `<button class="link sm" id="cmpSim">${I.compare} Compare with the closest</button>` : ''}` : ''; })()}
        ${hist.length ? `<h3 class="h3">Pens it has been in</h3><div class="chips-row">${Object.entries(pairCounts).sort((a, b) => b[1] - a[1]).map(([p, n]) => `<button class="pill" data-pen="${esc(p)}">${esc(penTitle(byId(S.pens, p)))} <b>${n}×</b></button>`).join('')}</div>
          <h3 class="h3">History</h3><ul class="hist">${hist.map(f => `<li><span class="dot" style="background:${esc(inkColor(i))}"></span><span><b>${esc(penTitle(byId(S.pens, f.penId)))}</b><small>${esc(fmtDate(f.start))} → ${f.end ? esc(fmtDate(f.end)) + (f.endReason ? ` (${esc(f.endReason)})` : '') : '<b>in the pen now</b>'}${f.note ? ` · ${esc(f.note)}` : ''}</small></span>${RO ? '' : `<button class="icon-btn sm" data-delfill="${esc(f.id)}" aria-label="Delete this entry">${I.x}</button>`}</li>`).join('')}</ul>` : ''}
      </div>
      ${RO ? '' : `<div class="mf"><div class="row"><button class="btn" id="eInk">${I.edit}Edit</button>${i.status === 'empty' ? `<button class="btn ghost" id="unfin">Back in collection</button>` : `<button class="btn ghost" id="fin">${I.done}Finished</button>`}</div>${i.status === 'empty' ? '' : `<button class="btn primary" id="fInk">${I.refill}<span class="hide-xs">Ink a pen</span></button>`}</div>`}`;
    mm.el.querySelector('.sheet').innerHTML = html;
    bind(mm);
  };
  const bind = mm => {
    const el = mm.el;
    $$('[data-close]', el).forEach(b => b.onclick = () => closeModal());
    $$('[data-lb]', el).forEach(b => b.onclick = () => lightbox(b.dataset.lb));
    $$('[data-pen]', el).forEach(b => b.onclick = () => showPen(b.dataset.pen));
    $$('.sim [data-ink]', el).forEach(b => b.onclick = () => showInk(b.dataset.ink));
    $('#cmpSim', el) && ($('#cmpSim', el).onclick = () => { const i = byId(S.inks, id); compareInks([id, ...similarInks(i.hex, id, 3).map(x => x.i.id)]); });
    $$('[data-delfill]', el).forEach(b => b.onclick = async () => { if (await confirmBox('Delete this fill from the history? The use count goes down by one.')) { const f = byId(S.fills, b.dataset.delfill); await deleteRec('fill', f); } });
    $('#eInk', el) && ($('#eInk', el).onclick = () => editInk(byId(S.inks, id)));
    $('#fInk', el) && ($('#fInk', el).onclick = () => inkAPen({ inkId: id }));
    $$('[data-photo="addPh"]', el).forEach(b => b.onclick = () => editInk(byId(S.inks, id), { scan: b.dataset.src }));
    $('#fin', el) && ($('#fin', el).onclick = () => finishInk(id));
    $('#unfin', el) && ($('#unfin', el).onclick = async () => { const i = byId(S.inks, id); await saveRec('ink', { ...i, status: 'owned', finishedAt: null }); toast(`${i.name} is back in the collection`); });
    hydrate(el);
  };
  const m = openModal('', { refresh: mm => render(mm), wide: true });
  render(m);
}

// Phones get two buttons: "Take photo" (opens the camera) and "From gallery". Computers just "Choose image".
const CAN_CAMERA = matchMedia('(pointer: coarse)').matches;
function photoBtns(id, cls = '') {
  return (CAN_CAMERA ? `<button type="button" class="btn ${cls}" data-photo="${id}" data-src="camera">${I.camera}Take photo</button>` : '')
    + `<button type="button" class="btn ${cls}" data-photo="${id}" data-src="gallery">${I.image}${CAN_CAMERA ? 'From gallery' : 'Choose image'}</button>`;
}
function chooseSource() {
  if (!CAN_CAMERA) return Promise.resolve('gallery');
  return new Promise(res => {
    const m = openModal(`<div class="confirm"><p><b>Add a photo</b></p><div class="row wrap">${photoBtns('src')}</div><div class="row end" style="margin-top:12px"><button class="btn ghost" data-close>Cancel</button></div></div>`, { cls: 'small', onClose: () => res(null) });
    $$('[data-photo="src"]', m.el).forEach(b => b.onclick = () => { m.onClose = null; closeModal(); res(b.dataset.src); });
  });
}
async function finishInk(id) {
  const i = byId(S.inks, id); if (!i) return;
  const unit = i.size === 'sample' ? 'sample' : 'bottle';
  const d = JSON.parse(JSON.stringify(i));
  d.finished = [...(i.finished || []), today()];
  if ((i.qty || 1) > 1) {
    if (!(await confirmBox(`Finished one ${unit} of ${i.name}? You'll still have ${i.qty - 1}.`, 'Finished'))) return;
    d.qty = i.qty - 1;
    await saveRec('ink', d); toast(`One ${unit} finished · ${d.qty} left`);
  } else {
    if (!(await confirmBox(`Mark ${i.name} as finished? It stays in your history and stats, marked "Finished".`, 'Finished'))) return;
    d.status = 'empty'; d.finishedAt = today();
    await saveRec('ink', d); toast(`${i.name} marked as finished`);
  }
}
function pickFile(source = 'gallery') {
  if (source === null) return Promise.resolve(null);
  return new Promise(res => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    if (source === 'camera') inp.capture = 'environment';
    inp.onchange = () => res(inp.files[0] || null);
    inp.addEventListener('cancel', () => res(null));
    inp.click();
  });
}
// Colour group from a measured ink colour: nearest of several reference shades per group (CIELAB distance)
const GROUP_REFS = {
  Black: ['#1b1b1f', '#2b2b2b', '#23252b', '#302a2a', '#262a33'],
  Blue: ['#1f3d8f', '#2c55a8', '#3a6fd0', '#5b84c9', '#1b2a55', '#7fa3d6', '#2f4a7a', '#4a5fa8', '#24346e'],
  Brown: ['#6b4423', '#7a4c2c', '#8b5a2b', '#5a3a28', '#9c6b45', '#a0703a', '#4a3426', '#b5835a', '#8d6e4f', '#6e5a3c', '#a5683a'],
  'Clear/White': ['#f2f2ee', '#e9e7df'],
  Green: ['#2f6b2f', '#3c7a3a', '#5a9a3c', '#1f4d2e', '#6b8e23', '#8aa65a', '#2e5e4a', '#4f7f4f', '#7a8a4a', '#9bbf6a', '#556b2f'],
  Grey: ['#808080', '#5f646b', '#9a9ea4', '#6e6a66', '#b4b6b8', '#4a4f55', '#7d8590'],
  Orange: ['#e07a26', '#f08c32', '#d9622b', '#f5a04a', '#c8642a', '#f07860', '#e8955a'],
  Pink: ['#e46aa0', '#f08cb4', '#d63c8a', '#f4a6c0', '#c45a8a', '#e88aa0'],
  Purple: ['#6a46a0', '#4b2a7a', '#8a5ac0', '#5a3a6e', '#9a7ac8', '#7a3a8a', '#3a2a5a', '#6b4a8a'],
  Red: ['#b02530', '#d03030', '#8a1c24', '#6e1a24', '#c8402e', '#a02040', '#e04848', '#7a2030'],
  Turquoise: ['#16999b', '#1fb5b5', '#127a80', '#2aa0b8', '#0f6a6e', '#4ac0c0', '#1e8a96'],
  Yellow: ['#dfb928', '#f0d040', '#c8a020', '#e8c860', '#d4b040'],
};
function hexToLab(hex) {
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [1, 3, 5].map(i => lin(parseInt(hex.slice(i, i + 2), 16)));
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
const REF_LAB = Object.entries(GROUP_REFS).flatMap(([g, hs]) => hs.map(h => [g, hexToLab(h)]));
function suggestGroup(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return '';
  const [L, A, B] = hexToLab(hex);
  let best = '', bd = Infinity;
  for (const [g, [l, a, b]] of REF_LAB) { const dd = (L - l) ** 2 * 0.6 + (A - a) ** 2 + (B - b) ** 2; if (dd < bd) { bd = dd; best = g; } }
  return best;
}

function editInk(ink, { scan = false } = {}) {
  const isNew = !ink;
  const d = ink ? JSON.parse(JSON.stringify(ink)) : { id: uid('i'), brand: '', collection: '', name: '', size: 'bottle', ml: null, qty: 1, colourGroup: '', hex: '', sheen: false, shimmer: false, duochrome: false, ironGall: false, scented: false, status: 'owned', notes: '', photos: {} };
  d.photos ||= {};
  const pending = {}; // key -> {blob, url}
  const brands = [...new Set(live(S.inks).map(i => i.brand))].sort(cmp);
  const m = openModal(`
    <div class="mh"><h2>${isNew ? 'Add ink' : 'Edit ink'}</h2><button class="icon-btn" data-close aria-label="Close">${I.x}</button></div>
    <form class="mb form" id="inkF" autocomplete="off">
      <div class="ph-edit">
        <div class="ph-slots" id="slots"></div>
        <div class="scan-row"><span class="lbl-inline">Swatch card</span>${photoBtns('scan')}</div>
        <div class="row wrap"><button type="button" class="link sm" id="recrop">Adjust boxes</button><button type="button" class="link sm" id="swOnly">Swatch only</button><button type="button" class="link sm" id="wrOnly">Writing sample only</button></div>
      </div>
      <div class="row2">
        <label class="lbl">Brand<input name="brand" list="dlBrand" required value="${esc(d.brand)}"></label>
        <label class="lbl">Collection / line<input name="collection" list="dlColl" value="${esc(d.collection)}" placeholder="e.g. Iroshizuku"></label>
      </div>
      <label class="lbl">Ink name<input name="name" required value="${esc(d.name)}"></label>
      <datalist id="dlBrand">${brands.map(b => `<option value="${esc(b)}">`).join('')}</datalist><datalist id="dlColl"></datalist>
      <div class="row3">
        <div class="lbl">Type<div class="seg wide" id="size"><button type="button" data-v="bottle">Bottle</button><button type="button" data-v="sample">Sample</button></div></div>
        <label class="lbl" id="mlL">Size (ml)<input name="ml" type="number" min="0" step="1" inputmode="numeric" value="${esc(d.ml ?? '')}" placeholder="e.g. 50"></label>
        <label class="lbl">Quantity<input name="qty" type="number" min="1" step="1" inputmode="numeric" value="${esc(d.qty || 1)}"></label>
      </div>
      <div class="lbl">Colour group <span class="muted" id="sugg"></span><div class="chips" id="cg">${COLOURS.map(([c, h]) => `<button type="button" class="chip" data-v="${esc(c)}"><i class="dot" style="background:${h}"></i>${esc(c)}</button>`).join('')}<button type="button" class="chip" data-v="">Not set</button></div></div>
      <div class="row2"><label class="lbl">Ink colour (for display)<span class="row"><input type="color" name="hexp" value="${esc(d.hex || COLOUR_HEX[d.colourGroup] || '#888888')}"><input name="hex" value="${esc(d.hex)}" placeholder="from swatch photo" pattern="#[0-9a-fA-F]{6}"></span></label>
        <label class="lbl">Status<select name="status">${STATUS.map(([k, n]) => `<option value="${k}" ${d.status === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>
      <div class="lbl">Properties<div class="chips" id="pr">${PROPS.map(([k, n]) => `<button type="button" class="chip ${d[k] ? 'on' : ''}" data-v="${k}">${n}</button>`).join('')}</div></div>
      ${purchaseFields(d, 'ink')}
      <label class="lbl">Notes<textarea name="notes" rows="3">${esc(d.notes)}</textarea></label>
    </form>
    <div class="mf">${isNew ? '<span></span>' : `<button class="btn danger ghost" id="del">Delete</button>`}<button class="btn primary" id="save">Save</button></div>`, {
    wide: true, onClose: () => Object.values(pending).forEach(p => URL.revokeObjectURL(p.url)),
  });
  const el = m.el, form = $('#inkF', el);
  bindPurchase(el, d);
  const syncColl = () => { const b = form.brand.value.trim(); $('#dlColl', el).innerHTML = [...new Set(live(S.inks).filter(i => i.brand === b && i.collection).map(i => i.collection))].sort(cmp).map(c => `<option value="${esc(c)}">`).join(''); };
  form.brand.oninput = syncColl; syncColl();
  const drawSize = () => { $$('#size button', el).forEach(b => b.classList.toggle('on', b.dataset.v === d.size)); $('#mlL', el).style.opacity = d.size === 'sample' ? .45 : 1; };
  $$('#size button', el).forEach(b => b.onclick = () => { d.size = b.dataset.v; drawSize(); }); drawSize();
  const drawCG = () => $$('#cg .chip', el).forEach(b => b.classList.toggle('on', b.dataset.v === (d.colourGroup || '')));
  $$('#cg .chip', el).forEach(b => b.onclick = () => { d.colourGroup = b.dataset.v; d.colourGuess = false; d.colourAuto = false; drawCG(); $('#sugg', el).textContent = ''; }); drawCG();
  $$('#pr .chip', el).forEach(b => b.onclick = () => { d[b.dataset.v] = !d[b.dataset.v]; b.classList.toggle('on', d[b.dataset.v]); });
  form.hexp.oninput = () => { form.hex.value = form.hexp.value; autoGroup(form.hexp.value); };
  form.hex.oninput = () => { if (/^#[0-9a-f]{6}$/i.test(form.hex.value)) { form.hexp.value = form.hex.value; autoGroup(form.hex.value); } };
  // pick the colour group from the swatch automatically, unless you chose one yourself
  const autoGroup = hex => {
    const g = suggestGroup(hex); if (!g) return;
    if (!d.colourGroup || d.colourGuess || d.colourAuto) {
      d.colourGroup = g; d.colourAuto = true; d.colourGuess = false; drawCG();
      $('#sugg', el).textContent = '· picked from the swatch — tap another to change';
    } else if (g !== d.colourGroup) {
      $('#sugg', el).innerHTML = `· swatch looks <button type="button" class="link" id="useSugg">${esc(g)}</button>`;
      $('#useSugg', el).onclick = () => { d.colourGroup = g; d.colourAuto = true; drawCG(); $('#sugg', el).textContent = '· picked from the swatch'; };
    }
  };
  const showSugg = autoGroup;
  if (d.colourGuess && d.colourGroup) $('#sugg', el).textContent = '· pre-filled guess, please check';
  else if (d.colourAuto && d.colourGroup) $('#sugg', el).textContent = '· picked from the swatch';

  function drawSlots() {
    const slot = (k, label) => {
      const src = pending[k]?.url;
      const has = src || d.photos[k];
      return `<div class="slot ${k}"><span class="slot-l">${label}</span>${has ? `<img ${src ? `src="${src}"` : `data-img="${esc(d.photos[k])}"`} alt="">` : '<span class="slot-e">—</span>'}${has ? `<button type="button" class="icon-btn sm rm" data-rm="${k}" aria-label="Remove ${label}">${I.x}</button>` : ''}</div>`;
    };
    $('#slots', el).innerHTML = slot('swatch', 'Swatch') + slot('writing', 'Writing') + slot('card', 'Whole card');
    $$('[data-rm]', el).forEach(b => b.onclick = () => { const k = b.dataset.rm; if (pending[k]) { URL.revokeObjectURL(pending[k].url); delete pending[k]; } else d.photos[k] = null; drawSlots(); });
    hydrate(el);
  }
  const setPending = (k, blob) => { if (pending[k]) URL.revokeObjectURL(pending[k].url); pending[k] = { blob, url: URL.createObjectURL(blob) }; };
  async function doScan(src) {
    const file = await pickFile(src); if (!file) return;
    const r = await openEditor({ file, mode: 'card', layout: S.layout, title: 'Swatch card' });
    if (!r) return;
    setPending('card', r.card); setPending('swatch', r.swatch); setPending('writing', r.writing);
    form.hex.value = r.hex; form.hexp.value = r.hex; autoGroup(r.hex);
    if (r.layout) { S.layout = r.layout; S.layoutUpdatedAt = Date.now(); await db.setMeta('layout', { layout: S.layout, at: S.layoutUpdatedAt }); applyLayoutCSS(); toast('Box positions remembered for next cards'); }
    drawSlots();
  }
  async function doSingle(k) {
    const file = await pickFile(await chooseSource()); if (!file) return;
    const r = await openEditor({ file, mode: 'photo', title: k === 'swatch' ? 'Swatch' : 'Writing sample' });
    if (!r) return;
    setPending(k, r.image);
    if (k === 'swatch') { form.hex.value = r.hex; form.hexp.value = r.hex; showSugg(r.hex); }
    drawSlots();
  }
  async function doRecrop() {
    const blob = pending.card?.blob || await imageBlob(d.photos.card).catch(() => null);
    if (!blob) { toast('No saved card photo for this ink yet — scan the card first', true); return; }
    const r = await openEditor({ file: blob, mode: 'card', layout: S.layout, title: 'Adjust boxes', recrop: true });
    if (!r) return;
    setPending('swatch', r.swatch); setPending('writing', r.writing);
    form.hex.value = r.hex; form.hexp.value = r.hex; autoGroup(r.hex);
    if (r.layout) { S.layout = { ...r.layout, aspect: S.layout.aspect }; S.layoutUpdatedAt = Date.now(); await db.setMeta('layout', { layout: S.layout, at: S.layoutUpdatedAt }); applyLayoutCSS(); toast('Box positions remembered for next cards'); }
    drawSlots();
  }
  $('#recrop', el).onclick = doRecrop;
  $$('[data-photo="scan"]', el).forEach(b => b.onclick = () => doScan(b.dataset.src));
  $('#swOnly', el).onclick = () => doSingle('swatch');
  $('#wrOnly', el).onclick = () => doSingle('writing');
  drawSlots();
  $('#save', el).onclick = async () => {
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    Object.assign(d, {
      brand: fd.get('brand').trim(), collection: fd.get('collection').trim(), name: fd.get('name').trim(),
      ml: d.size === 'bottle' && fd.get('ml') ? Number(fd.get('ml')) : null, qty: Math.max(1, Number(fd.get('qty')) || 1),
      hex: /^#[0-9a-f]{6}$/i.test(fd.get('hex')) ? fd.get('hex').toLowerCase() : '', status: fd.get('status'), notes: fd.get('notes').trim(),
    });
    readPurchase(d, fd, el);
    if (ink && d.colourGroup !== ink.colourGroup && !d.colourAuto) d.colourGuess = false;
    if (d.status === 'empty' && ink?.status !== 'empty') { d.finishedAt = today(); d.finished = [...(d.finished || []), today()]; }
    if (d.status !== 'empty') d.finishedAt = null;
    for (const [k, p] of Object.entries(pending)) { trashImage(ink?.photos?.[k]); d.photos[k] = await storeImage(p.blob); }
    for (const k of Object.keys(d.photos)) if (!d.photos[k]) { trashImage(ink?.photos?.[k]); delete d.photos[k]; }
    await saveRec('ink', d);
    closeModal();
    toast(isNew ? 'Ink added' : 'Saved');
  };
  $('#del', el) && ($('#del', el).onclick = async () => {
    const used = live(S.fills).filter(f => f.inkId === d.id).length;
    if (!(await confirmBox(`Delete ${d.name}?${used ? ` Its ${used} history entr${used === 1 ? 'y stays' : 'ies stay'} but will show as "Unknown ink".` : ''} Tip: to keep the history, set the status to "Used up" instead.`))) return;
    await deleteRec('ink', ink); closeModal(); closeModal();
  });
  if (scan) doScan(scan === true ? 'gallery' : scan);
}

// ───────────────────────── view: Pens ─────────────────────────
function filterPens() {
  const f = F.pens, u = usage(), q = norm(f.q).trim();
  const list = live(S.pens).filter(p => {
    if (f.brand.length && !f.brand.includes(p.brand)) return false;
    if (f.nibSize.length && !f.nibSize.includes(p.nibSize)) return false;
    if (f.nibMaterial.length && !f.nibMaterial.includes(p.nibMaterial)) return false;
    if (f.material.length && !f.material.includes(p.material)) return false;
    if (f.status.length && !f.status.includes(p.status || 'owned')) return false;
    const inked = !!currentFill(p.id);
    if (f.inked === 'yes' && !inked) return false;
    if (f.inked === 'no' && inked) return false;
    if (q) {
      const ci = currentFill(p.id); const ink = ci && byId(S.inks, ci.inkId);
      const hay = norm(`${p.brand} ${p.model} ${p.nibSize} ${p.nibMaterial} ${p.material} ${p.finish} ${p.filling} ${p.notes} ${ink ? inkTitle(ink) : ''}`);
      if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
    }
    return true;
  });
  const sorts = {
    brand: (a, b) => cmp(a.brand, b.brand) || cmp(a.model, b.model),
    used: (a, b) => (u.pen[b.id] || 0) - (u.pen[a.id] || 0) || cmp(penTitle(a), penTitle(b)),
    added: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
  };
  list.sort(sorts[f.sort] || sorts.brand);
  return { list, u };
}
function viewPens(m) {
  const f = F.pens;
  m.innerHTML = `
    <header class="vh"><div><h1>Pens</h1><p class="sub" id="cnt"></p></div>${RO ? '' : `<button class="btn primary" id="addPen">${I.plus}<span>Add pen</span></button>`}</header>
    <div class="toolbar">
      <div class="search">${I.search}<input id="q" type="search" placeholder="Search brand, model, nib, ink…" value="${esc(f.q)}" autocomplete="off"><button class="clr" id="qx" aria-label="Clear search">${I.x}</button></div>
      <button class="btn" id="fBtn">${I.filter}<span>Filters</span><b class="badge" id="fN"></b></button>
      <select id="sort" aria-label="Sort">${[['brand', 'Brand'], ['used', 'Most used'], ['added', 'Recently added']].map(([k, n]) => `<option value="${k}" ${f.sort === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
    </div>
    <div class="actchips" id="ac"></div>
    <div id="res"></div>`;
  $('#q', m).oninput = e => { f.q = e.target.value; saveF(); renderPens(); };
  $('#qx', m).onclick = () => { f.q = ''; $('#q', m).value = ''; saveF(); renderPens(); };
  $('#sort', m).onchange = e => { f.sort = e.target.value; saveF(); renderPens(); };
  $('#fBtn', m).onclick = () => filterSheet('pens');
  $('#addPen', m) && ($('#addPen', m).onclick = () => editPen());
  renderPens();
}
function renderPens() {
  const m = $('#main'), f = F.pens;
  const { list, u } = filterPens();
  const total = live(S.pens).length;
  $('#cnt', m).textContent = list.length === total ? plural(total, 'pen') : `${list.length} of ${total} pens`;
  const n = activeCount(f, PEN_FKEYS); $('#fN', m).textContent = n || ''; $('#fBtn', m).classList.toggle('on', !!n);
  $('#qx', m).hidden = !f.q;
  const chips = [];
  for (const k of PEN_FKEYS) for (const v of [].concat(f[k] || [])) if (v) chips.push(`<button class="chip x" data-k="${k}" data-v="${esc(v)}">${esc(k === 'inked' ? (v === 'yes' ? 'Inked now' : 'Empty') : k === 'status' ? PEN_STATUS.find(s => s[0] === v)?.[1] : v)} ${I.x}</button>`);
  $('#ac', m).innerHTML = chips.join('');
  $$('#ac .chip', m).forEach(b => b.onclick = () => { const k = b.dataset.k; if (Array.isArray(f[k])) f[k] = f[k].filter(x => x !== b.dataset.v); else f[k] = ''; saveF(); renderPens(); });
  const res = $('#res', m);
  if (!total) { res.innerHTML = `<div class="empty">${I.pen}<p>No pens yet.</p>${RO ? '' : '<button class="btn primary" id="addPen1">Add your first pen</button>'}</div>`; $('#addPen1', m) && ($('#addPen1', m).onclick = () => editPen()); return; }
  if (!list.length) { res.innerHTML = `<div class="empty">${I.search}<p>No pens match.</p></div>`; return; }
  res.innerHTML = `<div class="pens">${list.map(p => {
    const cf = currentFill(p.id), ci = cf && byId(S.inks, cf.inkId);
    return `<button class="pen-card" data-open="${esc(p.id)}">
      <span class="pc-img">${p.photos?.pen ? `<img data-img="${esc(p.photos.pen)}" alt="">` : `<span class="ph">${I.pen}</span>`}</span>
      <span class="pc-b"><b>${esc(penTitle(p))}</b><small>${esc([p.nibSize && p.nibSize + ' nib', p.nibMaterial, p.material].filter(Boolean).join(' · '))}</small>
      <span class="pc-ink">${ci ? `<i class="dot" style="background:${esc(inkColor(ci))}"></i>${esc(ci.name)}` : '<span class="muted">Empty</span>'}${u.pen[p.id] ? `<span class="muted"> · ${u.pen[p.id]} fills</span>` : ''}</span></span></button>`;
  }).join('')}</div>`;
  $$('[data-open]', res).forEach(b => b.onclick = () => showPen(b.dataset.open));
  hydrate(res);
}

function showPen(id) {
  const render = mm => {
    const p = byId(S.pens, id);
    if (!p || p.deleted) { closeModal(); return; }
    const hist = live(S.fills).filter(f => f.penId === id).sort((a, b) => cmp(b.start, a.start));
    const cf = currentFill(id), ci = cf && byId(S.inks, cf.inkId);
    const inkCounts = {}; hist.forEach(f => inkCounts[f.inkId] = (inkCounts[f.inkId] || 0) + 1);
    const ph = p.photos || {};
    mm.el.querySelector('.sheet').innerHTML = `
      <div class="mh"><div><h2>${esc(penTitle(p))}</h2><p class="sub">${esc([p.nibSize && p.nibSize + ' nib', p.nibMaterial].filter(Boolean).join(' · '))}</p></div><button class="icon-btn" data-close aria-label="Close">${I.x}</button></div>
      <div class="mb detail">
        <div class="photos">
          ${ph.pen ? `<button class="ph-main pen" data-lb="${esc(ph.pen)}"><img data-img="${esc(ph.pen)}" alt="Pen"></button>` : ''}
          ${ph.writing ? `<button class="ph-wr" data-lb="${esc(ph.writing)}"><img data-img="${esc(ph.writing)}" alt="Writing sample"></button>` : ''}
        </div>
        <div class="now" style="--ink:${esc(ci ? inkColor(ci) : 'transparent')}">
          ${ci ? `<button class="now-ink" data-ink="${esc(ci.id)}"><span class="dot xl" style="background:${esc(inkColor(ci))}">${ci.photos?.swatch ? `<img data-img="${esc(ci.photos.swatch)}" alt="">` : ''}</span><span><small>Inked with</small><b>${esc(ci.name)}</b><small>${esc(ci.brand)} · since ${esc(fmtDate(cf.start))} (${daysSince(cf.start)} d)</small></span></button>` : '<p class="muted">Empty — not inked right now.</p>'}
          ${RO ? '' : `<div class="row wrap">${ci ? `<button class="btn small" id="pRefill">${I.refill}Refill</button><button class="btn small" id="pChange">Change ink</button><button class="btn small ghost" id="pClean">${I.clean}Clean</button>` : `<button class="btn small primary" id="pFill">${I.refill}Ink this pen</button>`}</div>`}
        </div>
        <dl class="facts">
          ${[['Brand', p.brand], ['Model', p.model], ['Nib size', p.nibSize], ['Nib material', p.nibMaterial], ['Pen material', p.material], ['Finish / colour', p.finish], ['Filling system', p.filling], ['Care', p.careful ? 'Vintage / handle with care' : ''], ['Purchase', purchaseText(p)], ['Status', PEN_STATUS.find(s => s[0] === (p.status || 'owned'))?.[1]], ['Fills', hist.length]].filter(x => x[1] !== '' && x[1] != null).map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}
        </dl>
        ${p.notes ? `<p class="notes">${esc(p.notes)}</p>` : ''}
        ${hist.length ? `<h3 class="h3">Inks used in this pen</h3><div class="chips-row">${Object.entries(inkCounts).sort((a, b) => b[1] - a[1]).map(([i, n]) => { const ink = byId(S.inks, i); return `<button class="pill" data-ink="${esc(i)}"><i class="dot" style="background:${esc(inkColor(ink))}"></i>${esc(ink?.name || 'Unknown')} <b>${n}×</b></button>`; }).join('')}</div>
        <h3 class="h3">History</h3><ul class="hist">${hist.map(f => { const ink = byId(S.inks, f.inkId); return `<li><span class="dot" style="background:${esc(inkColor(ink))}"></span><span><b>${esc(ink ? inkTitle(ink) : 'Unknown ink')}</b><small>${esc(fmtDate(f.start))} → ${f.end ? esc(fmtDate(f.end)) + (f.endReason ? ` (${esc(f.endReason)})` : '') : '<b>now</b>'}${f.note ? ` · ${esc(f.note)}` : ''}</small></span>${RO ? '' : `<button class="icon-btn sm" data-delfill="${esc(f.id)}" aria-label="Delete this entry">${I.x}</button>`}</li>`; }).join('')}</ul>` : ''}
      </div>
      ${RO ? '' : `<div class="mf"><span></span><button class="btn" id="ePen">${I.edit}Edit pen</button></div>`}`;
    const el = mm.el;
    $$('[data-close]', el).forEach(b => b.onclick = () => closeModal());
    $$('[data-lb]', el).forEach(b => b.onclick = () => lightbox(b.dataset.lb));
    $$('[data-ink]', el).forEach(b => b.onclick = () => showInk(b.dataset.ink));
    $$('[data-delfill]', el).forEach(b => b.onclick = async () => { if (await confirmBox('Delete this fill from the history?')) await deleteRec('fill', byId(S.fills, b.dataset.delfill)); });
    $('#pRefill', el) && ($('#pRefill', el).onclick = () => refill(cf.id));
    $('#pClean', el) && ($('#pClean', el).onclick = () => clean(cf.id));
    $('#pChange', el) && ($('#pChange', el).onclick = () => inkAPen({ penId: id }));
    $('#pFill', el) && ($('#pFill', el).onclick = () => inkAPen({ penId: id }));
    $('#ePen', el) && ($('#ePen', el).onclick = () => editPen(byId(S.pens, id)));
    hydrate(el);
  };
  const m = openModal('', { refresh: mm => render(mm), wide: true });
  render(m);
}

function editPen(pen) {
  const isNew = !pen;
  const d = pen ? JSON.parse(JSON.stringify(pen)) : { id: uid('p'), brand: '', model: '', nibSize: '', nibMaterial: '', material: '', finish: '', filling: '', status: 'owned', notes: '', photos: {} };
  d.photos ||= {};
  const pending = {};
  const uniq = (k, base) => [...new Set([...base, ...live(S.pens).map(p => p[k]).filter(Boolean)])].sort(cmp);
  const dl = (id, arr) => `<datalist id="${id}">${arr.map(v => `<option value="${esc(v)}">`).join('')}</datalist>`;
  const m = openModal(`
    <div class="mh"><h2>${isNew ? 'Add pen' : 'Edit pen'}</h2><button class="icon-btn" data-close aria-label="Close">${I.x}</button></div>
    <form class="mb form" id="penF" autocomplete="off">
      <div class="ph-edit"><div class="ph-slots two" id="slots"></div></div>
      <div class="row2"><label class="lbl">Brand<input name="brand" list="dlPB" required value="${esc(d.brand)}"></label><label class="lbl">Model<input name="model" value="${esc(d.model)}" placeholder="e.g. Custom 74"></label></div>
      <div class="lbl">Nib size<div class="chips" id="ns">${uniq('nibSize', NIB_SIZES).map(v => `<button type="button" class="chip" data-v="${esc(v)}">${esc(v)}</button>`).join('')}</div><input name="nibSize" value="${esc(d.nibSize)}" placeholder="or type another…"></div>
      <div class="row2"><label class="lbl">Nib material<input name="nibMaterial" list="dlNM" value="${esc(d.nibMaterial)}"></label><label class="lbl">Pen material<input name="material" list="dlPM" value="${esc(d.material)}"></label></div>
      <div class="row2"><label class="lbl">Finish / colour<input name="finish" value="${esc(d.finish)}"></label><label class="lbl">Filling system<input name="filling" list="dlFS" value="${esc(d.filling)}"></label></div>
      <label class="lbl">Status<select name="status">${PEN_STATUS.map(([k, n]) => `<option value="${k}" ${d.status === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="switch"><input type="checkbox" name="careful" ${d.careful ? 'checked' : ''}><span>Vintage / handle with care <small class="muted">— warns before shimmer or iron gall inks</small></span></label>
      ${purchaseFields(d, 'pen')}
      <label class="lbl">Notes<textarea name="notes" rows="3">${esc(d.notes)}</textarea></label>
      ${dl('dlPB', uniq('brand', []))}${dl('dlNM', uniq('nibMaterial', NIB_MATERIALS))}${dl('dlPM', uniq('material', PEN_MATERIALS))}${dl('dlFS', uniq('filling', FILLING))}
    </form>
    <div class="mf">${isNew ? '<span></span>' : `<button class="btn danger ghost" id="del">Delete</button>`}<button class="btn primary" id="save">Save</button></div>`, {
    wide: true, onClose: () => Object.values(pending).forEach(p => URL.revokeObjectURL(p.url)),
  });
  const el = m.el, form = $('#penF', el);
  bindPurchase(el, d);
  const drawNS = () => $$('#ns .chip', el).forEach(b => b.classList.toggle('on', b.dataset.v === form.nibSize.value));
  $$('#ns .chip', el).forEach(b => b.onclick = () => { form.nibSize.value = form.nibSize.value === b.dataset.v ? '' : b.dataset.v; drawNS(); });
  form.nibSize.oninput = drawNS; drawNS();
  function drawSlots() {
    const slot = (k, label) => {
      const src = pending[k]?.url, has = src || d.photos[k];
      return `<div class="slot ${k}"><span class="slot-l">${label}</span>${has ? `<img ${src ? `src="${src}"` : `data-img="${esc(d.photos[k])}"`} alt="">` : `<span class="slot-e">${I.camera}</span>`}<span class="slot-btns">${CAN_CAMERA ? `<button type="button" class="slot-btn" data-add="${k}" data-src="camera" aria-label="Take photo">${I.camera}</button>` : ''}<button type="button" class="slot-btn" data-add="${k}" data-src="gallery" aria-label="${CAN_CAMERA ? 'From gallery' : 'Choose image'}">${I.image}${CAN_CAMERA ? '' : (has ? 'Replace' : 'Choose image')}</button></span>${has ? `<button type="button" class="icon-btn sm rm" data-rm="${k}" aria-label="Remove ${label}">${I.x}</button>` : ''}</div>`;
    };
    $('#slots', el).innerHTML = slot('pen', 'Pen') + slot('writing', 'Writing sample');
    $$('[data-rm]', el).forEach(b => b.onclick = () => { const k = b.dataset.rm; if (pending[k]) { URL.revokeObjectURL(pending[k].url); delete pending[k]; } else d.photos[k] = null; drawSlots(); });
    $$('[data-add]', el).forEach(b => b.onclick = async () => {
      const k = b.dataset.add; const file = await pickFile(b.dataset.src); if (!file) return;
      const r = await openEditor({ file, mode: 'photo', title: k === 'pen' ? 'Pen photo' : 'Writing sample' });
      if (!r) return;
      if (pending[k]) URL.revokeObjectURL(pending[k].url);
      pending[k] = { blob: r.image, url: URL.createObjectURL(r.image) }; drawSlots();
    });
    hydrate(el);
  }
  drawSlots();
  $('#save', el).onclick = async () => {
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    for (const k of ['brand', 'model', 'nibSize', 'nibMaterial', 'material', 'finish', 'filling', 'status', 'notes']) d[k] = String(fd.get(k) || '').trim();
    d.careful = !!fd.get('careful');
    readPurchase(d, fd, el);
    for (const [k, p] of Object.entries(pending)) { trashImage(pen?.photos?.[k]); d.photos[k] = await storeImage(p.blob); }
    for (const k of Object.keys(d.photos)) if (!d.photos[k]) { trashImage(pen?.photos?.[k]); delete d.photos[k]; }
    await saveRec('pen', d);
    closeModal(); toast(isNew ? 'Pen added' : 'Saved');
  };
  $('#del', el) && ($('#del', el).onclick = async () => {
    if (!(await confirmBox(`Delete ${penTitle(d)}? Tip: to keep its ink history, set the status to "Sold / given away" instead.`))) return;
    const cf = currentFill(d.id); if (cf) await saveRec('fill', { ...cf, end: today(), endReason: 'cleaned' });
    await deleteRec('pen', pen); closeModal(); closeModal();
  });
}

// ───────────────────────── view: Stats ─────────────────────────
function viewStats(m) {
  // scope: all inks, bottles only or samples only
  let scope = 'all'; try { scope = localStorage.getItem('ink.statsScope') || 'all'; } catch (e) {}
  const inScope = i => scope === 'all' || i?.size === scope;
  const inks = live(S.inks).filter(inScope), pens = live(S.pens);
  const fills = live(S.fills).filter(f => inScope(byId(S.inks, f.inkId)));
  const u = usage(fills);
  const scopeName = { all: 'inks', bottle: 'bottles', sample: 'samples' }[scope];
  const bars = (rows, max) => `<ol class="bars">${rows.map(r => `<li><button class="bar-l" ${r.ink ? `data-ink="${esc(r.ink)}"` : r.pen ? `data-pen="${esc(r.pen)}"` : ''}><i class="dot" style="background:${esc(r.color || 'var(--muted)')}"></i><span>${r.label}</span></button><span class="bar"><i style="width:${Math.max(3, r.n / max * 100)}%;background:${esc(r.color || 'var(--accent)')}"></i></span><b>${r.n}</b></li>`).join('')}</ol>`;
  const topInks = Object.entries(u.ink).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, n]) => { const i = byId(S.inks, id); return { ink: id, n, color: inkColor(i), label: `${esc(i?.name || 'Unknown')} <small>${esc(i?.brand || '')}</small>` }; });
  const topPens = Object.entries(u.pen).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, n]) => { const p = byId(S.pens, id); return { pen: id, n, label: esc(penTitle(p)) }; });
  const pairs = Object.entries(u.pair).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => { const [p, i] = k.split('|'); const ink = byId(S.inks, i); return { ink: i, n, color: inkColor(ink), label: `${esc(ink?.name || '?')} <small>in ${esc(penTitle(byId(S.pens, p)))}</small>` }; });
  const cg = {}; inks.forEach(i => cg[i.colourGroup || 'Not set'] = (cg[i.colourGroup || 'Not set'] || 0) + 1);
  const cgRows = Object.entries(cg).sort((a, b) => b[1] - a[1]).map(([c, n]) => ({ n, color: COLOUR_HEX[c] || '#bbb', label: esc(c) }));
  const br = {}; inks.forEach(i => br[i.brand] = (br[i.brand] || 0) + 1);
  const brRows = Object.entries(br).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c, n]) => ({ n, label: esc(c) }));
  const never = inks.filter(i => !u.ink[i.id] && (i.status || 'owned') === 'owned').length;
  const finished = inks.reduce((n, i) => n + (i.finished?.length || (i.status === 'empty' ? 1 : 0)), 0); // every finished bottle/sample counts
  const inkedNow = fills.filter(f => !f.end).length;
  const recent = fills.slice().sort((a, b) => cmp(b.start, a.start)).slice(0, 12);
  m.innerHTML = `
    <header class="vh"><div><h1>Stats</h1><p class="sub">${plural(fills.length, 'fill')} recorded${scope === 'all' ? '' : ` with ${scopeName}`}</p></div></header>
    <div class="seg scope" role="group" aria-label="Show stats for">${[['all', 'All'], ['bottle', 'Bottles'], ['sample', 'Samples']].map(([k, n]) => `<button data-scope="${k}" class="${scope === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    <div class="tiles">
      <div class="st"><b>${inks.length}</b><span>${scopeName}</span><small>${scope === 'all' ? `${inks.filter(i => i.size === 'bottle').length} bottles · ${inks.filter(i => i.size === 'sample').length} samples` : `${inks.filter(i => (i.status || 'owned') === 'owned').length} in collection`}</small></div>
      <div class="st"><b>${Object.keys(br).length}</b><span>brands</span></div>
      <div class="st"><b>${pens.length}</b><span>pens</span><small>${inkedNow} inked${scope === 'all' ? '' : ` with ${scopeName}`} now</small></div>
      <button class="st" id="neverBtn"><b>${never}</b><span>never used</span><small>show them →</small></button>
      <button class="st" id="finBtn"><b>${finished}</b><span>finished</span><small>show them →</small></button>
    </div>
    <section class="card ot" id="ot"></section>
    <div class="cols">
      <section class="card"><h2 class="h2">Most used inks</h2>${topInks.length ? bars(topInks, topInks[0].n) : '<p class="muted">Ink a pen to start counting.</p>'}</section>
      <section class="card"><h2 class="h2">Most used pens</h2>${topPens.length ? bars(topPens, topPens[0].n) : '<p class="muted">No fills yet.</p>'}</section>
      <section class="card"><h2 class="h2">Favourite pairings</h2>${pairs.length ? bars(pairs, pairs[0].n) : '<p class="muted">No fills yet.</p>'}</section>
      <section class="card"><h2 class="h2">Colour groups</h2>${bars(cgRows, Math.max(...cgRows.map(r => r.n), 1))}</section>
      <section class="card"><h2 class="h2">Top brands</h2>${bars(brRows, Math.max(...brRows.map(r => r.n), 1))}</section>
      <section class="card"><h2 class="h2">Spending</h2>${spendingHTML(inks, scope)}</section>
      <section class="card"><h2 class="h2">Recent fills</h2>${recent.length ? `<ul class="hist">${recent.map(f => { const i = byId(S.inks, f.inkId); return `<li><span class="dot" style="background:${esc(inkColor(i))}"></span><span><b>${esc(i?.name || '?')}</b><small>${esc(penTitle(byId(S.pens, f.penId)))} · ${esc(fmtDate(f.start))}</small></span></li>`; }).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}</section>
    </div>`;
  $$('[data-ink]', m).forEach(b => b.onclick = () => showInk(b.dataset.ink));
  $$('[data-pen]', m).forEach(b => b.onclick = () => showPen(b.dataset.pen));
  const sizeF = scope === 'all' ? [] : [scope];
  $('#neverBtn', m).onclick = () => { F.inks = { ...JSON.parse(JSON.stringify(DEF_F.inks)), usage: 'never', status: ['owned'], size: sizeF, layout: F.inks.layout }; saveF(); location.hash = 'inks'; };
  $('#finBtn', m).onclick = () => { F.inks = { ...JSON.parse(JSON.stringify(DEF_F.inks)), status: ['empty'], size: sizeF, layout: F.inks.layout }; saveF(); location.hash = 'inks'; };
  $$('[data-scope]', m).forEach(b => b.onclick = () => { try { localStorage.setItem('ink.statsScope', b.dataset.scope); } catch (e) {} viewStats(m); });
  drawOverTime($('#ot', m), fills);
}


// ───────────────────────── purchase details ─────────────────────────
const ACQ = [['bought', 'Bought'], ['gift', 'Gift'], ['free', 'Free']];
const money = v => `${S.prefs.currency || '€'}${Number(v || 0).toFixed(2).replace(/\.00$/, '')}`;
function purchaseFields(d, kind) {
  const shops = [...new Set([...live(S.inks), ...live(S.pens)].map(x => x.shop).filter(Boolean))].sort(cmp);
  return `<fieldset class="purchase"><legend>Purchase</legend>
    <div class="seg wide" id="acq">${ACQ.map(([k, n]) => `<button type="button" data-v="${k}">${n}</button>`).join('')}</div>
    <div class="row3 pur-row">
      <label class="lbl">Date<input type="date" name="purchaseDate" value="${esc(d.purchaseDate || '')}"></label>
      <label class="lbl" id="shopL">Shop / from<input name="shop" list="dlShop" value="${esc(d.shop || '')}" placeholder="${kind === 'ink' ? 'e.g. Fontoplumo' : 'e.g. Appelboom'}"></label>
      <label class="lbl" id="priceL">Price (${esc(S.prefs.currency || '€')})<input name="price" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(d.price ?? '')}"></label>
    </div><datalist id="dlShop">${shops.map(s => `<option value="${esc(s)}">`).join('')}</datalist></fieldset>`;
}
function bindPurchase(el, d) {
  const draw = () => {
    $$('#acq button', el).forEach(b => b.classList.toggle('on', b.dataset.v === d.acquired));
    $('#priceL', el).hidden = d.acquired === 'gift' || d.acquired === 'free';
    $('#shopL', el).firstChild.textContent = d.acquired === 'gift' ? 'From (who gave it)' : 'Shop / from';
  };
  $$('#acq button', el).forEach(b => b.onclick = () => { d.acquired = d.acquired === b.dataset.v ? '' : b.dataset.v; draw(); });
  draw();
}
function readPurchase(d, fd) {
  d.purchaseDate = fd.get('purchaseDate') || '';
  d.shop = String(fd.get('shop') || '').trim();
  d.price = d.acquired === 'bought' || !d.acquired ? (fd.get('price') === '' || fd.get('price') == null ? null : Math.max(0, Number(fd.get('price')))) : 0;
  if (d.price != null && !d.acquired) d.acquired = 'bought';
}
function purchaseText(d) {
  if (!d.acquired && !d.purchaseDate && !d.shop && d.price == null) return '';
  const bits = [];
  bits.push(d.acquired === 'gift' ? `Gift${d.shop ? ' from ' + d.shop : ''}` : d.acquired === 'free' ? `Free${d.shop ? ' · ' + d.shop : ''}` : `Bought${d.shop ? ' at ' + d.shop : ''}`);
  if (d.purchaseDate) bits.push(fmtDate(d.purchaseDate));
  if ((d.acquired === 'bought' || !d.acquired) && d.price != null) bits.push(money(d.price));
  return bits.join(' · ');
}

// ───────────────────────── colour similarity ─────────────────────────
const deltaE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function similarInks(hex, excludeId = null, n = 6) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return [];
  const t = hexToLab(hex);
  return live(S.inks).filter(i => i.id !== excludeId && /^#[0-9a-f]{6}$/i.test(i.hex || ''))
    .map(i => ({ i, d: deltaE(t, hexToLab(i.hex)) })).filter(x => x.d < 25).sort((a, b) => a.d - b.d).slice(0, n);
}
const simLabel = d => d < 5 ? 'Nearly identical' : d < 10 ? 'Very close' : d < 17 ? 'Close' : 'Similar';
function similarList(list) {
  return `<div class="sim">${list.map(({ i, d }) => `<button class="sim-i" data-ink="${esc(i.id)}"><span class="dot lg" style="background:${esc(inkColor(i))}">${i.photos?.swatch ? `<img data-img="${esc(i.photos.swatch)}" alt="">` : ''}</span><span><b>${esc(i.name)}</b><small>${esc(i.brand)} · ${simLabel(d)}${i.status === 'empty' ? ' · finished' : ''}</small></span></button>`).join('')}</div>`;
}
function colourCheck() {
  const measured = live(S.inks).filter(i => /^#[0-9a-f]{6}$/i.test(i.hex || '')).length;
  const m = openModal(`
    <div class="mh"><div><h2>Do I already have this colour?</h2><p class="sub">Photograph a swatch (e.g. in a shop) or pick a colour</p></div><button class="icon-btn" data-close aria-label="Close">${I.x}</button></div>
    <div class="mb">
      <div class="row wrap">${photoBtns('cc')}<label class="btn">${I.pipette}Pick colour<input type="color" id="ccPick" value="#2c55a8" class="vh-input"></label></div>
      <div id="ccRes" class="cc-res"><p class="muted">${measured} of your inks have a measured colour (from a scanned swatch, or one you set). Only those can be compared.</p></div>
    </div>`, { wide: true });
  const el = m.el;
  const show = hex => {
    const list = similarInks(hex, null, 8);
    $('#ccRes', el).innerHTML = `<div class="cc-chosen"><span class="dot xl" style="background:${esc(hex)}"></span><span><b>${esc(hex)}</b><small>${esc(suggestGroup(hex))}</small></span></div>`
      + (list.length ? `<h3 class="h3">Closest inks you own</h3>${similarList(list)}` : '<p class="muted">Nothing close in your collection — no near-duplicate.</p>')
      + `<p class="muted small">Based on ${measured} inks with a measured colour.</p>`;
    $$('[data-ink]', el).forEach(b => b.onclick = () => showInk(b.dataset.ink));
    hydrate(el);
  };
  $$('[data-photo="cc"]', el).forEach(b => b.onclick = async () => {
    const file = await pickFile(b.dataset.src); if (!file) return;
    const r = await openEditor({ file, mode: 'photo', title: 'Crop to the ink' });
    if (r) show(r.hex);
  });
  $('#ccPick', el).oninput = e => show(e.target.value);
}

// ───────────────────────── what should I ink next? ─────────────────────────
function suggestInk() {
  const st = { colour: '', size: 'all', picks: [] };
  const m = openModal(`
    <div class="mh"><div><h2>What should I ink next?</h2><p class="sub">Inks you haven't used in a while — or never</p></div><button class="icon-btn" data-close aria-label="Close">${I.x}</button></div>
    <div class="mb">
      <div class="chips" id="sgC"><button class="chip" data-c="">Any colour</button>${COLOURS.map(([c, h]) => `<button class="chip" data-c="${esc(c)}"><i class="dot" style="background:${h}"></i>${esc(c)}</button>`).join('')}</div>
      <div class="seg scope" id="sgS">${[['all', 'All'], ['bottle', 'Bottles'], ['sample', 'Samples']].map(([k, n]) => `<button data-s="${k}">${n}</button>`).join('')}</div>
      <div id="sgR"></div>
    </div>
    <div class="mf"><span class="muted small" id="sgN"></span><button class="btn" id="sgAgain">${I.spark}Other suggestions</button></div>`, { wide: true });
  const el = m.el;
  function pick() {
    const u = usage(), inPen = new Set(activeFills().map(f => f.inkId));
    const pool = live(S.inks).filter(i => (i.status || 'owned') === 'owned' && !inPen.has(i.id)
      && (!st.colour || i.colourGroup === st.colour) && (st.size === 'all' || i.size === st.size))
      .map(i => ({ i, age: u.inkLast[i.id] ? daysSince(u.inkLast[i.id]) : Infinity, r: Math.random() }))
      .sort((a, b) => (b.age - a.age) || (a.r - b.r));
    const top = pool.slice(0, Math.max(3, Math.ceil(pool.length * 0.3)));
    for (let k = top.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [top[k], top[j]] = [top[j], top[k]]; }
    st.picks = top.slice(0, 3).sort((a, b) => b.age - a.age);
    $('#sgN', el).textContent = `${pool.length} inks match`;
    draw();
  }
  function draw() {
    $$('#sgC .chip', el).forEach(b => b.classList.toggle('on', b.dataset.c === st.colour));
    $$('#sgS button', el).forEach(b => b.classList.toggle('on', b.dataset.s === st.size));
    $('#sgR', el).innerHTML = st.picks.length ? `<div class="sg-list">${st.picks.map(({ i, age }) => `
      <article class="sg-card" style="--ink:${esc(inkColor(i))}">
        <button class="sg-sw" data-ink="${esc(i.id)}">${i.photos?.swatch ? `<img data-img="${esc(i.photos.swatch)}" alt="">` : ''}</button>
        <div class="sg-b"><b>${esc(i.name)}</b><small>${esc(i.brand)}${i.collection ? ' · ' + esc(i.collection) : ''}</small>
          <span class="tag">${age === Infinity ? 'Never used' : `Last used ${age < 60 ? plural(age, 'day') : plural(Math.round(age / 30), 'month')} ago`}</span>
          <button class="btn small primary" data-use="${esc(i.id)}">${I.refill}Ink a pen</button></div></article>`).join('')}</div>`
      : '<p class="muted pad">No inks match — try another colour.</p>';
    $$('[data-ink]', el).forEach(b => b.onclick = () => showInk(b.dataset.ink));
    $$('[data-use]', el).forEach(b => b.onclick = () => { const id = b.dataset.use; closeModal(); setTimeout(() => inkAPen({ inkId: id }), 50); });
    hydrate(el);
  }
  $$('#sgC .chip', el).forEach(b => b.onclick = () => { st.colour = b.dataset.c; pick(); });
  $$('#sgS button', el).forEach(b => b.onclick = () => { st.size = b.dataset.s; pick(); });
  $('#sgAgain', el).onclick = pick;
  pick();
}

// ───────────────────────── compare swatches ─────────────────────────
function compareInks(ids) {
  const inks = ids.map(id => byId(S.inks, id)).filter(Boolean);
  const u = usage();
  const pairs = [];
  for (let a = 0; a < inks.length; a++) for (let b = a + 1; b < inks.length; b++) if (inks[a].hex && inks[b].hex) pairs.push(`${esc(inks[a].name)} ↔ ${esc(inks[b].name)}: ${simLabel(deltaE(hexToLab(inks[a].hex), hexToLab(inks[b].hex)))}`);
  openModal(`
    <div class="mh"><h2>Compare</h2><button class="icon-btn" data-close aria-label="Close">${I.x}</button></div>
    <div class="mb"><div class="cmp n${inks.length}">${inks.map(i => `
      <div class="cmp-c">
        <button class="cmp-sw" style="background:${esc(inkColor(i))}" data-lb="${esc(i.photos?.swatch || '')}">${i.photos?.swatch ? `<img data-img="${esc(i.photos.swatch)}" alt="">` : ''}</button>
        <div class="cmp-wr">${i.photos?.writing ? `<img data-img="${esc(i.photos.writing)}" alt="">` : '<span class="muted small">No writing sample</span>'}</div>
        <b>${esc(i.name)}</b><small>${esc(i.brand)}${i.collection ? ' · ' + esc(i.collection) : ''}</small>
        <small>${esc(i.colourGroup || '—')}${i.hex ? ' · ' + esc(i.hex) : ''}</small>
        <span class="t-m">${PROPS.filter(([k]) => i[k]).map(([, n]) => `<i class="tag">${esc(n)}</i>`).join('')}</span>
        <small>${i.size === 'sample' ? 'Sample' : 'Bottle'} · used ${u.ink[i.id] || 0}×</small>
      </div>`).join('')}</div>
      ${pairs.length ? `<p class="muted small cmp-note">${pairs.join('<br>')}</p>` : ''}</div>`, { wide: true, cls: 'cmpm' });
  const el = topModal().el;
  $$('[data-lb]', el).forEach(b => b.onclick = () => b.dataset.lb && lightbox(b.dataset.lb));
}


// ───────────────────────── stats: usage over time & spending ─────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_L = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function drawOverTime(box, fills) {
  const now = new Date();
  const P = S.period ||= { mode: 'year', y: now.getFullYear(), m: now.getMonth() };
  const inP = f => { const y = +f.start.slice(0, 4), mo = +f.start.slice(5, 7) - 1; return y === P.y && (P.mode === 'year' || mo === P.m); };
  const list = fills.filter(f => f.start && inP(f));
  const groupOf = f => byId(S.inks, f.inkId)?.colourGroup || 'Not set';
  const order = [...COLOURS.map(c => c[0]), 'Not set'];
  const colOf = g => COLOUR_HEX[g] || '#b9b4a8';
  // columns: months of the year, or days of the month
  const nCols = P.mode === 'year' ? 12 : new Date(P.y, P.m + 1, 0).getDate();
  const cols = Array.from({ length: nCols }, () => ({}));
  for (const f of list) { const k = P.mode === 'year' ? +f.start.slice(5, 7) - 1 : +f.start.slice(8, 10) - 1; const g = groupOf(f); cols[k][g] = (cols[k][g] || 0) + 1; }
  const tot = c => Object.values(c).reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...cols.map(tot));
  const colLabel = k => P.mode === 'year' ? MONTHS[k] : String(k + 1);
  const chart = `<div class="tchart ${P.mode}" role="img" aria-label="Fills per ${P.mode === 'year' ? 'month' : 'day'}">
    <div class="tc-grid"><span>${max}</span><span>${Math.round(max / 2)}</span><span>0</span></div>
    <div class="tc-bars">${cols.map((c, k) => { const t = tot(c); const tip = `${colLabel(k)}${P.mode === 'month' ? ' ' + MONTHS[P.m] : ''}: ${plural(t, 'fill')}${t ? ' — ' + order.filter(g => c[g]).map(g => `${g} ${c[g]}`).join(', ') : ''}`;
      return `<div class="tc-col" title="${esc(tip)}" ${P.mode === 'year' ? `data-month="${k}"` : ''}><div class="tc-stack" style="height:${t / max * 100}%">${order.filter(g => c[g]).map(g => `<i style="flex:${c[g]};background:${colOf(g)}"></i>`).join('')}</div><span class="tc-x">${P.mode === 'year' || (k + 1) % 5 === 0 || k === 0 ? colLabel(k) : ''}</span></div>`; }).join('')}</div></div>`;
  const cg = {}; list.forEach(f => { const g = groupOf(f); cg[g] = (cg[g] || 0) + 1; });
  const legend = order.filter(g => cg[g]).map(g => `<span class="lg-i"><i class="dot" style="background:${colOf(g)}"></i>${esc(g)} <b>${cg[g]}</b></span>`).join('');
  const u = usage(list);
  const rows = (obj, mk) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 6).map(mk);
  const mini = (title, rs) => `<div><h3 class="h3">${title}</h3>${rs.length ? `<ol class="bars">${rs.map(r => `<li><button class="bar-l" ${r.attr}><i class="dot" style="background:${esc(r.color)}"></i><span>${r.label}</span></button><span class="bar"><i style="width:${Math.max(4, r.n / rs[0].n * 100)}%;background:${esc(r.bar || r.color)}"></i></span><b>${r.n}</b></li>`).join('')}</ol>` : '<p class="muted">—</p>'}</div>`;
  const pensR = rows(u.pen, ([id, n]) => ({ n, attr: `data-pen="${esc(id)}"`, color: 'var(--muted)', bar: 'var(--accent)', label: esc(penTitle(byId(S.pens, id))) }));
  const inksR = rows(u.ink, ([id, n]) => { const i = byId(S.inks, id); return { n, attr: `data-ink="${esc(id)}"`, color: inkColor(i), label: `${esc(i?.name || '?')} <small>${esc(i?.brand || '')}</small>` }; });
  const label = P.mode === 'year' ? String(P.y) : `${MONTHS_L[P.m]} ${P.y}`;
  box.innerHTML = `
    <div class="ot-head"><h2 class="h2">Usage over time</h2>
      <div class="seg" id="otMode"><button data-m="month" class="${P.mode === 'month' ? 'on' : ''}">Month</button><button data-m="year" class="${P.mode === 'year' ? 'on' : ''}">Year</button></div>
      <div class="ot-nav"><button class="icon-btn" id="otPrev" aria-label="Previous">‹</button><b>${label}</b><button class="icon-btn" id="otNext" aria-label="Next">›</button></div></div>
    <p class="sub">${plural(list.length, 'fill')} in ${label}${list.length ? ` · ${Object.keys(u.ink).length} different inks · ${Object.keys(u.pen).length} pens` : ''}</p>
    ${chart}
    ${legend ? `<div class="lg">${legend}</div>` : ''}
    <div class="ot-cols">${mini('Pens used most', pensR)}${mini('Inks used most', inksR)}</div>`;
  $$('#otMode button', box).forEach(b => b.onclick = () => { P.mode = b.dataset.m; drawOverTime(box, fills); });
  $('#otPrev', box).onclick = () => { if (P.mode === 'year') P.y--; else if (--P.m < 0) { P.m = 11; P.y--; } drawOverTime(box, fills); };
  $('#otNext', box).onclick = () => { if (P.mode === 'year') P.y++; else if (++P.m > 11) { P.m = 0; P.y++; } drawOverTime(box, fills); };
  $$('[data-month]', box).forEach(c => c.onclick = () => { P.mode = 'month'; P.m = +c.dataset.month; drawOverTime(box, fills); });
  $$('[data-ink]', box).forEach(b => b.onclick = () => showInk(b.dataset.ink));
  $$('[data-pen]', box).forEach(b => b.onclick = () => showPen(b.dataset.pen));
}
function spendingHTML(inks, scope) {
  const items = [...inks.map(i => ({ ...i, kind: 'ink' })), ...(scope === 'all' ? live(S.pens).map(p => ({ ...p, kind: 'pen' })) : [])];
  const paid = items.filter(x => (x.acquired === 'bought' || !x.acquired) && x.price != null && x.price !== '');
  const gifts = items.filter(x => x.acquired === 'gift').length, free = items.filter(x => x.acquired === 'free').length;
  if (!paid.length && !gifts && !free) return '<p class="muted">Add purchase details (Edit → Purchase) to inks and pens to see what you spend.</p>';
  const sum = a => a.reduce((n, x) => n + Number(x.price || 0), 0);
  const inkSum = sum(paid.filter(x => x.kind === 'ink')), penSum = sum(paid.filter(x => x.kind === 'pen'));
  const byYear = {}; paid.forEach(x => { const y = x.purchaseDate ? x.purchaseDate.slice(0, 4) : 'No date'; byYear[y] = (byYear[y] || 0) + Number(x.price || 0); });
  const yRows = Object.entries(byYear).sort((a, b) => cmp(b[0], a[0]));
  const byShop = {}; paid.filter(x => x.shop).forEach(x => byShop[x.shop] = (byShop[x.shop] || 0) + Number(x.price || 0));
  const sRows = Object.entries(byShop).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const mx = a => Math.max(1, ...a.map(r => r[1]));
  const bl = (rs, m) => `<ol class="bars">${rs.map(([k, v]) => `<li><span class="bar-l"><span>${esc(k)}</span></span><span class="bar"><i style="width:${Math.max(4, v / m * 100)}%;background:var(--accent)"></i></span><b class="money">${money(v)}</b></li>`).join('')}</ol>`;
  return `<div class="spend"><div><b class="big">${money(inkSum + penSum)}</b><small>${scope === 'all' ? `inks ${money(inkSum)} · pens ${money(penSum)}` : `on ${scope === 'bottle' ? 'bottles' : 'samples'}`}</small></div>
    <div><b class="big">${paid.length ? money((inkSum + penSum) / paid.length) : '—'}</b><small>average per item</small></div>
    <div><b class="big">${gifts}</b><small>gifts</small></div><div><b class="big">${free}</b><small>free</small></div></div>
    ${yRows.length ? `<h3 class="h3">By year</h3>${bl(yRows, mx(yRows))}` : ''}
    ${sRows.length ? `<h3 class="h3">Top shops</h3>${bl(sRows, mx(sRows))}` : ''}`;
}

// ───────────────────────── view: Settings ─────────────────────────
function viewSettings(m) {
  if (RO) {
    m.innerHTML = `<header class="vh"><div><h1>About</h1></div></header><section class="card prose"><p>This is a read-only view of <b>${esc(S.title)}</b>. You can browse, search and filter, but not change anything.</p><p class="muted">Inks: ${live(S.inks).length} · Pens: ${live(S.pens).length}</p></section>`;
    return;
  }
  const conf = drive.isConfigured(), signed = drive.hasToken(), mt = S.meta;
  const link = mt.catalogId ? `${location.origin}${location.pathname}?view=${mt.catalogId}` : '';
  const hasKey = !!(CFG.apiKey || localStorage.getItem('ink.apiKey'));
  m.innerHTML = `
    <header class="vh"><div><h1>Settings</h1></div></header>
    <section class="card"><h2 class="h2">Collection name</h2><div class="row"><input id="title" value="${esc(S.title)}"><button class="btn" id="titleSave">Save</button></div></section>
    <section class="card"><h2 class="h2">Google Drive sync</h2>
      ${conf ? `
        <p>${signed ? `Connected. Last sync: <b>${mt.lastSync ? esc(new Date(mt.lastSync).toLocaleString('en-GB')) : 'never'}</b>.` : 'Not signed in on this device.'} ${S.syncState === 'error' ? `<br><span class="err-t">${esc(S.syncMsg)}</span>` : ''}</p>
        <p class="muted">Everything is saved on this device first, so the app works offline. Syncing copies it to a folder called <b>Fountain Pens and Inks</b> in your Google Drive (data file + photos), and brings in changes made on your other devices.</p>
        <div class="row wrap"><button class="btn primary" id="syncNow">${I.sync}${signed ? 'Sync now' : 'Sign in & sync'}</button>${signed ? '<button class="btn ghost" id="signOut">Sign out</button>' : ''}</div>`
      : `<p>Sync is not set up yet — the collection is saved on this device only.</p><p class="muted">Follow <b>SETUP.md</b> to create a free Google Client ID (≈15 min), then paste it into <code>config.js</code> or below.</p>`}
      <details class="adv"><summary>Google keys on this device</summary>
        <label class="lbl">OAuth Client ID<input id="cid" value="${esc(localStorage.getItem('ink.clientId') || CFG.clientId || '')}" placeholder="…apps.googleusercontent.com"></label>
        <label class="lbl">API key (for the public view link)<input id="akey" value="${esc(localStorage.getItem('ink.apiKey') || CFG.apiKey || '')}" placeholder="AIza…"></label>
        <button class="btn small" id="keysSave">Save keys</button></details>
    </section>
    <section class="card"><h2 class="h2">Read-only link for others</h2>
      <label class="switch"><input type="checkbox" id="pub" ${mt.public ? 'checked' : ''} ${conf ? '' : 'disabled'}><span>Anyone with the link can view and filter (no editing)</span></label>
      ${mt.public && link ? `<div class="row"><input readonly value="${esc(link)}" id="pubLink"><button class="btn" id="copy">Copy</button></div>${hasKey ? '' : '<p class="err-t">Add the API key to config.js, otherwise the link cannot load.</p>'}<p class="muted">Viewers see your inks, pens, photos and usage — nothing else in your Drive.</p>` : `<p class="muted">${conf ? 'Turn on, then the link appears after the next sync.' : 'Needs Google Drive sync.'}</p>`}
    </section>
    <section class="card"><h2 class="h2">Cleaning reminders</h2>
      <p class="muted">Pens inked longer than this are flagged “Time to clean” on the Inked screen.</p>
      <div class="row2"><label class="lbl">Normal inks (days)<input type="number" min="1" id="cDays" value="${esc(S.prefs.cleanDays)}"></label>
      <label class="lbl">Shimmer &amp; iron gall inks (days)<input type="number" min="1" id="cDaysR" value="${esc(S.prefs.cleanDaysRisky)}"></label></div>
      <div class="row2" style="margin-top:12px"><label class="lbl">Currency symbol<input id="cur" value="${esc(S.prefs.currency)}" maxlength="4"></label><span></span></div>
      <button class="btn small" id="prefSave" style="margin-top:12px">Save</button>
    </section>
    <section class="card"><h2 class="h2">Swatch card layout</h2>
      <p class="muted">Where the swatch and writing sample sit on your cards. Adjust the boxes while scanning a card and tick “Remember box positions”.</p>
      <p>Card ratio ${esc(S.layout.aspect)} · Swatch ${S.layout.swatch.map(v => Math.round(v * 100)).join('/')} · Writing ${S.layout.writing.map(v => Math.round(v * 100)).join('/')}</p>
      <div class="row wrap"><button class="btn small" id="recropAll">Re-cut all saved cards</button><button class="btn small ghost" id="layReset">Reset to default</button></div>
      <p class="muted small">Every scan keeps the whole straightened card, so after changing the box positions you can re-cut the swatch and writing sample of all inks at once.</p>
    </section>
    <section class="card"><h2 class="h2">Your data</h2>
      <div class="row wrap"><button class="btn" id="xlsx">Export to Excel</button><button class="btn" id="bak">Download backup (.json)</button><button class="btn ghost" id="restore">Restore from backup…</button></div>
      <p class="muted">The backup file has all data but not the photos (those are in your Google Drive folder).</p>
    </section>
    <section class="card"><h2 class="h2">Install</h2><p class="muted">On Android: Chrome menu ⋮ → <b>Add to Home screen / Install app</b>. On Windows: the install icon at the right of the Chrome or Edge address bar.</p>${S.installEvt ? '<button class="btn primary" id="install">Install now</button>' : ''}</section>
    <p class="muted center small">Fountain Pens and Inks · v1.6</p>`;
  $('#titleSave', m).onclick = async () => { S.title = $('#title', m).value.trim() || 'Fountain Pens and Inks'; S.titleUpdatedAt = Date.now(); await db.setMeta('title', { title: S.title, at: S.titleUpdatedAt }); changed(); toast('Saved'); };
  $('#syncNow', m) && ($('#syncNow', m).onclick = () => sync(true));
  $('#signOut', m) && ($('#signOut', m).onclick = () => { drive.signOut(); S.syncState = 'signin'; updateSyncBadge(); renderView(); });
  $('#keysSave', m).onclick = () => {
    try { localStorage.setItem('ink.clientId', $('#cid', m).value.trim()); localStorage.setItem('ink.apiKey', $('#akey', m).value.trim()); } catch (e) {}
    drive.setConfig({ clientId: $('#cid', m).value.trim(), apiKey: $('#akey', m).value.trim() });
    if (drive.isConfigured()) drive.loadGis().catch(() => {});
    toast('Keys saved on this device'); renderView(); updateSyncBadge();
  };
  $('#pub', m).onchange = async e => { await setMeta('public', e.target.checked); renderView(); sync(true); };
  $('#copy', m) && ($('#copy', m).onclick = () => { navigator.clipboard?.writeText(link).then(() => toast('Link copied'), () => { $('#pubLink', m).select(); }); });
  $('#layReset', m).onclick = async () => { S.layout = DEFAULT_LAYOUT; S.layoutUpdatedAt = Date.now(); await db.setMeta('layout', { layout: S.layout, at: S.layoutUpdatedAt }); applyLayoutCSS(); changed(); toast('Box positions reset'); };
  $('#recropAll', m).onclick = () => recropAll();
  $('#prefSave', m).onclick = async () => { S.prefs = { ...S.prefs, cleanDays: Math.max(1, +$('#cDays', m).value || 28), cleanDaysRisky: Math.max(1, +$('#cDaysR', m).value || 14), currency: $('#cur', m).value.trim() || '€' }; S.prefsUpdatedAt = Date.now(); await db.setMeta('prefs', { prefs: S.prefs, at: S.prefsUpdatedAt }); changed(); toast('Saved'); };
  $('#xlsx', m).onclick = exportExcel;
  $('#bak', m).onclick = () => downloadBlob(new Blob([JSON.stringify(buildCatalog(), null, 1)], { type: 'application/json' }), `fountain-pens-and-inks-backup-${today()}.json`);
  $('#restore', m).onclick = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.onchange = async () => {
      try { const data = JSON.parse(await inp.files[0].text()); if (!['fountain-pens-and-inks', 'ink-catalog'].includes(data.app)) throw new Error('Not a Fountain Pens and Inks backup'); await mergeCatalog(data); changed(); toast('Backup merged'); }
      catch (e) { toast(e.message, true); }
    };
    inp.click();
  };
  $('#install', m) && ($('#install', m).onclick = () => S.installEvt.prompt());
}
async function recropAll() {
  const list = live(S.inks).filter(i => i.photos?.card);
  if (!list.length) { toast('No scanned cards yet'); return; }
  if (!(await confirmBox(`Re-cut the swatch and writing sample of ${plural(list.length, 'ink')} using the current box positions?`, 'Re-cut'))) return;
  let done = 0, failed = 0;
  for (const ink of list) {
    try {
      const blob = await imageBlob(ink.photos.card);
      if (!blob) { failed++; continue; }
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0);
      const fit = (cv, max) => { const k = Math.min(1, max / Math.max(cv.width, cv.height)); const o = document.createElement('canvas'); o.width = Math.round(cv.width * k); o.height = Math.round(cv.height * k); o.getContext('2d').drawImage(cv, 0, 0, o.width, o.height); return o; };
      const jpg = cv => new Promise(r => cv.toBlob(r, 'image/jpeg', 0.88));
      const sw = cropNorm(c, S.layout.swatch), wr = cropNorm(c, S.layout.writing);
      const d = JSON.parse(JSON.stringify(ink));
      trashImage(ink.photos.swatch); trashImage(ink.photos.writing);
      d.photos.swatch = await storeImage(await jpg(fit(sw, 700)));
      d.photos.writing = await storeImage(await jpg(fit(wr, 1400)));
      d.hex = dominantHex(sw);
      if (d.colourAuto || !d.colourGroup) { d.colourGroup = suggestGroup(d.hex); d.colourAuto = true; }
      await saveRec('ink', d);
      toast(`Re-cutting… ${++done} of ${list.length}`);
    } catch (e) { console.warn(e); failed++; }
  }
  toast(`Re-cut ${plural(done, 'card')}${failed ? ` · ${failed} couldn't be loaded (sign in to Google and try again)` : ''}`, !!failed);
}
function downloadBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function exportExcel() {
  try {
    if (!window.XLSX) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; s.onload = res; s.onerror = () => rej(new Error('Excel export needs an internet connection the first time')); document.head.appendChild(s); });
    const u = usage(); const yn = v => v ? 'Yes' : '';
    const inks = live(S.inks).sort((a, b) => cmp(a.brand, b.brand) || cmp(a.name, b.name)).map(i => ({
      Brand: i.brand, Collection: i.collection, Name: i.name, Type: i.size === 'sample' ? 'Sample' : 'Bottle', 'Size (ml)': i.ml ?? '', Quantity: i.qty || 1,
      'Colour group': i.colourGroup, Colour: i.hex, Sheen: yn(i.sheen), Shimmer: yn(i.shimmer), 'Duo-chrome': yn(i.duochrome), 'Iron gall': yn(i.ironGall), Scented: yn(i.scented),
      Status: STATUS.find(s => s[0] === (i.status || 'owned'))?.[1], 'Times used': u.ink[i.id] || 0, 'Last used': u.inkLast[i.id] || '',
      'In pen now': (u.inkPens[i.id] || []).map(p => penTitle(byId(S.pens, p))).join(', '),
      Acquired: ACQ.find(a => a[0] === i.acquired)?.[1] || '', 'Purchase date': i.purchaseDate || '', Shop: i.shop || '', Price: i.price ?? '', Notes: i.notes,
    }));
    const pens = live(S.pens).sort((a, b) => cmp(penTitle(a), penTitle(b))).map(p => {
      const cf = currentFill(p.id);
      return { Brand: p.brand, Model: p.model, 'Nib size': p.nibSize, 'Nib material': p.nibMaterial, 'Pen material': p.material, Finish: p.finish, 'Filling system': p.filling, Status: PEN_STATUS.find(s => s[0] === (p.status || 'owned'))?.[1], 'Current ink': cf ? inkTitle(byId(S.inks, cf.inkId)) : '', Fills: u.pen[p.id] || 0, Careful: p.careful ? 'Yes' : '', Acquired: ACQ.find(a => a[0] === p.acquired)?.[1] || '', 'Purchase date': p.purchaseDate || '', Shop: p.shop || '', Price: p.price ?? '', Notes: p.notes };
    });
    const fills = live(S.fills).sort((a, b) => cmp(b.start, a.start)).map(f => ({ Pen: penTitle(byId(S.pens, f.penId)), Ink: inkTitle(byId(S.inks, f.inkId)), Filled: f.start, Ended: f.end || '', 'Ended by': f.endReason || (f.end ? '' : 'in pen now'), Note: f.note || '' }));
    const wb = XLSX.utils.book_new();
    for (const [n, rows] of [['Inks', inks], ['Pens', pens], ['Fill history', fills]]) {
      const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{}]);
      ws['!cols'] = Object.keys(rows[0] || {}).map(k => ({ wch: Math.min(40, Math.max(k.length + 2, ...rows.map(r => String(r[k] ?? '').length + 1))) }));
      XLSX.utils.book_append_sheet(wb, ws, n);
    }
    XLSX.writeFile(wb, `fountain-pens-and-inks-${today()}.xlsx`);
  } catch (e) { toast(e.message, true); }
}

// ───────────────────────── boot ─────────────────────────
async function loadLocal() {
  const [inks, pens, fills, local, imageMap, layout, title] = await Promise.all([
    db.all('inks'), db.all('pens'), db.all('fills'), db.meta('local', {}), db.meta('imageMap', {}), db.meta('layout'), db.meta('title'),
  ]);
  Object.assign(S, { inks, pens, fills, meta: local || {}, imageMap: imageMap || {} });
  if (layout) { S.layout = layout.layout; S.layoutUpdatedAt = layout.at; }
  // box positions saved from an earlier default follow the new default
  const OLD = { writing: ['[0.03,0.73,0.94,0.255]', '[0.03,0.73,0.94,0.142]'], swatch: ['[0.085,0.065,0.83,0.59]'] };
  if (S.layout) for (const k of ['swatch', 'writing']) if (OLD[k].includes(JSON.stringify(S.layout[k]))) S.layout = { ...S.layout, [k]: DEFAULT_LAYOUT[k] };
  applyLayoutCSS();
  if (title) { S.title = title.title; S.titleUpdatedAt = title.at; }
  const prefs = await db.meta('prefs'); if (prefs) { S.prefs = { ...S.prefs, ...prefs.prefs }; S.prefsUpdatedAt = prefs.at; }
  if (!S.meta.seeded && !inks.length) {
    try {
      const seed = await (await fetch('seed.json')).json();
      const t = Date.now();
      seed.forEach(i => { i.createdAt = t; i.updatedAt = 0; });
      await db.putMany('inks', seed); S.inks = seed;
    } catch (e) { console.warn('seed', e); }
    await setMeta('seeded', true);
  }
}
async function loadShared() {
  const data = await (await drive.publicDownload(VIEW_ID)).json();
  Object.assign(S, { inks: data.inks || [], pens: data.pens || [], fills: data.fills || [], imageMap: data.images || {}, title: data.title || S.title });
  if (data.prefs) S.prefs = { ...S.prefs, ...data.prefs };
  if (data.layout) S.layout = data.layout;
  applyLayoutCSS();
}

async function boot() {
  drive.setConfig({ clientId: localStorage.getItem('ink.clientId') || CFG.clientId || '', apiKey: localStorage.getItem('ink.apiKey') || CFG.apiKey || '' });
  try {
    if (RO) await loadShared(); else await loadLocal();
  } catch (e) {
    document.body.innerHTML = `<div class="fatal"><h1>Could not open the collection</h1><p>${esc(e.message)}</p></div>`; return;
  }
  document.title = RO ? `${S.title} (view only)` : 'Fountain Pens and Inks';
  shell();
  window.addEventListener('hashchange', setView);
  setView();
  if (!RO) {
    if (drive.isConfigured()) { drive.loadGis().catch(() => {}); sync(false); }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && drive.hasToken()) sync(false); });
    navigator.storage?.persist?.();
    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installEvt = e; });
    setInterval(updateSyncBadge, 60000);
  }
  if ('serviceWorker' in navigator && location.protocol === 'https:' && !/claude|claudeusercontent/.test(location.host)) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
