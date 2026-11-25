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
| D10 | Data **hosted on Google Drive** (link shared with the team), **not in git**. `public/data/woa23/**/*.bin` is git-ignored; only `meta.json` is committed | Monthly+annual binaries are 341 MB (163 MB as .tar.gz); committing them would bloat the repo permanently. |
| D11 | Volume texture channels: **r = T, g = S, b = O₂, a = ocean mask** (was r=T, g=S, b=mask). Shader field index `uField` 0/1/2 indexes the channels | Oxygen fits the free 4th channel at no extra GPU memory. Any code reading the mask must use `.a` now. |
| D12 | Box height = `depthScale × nz / 102` | Annual and monthly share the same standard levels, so every level has the same height in both modes (monthly looks like the top 57/102 of the annual box). |
| D13 | Data location, first match wins: `?data=<base url>` → `VITE_DATA_URL` → `data/woa23/` → legacy `data/` (old annual T/S) | The app keeps working before the new data is downloaded; hosting can change without code changes. A Drive link cannot be used directly (see README). |
| D14 | Months load lazily, one step at a time, and stay cached in memory | 22 MB per month. Playback will need all 12 cached or streamed (not built yet). |
| D15 | Old saved configs (`ocean-config.json`) are **not compatible** with the new data | T/S/O normalisation ranges changed (T −3…31 → −3…36, S 5…41 → 4…44), so saved rectangles/curves shift. Re-draw them. |
| D16 | **All 12 months are preloaded onto the GPU** (one RGBA16F 3D texture per month, 12 × ~30 MB ≈ 354 MB GPU). CPU copies of multi-step datasets are dropped after upload; annual (single step, ~40 MB) stays cached | Month switching and playback need no uploads. Cost: ~0.4 GB GPU memory in monthly mode (could fail on very small GPUs; no fallback yet). Month slider and Play are disabled until all 12 are loaded. |
| D17 | Playback blends two adjacent months **in the shader** (`uVolB`, `uBlend`), not with a render-to-texture pass | Simpler and needs no `EXT_color_buffer_float`. Volume fetches double only while blending (one fetch otherwise). This replaces the plan in ROADMAP item F. |
| D18 | Playback options: 0.5 / 1 / 2 / 4 months per second, loop Dec→Jan, blend on/off, Space toggles. Rendering drops to half resolution while playing and returns to full on pause | Reuses the existing "interacting" low-res mode; adaptive quality is still roadmap item E. |
| D19 | Per-step histograms (all pairs) are computed in the browser at load; brightness is normalised by the maximum over all loaded steps | Brightness stays comparable between months. The max grows while months are still loading, so the final look settles after the last month. |
| D20 | **Diagram pairs**: T–S (x = S, y = T), T–O₂ (x = O₂, y = T), S–O₂ (x = O₂, y = S). Selections (rectangles, curve) belong to **one pair**; the 3D view shows the active pair's selections only | Clear semantics, no ambiguity about what a rectangle means. Combining selections from different pairs (intersection/union) is not built (future work). |
| D21 | Save format now has `pair`, `selections {ts,to,so}` and `data {dataset, step}`. Old configs with only `rects`/`curve` load as T–S | Backward-readable, although old values are shifted by the new ranges (D15). |

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

- **2026-11-25** NCEI allowed by user; real download + prep run succeeded (details in *Data run status*). User chose Google Drive for hosting (D10).
- **2026-11-25** User will run download + prep locally and upload to Google Drive; step-by-step instructions added to `README.md` (*Getting the data*). Drive links can't be fetched by the browser app (no CORS, large-file confirm page), so teammates unzip into `public/data/`; the app also accepts `?data=<url>`.
- **2026-11-25** Dataset selector built and tested in headless Chromium (SwiftShader) against the real `woa23` data: Annual → Monthly → Jul → 1D mode with dissolved oxygen all load and render; window readout shows real units; no JS errors (only software-renderer GPU warnings). Commits: loader (`src/data.js`), T-S panel `setData`, step-label fix, selector + shader/`main.js`/`index.html`.
- **2026-11-25** Bug found while testing: `meta.json` has `step_labels` (snake_case); loader now exposes it as `stepLabels`.
- **2026-11-25** Added: per-step histograms + per-pair selections in the diagram panel (refactor), preload of all 12 months, play/pause with blending, diagram selector (T–S, T–O₂, S–O₂). Each step tested in headless Chromium (SwiftShader) on the real data:
  preload state (Play/slider disabled while loading, enabled after), playback (Feb→May seen at 4 months/s, Space pauses, label stable), switching back to Annual hides the controls, T–O₂ rectangle (low-oxygen box) + curve render fiber surfaces, S–O₂ starts empty, T–S default selection returns, save → reload → load restores dataset, month and pair; no JS errors.
