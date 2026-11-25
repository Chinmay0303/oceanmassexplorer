import './simple.css';
import './style.css';
import { VERT, FRAG, MAX_CURVE, MAX_CURVES, MAX_RECTS } from './shaders.js';
import { TSPanel, buildHists, PAIRS, PAIR_KEYS } from './ts.js';
import { themeColors } from './theme.js';

import { openData } from './data.js';
import { colormapTable, mapName, CHOICES } from './colormaps.js';
import { drawColorbar } from './legend.js';
import { renderSelections } from './selections-ui.js';

const $ = (id) => document.getElementById(id);
const status = $('status');
const HELP = 'Drag: rotate · right/Shift-drag: pan · scroll: zoom to cursor · WASD/arrows, R/F, Q/E: move · click: pick a point · Home: reset view';

// ---------- data ----------
let data;
try { data = await openData(); } catch (e) { status.textContent = 'Could not load ocean data: ' + e.message; throw e; }
const meta = data.meta;
const { nx, ny } = meta;
const cur = { name: Object.keys(meta.datasets)[0], k: 0 };
cur.ds = meta.datasets[cur.name];
const first = await data.loadStep(cur.name, cur.ds.steps[0]);
cur.nz = first.nz;
// what the T-S panel needs to know about the loaded step
const panelMeta = () => ({ nx, ny, nz: cur.ds.nz, depth: cur.ds.depth, lat0: meta.lat0, dlat: meta.dlat, ranges: meta.ranges });

// ---------- GL ----------
const canvas = $('gl');
const gl = canvas.getContext('webgl2');
if (!gl) { status.textContent = 'WebGL2 is not supported by this browser.'; throw new Error('no webgl2'); }

function program(vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}
const prog = program(VERT, FRAG);
gl.useProgram(prog);
const U = new Proxy({}, { get: (_, n) => gl.getUniformLocation(prog, n) });

function tex(target, unit, setup) {
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(target, t);
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  setup();
  return t;
}

// Volumes: one RGBA16F 3D texture (T, S, O2, ocean mask) per time step of the current dataset, uploaded one
// depth level at a time to keep memory low. Annual = 1 texture (53 MB), monthly = 12 textures (12 x 30 MB), so every
// month is on the GPU and switching / animating needs no upload. Uploads use texture unit UPLOAD_UNIT so they never
// disturb the units the shader samples from.
const UPLOAD_UNIT = 7;
function makeVolume(d) {
  return tex(gl.TEXTURE_3D, UPLOAD_UNIT, () => {
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA16F, nx, ny, d.nz);
    const n = nx * ny, level = new Float32Array(n * 4);
    for (let k = 0; k < d.nz; k++) {
      for (let i = 0, idx = k * n; i < n; i++, idx++) {
        level[i * 4] = d.t[idx] / 65535;
        level[i * 4 + 1] = d.s[idx] / 65535;
        level[i * 4 + 2] = d.o ? d.o[idx] / 65535 : 0;
        level[i * 4 + 3] = d.mask[idx] & 1;
      }
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, k, nx, ny, 1, gl.RGBA, gl.FLOAT, level);
    }
  });
}
// per-dataset state kept on `cur`: tex[k] GPU volume of step k, hists[k] its diagram histograms,
// histMax = brightness normalisation over all loaded steps, ready = number of loaded steps
function resetVolumes() {
  for (const t of cur.tex ?? []) gl.deleteTexture(t);
  Object.assign(cur, { tex: [], hists: [], histMax: {}, ready: 0 });
}
function addStep(k, d) {
  cur.tex[k] = makeVolume(d);
  cur.hists[k] = buildHists(d, panelMeta());
  for (const [key, h] of Object.entries(cur.hists[k])) {
    let m = cur.histMax[key] ?? 0;
    for (const v of h) if (v > m) m = v;
    cur.histMax[key] = m;
  }
  cur.ready++;
}
resetVolumes();
addStep(0, first);

