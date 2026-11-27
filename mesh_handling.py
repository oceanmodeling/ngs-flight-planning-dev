"""Functions for handling STOFS forecast mesh files.

Functions
---------
get_box
load_forecast_ds
zeta_byte_range_layout
mesh_fingerprint
get_nearest_inds_dists
ds_add_datum
ds_add_tidal_range
tidal_tol_from_range

"""


import logging
import sys
import shapely
import geopandas as gpd
import datetime
import xarray
import pandas
import numpy
import scipy
import s3fs
import xarray_subset_grid
import math
import os
import json
import hashlib
import pathlib
import asyncio
import concurrent.futures
import obstore
from coastalmodeling_vdatum import vdatum
from obstore.store import S3Store
from virtualizarr.parsers import HDFParser
from virtualizarr.registry import ObjectStoreRegistry
from utils import switch_lon_lims


logger = logging.getLogger(__name__)


def get_box(geometries: gpd.GeoDataFrame, 
            buffer: float = 0.1) -> shapely.box:
    """Get a buffered box around geometries in a geopandas data frame.

    Parameters
    ----------
    geometries
        The collection of geometries around which the box will be defined.
    buffer
        Additional buffer around the box.

    Returns
    -------
    Shapely box
        A single polygon containing the union of all the geometries in 
        the input data frame.
        
    """
    tb = geometries.total_bounds
    bbox = shapely.box(tb[0] - buffer, tb[1] - buffer,
                       tb[2] + buffer, tb[3] + buffer)
    return bbox


STOFS_BUCKET = 'noaa-gestofs-pds'
LMSL_PATH = 'noaa-nos-stofs2d-pds/_archive/msl_2017-2019_avg/GSTOFSv5.6.5_msl_2017-2019_avg_20241619.nc'


def load_forecast_ds(init_datetime: datetime.datetime,
                     bbox: shapely.box,
                     convert_to_local_msl: bool = True,
                     allow_byte_ranges: bool = True,
                     mesh_cache: bool | str | pathlib.Path = True) -> xarray.Dataset:
    """Load STOFS-2D-Global forecast water levels for a lat-lon box.

    Hardcoded to return a single STOFS-2D-Global forecast run.

    Two loading methods are available:

    * Byte-range reads (fast). Used only if the water level variable
      (zeta) is stored uncompressed and unfiltered in the source file,
      which makes the byte position of every (time, node) value
      computable. Only the bytes for nodes inside bbox are downloaded,
      instead of whole 12.8 MB global chunks for every time step.
      The mesh node coordinates and LMSL values, which are the same for
      every forecast on a given mesh, can be cached on disk (see
      mesh_cache).
    * xarray-subset-grid (slow, ~5+ minutes). Used if the data are
      compressed or filtered, if allow_byte_ranges is False, or if
      the fast method fails for any reason. Does not use the cache.

    Both return the same structure: zeta (time, node) for nodes in bbox,
    with lat and lon coordinates.

    Parameters
    ----------
    init_datetime
        The initialization datetime of the forecast to load.
    bbox
        The bounding box of the region to load.
    convert_to_local_msl
        Whether or not to convert to local mean sea level.
    allow_byte_ranges
        Whether the fast byte-range method may be used (when the source
        file allows it). Set False to force the xarray-subset-grid method.
    mesh_cache
        Where to cache mesh node coordinates and LMSL values between runs.
        True (default) uses $NGS_MESH_CACHE_DIR if set, otherwise
        ~/.cache/ngs-flight-planning/meshes. A path uses that directory.
        False disables the cache. Before a cached mesh is used, the
        forecast file's mesh is fingerprinted (sizes, sampled node
        coordinates and boundary arrays), so a different STOFS mesh is
        never mistaken for a cached one; each mesh gets its own entry.

    Returns
    -------
    xarray dataset containing forecast data on original model mesh.

    """
    # Open global dataset (metadata only) as a virtual zarr store.
    yyyymmdd = init_datetime.strftime('%Y%m%d')
    hh = init_datetime.strftime('%H')
    subdir = f'stofs_2d_glo.{yyyymmdd}'
    filename = f'stofs_2d_glo.t{hh}z.fields.cwl.nc'
    #
    store = S3Store(
        bucket=STOFS_BUCKET,
        region="us-east-1",
        skip_signature=True,
        client_options={"timeout": "300s", "connect_timeout":"60s"},
        retry_config={"max_attempts": 5}
    )
    registry = ObjectStoreRegistry({f"s3://{STOFS_BUCKET}": store})
    parser = HDFParser()
    manifest_store = parser(
        url=f"s3://{STOFS_BUCKET}/{subdir}/{filename}",
        registry=registry
    )
    logger.info('Opening data file...')
    ds = xarray.open_zarr(
        manifest_store,
        consolidated=False,
        zarr_format=3,
    )
    logger.info('Finished opening data file.')

    if allow_byte_ranges:
        try:
            vds = manifest_store.to_virtual_dataset()
        except Exception as e:
            vds = None
            layout = f'could not read chunk manifest: {e!r}'
        else:
            layout = zeta_byte_range_layout(vds)
        if isinstance(layout, str):
            logger.info(f'Byte-range loading not possible ({layout}). '
                        'Using xarray-subset-grid instead (slower).')
        else:
            logger.info('Forecast water levels are stored uncompressed: '
                        'using byte-range loading.')
            try:
                return _load_forecast_byte_ranges(
                    store, ds, vds, layout, bbox, convert_to_local_msl,
                    _mesh_cache_root(mesh_cache)
                )
            except Exception as e:
                logger.warning(f'Byte-range loading failed ({e!r}). '
                               'Falling back to xarray-subset-grid (slower).')
    else:
        logger.info('Byte-range loading disabled: using xarray-subset-grid.')

    return _load_forecast_xsg(ds, bbox, convert_to_local_msl)


