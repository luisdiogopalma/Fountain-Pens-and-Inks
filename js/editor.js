// Photo editor: auto-detects a swatch card (or any paper/photo), perspective-corrects it,
// white-balances from the paper, and crops the swatch + writing sample regions.
//
// openEditor({ file, mode: 'card' | 'photo', layout, title }) ->
//   card mode : { card, swatch, writing, hex, layout }  (Blobs)  or null when cancelled
//   photo mode: { image, hex }                                    or null

// Default fits Wearingeul "instant film" swatch cards: bank-card size (ISO ID-1, 53.98 × 85.60 mm).
// Box positions are adjustable in the editor.
export const DEFAULT_LAYOUT = {
  aspect: 0.6306, // width / height of the card
  swatch: [0.085, 0.065, 0.815, 0.59], // right edge kept inside the ink, which tends to bleed on that side
  writing: [0.03, 0.73, 0.94, 0.15], // runs down to just above the printed brand name
};

const MAX_SRC = 3000;      // working resolution of the original photo
const MAX_OUT = 1600;      // longest side of the corrected image
const DETECT = 640;        // detection resolution

// ---------- image helpers ----------
function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { res(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    img.onerror = () => rej(new Error('Could not read this image'));
    img.src = url;
  });
}
function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function scaledCanvas(src, maxSide) {
  const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const c = canvasOf(Math.round(sw * k), Math.round(sh * k));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
const toBlob = (c, q = 0.88) => new Promise(r => c.toBlob(r, 'image/jpeg', q));

// ---------- card detection ----------
function otsu(hist, total) {
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; t = i; }
  }
  return t;
}
function convexHull(pts) {
  pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}
function quadFromHull(h) {
  if (h.length < 4) return null;
  // largest-area quadrilateral using hull vertices (n is small after downscale)
  const n = h.length;
  const step = Math.max(1, Math.floor(n / 60));
  const idx = []; for (let i = 0; i < n; i += step) idx.push(i);
  const area = q => { let s = 0; for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; };
  let best = null, bestA = 0;
  const m = idx.length;
  for (let a = 0; a < m; a++) for (let c = a + 2; c < m; c++) {
    // for fixed diagonal a-c pick farthest b on one side and d on the other
    let bb = -1, bd = 0, dd = -1, ddist = 0;
    const A = h[idx[a]], C = h[idx[c]];
    for (let k = a + 1; k < c; k++) { const P = h[idx[k]]; const d = Math.abs((C[0] - A[0]) * (A[1] - P[1]) - (A[0] - P[0]) * (C[1] - A[1])); if (d > bd) { bd = d; bb = k; } }
    for (let k = c + 1; k < m + a; k++) { const P = h[idx[k % m]]; const d = Math.abs((C[0] - A[0]) * (A[1] - P[1]) - (A[0] - P[0]) * (C[1] - A[1])); if (d > ddist) { ddist = d; dd = k % m; } }
    if (bb < 0 || dd < 0) continue;
    const q = [A, h[idx[bb]], C, h[idx[dd]]];
    const ar = area(q); if (ar > bestA) { bestA = ar; best = q; }
  }
  return best;
}
export function orderCorners(q) {
  // returns [TL, TR, BR, BL] in image coordinates (y down)
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  const sorted = q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let start = 0, bestS = Infinity;
  sorted.forEach((p, i) => { const s = p[0] + p[1]; if (s < bestS) { bestS = s; start = i; } });
  return [0, 1, 2, 3].map(i => sorted[(start + i) % 4]);
}

