import { MAX_CURVE, MAX_CURVES, MAX_RECTS } from './shaders.js';
import { themeColors } from './theme.js';
import { colorAt, mapName } from './colormaps.js';

const BINS = 256;
// One global palette for all selections (none of them blue: the blues are the ocean). A new selection gets the
// first colour not used by an existing one (least used when all are taken), so colours are not repeated across
// diagrams and a deleted selection frees its colour.
export const PALETTE = [[214, 48, 49], [124, 181, 24], [230, 126, 34], [142, 68, 173], [233, 30, 140], [241, 196, 15], [0, 150, 136], [121, 85, 72], [90, 90, 90], [255, 138, 128]];
const rgb = (c) => `rgb(${c})`;
const M = { l: 50, r: 10, t: 10, b: 40 }; // plot margins in px
const STRIP = 5;                          // width of the colour strips along the axes

// Diagram pairs. x / y are field indices (0 = T, 1 = S, 2 = O2) = channels of the volume texture, so the shader
// can look up the pair with uVol[x], uVol[y]. Selections (rectangles, curve) belong to one pair.
export const PAIRS = {
  ts: { x: 1, y: 0, label: 'T–S' },
  to: { x: 2, y: 0, label: 'T–O₂' },
  so: { x: 2, y: 1, label: 'S–O₂' },
};

// 2D volume-weighted histograms of one time step for every pair: BINS x BINS, row = y bin, column = x bin.
// Voxel weight = cos(lat) * layer thickness (approximate water volume). d = { t, s, o|null, mask }.
export function buildHists(d, { nx, ny, nz, depth, lat0, dlat }) {
  const hists = { ts: new Float32Array(BINS * BINS) };
  if (d.o) { hists.to = new Float32Array(BINS * BINS); hists.so = new Float32Array(BINS * BINS); }
  const { ts, to, so } = hists;
  const dz = depth.map((_, i) => (depth[Math.min(i + 1, nz - 1)] - depth[Math.max(i - 1, 0)]) / 2);
  let i = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) {
      const w = Math.cos(((lat0 + j * dlat) * Math.PI) / 180) * dz[k];
      for (let x = 0; x < nx; x++, i++) {
        if (!(d.mask[i] & 1)) continue; // bit0 = ocean
        const bt = d.t[i] >> 8, bs = d.s[i] >> 8;
        ts[bt * BINS + bs] += w;
        if (to) { const bo = d.o[i] >> 8; to[bt * BINS + bo] += w; so[bs * BINS + bo] += w; }
      }
    }
  return hists;
}

