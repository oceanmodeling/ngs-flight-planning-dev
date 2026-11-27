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
```

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
- **Clearing the cache.** It is safe to delete the cache folder at any time; it is rebuilt on the next run. The first run on a new mesh takes longer, because it downloads the full coordinate and LMSL fields once.

#### Disclaimer
This repository is a scientific product and is not official communication of the National Oceanic and Atmospheric Administration, or the United States Department of Commerce. All NOAA GitHub project code is provided on an "as is" basis and the user assumes responsibility for its use. Any claims against the Department of Commerce or Department of Commerce bureaus stemming from the use of this GitHub project will be governed by all applicable Federal law. Any reference to specific commercial products, processes, or services by service mark, trademark, manufacturer, or otherwise, does not constitute or imply their endorsement, recommendation or favoring by the Department of Commerce. The Department of Commerce seal and logo, or the seal and logo of a DOC bureau, shall not be used in any manner to imply endorsement of any commercial product or activity by DOC or the United States Government.

# Changelog

## 2026-11-26

### Enhancements
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