function labelComponents(mask, w, h, minArea) {
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const comps = [];
  let next = 1;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s]) continue;
    let sp = 0; stack[sp++] = s; label[s] = next;
    let area = 0, border = 0;
    const rowMin = new Int32Array(h).fill(-1), rowMax = new Int32Array(h).fill(-1);
    while (sp) {
      const i = stack[--sp]; area++;
      const x = i % w, y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border++;
      if (rowMin[y] < 0 || x < rowMin[y]) rowMin[y] = x;
      if (x > rowMax[y]) rowMax[y] = x;
      if (x > 0 && mask[i - 1] && !label[i - 1]) { label[i - 1] = next; stack[sp++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !label[i + 1]) { label[i + 1] = next; stack[sp++] = i + 1; }
      if (y > 0 && mask[i - w] && !label[i - w]) { label[i - w] = next; stack[sp++] = i - w; }
      if (y < h - 1 && mask[i + w] && !label[i + w]) { label[i + w] = next; stack[sp++] = i + w; }
    }
    if (area >= minArea) comps.push({ area, border, rowMin, rowMax });
    next++;
  }
  return comps;
}
const polyArea = q => { let s = 0; for (let i = 0; i < q.length; i++) { const a = q[i], b = q[(i + 1) % q.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; };
function quadAnglesOk(q) {
  for (let i = 0; i < 4; i++) {
    const a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
    const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1);
    const ang = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
    if (ang < 55 || ang > 125) return false;
  }
  return true;
}

// Card detection combines two ideas and keeps the best-scoring quadrilateral:
//  1. bright regions at many thresholds (works when the card is clearly whiter than the table)
//  2. straight edges (Hough lines) — works when card and table have similar brightness
// Every candidate is scored by how much real edge lies along its 4 sides, times its size.
export function detectCard(canvas, layout = null) {
  const dc = scaledCanvas(canvas, 520);
  const w = dc.width, h = dc.height, N = w * h;
  const d = dc.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  // blurred channels
  const blur = src => { // two passes of a 5-wide box blur
    let a = src, b = new Float32Array(N);
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < h; y++) { let acc = 0; const o = y * w; for (let x = -2; x < w; x++) { if (x + 2 < w) acc += a[o + x + 2]; if (x - 3 >= 0) acc -= a[o + x - 3]; if (x >= 0) b[o + x] = acc / (Math.min(w - 1, x + 2) - Math.max(0, x - 2) + 1); } }
      const c = new Float32Array(N);
      for (let x = 0; x < w; x++) { let acc = 0; for (let y = -2; y < h; y++) { if (y + 2 < h) acc += b[(y + 2) * w + x]; if (y - 3 >= 0) acc -= b[(y - 3) * w + x]; if (y >= 0) c[y * w + x] = acc / (Math.min(h - 1, y + 2) - Math.max(0, y - 2) + 1); } }
      a = c;
    }
    return a;
  };
  const ch = [0, 1, 2].map(k => { const a = new Float32Array(N); for (let i = 0; i < N; i++) a[i] = d[i * 4 + k]; return blur(a); });
  const mag = new Float32Array(N), ang = new Float32Array(N);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x; let bm = 0, bgx = 0, bgy = 0;
    for (const c of ch) {
      const gx = (c[i - w + 1] + 2 * c[i + 1] + c[i + w + 1]) - (c[i - w - 1] + 2 * c[i - 1] + c[i + w - 1]);
      const gy = (c[i + w - 1] + 2 * c[i + w] + c[i + w + 1]) - (c[i - w - 1] + 2 * c[i - w] + c[i - w + 1]);
      const m = gx * gx + gy * gy; if (m > bm) { bm = m; bgx = gx; bgy = gy; }
    }
    mag[i] = Math.sqrt(bm); ang[i] = Math.atan2(bgy, bgx);
  }
  const sorted = Float32Array.from(mag).sort();
  const tStrong = Math.max(8, sorted[Math.floor(N * 0.90)]), tSupport = Math.max(6, sorted[Math.floor(N * 0.80)]);

  // --- edge support of a quad side
  const support = (P, Q) => {
    const L = Math.hypot(Q[0] - P[0], Q[1] - P[1]); if (L < 10) return 0;
    const n = Math.max(8, Math.floor(L / 2)), nx = -(Q[1] - P[1]) / L, ny = (Q[0] - P[0]) / L;
    let hit = 0, cnt = 0;
    for (let k = 1; k < n; k++) {
      const t = k / n, x = P[0] + (Q[0] - P[0]) * t, y = P[1] + (Q[1] - P[1]) * t;
      let ok = false, inside = false;
      for (let o = -3; o <= 3 && !ok; o++) {
        const xx = Math.round(x + nx * o), yy = Math.round(y + ny * o);
        if (xx < 1 || yy < 1 || xx >= w - 1 || yy >= h - 1) continue;
        inside = true; if (mag[yy * w + xx] > tSupport) ok = true;
      }
      if (inside) { cnt++; if (ok) hit++; }
    }
    return cnt < n * 0.6 ? 0 : hit / cnt;
  };
  const candidates = [];
  const consider = q => {
    if (!q) return;
    const o = orderCorners(q);
    if (!quadAnglesOk(o)) return;
    const a = polyArea(o); if (a < N * 0.05 || a > N * 0.97) return;
    if (o.some(p => p[0] < -w * 0.02 || p[1] < -h * 0.02 || p[0] > w * 1.02 || p[1] > h * 1.02)) return;
    const s = [0, 1, 2, 3].map(i => support(o[i], o[(i + 1) % 4]));
    const mn = Math.min(...s), avg = s.reduce((x, y) => x + y, 0) / 4;
    if (mn < 0.45) return;
    candidates.push({ q: o, s, score: Math.pow(avg, 3) * Math.pow(mn, 2) * a });
  };

  // 1) bright-region candidates
  const W = new Uint8Array(N), hist = new Uint32Array(256);
  for (let i = 0; i < N; i++) { const r = ch[0][i], g = ch[1][i], b = ch[2][i]; const v = Math.max(0, Math.min(255, Math.round((r + g + b) / 3 - 1.2 * (Math.max(r, g, b) - Math.min(r, g, b))))); W[i] = v; hist[v]++; }
  const ts = new Set([otsu(hist, N)]); for (let t = 110; t <= 250; t += 10) ts.add(t);
  const mask = new Uint8Array(N);
  for (const t of ts) {
    for (let i = 0; i < N; i++) mask[i] = W[i] > t ? 1 : 0;
    for (const c of labelComponents(mask, w, h, N * 0.05)) {
      const pts = [];
      for (let y = 0; y < h; y++) if (c.rowMin[y] >= 0) { pts.push([c.rowMin[y], y]); pts.push([c.rowMax[y] + 1, y]); }
      consider(quadFromHull(convexHull(pts)));
    }
  }

  // 2) Hough-line candidates (votes only near each pixel's gradient direction)
  const diag = Math.ceil(Math.hypot(w, h)), NT = 180, NR = 2 * diag + 1;
  const acc = new Float32Array(NT * NR);
  const cosT = new Float32Array(NT), sinT = new Float32Array(NT);
  for (let t = 0; t < NT; t++) { cosT[t] = Math.cos(t * Math.PI / 180); sinT[t] = Math.sin(t * Math.PI / 180); }
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x; if (mag[i] < tStrong) continue;
    let t0 = Math.round(ang[i] * 180 / Math.PI); t0 = ((t0 % 180) + 180) % 180;
    for (let dt = -6; dt <= 6; dt++) {
      const t = (t0 + dt + 180) % 180;
      const r = Math.round(x * cosT[t] + y * sinT[t]) + diag;
      acc[t * NR + r] += 1;
    }
  }
  const peaks = [];
  const used = new Uint8Array(NT * NR);
  const order = [];
  for (let k = 0; k < acc.length; k++) if (acc[k] > Math.min(w, h) * 0.12) order.push(k);
  order.sort((a, b) => acc[b] - acc[a]);
  for (const k of order) {
    if (used[k]) continue;
    const t = Math.floor(k / NR), r = k % NR;
    peaks.push({ t, r: r - diag, v: acc[k] });
    for (let dt = -5; dt <= 5; dt++) for (let dr = -10; dr <= 10; dr++) {
      const tt = t + dt, rr = r + dr; if (tt < 0 || tt >= NT || rr < 0 || rr >= NR) continue; used[tt * NR + rr] = 1;
    }
    if (peaks.length >= 22) break;
  }
  const inter = (a, b) => {
    const c1 = cosT[a.t], s1 = sinT[a.t], c2 = cosT[b.t], s2 = sinT[b.t];
    const det = c1 * s2 - s1 * c2; if (Math.abs(det) < 1e-6) return null;
    return [(a.r * s2 - s1 * b.r) / det, (c1 * b.r - a.r * c2) / det];
  };
  const angDiff = (a, b) => { const x = Math.abs(a - b) % 180; return Math.min(x, 180 - x); };
  const pairs = [];
  for (let i = 0; i < peaks.length; i++) for (let j = i + 1; j < peaks.length; j++) {
    if (angDiff(peaks[i].t, peaks[j].t) < 22) pairs.push([peaks[i], peaks[j]]);
  }
  for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) {
    const [a1, a2] = pairs[i], [b1, b2] = pairs[j];
    if (angDiff(a1.t, b1.t) < 55) continue;
    const q = [inter(a1, b1), inter(b1, a2), inter(a2, b2), inter(b2, a1)];
    if (q.some(p => !p)) continue;
    consider(q);
  }

  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) return null;
  let best = candidates[0].q;
  if (layout && layout.swatch) {
    // The swatch is usually the strongest rectangle in the photo. Test both readings for each
    // top candidate — "this is the card" and "this is the swatch on the card" — and keep the one
    // whose 8 edges (card outline + swatch outline at the known layout position) are best supported.
    const [sx, sy, sw, sh] = layout.swatch;
    const unitSw = [[sx, sy], [sx + sw, sy], [sx + sw, sy + sh], [sx, sy + sh]];
    const unitCard = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const mapPts = (Hm, pts) => pts.map(([u, v]) => { const z = Hm[6] * u + Hm[7] * v + 1; return [(Hm[0] * u + Hm[1] * v + Hm[2]) / z, (Hm[3] * u + Hm[4] * v + Hm[5]) / z]; });
    const sides = q => [0, 1, 2, 3].map(i => support(q[i], q[(i + 1) % 4]));
    const inside = q => q.every(p => p[0] > -w * 0.03 && p[1] > -h * 0.03 && p[0] < w * 1.03 && p[1] < h * 1.03);
    // paper-vs-ink contrast: the card margin should be lighter and less colourful than the swatch
    const sample = (Hm, pts) => {
      let L = 0, C = 0, n = 0;
      for (const [x, y] of mapPts(Hm, pts)) {
        const xi = Math.round(x), yi = Math.round(y);
        if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
        const i = yi * w + xi, r = ch[0][i], g = ch[1][i], b = ch[2][i];
        L += (r + g + b) / 3; C += Math.max(r, g, b) - Math.min(r, g, b); n++;
      }
      return n ? [L / n, C / n] : null;
    };
    const marginPts = [], swPts = [];
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      marginPts.push([sx / 2, sy + sh * t], [sx + sw + (1 - sx - sw) / 2, sy + sh * t], [sx + sw * t, sy / 2]);
      for (let j = 0; j <= 10; j++) swPts.push([sx + sw * (0.2 + 0.6 * t), sy + sh * (0.2 + 0.6 * j / 10)]);
    }
    const contrast = cardH => { const m = sample(cardH, marginPts), q = sample(cardH, swPts); if (!m || !q) return -1; return Math.max(-1, Math.min(1, ((m[0] - q[0]) + (q[1] - m[1])) / 80)); };
    const sum = a => a.reduce((x, y) => x + y, 0);
    let bestH = -Infinity;
    for (const c of candidates.slice(0, 30)) {
      // reading 1: c is the card
      const H1 = homography(unitCard, c.q);
      const h1 = 0.6 * (sum(c.s) + sum(sides(mapPts(H1, unitSw)))) / 8 + 0.4 * contrast(H1);
      if (h1 > bestH) { bestH = h1; best = c.q; }
      // reading 2: c is the swatch
      const cardQ = mapPts(homography(unitSw, c.q), unitCard);
      if (inside(cardQ) && quadAnglesOk(cardQ)) {
        const H2 = homography(unitCard, cardQ);
        const h2 = 0.6 * (sum(c.s) + sum(sides(cardQ))) / 8 + 0.4 * contrast(H2);
        if (h2 > bestH) { bestH = h2; best = cardQ; }
      }
    }
  }
  // snap each side onto the nearby edge (least-squares line through the strongest edge points)
  const refine = q => {
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const P = q[i], Q = q[(i + 1) % 4];
      const L = Math.hypot(Q[0] - P[0], Q[1] - P[1]); const nx = -(Q[1] - P[1]) / L, ny = (Q[0] - P[0]) / L;
      const pts = [];
      const n = Math.max(10, Math.floor(L / 2));
      for (let k = 2; k < n - 1; k++) {
        const t = k / n, x = P[0] + (Q[0] - P[0]) * t, y = P[1] + (Q[1] - P[1]) * t;
        let bm = 0, bp = null;
        for (let o = -8; o <= 8; o++) {
          const xx = Math.round(x + nx * o), yy = Math.round(y + ny * o);
          if (xx < 1 || yy < 1 || xx >= w - 1 || yy >= h - 1) continue;
          const m = mag[yy * w + xx]; if (m > bm) { bm = m; bp = [xx, yy]; }
        }
        if (bp && bm > tSupport * 0.6) pts.push(bp);
      }
      if (pts.length < n * 0.35) { lines.push(null); continue; }
      // total least squares, then one pass dropping outliers
      const fit = ps => {
        const mx = ps.reduce((a, p) => a + p[0], 0) / ps.length, my = ps.reduce((a, p) => a + p[1], 0) / ps.length;
        let sxx = 0, syy = 0, sxy = 0; for (const [x, y] of ps) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
        const th = 0.5 * Math.atan2(2 * sxy, sxx - syy); return { mx, my, dx: Math.cos(th), dy: Math.sin(th) };
      };
      let f = fit(pts);
      const dist = p => Math.abs((p[0] - f.mx) * f.dy - (p[1] - f.my) * f.dx);
      const keep = pts.filter(p => dist(p) < 2.5);
      if (keep.length >= pts.length * 0.5) f = fit(keep);
      lines.push(f);
    }
    return q.map((p, i) => {
      const a = lines[(i + 3) % 4], b = lines[i]; // corner i joins side i-1 and side i
      if (!a || !b) return p;
      const det = a.dx * b.dy - a.dy * b.dx; if (Math.abs(det) < 1e-6) return p;
      const t = ((b.mx - a.mx) * b.dy - (b.my - a.my) * b.dx) / det;
      const r = [a.mx + a.dx * t, a.my + a.dy * t];
      return Math.hypot(r[0] - p[0], r[1] - p[1]) < Math.min(w, h) * 0.08 ? r : p;
    });
  };
  best = refine(refine(best));
  const k = canvas.width / w;
  return best.map(p => [Math.max(0, Math.min(canvas.width, p[0] * k)), Math.max(0, Math.min(canvas.height, p[1] * k))]);
}

