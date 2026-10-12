// Google Drive access (drive.file scope: the app only sees files it created itself)
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_KEY = 'ink.gtoken';

let cfg = { clientId: '', apiKey: '' };
let token = null, exp = 0, tokenClient = null, gisP = null;

export function setConfig(c) { cfg = { ...cfg, ...c }; }
export function isConfigured() { return !!cfg.clientId; }

try {
  const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
  if (t && t.exp > Date.now() + 60000) { token = t.token; exp = t.exp; }
} catch (e) { /* storage unavailable */ }

export function loadGis() {
  if (gisP) return gisP;
  gisP = new Promise((res, rej) => {
    if (window.google?.accounts?.oauth2) return res();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.onload = () => res(); s.onerror = () => { gisP = null; rej(new Error('Could not load Google sign-in (offline?)')); };
    document.head.appendChild(s);
  });
  return gisP;
}

export function hasToken() { return !!token && Date.now() < exp - 60000; }

export function signIn() {
  // Must be called from a click/tap so the browser allows the Google popup.
  if (hasToken()) return Promise.resolve(token);
  if (!cfg.clientId) return Promise.reject(new Error('Google Client ID is not set (Settings → Google Drive).'));
  if (!window.google?.accounts?.oauth2) return loadGis().then(() => Promise.reject(new Error('Google sign-in was still loading — tap again.')));
  return new Promise((res, rej) => {
    if (!tokenClient) tokenClient = google.accounts.oauth2.initTokenClient({ client_id: cfg.clientId, scope: SCOPE, callback: () => {} });
    tokenClient.callback = r => {
      if (r.error) return rej(new Error(r.error_description || r.error));
      token = r.access_token; exp = Date.now() + (r.expires_in || 3600) * 1000;
      try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, exp })); localStorage.setItem('ink.gconsent', '1'); } catch (e) {}
      res(token);
    };
    tokenClient.error_callback = e => rej(new Error(e?.type === 'popup_closed' ? 'Sign-in window was closed' : (e?.message || 'Sign-in failed')));
    let consented = false; try { consented = localStorage.getItem('ink.gconsent') === '1'; } catch (e) {}
    tokenClient.requestAccessToken({ prompt: consented ? '' : 'consent' });
  });
}

export function signOut() {
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {});
  token = null; exp = 0;
  try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem('ink.gconsent'); } catch (e) {}
}

async function api(url, opts = {}) {
  if (!hasToken()) throw Object.assign(new Error('Not signed in to Google'), { code: 'auth' });
  const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
  if (r.status === 401) { token = null; exp = 0; throw Object.assign(new Error('Google session expired — tap Sync'), { code: 'auth' }); }
  if (!r.ok) { const t = await r.text(); throw new Error(`Google Drive error ${r.status}: ${t.slice(0, 200)}`); }
  return r;
}
const q = s => encodeURIComponent(s);

export async function findOrCreateFolder(name, parent) {
  const query = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false` + (parent ? ` and '${parent}' in parents` : '');
  const r = await (await api(`${API}/files?q=${q(query)}&fields=files(id,name)&spaces=drive`)).json();
  if (r.files?.length) return r.files[0].id;
  const c = await (await api(`${API}/files?fields=id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parent ? { parents: [parent] } : {}) }),
  })).json();
  return c.id;
}

export async function findFile(name, parent) {
  const query = `name='${name}' and '${parent}' in parents and trashed=false`;
  const r = await (await api(`${API}/files?q=${q(query)}&fields=files(id,modifiedTime)&orderBy=modifiedTime desc`)).json();
  return r.files?.[0] || null;
}

export async function fileInfo(id) {
  try { return await (await api(`${API}/files/${id}?fields=id,trashed,modifiedTime`)).json(); }
  catch (e) { if (e.code === 'auth') throw e; return null; }
}

export async function download(id) { return api(`${API}/files/${id}?alt=media`); }

export async function upload({ id = null, name, parent, mime, body }) {
  const b = 'inkcat' + Math.random().toString(36).slice(2);
  const meta = id ? {} : { name, parents: [parent], mimeType: mime };
  const payload = new Blob([
    `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${mime}\r\n\r\n`,
    body, `\r\n--${b}--`,
  ]);
  const r = await api(`${UPLOAD}/files${id ? '/' + id : ''}?uploadType=multipart&fields=id,modifiedTime`, {
    method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body: payload,
  });
  return r.json();
}

export async function makePublic(id) {
  await api(`${API}/files/${id}/permissions?fields=id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
}
export async function makePrivate(id) {
  try { await api(`${API}/files/${id}/permissions/anyoneWithLink`, { method: 'DELETE' }); } catch (e) { /* already private */ }
}
export async function trash(id) {
  try { await api(`${API}/files/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }); } catch (e) {}
}

// Public (read-only) access for viewers: files shared "anyone with the link", read with the API key.
export async function publicDownload(id) {
  if (!cfg.apiKey) throw new Error('This viewer link needs an API key in config.js');
  const r = await fetch(`${API}/files/${id}?alt=media&key=${cfg.apiKey}`);
  if (!r.ok) throw new Error(`Could not load shared catalogue (${r.status})`);
  return r;
}