def zeta_byte_range_layout(vds, var: str = 'zeta') -> dict | str:
    """Check whether a variable can be read with plain byte-range requests.

    This is only safe when every chunk is stored as raw bytes: no
    compression, no filters (e.g., shuffle), and every chunk present
    in the file at exactly its uncompressed size.

    Parameters
    ----------
    vds
        Virtual dataset for the forecast file (from
        ManifestStore.to_virtual_dataset()), or the ManifestStore itself.
    var
        Name of the variable to check.

    Returns
    -------
    dict describing the chunk layout if byte-range reads are possible,
    otherwise a string giving the reason they are not.

    """
    layout = _raw_chunk_layout(vds, var)
    if isinstance(layout, dict) and len(layout['shape']) != 2:
        return f"{var} has {len(layout['shape'])} dimensions, expected 2 (time, node)"
    return layout


def _raw_chunk_layout(vds, var: str) -> dict | str:
    """Chunk layout of a variable stored as raw bytes, or why it is not.

    Works for any number of dimensions. See zeta_byte_range_layout.
    """
    if hasattr(vds, 'to_virtual_dataset'):
        try:
            vds = vds.to_virtual_dataset()
        except Exception as e:
            return f'could not read chunk manifest: {e!r}'
    if var not in vds.variables:
        return f'variable {var} not found'
    marr = vds[var].data
    meta = marr.metadata.to_dict()
    codecs = meta.get('codecs', ())
    codec_names = [c['name'] if isinstance(c, dict) else str(c) for c in codecs]
    if codec_names != ['bytes']:
        return f'{var} is compressed or filtered (codecs: {codec_names})'
    if meta.get('storage_transformers'):
        return f'{var} uses storage transformers'
    if meta['chunk_grid']['name'] != 'regular':
        return f'{var} does not use a regular chunk grid'
    endian = codecs[0].get('configuration', {}).get('endian', 'little')
    dtype = numpy.dtype(meta['data_type']).newbyteorder('<' if endian == 'little' else '>')
    shape = tuple(meta['shape'])
    chunk_shape = tuple(meta['chunk_grid']['configuration']['chunk_shape'])
    n_chunks = tuple(math.ceil(s / c) for s, c in zip(shape, chunk_shape))
    chunk_bytes = math.prod(chunk_shape) * dtype.itemsize
    entries = marr.manifest.dict()
    if len(entries) != math.prod(n_chunks):
        return f'{var} has missing chunks ({len(entries)} of {math.prod(n_chunks)} stored)'
    chunks = {}
    for key, entry in entries.items():
        if entry['length'] != chunk_bytes:
            return (f'{var} chunk {key} is {entry["length"]} bytes, not the raw '
                    f'size {chunk_bytes}, so it must be encoded')
        idx = tuple(int(i) for i in key.replace('/', '.').split('.'))
        chunks[idx] = (entry['path'], entry['offset'])
    return {'var': var, 'dtype': dtype, 'shape': shape,
            'chunk_shape': chunk_shape, 'chunks': chunks,
            'fill_value': meta.get('fill_value')}


