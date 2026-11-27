Calculate water levels to support NGS flight planning.

# Installation
This package has been developed using `python` 3.12, and tested with `python` 3.12 and 3.11. If you don't have one of these, you can use `conda` or `mamba` to set up a `python` 3.12 environment with the following steps:
```
# Install miniconda if needed:
wget "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-$(uname)-$(uname -m).sh"
bash "Miniforge3-$(uname)-$(uname -m).sh" -b -p "${HOME}/conda"
source "${HOME}/conda/etc/profile.d/conda.sh"
source "${HOME}/conda/etc/profile.d/mamba.sh"

# Set up a python 3.12 env:
mamba create --name=py312 python=3.12
mamba activate py312
# Replace the "2"s with "1"s if you want python 3.11!
```

Get the package code by cloning from github:
```
git clone git@github.com:noaa-ocs-modeling/ngs-flight-planning.git
```

Then, to set up the minimal environment to run the main scripts in the package, follow the "Standard" instructions below. To use the accompanying Jupyter notebook(s), or to use the exact environment used in development, follow the "Development & Jupyter notebooks" instructions.

## Standard
```
cd ngs-flight-planning
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Development & Jupyter notebooks
```
cd ngs-flight-planning
python -m venv .venv
source .venv/bin/activate
pip install -r dev_requirements.txt
```

## Note on `xarray-subset-grid` (Python 3.11/3.12)
`xarray-subset-grid` is installed from GitHub. Commits from July 2026 onward use a type hint that only works on Python 3.14 or newer. On Python 3.11 and 3.12, the package fails as soon as it is imported:
```
TypeError: unsupported operand type(s) for |: 'types.GenericAlias' and 'str'
```
Both requirements files therefore pin the last commit before that change:
```
xarray_subset_grid @ git+https://github.com/asascience-open/xarray-subset-grid.git@f96a90bd0becdfa6e4785ce79f835a97abb4d06e
```
If you already installed an unpinned version, replace it with:
```
pip install --force-reinstall --no-deps "xarray_subset_grid @ git+https://github.com/asascience-open/xarray-subset-grid.git@f96a90bd0becdfa6e4785ce79f835a97abb4d06e"
```
Installing packages from GitHub requires `git`. On macOS, if `git` stops with an Xcode license message, either run `sudo xcodebuild -license`, or install `git` into your conda environment with `conda install -c conda-forge git`.

# Usage
Eventually, the aim is to use the package for long-term (months ahead) flight planning, near-term (days ahead) flight planning, and post flight QC (preliminary and final). Presently, the near-term flight planning and both QC modes have been implemeted. These are run using python command line scripts. The process should output the same types of files as the existing TCARI method. 

The easiest way to run flight planning and look at the results is the visualization app: run `python app.py` (see "Visualization app" below). The command line scripts below do the same calculations and write the same files.

## Flight planning
Run the script `predict.py`, with three required command line arguments:
```
python predict.py <project_name> <path_to_flight_lines>.wpt <STOFS_forecast_initialization>
```
replacing the parts in angle brackets `<...>` with actual values. More detailed descriptions of these arguments, as well as a number of additional, optional command line arguments, can be accessed by running
```
python predict.py -h
```
An example command might look like:
```
python predict.py AL2401 data/AL2401.wpt 2025-01-01T12:00 -o data/testing -l DEBUG
```
If this executes successfully, the following output files should be saved in `./data/testing/AL2401/`:
```
AL2401_mllw_mhw_20250101T12.dates.txt      AL2401_mllw_mhw_20250101T12.lines.shp  AL2401_mllw_mhw_20250101T12.pts.geojson
AL2401_mllw_mhw_20250101T12.gpkg           AL2401_mllw_mhw_20250101T12.lines.shx  AL2401_mllw_mhw_20250101T12.pts.shp
AL2401_mllw_mhw_20250101T12.lines.cpg      AL2401_mllw_mhw_20250101T12.lines.txt  AL2401_mllw_mhw_20250101T12.pts.shx
AL2401_mllw_mhw_20250101T12.lines.dbf      AL2401_mllw_mhw_20250101T12.pts.cpg
AL2401_mllw_mhw_20250101T12.lines.geojson  AL2401_mllw_mhw_20250101T12.pts.dbf
AL2401_mllw_mhw_20250101T12.gui.json      AL2401_mllw_mhw_20250101T12.mesh.bin
```
The `.gui.json` and `.mesh.bin` files are for the visualization app: the first holds the lines, photo points, windows, sun and camera data, and the second (about 24 MB for AL2401) the forecast water levels on the model mesh (see "Visualization app" below).

## QC
Run the script `qc.py`, with two required command line arguments:
```
python qc.py <project_name> <path_to_images_file>.csv
```
replacing the parts in angle brackets `<...>` with actual values. More detailed descriptions of these arguments, as well as a number of additional, optional command line arguments, can be accessed by running
```
python qc.py -h
```
The most commonly used optional command line arguments might be `-q`, with value `field` or `final`, to select which stage of QC is being run, and `-d` to list datums to analyze. These default to `field` and ['mllw', 'mhw'], respectively.

An example command might look like:
```
python qc.py \
    AL2401_qc \
    data/ImageEvents_C147643_1217241559565_003_RGB1.csv \
    -o data/testing \
    -l DEBUG
