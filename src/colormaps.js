import { STOPS } from './colormap-stops.js';

// Per-field default (index = field: 0 temperature, 1 salinity, 2 oxygen). "auto" in the UI means these.
export const FIELD_DEFAULT = ['thermal', 'haline', 'oxy'];
export const CHOICES = [['auto', 'Oceanographic (per field)'], ['viridis', 'Viridis'], ['cividis', 'Cividis (colour-blind safe)']];

export const mapName = (field, choice) => (choice === 'auto' ? FIELD_DEFAULT[field] : choice);

const parse = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// colour at u in [0, 1] as [r, g, b] (0-255)
export function colorAt(name, u) {
  const st = STOPS[name], f = Math.min(Math.max(u, 0), 1) * (st.length - 1), k = Math.min(Math.floor(f), st.length - 2), w = f - k;
  const a = parse(st[k]), b = parse(st[k + 1]);
  return a.map((v, i) => v * (1 - w) + b[i] * w);
}

// 256 x 1 RGBA8 table for a texture
export function colormapTable(name) {
  const t = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) t.set([...colorAt(name, i / 255).map(Math.round), 255], i * 4);
  return t;
}
