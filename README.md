# Ocean Water Mass Explorer

WebGL2 volume renderer for World Ocean Atlas 2023 temperature and salinity, with a T-S diagram
whose selections (rectangles and a curve) extract fiber surfaces in the 3D volume.

## Run

    npm install
    npm run dev        # development server
    npm run build      # static site in dist/, can be hosted anywhere

## Getting the data (WOA23: temperature, salinity, oxygen; annual + monthly)

The app reads `public/data/woa23/`. The `.bin` files (341 MB) are not in git; `meta.json` is.

**One person (once): build the data**

1. Install Python 3.10+ and clone the repo.
2. `pip install numpy scipy netCDF4`
3. `python tools/download.py data/raw`   (39 files, about 1.5 GB, safe to re-run; skips finished files)
4. `python tools/prep.py data/raw public/data/woa23`   (about 30 s)
5. Check `public/data/woa23` has this exact content:
   - `meta.json`
   - `annual/00.bin` (39,657,600 bytes) and `annual/00.mask.bin` (6,609,600 bytes)
   - `monthly/01.bin` ... `12.bin` (22,161,600 bytes each) and `01.mask.bin` ... `12.mask.bin` (3,693,600 bytes each)
6. Zip the `woa23` folder (so the zip contains the folder `woa23/` at its top), upload to Google Drive,
   set sharing to "Anyone with the link: Viewer", and paste the link into `log.md`.

**Everyone else: use the data**

1. Download the zip from the Drive link, unzip it into `public/data/` so that `public/data/woa23/meta.json` exists.
2. `npm install` then `npm run dev`. The app picks up `woa23` automatically; if it is missing it falls back to the old annual files in `public/data/`.

A Drive link cannot be used directly as a web data source (no CORS headers, and a confirmation page for large files),
so the data must be unzipped next to the app or hosted on a CORS-enabled host and passed as `?data=<base url>/`.
