import { themeColors } from './theme.js';
import { colorAt } from './colormaps.js';
import { niceTicks } from './ts.js';

const rgb = (c) => `rgb(${c.map(Math.round)})`;

// Colour bar with real-unit ticks for the 1D transfer function:
// args = { map, lo, hi, label, unit }  (map = colour map name, lo/hi = window in real units)
// Redraws itself when the canvas is resized.
export function drawColorbar(canvas, args) {
  canvas._legend = args;
  if (!canvas._observer) {
    canvas._observer = new ResizeObserver(() => paint(canvas));
    canvas._observer.observe(canvas);
  }
  paint(canvas);
}

function paint(cv) {
  const a = cv._legend, r = cv.getBoundingClientRect();
  if (!a || r.width < 2) return;
  const dpr = devicePixelRatio || 1, w = r.width, h = r.height;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { textLight, border } = themeColors(), x0 = 6, x1 = w - 6, bar = 14;
  const g = ctx.createLinearGradient(x0, 0, x1, 0);
  for (let i = 0; i <= 16; i++) g.addColorStop(i / 16, rgb(colorAt(a.map, i / 16)));
  ctx.fillStyle = g; ctx.fillRect(x0, 2, x1 - x0, bar);
  ctx.strokeStyle = rgb(border); ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, 2.5, x1 - x0 - 1, bar - 1);
  ctx.fillStyle = rgb(textLight); ctx.strokeStyle = rgb(textLight);
  ctx.font = `11px ${getComputedStyle(cv).fontFamily}`;
  ctx.textAlign = 'center';
  for (const v of niceTicks(a.lo, a.hi, 4)) {
    const x = x0 + ((v - a.lo) / (a.hi - a.lo)) * (x1 - x0);
    ctx.beginPath(); ctx.moveTo(x, 2 + bar); ctx.lineTo(x, 2 + bar + 3); ctx.stroke();
    ctx.fillText(v, Math.min(Math.max(x, x0 + 8), x1 - 8), bar + 17);
  }
  ctx.fillText(`${a.label} (${a.unit})`, w / 2, bar + 31);
}