- **2026-11-25** Side effects: diagram axes now use nice tick values (0, 10, 20, … instead of rounded fractions); the stale "control polygon" hint was rewritten.
- **2026-11-25 Full verification pass** (production build `npm run build` + `vite preview`, headless Chromium with software WebGL, real `woa23` data):
  build OK; Python scripts compile; scenario scripts all passed with no JS errors: annual↔monthly switching, month slider, preload gating
  (Play/slider disabled until 12/12), playback + Space pause, blend off, save → reload → load (dataset, month, pair, selections), T–O₂ and S–O₂ diagrams,
  1D mode on oxygen/salinity with real-unit window label, slice mode (label 350 m at level 30 of monthly), clip slider.
  Fallbacks: if `data/woa23/meta.json` is missing the app uses the legacy files (single dataset "Annual (legacy)", oxygen field and oxygen diagrams disabled);
  an explicit `?data=bad/` shows "Could not load ocean data: …/meta.json: not JSON (file missing?)".
  Not covered: a real GPU (frame rate, 0.4 GB monthly memory), other browsers, phones, light/dark theme switch, the Drive/CORS hosting path.
  No automated test suite exists yet; these checks were ad-hoc Playwright scripts kept outside the repo.

## Data run status

- **2026-11-25: real run done.** `www.ncei.noaa.gov` was allowed; `tools/download.py` fetched all 39 files (1.5 GB) with the
  URL layout as written (it was correct), then `tools/prep.py data/raw public/data/woa23` ran in ~26 s.
- Output `public/data/woa23/`: 341 MB (annual 3 fields ≈ 40 MB + mask; monthly 12 × ~22 MB + masks), 163 MB as tar.gz.
  Generated locally in the cloud session; **the .bin files are not in git** (D10), so a teammate must get them from Drive
  or regenerate (download + prep, ~10 min).
- Verified in the real files: `*_an` shape (1, 102|57, 180, 360); oxygen units **µmol/kg**; titles say "1971-2000 1.00 degree";
  monthly depth axis = first 57 annual levels (prep asserts it).
- **Global ranges** (shared by annual and monthly): T −3…36 °C, S 4…44, O₂ 0…722 µmol/kg.
- **Ocean fraction** (voxels with T and S valid): annual 0.500 (6.6M voxels incl. the deep ocean), monthly 0.591 (only top 1500 m).
  **Oxygen coverage of ocean cells: 100 %** in every step — no oxygen holes, so a per-field validity mask is not needed in the renderer.
- Annual actual value spread (99.99th percentile): T up to ~29, S 7.5–40.4, O₂ up to ~420. Monthly maxima are higher (T 33 °C, O₂ 552 in July).
  The global ranges are wider than the annual data, so annual selections use a slightly smaller part of the axes. See open questions.
- Old files: `public/data/{t,s,mask}.bin` (legacy, unknown span) are still what the app reads. Nothing in the app uses `woa23` yet.
- Synthetic-data testing earlier (before the real run) was only used to check the script; none of that data was committed.

## Open questions / TODO

- Upload the `woa23` data to Google Drive and put the shared link in README + here (the cloud session cannot upload to Drive; use the tar.gz or run prep locally). The app will need a configurable data base URL (Drive links do not allow direct CORS fetches, so we may need a direct-download host, e.g. GitHub release assets, for the deployed app; Drive is fine for the team to fetch files into `public/data/woa23` by hand).
- Should the global ranges be clipped (e.g. to 99.99th percentile) to use the T-S/T-O axes better? Coastal extremes (T 36, S 44, O₂ 722) stretch them; the 256-bin histogram resolution is ~0.15 °C in T.
- Oxygen units µmol/kg confirmed; put them on the axis label.
- Frontend status: dataset selector, month slider, oxygen field, preload, play/pause with blending, diagram selector (T–S / T–O₂ / S–O₂) are DONE.
  Not done: selections combined across pairs, legend/colour bar (oxygen especially), real-time performance numbers on a real GPU
  (all tests so far ran on a software renderer), GPU-memory fallback for monthly mode (~0.4 GB), seasonal dataset (D3).
- Not yet checked on a real GPU: smoothness of playback at 320 march steps with blending (two fetches per sample). If it stutters, lower the
  playback resolution factor or add the adaptive step / empty-space skipping from ROADMAP item E.
