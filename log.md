# Project log — Ocean Water Mass Explorer

Running log of decisions, findings and small things, newest at the bottom. Written so a teammate (or future us)
can understand *why* things are the way they are. Section IDs like `3.5` / `6.10` refer to `CODE_MAP.txt`.
Date of the first entries: 2026-11-25.

## Quick facts

- Course project (graphics & visualization), 2 people. Proposal: interactive WebGL tool, T-S diagram selection →
  3D volume (multidimensional transfer function) + fiber surfaces from a drawn T-S curve.
- Stack: vanilla JS + WebGL2 + Canvas2D, Vite. One full-screen triangle, single ray-marching fragment shader.
- Branch for this work: `claude/amazing-tesla-1jshar`. Repo had one commit ("first commit") at the start.
- Files written so far besides code: `CODE_MAP.txt` (what lives where), `ROADMAP.txt` (feasibility + priorities), this log.

## Decisions

| ID | Decision | Why |
|----|----------|-----|
| D1 | Fields: **Temperature, Salinity, Dissolved oxygen** only; grid **1°**; NetCDF; field `an` (objectively analysed) | Team choice. 1° keeps the volume at 360×180; `an` is gap-filled, `mn` (statistical mean) is not. Oxygen only exists at 1° anyway (0.25° is T/S only). |
| D2 | Time span for **everything**: **`decav71A0` = 1971–2000 climate normal** | Oxygen exists only for 1971–2000 and "all" (1965–2022); T/S have no "all". 1971–2000 is the only span common to all three, so no diagram mixes spans. |
| D3 | Two time options now: **Annual** and **Monthly**. Seasonal **not** now | Monthly dominates seasonal for animation (12 vs 4 frames). Seasonal oxygen is only 0–1500 m, so with oxygen seasonal gains nothing in depth. Data pipeline is generic, so seasonal is one more entry in `DATASETS` (tools/prep.py) if wanted later. If added, label seasons Jan–Mar etc. (the doc defines them as northern-hemisphere seasons). |
| D4 | Annual = 102 levels (0–5500 m). Monthly = 57 levels (0–1500 m) | WOA23 doc Table 4: monthly T, S, O are limited to 1500 m. The 57 monthly levels are exactly the first 57 annual levels (prep.py asserts this). |
| D5 | One **global value range per field** (t, s, o) over all files | Saved rectangles/curves are in normalised coordinates, so they must mean the same thing in annual and monthly, and T-S axes must not jump between months. |
| D6 | Land / below-seafloor / missing cells are **filled with nearest valid value, per field**, and a separate **mask** says what is real | GPU linear filtering must not blend in junk. Mask bit0 = ocean (T and S valid), bit1 = oxygen valid. Oxygen can have holes where T/S exist; the app can decide later what to do with bit1. |
| D7 | Storage: **uint16**, planar `[field][depth][lat][lon]`, one file per time step | Same idea as the old format (13.2 MB per annual field). Monthly ≈ 22 MB per step, ≈ 266 MB for 12 months before compression. |
| D8 | New data goes to `public/data/woa23/` (own `meta.json`); old `public/data/*` untouched | The app still reads the old files; overwriting would break it until the frontend is migrated. |
| D9 | "Monthly" is a **climatology** (mean of each month over 1971–2000), not a time series | Animation shows a typical seasonal cycle. Say "monthly climatology" in the UI. |

## Findings about the existing code (first review)

- Old data = annual, 1°, `t_an`/`s_an`, 102 levels, 0–5500 m. **Time span was never recorded**; nobody on the team remembers it.
  The old `public/data` is therefore treated as legacy and will be replaced by the `woa23` set.
- All proposal features P1–P8 + novelty N1 are implemented except P2 (1D TF is only a window + fixed colour map).
- Known quality issues (details in ROADMAP.txt): fiber surface detection can miss thin sheets (fixed 320 steps,
  one sign-change test), SDF sign flips at sharp curve kinks, rectangles have flat colour only.