// 1D colour map (256 x 1): each field has its own default map (temperature thermal, salinity haline, oxygen oxy);
// the table is re-uploaded when the field or the colour-map choice changes
const cmapTex = tex(gl.TEXTURE_2D, 2, () => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, colormapTable('thermal')));
let cmapName = 'thermal';
function updateColormap() {
  const name = mapName(+$('field').value, $('cmap').value);
  if (name === cmapName) return;
  cmapName = name;
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, cmapTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, colormapTable(name));
}

// region transfer function: one 256 x 256 layer per diagram (rectangles drawn as volumes); nearest filtering = sharp edges
const tf2 = tex(gl.TEXTURE_2D_ARRAY, 3, () => {
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 256, 256, PAIR_KEYS.length);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
});

// signed distance to each curve in its diagram: one 512 x 512 layer per curve slot, recomputed when the curve in a slot changes
const SDF = 512;
const sdfTex = tex(gl.TEXTURE_2D_ARRAY, 4, () => gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RG16F, SDF, SDF, MAX_CURVES));
const sdfKeys = Array(MAX_CURVES).fill('');   // which curve (points as JSON) each layer currently holds
const sdfCache = new Map();                    // recently computed distance fields, so slots can be reshuffled cheaply
function curveSDF(curve) {
  const out = new Float32Array(SDF * SDF * 2);
  for (let y = 0; y < SDF; y++)
    for (let x = 0; x < SDF; x++) {
      const px = (x + 0.5) / SDF, py = (y + 0.5) / SDF;
      let best = 1e9, sgn = 1, edge = 1;
      for (let i = 0; i < curve.length - 1; i++) {
        const [ax, ay] = curve[i], bx = curve[i + 1][0] - ax, by = curve[i + 1][1] - ay;
        const qx = px - ax, qy = py - ay;
        const t = (qx * bx + qy * by) / Math.max(bx * bx + by * by, 1e-12);
        const c = Math.min(1, Math.max(0, t));
        const d = Math.hypot(qx - bx * c, qy - by * c);
        if (d < best) { best = d; sgn = bx * qy - by * qx < 0 ? -1 : 1; edge = t < 0 || t > 1 ? 1 : 0; }
      }
      out.set([best * sgn, edge], (y * SDF + x) * 2);
    }
  return out;
}

gl.uniform1i(U.uVol, 0); gl.uniform1i(U.uVolB, 5); gl.uniform1i(U.uTF1, 2); gl.uniform1i(U.uTF2, 3); gl.uniform1i(U.uSDF, 4);
gl.uniform1f(U.uBand, 0.01);

// ---------- camera ----------
// Orbit camera around `target`. Left drag orbits; right/middle/Shift drag pans; wheel zooms to the cursor;
// WASD/arrows move, R/F up/down, Q/E zoom; the Reset button or Home resets.
const TAN = Math.tan(0.4);
const HOME = { az: 0.4, el: 0.7, dist: 3.2, target: [0, 0, 0] };
const cam = structuredClone(HOME);
const LIMIT = [1.2, 0.6, 0.7]; // target stays near the volume
let lastInteract = 0, lastScale = 1;
let dirty = true;
const redraw = () => { dirty = true; };
const interact = () => { lastInteract = performance.now(); dirty = true; };  // low-res render while interacting

function basis() {
  const ce = Math.cos(cam.el);
  const dir = [ce * Math.sin(cam.az), Math.sin(cam.el), ce * Math.cos(cam.az)]; // target -> eye
  const fwd = dir.map((v) => -v);
  const right = norm(cross(fwd, [0, 1, 0]));
  return { dir, fwd, right, up: cross(right, fwd) };
}
function clampTarget() { cam.target = cam.target.map((v, i) => Math.max(-LIMIT[i], Math.min(LIMIT[i], v))); }
function pan(dx, dy) { // dx, dy in focus-plane world units along right / up
  const { right, up } = basis();
  cam.target = cam.target.map((v, i) => v + right[i] * dx + up[i] * dy);
  clampTarget();
}

