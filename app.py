"""Local web app for NGS flight planning: start a run and see the results.

Usage (from the repository folder, in the project's Python environment):

    python app.py

This opens the app in your web browser. Pick a flight-lines file and a
STOFS forecast, press Run, and the map, timeline and charts appear when
the run finishes. Past runs are listed in the app and kept in ./runs/.

Options:
    --port N        Port to use (default 8050, or the next free one).
    --no-browser    Do not open a browser window automatically.

Only the Python standard library is used here; each run calls predict.py
in a separate process with the same Python interpreter, so the outputs
are exactly the same as running predict.py from the command line.
"""

import argparse
import concurrent.futures
import csv
import datetime
import io
import json
import mimetypes
import os
import pathlib
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(REPO))
from utils import hdms_to_dd  # noqa: E402  (same conversion predict.py uses)
VIEWER = REPO / 'viewer'
DATA = REPO / 'data'
RUNS = REPO / 'runs'
STOFS_BUCKET_URL = 'https://noaa-gestofs-pds.s3.amazonaws.com'
REQUIRED_COLUMNS = {'LINE', 'LAT1', 'LON1', 'LAT2', 'LON2', 'PHOTOS'}
DATUMS = ['mllw', 'mlw', 'mhw', 'mhhw', 'bmhw']
MAX_UPLOAD_BYTES = 2_000_000

# Progress stages, matched against predict.py's log lines (first match wins).
STAGES = [
    ('Reading flight lines', ('Processing data for project',)),
    ('Opening the forecast', ('Loading forecast subset',)),
    ('Checking the model mesh', ('node coordinates', 'cached mesh', 'Mesh cache', 'is not cached yet')),
    ('Downloading water levels', ('Loading water levels', 'Loading dataset')),
    ('Local mean sea level', ('LMSL',)),
    ('Tidal datums', ('Adding datums',)),
    ('Sun angles', ('Calculating solar elevation',)),
    ('Finding time windows', ('Calculating windows by point',)),
    ('Writing outputs', ('Writing outputs',)),
]

_runs_lock = threading.Lock()
_procs = {}            # run id -> subprocess.Popen
_forecast_cache = {'time': 0, 'value': None}


# --------------------------------------------------------------------- helpers
def check_lines_text(text: str) -> tuple[bool, str, int]:
    """Check that text is a flight-lines CSV. Returns (ok, message, n_lines)."""
    try:
        reader = csv.DictReader(io.StringIO(text))
        cols = {c.strip() for c in (reader.fieldnames or [])}
        missing = REQUIRED_COLUMNS - cols
        if missing:
            return False, f"Not a flight-lines file: missing column(s) {', '.join(sorted(missing))}.", 0
        n = sum(1 for _ in reader)
        if n == 0:
            return False, 'The file has no flight lines.', 0
        return True, f'{n} flight lines', n
    except Exception as e:
        return False, f'Could not read the file as CSV: {e}', 0


def lines_geometry(text: str) -> dict:
    """Flight lines from a flight-lines file, as decimal-degree coordinates."""
    lines, bad = [], 0
    for row in csv.DictReader(io.StringIO(text)):
        row = {k.strip(): (v or '').strip() for k, v in row.items() if k}
        try:
            coords = [[hdms_to_dd(row['LON1']), hdms_to_dd(row['LAT1'])],
                      [hdms_to_dd(row['LON2']), hdms_to_dd(row['LAT2'])]]
            lines.append({'line': row['LINE'], 'photos': int(float(row['PHOTOS'])), 'coords': coords,
                          'attrs': row})
        except (KeyError, ValueError):
            bad += 1
    return {'lines': lines, 'unreadable_rows': bad}


def list_line_files() -> list[dict]:
    """Flight-line files in data/ (any .wpt or .txt with the right columns)."""
    out = []
    for p in sorted(DATA.glob('*')):
        if p.suffix.lower() not in ('.wpt', '.txt', '.csv') or not p.is_file():
            continue
        try:
            ok, msg, n = check_lines_text(p.read_text(errors='replace'))
        except OSError:
            continue
        if ok:
            out.append({'name': p.name, 'lines': n, 'project': default_project(p.name)})
    return out