- Stale text: README/style.css mention `docs/styles.md` which does not exist; index.html hint still says "control polygon".

## Dataset facts (from WOA23 Product Documentation + NCEI screenshots)

- File name: `woa23_[span]_[v][tp]_[gr].nc`; v = t/s/o; tp 00 annual, 01–12 months, 13–16 seasons; gr 01 = 1°.
- Variables inside: `t_an`, `s_an`, `o_an` (shape time=1, depth, lat=180, lon=360); fill value 9.96921e36; lat −89.5…89.5, lon −179.5…179.5.
- Depth levels (Table 4): annual T/S/O 102; seasonal T/S 102 but O 57; monthly T/S/O 57.
- Each NetCDF holds *all* statistic fields (an, mn, dd, sd, …), so files are big; we only read `*_an`.
- Download page default in the screenshots was **CSV** — use **NetCDF**.

## Ideas / priorities agreed so far

See `ROADMAP.txt`. Order: fiber quality fix → editable 1D TF + colour maps + legend → delete/edit single selections →
real multidimensional TF → multiple curves → 3D picking → T/S/O bivariate panel → performance (brick skipping, adaptive steps) →
time animation (annual/monthly, play/pause) → hygiene (data hosting, tests, docs).
Animation design notes: blend two months once per frame into a third 3D texture (needs `EXT_color_buffer_float`);
compute each month's histogram in the browser at load (~30 ms); scale box height by nz/102 so annual and monthly look the same.

## Timeline

- **2026-11-25** Read proposal; reviewed all code; wrote `CODE_MAP.txt`. First push failed (403, GitHub App not installed); worked after the user fixed access.
- **2026-11-25** User added suggestions (colour map/legend, delete single selection, multiple curves, more fields, multi-year/seasonal, adaptive step). Wrote `ROADMAP.txt`; extended CODE_MAP with interaction levels (Part 10) and coverage audit (Part 11).
- **2026-11-25** NCEI hosts (`www.ncei.noaa.gov`, `data.nodc.noaa.gov`) were unreachable from the cloud session (proxy 403 / DNS), so dataset facts were taken from the user's PDF + screenshots instead.
- **2026-11-25** Decisions D1–D9 made. Wrote `tools/download.py` and rewrote `tools/prep.py` (annual + monthly, t/s/o). Updated `.gitignore` (`data/raw`), README, CODE_MAP Part 1.

## Data run status (read this before trusting `public/data/woa23`)

- `tools/prep.py` was **tested on synthetic NetCDF files** shaped like WOA23 (39 files, correct dims/depths, holes in oxygen):
  correct output sizes, masks, ranges, meta.json, and a clear error when inputs are missing. Synthetic data was **not** committed.
- It has **not been run on the real WOA23 files**: the session's network policy blocks `www.ncei.noaa.gov` (HTTP 403 from the agent proxy).
  Consequently `public/data/woa23/` does **not exist yet**.
- To finish: allow `www.ncei.noaa.gov` in the cloud environment's network settings (or run on a laptop), then
  `python tools/download.py data/raw && python tools/prep.py data/raw public/data/woa23`.
- Unverified: the download URL layout in `tools/download.py` (`…/WOA23/DATA/<variable>/netcdf/decav71A0/1.00/…`). If NCEI answers 404, fix `BASE`/`url()`.
  If the server splits files differently, only `download.py` needs changing; `prep.py` just needs the 39 files in one folder.

## Open questions / TODO

- Where to host the data? Monthly is ≈ 266 MB (uint16) — too heavy for git. Options: 8-bit + gzip, GitHub release assets, Git LFS, or generate on build. Decide before committing `woa23`.
- How much oxygen is missing inside the ocean? `prep.py` prints `oxygen coverage of ocean` per step (stored in `meta.json` → `stats`); look at it after the first real run.
- Check oxygen units in the real file (`o_an:units`, expected µmol/kg) and put them on the axis label.
- Frontend migration to the new data layout (dataset selector, time slider, play/pause) — not started.