// ---------- perspective warp ----------
function solve(A, b) { // gaussian elimination, A n×n
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let mx = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[mx][i])) mx = r;
    [A[i], A[mx]] = [A[mx], A[i]]; [b[i], b[mx]] = [b[mx], b[i]];
    for (let r = i + 1; r < n; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c]; x[i] = s / A[i][i]; }
  return x;
}
function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [X, Y] = to[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
  }
  return solve(A, b);
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function warp(srcCanvas, quad, outW, outH) {
  const sw = srcCanvas.width, sh = srcCanvas.height;
  const sd = srcCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
  const H = homography([[0, 0], [outW, 0], [outW, outH], [0, outH]], quad);
  const out = canvasOf(outW, outH);
  const g = out.getContext('2d');
  const od = g.createImageData(outW, outH);
  const o = od.data;
  for (let v = 0; v < outH; v++) {
    for (let u = 0; u < outW; u++) {
      const uu = u + 0.5, vv = v + 0.5;
      const z = H[6] * uu + H[7] * vv + 1;
      let x = (H[0] * uu + H[1] * vv + H[2]) / z - 0.5;
      let y = (H[3] * uu + H[4] * vv + H[5]) / z - 0.5;
      if (x < 0) x = 0; if (y < 0) y = 0; if (x > sw - 1.001) x = sw - 1.001; if (y > sh - 1.001) y = sh - 1.001;
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      const p00 = (y0 * sw + x0) * 4, p10 = p00 + 4, p01 = p00 + sw * 4, p11 = p01 + 4;
      const q = (v * outW + u) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = sd[p00 + ch] + (sd[p10 + ch] - sd[p00 + ch]) * fx;
        const bot = sd[p01 + ch] + (sd[p11 + ch] - sd[p01 + ch]) * fx;
        o[q + ch] = top + (bot - top) * fy;
      }
      o[q + 3] = 255;
    }
  }
  g.putImageData(od, 0, 0);
  return out;
}