// reset: the Reset view button or the Home key (no double-click: two quick picks would reset the camera)
const resetView = () => { Object.assign(cam, structuredClone(HOME)); interact(); };
let drag = null, downAt = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  document.activeElement?.blur();
  canvas.setPointerCapture(e.pointerId);
  downAt = { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey };
  drag = e.button === 1 || e.button === 2 || e.shiftKey ? 'pan' : 'orbit';
  canvas.style.cursor = drag === 'pan' ? 'move' : 'grabbing';
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag === 'pan') {
    const wpp = (2 * TAN * cam.dist) / canvas.clientHeight;  // world units per screen pixel at the focus plane
    pan(-e.movementX * wpp, e.movementY * wpp);
  } else {
    cam.az -= e.movementX * 0.006;
    cam.el = Math.max(-1.5, Math.min(1.5, cam.el + e.movementY * 0.006));
  }
  interact();
});
canvas.addEventListener('pointerup', (e) => {
  // a click (left button, hardly moved) picks the ocean point under the cursor
  const click = downAt && downAt.button === 0 && !downAt.shift && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 4;
  downAt = null; drag = null; canvas.style.cursor = 'grab';
  if (click) pickAt(e.clientX, e.clientY);
});

// zoom by `k` (< 1 zooms in), keeping the point under the cursor (ndc x, y) fixed
function zoom(k, x = 0, y = 0) {
  const d = Math.max(0.02, Math.min(10, cam.dist * k));
  const { right, up } = basis();
  const s = (cam.dist - d) * TAN;
  const aspect = canvas.clientWidth / canvas.clientHeight;
  cam.target = cam.target.map((v, i) => v + s * (x * aspect * right[i] + y * up[i]));
  cam.dist = d;
  clampTarget();
}
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  const r = canvas.getBoundingClientRect();
  zoom(Math.exp(Math.max(-300, Math.min(300, px)) * 0.002), ((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2);
  interact();
}, { passive: false });

const keys = new Set();
addEventListener('keydown', (e) => { if (!/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) keys.add(e.key.toLowerCase()); });
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());
function moveByKeys(dt) {
  if (!keys.size) return;
  const { fwd, right } = basis();
  const flat = norm([fwd[0], 0, fwd[2]]);
  const step = cam.dist * 0.8 * dt;  // speed scales with zoom
  const has = (...k) => k.some((x) => keys.has(x));
  const m = [(has('d', 'arrowright') ? 1 : 0) - (has('a', 'arrowleft') ? 1 : 0), (has('r') ? 1 : 0) - (has('f') ? 1 : 0), (has('w', 'arrowup') ? 1 : 0) - (has('s', 'arrowdown') ? 1 : 0)];
  cam.target = cam.target.map((v, i) => v + step * (m[0] * right[i] + m[2] * flat[i] + (i === 1 ? m[1] : 0)));
  clampTarget();
  if (has('q', 'e')) zoom(Math.exp(((has('q') ? 1 : 0) - (has('e') ? 1 : 0)) * 1.5 * dt));
  if (m.some(Boolean) || has('q', 'e')) interact();
}

// ---------- T-S panel ----------
const renderList = () => renderSelections($('selList'), panel);
const panel = new TSPanel($('ts'), { fields: meta.fields, names: meta.names, units: meta.units, ranges: meta.ranges },
  () => { uploadSelection(); redraw(); renderList(); },                  // selections changed
  () => { $('pair').value = panel.pairKey; renderList(); });             // selection or diagram changed
panel.setHists(cur.hists[0], cur.histMax);