def _read_nodes_byte_ranges(store, layout: dict, node_idx: numpy.ndarray,
                            max_gap_nodes: int = 2048,
                            max_concurrency: int = 64) -> numpy.ndarray:
    """Read values of a (time, node) variable for selected nodes only.

    Contiguous runs of the selected node indices (merged across gaps of
    up to max_gap_nodes, and split at chunk boundaries) are each fetched
    as one byte range per time step. The ranges for each time step are
    fetched as one obstore call (which coalesces nearby ranges), with up
    to max_concurrency time steps fetched at once.

    Returns
    -------
    numpy array with shape (n_time, len(node_idx)).

    """
    dtype = layout['dtype']
    item = dtype.itemsize
    n_time = layout['shape'][0]
    ct, cn = layout['chunk_shape']
    node_idx = numpy.asarray(node_idx)
    # Runs of selected nodes, as [start, end) node indices, split at chunk edges.
    runs = []
    run_start = prev = int(node_idx[0])
    for n in node_idx[1:]:
        n = int(n)
        if n - prev > max_gap_nodes or n // cn != run_start // cn:
            runs.append((run_start, prev + 1))
            run_start = n
        prev = n
    runs.append((run_start, prev + 1))
    # Build one request per (time, run).
    requests = {}  # path -> list of (start_byte, end_byte, t, run_start, run_end)
    for t in range(n_time):
        for r0, r1 in runs:
            path, chunk_offset = layout['chunks'][(t // ct, r0 // cn)]
            within = ((t % ct) * cn + (r0 % cn)) * item
            start = chunk_offset + within
            requests.setdefault(path, []).append((start, start + (r1 - r0) * item, t, r0, r1))
    n_req = sum(len(v) for v in requests.values())
    n_bytes = sum(e - s for v in requests.values() for s, e, *_ in v)
    # Small single-time reads (mesh checks) are logged at debug level only.
    log = logger.info if n_time > 1 else logger.debug
    log(f'Fetching {len(node_idx)} nodes x {n_time} times: {len(runs)} node '
        f'runs, {n_req} byte ranges, {n_bytes / 1e6:.1f} MB.')
    # Fetch: one batch per (file, time step), with up to max_concurrency
    # batches in flight. Many small ranges are latency-bound, so running
    # them concurrently matters far more than the number of bytes.
    batches = {}
    for path, reqs in requests.items():
        key = path.split('://', 1)[-1].split('/', 1)[1]  # strip s3://bucket/
        for r in reqs:
            batches.setdefault((key, r[2]), []).append(r)

    async def fetch_all():
        sem = asyncio.Semaphore(max_concurrency)

        async def fetch(key, reqs):
            async with sem:
                bufs = await obstore.get_ranges_async(
                    store, key,
                    starts=[r[0] for r in reqs],
                    ends=[r[1] for r in reqs]
                )
            return reqs, bufs

        return await asyncio.gather(*(fetch(k, v) for (k, _), v in batches.items()))

    results = _run_coroutine(fetch_all())

    # Scatter into output.
    out = numpy.empty((n_time, len(node_idx)), dtype=dtype.newbyteorder('='))
    for reqs, buffers in results:
        for (s, e, t, r0, r1), buf in zip(reqs, buffers):
            vals = numpy.frombuffer(buf, dtype=dtype)
            sel = (node_idx >= r0) & (node_idx < r1)
            out[t, sel] = vals[node_idx[sel] - r0]
    return out


def _run_coroutine(coro):
    """Run a coroutine to completion, also from inside a running event loop
    (e.g., a Jupyter notebook), by using a separate thread in that case."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def _load_forecast_byte_ranges(store, ds: xarray.Dataset, vds, layout: dict,
                               bbox: shapely.box,
                               convert_to_local_msl: bool,
                               cache_root: pathlib.Path | None = None) -> xarray.Dataset:
    """Load zeta for nodes in bbox via byte-range reads (see load_forecast_ds)."""
    x, y, cache_entry, from_cache = _get_mesh_coords(store, ds, vds, cache_root)
    node_idx = _nodes_in_box(x, y, bbox)
    if from_cache and not _cached_nodes_match(store, vds, node_idx, x, y):
        # The fingerprint matched but the nodes we need differ: the cache
        # entry is wrong for this mesh. Download and replace it.
        logger.warning('Cached mesh coordinates differ from the forecast file at '
                       'the nodes in the box: downloading and replacing the cache entry.')
        x, y, cache_entry = _refresh_mesh_cache(ds, cache_entry)
        node_idx = _nodes_in_box(x, y, bbox)
    logger.info(f'{len(node_idx)} mesh nodes inside the box.')

    logger.info('Loading water levels with byte-range requests...')
    zeta = _read_nodes_byte_ranges(store, layout, node_idx).astype('float32')
    # Mask missing (dry) values the same way xarray does when opening
    # the file, i.e., using the stored fill value.
    fill = layout['fill_value']
    if fill is not None:
        zeta[numpy.isclose(zeta, fill, rtol=1e-6)] = numpy.nan
    logger.info('Finished loading water levels.')

    subset_ds = xarray.Dataset(
        {'zeta': (('time', 'node'), zeta, ds['zeta'].attrs)},
        coords={'time': ds['time'].values,
                'x': ('node', x[node_idx]),
                'y': ('node', y[node_idx])},
    )

    if convert_to_local_msl:
        lmsl = _get_lmsl_for_nodes(node_idx, x, y, cache_entry)
        logger.info('Subtracting LMSL...')
        subset_ds['zeta'] = subset_ds['zeta'] - xarray.DataArray(lmsl, dims=['node'])

    # Mesh triangles inside the box, for the results viewer's mesh view.
    # Stored as extra variables that predict.py removes before processing.
    try:
        tri = _triangles_in_box(store, ds, vds, node_idx, cache_entry)
        if tri is not None:
            subset_ds['mesh_tri'] = (('mesh_face', 'corner'), tri)
    except Exception as e:
        logger.warning(f'Could not load mesh triangles ({e!r}); the mesh view will use an approximate triangulation.')
    subset_ds['global_node'] = ('node', node_idx)

    logger.info('Renaming x and y coordinates to match thalassa.')
    return subset_ds.rename({'x':'lon', 'y':'lat'})


def _triangles_in_box(store, ds: xarray.Dataset, vds, node_idx: numpy.ndarray,
                      cache_entry: pathlib.Path | None) -> numpy.ndarray | None:
    """Mesh triangles with all three corners among node_idx, as local indices.

    The global triangle list (~300 MB) is downloaded once per mesh and kept
    in the mesh cache. Without the cache it is not downloaded (too large to
    fetch on every run) and None is returned.
    """
    if cache_entry is None:
        logger.info('Mesh cache disabled: mesh triangles not loaded.')
        return None
    n_node = int(ds.sizes['node'])
    path = cache_entry / 'element.npy'
    layout = _raw_chunk_layout(vds, 'element')
    elements = None
    if path.exists():
        elements = numpy.load(path, mmap_mode='r')
        # Spot-check the cached triangles against the forecast file.
        if isinstance(layout, dict) and elements.shape == tuple(layout['shape']):
            ok = all(_elements_match(store, layout, elements, rows) for rows in
                     (slice(0, 50), slice(elements.shape[0] // 2, elements.shape[0] // 2 + 50),
                      slice(elements.shape[0] - 50, elements.shape[0])))
            if not ok:
                logger.warning('Cached mesh triangles differ from the forecast file: downloading them again.')
                elements = None
        else:
            elements = None
    if elements is None:
        logger.info('Downloading mesh triangles once for the mesh cache (~300 MB)...')
        start = int(ds['element'].attrs.get('start_index', 1))
        elements = (ds['element'].values - start).astype('int32')
        _save_cache_files(cache_entry, {'element.npy': elements}, 'element.json',
                          {'start_index_removed': start, 'shape': list(elements.shape),
                           'created': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        elements = numpy.load(path, mmap_mode='r')
    inbox = numpy.zeros(n_node, dtype=bool)
    inbox[node_idx] = True
    el = numpy.asarray(elements)
    keep = inbox[el[:, 0]] & inbox[el[:, 1]] & inbox[el[:, 2]]
    local = numpy.full(n_node, -1, dtype='int64')
    local[node_idx] = numpy.arange(len(node_idx))
    tri = local[el[keep]].astype('int32')
    logger.info(f'{len(tri)} mesh triangles inside the box.')
    return tri


def _elements_match(store, layout: dict, cached: numpy.ndarray, rows: slice) -> bool:
    """Compare cached triangles (0-based) with the file (1-based) for some rows."""
    item = layout['dtype'].itemsize
    path, offset = layout['chunks'][(0, 0)]
    key = path.split('://', 1)[-1].split('/', 1)[1]
    start = offset + rows.start * 3 * item
    raw = numpy.frombuffer(obstore.get_range(store, key, start=start, end=start + (rows.stop - rows.start) * 3 * item),
                           dtype=layout['dtype']).reshape(-1, 3)
    return numpy.array_equal(raw - 1, numpy.asarray(cached[rows]))


# ---------------------------------------------------------------------------
# Mesh cache
#
# Node coordinates (x, y: ~205 MB) and LMSL (~50 MB) are the same for every
# forecast on a given STOFS mesh. They are cached on disk in one directory
# per mesh, named by a fingerprint computed from the forecast file itself on
# every run, so a different mesh (e.g., after a STOFS upgrade) gets its own
# entry and is never confused with a cached one.
# ---------------------------------------------------------------------------

MESH_CACHE_ENV_VAR = 'NGS_MESH_CACHE_DIR'
MESH_FINGERPRINT_BLOCKS = 64       # evenly spaced blocks of nodes ...
MESH_FINGERPRINT_BLOCK_SIZE = 512  # ... of this many consecutive nodes each


def _mesh_cache_root(mesh_cache: bool | str | pathlib.Path | None) -> pathlib.Path | None:
    """Resolve the mesh_cache argument of load_forecast_ds to a directory."""
    if mesh_cache is None or mesh_cache is False:
        return None
    if mesh_cache is True:
        env = os.environ.get(MESH_CACHE_ENV_VAR)
        if env:
            return pathlib.Path(env).expanduser()
        return pathlib.Path.home() / '.cache' / 'ngs-flight-planning' / 'meshes'
    return pathlib.Path(mesh_cache).expanduser()


def _nodes_in_box(x: numpy.ndarray, y: numpy.ndarray, bbox: shapely.box) -> numpy.ndarray:
    """Indices of mesh nodes inside a lon-lat box."""
    minx, miny, maxx, maxy = bbox.bounds
    lon = switch_lon_lims(x, min_lon=-180.0) if minx < 0 else switch_lon_lims(x, min_lon=0.0)
    node_idx = numpy.flatnonzero((lon >= minx) & (lon <= maxx) & (y >= miny) & (y <= maxy))
    if len(node_idx) == 0:
        raise ValueError(f'no forecast mesh nodes inside box {bbox.bounds}')
    return node_idx


def _cached_nodes_match(store, vds, node_idx, x, y) -> bool:
    """Check cached x, y against the forecast file at exactly these nodes."""
    for var, cached in (('x', x), ('y', y)):
        actual = _read_1d_nodes(store, _raw_chunk_layout(vds, var), node_idx)
        if not numpy.array_equal(actual, cached[node_idx]):
            return False
    logger.info(f'Cached coordinates verified at all {len(node_idx)} nodes in the box.')
    return True


def mesh_fingerprint(store, ds: xarray.Dataset, vds,
                     n_blocks: int = MESH_FINGERPRINT_BLOCKS,
                     block_size: int = MESH_FINGERPRINT_BLOCK_SIZE) -> tuple[str, dict]:
    """Fingerprint the mesh of a forecast file without downloading all of it.

    Combines:
      * the mesh dimension sizes (nodes, elements, boundaries),
      * x and y for n_blocks evenly spaced blocks of block_size
        consecutive nodes (32,768 nodes and ~0.5 MB by default, read
        with one byte-range request per block),
      * the small boundary arrays (nvell, ibtype, nbvv), if present.

    Parameters
    ----------
    store
        obstore store for the forecast bucket.
    ds
        The forecast dataset (opened lazily).
    vds
        Virtual dataset for the forecast file (holds the chunk manifests).
    n_blocks, block_size
        How many blocks of nodes to sample, and how many nodes per block.

    Returns
    -------
    Tuple of (fingerprint string, dict of sampled node indices and values,
    used to double-check cached coordinates before they are used).

    Raises
    ------
    ValueError if x or y are not stored as raw bytes (so cannot be sampled
    cheaply); the caller then skips the cache.

    """
    sizes = {d: int(ds.sizes[d]) for d in ('node', 'nfaces', 'nvertex', 'nbou', 'nvel')
             if d in ds.sizes}
    h = hashlib.sha256(json.dumps(sizes, sort_keys=True).encode())
    n_node = sizes['node']
    block_size = min(block_size, n_node)
    starts = numpy.unique(numpy.linspace(0, n_node - block_size, n_blocks).astype('int64'))
    idx = numpy.unique((starts[:, None] + numpy.arange(block_size)[None, :]).ravel())
    samples = {'idx': idx}
    for var in ('x', 'y'):
        layout = _raw_chunk_layout(vds, var)
        if isinstance(layout, str):
            raise ValueError(f'cannot sample mesh coordinates ({layout})')
        if len(layout['shape']) != 1 or layout['shape'][0] != n_node:
            raise ValueError(f'{var} has unexpected shape {layout["shape"]}')
        samples[var] = _read_1d_nodes(store, layout, idx)
        h.update(samples[var].astype('<f8').tobytes())
    for var in ('nvell', 'ibtype', 'nbvv'):
        if var in ds.variables:
            h.update(var.encode())
            h.update(numpy.ascontiguousarray(ds[var].values).astype('<i8').tobytes())
    return h.hexdigest()[:16], samples


def _read_1d_nodes(store, layout: dict, node_idx: numpy.ndarray) -> numpy.ndarray:
    """Read a raw 1D variable at the given node indices, using byte ranges.

    Reuses the (time, node) reader by treating the variable as one time
    step, so runs of consecutive indices are fetched as single ranges.
    """
    layout2d = dict(layout, shape=(1, layout['shape'][0]),
                    chunk_shape=(1, layout['chunk_shape'][0]),
                    chunks={(0, c): v for (c,), v in layout['chunks'].items()})
    # max_gap_nodes=1: merge only consecutive nodes, so no extra bytes are read.
    return _read_nodes_byte_ranges(store, layout2d, node_idx, max_gap_nodes=1)[0].astype('float64')


def _get_mesh_coords(store, ds: xarray.Dataset, vds,
                     cache_root: pathlib.Path | None) -> tuple:
    """Get global node coordinates x, y, from the mesh cache if possible.

    Returns
    -------
    Tuple of (x, y, cache entry directory or None if the cache is not
    used, whether x and y came from the cache).

    """
    def download():
        logger.info('Downloading mesh node coordinates...')
        return ds['x'].values, ds['y'].values

    if cache_root is None:
        logger.info('Mesh cache disabled.')
        x, y = download()
        return x, y, None, False
    try:
        fingerprint, samples = mesh_fingerprint(store, ds, vds)
    except Exception as e:
        logger.info(f'Mesh cache not used: {e}')
        x, y = download()
        return x, y, None, False

    entry = cache_root / f'mesh_{fingerprint}'
    n_node = int(ds.sizes['node'])
    idx = samples['idx']
    x_file, y_file = entry / 'x.npy', entry / 'y.npy'
    if x_file.exists() and y_file.exists():
        try:
            x = numpy.load(x_file)
            y = numpy.load(y_file)
            if (len(x) == n_node and len(y) == n_node and
                    numpy.array_equal(x[idx], samples['x']) and
                    numpy.array_equal(y[idx], samples['y'])):
                logger.info(f'Using cached mesh {fingerprint} ({entry}).')
                return x, y, entry, True
            logger.warning(f'Cached mesh files in {entry} do not match the forecast '
                           'file: downloading and replacing them.')
        except Exception as e:
            logger.warning(f'Could not read cached mesh in {entry} ({e!r}): '
                           'downloading and replacing it.')

    logger.info(f'Mesh {fingerprint} is not cached yet: downloading it once '
                f'and saving it to {entry}.')
    x, y = download()
    if not (numpy.array_equal(x[idx], samples['x']) and
            numpy.array_equal(y[idx], samples['y'])):
        # Should never happen; means the byte-range samples are wrong.
        logger.error('Mesh fingerprint samples do not match the downloaded '
                     'coordinates: not caching this mesh.')
        return x, y, None, False
    try:
        _save_cache_files(entry, {'x.npy': x, 'y.npy': y}, 'mesh.json', {
            'fingerprint': fingerprint,
            'n_node': n_node,
            'sizes': {d: int(ds.sizes[d]) for d in ds.sizes},
            'created': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'description': ds.attrs.get('description', ''),
        })
    except Exception as e:
        logger.warning(f'Could not save mesh cache to {entry} ({e!r}): continuing without it.')
        return x, y, None, False
    return x, y, entry, False


def _refresh_mesh_cache(ds: xarray.Dataset, entry: pathlib.Path) -> tuple:
    """Re-download x, y and overwrite a cache entry (dropping its LMSL)."""
    logger.info('Downloading mesh node coordinates...')
    x, y = ds['x'].values, ds['y'].values
    try:
        for name in ('lmsl.npy', 'lmsl.json'):
            (entry / name).unlink(missing_ok=True)
        meta = json.loads((entry / 'mesh.json').read_text())
        meta['refreshed'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        _save_cache_files(entry, {'x.npy': x, 'y.npy': y}, 'mesh.json', meta)
        return x, y, entry
    except Exception as e:
        logger.warning(f'Could not refresh mesh cache in {entry} ({e!r}): continuing without it.')
        return x, y, None


def _get_lmsl_for_nodes(node_idx: numpy.ndarray, x: numpy.ndarray, y: numpy.ndarray,
                        cache_entry: pathlib.Path | None) -> numpy.ndarray:
    """LMSL values at the given nodes, from the mesh cache if possible.

    The cached LMSL is only used if it was made from the same LMSL file
    (same path and S3 ETag) for this mesh. When the cache is (re)built,
    the whole LMSL file's node coordinates are checked against the
    forecast mesh.
    """
    s3 = s3fs.S3FileSystem(anon=True)
    lmsl_file = cache_entry / 'lmsl.npy' if cache_entry is not None else None
    lmsl_meta = cache_entry / 'lmsl.json' if cache_entry is not None else None
    etag = None
    if cache_entry is not None:
        try:
            etag = s3.info(f's3://{LMSL_PATH}').get('ETag')
        except Exception as e:
            logger.info(f'Could not check the LMSL file version ({e!r}): not using cached LMSL.')
        if etag and lmsl_file.exists() and lmsl_meta.exists():
            try:
                meta = json.loads(lmsl_meta.read_text())
                lmsl = numpy.load(lmsl_file, mmap_mode='r')
                if (meta.get('path') == LMSL_PATH and meta.get('etag') == etag
                        and len(lmsl) == len(x)):
                    logger.info('Using cached LMSL.')
                    return numpy.asarray(lmsl[node_idx])
                logger.info('Cached LMSL is for a different LMSL file version: replacing it.')
            except Exception as e:
                logger.warning(f'Could not read cached LMSL ({e!r}): replacing it.')

    logger.info('Opening LMSL dataset...')
    ds_lmsl = xarray.open_dataset(s3.open(f's3://{LMSL_PATH}', 'rb'))
    if ds_lmsl.sizes['node'] != len(x):
        raise ValueError(
            f"LMSL file has {ds_lmsl.sizes['node']} nodes but the forecast mesh has "
            f"{len(x)}: the meshes differ, so LMSL cannot be subtracted."
        )

    if cache_entry is not None and etag:
        logger.info('Downloading the global LMSL field once for the mesh cache...')
        lx, ly = ds_lmsl['x'].values, ds_lmsl['y'].values
        if not (numpy.allclose(lx, x) and numpy.allclose(ly, y)):
            raise ValueError('LMSL node coordinates differ from the forecast mesh.')
        lmsl = ds_lmsl['mean_sea_level'].values
        try:
            _save_cache_files(cache_entry, {'lmsl.npy': lmsl}, 'lmsl.json',
                              {'path': LMSL_PATH, 'etag': etag,
                               'created': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        except Exception as e:
            logger.warning(f'Could not save LMSL to the mesh cache ({e!r}).')
        return lmsl[node_idx]

    logger.info('Loading LMSL for nodes in the box...')
    lmsl_sub = ds_lmsl.isel(node=node_idx).load()
    if not (numpy.allclose(lmsl_sub['x'].values, x[node_idx]) and
            numpy.allclose(lmsl_sub['y'].values, y[node_idx])):
        raise ValueError('LMSL node coordinates differ from the forecast mesh.')
    return lmsl_sub['mean_sea_level'].values


def _save_cache_files(entry: pathlib.Path, arrays: dict, meta_name: str, meta: dict) -> None:
    """Save arrays and a metadata file into a cache entry.

    Each file is written to a temporary name and then renamed, and the
    metadata file is written last, so an interrupted run never leaves a
    half-written file under a real name.
    """
    entry.mkdir(parents=True, exist_ok=True)
    for name, arr in arrays.items():
        tmp = entry / f'.{name}.{os.getpid()}.tmp'
        with open(tmp, 'wb') as f:
            numpy.save(f, arr)
        os.replace(tmp, entry / name)
    tmp = entry / f'.{meta_name}.{os.getpid()}.tmp'
    tmp.write_text(json.dumps(meta, indent=2))
    os.replace(tmp, entry / meta_name)


def _load_forecast_xsg(ds: xarray.Dataset, bbox: shapely.box,
                       convert_to_local_msl: bool) -> xarray.Dataset:
    """Subset and load forecast with xarray-subset-grid (original method).

    Can be slow (~5-15 minutes): every chunk of zeta that overlaps the
    box is downloaded in full, for every time step.
    """
    logger.info('Assigning grid topology...')
    ds = xarray_subset_grid.grids.ugrid.assign_ugrid_topology(ds)
    logger.info('Finished assigning grid topology.')

    # Subset to box.
    logger.info('Subsetting...')
    subset_ds = ds.xsg.subset_polygon(shapely.get_coordinates(bbox))
    logger.info('Finished subsetting.')
    logger.info('Loading dataset...')
    logger.info('(This may take some time)')
    subset_ds.load()
    logger.info('Finished loading dataset.')

    # Optionally convert to local mean sea level.
    if convert_to_local_msl:
        lmsl_filename = LMSL_PATH
        logger.info('Opening LMSL dataset...')
        s3 = s3fs.S3FileSystem(anon=True)
        ds_lmsl = xarray.open_dataset(
            s3.open(f's3://{lmsl_filename}', 'rb')
        )
        logger.info('Assigning grid topology...')
        ds_lmsl = xarray_subset_grid.grids.ugrid.assign_ugrid_topology(ds_lmsl)
        logger.info('Subsetting LMSL data...')
        subset_ds_lmsl = ds_lmsl.xsg.subset_polygon(shapely.get_coordinates(bbox))
        logger.info('Loading LMSL data...')
        subset_ds_lmsl.load()
        logger.info('Subtracting LMSL...')
        if subset_ds['zeta'].node.shape == subset_ds_lmsl['mean_sea_level'].node.shape:
            subset_ds['zeta'] = subset_ds['zeta'] - subset_ds_lmsl['mean_sea_level']
        else:
            logger.warning('Cannot subtract STOFS mean sea level: shape mismatch. Attempting manual node matching.')
            if numpy.allclose(ds.y.data, ds_lmsl.y.data) and numpy.allclose(ds.x.data, ds_lmsl.x.data):
                ds = ds.assign_coords(node=('node', range(ds.node.shape[0])))
                subset_inds = ds.xsg.subset_polygon(shapely.get_coordinates(bbox))
                manual_subset_lmsl = ds_lmsl.isel(node=subset_inds['node'].data)
                subset_ds['zeta'] = subset_ds['zeta'] - manual_subset_lmsl['mean_sea_level']
                logger.info('Manual node matching successful. Subtracted LMSL.')
            else:
                logger.error('Manual node matching failed: forecast and LMSL data have different x and y coordinates. Cannot subtract LMSL.')
                raise ValueError('Manual node matching failed: forecast and LMSL data have different x and y coordinates. Cannot subtract LMSL.')



    logger.info('Renaming x and y coordinates to match thalassa.')
    return subset_ds.rename({'x':'lon', 'y':'lat'})


def get_nearest_inds_dists(
    ds_mesh: xarray.Dataset, 
    df_stations: pandas.DataFrame,
    n_nearest: int = 10,
    ds_x_var: str = 'x', 
    ds_y_var: str = 'y',
    df_x_var:str = 'longitude', 
    df_y_var: str = 'latitude'
) -> tuple[xarray.DataArray, xarray.DataArray]:
    """Get indices and distances to nearest points in dataset.

    If the "station" data frame only has 1 station, might need to use
        df_stations.loc[0].to_frame().transpose()
    or
        df_stations.loc[0:0]
    to get the right format.

    Parameters
    ----------
    ds_mesh 
        Contains the forecast data on original mesh.
    df_stations
        Contains the stations to locate.
    n_nearest
        The number of nearest mesh points to a station to return.
    ds_x_var 
        The name of the x/longitude variable in the mesh dataset.
    ds_y_var
        The name of the y/latitude variable in the mesh dataset.
    df_x_var 
        The name of the x/longitude variable in the station dataframe.
    df_y_var
        The name of the y/latitude variable in the station dataframe.
        
    Returns
    -------
    Tuple of two datasets containing (1) the indices and (2) the distances
    to the station, of the nearest mesh nodes. Each of these two datasets 
    is 2D, with having dimensions (station, k), where k denotes the position
    in the sequence from 0 to (n_nearest - 1) of proximity to the station.
    
    """
    tree = scipy.spatial.cKDTree(
        numpy.column_stack((ds_mesh[ds_x_var].data,
                            ds_mesh[ds_y_var].data))
    )
    dists, inds = tree.query(
        tuple(zip(df_stations[df_x_var], df_stations[df_y_var])), 
        k=n_nearest
    )
    # Make sure that outputs are 2-dimensional (station, k), 
    # even if some dimensions are length 1.
    if n_nearest == 1:
        dists  = numpy.expand_dims(dists, axis=1)
        inds  = numpy.expand_dims(inds, axis=1)
    return xarray.DataArray(inds, dims=["station", "k"]), \
        xarray.DataArray(dists, dims=["station", "k"])


def ds_add_datum(ds: xarray.Dataset,
                 target_datum: str,
                 base_datum: str = 'lmsl',
                 incl_time_axis: bool = False,
                 ds_y_name: str = 'lat',
                 ds_x_name: str = 'lon') -> xarray.Dataset:
    """Adds datum field to a STOFS dataset, relative to base_datum. 

    Parameters
    ----------
    ds
        The dataset to add a datum field to.
    target_datum
        The target datum to add, e.g., mllw.
    base_datum
        The datum relative to which target_datum values are expressed.
    incl_time_axis
        Whether to include time in the dimensionality of the return value.
        If True, the datum added will have dimensions (node, time).
        If False, the datum added will have dimensions (node).
    ds_y_name
        The name of the y/latitude variable in the mesh dataset.
    ds_x_name
        The name of the x/longitude variable in the mesh dataset.
    
    Returns
    -------
    A dataset that is the same as input ds, with an added field 
    representing the field target_datum=0 relative to base_datum.
    
    """
    # Array of zeros to represent base datum.
    z_dummy = numpy.zeros_like(ds[ds_y_name].data)
    
    # Convert to target (positive means below base).
    x, y, z_new = vdatum.convert(base_datum.lower(), target_datum.lower(), 
                                 ds[ds_y_name].data, ds[ds_x_name].data, z_dummy,
                                 online=True, epoch=None)
    
    # Deal with missing values and convert to height instead of depth.
    # This makes MHW (> LMSL) positive and MLLW (< LMSL) negative.
    z_ll = -1.0 * numpy.where(~numpy.isinf(z_new), z_new, numpy.nan)
    
    # Add to copy of dataset.
    # Use the spatial dimension(s) of the latitude variable rather than
    # assuming 'node': after selecting nearest nodes for image points
    # (ds.sel(node=inds)), the spatial dimension is 'station'. Hardcoding
    # 'node' there made the new datum broadcast against the existing
    # variables into a 2D (station, node) array.
    spatial_dims = list(ds[ds_y_name].dims)
    ds_out = ds.copy()
    new_var_name = '_'.join([target_datum, 'minus', base_datum])
    if incl_time_axis:
        ds_out[new_var_name] = xarray.DataArray(
            numpy.tile(z_ll, (len(ds.time),) + (1,) * z_ll.ndim),
            dims=['time'] + spatial_dims
        )
        return ds_out
    else:
        ds_out[new_var_name] = xarray.DataArray(z_ll, dims=spatial_dims)
        return ds_out


def ds_add_tidal_range(ds: xarray.Dataset,
                       incl_time_axis: bool = False,
                       ds_y_name: str = 'lat',
                       ds_x_name: str = 'lon') -> xarray.Dataset:
    """Adds tidal mean range field to a STOFS dataset.

    Parameters
    ----------
    ds
        The dataset to add a datum field to.
    incl_time_axis
        Whether to include time in the dimensionality of the return value.
        If True, the datum added will have dimensions (node, time).
        If False, the datum added will have dimensions (node).
    ds_y_name
        The name of the y/latitude variable in the mesh dataset.
    ds_x_name
        The name of the x/longitude variable in the mesh dataset.
    
    Returns
    -------
    A dataset that is the same as input ds, with an added field 
    ("mean_range") representing tidal range, i.e., (MHW - MLW)
    for most cases, or (MHW - MLLW) for the West Coast and Alaska.
    
    """
    ds_out = ds.copy()
    # Check if we need the west coast/Alaska range (MHW - MLLW)
    # or the default range (MHW - MLW).
    # For now we'll just do this assuming the entire dataset is either 
    # west coast/Alaska or not, but in the future we could make this 
    # spatially specific if needed.
    lons_m180_180 = switch_lon_lims(ds_out[ds_x_name].data, min_lon=-180.0)
    lats = ds_out[ds_y_name].data
    wcak_min_lon = -180.0
    wcak_max_lon = -110.0
    wcak_min_lat = 30.0
    wcak_max_lat = 76.0
    in_wcak = (
        (lons_m180_180 >= wcak_min_lon) & 
        (lons_m180_180 <= wcak_max_lon) & \
        (lats >= wcak_min_lat) & 
        (lats <= wcak_max_lat)
    )
    if numpy.all(in_wcak):
        logger.info('Dataset is entirely in the West Coast/Alaska region. Using range (MHW - MLLW).')
        use_wcak_range = True
    elif numpy.all(~in_wcak):
        logger.info('Dataset is entirely outside of the West Coast/Alaska region. Using default range (MHW - MLW).')
        use_wcak_range = False
    else:
        logger.error('Dataset contains some points in the West Coast/Alaska region and some points outside of it.')
        raise NotImplementedError('Cannot handle datasets that contain some points in the West Coast/Alaska region and some points outside of it. Please check the inputs or subset the data so that it is either entirely in or entirely out of the West Coast/Alaska region.')
    # Make sure we have the required variables.
    if use_wcak_range:
        range_lower_var = 'mllw_minus_lmsl'
        range_lower_datum = 'mllw'
    else:
        range_lower_var = 'mlw_minus_lmsl'
        range_lower_datum = 'mlw'
    if range_lower_var not in ds.data_vars:
        ds_out = ds_add_datum(ds, range_lower_datum, incl_time_axis=incl_time_axis, 
                              ds_y_name=ds_y_name, ds_x_name=ds_x_name)
    if 'mhw_minus_lmsl' not in ds.data_vars:
        ds_out = ds_add_datum(ds_out, 'mhw', incl_time_axis=incl_time_axis, 
                              ds_y_name=ds_y_name, ds_x_name=ds_x_name)
    # Calculate the range.
    ds_out['mean_range'] = ds_out['mhw_minus_lmsl'] - ds_out[range_lower_var]
    return ds_out


def tidal_tol_from_range(ds: xarray.Dataset,
                         range_var: str = 'mean_range') -> xarray.Dataset:
    """Calculate tolerance of water level for a given tidal range. 

    Tolerance is defined as the maximum allowable difference between water  
    level at the time of imaging and the datum level being surveyed. 
    
    The tolerance is calculated according to the 2014 NGS Memo.

    Parameters
    ----------
    ds
        Dataset containing at least a variable representing mean 
        tidal range.
    range_var
        The name of the variable in ds representing mean tidal range.
    
    Returns
    -------
    A dataset that is the same as input ds, with an added field 
    ("tolerance") representing the water level tolerance for each 
    location in the dataset. 
    
    """
    if range_var not in ds.data_vars:
        sys.exit('tidal_tol_from_range: range variable (default: mean_range) required to calculate tolerances.')
    # Tolerance calculation from memorandum of November 24, 2014. 
    ft_to_meters = 0.3048
    tol_thresh = 5.0 * ft_to_meters
    tol_fraction = 0.1
    tol_minimum = 0.5 * ft_to_meters
    tol = (tol_fraction * ds[range_var]).where(ds[range_var] > tol_thresh,
                                               other=tol_minimum, 
                                               drop=False)
    return ds.assign(tolerance=tol)
    