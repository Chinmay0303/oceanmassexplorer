import { MAX_CURVE, MAX_CURVES, MAX_RECTS, PAIR_CHANNELS } from './shaders.js';
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

// Diagrams. x / y are field indices (0 = T, 1 = S, 2 = O2) = channels of the volume texture (see PAIR_CHANNELS in
// shaders.js); `index` is the diagram number the shader uses. Every selection belongs to one diagram.
export const PAIRS = {
  ts: { index: 0, x: PAIR_CHANNELS[0][0], y: PAIR_CHANNELS[0][1], label: 'T–S' },
  to: { index: 1, x: PAIR_CHANNELS[1][0], y: PAIR_CHANNELS[1][1], label: 'T–O₂' },
  so: { index: 2, x: PAIR_CHANNELS[2][0], y: PAIR_CHANNELS[2][1], label: 'S–O₂' },
};
export const PAIR_KEYS = Object.keys(PAIRS);

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
  constructor(canvas, info, onChange, onSelect = () => {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.info = info;
    this.onChange = onChange;   // selections changed: update the 3D view
    this.onSelect = onSelect;   // selected item or active diagram changed: update the list
    this.tool = 'rect';
    this.pairKey = 'ts';
    this.items = [];
    this.nextId = 1;
    this.selectedId = null;
    this.drag = null;
    this.theme = themeColors();
    this.probe = null;         // normalised [T, S, O2] of the point picked in the 3D view (marked in every diagram)
    this.cmapChoice = 'auto';  // colour-map choice of the 1D transfer function (colours the axis strips)
    this.hists = null;
    this.histMax = null;
    this.histImg = this.renderHist();
    this.resize();
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', () => this.up());
    canvas.addEventListener('pointerleave', () => { if (!this.drag) this.cv.style.cursor = this.tool === 'select' ? 'default' : 'crosshair'; });
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  // ---- selections: one flat list of items { id, kind: 'rect' | 'curve', pair, name, color, visible, style, ... } ----
  // rect: s0, s1 (x range) and t0, t1 (y range) in normalised coordinates; curve: points [[x, y], ...].
  // The diagram shows the items of the active pair; the 3D view draws the visible items of all diagrams.
  get pair() { return PAIRS[this.pairKey]; }
  get rects() { return this.items.filter((i) => i.kind === 'rect' && i.pair === this.pairKey); }
  // what the 3D view draws, from ALL diagrams:
  get surfaceRects() { return this.items.filter((i) => i.kind === 'rect' && i.visible && i.style !== 'volume'); }   // boundary surfaces
  volumeRectsOf(pair) { return this.items.filter((i) => i.kind === 'rect' && i.pair === pair && i.visible && i.style !== 'surface'); }  // translucent volumes
  get curves() { return this.items.filter((i) => i.kind === 'curve' && i.visible && i.points.length > 1); }

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

  clearAll() {
    this.items = [];
    this.selectedId = null;
    this.draw();
    this.onChange();
  }

  deleteSelected() { if (this.selectedId != null) this.remove(this.selectedId); }

  // select an item (switches the active diagram when it belongs to another one)
  select(id) {
    const it = this.items.find((i) => i.id === id);
    if (it && it.pair !== this.pairKey) this.setPair(it.pair);
    this.selectedId = it ? id : null;
    this.draw();
    this.onSelect();
  }

  setVisible(id, visible) { this.edit(id, { visible }); }
  setStyle(id, style) { this.edit(id, { style }); }
  edit(id, patch) {
    const it = this.items.find((i) => i.id === id);
    if (!it) return;
    Object.assign(it, patch);
    this.draw();
    this.onChange();
  }

  setProbe(values) {
    this.probe = values;
    this.draw();
  }

  setTool(tool) {
    this.tool = tool;
    this.cv.style.cursor = tool === 'select' ? 'default' : 'crosshair';
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
    if (!this.items.some((i) => i.id === this.selectedId && i.pair === key)) this.selectedId = null;
    this.histImg = this.renderHist();
    this.draw();
    this.onChange();
    this.onSelect();
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

  // ---- select tool: hit test, move, resize ----
  // hit = { item, corner } for the item under the pointer (corner = 'nw' | 'ne' | 'sw' | 'se' for a handle of the selected rectangle)
  hitTest(e) {
    const r = this.cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    const mine = this.items.filter((i) => i.pair === this.pairKey);
    const sel = mine.find((i) => i.id === this.selectedId && i.kind === 'rect');
    if (sel) {
      const corners = { nw: [sel.s0, sel.t1], ne: [sel.s1, sel.t1], sw: [sel.s0, sel.t0], se: [sel.s1, sel.t0] };
      for (const [name, [s, t]] of Object.entries(corners)) {
        const [x, y] = this.toPx(s, t);
        if (Math.hypot(px - x, py - y) <= 8) return { item: sel, corner: name };
      }
    }
    for (const it of [...mine].reverse()) {
      if (it.kind === 'rect') {
        const [a, b] = this.toPx(it.s0, it.t1), [c, d] = this.toPx(it.s1, it.t0);
        if (px >= a - 3 && px <= c + 3 && py >= b - 3 && py <= d + 3) return { item: it, corner: null };
      } else {
        for (let k = 0; k < it.points.length - 1; k++) {
          const [ax, ay] = this.toPx(...it.points[k]), [bx, by] = this.toPx(...it.points[k + 1]);
          const l2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1, u = Math.min(1, Math.max(0, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / l2));
          if (Math.hypot(px - (ax + u * (bx - ax)), py - (ay + u * (by - ay))) <= 7) return { item: it, corner: null };
        }
      }
    }
    return null;
  }

  // apply the current select-tool drag to its item
  editDrag(p) {
    const d = this.drag, it = this.items.find((i) => i.id === d.id);
    if (!it) return;
    const o = d.orig, dx = p[0] - d.start[0], dy = p[1] - d.start[1], clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    if (it.kind === 'rect' && d.corner) {  // resize: the opposite corner stays fixed
      const ax = d.corner.includes('w') ? o.s1 : o.s0, ay = d.corner.includes('n') ? o.t0 : o.t1;
      it.s0 = Math.min(ax, p[0]); it.s1 = Math.max(ax, p[0]);
      it.t0 = Math.min(ay, p[1]); it.t1 = Math.max(ay, p[1]);
      if (it.s1 - it.s0 < 0.01) { it.s0 = o.s0; it.s1 = o.s1; }
      if (it.t1 - it.t0 < 0.01) { it.t0 = o.t0; it.t1 = o.t1; }
    } else if (it.kind === 'rect') {  // move, kept inside the diagram
      const mx = clamp(dx, -o.s0, 1 - o.s1), my = clamp(dy, -o.t0, 1 - o.t1);
      it.s0 = o.s0 + mx; it.s1 = o.s1 + mx; it.t0 = o.t0 + my; it.t1 = o.t1 + my;
    } else {
      const xs = o.points.map((q) => q[0]), ys = o.points.map((q) => q[1]);
      const mx = clamp(dx, -Math.min(...xs), 1 - Math.max(...xs)), my = clamp(dy, -Math.min(...ys), 1 - Math.max(...ys));
      it.points = o.points.map(([x, y]) => [x + mx, y + my]);
    }
    d.moved = true;
  }

  down(e) {
    this.cv.setPointerCapture(e.pointerId);
    const p = this.fromEvent(e);
    if (this.tool === 'select') {
      const h = this.hitTest(e);
      this.selectedId = h ? h.item.id : null;
      if (h) this.drag = { edit: true, id: h.item.id, corner: h.corner, start: p, orig: structuredClone(h.item), moved: false };
      this.draw();
      this.onSelect();
      return;
    }
    this.selectedId = null;
    this.onSelect();
    this.drag = this.tool === 'rect' ? { s0: p[0], t0: p[1], s1: p[0], t1: p[1], color: this.nextColor() } : { points: [p] };
  }

  move(e) {
    if (!this.drag) {
      if (this.tool === 'select') {
        const h = this.hitTest(e);
        this.cv.style.cursor = !h ? 'default' : h.corner ? (h.corner === 'nw' || h.corner === 'se' ? 'nwse-resize' : 'nesw-resize') : 'move';
      }
      return;
    }
    const p = this.fromEvent(e);
    if (this.drag.edit) this.editDrag(p);
    else if (this.tool === 'rect') {
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
    if (d.edit) {
      this.draw();
      if (d.moved) this.onChange();  // the 3D view is updated once, when the drag ends
      return;
    }
    if (this.tool === 'rect') {
      if (Math.abs(d.s1 - d.s0) > 0.01 && Math.abs(d.t1 - d.t0) > 0.01)
        this.add('rect', { s0: Math.min(d.s0, d.s1), s1: Math.max(d.s0, d.s1), t0: Math.min(d.t0, d.t1), t1: Math.max(d.t0, d.t1), color: d.color });
    } else if (d.points.length > 1) {
      this.add('curve', { points: d.points });
    }
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
    const liveRect = this.drag && !this.drag.edit && this.tool === 'rect' ? [{ ...this.drag, visible: true, style: 'surface', kind: 'rect' }] : [];
    for (const r of [...mine.filter((i) => i.kind === 'rect'), ...liveRect]) {
      const [a, b] = this.toPx(r.s0, r.t1), [c, d] = this.toPx(r.s1, r.t0), on = r.id === this.selectedId;
      ctx.globalAlpha = r.visible ? 1 : 0.35;
      ctx.setLineDash(r.visible ? [] : [4, 3]);
      ctx.fillStyle = `rgba(${r.color},${r.style === 'surface' ? 0.15 : 0.35})`; ctx.strokeStyle = `rgb(${r.color})`; ctx.lineWidth = on ? 3.5 : 2;
      ctx.fillRect(Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b));
      ctx.strokeRect(Math.min(a, c), Math.min(b, d), Math.abs(c - a), Math.abs(d - b));
      if (on) {  // resize handles
        ctx.setLineDash([]); ctx.fillStyle = rgb(bg); ctx.lineWidth = 2;
        for (const [hx, hy] of [[a, b], [c, b], [a, d], [c, d]]) { ctx.fillRect(hx - 4, hy - 4, 8, 8); ctx.strokeRect(hx - 4, hy - 4, 8, 8); }
      }
    }
    const liveCurve = this.drag?.points ? [{ points: this.drag.points, color: this.nextColor(), visible: true }] : [];
    for (const c of [...mine.filter((i) => i.kind === 'curve'), ...liveCurve]) {
      const on = c.id === this.selectedId;
      ctx.globalAlpha = c.visible ? 1 : 0.35;
      ctx.setLineDash(c.visible ? [] : [4, 3]);
      ctx.strokeStyle = rgb(c.color); ctx.lineWidth = on ? 3.5 : 2; ctx.beginPath();
      c.points.forEach(([s, t], i) => { const [px, py] = this.toPx(s, t); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.stroke();
      if (on) {
        ctx.setLineDash([]); ctx.fillStyle = rgb(c.color);
        for (const [s, t] of c.points) { const [px, py] = this.toPx(s, t); ctx.beginPath(); ctx.arc(px, py, 3, 0, 6.3); ctx.fill(); }
      }
    }
    ctx.globalAlpha = 1; ctx.setLineDash([]);
    if (this.probe) {  // picked point: ring + cross, visible on light and dark backgrounds
      const [px, py] = this.toPx(this.probe[ix], this.probe[iy]);
      ctx.lineWidth = 3; ctx.strokeStyle = '#000';
      ctx.beginPath(); ctx.arc(px, py, 6, 0, 6.3); ctx.moveTo(px - 10, py); ctx.lineTo(px + 10, py); ctx.moveTo(px, py - 10); ctx.lineTo(px, py + 10); ctx.stroke();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
    }
    this.drawLegend();
  }

  // 256x256 RGBA texture data for the region transfer function of one diagram (its rectangles drawn as volumes)
  regionTF(pair, size = 256) {
    const data = new Uint8Array(size * size * 4);
    for (const r of this.volumeRectsOf(pair)) {
      const sa = Math.floor(r.s0 * size), sb = Math.ceil(r.s1 * size);
      const ta = Math.floor(r.t0 * size), tb = Math.ceil(r.t1 * size);
      for (let ty = ta; ty < tb && ty < size; ty++)
        for (let sx = sa; sx < sb && sx < size; sx++) data.set([...r.color, 255], (ty * size + sx) * 4);
    }
    return data;
  }
}