function uploadSelection() {
  // rectangles drawn as volumes: one region transfer function layer per diagram
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tf2);
  let fillMask = 0;
  PAIR_KEYS.forEach((key, i) => {
    if (!panel.volumeRectsOf(key).length) return;
    fillMask |= 1 << i;
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, 256, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, panel.regionTF(key));
  });
  gl.uniform1i(U.uFillMask, fillMask);

  // curves (all diagrams): layer i of the distance texture holds the i-th visible curve
  const curves = panel.curves.slice(0, MAX_CURVES);
  gl.activeTexture(gl.TEXTURE4);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, sdfTex);
  const curveCol = new Float32Array(MAX_CURVES * 3), curvePair = new Int32Array(MAX_CURVES);
  curves.forEach((c, i) => {
    const pts = c.points.slice(0, MAX_CURVE), key = JSON.stringify(pts);
    if (sdfKeys[i] !== key) {
      if (!sdfCache.has(key)) {
        if (sdfCache.size >= 8) sdfCache.delete(sdfCache.keys().next().value);
        sdfCache.set(key, curveSDF(pts));
      }
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, SDF, SDF, 1, gl.RG, gl.FLOAT, sdfCache.get(key));
      sdfKeys[i] = key;
    }
    curveCol.set(c.color.map((v) => v / 255), i * 3);
    curvePair[i] = PAIRS[c.pair].index;
  });
  gl.uniform1i(U.uNCurve, curves.length);
  gl.uniform3fv(U.uCurveColor, curveCol);
  gl.uniform1iv(U.uCurvePair, curvePair);

  // rectangles drawn as surfaces (all diagrams)
  const rects = panel.surfaceRects.slice(0, MAX_RECTS);
  const box = new Float32Array(MAX_RECTS * 4), col = new Float32Array(MAX_RECTS * 3), rectPair = new Int32Array(MAX_RECTS);
  rects.forEach((r, i) => {
    box.set([(r.s0 + r.s1) / 2, (r.t0 + r.t1) / 2, (r.s1 - r.s0) / 2, (r.t1 - r.t0) / 2], i * 4);
    col.set(r.color.map((c) => c / 255), i * 3);
    rectPair[i] = PAIRS[r.pair].index;
  });
  gl.uniform4fv(U.uRect, box);
  gl.uniform3fv(U.uRectColor, col);
  gl.uniform1iv(U.uRectPair, rectPair);
  gl.uniform1i(U.uNRect, rects.length);
}

$('pair').addEventListener('change', () => panel.setPair($('pair').value));
[...$('pair').options].forEach((o) => { o.disabled = PAIRS[o.value].x >= meta.fields.length; });  // oxygen pairs need the oxygen field
document.querySelectorAll('input[name=tool]').forEach((r) => r.addEventListener('change', () => panel.setTool(r.value)));
$('deleteAll').onclick = () => {
  if (panel.items.length > 1 && !confirm(`Delete all ${panel.items.length} selections?`)) return;
  panel.clearAll();
};
addEventListener('keydown', (e) => {  // Delete / Backspace removes the selected item (not while typing)
  if ((e.key === 'Delete' || e.key === 'Backspace') && !/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && panel.selectedId != null) {
    e.preventDefault();
    panel.deleteSelected();
  }
});

