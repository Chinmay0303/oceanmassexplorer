import { MAX_CURVE, MAX_RECTS } from './shaders.js';
import { themeColors, CURVE_RGB } from './theme.js';

const BINS = 256;
// categorical colours, none of them blue (the palette blues are the ocean) or the curve's green
export const RECT_COLORS = [[214, 48, 49], [230, 126, 34], [142, 68, 173], [233, 30, 140], [241, 196, 15], [121, 85, 72], [0, 150, 136], [90, 90, 90]];
const rgb = (c) => `rgb(${c})`;
const M = { l: 44, r: 10, t: 10, b: 32 }; // plot margins in px

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
function ticks(lo, hi, n = 4) {
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
    this.sel = Object.fromEntries(Object.keys(PAIRS).map((k) => [k, { rects: [], curve: [] }]));
    this.showCurve = true;
    this.showRects = true;
    this.drag = null;
    this.theme = themeColors();
    this.hists = null;
    this.histMax = null;
    this.histImg = this.renderHist();
    this.resize();
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', () => this.up());
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  // selections of the active pair (the 3D view shows these)
  get rects() { return this.sel[this.pairKey].rects; }
  set rects(v) { this.sel[this.pairKey].rects = v; }
  get curve() { return this.sel[this.pairKey].curve; }
  set curve(v) { this.sel[this.pairKey].curve = v; }
  get pair() { return PAIRS[this.pairKey]; }

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

  renderHist() {
    const img = new ImageData(BINS, BINS);
    const hist = this.hists?.[this.pairKey];
    let max = this.histMax?.[this.pairKey] ?? 0;
    if (hist && !max) for (const v of hist) max = Math.max(max, v);
    const lmax = Math.log1p(max) || 1;
    // light theme: accent background -> secondary -> primary; dark theme: -> primary -> tertiary
    const { bg, accentBg, primary, secondary, tertiary } = this.theme;
    const dark = bg[0] + bg[1] + bg[2] < 384;
    const stops = dark ? [accentBg, primary, tertiary] : [accentBg, secondary, primary];
    const ramp = (u) => {
      const f = u * (stops.length - 1), k = Math.min(Math.floor(f), stops.length - 2), w = f - k;
      return stops[k].map((c, i) => c * (1 - w) + stops[k + 1][i] * w);
    };
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
    if (this.tool === 'rect') {
      this.drag = { s0: p[0], t0: p[1], s1: p[0], t1: p[1], color: RECT_COLORS[this.rects.length % RECT_COLORS.length] };
    } else {
      this.curve = [p];
      this.drag = true;
    }
  }

  move(e) {
    if (!this.drag) return;
    const p = this.fromEvent(e);
    if (this.tool === 'rect') {
      this.drag.s1 = p[0]; this.drag.t1 = p[1];
    } else {
      const q = this.curve[this.curve.length - 1];
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.02 && this.curve.length < MAX_CURVE) this.curve.push(p);
    }
    this.draw();
  }

  up() {
    if (!this.drag) return;
    if (this.tool === 'rect') {
      const d = this.drag;
      if (this.rects.length < MAX_RECTS && Math.abs(d.s1 - d.s0) > 0.01 && Math.abs(d.t1 - d.t0) > 0.01)
        this.rects.push({ s0: Math.min(d.s0, d.s1), s1: Math.max(d.s0, d.s1), t0: Math.min(d.t0, d.t1), t1: Math.max(d.t0, d.t1), color: d.color });
    } else if (this.curve.length < 2) {
      this.curve = [];
    }
    this.drag = null;
    this.draw();
    this.onChange();
  }

  clear(what) {
    if (what === 'rects') this.rects = [];
    else this.curve = [];
    this.draw();
    this.onChange();
  }

  // selection of the active pair
  setSelection(rects, curve) {
    this.rects = rects; this.curve = curve;
    this.draw();
    this.onChange();
  }

  // all pairs: { ts: { rects, curve }, ... } (for save / load)
  getSelections() { return structuredClone(this.sel); }
  setSelections(sel) {
    for (const k of Object.keys(PAIRS)) this.sel[k] = { rects: sel?.[k]?.rects ?? [], curve: sel?.[k]?.curve ?? [] };
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
    const [xl, xh] = ranges[fields[ix]], [yl, yh] = ranges[fields[iy]];
    ctx.textAlign = 'center';
    for (const v of ticks(xl, xh)) ctx.fillText(v, this.toPx((v - xl) / (xh - xl), 0)[0], y1 + 13);
    ctx.fillText(`${names[ix]} (${units[ix]})`, (x0 + x1) / 2, y1 + 27);
    ctx.textAlign = 'right';
    for (const v of ticks(yl, yh)) ctx.fillText(v, x0 - 5, this.toPx(0, (v - yl) / (yh - yl))[1] + 4);
    ctx.save();
    ctx.translate(11, (y0 + y1) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center';
    ctx.fillText(`${names[iy]} (${units[iy]})`, 0, 0);
    ctx.restore();

    const all = !this.showRects ? [] : this.drag && this.tool === 'rect' ? [...this.rects, this.drag] : this.rects;
    for (const r of all) {
      const [a, b] = this.toPx(r.s0, r.t1), [c, d] = this.toPx(r.s1, r.t0);
      ctx.fillStyle = `rgba(${r.color},0.25)`; ctx.strokeStyle = `rgb(${r.color})`; ctx.lineWidth = 2;
      ctx.fillRect(Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b));
      ctx.strokeRect(Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b));
    }
    if (this.curve.length && this.showCurve) {
      ctx.strokeStyle = rgb(CURVE_RGB); ctx.lineWidth = 2; ctx.beginPath();
      this.curve.forEach(([s, t], i) => { const [px, py] = this.toPx(s, t); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.stroke();
    }
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
