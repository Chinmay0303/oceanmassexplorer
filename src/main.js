import './simple.css';
import './style.css';
import { VERT, FRAG, MAX_CURVE, MAX_RECTS } from './shaders.js';
import { TSPanel } from './ts.js';
import { themeColors, CURVE_RGB } from './theme.js';

const $ = (id) => document.getElementById(id);
const status = $('status');

async function fetchBin(name, Type) {
  const buf = await (await fetch(`data/${name}`)).arrayBuffer();
  return new Type(buf);
}

// ---------- data ----------
const meta = await (await fetch('data/meta.json')).json();
const [tData, sData, mask] = await Promise.all([fetchBin('t.bin', Uint16Array), fetchBin('s.bin', Uint16Array), fetchBin('mask.bin', Uint8Array)]);
const { nx, ny, nz } = meta;

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

// volume: rgba16f = (T, S, ocean mask), uploaded one depth level at a time to keep memory low
tex(gl.TEXTURE_3D, 0, () => {
  gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA16F, nx, ny, nz);
  const level = new Float32Array(nx * ny * 4), n = nx * ny;
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < n; i++) {
      const idx = k * n + i;
      level.set([tData[idx] / 65535, sData[idx] / 65535, mask[idx], 0], i * 4);
    }
    gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, k, nx, ny, 1, gl.RGBA, gl.FLOAT, level);
  }
});

// 1D colour map (viridis-like stops)
const STOPS = [[68, 1, 84], [65, 68, 135], [42, 120, 142], [34, 168, 132], [122, 209, 81], [253, 231, 37]];
const cmap = new Uint8Array(256 * 4);
for (let i = 0; i < 256; i++) {
  const f = (i / 255) * (STOPS.length - 1), k = Math.min(Math.floor(f), STOPS.length - 2), u = f - k;
  for (let c = 0; c < 3; c++) cmap[i * 4 + c] = STOPS[k][c] * (1 - u) + STOPS[k + 1][c] * u;
  cmap[i * 4 + 3] = 255;
}
tex(gl.TEXTURE_2D, 2, () => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, cmap));

const tf2 = tex(gl.TEXTURE_2D, 3, () => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(256 * 256 * 4)));

// sharp rectangle edges in the T-S transfer function
gl.activeTexture(gl.TEXTURE3);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

// signed distance to the T-S curve, recomputed when the curve changes
const SDF = 512;
const sdfTex = tex(gl.TEXTURE_2D, 4, () => gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG16F, SDF, SDF));
let sdfKey = '';
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

gl.uniform1i(U.uVol, 0); gl.uniform1i(U.uTF1, 2); gl.uniform1i(U.uTF2, 3); gl.uniform1i(U.uSDF, 4);
gl.uniform3fv(U.uFiberColor, CURVE_RGB.map((c) => c / 255));
gl.uniform1f(U.uBand, 0.01);

// ---------- camera ----------
// Orbit camera around `target`. Left drag orbits; right/middle/Shift drag pans; wheel zooms to the cursor;
// WASD/arrows move, R/F up/down, Q/E zoom; double-click resets.
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

let drag = null;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  document.activeElement?.blur();
  canvas.setPointerCapture(e.pointerId);
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
canvas.addEventListener('pointerup', () => { drag = null; canvas.style.cursor = 'grab'; });
canvas.addEventListener('dblclick', () => { Object.assign(cam, structuredClone(HOME)); interact(); });

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
const panel = new TSPanel($('ts'), meta, { t: tData, s: sData, mask }, () => { uploadSelection(); redraw(); });

function uploadSelection() {
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, tf2);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, panel.regionTF());
  const n = Math.min(panel.curve.length, MAX_CURVE);
  const key = JSON.stringify(panel.curve);
  if (n > 1 && key !== sdfKey) {
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, sdfTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SDF, SDF, gl.RG, gl.FLOAT, curveSDF(panel.curve.slice(0, n)));
    sdfKey = key;
  }
  gl.uniform1i(U.uNCurve, n);
  const rects = panel.rects.slice(0, MAX_RECTS);
  const box = new Float32Array(MAX_RECTS * 4), col = new Float32Array(MAX_RECTS * 3);
  rects.forEach((r, i) => {
    box.set([(r.s0 + r.s1) / 2, (r.t0 + r.t1) / 2, (r.s1 - r.s0) / 2, (r.t1 - r.t0) / 2], i * 4);
    col.set(r.color.map((c) => c / 255), i * 3);
  });
  gl.uniform4fv(U.uRect, box);
  gl.uniform3fv(U.uRectColor, col);
  gl.uniform1i(U.uNRect, rects.length);
}