// ---------- controls ----------
for (const [v, label] of CHOICES) $('cmap').add(new Option(label, v));
const ids = ['quality', 'field', 'cmap', 'winLo', 'winHi', 'opacity', 'context', 'depthScale', 'sliceDepth', 'c0', 'c1', 'c2', 'c3', 'c4', 'c5'];
function applyControls() {
  const tf = $('tf1d').checked;
  gl.uniform1i(U.uTF1D, tf ? 1 : 0);
  for (const id of ['field', 'cmap', 'winLo', 'winHi']) $(id).disabled = !tf;  // only used by the 1D transfer function
  gl.uniform1i(U.uField, +$('field').value);
  updateColormap();
  const lo = +$('winLo').value, hi = Math.max(+$('winHi').value, lo + 0.005);
  gl.uniform2f(U.uWin, lo, hi);
  gl.uniform1f(U.uOpacity, +$('opacity').value);
  gl.uniform1i(U.uSteps, +$('quality').value);
  gl.uniform1f(U.uContext, +$('context').value);
  gl.uniform1f(U.uD, +$('depthScale').value * cur.nz / 102);  // same height per level in every dataset
  const c = [0, 1, 2, 3, 4, 5].map((i) => +$('c' + i).value);
  gl.uniform3f(U.uClipMin, Math.min(c[0], c[1]), Math.min(c[2], c[3]), Math.min(c[4], c[5]));
  gl.uniform3f(U.uClipMax, Math.max(c[0], c[1]), Math.max(c[2], c[3]), Math.max(c[4], c[5]));
  panel.cmapChoice = $('cmap').value;
  panel.draw();
  const k = +$('sliceDepth').value;
  $('sliceLabel').textContent = `${cur.ds.depth[k]} m`;
  gl.uniform1f(U.uSlice, $('slice').checked ? (k + 0.5) / cur.nz : -1);
  const fi = +$('field').value, [r0, r1] = meta.ranges[meta.fields[fi]];
  const real = (u) => (r0 + u * (r1 - r0)).toFixed(fi === 2 ? 0 : 1);
  $('winLabel').textContent = `${meta.names[fi]} window: ${real(lo)} to ${real(hi)} ${meta.units[fi]}`;
  $('cbar').hidden = !tf;  // the colour bar belongs to the 1D transfer function
  $('winLabel').hidden = !tf;
  if (!$('cbar').hidden) drawColorbar($('cbar'), { map: cmapName, lo: r0 + lo * (r1 - r0), hi: r0 + hi * (r1 - r0), label: meta.names[fi], unit: meta.units[fi] });
  interact();
}
const checks = ['tf1d', 'slice'];
[...ids, ...checks].forEach((id) => $(id).addEventListener('input', applyControls));
$('slice').addEventListener('change', () => { if ($('slice').checked) cam.el = Math.max(cam.el, 1.2); });  // look down on the map
// ---------- dataset / time step ----------
const dsSel = $('dataset'), stepEl = $('step');
for (const [name, d] of Object.entries(meta.datasets)) dsSel.add(new Option(d.label, name));
[...$('field').options].forEach((o, i) => { o.disabled = i >= meta.fields.length; });
$('dataInfo').textContent = [meta.source, meta.span && `Span ${meta.span}`].filter(Boolean).join(' · ');

function syncStepUi() {
  const ds = cur.ds;
  $('stepRow').hidden = ds.steps.length < 2;
  stepEl.max = ds.steps.length - 1;
  stepEl.value = cur.k;
  $('animRow').hidden = ds.steps.length < 2;
  playBtn.disabled = cur.ready < ds.steps.length;
  stepEl.disabled = cur.ready < ds.steps.length;  // steps are selectable once all are on the GPU
  $('stepLabel').textContent = ds.stepLabels[cur.k];
  $('sliceDepth').max = cur.nz - 1;
  $('sliceDepth').value = Math.min(+$('sliceDepth').value, cur.nz - 1);
}
// ---- playback: pos = position in steps (fractional while blending); cur.k = nearest step, shown in UI/diagram ----
const anim = { playing: false, pos: 0 };
const playBtn = $('play');
function setPlaying(on) {
  anim.playing = on && cur.ready === cur.ds.steps.length && cur.ds.steps.length > 1;
  if (!anim.playing) anim.pos = cur.k;  // stop on an exact step
  playBtn.textContent = anim.playing ? 'Pause' : 'Play';
  redraw();
}
playBtn.addEventListener('click', () => setPlaying(!anim.playing));
addEventListener('keydown', (e) => {
  if (e.key === ' ' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName)) { e.preventDefault(); setPlaying(!anim.playing); }
});
$('smooth').addEventListener('input', redraw);

let loadToken = 0;
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const showHists = () => panel.setHists(cur.hists[cur.k], cur.histMax);

