"""WOA23 annual 1deg T/S (NetCDF) -> raw binaries for the browser.

Usage: python tools/prep.py data/raw/t.nc data/raw/s.nc public/data

Writes t.bin, s.bin (uint16, normalised to the ranges in meta.json), mask.bin
(uint8, 1 = ocean) and meta.json. Layout is [depth][lat][lon], lon fastest.
Land / below-seafloor cells are filled with the nearest ocean value so that
linear filtering on the GPU does not bleed junk into coastlines.
"""
import json
import sys

import numpy as np
from netCDF4 import Dataset
from scipy.ndimage import distance_transform_edt


def load(path, var):
    with Dataset(path) as ds:
        a = ds.variables[var][0]  # (depth, lat, lon)
        return np.ma.filled(a.astype("float32"), np.nan), ds


def fill_nearest(a, ocean):
    idx = distance_transform_edt(~ocean, return_distances=False, return_indices=True)
    return a[tuple(idx)]


def quantise(a, lo, hi):
    return np.clip((a - lo) / (hi - lo) * 65535 + 0.5, 0, 65535).astype("<u2")


def main(t_path, s_path, out):
    t, ds = load(t_path, "t_an")
    s, _ = load(s_path, "s_an")
    with Dataset(t_path) as d:
        depth = d.variables["depth"][:].astype(float).tolist()
        lat = d.variables["lat"][:].astype(float).tolist()
        lon = d.variables["lon"][:].astype(float).tolist()

    ocean = ~np.isnan(t) & ~np.isnan(s)
    assert ocean.any() and t.shape == s.shape == (len(depth), len(lat), len(lon))

    t_lo, t_hi = float(np.floor(t[ocean].min())), float(np.ceil(t[ocean].max()))
    s_lo, s_hi = float(np.floor(s[ocean].min())), float(np.ceil(s[ocean].max()))

    quantise(fill_nearest(t, ocean), t_lo, t_hi).tofile(f"{out}/t.bin")
    quantise(fill_nearest(s, ocean), s_lo, s_hi).tofile(f"{out}/s.bin")
    ocean.astype("u1").tofile(f"{out}/mask.bin")

    meta = dict(
        nx=len(lon), ny=len(lat), nz=len(depth),
        depth=depth, lat0=lat[0], dlat=lat[1] - lat[0], lon0=lon[0],
        t_range=[t_lo, t_hi], s_range=[s_lo, s_hi],
    )
    json.dump(meta, open(f"{out}/meta.json", "w"))
    print(meta["nx"], meta["ny"], meta["nz"], "T", meta["t_range"], "S", meta["s_range"],
          "ocean fraction %.3f" % ocean.mean())


if __name__ == "__main__":
    main(*sys.argv[1:4])
