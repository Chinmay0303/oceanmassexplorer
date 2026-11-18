import { MAX_CURVE, MAX_RECTS } from './shaders.js';
import { themeColors, CURVE_RGB } from './theme.js';

const BINS = 256;
// categorical colours, none of them blue (the palette blues are the ocean) or the curve's green
export const RECT_COLORS = [[214, 48, 49], [230, 126, 34], [142, 68, 173], [233, 30, 140], [241, 196, 15], [121, 85, 72], [0, 150, 136], [90, 90, 90]];
const rgb = (c) => `rgb(${c})`;
const M = { l: 44, r: 10, t: 10, b: 32 }; // plot margins in px

// T-S diagram: 2D volume-weighted histogram plus rectangle and curve selection.
// Coordinates exposed to callers are normalised (s, t) in [0,1]; t is up.
export class TSPanel {
  constructor(canvas, meta, tsData, onChange) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.meta = meta;
    this.onChange = onChange;
    this.tool = 'rect';
    this.rects = []; // {s0,t0,s1,t1,color}
    this.curve = []; // [[s,t],...]
    this.showCurve = true;
    this.showRects = true;
    this.drag = null;
    this.theme = themeColors();
    this.hist = this.buildHist(tsData);
    this.histImg = this.renderHist();
    this.resize();
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', () => this.up());
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  // re-colour for a theme change
  refreshTheme() {
    this.theme = themeColors();
    this.histImg = this.renderHist();
    this.draw();
  }

  buildHist({ t, s, mask }) {
    const { nx, ny, nz, depth, lat0, dlat } = this.meta;
    const h = new Float32Array(BINS * BINS);
    const dz = depth.map((d, i) => (depth[Math.min(i + 1, nz - 1)] - depth[Math.max(i - 1, 0)]) / 2);
    let i = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++) {
        const w = Math.cos(((lat0 + j * dlat) * Math.PI) / 180) * dz[k];
        for (let x = 0; x < nx; x++, i++) {
          if (!mask[i]) continue;
          h[Math.min(BINS - 1, (t[i] >> 8)) * BINS + Math.min(BINS - 1, s[i] >> 8)] += w;
        }
      }
    return h;
  }

  renderHist() {
    const img = new ImageData(BINS, BINS);
    let max = 0;
    for (const v of this.hist) max = Math.max(max, v);
    const lmax = Math.log1p(max);
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
        const v = Math.log1p(this.hist[ty * BINS + sx]) / lmax;
        const o = ((BINS - 1 - ty) * BINS + sx) * 4; // flip so t is up
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

  setSelection(rects, curve) {
    this.rects = rects; this.curve = curve;
    this.draw();
    this.onChange();
  }

  draw() {
    const { ctx, w, h } = this;
    const [x0, y0] = this.toPx(0, 1), [x1, y1] = this.toPx(1, 0);
    const { bg, textLight, border } = this.theme;
    ctx.fillStyle = rgb(bg);
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.histImg, x0, y0, x1 - x0, y1 - y0);

    ctx.fillStyle = rgb(textLight); ctx.strokeStyle = rgb(border); ctx.lineWidth = 1;
    ctx.font = `11px ${getComputedStyle(this.cv).fontFamily}`;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    const [tl, th] = this.meta.t_range, [sl, sh] = this.meta.s_range;
    ctx.textAlign = 'center';
    for (let i = 0; i <= 4; i++) {
      const f = i / 4, [px] = this.toPx(f, 0);
      ctx.fillText((sl + f * (sh - sl)).toFixed(0), px, y1 + 13);
    }
    ctx.fillText('Salinity (PSU)', (x0 + x1) / 2, y1 + 27);
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const f = i / 4, [, py] = this.toPx(0, f);
      ctx.fillText((tl + f * (th - tl)).toFixed(0), x0 - 5, py + 4);
    }
    ctx.save();
    ctx.translate(11, (y0 + y1) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center';
    ctx.fillText('Temperature (°C)', 0, 0);
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

  // 256x256 RGBA texture data for the T-S region transfer function (x = S, y = T)
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