// show step k of the current dataset (must be loaded)
function setStep(k, setPos = true) {
  if (!cur.tex[k]) return;
  clearProbe();  // the picked values belong to the previous time step
  cur.k = k;
  if (setPos) anim.pos = k;
  stepEl.value = k;
  $('stepLabel').textContent = cur.ds.stepLabels[k];
  showHists();
  redraw();
}
// load the remaining steps of the current dataset in the background (token = request that started it)
async function preloadRest(my) {
  const n = cur.ds.steps.length;
  for (let j = 0; j < n; j++) {
    if (cur.tex[j]) continue;
    status.textContent = `Loading ${cur.ds.label.toLowerCase()} data: ${cur.ready}/${n} ${cur.ds.stepLabels[j]}…`;
    let d;
    try { d = await data.loadStep(cur.name, cur.ds.steps[j]); } catch (e) { status.textContent = 'Could not load data: ' + e.message; return; }
    if (my !== loadToken) return;
    addStep(j, d);
    await nextFrame();
    if (my !== loadToken) return;
  }
  syncStepUi();
  showHists();
  status.textContent = HELP;
}
// switch dataset (loads step k first and shows it; the other steps follow in the background)
async function selectDataset(name, k = 0) {
  const my = ++loadToken, ds = meta.datasets[name];
  setPlaying(false);
  status.textContent = `Loading ${ds.label} ${ds.stepLabels[k]}…`;
  let d;
  try { d = await data.loadStep(name, ds.steps[k]); } catch (e) { status.textContent = 'Could not load data: ' + e.message; return; }
  if (my !== loadToken) return;
  clearProbe();
  resetVolumes();
  Object.assign(cur, { name, k, ds, nz: d.nz });
  anim.pos = k;
  addStep(k, d);
  syncStepUi();
  showHists();
  applyControls();
  if (cur.ds.steps.length > 1) preloadRest(my); else status.textContent = HELP;
}
dsSel.addEventListener('change', () => selectDataset(dsSel.value, 0));
stepEl.addEventListener('input', () => setStep(+stepEl.value));
syncStepUi();

// ---------- save / load ----------
$('save').onclick = () => {
  const state = {
    controls: Object.fromEntries([...ids, ...checks].map((id) => [id, checks.includes(id) ? $(id).checked : $(id).value])),
    camera: cam, pair: panel.pairKey, selections: panel.getSelections(),
    data: { dataset: cur.name, step: cur.k },
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' }));
  a.download = 'ocean-config.json';
  a.click();
  URL.revokeObjectURL(a.href);
};
$('load').onclick = () => $('file').click();
$('reset').onclick = resetView;
// selections as a flat list; older configs had rects/curve (T-S only) or one {rects, curve} set per diagram
function migrateSelections(s) {
  if (Array.isArray(s.selections)) return s.selections;
  const per = s.selections ?? { ts: { rects: s.rects, curve: s.curve } };
  const out = [];
  for (const [pair, v] of Object.entries(per)) {
    for (const r of v?.rects ?? []) out.push({ kind: 'rect', pair, ...r });
    if (v?.curve?.length > 1) out.push({ kind: 'curve', pair, points: v.curve });
  }
  return out;
}
$('file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const s = JSON.parse(await f.text());
    for (const [id, v] of Object.entries(s.controls)) {
      if (!$(id) || id === 'mode') continue;  // controls that no longer exist
      checks.includes(id) ? ($(id).checked = v) : ($(id).value = v);
    }
    if (s.controls.mode !== undefined && s.controls.tf1d === undefined) $('tf1d').checked = s.controls.mode === '0';  // old 'Mode' select
    Object.assign(cam, structuredClone(HOME), s.camera);
    const want = s.data;
    if (want && meta.datasets[want.dataset]) {
      const k = Math.min(want.step, meta.datasets[want.dataset].steps.length - 1);
      if (want.dataset !== cur.name) { dsSel.value = want.dataset; await selectDataset(want.dataset, k); }
      else setStep(k);
    }
    applyControls();
    const pk = PAIRS[s.pair] && !$('pair').querySelector(`option[value=${s.pair}]`).disabled ? s.pair : 'ts';
    $('pair').value = pk;
    panel.setPair(pk);
    panel.setSelections(migrateSelections(s));
  } catch (err) {
    alert('Could not load configuration: ' + err.message);
  }
  e.target.value = '';
};

