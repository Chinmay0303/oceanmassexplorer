# Ocean Water Mass Explorer

WebGL2 volume renderer for World Ocean Atlas 2023 temperature and salinity, with a T-S diagram
whose selections (rectangles and a curve) extract fiber surfaces in the 3D volume.

## Run

    npm install
    npm run dev        # development server
    npm run build      # static site in dist/, can be hosted anywhere

## Regenerating the data

`public/data` is already included. To rebuild it from the WOA23 annual 1-degree NetCDF files:

    python tools/prep.py t_an.nc s_an.nc public/data

Requires numpy, scipy and netCDF4.