document.querySelectorAll('input[name=tool]').forEach((r) => r.addEventListener('change', () => { panel.tool = r.value; }));
$('clearRects').onclick = () => panel.clear('rects');
$('clearCurve').onclick = () => panel.clear('curve');

// ---------- controls ----------
const ids = ['mode', 'field', 'winLo', 'winHi', 'opacity', 'context', 'depthScale', 'sliceDepth', 'c0', 'c1', 'c2', 'c3', 'c4', 'c5'];
function applyControls() {
  gl.uniform1i(U.uMode, +$('mode').value);
  gl.uniform1i(U.uField, +$('field').value);
  const lo = +$('winLo').value, hi = Math.max(+$('winHi').value, lo + 0.005);
  gl.uniform2f(U.uWin, lo, hi);
  gl.uniform1f(U.uOpacity, +$('opacity').value);
  gl.uniform1f(U.uContext, +$('context').value);
  gl.uniform1f(U.uD, +$('depthScale').value);
  const c = [0, 1, 2, 3, 4, 5].map((i) => +$('c' + i).value);
  gl.uniform3f(U.uClipMin, Math.min(c[0], c[1]), Math.min(c[2], c[3]), Math.min(c[4], c[5]));
  gl.uniform3f(U.uClipMax, Math.max(c[0], c[1]), Math.max(c[2], c[3]), Math.max(c[4], c[5]));
  gl.uniform1i(U.uFiber, $('fiber').checked ? 1 : 0);
  panel.showCurve = $('fiber').checked;
  gl.uniform1i(U.uRegions, $('regions').checked ? 1 : 0);
  gl.uniform1i(U.uFill, $('fill').checked ? 1 : 0);
  panel.showRects = $('regions').checked;
  panel.draw();
  const k = +$('sliceDepth').value;
  $('sliceLabel').textContent = `${meta.depth[k]} m`;
  gl.uniform1f(U.uSlice, $('slice').checked ? (k + 0.5) / nz : -1);
  interact();
}
const checks = ['fiber', 'regions', 'fill', 'slice'];
[...ids, ...checks].forEach((id) => $(id).addEventListener('input', applyControls));
$('slice').addEventListener('change', () => { if ($('slice').checked) cam.el = Math.max(cam.el, 1.2); });  // look down on the map
$('sliceDepth').max = nz - 1;
// drawing a curve or rectangle while it is hidden turns it back on
$('ts').addEventListener('pointerdown', () => {
  const box = $(panel.tool === 'curve' ? 'fiber' : 'regions');
  if (!box.checked) { box.checked = true; applyControls(); }
});

// ---------- save / load ----------
$('save').onclick = () => {
  const state = {
    controls: Object.fromEntries([...ids, ...checks].map((id) => [id, checks.includes(id) ? $(id).checked : $(id).value])),
    camera: cam, rects: panel.rects, curve: panel.curve,
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' }));
  a.download = 'ocean-config.json';
  a.click();
  URL.revokeObjectURL(a.href);
};
$('load').onclick = () => $('file').click();
$('reset').onclick = () => { Object.assign(cam, structuredClone(HOME)); interact(); };
$('file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const s = JSON.parse(await f.text());
    for (const [id, v] of Object.entries(s.controls)) checks.includes(id) ? ($(id).checked = v) : ($(id).value = v);
    Object.assign(cam, structuredClone(HOME), s.camera);
    applyControls();
    panel.setSelection(s.rects ?? [], s.curve ?? []);
  } catch (err) {
    alert('Could not load configuration: ' + err.message);
  }
  e.target.value = '';
};

// ---------- render loop ----------
let lastT = 0;
function render(now) {
  requestAnimationFrame(render);
  moveByKeys(Math.min((now - lastT) / 1000, 0.1));
  lastT = now;
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
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(...a); return a.map((v) => v / l); }

// canvases follow the page theme (light / dark)
function applyTheme() {
  const t = themeColors(), f = (c) => c.map((v) => v / 255);
  gl.uniform3fv(U.uBg, f(t.bg));
  gl.uniform3fv(U.uLand, f(t.border));
  gl.uniform3fv(U.uEdge, f(t.textLight));
  panel.refreshTheme();
  redraw();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
applyTheme();

// starting selection: warm salty box plus a thermocline-like curve
panel.setSelection([{ s0: 0.8, s1: 1, t0: 0.55, t1: 1, color: [214, 48, 49] }], [[0.8, 0.15], [0.84, 0.4], [0.88, 0.7]]);
applyControls();
status.textContent = 'Drag: rotate · right/Shift-drag: pan · scroll: zoom to cursor · WASD/arrows, R/F, Q/E: move · double-click: reset';
render(performance.now());