def default_project(filename: str) -> str:
    """Project name from a file name, e.g. AK2507-CS-N.txt -> AK2507-CS-N."""
    return re.sub(r'[^A-Za-z0-9_-]+', '_', pathlib.Path(filename).stem) or 'project'


def list_forecasts(days: int = 4) -> dict:
    """STOFS-2D-Global forecast cycles available on NOAA's S3, newest first."""
    if _forecast_cache['value'] and time.time() - _forecast_cache['time'] < 600:
        return _forecast_cache['value']
    today = datetime.datetime.now(datetime.timezone.utc).date()
    cycles = [(today - datetime.timedelta(days=d), hh) for d in range(days) for hh in (18, 12, 6, 0)]

    def exists(cycle):
        date, hh = cycle
        ymd = date.strftime('%Y%m%d')
        key = f'stofs_2d_glo.{ymd}/stofs_2d_glo.t{hh:02d}z.fields.cwl.nc'
        url = f'{STOFS_BUCKET_URL}/?list-type=2&max-keys=1&prefix={urllib.parse.quote(key)}'
        with urllib.request.urlopen(url, timeout=15) as r:
            return f'<Key>{key}</Key>' in r.read().decode()

    try:
        with concurrent.futures.ThreadPoolExecutor(16) as pool:
            found = list(pool.map(exists, cycles))
    except Exception as e:
        return {'forecasts': [], 'error': f"Could not reach NOAA's forecast archive ({e}). Check the internet connection."}
    value = {'forecasts': [f'{d.isoformat()}T{hh:02d}:00' for (d, hh), ok in zip(cycles, found) if ok],
             'error': None}
    _forecast_cache.update(time=time.time(), value=value)
    return value


def run_dir(run_id: str) -> pathlib.Path:
    if not re.fullmatch(r'[A-Za-z0-9_.-]+', run_id):
        raise ValueError('bad run id')
    return RUNS / run_id


def read_run(run_id: str) -> dict:
    return json.loads((run_dir(run_id) / 'run.json').read_text())


def write_run(run_id: str, info: dict) -> None:
    p = run_dir(run_id) / 'run.json'
    tmp = p.with_suffix('.tmp')
    tmp.write_text(json.dumps(info, indent=2))
    os.replace(tmp, p)


def stage_of(log_text: str) -> int:
    """Index of the latest progress stage reached, from the log so far."""
    idx = -1
    for line in log_text.splitlines():
        for i, (_, markers) in enumerate(STAGES):
            if i > idx and any(m in line for m in markers):
                idx = i
    return idx


def list_runs() -> list[dict]:
    out = []
    for p in sorted(RUNS.glob('*/run.json'), reverse=True):
        try:
            out.append(json.loads(p.read_text()))
        except Exception:
            continue
    return out


def mark_interrupted_runs() -> None:
    """Runs left 'running' by a previous app session cannot still be running."""
    for info in list_runs():
        if info.get('status') == 'running':
            info.update(status='failed', error='The app was closed while this run was in progress.')
            write_run(info['id'], info)