// "Nice" tick values (1, 2, 5 x 10^k) inside [lo, hi]
export function niceTicks(lo, hi, n = 4) {
  const raw = (hi - lo) / n, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  const step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  const out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

// Diagram panel: 2D histogram of the selected pair plus rectangle and curve selection.
// info = { fields, names, units, ranges }. Coordinates exposed to callers are normalised (x, y) in [0,1]
// over the global range of each field; y is up. Rectangles keep the historical names s0/s1 (x) and t0/t1 (y).
export class TSPanel {
  constructor(canvas, info, onChange) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.info = info;
    this.onChange = onChange;
    this.tool = 'rect';
    this.pairKey = 'ts';
    this.items = [];
    this.nextId = 1;
    this.selectedId = null;
    this.showCurve = true;
    this.showRects = true;
    this.drag = null;
    this.theme = themeColors();
    this.cmapChoice = 'auto';  // colour-map choice of the 1D transfer function (colours the axis strips)
    this.hists = null;
    this.histMax = null;
    this.histImg = this.renderHist();
    this.resize();
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', () => this.up());
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  // ---- selections: one flat list of items { id, kind: 'rect' | 'curve', pair, name, color, visible, style, ... } ----
  // rect: s0, s1 (x range) and t0, t1 (y range) in normalised coordinates; curve: points [[x, y], ...].
  // The diagram shows the items of the active pair; `rects` / `curve` are what the 3D view draws at the moment.
  get pair() { return PAIRS[this.pairKey]; }
  get rects() { return this.items.filter((i) => i.kind === 'rect' && i.pair === this.pairKey); }
  get curveItem() { return this.items.find((i) => i.kind === 'curve' && i.pair === this.pairKey && i.points.length > 1) ?? null; }
  get curve() { return this.curveItem?.points ?? []; }

  nextColor() {
    const used = (c) => this.items.filter((i) => i.color.join() === c.join()).length;  // by value: loaded colours are copies
    return PALETTE.reduce((best, c) => (used(c) < used(best) ? c : best), PALETTE[0]);
  }

  // add a selection; returns the item, or null when the limit for its kind is reached (8 rectangles, 4 curves in total)
  add(kind, data, pair = this.pairKey) {
    const limit = kind === 'rect' ? MAX_RECTS : MAX_CURVES;
    if (this.items.filter((i) => i.kind === kind).length >= limit) return null;
    const taken = new Set(this.items.filter((i) => i.kind === kind && i.pair === pair).map((i) => i.n));
    let n = 1;
    while (taken.has(n)) n++;
    const item = { id: this.nextId++, kind, pair, n, name: `${PAIRS[pair].label} ${kind === 'rect' ? 'rectangle' : 'curve'} ${n}`,
      color: data.color ?? this.nextColor(), visible: true, style: 'surface', ...data };
    this.items.push(item);
    return item;
  }

  remove(id) {
    this.items = this.items.filter((i) => i.id !== id);
    if (this.selectedId === id) this.selectedId = null;
    this.draw();
    this.onChange();
  }

  // hists: { ts, to?, so? } of the step to show; max: optional { ts, to, so } normalisation (keeps brightness
  // comparable between time steps)
  setHists(hists, max = null) {
    this.hists = hists;
    this.histMax = max;
    this.histImg = this.renderHist();
    this.draw();
  }

  setPair(key) {
    if (!PAIRS[key] || key === this.pairKey) return;
    this.drag = null;
    this.pairKey = key;
    this.histImg = this.renderHist();
    this.draw();
    this.onChange();
  }

  // re-colour for a theme change
  refreshTheme() {
    this.theme = themeColors();
    this.histImg = this.renderHist();
    this.draw();
  }

  // density colours: u in [0, 1] -> [r, g, b]
  histRamp() {
    // light theme: accent background -> secondary -> primary; dark theme: -> primary -> tertiary
    const { bg, accentBg, primary, secondary, tertiary } = this.theme;
    const dark = bg[0] + bg[1] + bg[2] < 384;
    const stops = dark ? [accentBg, primary, tertiary] : [accentBg, secondary, primary];
    return (u) => {
      const f = u * (stops.length - 1), k = Math.min(Math.floor(f), stops.length - 2), w = f - k;
      return stops[k].map((c, i) => c * (1 - w) + stops[k + 1][i] * w);
    };
  }

  // small colour bar (#histLegend) explaining the histogram colours
  drawLegend() {
    const cv = document.getElementById('histLegend');
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    if (r.width < 2) return;
    const dpr = devicePixelRatio || 1;
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) {
      cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    const { textLight, border } = this.theme, ramp = this.histRamp(), x0 = 6, x1 = r.width - 6;
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    for (let i = 0; i <= 8; i++) g.addColorStop(i / 8, rgb(ramp(0.15 + 0.85 * (i / 8)).map(Math.round)));
    ctx.fillStyle = g; ctx.fillRect(x0, 2, x1 - x0, 8);
    ctx.strokeStyle = rgb(border); ctx.strokeRect(x0 + 0.5, 2.5, x1 - x0 - 1, 7);
    ctx.fillStyle = rgb(textLight);
    ctx.font = `11px ${getComputedStyle(this.cv).fontFamily}`;
    ctx.textAlign = 'left'; ctx.fillText('little water', x0, 23);
    ctx.textAlign = 'right'; ctx.fillText('much water', x1, 23);
    ctx.textAlign = 'center'; ctx.fillText('volume (log)', r.width / 2, 23);
  }

  renderHist() {
    const img = new ImageData(BINS, BINS);
    const hist = this.hists?.[this.pairKey];
    let max = this.histMax?.[this.pairKey] ?? 0;
    if (hist && !max) for (const v of hist) max = Math.max(max, v);
    const lmax = Math.log1p(max) || 1;
    const { bg } = this.theme, ramp = this.histRamp();
    for (let ty = 0; ty < BINS; ty++)
      for (let sx = 0; sx < BINS; sx++) {
        const v = hist ? Math.min(1, Math.log1p(hist[ty * BINS + sx]) / lmax) : 0;
        const o = ((BINS - 1 - ty) * BINS + sx) * 4; // flip so y is up
        const c = v === 0 ? bg : ramp(0.15 + 0.85 * v);
        img.data.set([c[0], c[1], c[2], 255], o);
      }
    const cv = document.createElement('canvas');
    cv.width = cv.height = BINS;
    cv.getContext('2d').putImageData(img, 0, 0);
    return cv;
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    this.cv.width = Math.max(1, Math.round(r.width * dpr));
    this.cv.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = r.width; this.h = r.height;
    this.draw();
  }

  toPx(s, t) { return [M.l + s * (this.w - M.l - M.r), M.t + (1 - t) * (this.h - M.t - M.b)]; }

  fromEvent(e) {
    const r = this.cv.getBoundingClientRect();
    const s = (e.clientX - r.left - M.l) / (this.w - M.l - M.r);
    const t = 1 - (e.clientY - r.top - M.t) / (this.h - M.t - M.b);
    return [Math.min(1, Math.max(0, s)), Math.min(1, Math.max(0, t))];
  }

  down(e) {
    this.cv.setPointerCapture(e.pointerId);
    const p = this.fromEvent(e);
    this.drag = this.tool === 'rect' ? { s0: p[0], t0: p[1], s1: p[0], t1: p[1], color: this.nextColor() } : { points: [p] };
  }

  move(e) {
    if (!this.drag) return;
    const p = this.fromEvent(e);
    if (this.tool === 'rect') {
      this.drag.s1 = p[0]; this.drag.t1 = p[1];
    } else {
      const q = this.drag.points[this.drag.points.length - 1];
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.02 && this.drag.points.length < MAX_CURVE) this.drag.points.push(p);
    }
    this.draw();
  }

  up() {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    if (this.tool === 'rect') {
      if (Math.abs(d.s1 - d.s0) > 0.01 && Math.abs(d.t1 - d.t0) > 0.01)
        this.add('rect', { s0: Math.min(d.s0, d.s1), s1: Math.max(d.s0, d.s1), t0: Math.min(d.t0, d.t1), t1: Math.max(d.t0, d.t1), color: d.color });
    } else if (d.points.length > 1) {
      this.add('curve', { points: d.points });
    }
    this.draw();
    this.onChange();
  }

  // delete all rectangles or all curves of the active pair
  clear(what) {
    const kind = what === 'rects' ? 'rect' : 'curve';
    this.items = this.items.filter((i) => !(i.kind === kind && i.pair === this.pairKey));
    if (!this.items.some((i) => i.id === this.selectedId)) this.selectedId = null;
    this.draw();
    this.onChange();
  }

  // for save / load: plain data of all selections
  getSelections() { return structuredClone(this.items); }
  setSelections(list) {
    this.items = [];
    this.selectedId = null;
    for (const it of list ?? []) {
      if (!PAIRS[it.pair] || !['rect', 'curve'].includes(it.kind)) continue;
      const { id, n, name, ...rest } = it;
      const added = this.add(it.kind, rest, it.pair);
      if (added && name) added.name = name;
    }
    this.draw();
    this.onChange();
  }

  draw() {
    const { ctx, w, h } = this;
    const { fields, names, units, ranges } = this.info;
    const { x: ix, y: iy } = this.pair;
    const [x0, y0] = this.toPx(0, 1), [x1, y1] = this.toPx(1, 0);
    const { bg, textLight, border } = this.theme;
    ctx.fillStyle = rgb(bg);
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.histImg, x0, y0, x1 - x0, y1 - y0);

    ctx.fillStyle = rgb(textLight); ctx.strokeStyle = rgb(border); ctx.lineWidth = 1;
    ctx.font = `11px ${getComputedStyle(this.cv).fontFamily}`;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    // colour strips along the axes: the colour map each field uses in the 1D transfer function
    const strip = (name, ax, ay, bx, by) => {
      const g = ctx.createLinearGradient(ax, ay, bx, by);
      for (let i = 0; i <= 16; i++) g.addColorStop(i / 16, rgb(colorAt(name, i / 16).map(Math.round)));
      return g;
    };
    ctx.save();
    ctx.fillStyle = strip(mapName(ix, this.cmapChoice), x0, 0, x1, 0); ctx.fillRect(x0, y1 + 2, x1 - x0, STRIP);
    ctx.fillStyle = strip(mapName(iy, this.cmapChoice), 0, y1, 0, y0); ctx.fillRect(x0 - 2 - STRIP, y0, STRIP, y1 - y0);
    ctx.restore();
    const [xl, xh] = ranges[fields[ix]], [yl, yh] = ranges[fields[iy]];
    ctx.textAlign = 'center';
    for (const v of niceTicks(xl, xh)) ctx.fillText(v, this.toPx((v - xl) / (xh - xl), 0)[0], y1 + STRIP + 15);
    ctx.fillText(`${names[ix]} (${units[ix]})`, (x0 + x1) / 2, y1 + STRIP + 29);
    ctx.textAlign = 'right';
    for (const v of niceTicks(yl, yh)) ctx.fillText(v, x0 - STRIP - 5, this.toPx(0, (v - yl) / (yh - yl))[1] + 4);
    ctx.save();
    ctx.translate(11, (y0 + y1) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center';
    ctx.fillText(`${names[iy]} (${units[iy]})`, 0, 0);
    ctx.restore();

    const mine = this.items.filter((i) => i.pair === this.pairKey);
    if (this.showRects) {
      const live = this.drag && this.tool === 'rect' ? [{ ...this.drag, visible: true }] : [];
      for (const r of [...mine.filter((i) => i.kind === 'rect'), ...live]) {
        const [a, b] = this.toPx(r.s0, r.t1), [c, d] = this.toPx(r.s1, r.t0);
        ctx.fillStyle = `rgba(${r.color},0.25)`; ctx.strokeStyle = `rgb(${r.color})`; ctx.lineWidth = 2;
        ctx.fillRect(Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b));
        ctx.strokeRect(Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b));
      }
    }
    if (this.showCurve) {
      const live = this.drag?.points ? [{ points: this.drag.points, color: this.nextColor() }] : [];
      for (const c of [...mine.filter((i) => i.kind === 'curve'), ...live]) {
        ctx.strokeStyle = rgb(c.color); ctx.lineWidth = 2; ctx.beginPath();
        c.points.forEach(([s, t], i) => { const [px, py] = this.toPx(s, t); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
        ctx.stroke();
      }
    }
    this.drawLegend();
  }

  // 256x256 RGBA texture data for the region transfer function of the active pair (x = first axis, y = second)
  regionTF(size = 256) {
    const data = new Uint8Array(size * size * 4);
    for (const r of this.rects) {
      const sa = Math.floor(r.s0 * size), sb = Math.ceil(r.s1 * size);
      const ta = Math.floor(r.t0 * size), tb = Math.ceil(r.t1 * size);
      for (let ty = ta; ty < tb && ty < size; ty++)
        for (let sx = sa; sx < sb && sx < size; sx++) data.set([...r.color, 255], (ty * size + sx) * 4);
    }
    return data;
  }
}
