"""Download the WOA23 NetCDF files needed by tools/prep.py (1 degree, one climatological span).

Usage: python tools/download.py [raw_dir]          (default raw_dir = data/raw, git-ignored)

Files fetched (3 variables x 13 periods = 39 files, each holds ALL statistic fields, so expect > 1 GB):
  woa23_decav71A0_{t,s,o}00_01.nc          annual
  woa23_decav71A0_{t,s,o}01_01.nc .. 12    monthly
Span decav71A0 = 1971-2000 climate normal: the only span for which temperature, salinity AND oxygen exist
(see log.md, decision D2).

The URL layout below follows the WOA directory convention (variable/netcdf/span/grid) and is NOT yet verified
against the live server; change BASE / URL if NCEI answers 404. Existing files are skipped, so it can be re-run.
"""
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE = "https://www.ncei.noaa.gov/data/oceans/woa/WOA23/DATA"
SPAN = "decav71A0"
VARS = {"t": "temperature", "s": "salinity", "o": "oxygen"}
PERIODS = [f"{m:02d}" for m in range(0, 13)]  # 00 = annual, 01..12 = months


def name(v, tp):
    return f"woa23_{SPAN}_{v}{tp}_01.nc"


def url(v, tp):
    return f"{BASE}/{VARS[v]}/netcdf/{SPAN}/1.00/{name(v, tp)}"


def main(raw="data/raw"):
    raw = Path(raw)
    raw.mkdir(parents=True, exist_ok=True)
    for v in VARS:
        for tp in PERIODS:
            dst = raw / name(v, tp)
            if dst.exists() and dst.stat().st_size > 0:
                print("have", dst.name)
                continue
            print("get ", url(v, tp))
            try:
                tmp = dst.with_suffix(".part")
                urllib.request.urlretrieve(url(v, tp), tmp)
                tmp.rename(dst)
            except urllib.error.URLError as e:
                sys.exit(f"download failed for {url(v, tp)}: {e}")


if __name__ == "__main__":
    main(*sys.argv[1:2])
