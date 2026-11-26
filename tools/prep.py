"""WOA23 1-degree NetCDF (t, s, o; annual + monthly) -> raw binaries for the browser.

Usage: python tools/prep.py [raw_dir] [out_dir] [--gzip]     (defaults: data/raw  public/data/woa23)
--gzip writes every .bin / .mask.bin as .gz (about half the size, used for the GitHub Pages build; the app unpacks them in the browser).
Get the inputs first with: python tools/download.py data/raw

Input : woa23_decav71A0_{t,s,o}{tp}_01.nc, tp = 00 (annual) and 01..12 (months); variables t_an, s_an, o_an.
Output (out_dir):
  meta.json                 grid, depth axes, global value ranges, dataset/step list (read this first)
  annual/00.bin             uint16, planar [field][depth][lat][lon], lon fastest, field order = meta.fields
  annual/00.mask.bin        uint8 per voxel [depth][lat][lon]: bit0 = ocean (t and s valid), bit1 = oxygen valid
  monthly/01.bin .. 12.bin  same, 57 levels (0-1500 m), plus 01.mask.bin .. 12.mask.bin

Design (see log.md):
 * one GLOBAL range per field over all files, so annual and monthly share one normalisation and
   saved selections (normalised T-S coordinates) stay valid across datasets;
 * land / below-seafloor / missing cells are filled with the nearest valid value (per field) so GPU
   linear filtering does not bleed junk; the mask tells the renderer which cells are real;
 * monthly levels must equal the first 57 annual levels (checked), so one depth axis serves both.
"""
import gzip
import json
import sys
from pathlib import Path

import numpy as np
from netCDF4 import Dataset
from scipy.ndimage import distance_transform_edt

SPAN = "decav71A0"
FIELDS = ["t", "s", "o"]  # file prefix letters; variable inside the file is "<f>_an"
DATASETS = {
    "annual": dict(label="Annual", nz=102, steps=["00"], step_labels=["Annual"]),
    "monthly": dict(
        label="Monthly", nz=57, steps=[f"{m:02d}" for m in range(1, 13)],
        step_labels=["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    ),
}


def path(raw, f, tp):
    return Path(raw) / f"woa23_{SPAN}_{f}{tp}_01.nc"


def read(raw, f, tp):
    """-> (array[depth, lat, lon] float32 with NaN for missing, depth, lat, lon)"""
    with Dataset(path(raw, f, tp)) as ds:
        a = np.ma.filled(ds.variables[f"{f}_an"][0].astype("float32"), np.nan)
        return a, ds.variables["depth"][:].astype(float), ds.variables["lat"][:].astype(float), ds.variables["lon"][:].astype(float)


def fill_nearest(a, valid):
    idx = distance_transform_edt(~valid, return_distances=False, return_indices=True)
    return a[tuple(idx)]


def quantise(a, lo, hi):
    return np.clip((a - lo) / (hi - lo) * 65535 + 0.5, 0, 65535).astype("<u2")


def write(path, data, gz):
    """data: bytes; with gz the file gets a .gz suffix"""
    if gz:
        with gzip.GzipFile(f"{path}.gz", "wb", compresslevel=9, mtime=0) as f:
            f.write(data)
    else:
        Path(path).write_bytes(data)


def main(raw="data/raw", out="public/data/woa23", gz=False):
    out = Path(out)
    missing = [str(path(raw, f, tp)) for d in DATASETS.values() for tp in d["steps"] for f in FIELDS if not path(raw, f, tp).exists()]
    if missing:
        sys.exit(f"{len(missing)} input files missing, e.g. {missing[0]}\nrun: python tools/download.py {raw}")

    # pass 1: grid/depth checks and global ranges
    lo = {f: np.inf for f in FIELDS}
    hi = {f: -np.inf for f in FIELDS}
    depth_annual = grid = None
    for name, d in DATASETS.items():
        for tp in d["steps"]:
            for f in FIELDS:
                a, depth, lat, lon = read(raw, f, tp)
                assert a.shape == (d["nz"], 180, 360), f"{path(raw, f, tp).name}: unexpected shape {a.shape}"
                assert np.all(np.diff(lat) > 0) and np.all(np.diff(lon) > 0), "lat/lon must ascend"
                if name == "annual":
                    depth_annual = depth_annual if depth_annual is not None else depth
                    assert np.array_equal(depth, depth_annual)
                else:
                    assert np.array_equal(depth, depth_annual[: d["nz"]]), "monthly levels differ from annual levels"
                grid = grid or (lat, lon)
                v = a[~np.isnan(a)]
                assert v.size, f"{path(raw, f, tp).name} has no valid values"
                lo[f], hi[f] = min(lo[f], float(v.min())), max(hi[f], float(v.max()))
    rng = {f: [float(np.floor(lo[f])), float(np.ceil(hi[f]))] for f in FIELDS}
    lat, lon = grid
    print("global ranges", rng)

    # pass 2: write binaries
    meta_ds = {}
    for name, d in DATASETS.items():
        (out / name).mkdir(parents=True, exist_ok=True)
        stats = []
        for tp in d["steps"]:
            arrs = {f: read(raw, f, tp)[0] for f in FIELDS}
            ocean = ~np.isnan(arrs["t"]) & ~np.isnan(arrs["s"])
            o_ok = ~np.isnan(arrs["o"]) & ocean
            planes = []
            for f in FIELDS:
                valid = o_ok if f == "o" else ocean
                planes.append(quantise(fill_nearest(arrs[f], valid), *rng[f]))
            write(out / name / f"{tp}.bin", np.concatenate([p.ravel() for p in planes]).tobytes(), gz)
            write(out / name / f"{tp}.mask.bin", (ocean.astype("u1") | (o_ok.astype("u1") << 1)).tobytes(), gz)
            stats.append(dict(step=tp, ocean=round(float(ocean.mean()), 4), o2_of_ocean=round(float(o_ok.sum() / ocean.sum()), 4)))
            print(name, tp, "ocean %.3f  oxygen coverage of ocean %.3f" % (stats[-1]["ocean"], stats[-1]["o2_of_ocean"]))
        meta_ds[name] = dict(
            label=d["label"], nz=d["nz"], depth=depth_annual[: d["nz"]].tolist(),
            steps=d["steps"], step_labels=d["step_labels"], stats=stats,
        )

    meta = dict(
        source="World Ocean Atlas 2023, objectively analysed climatology (t_an, s_an, o_an), 1-degree grid",
        span=SPAN, span_years="1971-2000", nx=len(lon), ny=len(lat),
        lat0=float(lat[0]), dlat=float(lat[1] - lat[0]), lon0=float(lon[0]), dlon=float(lon[1] - lon[0]),
        fields=FIELDS, field_names=["Temperature", "Salinity", "Dissolved oxygen"], ranges=rng,
        layout="uint16 planar [field][depth][lat][lon], lon fastest; mask uint8 [depth][lat][lon] bit0 ocean bit1 oxygen valid",
        datasets=meta_ds, compression="gzip" if gz else None,
    )
    (out / "meta.json").write_text(json.dumps(meta))
    print("wrote", out)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    main(*args[:2], gz="--gzip" in sys.argv)