// ---------- white balance ----------
export function sampleColor(canvas, x, y, r = 6) {
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const x0 = Math.max(0, Math.round(x - r)), y0 = Math.max(0, Math.round(y - r));
  const w = Math.min(canvas.width - x0, r * 2 + 1), h = Math.min(canvas.height - y0, r * 2 + 1);
  if (w <= 0 || h <= 0) return [255, 255, 255];
  const d = g.getImageData(x0, y0, w, h).data;
  let R = 0, G = 0, B = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; n++; }
  return [R / n, G / n, B / n];
}
export function findWhite(canvas, exclude = []) {
  const k = Math.min(1, 400 / Math.max(canvas.width, canvas.height));
  const c = scaledCanvas(canvas, 400);
  const w = c.width, h = c.height;
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const B = Math.max(6, Math.round(Math.min(w, h) / 30));
  let best = null, bestS = -Infinity;
  for (let by = B; by + B < h - B; by += Math.max(2, B >> 1)) {
    for (let bx = B; bx + B < w - B; bx += Math.max(2, B >> 1)) {
      const cxn = (bx + B / 2) / w, cyn = (by + B / 2) / h;
      if (cxn < 0.05 || cxn > 0.95 || cyn < 0.04 || cyn > 0.96) continue;
      if (exclude.some(r => cxn > r[0] - 0.02 && cxn < r[0] + r[2] + 0.02 && cyn > r[1] - 0.02 && cyn < r[1] + r[3] + 0.02)) continue;
      let s = 0, s2 = 0, chroma = 0, clip = 0, n = 0;
      for (let y = by; y < by + B; y += 2) for (let x = bx; x < bx + B; x += 2) {
        const p = (y * w + x) * 4, r = d[p], g = d[p + 1], b = d[p + 2];
        const L = (r + g + b) / 3; s += L; s2 += L * L;
        chroma += Math.max(r, g, b) - Math.min(r, g, b);
        if (r > 252 && g > 252 && b > 252) clip++;
        n++;
      }
      const m = s / n, sd = Math.sqrt(Math.max(0, s2 / n - m * m));
      const score = m - 1.5 * (chroma / n) - 4 * sd - (clip / n > 0.3 ? 80 : 0);
      if (score > bestS) { bestS = score; best = [(bx + B / 2) / k, (by + B / 2) / k]; }
    }
  }
  return best || [canvas.width / 2, canvas.height / 2];
}
export function applyGains(src, gains) {
  const out = canvasOf(src.width, src.height);
  const g = out.getContext('2d');
  const sg = src.getContext('2d', { willReadFrequently: true });
  const id = sg.getImageData(0, 0, src.width, src.height);
  const d = id.data;
  const [gr, gg, gb] = gains;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.min(255, d[i] * gr); d[i + 1] = Math.min(255, d[i + 1] * gg); d[i + 2] = Math.min(255, d[i + 2] * gb);
  }
  g.putImageData(id, 0, 0);
  return out;
}
function gainsFor(rgb) {
  const target = 245;
  return rgb.map(v => Math.max(0.5, Math.min(3, target / Math.max(20, v))));
}
export function cropNorm(canvas, r) {
  const x = Math.round(r[0] * canvas.width), y = Math.round(r[1] * canvas.height);
  const w = Math.max(1, Math.round(r[2] * canvas.width)), h = Math.max(1, Math.round(r[3] * canvas.height));
  const c = canvasOf(w, h);
  c.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return c;
}
export function dominantHex(canvas) {
  // median colour of the central 60%, ignoring near-white paper pixels
  const c = scaledCanvas(canvas, 120);
  const w = c.width, h = c.height;
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(Math.round(w * 0.2), Math.round(h * 0.2), Math.max(1, Math.round(w * 0.6)), Math.max(1, Math.round(h * 0.6))).data;
  const rs = [], gs = [], bs = [];
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (r > 235 && g > 235 && b > 235) continue;
    rs.push(r); gs.push(g); bs.push(b);
  }
  if (!rs.length) return '#ffffff';
  const med = a => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
  return '#' + [med(rs), med(gs), med(bs)].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}

