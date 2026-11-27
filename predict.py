"""The main function for flight planning with STOFS forecast water levels.

And also its command line argument parser.

Usage will usually be from the command line, so the functions
listed here are not often called directly.

Functions
---------
main
ngs_arg_parser

"""


import logging
import argparse
import pathlib
import geopandas as gpd
import pandas as pd
import numpy as np
import xarray as xr
import datetime
import pytz
import shapely
import pvlib
#
import inputs 
import processing  
import mesh_handling
import outputs


logging.basicConfig(
    level=logging.INFO, 
    format='%(asctime)s %(name)-15s %(levelname)-8s %(message)s', 
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)
# Logging strategy:
# It's helpful to know how long some of the heavy calculations take
# so they are added at "info" level. Basic signposting for other
# parts of the process are at the "debug" level.


def main(
    project_name: str,
    lines_file: str,
    init_datetime: datetime.datetime,
    datums: list,
    output_dir: pathlib.Path | str,
    min_solar_elevation: float,
    output_time_zone: str,
    every_nth_point: int,
    mesh_cache: bool | str | pathlib.Path = True
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Run NGS flight planning data processing on STOFS forecast data.

    If successfully executed, this results in a number of output files
    being written to a subdirectory of output_dir.

    Parameters
    ----------
    project_name
        Name of project, used to define the output directory and filenames.
    lines_file
        The path and name of the file defining the flight lines.
    init_datetime
        The initialization time and date of the STOFS forecast to use.
    datums
        List of the datums to process and output time windows for.
    output_dir
        The directory in which to create the output data subdirectory.
        The final names and locations of output files are:
        <output_dir>/<project_name>/<project_name>_<datums>_<init_datetime>.<ext>
        where <ext> represents the file type extension (e.g., txt).
    min_solar_elevation
        The minimum solar elevation that is considered to meet requirements
        for valid imagery to be captured.
    output_time_zone
        The time zone of time stamps given in the output files.
        Not currently implemented.
    every_nth_point
        Specification of which image points to use when calculating the time
        windows for a line.
        0 = first and last only;
        1 = every point;
        N (integer) = every Nth point.
    mesh_cache
        Where to cache STOFS mesh coordinates and LMSL between runs:
        True for the default location, a directory path, or False to
        disable. See mesh_handling.load_forecast_ds.

    Returns
    -------
    pandas DataFrame
        Data frame of time windows by image point.
    pandas DataFrame
        Data frame of time windows by flight line.
    
    """
    logger.info(f'Processing data for project {project_name}')
    logger.info(f'Flight lines file: {lines_file}')
    logger.info(f"Forecast data used from {init_datetime.strftime('%Y-%m-%d %HUTC')} model run")
    logger.info(f"Datums requested: {', '.join(datums)}")
    if output_time_zone not in pytz.all_timezones:
        logger.warning('Specified output_time_zone not available in pytz: defaulting to UTC.')
        output_time_zone = 'UTC'
    logger.info(f'Output timezone: {output_time_zone}')

    # Get (and create, if needed) output directory.
    save_dir = outputs.get_create_output_dir(output_dir, project_name)
    logger.info(f'Output will be saved to: {str(save_dir)}')

    # Read flight paths and calculate image points. 
    logger.debug('Reading flight paths and calculating image points...')
    df_lines = inputs.load_lines_gdf(lines_file)
    df_points = processing.point_table_from_lines(df_lines)
    
    # Load and subset forecast and datum data.
    logger.info('Loading forecast subset...')
    bbox = mesh_handling.get_box(df_lines)    
    ds_mesh = mesh_handling.load_forecast_ds(
        init_datetime, bbox, convert_to_local_msl=True, mesh_cache=mesh_cache
    )
    logger.info('Finished loading forecast subset.')
    # Mesh triangles (for the results viewer's mesh view) travel with the
    # forecast subset; set them aside so they don't enter the calculations.
    mesh_tri = ds_mesh['mesh_tri'].values if 'mesh_tri' in ds_mesh else None
    ds_mesh = ds_mesh.drop_vars([v for v in ('mesh_tri', 'global_node') if v in ds_mesh.variables])
    
    logger.info('Adding datums...')
    # Get list of datums to add.
    # We want all in `datums`, except BMHW, plus MHW, MLW and MLLW to calculate
    # range (MHW - MLW, or MHW - MLLW for West Coast/Alaska). Adding them here,
    # on the full mesh, means ds_add_tidal_range never has to add one later.
    datums_to_add = [d for d in datums if d != 'bmhw']
    for datum in list(set(datums_to_add + ['mhw', 'mlw', 'mllw'])):
        ds_mesh = mesh_handling.ds_add_datum(ds_mesh, datum)
    logger.info('Finished adding datums...')
    ds_mesh_levels = ds_mesh   # water levels and datums at every mesh node, for the mesh view
    
    logger.info('Dropping NaN data...')
    # For window calculations, we need a time series with no missing data,
    # and valid datum values, so we exclude model points that don't meet 
    # that criterium.
    # zeta gives the water level; 
    # mhw_minus_lmsl gives the datum values, and is guaranteed to be present
    # because it's hardcoded above.
    ds_drop = ds_mesh.dropna('node', how='any', subset=['mhw_minus_lmsl', 'zeta'])
    ds_drop_zeta = ds_mesh.dropna('node', how='any', subset=['zeta'])
    logger.info(f'Number of nodes: full subset {len(ds_mesh.node)}; ' + 
                f'NaN in zeta {len(ds_drop_zeta.node)}; ' + 
                f'NaN in zeta or datum {len(ds_drop.node)}.')
    
    logger.debug('Calculating nearest nodes to image positions...')
    # Using only model nodes with no missing data, as described above. 
    inds, dists = mesh_handling.get_nearest_inds_dists(
        ds_drop,
        df_points,
        n_nearest=1,
        ds_x_var='lon', 
        ds_y_var='lat',
        df_x_var='LON',
        df_y_var='LAT'
    )
    
    logger.debug('Subsetting to nearest nodes...')
    # Note that the lat and lon values in this dataset 
    # are now the model node locations, not the image 
    # point locations. 
    ds_points_model_timeseries = ds_drop.sel(node=inds).isel(k=0)
    
    logger.debug('Calculating tidal range and tolerance...')
    # Range = MHW - MLW (MHW - MLLW for West Coast/Alaska).
    # Tolerance based on 2014 NGS/RSD memo.
    ds_points_model_timeseries = mesh_handling.ds_add_tidal_range(
        ds_points_model_timeseries
    )
    ds_points_model_timeseries = mesh_handling.tidal_tol_from_range(
        ds_points_model_timeseries
    )
    
    logger.debug('Interpolating along time axis...')
    ds_interp = processing.interp_time(ds_points_model_timeseries)
    
    logger.debug('Converting to pandas data frame...')
    # Renames the model node lat and lon columns, both for clarity
    # and to avoid conflicts when joining with the image location
    # lat and lon.
    df_interp = ds_interp[[v for v in ds_interp.data_vars if 'station' in ds_interp[v].dims]]\
                .to_dataframe(dim_order=['station', 'time'])\
                .rename(columns={'lat':'node_lat', 'lon':'node_lon'})
    # Times so far are in UTC: add this explicitly.
    df_interp = df_interp.tz_localize('UTC', level='time')
    
    logger.info('Calculating solar elevation angles...')
    df_interp = processing.calc_sun_alt(df_interp)
    logger.info('Finished calculating solar elevation angles.')
    
    logger.debug('Calculating times when water level in range...')
    df_interp = processing.calc_in_range(
        df_interp, datums, min_solar_elevation=min_solar_elevation
    )
    
    logger.info('Calculating windows by point...')
    df_point_windows = processing.point_windows_from_bool(df_interp, datums)
    
    # Add line column and reorder.
    df_point_windows = df_point_windows.join(df_points.LINE, on='station')\
                                       .rename(columns={'LINE':'line'})
    df_point_windows = df_point_windows[['station', 'node_lat', 'node_lon', 
                                         'line', 'datum',
                                         'start_time', 'end_time']]
    logger.info('Finished calculating windows by point.')
    
    logger.info('Calculating windows by line...')
    # This is actually done by going back to the boolean time series,
    # rather than calculating line windows from point windows.
    df_line_windows = processing.line_windows_from_bool(
        df_interp, df_points, datums, point_step=every_nth_point
    )
    logger.info('Finished calculating windows by line.')

    # Explain any datums with no windows at all, so it's clear to the
    # user why (sun too low, water never in range, or no line-wide overlap).
    notes = processing.explain_missing_windows(
        df_interp, df_point_windows, df_line_windows, datums,
        min_solar_elevation, point_step=every_nth_point
    )
    for note in notes:
        logger.warning(note)

    logger.warning(f'Converting times to {output_time_zone}...')
    logger.warning('ATTENTION: Take care when using time information in GIS software. Geopackage (.gpkg) files may contain timezone information, but shapefiles (.shp) do not.')
    logger.debug('Before conversion:')
    logger.debug(df_line_windows)
    logger.debug(df_point_windows)
    df_line_windows.start_time = df_line_windows.start_time.dt.tz_convert(output_time_zone)
    df_line_windows.end_time = df_line_windows.end_time.dt.tz_convert(output_time_zone)
    df_point_windows.start_time = df_point_windows.start_time.dt.tz_convert(output_time_zone)
    df_point_windows.end_time = df_point_windows.end_time.dt.tz_convert(output_time_zone)
    logger.debug('After conversion:')
    logger.debug(df_line_windows)
    logger.debug(df_point_windows)
    
    logger.info('Writing outputs...')
    outputs.output_all_prediction(df_lines, df_line_windows, 
                                  df_points, df_point_windows, 
                                  project_name, datums, init_datetime,
                                  save_dir, notes=notes)
    # Data file for the results viewer (viewer/index.html). A failure here
    # must not lose the main outputs, which are already written.
    try:
        outputs.gui_json_prediction(
            df_lines, df_points, ds_points_model_timeseries,
            df_line_windows, df_point_windows, project_name, datums,
            init_datetime, bbox, min_solar_elevation, every_nth_point,
            output_time_zone, notes, save_dir
        )
    except Exception as e:
        logger.error(f'Could not write results viewer data: {e}', exc_info=True)
    try:
        outputs.mesh_levels_prediction(ds_mesh_levels, mesh_tri, datums, project_name,
                                       init_datetime, save_dir)
    except Exception as e:
        logger.error(f'Could not write mesh water levels for the viewer: {e}', exc_info=True)
    return df_point_windows, df_line_windows


def ngs_arg_parser():
    """Return arg parser for main NGS data processing function."""
    parser = argparse.ArgumentParser()
    parser.add_argument("project", type=str,
                        help="Name of project, used in naming output files.")
    parser.add_argument("flight_line_filepath", type=str,
                        help="Path and name of file defining flight lines to analyze. Can be a relative or absolute path.")
    parser.add_argument("forecast_init_datetime", type=str,
                        help="The initialization date & time of the forecast run to be used. Formatted yyyy-mm-ddT12:00, e.g., 2024-12-15T06:00")
    parser.add_argument('-d', '--datums', nargs='+', 
                        default=['mllw', 'mhw'],
                        help="Space separated list of datums to process, e.g., '-d mllw mlw mhw' (default: %(default)s)")
    parser.add_argument('-o', '--output_directory', 
                        default=pathlib.Path('./data').resolve(), 
                        help="Directory within which to create the project's saved data directory (default: %(default)s)")
    parser.add_argument('-e', '--min_solar_elevation', type=float, 
                        default=25.0,
                        help="Minimum solar elevation required for imaging time selection (default: %(default)s)")
    parser.add_argument('-z', '--output_time_zone', type=str, 
                        default='UTC',
                        help="The timezone to convert output times to, e.g., 'UTC', 'US/Eastern', 'US/Alaska'. This must be one of the timezones available in `pytz`. See https://en.wikipedia.org/wiki/List_of_tz_database_time_zones for more options. (default: %(default)s)")
    parser.add_argument('-n', '--every_nth_point', type=int, 
                        default=1,
                        help="The number of points to use when calculating a line's time window (default: %(default)s). '0' means only use the end points. '1' means use every point. Integer N means use every Nth point.")
    parser.add_argument('--mesh-cache-dir', type=str, default=None,
                        help="Directory for caching STOFS mesh coordinates and LMSL between runs (default: $NGS_MESH_CACHE_DIR, or ~/.cache/ngs-flight-planning/meshes). Each STOFS mesh is fingerprinted and cached separately.")
    parser.add_argument('--no-mesh-cache', action='store_true',
                        help="Do not read or write the mesh cache.")
    parser.add_argument('-l', '--logging-level', type=str,
                        default='INFO',
                        help="Logging level passed to program logger ( one of ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'] default: %(default)s)")
    #
    return parser

if __name__ == '__main__':
    # Set up command line argument parser.
    parser = ngs_arg_parser()
    args = parser.parse_args()
    logger.setLevel(level=args.logging_level)
    # Run the main script.
    df_point_windows, df_line_windows = main(
        args.project,
        pathlib.Path(args.flight_line_filepath).resolve(),
        datetime.datetime.fromisoformat(args.forecast_init_datetime),
        args.datums,
        pathlib.Path(args.output_directory).resolve(),
        args.min_solar_elevation,
        args.output_time_zone,
        args.every_nth_point,
        False if args.no_mesh_cache else (args.mesh_cache_dir or True)
    )