# --------------------------------------------------------------------- runs
def start_run(req: dict) -> dict:
    with _runs_lock:
        if any(p.poll() is None for p in _procs.values()):
            raise ValueError('A run is already in progress. Wait for it to finish or cancel it.')

        # Flight lines: a file from data/, or uploaded text.
        if req.get('upload_text') is not None:
            text = req['upload_text']
            if len(text.encode()) > MAX_UPLOAD_BYTES:
                raise ValueError('The uploaded file is too large for a flight-lines file.')
            name = pathlib.Path(req.get('upload_name') or 'lines.wpt').name
        else:
            name = pathlib.Path(req.get('lines_file') or '').name
            src = DATA / name
            if not name or not src.is_file():
                raise ValueError('Choose a flight-lines file.')
            text = src.read_text(errors='replace')
        ok, msg, _ = check_lines_text(text)
        if not ok:
            raise ValueError(msg)

        project = default_project(req.get('project') or name)
        forecast = req.get('forecast') or ''
        try:
            datetime.datetime.fromisoformat(forecast)
        except ValueError:
            raise ValueError('Choose a forecast.')
        datums = [d for d in req.get('datums', []) if d in DATUMS]
        if not datums:
            raise ValueError('Choose at least one datum.')
        min_sun = float(req.get('min_sun', 25))
        nth = int(req.get('every_nth_point', 1))
        tz = str(req.get('time_zone') or 'UTC')

        run_id = f"{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}_{project}"
        d = run_dir(run_id)
        d.mkdir(parents=True)
        lines_path = d / re.sub(r'[^A-Za-z0-9_.-]+', '_', name)
        lines_path.write_text(text)

        cmd = [sys.executable, str(REPO / 'predict.py'), project, str(lines_path), forecast,
               '-d', *datums, '-o', str(d / 'output'), '-e', str(min_sun),
               '-z', tz, '-n', str(nth), '-l', 'INFO']
        info = {
            'id': run_id, 'status': 'running', 'project': project, 'lines_file': name,
            'forecast': forecast, 'datums': datums, 'min_sun': min_sun,
            'every_nth_point': nth, 'time_zone': tz,
            'started': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
            'finished': None, 'gui': None, 'error': None,
        }
        write_run(run_id, info)
        log = open(d / 'log.txt', 'w')
        env = dict(os.environ, PYTHONUNBUFFERED='1')
        proc = subprocess.Popen(cmd, cwd=REPO, stdout=log, stderr=subprocess.STDOUT, env=env,
                                start_new_session=True)
        _procs[run_id] = proc
        threading.Thread(target=_watch, args=(run_id, proc, log), daemon=True).start()
        return info


def _watch(run_id: str, proc: subprocess.Popen, log) -> None:
    code = proc.wait()
    log.close()
    d = run_dir(run_id)
    info = read_run(run_id)
    gui = sorted(d.glob('output/*/*.gui.json'))
    info['finished'] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
    if info.get('status') == 'cancelled':
        pass
    elif code == 0 and gui:
        info.update(status='done', gui=str(gui[0].relative_to(d)))
    else:
        log_text = (d / 'log.txt').read_text(errors='replace')
        errs = [l for l in log_text.splitlines() if 'ERROR' in l or 'Error' in l]
        info.update(status='failed',
                    error=(errs[-1] if errs else f'predict.py stopped with exit code {code}.'))
    write_run(run_id, info)


def cancel_run(run_id: str) -> dict:
    proc = _procs.get(run_id)
    info = read_run(run_id)
    if proc and proc.poll() is None:
        info.update(status='cancelled', error='Cancelled.')
        write_run(run_id, info)
        os.killpg(proc.pid, signal.SIGTERM)
    return info


def run_status(run_id: str) -> dict:
    info = read_run(run_id)
    log_path = run_dir(run_id) / 'log.txt'
    log_text = log_path.read_text(errors='replace') if log_path.exists() else ''
    info['stage'] = stage_of(log_text)
    info['stages'] = [s for s, _ in STAGES]
    info['log_tail'] = '\n'.join(log_text.splitlines()[-40:])
    return info