```
If this executes successfully, the following output files should be saved in `./data/testing/AL2401_qc/`:
```
AL2401_qc_mllw_mhw_20241217T12_qc.html
AL2401_qc_mllw_mhw_20241217T12_qc.geojson
AL2401_qc_mllw_mhw_20241217T12_qc.csv
AL2401_qc_mllw_mhw_20241217T12_qc.gpkg
AL2401_qc_mllw_mhw_20241217T12_qc.shp
AL2401_qc_mllw_mhw_20241217T12_qc.cpg
AL2401_qc_mllw_mhw_20241217T12_qc.shx
AL2401_qc_mllw_mhw_20241217T12_qc.dbf
```

## Mesh cache
When the STOFS forecast file stores water levels uncompressed, the scripts read only the parts they need (see the Changelog). In that mode, the mesh node coordinates (about 205 MB) and the local mean sea level field (about 50 MB) are the same for every forecast on a given STOFS mesh, so they are cached on disk after the first run.

- **Location:** `~/.cache/ngs-flight-planning/meshes/` by default. Set the `NGS_MESH_CACHE_DIR` environment variable, or pass `--mesh-cache-dir <dir>` to `predict.py` or `qc.py`, to use another directory. Pass `--no-mesh-cache` to neither read nor write the cache.
- **One entry per mesh.** Each run fingerprints the forecast file's mesh before using the cache: the mesh dimension sizes, the coordinates of 32,768 nodes (64 evenly spaced blocks of 512 consecutive nodes), and the open-boundary arrays. This downloads about 0.5 MB and takes a few seconds. A different mesh, for example after a STOFS upgrade, gets its own `mesh_<fingerprint>` folder, so meshes are never mixed up.
- **Extra checks.**
  - The coordinates of every node the run actually uses are compared with the forecast file. If any differ, the entry is downloaded again and replaced.
  - The cached LMSL is used only if the LMSL file on S3 is unchanged (same ETag).
- **Mesh triangles.** The visualization app's mesh view also needs the mesh's triangle list (about 300 MB for the global mesh). It is downloaded once per mesh into the same cache entry (`element.npy`) and spot-checked against the forecast file on later runs.
- **Clearing the cache.** It is safe to delete the cache folder at any time; it is rebuilt on the next run. The first run on a new mesh takes longer, because it downloads the full coordinate and LMSL fields once.

# Visualization app
A local web app to run flight planning and explore the results on a map: which lines can be flown when, a suggested flight plan, a simulated photo for any photo point, and the STOFS forecast water levels on the model mesh.

## Starting the app
From the repository folder, in the project's Python environment:
```
python app.py
```
Your web browser opens on the app (at <http://localhost:8050> by default). Close it with Ctrl+C in the terminal. Options: `--port <n>` to use another port, `--no-browser` to not open a browser window.

The app uses only the Python standard library; there is nothing extra to install. The page loads deck.gl, MapLibre, the basemap and the satellite imagery from the web, so it needs an internet connection (as do the forecasts). After the app is updated, reload its browser tab (Cmd+Shift+R or Ctrl+Shift+R) to get the new version.

## Running a calculation (New run tab)
1. **Flight lines:** pick a file from `data/` (any `.wpt`, `.txt` or `.csv` flight-lines file with the `LINE`, `LAT1`, `LON1`, `LAT2`, `LON2` and `PHOTOS` columns), or upload one, or drop it on the page. Its lines are drawn on the map straight away. Click a line to see every column of its row.
2. **STOFS forecast:** the runs from the last four days that are on NOAA's archive; the latest is selected. (For older forecasts, run `predict.py` directly.)
3. **Datums**, **minimum sun elevation**, and under **More options** the photo points checked per line and the time zone for the results.
4. Press **Run**. The steps tick off as it works, usually one to two minutes, with a Cancel button and the log. When it finishes, the results open.

Each run is kept in its own folder under `runs/` (ignored by git), with the same output files as `predict.py` plus the run's log. **Past runs** are listed under the form; click one to open its results again.

## Results tab
- **Flight plans.** The lines are scheduled into flights (`viewer/planner.js`). Each line is flown entirely inside one of its time windows, in either direction; the time to fly each line, the transit and turn between lines, and a maximum flight length are taken into account, with one flight per day. Four plans are offered:
  - **Finish soonest:** fly every day there are windows.
  - **Fewest flights:** cover the most lines per flight.
  - **Best value:** the fewest total hours for the lines covered, counting time on site and an overhead per flight (getting to and from the site, take-off and landing). It may leave out lines that would need a flight of their own.
  - **Best single flight:** the most lines in one flight.

  The **recommended** plan covers every line that has a window in the fewest total hours. Each plan lists its flights with times and the order of lines; click a flight to show only that flight. On the map, planned lines are coloured by flight, numbered in flying order, with an arrow showing the direction each line is flown and the transits between lines. The map stays north-up.
- **Planning assumptions:** ground speed (default 180 kt), time per turn or line change (4 min), longest flight on site (4 h), overhead per flight (1 h) and longest wait for a window (60 min). Plans update as you type, and a message says whether the recommended plan changed. **Reset to defaults** restores them.
- **Photo preview.** Click any white photo point to see a simulated photo at the time it would be taken in the selected plan (`viewer/photo.js`, `viewer/geometry.js`):
  - Esri World Imagery cut to the photo's exact ground footprint and turned so the flight direction is up, as the camera sees it. The camera geometry comes from the flight-lines file: flying height = focal length × scale, footprint = image format × scale (3.34 × 2.50 km from 3,200 m for AL2401).
  - Lighting for the sun at that moment: dimmer, warmer and hazier when the sun is low. A compass shows north and the sun's direction.
  - Sun glint on water only (water outlines from the basemap), with its strength from the Cox–Munk wave-slope model for a light breeze (5 m/s). Glint enters the frame only when the sun is high, above about 69° for the AL2401 camera.
  - The sun's elevation and direction, the glint verdict, shadow direction and length, and the footprint are listed under the image. The sun position is computed in the browser and agrees with `predict.py`'s pvlib values to within 0.15°.

  The preview is an illustration: the satellite image has its own sun, shadows, tide and season, and clouds and waves are not modelled.
- **STOFS water levels on the mesh** (under **Map view**, off by default). The forecast water level on every STOFS model triangle in the survey area, coloured blue below and orange above the chosen reference (local mean sea level or one of the run's datums), with the mesh edges (can be turned off). A time bar on the map steps through the forecast hour by hour, with play/pause. Hover over a triangle to read its water level. Dry areas are not shown.
- **Lines.** Every line with its first window, number of windows and place in the plan (flight · order). Click a line to select it; clicking a line on the map also opens a popup with every column of its flight-lines file row.
- Notes explaining datums with no windows (for example, sun too low) are shown at the top. Switch datum with the buttons at the top of the Results panel.

## Viewing results without the app
The page in `viewer/` can also show results from `predict.py` runs made on the command line. Start a plain web server in the repository folder:
```
python -m http.server 8000
```
then open <http://localhost:8000/viewer/> and choose **Open results…**, or drop a `.gui.json` file onto the page. To include the mesh view, open the file through a `data` link instead, so the page can find the `.mesh.bin` file next to it, for example:
```
http://localhost:8000/viewer/?data=../data/testing/AL2401/AL2401_mllw_mhw_20250101T12.gui.json
```
Inside the app, **Open file…** does the same for a `.gui.json` file (without the mesh view).

## Files
| File | What it is |
|---|---|
| `app.py` | The local web server: run form, runs, forecast list, flight-line files |
| `viewer/index.html`, `viewer/style.css` | The page |
| `viewer/app.js` | Map, panels, plans display, mesh view controls |
| `viewer/planner.js` | Flight planner |
| `viewer/geometry.js` | Sun position, camera footprint, glare and shadow geometry |
| `viewer/photo.js` | Simulated photo |
| `viewer/mesh.js` | Reading and colouring the mesh water levels |
| `<name>.gui.json` | Written by `predict.py`: lines (with every flight-lines column), photo points, matched model nodes, hourly water levels, datums and tolerance, sun elevation, windows, notes and settings |
| `<name>.mesh.bin` | Written by `predict.py`: node positions, mesh triangles, datum heights and hourly water levels (16-bit centimetres) for every mesh node in the area |

## Requirements and limits
- Photo previews need the flight-lines columns `SCALE`, `FocalLength(M)`, `FormatX(FT)` and `FormatY(FT)`. Results made before 2026-11-26 do not include them, and results made before 2026-11-27 have no mesh file; run them again to use those features.
- The mesh view uses the real STOFS triangles, which are downloaded once per mesh into the mesh cache (about 300 MB). Without the mesh cache, an approximate triangulation of the nodes is used and the view says so.
- Planning does not include the actual distance to and from an airport (only the overhead per flight), weather, or airspace.
- The photo preview assumes a vertical camera and flat ground and water at the file's ground elevation.

# Disclaimer
This repository is a scientific product and is not official communication of the National Oceanic and Atmospheric Administration, or the United States Department of Commerce. All NOAA GitHub project code is provided on an "as is" basis and the user assumes responsibility for its use. Any claims against the Department of Commerce or Department of Commerce bureaus stemming from the use of this GitHub project will be governed by all applicable Federal law. Any reference to specific commercial products, processes, or services by service mark, trademark, manufacturer, or otherwise, does not constitute or imply their endorsement, recommendation or favoring by the Department of Commerce. The Department of Commerce seal and logo, or the seal and logo of a DOC bureau, shall not be used in any manner to imply endorsement of any commercial product or activity by DOC or the United States Government.

# Changelog

## 2026-11-27

### Enhancements
- **STOFS water levels on the mesh** in the results viewer: a map view option (off by default) with a time bar, coloured by water level relative to local mean sea level or a datum, with the mesh edges.
  - `predict.py` also writes `<name>.mesh.bin` (`outputs.mesh_levels_prediction`): node positions, mesh triangles, datum heights and hourly water levels for every mesh node in the survey area, compactly as 16-bit centimetres. About 24 MB for AL2401 (57,941 nodes, 114,308 triangles, 186 hours). If writing it fails, the error is logged and the other outputs are unaffected.
  - The STOFS triangle list (~300 MB for the global mesh) is downloaded once per mesh into the mesh cache (`element.npy`) and spot-checked against the forecast file on later runs. Without the mesh cache, or with the xarray-subset-grid loader, an approximate (Delaunay) triangulation of the nodes is used instead and labelled as such in the viewer.
  - `app.py` serves the file at `/api/runs/<id>/mesh`.
- **README:** the app and results viewer are now described together in a new "Visualization app" section.

## 2026-11-26

### Enhancements
- **App** (`app.py`). `python app.py` opens a local web app to start runs and see the results, with no other steps. See "Visualization app" above.
  - Choosing a flight-lines file, or uploading one, draws its lines on the map before the run.
  - The run form lists the flight-line files in `data/` (or takes an upload, checked for the required columns), the STOFS forecast cycles available on NOAA's S3 from the last four days, the datums, the minimum sun elevation, points per line and output time zone.
  - Each run calls `predict.py` in its own process and folder under `runs/` (ignored by git). Progress, a cancel button and the log are shown while it runs, and the results open when it finishes. Past runs are listed and can be reopened.
  - Only the Python standard library is used; no new dependencies.
- **Results viewer** (`viewer/`), built on deck.gl and MapLibre with no build step. It plans the flights and shows what each photo would look like. See "Visualization app" above.
  - **Flight plans** (`viewer/planner.js`): a recommended plan and alternates (finish soonest, fewest flights, best value, best single flight), each a set of flights with the order and time of every line, shown on the map. Planning assumptions are editable. For AL2401 (MLLW, 26 Nov 18Z forecast) the recommended plan flies all 17 lines that have windows in 3 flights, 2.2 h on site.
  - **Photo preview** (`viewer/photo.js`, `viewer/geometry.js`): clicking a photo point renders a simulated photo from Esri World Imagery, cut to the photo footprint and turned to the flight direction, lit for the sun at the planned time, with sun glint on water.
  - Clicking a line shows every column of its flight-lines file row in a popup.
  - Arrows beside planned lines show the direction each line is flown; the map stays north-up.
  - Planning assumptions update the plans as you type, with a message saying whether the recommended plan changed, and a reset button.
  - `predict.py` now also writes `<name>.gui.json` (`outputs.gui_json_prediction`) with the flight lines, photo points, matched model nodes and their distance, hourly forecast water level, datum levels and tolerance, hourly solar elevation, line and point windows, notes and run settings. It also stores every column of the flight-lines file for each line. It is about 1.8 MB for the AL2401 example. If writing it fails, the error is logged and the other outputs are unaffected.
- **Mesh cache.** In the byte-range loading mode, the STOFS mesh node coordinates and the local mean sea level (LMSL) field are now cached on disk after the first run. Later runs on the same mesh skip downloading them. See "Mesh cache" above.
  - For the AL2401 example, a run took 75 s with a warm cache versus 90 s without the cache, with identical output files. Most of the remaining time (about 50 s) is downloading the forecast water levels, which change with every forecast and cannot be cached. The first run on a new mesh downloads about 460 MB once (the mesh coordinates, plus the LMSL field and its coordinates for the mesh check) and stores about 255 MB on disk.
  - Before a cached mesh is used, the forecast file's mesh is fingerprinted: dimension sizes, 32,768 sampled node coordinates and the open-boundary arrays (`mesh_handling.mesh_fingerprint`). Each STOFS mesh gets its own cache entry, so a new mesh, for example after a STOFS upgrade, is never mistaken for a cached one.
  - On every cache hit, the coordinates of all nodes the run actually uses are also compared with the forecast file. If any differ, the cache entry is downloaded again and replaced.
  - The cached LMSL is used only if the LMSL file on S3 is unchanged (same ETag). When the LMSL cache is built, the LMSL file's coordinates are checked against the forecast mesh at every node.
  - New options for `predict.py` and `qc.py`: `--mesh-cache-dir <dir>` and `--no-mesh-cache`. The `NGS_MESH_CACHE_DIR` environment variable also sets the location. In Python, use `load_forecast_ds(..., mesh_cache=...)`.

## 2026-11-25

### Bug fixes
- **West Coast/Alaska crash with `--datums bmhw`** (`ValueError: dim_order ['station', 'time'] does not match ... ['station', 'time', 'node']`). In the West Coast/Alaska region the tidal range uses MLLW. If MLLW wasn't one of the requested datums, it was added after image points were matched to model nodes, but labelled with the old `node` dimension instead of `station`. The tidal range and tolerance then became 2D `(station, node)` arrays. This was unrelated to the STOFS-2D-Global v3.1 upgrade.
  - `mesh_handling.ds_add_datum` now uses the dataset's own spatial dimension instead of assuming `node`.
  - `predict.py` and `qc.py` now always add MLLW, along with MHW and MLW, before matching nodes.
- **Crash when no time windows are found** (`KeyError: 0` in `outputs.line_text_prediction`). This happened, for example, in Alaska in late autumn, when the sun never reaches the minimum solar elevation. The text outputs now write a clear message instead, and the other output files are still written.
- **Silent all-NaN water levels in `processing.interp_time`.** The one-minute time axis was always built in nanoseconds. If the forecast's time axis used another unit (pandas 3 defaults to microseconds), every interpolated value became NaN and no windows were found. The new axis now uses the same unit as the data. Real STOFS data uses nanoseconds, so earlier runs were not affected.
- **`xarray-subset-grid` fails to import on Python 3.11/3.12** with its latest GitHub commits. `requirements.txt` and `dev_requirements.txt` now pin commit `f96a90b`. See "Note on `xarray-subset-grid`" above.

### Enhancements
- **Faster STOFS forecast loading.** When the forecast water levels (`zeta`) are stored uncompressed, `mesh_handling.load_forecast_ds` downloads only the bytes for mesh nodes inside the area of interest, using concurrent byte-range requests. Before, it downloaded whole global chunks for every time step.
  - For the AL2401 example: about 52 MB downloaded instead of about 2.4 GB, and the whole run took 97 s instead of about 7 minutes, with identical output files.
  - The file's compression is checked first (`mesh_handling.zeta_byte_range_layout`). If the data are compressed or filtered, or the fast method fails for any reason, the original xarray-subset-grid method is used, and the reason is logged.
  - The fast method can be turned off with `load_forecast_ds(..., allow_byte_ranges=False)`.
- **Explanations when a datum has no time windows.** The new function `processing.explain_missing_windows` works out why, and the reason is logged as a warning and written as a `NOTE:` at the top of the `.lines.txt` and `.dates.txt` outputs. Possible reasons:
  - the sun never reaches the minimum solar elevation (the highest elevation reached is reported)
  - the water level is never within tolerance of the datum (the closest it gets is reported)
  - the water level is in range only when the sun is too low
  - photo points have windows, but they never overlap across a whole line
