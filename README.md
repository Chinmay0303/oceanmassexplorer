# Ocean Water Mass Explorer

WebGL2 volume renderer for World Ocean Atlas 2023 temperature and salinity, with a T-S diagram
whose selections (rectangles and a curve) extract fiber surfaces in the 3D volume.

## Run

    npm install
    npm run dev        # development server
    npm run build      # static site in dist/, can be hosted anywhere

## Regenerating the data

`public/data` (annual temperature and salinity, time span not recorded) is what the app reads today.
The new multi-field, annual + monthly pipeline (temperature, salinity, oxygen, 1971-2000) writes to
`public/data/woa23` and is not wired into the app yet. See `log.md` for the decisions.

The generated `.bin` files are not in git (341 MB). Get them from the team's Google Drive folder (link in `log.md`)
and unpack into `public/data/woa23/`, or regenerate:

    pip install numpy scipy netCDF4
    python tools/download.py data/raw        # 39 NetCDF files from NCEI, > 1 GB
    python tools/prep.py data/raw public/data/woa23