// ---------- render loop ----------
let lastT = 0;
function render(now) {
  requestAnimationFrame(render);
  const dt = Math.min((now - lastT) / 1000, 0.1);
  lastT = now;
  moveByKeys(dt);
  updatePin();
  const n = cur.ds.steps.length, loop = $('loop').checked;
  if (anim.playing) {
    anim.pos += dt * +$('speed').value;
    if (anim.pos >= n) { if (loop) anim.pos %= n; else { anim.pos = n - 1; setPlaying(false); } }
    const k = Math.round(anim.pos) % n;
    if (k !== cur.k) setStep(k, false);
    interact();  // half resolution while playing, full resolution after pausing
  }
  const sc = now - lastInteract < 200 ? 0.5 : 1;
  if (sc !== lastScale) { lastScale = sc; dirty = true; }
  const dpr = Math.min(devicePixelRatio || 1, 2) * sc;
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); dirty = true; }
  if (!dirty) return;
  dirty = false;

  const { dir, fwd, right, up } = basis();
  const eye = cam.target.map((t, i) => t + cam.dist * dir[i]);
  gl.uniform3fv(U.uEye, eye); gl.uniform3fv(U.uFwd, fwd); gl.uniform3fv(U.uRight, right); gl.uniform3fv(U.uUp, up);
  gl.uniform1f(U.uTan, TAN);
  gl.uniform1f(U.uAspect, w / h);
  // volumes: A = current step, B = next step (only sampled while blending)
  let a = cur.k, b = cur.k, blend = 0;
  if (anim.playing && $('smooth').checked) {
    a = Math.floor(anim.pos) % n;
    b = loop ? (a + 1) % n : Math.min(a + 1, n - 1);
    blend = anim.pos - Math.floor(anim.pos);
  }
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, cur.tex[a]);
  gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_3D, cur.tex[b]);
  gl.uniform1f(U.uBlend, blend);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(...a); return a.map((v) => v / l); }

// ---------- picking: click the ocean to read its values ----------
// A small extra pass (uPick) writes the first ocean sample under the cursor into a 4 x 1 RGBA8 target (no float
// render targets needed); the result is decoded here, shown in #readout, marked in the diagram and pinned in 3D.
const pickTex = gl.createTexture();
gl.activeTexture(gl.TEXTURE6);
gl.bindTexture(gl.TEXTURE_2D, pickTex);
gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 4, 1);
const pickFbo = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pickTex, 0);
gl.bindFramebuffer(gl.FRAMEBUFFER, null);

let probe = null;  // { tc: texture coords [u, v, w], val: normalised [T, S, O2] }
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const currentUD = () => +$('depthScale').value * cur.nz / 102;

function pickRaw(ndcX, ndcY) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, pickFbo);
  gl.viewport(0, 0, 4, 1);
  gl.uniform1i(U.uPick, 1);
  gl.uniform2f(U.uPickNdc, ndcX, ndcY);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = new Uint8Array(16);
  gl.readPixels(0, 0, 4, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.uniform1i(U.uPick, 0);
  if (!px[12]) return null;
  const u16 = (i) => (px[i] * 256 + px[i + 1]) / 65535;
  return { tc: [u16(0), u16(2), u16(4)], val: [u16(6), u16(8), u16(10)] };
}

function pickAt(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  probe = pickRaw(((clientX - r.left) / r.width) * 2 - 1, 1 - ((clientY - r.top) / r.height) * 2);
  if (probe) showProbe(); else clearProbe();
}

function clearProbe() {
  probe = null;
  $('readout').hidden = true;
  $('pin').hidden = true;
  panel?.setProbe(null);
}

