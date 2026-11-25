# Ocean Water Mass Explorer

WebGL2 volume renderer for World Ocean Atlas 2023 temperature, salinity and dissolved oxygen (annual and monthly),
with a water-mass diagram (T-S, T-O2, S-O2) whose selections (rectangles and curves) extract fiber surfaces in the 3D volume.

## Setup

Needs Git and Node.js 20.19 or newer.

1. Clone the repo and switch to the working branch:

       git clone git@github.com:Navinas3460/oceanmassexplorer.git
       cd oceanmassexplorer

2. Install the dependencies:

       npm install

3. Download the data (341 MB unpacked) from Google Drive and save `woa23.zip` in your downloads directory:
   https://drive.google.com/file/d/1OTczr9tlrDxFRFFEb6hOi05PDWdETCT9/view?usp=drivesdk
   (for a large file Drive shows a virus-scan page: click "Download anyway")

4. Unzip it into `public/data/` (replace `<downloads-directory>` with the folder the zip was saved to):

       cd public/data
       unzip <downloads-directory>/woa23.zip
       cd ../..

5. Check that this file exists (the folder must not be nested twice):

       ls public/data/woa23/meta.json

6. Start the app and open the address it prints (usually http://localhost:5173):

       npm run dev

If the data is missing, the app falls back to the old annual temperature/salinity files and shows "Annual (legacy)".

## Using the app

- **Data**: choose Annual (0-5500 m) or Monthly (0-1500 m). Monthly loads all 12 months first (about 0.4 GB of GPU memory),
  then the month slider, Play/Pause (also Space), speed, month blending and looping become available.
- **Water-mass diagram**: choose Temperature-Salinity, Temperature-Oxygen or Salinity-Oxygen, then drag to draw a rectangle
  (region) or a curve (fiber surface). Every diagram keeps its own selections; the 3D view shows the chosen diagram's.
- **Volume**: 1D transfer function mode can colour by temperature, salinity or oxygen.
- Camera: drag to rotate, right/Shift-drag to pan, scroll to zoom, double-click to reset.

## More

`log.md` has the decisions and history (including how the data was built with `tools/download.py` and `tools/prep.py`),
`CODE_MAP.txt` shows where everything is in the code, `ROADMAP.txt` the planned improvements.