// ---------- UI ----------
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

export function openEditor({ file, mode = 'card', layout = DEFAULT_LAYOUT, title = 'Edit photo', recrop = false }) {
  // recrop: the file is an already straightened, colour-corrected card — go straight to the boxes
  return new Promise(async resolve => {
    const root = el('div', 'ed');
    root.innerHTML = `
      <div class="ed-top">
        <button class="btn ghost ed-cancel" type="button">Cancel</button>
        <div class="ed-title"><strong>${title}</strong><span class="ed-step"></span></div>
        <button class="btn primary ed-next" type="button">Next</button>
      </div>
      <div class="ed-stage"><div class="ed-wrap"><canvas class="ed-canvas"></canvas><div class="ed-ov"></div></div><canvas class="ed-loupe" width="120" height="120"></canvas><div class="ed-busy">Working…</div></div>
      <div class="ed-bar"><p class="ed-hint"></p><div class="ed-actions"></div></div>`;
    document.body.appendChild(root);
    document.body.classList.add('no-scroll');
    const $ = s => root.querySelector(s);
    const stage = $('.ed-stage'), wrap = $('.ed-wrap'), cv = $('.ed-canvas'), ov = $('.ed-ov'), loupe = $('.ed-loupe');
    const busy = on => $('.ed-busy').classList.toggle('on', on);
    const resizeH = () => onResize();
    const onPop = () => close(null, true);
    const close = (val, fromPop) => {
      root.remove(); window.removeEventListener('resize', resizeH); window.removeEventListener('popstate', onPop);
      if (!document.querySelector('.modal')) document.body.classList.remove('no-scroll');
      if (!fromPop) { window.__skipPop = (window.__skipPop || 0) + 1; history.back(); }
      resolve(val);
    };
    history.pushState({ editor: 1 }, '');
    window.addEventListener('popstate', onPop);
    $('.ed-cancel').onclick = () => close(null);

    busy(true);
    let img;
    try { img = await loadImage(file); } catch (e) { alert(e.message); return close(null); }
    await new Promise(r => setTimeout(r, 30));
    const src = scaledCanvas(img, MAX_SRC);
    const view = scaledCanvas(src, 1400);
    let quad = null;
    let L = JSON.parse(JSON.stringify(layout || DEFAULT_LAYOUT));
    if (!recrop) { try { quad = detectCard(src, mode === 'card' ? L : null); } catch (e) { console.warn(e); } }
    else quad = [[0, 0], [src.width, 0], [src.width, src.height], [0, src.height]];
    const detected = !!quad;
    const fullQuad = () => { const m = 0.03; const w = src.width, h = src.height; return [[w * m, h * m], [w * (1 - m), h * m], [w * (1 - m), h * (1 - m)], [w * m, h * (1 - m)]]; };
    if (!quad) quad = fullQuad();
    let step = 1, warped = null, preview = null, white = null, wbOn = !recrop, onResize = () => {};

    // fit a canvas into the stage
    function fit(c) {
      const sr = stage.getBoundingClientRect();
      const pad = 24;
      const k = Math.min((sr.width - pad) / c.width, (sr.height - pad) / c.height);
      const dw = Math.max(50, Math.floor(c.width * k)), dh = Math.max(50, Math.floor(c.height * k));
      wrap.style.width = dw + 'px'; wrap.style.height = dh + 'px';
      return { dw, dh, k: dw / c.width };
    }
    function show(c) { cv.width = c.width; cv.height = c.height; cv.getContext('2d').drawImage(c, 0, 0); }

    // ----- step 1: corners -----
    function step1() {
      step = 1;
      $('.ed-step').textContent = 'Step 1 of 2 · corners';
      $('.ed-next').textContent = 'Next';
      $('.ed-hint').textContent = detected ? (mode === 'card' ? 'Card found. Drag the corners if they are not exactly on the card.' : 'Drag the corners to crop.') : (mode === 'card' ? 'Could not find the card automatically — drag the 4 corners onto it.' : 'Drag the corners to crop.');
      const acts = $('.ed-actions'); acts.innerHTML = '';
      const bAuto = el('button', 'btn small', 'Auto-detect'); bAuto.type = 'button';
      bAuto.onclick = () => { const q = detectCard(src, mode === 'card' ? L : null); if (q) { quad = q; draw(); } else $('.ed-hint').textContent = 'Nothing found — place the corners by hand.'; };
      const bFull = el('button', 'btn small', 'Whole photo'); bFull.type = 'button';
      bFull.onclick = () => { quad = fullQuad(); draw(); };
      acts.append(bAuto, bFull);
      show(view);
      const s = view.width / src.width;
      let geo = fit(view);
      ov.innerHTML = '<svg class="ed-svg"><polygon/></svg>' + [0, 1, 2, 3].map(i => `<div class="ed-h" data-i="${i}"></div>`).join('');
      const poly = ov.querySelector('polygon'), svg = ov.querySelector('svg');
      function draw() {
        svg.setAttribute('width', geo.dw); svg.setAttribute('height', geo.dh);
        const pts = quad.map(p => [p[0] * s * geo.k, p[1] * s * geo.k]);
        poly.setAttribute('points', pts.map(p => p.join(',')).join(' '));
        ov.querySelectorAll('.ed-h').forEach((h, i) => { h.style.left = pts[i][0] + 'px'; h.style.top = pts[i][1] + 'px'; });
      }
      onResize = () => { geo = fit(view); draw(); };
      draw();
      ov.querySelectorAll('.ed-h').forEach(h => {
        h.onpointerdown = e => {
          e.preventDefault(); h.setPointerCapture(e.pointerId);
          const i = +h.dataset.i; const r = wrap.getBoundingClientRect();
          const off = [e.clientX - (r.left + quad[i][0] * s * geo.k), e.clientY - (r.top + quad[i][1] * s * geo.k)];
          loupe.classList.add('on');
          const move = ev => {
            const x = (ev.clientX - off[0] - r.left) / (s * geo.k), y = (ev.clientY - off[1] - r.top) / (s * geo.k);
            quad[i] = [Math.max(0, Math.min(src.width, x)), Math.max(0, Math.min(src.height, y))];
            draw();
            // loupe on the side away from the finger
            const sr = stage.getBoundingClientRect();
            loupe.style.left = (ev.clientX - sr.left < sr.width / 2) ? 'auto' : '12px';
            loupe.style.right = (ev.clientX - sr.left < sr.width / 2) ? '12px' : 'auto';
            const lg = loupe.getContext('2d'); const z = 60 / (geo.k * s) / 2.5;
            lg.fillStyle = '#000'; lg.fillRect(0, 0, 120, 120);
            lg.drawImage(src, quad[i][0] - z, quad[i][1] - z, z * 2, z * 2, 0, 0, 120, 120);
            lg.strokeStyle = '#ff3b6b'; lg.lineWidth = 1.5; lg.beginPath(); lg.moveTo(60, 0); lg.lineTo(60, 120); lg.moveTo(0, 60); lg.lineTo(120, 60); lg.stroke();
          };
          move(e);
          h.onpointermove = move;
          h.onpointerup = h.onpointercancel = () => { h.onpointermove = null; loupe.classList.remove('on'); };
        };
      });
    }

    // ----- step 2: white balance + regions -----
    function buildWarp() {
      let q = quad;
      if (mode === 'card' && L.aspect) {
        const mw = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2, mh = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
        if ((L.aspect < 1) !== (mw < mh)) { quad = q = [q[3], q[0], q[1], q[2]]; }
      }
      const wTop = dist(q[0], q[1]), wBot = dist(q[3], q[2]), hL = dist(q[0], q[3]), hR = dist(q[1], q[2]);
      let ow = (wTop + wBot) / 2, oh = (hL + hR) / 2;
      if (mode === 'card' && L.aspect) {
        // keep the measured size but correct the proportions to the known card format
        const area = ow * oh; oh = Math.sqrt(area / L.aspect); ow = oh * L.aspect;
      }
      const k = Math.min(1, MAX_OUT / Math.max(ow, oh));
      warped = warp(src, q, Math.max(10, Math.round(ow * k)), Math.max(10, Math.round(oh * k)));
      preview = scaledCanvas(warped, 900);
      const ex = mode === 'card' ? [L.swatch, L.writing] : [];
      const wp = findWhite(warped, ex);
      white = [wp[0] / warped.width, wp[1] / warped.height];
    }
    function currentGains() {
      if (!wbOn) return [1, 1, 1];
      return gainsFor(sampleColor(warped, white[0] * warped.width, white[1] * warped.height, Math.max(4, Math.round(warped.width / 120))));
    }
    function step2() {
      step = 2;
      $('.ed-step').textContent = 'Step 2 of 2 · colour' + (mode === 'card' ? ' & areas' : '');
      $('.ed-next').textContent = 'Save';
      $('.ed-hint').innerHTML = mode === 'card'
        ? 'The <b>target</b> marks white paper used to correct colour — drag it to move it. Drag the <b>Swatch</b> and <b>Writing</b> boxes (corner dots resize).'
        : 'The <b>target</b> marks something white used to correct colour — drag it, or turn correction off.';
      const acts = $('.ed-actions'); acts.innerHTML = '';
      const bBack = el('button', 'btn small', '← Corners'); bBack.type = 'button'; bBack.onclick = () => step1();
      const bRot = el('button', 'btn small', 'Rotate ↻'); bRot.type = 'button';
      bRot.onclick = () => { quad = [quad[3], quad[0], quad[1], quad[2]]; busy(true); setTimeout(() => { buildWarp(); render(); busy(false); }, 20); };
      const wb = el('label', 'chk', `<input type="checkbox" ${wbOn ? 'checked' : ''}> Colour correction`);
      wb.querySelector('input').onchange = e => { wbOn = e.target.checked; render(); };
      acts.append(bBack, bRot, wb);
      if (mode === 'card') {
        const def = el('label', 'chk', '<input type="checkbox" class="ed-def"> Remember box positions');
        acts.append(def);
      }
      render();
    }
    function render() {
      const p = applyGains(preview, currentGains());
      show(p);
      let geo = fit(p);
      const boxes = mode === 'card' ? [['swatch', 'Swatch'], ['writing', 'Writing']] : [];
      ov.innerHTML = boxes.map(([k, n]) => `<div class="ed-box" data-k="${k}"><span>${n}</span><i class="tl"></i><i class="br"></i></div>`).join('') + `<div class="ed-wb" title="White reference"></div>`;
      const place = () => {
        ov.querySelectorAll('.ed-box').forEach(b => {
          const r = L[b.dataset.k];
          Object.assign(b.style, { left: r[0] * geo.dw + 'px', top: r[1] * geo.dh + 'px', width: r[2] * geo.dw + 'px', height: r[3] * geo.dh + 'px' });
        });
        const m = ov.querySelector('.ed-wb'); m.style.left = white[0] * geo.dw + 'px'; m.style.top = white[1] * geo.dh + 'px';
      };
      onResize = () => { geo = fit(p); place(); };
      place();
      const drag = (elm, onMove, onEnd) => {
        elm.onpointerdown = e => {
          e.preventDefault(); e.stopPropagation(); elm.setPointerCapture(e.pointerId);
          const start = [e.clientX, e.clientY];
          elm.onpointermove = ev => onMove((ev.clientX - start[0]) / geo.dw, (ev.clientY - start[1]) / geo.dh, ev);
          elm.onpointerup = elm.onpointercancel = () => { elm.onpointermove = null; onEnd && onEnd(); };
        };
      };
      ov.querySelectorAll('.ed-box').forEach(b => {
        const k = b.dataset.k;
        let base;
        const clamp = r => { r[2] = Math.max(0.05, Math.min(1, r[2])); r[3] = Math.max(0.05, Math.min(1, r[3])); r[0] = Math.max(0, Math.min(1 - r[2], r[0])); r[1] = Math.max(0, Math.min(1 - r[3], r[1])); return r; };
        const grab = fn => e => { base = L[k].slice(); fn(e); };
        b.addEventListener('pointerdown', grab(() => {}), true);
        drag(b, (dx, dy) => { L[k] = clamp([base[0] + dx, base[1] + dy, base[2], base[3]]); place(); });
        const tl = b.querySelector('.tl'), br = b.querySelector('.br');
        tl.addEventListener('pointerdown', grab(() => {}), true);
        br.addEventListener('pointerdown', grab(() => {}), true);
        drag(tl, (dx, dy) => { L[k] = clamp([base[0] + dx, base[1] + dy, base[2] - dx, base[3] - dy]); place(); });
        drag(br, (dx, dy) => { L[k] = clamp([base[0], base[1], base[2] + dx, base[3] + dy]); place(); });
      });
      const m = ov.querySelector('.ed-wb');
      let wbase;
      m.addEventListener('pointerdown', () => { wbase = white.slice(); }, true);
      drag(m, (dx, dy) => { white = [Math.max(0, Math.min(1, wbase[0] + dx)), Math.max(0, Math.min(1, wbase[1] + dy))]; place(); }, () => render());
      // tap on empty area moves the white target
      ov.onpointerdown = e => {
        if (e.target !== ov) return;
        const r = wrap.getBoundingClientRect();
        white = [(e.clientX - r.left) / geo.dw, (e.clientY - r.top) / geo.dh];
        render();
      };
    }

    $('.ed-next').onclick = async () => {
      if (step === 1) {
        busy(true);
        await new Promise(r => setTimeout(r, 20));
        try { buildWarp(); step2(); } finally { busy(false); }
        return;
      }
      busy(true);
      await new Promise(r => setTimeout(r, 20));
      const final = applyGains(warped, currentGains());
      if (mode === 'card') {
        const sw = cropNorm(final, L.swatch), wr = cropNorm(final, L.writing);
        const out = {
          card: await toBlob(scaledCanvas(final, 1400)),
          swatch: await toBlob(scaledCanvas(sw, 700)),
          writing: await toBlob(scaledCanvas(wr, 1400)),
          hex: dominantHex(sw),
          layout: root.querySelector('.ed-def')?.checked ? { aspect: +(warped.width / warped.height).toFixed(4), swatch: L.swatch.map(v => +v.toFixed(4)), writing: L.writing.map(v => +v.toFixed(4)) } : null,
        };
        close(out);
      } else {
        close({ image: await toBlob(scaledCanvas(final, 1600)), hex: dominantHex(final) });
      }
    };
    window.addEventListener('resize', resizeH);
    busy(false);
    if (recrop) { buildWarp(); step2(); } else step1();
  });
}