function showProbe() {
  const { tc, val } = probe, [u, v, w] = tc;
  const lon = meta.lon0 + (u * nx - 0.5) * meta.dlon, lat = meta.lat0 + (v * ny - 0.5) * meta.dlat;
  const kk = Math.min(Math.max(w * cur.nz - 0.5, 0), cur.nz - 1), k0 = Math.floor(kk), k1 = Math.min(k0 + 1, cur.nz - 1);
  const depth = cur.ds.depth[k0] * (1 - (kk - k0)) + cur.ds.depth[k1] * (kk - k0);
  const lines = [`${Math.abs(lat).toFixed(1)}°${lat < 0 ? 'S' : 'N'}  ${Math.abs(lon).toFixed(1)}°${lon < 0 ? 'W' : 'E'}  ${depth.toFixed(0)} m`];
  meta.fields.forEach((f, i) => {
    const [r0, r1] = meta.ranges[f];
    lines.push(`${meta.names[i]}: ${(r0 + val[i] * (r1 - r0)).toFixed(i === 2 ? 1 : 2)} ${meta.units[i]}`);
  });
  const near = (pt, pts) => Math.min(...pts.slice(1).map((b, i) => {  // distance from pt to the polyline in the diagram
    const a = pts[i], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
    const t = Math.min(1, Math.max(0, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / l2));
    return Math.hypot(pt[0] - a[0] - t * dx, pt[1] - a[1] - t * dy);
  }));
  const inside = panel.items.filter((it) => {
    const d = PAIRS[it.pair], pt = [val[d.x], val[d.y]];
    return it.kind === 'rect' ? pt[0] >= it.s0 && pt[0] <= it.s1 && pt[1] >= it.t0 && pt[1] <= it.t1 : near(pt, it.points) < 0.02;
  });
  if (inside.length) lines.push('In: ' + inside.map((it) => it.name).join(', '));
  $('readout').textContent = lines.join('\n');
  $('readout').hidden = false;
  panel.setProbe(val);
  updatePin();
}

// keep the pin on the picked point while the camera moves (it is drawn on top, not occluded)
function updatePin() {
  const pin = $('pin');
  if (!probe) { pin.hidden = true; return; }
  const [u, v, w] = probe.tc, uD = currentUD();
  const P = [(u - 0.5) * 2, (0.5 - w) * 2 * uD, 0.5 - v];
  const { dir, fwd, right, up } = basis();
  const rel = P.map((c, i) => c - (cam.target[i] + cam.dist * dir[i]));
  const d = dot3(rel, fwd);
  const xn = dot3(rel, right) / (d * TAN * (canvas.clientWidth / canvas.clientHeight)), yn = dot3(rel, up) / (d * TAN);
  pin.hidden = d <= 0.01 || Math.abs(xn) > 1.05 || Math.abs(yn) > 1.05;
  pin.style.left = `${((xn + 1) / 2) * canvas.clientWidth}px`;
  pin.style.top = `${((1 - yn) / 2) * canvas.clientHeight}px`;
}
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') clearProbe();
  if (e.key === 'Home' && !/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) resetView();
});

// canvases follow the page theme (light / dark)
function applyTheme() {
  const t = themeColors(), f = (c) => c.map((v) => v / 255);
  gl.uniform3fv(U.uBg, f(t.bg));
  gl.uniform3fv(U.uLand, f(t.border));
  gl.uniform3fv(U.uEdge, f(t.textLight));
  panel.refreshTheme();
  redraw();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyTheme(); applyControls(); });
applyTheme();

// starting selection: warm salty box plus a thermocline-like curve
panel.setSelections([
  { kind: 'rect', pair: 'ts', s0: 0.8, s1: 1, t0: 0.55, t1: 1 },
  { kind: 'curve', pair: 'ts', points: [[0.8, 0.15], [0.84, 0.4], [0.88, 0.7]] },
]);
applyControls();
if (cur.ds.steps.length > 1) preloadRest(loadToken); else status.textContent = HELP;
render(performance.now());