# --------------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = 'NGSFlightPlanning/1'

    def log_message(self, fmt, *args):   # keep the terminal quiet
        pass

    def send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path: pathlib.Path):
        if not path.is_file():
            return self.send_json({'error': 'not found'}, HTTPStatus.NOT_FOUND)
        body = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header('Content-Type', mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == '/api/info':
                return self.send_json({'app': True, 'datums': DATUMS})
            if path == '/api/linefiles':
                return self.send_json({'files': list_line_files()})
            m = re.fullmatch(r'/api/linefiles/([^/]+)', path)
            if m:
                src = DATA / pathlib.Path(urllib.parse.unquote(m.group(1))).name
                if not src.is_file():
                    return self.send_json({'error': 'not found'}, HTTPStatus.NOT_FOUND)
                return self.send_json(lines_geometry(src.read_text(errors='replace')))
            if path == '/api/forecasts':
                return self.send_json(list_forecasts())
            if path == '/api/runs':
                return self.send_json({'runs': list_runs()})
            m = re.fullmatch(r'/api/runs/([^/]+)', path)
            if m:
                return self.send_json(run_status(m.group(1)))
            m = re.fullmatch(r'/api/runs/([^/]+)/mesh', path)
            if m:
                files = sorted(run_dir(m.group(1)).glob('output/*/*.mesh.bin'))
                if not files:
                    return self.send_json({'error': 'This run has no mesh water levels (run it again to add them).'}, HTTPStatus.NOT_FOUND)
                return self.send_file(files[0])
            m = re.fullmatch(r'/api/runs/([^/]+)/gui', path)
            if m:
                info = read_run(m.group(1))
                if not info.get('gui'):
                    return self.send_json({'error': 'This run has no results.'}, HTTPStatus.NOT_FOUND)
                return self.send_file(run_dir(m.group(1)) / info['gui'])
            # Static files from viewer/.
            rel = path.lstrip('/') or 'index.html'
            target = (VIEWER / rel).resolve()
            if VIEWER.resolve() not in target.parents and target != VIEWER.resolve():
                return self.send_json({'error': 'not found'}, HTTPStatus.NOT_FOUND)
            if target.is_dir():
                target = target / 'index.html'
            return self.send_file(target)
        except FileNotFoundError:
            return self.send_json({'error': 'not found'}, HTTPStatus.NOT_FOUND)
        except Exception as e:
            return self.send_json({'error': str(e)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            n = int(self.headers.get('Content-Length') or 0)
            if n > MAX_UPLOAD_BYTES * 2:
                return self.send_json({'error': 'Request too large.'}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            req = json.loads(self.rfile.read(n) or b'{}')
            if path == '/api/runs':
                return self.send_json(start_run(req))
            if path == '/api/check-lines':
                ok, msg, nl = check_lines_text(req.get('text', ''))
                geo = lines_geometry(req.get('text', '')) if ok else {'lines': []}
                return self.send_json({'ok': ok, 'message': msg, 'lines': nl, 'geometry': geo})
            m = re.fullmatch(r'/api/runs/([^/]+)/cancel', path)
            if m:
                return self.send_json(cancel_run(m.group(1)))
            return self.send_json({'error': 'not found'}, HTTPStatus.NOT_FOUND)
        except ValueError as e:
            return self.send_json({'error': str(e)}, HTTPStatus.BAD_REQUEST)
        except Exception as e:
            return self.send_json({'error': str(e)}, HTTPStatus.INTERNAL_SERVER_ERROR)


def free_port(start: int) -> int:
    for port in range(start, start + 50):
        with socket.socket() as s:
            try:
                s.bind(('127.0.0.1', port))
                return port
            except OSError:
                continue
    raise SystemExit(f'No free port found from {start}.')


def main():
    parser = argparse.ArgumentParser(description='NGS flight planning app (local web interface).')
    parser.add_argument('--port', type=int, default=8050, help='Port (default: 8050, or the next free one).')
    parser.add_argument('--no-browser', action='store_true', help='Do not open a browser window.')
    args = parser.parse_args()
    RUNS.mkdir(exist_ok=True)
    mark_interrupted_runs()
    port = free_port(args.port)
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    url = f'http://localhost:{port}/'
    print(f'NGS flight planning app running at {url}', flush=True)
    print('Press Ctrl+C to stop.', flush=True)
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopping.')
        for p in _procs.values():
            if p.poll() is None:
                os.killpg(p.pid, signal.SIGTERM)


if __name__ == '__main__':
    main()
