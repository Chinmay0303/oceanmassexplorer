// Data access: finds the dataset (WOA23 'woa23' layout from tools/prep.py, or the legacy annual T/S files)
// and loads one time step at a time.
//
// Data location, first match wins: ?data=<base url> in the page URL, VITE_DATA_URL at build time, data/woa23/.
// If the default location has no usable meta.json the old files in data/ are used instead.
// A step is { t, s, o, mask, nz }: t/s/o are Uint16Array (value = u / 65535 over meta.ranges[field]) or null for
// fields the dataset does not have; mask is Uint8Array, bit0 = ocean (T and S valid).

const UNITS = { t: '°C', s: 'PSU', o: 'µmol/kg' };
const NAMES = { t: 'Temperature', s: 'Salinity', o: 'Dissolved oxygen' };

const withSlash = (u) => (u.endsWith('/') ? u : u + '/');

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  try { return await r.json(); } catch { throw new Error(`${url}: not JSON (file missing?)`); }
}

// gzip: files written by `prep.py --gzip` are unpacked here. The two magic bytes are checked first because a server may
// already have decoded the file (Content-Encoding); then there is nothing to do.
async function getBytes(url, expected, gz = false) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  let buf = await r.arrayBuffer();
  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (gz && head[0] === 0x1f && head[1] === 0x8b) {
    buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  if (buf.byteLength !== expected) throw new Error(`${url}: ${buf.byteLength} bytes, expected ${expected}`);
  return buf;
}

function fromWoa23(m) {
  return {
    legacy: false, source: m.source, span: m.span_years,
    nx: m.nx, ny: m.ny, lat0: m.lat0, dlat: m.dlat, lon0: m.lon0, dlon: m.dlon ?? 1,
    fields: m.fields, names: m.fields.map((f) => NAMES[f]), units: m.fields.map((f) => UNITS[f]),
    ranges: m.ranges, compression: m.compression ?? null,
    datasets: Object.fromEntries(Object.entries(m.datasets).map(([k, d]) => [k, { ...d, stepLabels: d.step_labels }])),
  };
}

function fromLegacy(m) {
  return {
    legacy: true, source: 'Legacy annual 1-degree T/S (time span unknown)', span: '',
    nx: m.nx, ny: m.ny, lat0: m.lat0, dlat: m.dlat, lon0: m.lon0, dlon: 1,
    fields: ['t', 's'], names: [NAMES.t, NAMES.s], units: [UNITS.t, UNITS.s],
    ranges: { t: m.t_range, s: m.s_range },
    datasets: { annual: { label: 'Annual (legacy)', nz: m.nz, depth: m.depth, steps: ['legacy'], stepLabels: ['Annual'] } },
  };
}

export async function openData() {
  const explicit = new URLSearchParams(location.search).get('data') ?? import.meta.env.VITE_DATA_URL;
  let base, meta;
  if (explicit) {
    base = withSlash(explicit);
    meta = fromWoa23(await getJSON(base + 'meta.json'));
  } else {
    try {
      base = 'data/woa23/';
      meta = fromWoa23(await getJSON(base + 'meta.json'));
    } catch (e) {
      console.warn('woa23 data not found, using legacy files:', e.message);
      base = 'data/';
      meta = fromLegacy(await getJSON(base + 'meta.json'));
    }
  }

  const cache = new Map();
  async function loadStep(dataset, step) {
    const key = `${dataset}/${step}`;
    if (cache.has(key)) return cache.get(key);
    const ds = meta.datasets[dataset];
    const n = meta.nx * meta.ny * ds.nz;
    let out;
    if (meta.legacy) {
      const [t, s, mask] = await Promise.all([
        getBytes(base + 't.bin', n * 2), getBytes(base + 's.bin', n * 2), getBytes(base + 'mask.bin', n),
      ]);
      out = { t: new Uint16Array(t), s: new Uint16Array(s), o: null, mask: new Uint8Array(mask), nz: ds.nz };
    } else {
      const gz = meta.compression === 'gzip', ext = gz ? '.gz' : '';
      const [bin, mask] = await Promise.all([
        getBytes(`${base}${dataset}/${step}.bin${ext}`, n * 2 * meta.fields.length, gz),
        getBytes(`${base}${dataset}/${step}.mask.bin${ext}`, n, gz),
      ]);
      const all = new Uint16Array(bin);
      const f = (i) => (i < meta.fields.length ? all.subarray(i * n, (i + 1) * n) : null);
      out = { t: f(0), s: f(1), o: f(2), mask: new Uint8Array(mask), nz: ds.nz };
    }
    if (ds.steps.length === 1) cache.set(key, out);  // multi-step datasets are big and live on the GPU instead
    return out;
  }
  return { meta, base, loadStep };
}
