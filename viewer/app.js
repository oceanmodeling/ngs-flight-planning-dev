/* NGS flight planning – map page.
 *
 * Results:
 *   plans  flight plans that fly the lines inside their windows (planner.js):
 *          a recommended plan and alternates, each as flights with an order
 *          of lines, drawn on the map (colour = flight, number = order)
 *   photo  click a photo point to see a simulated photo at the time it would
 *          be taken in the plan, with lighting and sun glint (photo.js)
 *   lines  every line with its windows and where it sits in the plan
 * Served by app.py, the page also has a "New run" tab: run form, progress,
 * past runs, and a map preview of the chosen flight-lines file.
 * No build step: deck.gl and MapLibre are loaded from a CDN in index.html.
 */
'use strict';

const BASEMAP = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const BLUE = '#2a78d6';
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#6250d6', '#e87ba4', '#008300', '#eda100', '#e34948'];
const GREY = [148, 147, 142];
const MIN = 60e3;
// Arrow icon (points east), tinted per flight.
const ARROW_ICON = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
  '<path d="M6 24h30V10l24 22-24 22V40H6z" fill="#fff" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>');
const FLY_MS = 2500;          // map fly-out-and-in time when changing files or tabs
const SELECT_FLY_MS = 1500;   // map move when selecting a line

const R = { data: null, datum: null, tz: 'UTC', sel: null, t: null, plans: null, plan: 0, sortie: null, opts: {}, preview: null,
            meshUrl: null, mesh: null };   // results state
const APP = { on: false, tab: 'results', upload: null, poll: null, tick: null, current: null, preview: null, files: [], runs: [] };
let map = null, overlay = null, popup = null, D = null;

const $ = (id) => document.getElementById(id);
const rgb = (hex, a = 255) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).concat(a);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtN = (v, d = 0) => v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });

// ---------------------------------------------------------------- time formatting
function fmt(t, opts) { return new Intl.DateTimeFormat('en-GB', { timeZone: R.tz, hour12: false, ...opts }).format(t); }
const fmtDay = (t) => fmt(t, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = (t) => fmt(t, { hour: '2-digit', minute: '2-digit' });
const fmtFull = (t) => `${fmtDay(t)}, ${fmtTime(t)}`;
const fmtDur = (ms) => { const m = Math.round(ms / MIN); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`; };
const tzName = () => R.tz;

// ---------------------------------------------------------------- map setup
function initMap() {
  map = new maplibregl.Map({ container: 'map', style: BASEMAP, center: [-95, 35], zoom: 3, attributionControl: { compact: true } });
  map.dragRotate.disable();                 // keep north up (direction arrows assume it)
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
  overlay = new deck.MapboxOverlay({ interleaved: false, layers: [], getTooltip: tooltip });
  map.addControl(overlay);
}
function fitCoords(coords, duration = FLY_MS, padding = 60) {
  const xs = coords.map(c => c[0]), ys = coords.map(c => c[1]);
  map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding, duration, maxZoom: 13 });
}

// ---------------------------------------------------------------- line popup (all file columns)
const COLUMN_HELP = {
  RECORD: 'record number', LINE: 'line name', FEET: 'length (ft)', MILES: 'length (mi)',
  SCALE: 'photo scale, 1:n', FAZI: 'forward heading (°)', BAZI: 'back heading (°)',
  SWP: 'start waypoint', EWP: 'end waypoint', LAT1: 'start latitude', LON1: 'start longitude',
  LAT2: 'end latitude', LON2: 'end longitude', EMULSION: 'film / sensor type', LAP: 'forward overlap (%)',
  PHOTOS: 'number of photos', GRND_EL: 'ground elevation', MAGDEC: 'magnetic declination',
  'FocalLength(M)': 'focal length (m)', 'FormatX(FT)': 'image format X (ft)', 'FormatY(FT)': 'image format Y (ft)',
};
function closePopup() { if (popup) { popup.remove(); popup = null; } }
function showLinePopup(line, lngLat) {
  closePopup();
  const attrs = line.attrs || { LINE: line.line, PHOTOS: String(line.photos) };
  const label = (k) => COLUMN_HELP[k] ? COLUMN_HELP[k][0].toUpperCase() + COLUMN_HELP[k].slice(1) : k;
  const [s, e] = line.coords;
  const rows = Object.entries(attrs).map(([k, v]) =>
    `<tr><th>${esc(label(k))}${COLUMN_HELP[k] ? ` <small>${esc(k)}</small>` : ''}</th>
         <td>${v === null || v === '' ? '<span class="muted">—</span>' : esc(v)}</td></tr>`).join('') +
    `<tr class="derived"><th>Start <small>decimal °</small></th><td>${s[1].toFixed(5)}, ${s[0].toFixed(5)}</td></tr>
     <tr class="derived"><th>End <small>decimal °</small></th><td>${e[1].toFixed(5)}, ${e[0].toFixed(5)}</td></tr>`;
  popup = new maplibregl.Popup({ closeOnClick: false, maxWidth: '380px', offset: 10, className: 'line-popup' })
    .setLngLat(lngLat)
    .setHTML(`<h3>Line ${esc(line.line)}</h3><div class="popup-scroll"><table>${rows}</table></div>`)
    .addTo(map);
}

function tooltip({ object, layer, index }) {
  if (layer && layer.id === 'mesh-fill') {
    const M = R.mesh.data, v = M && index >= 0 ? M.values[index] : NaN;
    return Number.isFinite(v) ? { text: `Water level ${v >= 0 ? '+' : ''}${v.toFixed(2)} m vs ${refName(R.mesh.ref)}\n${fmtFull(M.times[R.mesh.ti])} ${tzName()} (triangle average)` } : null;
  }
  if (object == null || !layer) return null;
  if (layer.id === 'preview-lines') return { text: `Line ${object.line} · ${object.photos} photos` };
  if (layer.id === 'photos') return { text: `Line ${object.line} · photo ${object.num}: click to see the photo` };
  if (layer.id === 'lines') {
    const n = windowsOf(object.line).length;
    return { text: `Line ${object.line} · ${n ? `${n} ${R.datum.toUpperCase()} window${n > 1 ? 's' : ''}` : 'no window'}` };
  }
  return null;
}

// ---------------------------------------------------------------- results: loading
function loadResults(data, { meshUrl = null } = {}) {
  if (!data || data.format !== 'ngs-flight-planning-gui') {
    throw new Error('This is not a results file (expected a .gui.json written by predict.py).');
  }
  closePopup();
  PhotoPreview.close();
  R.data = data;
  R.datum = data.settings.datums[0];
  R.tz = data.settings.output_time_zone || 'UTC';
  R.sel = null; R.t = null; R.plan = 0; R.sortie = null; R.preview = null;
  stopMeshPlay();
  R.meshUrl = meshUrl;
  R.mesh = { on: false, ref: null, edges: true, ti: 0, data: null, loading: false, error: null, timer: null };
  renderMeshBar();
  const T = data.times.map(Date.parse), P = data.points;
  const win = new Map(), photos = new Map();
  for (const w of data.line_windows) {
    const k = `${w.line}|${w.datum}`;
    if (!win.has(k)) win.set(k, []);
    win.get(k).push([Date.parse(w.start), Date.parse(w.end)]);
  }
  for (const a of win.values()) a.sort((x, y) => x[0] - y[0]);
  for (let i = 0; i < P.line.length; i++) {
    if (!photos.has(P.line[i])) photos.set(P.line[i], []);
    photos.get(P.line[i]).push({ i, line: P.line[i], num: P.point_num[i], lon: P.lon[i], lat: P.lat[i] });
  }
  for (const a of photos.values()) a.sort((x, y) => x.num - y.num);
  D = { T, t0: T[0], t1: T[T.length - 1], win, photos };
  computePlans();

  $('empty').hidden = true;
  $('run-title').textContent = `${data.project} · forecast ${new Date(data.forecast_init).toISOString().slice(0, 13).replace('T', ' ')}Z`;
  if (APP.on) { $('tab-results').disabled = false; showTab('results'); }
  else { fitResults(0); renderAll(); }
}
function fitResults(duration = FLY_MS) {
  const [x0, y0, x1, y1] = R.data.bbox;
  map.fitBounds([[x0, y0], [x1, y1]], { padding: 40, duration });
}
async function loadFromUrl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not fetch ${url} (HTTP ${r.status}).`);
  loadResults(await r.json(), { meshUrl: url.replace(/\.gui\.json(\?.*)?$/, '.mesh.bin') });
}
function loadFromFile(file) { file.text().then(txt => loadResults(JSON.parse(txt))).catch(showError); }
function showError(e) {
  $('empty').hidden = false;
  const el = $('load-error'); el.hidden = false; el.textContent = e.message || String(e);
}

// ---------------------------------------------------------------- plans
const lineObj = (name) => R.data.lines.find(l => l.line === name);
const windowsOf = (name) => (D && D.win.get(`${name}|${R.datum}`)) || [];
const dayOf = (ms) => fmt(ms, { year: 'numeric', month: '2-digit', day: '2-digit' });

function computePlans() {
  const win = new Map(R.data.lines.map(l => [l.line, windowsOf(l.line)]));
  R.plans = Planner.plans(R.data.lines, win, dayOf, R.opts);
  R.plan = 0; R.sortie = null;
}
const activePlan = () => (R.plans && R.plans[R.plan]) || null;
const flightColor = (k) => PALETTE[k % PALETTE.length];

// Where a line sits in the active plan: { k (flight index), j (order), leg } or null.
function planned(line) {
  const p = activePlan();
  if (!p) return null;
  for (let k = 0; k < p.sorties.length; k++) {
    const j = p.sorties[k].legs.findIndex(g => g.line === line);
    if (j >= 0) return { k, j, leg: p.sorties[k].legs[j] };
  }
  return null;
}

// Time a photo would be taken: from the plan if the line is planned, else the
// middle of the line's first window, else the sunniest hour of the first day.
function photoTime(line, num) {
  const pl = planned(line);
  if (pl) {
    const n = lineObj(line).photos, idx = pl.leg.dir === 0 ? num - 1 : n - num;
    return { ms: Math.round(pl.leg.start + (n > 1 ? idx / (n - 1) : 0) * (pl.leg.end - pl.leg.start)), pl };
  }
  const w = windowsOf(line)[0];
  if (w) return { ms: Math.round((w[0] + w[1]) / 2), pl: null };
  const sun = R.data.points.sun[D.photos.get(line)[0].i];
  let best = 0;
  for (let k = 0; k < Math.min(24, D.T.length); k++) if ((sun[k] ?? -99) > (sun[best] ?? -99)) best = k;
  return { ms: D.T[best], pl: null };
}

function selectLine(name, { fly = true } = {}) {
  R.sel = name;
  if (name && fly) fitCoords(lineObj(name).coords, SELECT_FLY_MS, 120);
  renderResultsParts();
}
// Re-render everything except the panel's fixed parts (settings keep focus and state).
function renderResultsParts() {
  if (!$('plans')) return renderAll();
  renderMap(); renderPlans(); renderLinesTable(); renderLineCard();
}
function selectPlan(i) {
  R.plan = i; R.sortie = null;
  const p = activePlan();
  if (p) fitCoords(p.sorties.flatMap(s => s.legs.flatMap(g => lineObj(g.line).coords)), SELECT_FLY_MS);
  renderResultsParts();
}
function selectSortie(k) {
  R.sortie = R.sortie === k ? null : k;
  const p = activePlan();
  const legs = R.sortie == null ? p.sorties.flatMap(s => s.legs) : p.sorties[R.sortie].legs;
  fitCoords(legs.flatMap(g => lineObj(g.line).coords), SELECT_FLY_MS);
  renderResultsParts();
}

// ---------------------------------------------------------------- photo preview
function openPhoto(ph) {
  const ln = lineObj(ph.line), cam = Geo.camera(ln);
  closePopup();
  if (!cam) {
    alert('This results file has no camera details (scale, focal length, image format). Run it again from the app to preview photos.');
    return;
  }
  const { ms, pl } = photoTime(ph.line, ph.num);
  R.preview = { ...ph, fp: Geo.footprint(ph.lon, ph.lat, cam), ms };
  R.sel = ph.line;
  const when = pl ? `flight ${pl.k + 1}, line ${pl.j + 1} of ${activePlan().sorties[pl.k].legs.length}` : 'not in the plan: middle of its first window';
  PhotoPreview.open({
    container: $('map-wrap'), lon: ph.lon, lat: ph.lat, cam, ms,
    title: `Line ${ph.line} · photo ${ph.num} of ${ln.photos}`,
    subtitle: `${fmtFull(ms)} ${tzName()} <span class="muted">(${when})</span>`,
    minSun: R.data.settings.min_solar_elevation,
    onClose: () => { R.preview = null; renderMap(); },
  });
  renderResultsParts();
}

// ---------------------------------------------------------------- results: map
function renderMap() {
  if (APP.on && APP.tab === 'run') return renderPreview();
  if (!R.data) { overlay.setProps({ layers: [] }); $('map-legend').hidden = true; return; }
  const data = R.data, p = activePlan();
  const inFocus = (k) => R.sortie == null || R.sortie === k;
  const layers = meshLayers();
  if (R.sel) layers.push(new deck.PathLayer({
    id: 'halo', data: [lineObj(R.sel)], getPath: d => d.coords, getColor: [11, 11, 11, 200],
    getWidth: 11, widthUnits: 'pixels', capRounded: true,
  }));
  layers.push(new deck.PathLayer({
    id: 'lines', data: data.lines, getPath: d => d.coords, pickable: true,
    getColor: d => {
      const pl = planned(d.line);
      if (!pl) return [...GREY, 170];
      return rgb(flightColor(pl.k), inFocus(pl.k) ? 255 : 70);
    },
    getWidth: d => (planned(d.line) ? 4.5 : 2.5), widthUnits: 'pixels', capRounded: true,
    updateTriggers: { getColor: [R.plan, R.sortie, R.datum, R.plans], getWidth: [R.plan, R.plans] },
  }));
  if (p) {
    // Transit legs between consecutive lines of each flight.
    const transits = p.sorties.flatMap((s, k) => s.legs.slice(1).map((g, j) => {
      const a = s.legs[j], la = lineObj(a.line), lb = lineObj(g.line);
      return { k, path: [la.coords[1 - a.dir], lb.coords[g.dir]] };
    }));
    layers.push(new deck.PathLayer({
      id: 'transits', data: transits.filter(t => inFocus(t.k)), getPath: t => t.path,
      getColor: t => rgb(flightColor(t.k), 150), getWidth: 1.5, widthUnits: 'pixels',
    }));
    // Direction arrows beside each planned line, pointing the way it is flown.
    const arrows = p.sorties.flatMap((s, k) => s.legs.map(g => {
      const c = lineObj(g.line).coords, a = c[g.dir], b = c[1 - g.dir];
      return { k, pos: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], bearing: Geo.bearing(a[0], a[1], b[0], b[1]) };
    }));
    layers.push(new deck.IconLayer({
      id: 'arrows', data: arrows.filter(o => inFocus(o.k)), getPosition: o => o.pos,
      getIcon: () => ({ url: ARROW_ICON, width: 64, height: 64, mask: true }),
      getSize: 22, sizeUnits: 'pixels', getColor: o => rgb(flightColor(o.k)),
      getAngle: o => 90 - o.bearing - map.getBearing(),          // icon points east; deck angles turn counter-clockwise
      getPixelOffset: o => { const r = (o.bearing - map.getBearing()) * Math.PI / 180; return [Math.cos(r) * 13, Math.sin(r) * 13]; },
      updateTriggers: { getAngle: [map.getBearing()], getPixelOffset: [map.getBearing()] },
    }));
    // Order numbers at the start of each planned line.
    const order = p.sorties.flatMap((s, k) => s.legs.map((g, j) => ({ k, j, pos: lineObj(g.line).coords[g.dir] })));
    layers.push(new deck.TextLayer({
      id: 'order', data: order.filter(o => inFocus(o.k)), getPosition: o => o.pos, getText: o => String(o.j + 1),
      getSize: 14, getColor: [255, 255, 255], background: true, getBackgroundColor: o => rgb(flightColor(o.k)),
      backgroundPadding: [6, 3], fontWeight: 'bold', fontFamily: 'Arial, Helvetica, sans-serif', getPixelOffset: [0, 14],
    }));
  }
  // Clickable photo points: lines in the plan (or the focused flight), plus the selected line.
  const showLines = new Set();
  if (p) p.sorties.forEach((s, k) => inFocus(k) && s.legs.forEach(g => showLines.add(g.line)));
  if (R.sel) showLines.add(R.sel);
  const pts = [...showLines].flatMap(l => D.photos.get(l) || []);
  layers.push(new deck.ScatterplotLayer({
    id: 'photos', data: pts, getPosition: q => [q.lon, q.lat], pickable: true,
    getRadius: q => (R.preview && R.preview.line === q.line && R.preview.num === q.num) ? 6 : 3.5, radiusUnits: 'pixels',
    getFillColor: q => (R.preview && R.preview.line === q.line && R.preview.num === q.num) ? [255, 207, 74] : [255, 255, 255],
    stroked: true, getLineColor: [11, 11, 11], getLineWidth: 1, lineWidthUnits: 'pixels',
    updateTriggers: { getRadius: [R.preview], getFillColor: [R.preview] },
  }));
  if (R.preview) layers.push(new deck.PolygonLayer({
    id: 'preview-footprint', data: [R.preview.fp], getPolygon: d => d, filled: true,
    getFillColor: [255, 207, 74, 40], getLineColor: [201, 133, 0], getLineWidth: 2, lineWidthUnits: 'pixels',
  }));
  layers.push(new deck.TextLayer({
    id: 'labels', data: data.lines, getPosition: d => d.coords[1], getText: d => d.line,
    getSize: 10, getColor: [82, 81, 78], getPixelOffset: [0, -9], fontFamily: 'system-ui, sans-serif',
    background: true, getBackgroundColor: [255, 255, 255, 190], backgroundPadding: [2, 1],
  }));
  overlay.setProps({
    layers,
    onClick: (info) => {
      if (info.layer?.id === 'photos') openPhoto(info.object);
      else if (info.layer?.id === 'lines') { selectLine(info.object.line, { fly: false }); showLinePopup(info.object, info.coordinate); }
      else closePopup();
    },
  });
  const lg = $('map-legend'); lg.hidden = false;
  lg.innerHTML = meshLegend() + (p ? p.sorties.map((s, k) => `<div><span class="swatch" style="background:${flightColor(k)}"></span>Flight ${k + 1} · ${fmtDay(s.start)}</div>`).join('') : '') +
    `<div><span class="swatch" style="background:rgb(${GREY})"></span>Not in the plan</div>
     ${p ? '<div><span class="arrow-key">➜</span>Direction each line is flown</div>' : ''}
     <div><span class="dot" style="background:#fff"></span>Photo point: click to preview the photo</div>`;
}

// ---------------------------------------------------------------- mesh view (STOFS water levels on the mesh)
const refName = (r) => r === 'lmsl' ? 'local mean sea level' : r.toUpperCase();

function meshLayers() {
  const M = R.mesh && R.mesh.on && R.mesh.data;
  if (!M) return [];
  const layers = [new deck.SolidPolygonLayer({
    id: 'mesh-fill', data: { length: M.m, startIndices: M.startIndices, attributes: { getPolygon: { value: M.positions, size: 2 } } },
    _normalize: false, positionFormat: 'XY', pickable: true,
    getFillColor: (_, { index }) => M.colors.subarray(index * 4, index * 4 + 4),
    updateTriggers: { getFillColor: [R.mesh.ti, R.mesh.ref] },
  })];
  if (R.mesh.edges) layers.push(new deck.LineLayer({
    id: 'mesh-edges', data: { length: M.nEdges, attributes: { getSourcePosition: { value: M.edgeSrc, size: 2 }, getTargetPosition: { value: M.edgeTgt, size: 2 } } },
    getColor: [40, 40, 40, 38], getWidth: 0.6, widthUnits: 'pixels',
  }));
  return layers;
}

function meshLegend() {
  const M = R.mesh && R.mesh.on && R.mesh.data;
  if (!M) return '';
  const S = Mesh.scaleFor(M, R.mesh.ref);
  return `<div class="mesh-legend"><b>Water level vs ${esc(refName(R.mesh.ref))}</b>
    <div class="grad" style="background:${Mesh.gradientCss()}"></div>
    <div class="grad-ticks"><span>−${S.toFixed(1)} m</span><span>0</span><span>+${S.toFixed(1)} m</span></div>
    <div class="muted">below · above · dry areas not shown</div></div>`;
}

async function setMeshOn(on) {
  const ms = R.mesh;
  ms.on = on;
  if (on && !ms.data && !ms.loading) {
    ms.loading = true; ms.error = null; renderMeshControls();
    try {
      const r = await fetch(R.meshUrl);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Could not load the mesh water levels (HTTP ${r.status}).`);
      ms.data = Mesh.parse(await r.arrayBuffer());
      const d = R.datum === 'bmhw' ? 'mhw' : R.datum;
      ms.ref = ms.data.header.datums.includes(d) ? d : 'lmsl';
      ms.ti = defaultMeshTime();
    } catch (e) { ms.error = e.message; ms.on = false; }
    ms.loading = false;
  }
  if (!ms.on) stopMeshPlay();
  if (ms.on && ms.data) Mesh.update(ms.data, ms.ti, ms.ref);
  renderMeshControls(); renderMeshBar(); renderMap();
}

// Start at the hour of the first planned flight, else the first hour.
function defaultMeshTime() {
  const M = R.mesh.data, p = activePlan();
  if (!p || !p.sorties.length) return 0;
  const t = p.sorties[0].start;
  let best = 0;
  M.times.forEach((x, i) => { if (Math.abs(x - t) < Math.abs(M.times[best] - t)) best = i; });
  return best;
}

function setMeshTime(ti) {
  const ms = R.mesh, M = ms.data;
  ms.ti = Math.max(0, Math.min(M.t - 1, ti));
  Mesh.update(M, ms.ti, ms.ref);
  renderMeshBar(); renderMap();
}
function playMesh() {
  const ms = R.mesh;
  if (ms.timer) return stopMeshPlay();
  if (ms.ti >= ms.data.t - 1) ms.ti = 0;
  ms.timer = setInterval(() => { if (ms.ti >= ms.data.t - 1) return stopMeshPlay(); setMeshTime(ms.ti + 1); }, 350);
  renderMeshBar();
}
function stopMeshPlay() {
  if (R.mesh && R.mesh.timer) { clearInterval(R.mesh.timer); R.mesh.timer = null; }
  const b = $('mesh-play'); if (b) b.textContent = '▶';
}

function renderMeshControls() {
  const el = $('mesh-controls');
  if (!el || !R.mesh) return;
  const ms = R.mesh, M = ms.data;
  const disabled = !R.meshUrl;
  let extra = '';
  if (disabled) extra = `<p class="hint">Mesh water levels are available when results are opened from the app's past runs.</p>`;
  else if (ms.loading) extra = `<p class="hint">Loading mesh water levels…</p>`;
  else if (ms.error) extra = `<p class="error">${esc(ms.error)}</p>`;
  else if (ms.on && M) {
    const refs = ['lmsl', ...M.header.datums];
    extra = `<div class="mesh-opts">
        <label>Relative to <select id="mesh-ref">${refs.map(r => `<option value="${r}" ${r === ms.ref ? 'selected' : ''}>${r === 'lmsl' ? 'Local mean sea level' : r.toUpperCase()}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" id="mesh-edges" ${ms.edges ? 'checked' : ''}> Mesh edges</label>
      </div>
      <p class="hint">${M.n.toLocaleString()} nodes · ${M.m.toLocaleString()} triangles${M.header.triangulation === 'stofs' ? ' (STOFS model mesh)' : ' (approximate triangulation: the model mesh was not available)'} · hourly forecast. Use the time bar on the map.</p>`;
  }
  el.innerHTML = `<label class="check"><input type="checkbox" id="mesh-on" ${ms.on ? 'checked' : ''} ${disabled ? 'disabled' : ''}> STOFS water levels on the mesh</label>${extra}`;
  $('mesh-on').addEventListener('change', (e) => setMeshOn(e.target.checked));
  if ($('mesh-ref')) $('mesh-ref').addEventListener('change', (e) => { ms.ref = e.target.value; Mesh.update(M, ms.ti, ms.ref); renderMap(); });
  if ($('mesh-edges')) $('mesh-edges').addEventListener('change', (e) => { ms.edges = e.target.checked; renderMap(); });
}

function renderMeshBar() {
  const bar = $('mesh-bar');
  const ms = R.mesh, M = ms && ms.on && ms.data;
  const show = !!M && (!APP.on || APP.tab === 'results');
  bar.hidden = !show;
  if (!show) return;
  const slider = $('mesh-slider');
  slider.max = M.t - 1; slider.value = ms.ti;
  $('mesh-time').textContent = `${fmtFull(M.times[ms.ti])} ${tzName()}`;
  $('mesh-play').textContent = ms.timer ? '⏸' : '▶';
}

// ---------------------------------------------------------------- results: panel
function renderAll() { renderMap(); renderPanel(); }

function renderPanel() {
  const el = $('results-panel'), data = R.data;
  if (!data) { el.innerHTML = ''; return; }
  const ds = data.settings.datums;
  const datumToggle = ds.length > 1
    ? `<div class="seg">${ds.map(d => `<button type="button" data-datum="${d}" class="${d === R.datum ? 'on' : ''}">${d.toUpperCase()}</button>`).join('')}</div>` : '';
  const notes = data.notes.map(n => `<div class="note">${esc(n)}</div>`).join('');
  const o = { ...Planner.DEFAULTS, ...R.opts };
  el.innerHTML = `
    <div class="res-head">
      <div><b>${esc(data.project)}</b> <span class="muted">· times in ${esc(tzName())}</span></div>
      ${datumToggle}
    </div>
    ${notes}
    <h4>Map view</h4>
    <div id="mesh-controls" class="mesh-controls"></div>
    <h4>Flight plans <span class="muted">· ${R.datum.toUpperCase()}</span></h4>
    <details class="more assumptions" id="assumptions" ${R.assumpOpen ? 'open' : ''}><summary>Planning assumptions</summary>
      <div class="opts">
        <label>Ground speed <span><input type="number" data-opt="speedKt" value="${o.speedKt}" min="60" max="400" step="5"> kt</span></label>
        <label>Turn / line change <span><input type="number" data-opt="turnMin" value="${o.turnMin}" min="0" max="30" step="0.5"> min</span></label>
        <label>Longest flight on site <span><input type="number" data-opt="maxSortieH" value="${o.maxSortieH}" min="0.5" max="12" step="0.5"> h</span></label>
        <label>Overhead per flight <span><input type="number" data-opt="overheadH" value="${o.overheadH}" min="0" max="10" step="0.25"> h</span></label>
        <label>Longest wait for a window <span><input type="number" data-opt="maxWaitMin" value="${o.maxWaitMin}" min="0" max="600" step="10"> min</span></label>
      </div>
      <div class="opts-foot"><button type="button" id="opts-reset">Reset to defaults</button></div>
      <p class="hint">Plans update as you type. Overhead per flight covers getting to and from the site, take-off and landing. One flight per day. Lines can be flown in either direction.</p>
    </details>
    <div id="plan-change" class="plan-change" hidden></div>
    <div id="plans"></div>
    <div id="line-card"></div>
    <h4>Lines <span class="muted">· click a white photo point on the map to see the photo</span></h4>
    <div id="lines-table"></div>`;
  el.querySelectorAll('[data-datum]').forEach(b => b.addEventListener('click', () => { R.datum = b.dataset.datum; computePlans(); PhotoPreview.close(); renderAll(); }));
  $('assumptions').addEventListener('toggle', (e) => { R.assumpOpen = e.target.open; });
  let timer = null;
  el.querySelectorAll('[data-opt]').forEach(inp => inp.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const v = parseFloat(inp.value);
      if (!Number.isFinite(v) || v < +inp.min || v > +inp.max) { inp.classList.add('bad'); return; }
      inp.classList.remove('bad');
      R.opts = { ...R.opts, [inp.dataset.opt]: v };
      replan();
    }, 300);
  }));
  $('opts-reset').addEventListener('click', () => {
    R.opts = {};
    el.querySelectorAll('[data-opt]').forEach(inp => { inp.value = Planner.DEFAULTS[inp.dataset.opt]; inp.classList.remove('bad'); });
    replan();
  });
  renderMeshControls();
  renderPlans();
  renderLinesTable();
  renderLineCard();
}

// Recalculate plans after an assumption changed, and say what changed.
function replan() {
  const before = R.plans && R.plans.find(p => p.recommended);
  computePlans();
  const after = R.plans && R.plans.find(p => p.recommended);
  const desc = (p) => p ? `<b>${esc(p.title)}</b>: ${p.sorties.length} flight${p.sorties.length > 1 ? 's' : ''}, ${p.covered} lines, ${fmtN(p.cost, 1)} h total` : 'none';
  const same = before && after && before.title === after.title && before.sorties.length === after.sorties.length &&
               before.covered === after.covered && Math.abs(before.cost - after.cost) < 0.005;
  const msg = $('plan-change');
  msg.hidden = false;
  msg.innerHTML = same
    ? `Plans recalculated. The recommended plan is unchanged: ${desc(after)}.`
    : `Plans recalculated. Recommended is now ${desc(after)} <span class="muted">(was ${desc(before)})</span>.`;
  msg.classList.remove('flash'); void msg.offsetWidth; msg.classList.add('flash');
  renderPlans(); renderLinesTable(); renderLineCard(); renderMap();
}

function renderPlans() {
  const box = $('plans');
  if (!box) return;
  box.innerHTML = (R.plans || []).map((p, i) => planCard(p, i)).join('') ||
    `<p class="hint">No line has a ${R.datum.toUpperCase()} window in this forecast, so there is nothing to plan.</p>`;
  box.querySelectorAll('[data-plan]').forEach(c => c.addEventListener('click', (e) => { if (!e.target.closest('[data-sortie]')) selectPlan(+c.dataset.plan); }));
  box.querySelectorAll('[data-sortie]').forEach(s => s.addEventListener('click', () => selectSortie(+s.dataset.sortie)));
}

function renderLinesTable() {
  const box = $('lines-table');
  if (!box) return;
  const rows = R.data.lines.map(l => {
    const w = windowsOf(l.line), pl = planned(l.line);
    const first = w.length ? `${fmtDay(w[0][0])} <b>${fmtTime(w[0][0])}–${fmtTime(w[0][1])}</b>` : '<span class="muted">no window</span>';
    const fl = pl ? `<span class="chip-dot" style="background:${flightColor(pl.k)}"></span>${pl.k + 1}·${pl.j + 1}` : '<span class="muted">—</span>';
    return `<tr data-line="${esc(l.line)}" class="${l.line === R.sel ? 'sel' : ''}">
      <td>${esc(l.line)}</td><td>${first}</td><td class="num">${w.length || ''}</td><td class="num">${fl}</td></tr>`;
  }).join('');
  box.innerHTML = `<table class="lines-table"><thead><tr><th>Line</th><th>First window</th><th class="num">Windows</th><th class="num">Flight·order</th></tr></thead><tbody>${rows}</tbody></table>`;
  box.querySelectorAll('tr[data-line]').forEach(tr => tr.addEventListener('click', () => { closePopup(); selectLine(tr.dataset.line); }));
}

function planCard(p, i) {
  const active = i === R.plan;
  const total = `${fmtN(p.cost, 1)} h total <span class="muted">(${fmtN(p.hours, 1)} h on site + ${p.sorties.length} × ${fmtN(p.overhead, 2)} h overhead)</span>`;
  const missing = p.flyable - p.covered;
  let body = '';
  if (active) {
    body = `<p class="hint">${esc(p.why)}</p>` + p.sorties.map((s, k) => `
      <div class="sortie ${R.sortie === k ? 'on' : ''}" data-sortie="${k}">
        <div><span class="swatch" style="background:${flightColor(k)}"></span><b>Flight ${k + 1}</b> · ${fmtDay(s.start)} ${fmtTime(s.start)}–${fmtTime(s.end)}
          <span class="muted">· ${s.lines} line${s.lines > 1 ? 's' : ''} · ${fmtDur(s.end - s.start)}</span></div>
        <div class="legs">${s.legs.map(g => esc(g.line)).join(' → ')}</div>
      </div>`).join('') +
      (missing ? `<p class="hint">Not covered by this plan: ${missing} line${missing > 1 ? 's' : ''} that ${missing > 1 ? 'have' : 'has'} windows.</p>` : '') +
      (p.noWindow.length ? `<p class="hint">${p.noWindow.length} line${p.noWindow.length > 1 ? 's have' : ' has'} no ${R.datum.toUpperCase()} window in this forecast and cannot be planned.</p>` : '');
  }
  return `<div class="plan ${active ? 'on' : ''}" data-plan="${i}">
    <div class="plan-head"><b>${esc(p.title)}</b>${p.recommended ? '<span class="badge done">recommended</span>' : ''}</div>
    <div class="plan-stats">${p.sorties.length} flight${p.sorties.length > 1 ? 's' : ''} · ${p.covered} of ${p.flyable} lines · finishes ${fmtDay(p.finish)}<br>${total}</div>
    ${body}
  </div>`;
}

function renderLineCard() {
  const el = $('line-card');
  if (!el) return;
  if (!R.sel) { el.innerHTML = ''; return; }
  const ln = lineObj(R.sel), w = windowsOf(R.sel), pl = planned(R.sel);
  const plan = pl
    ? `<p class="kv-p">Planned in <b>flight ${pl.k + 1}</b>, line ${pl.j + 1}: <b>${fmtDay(pl.leg.start)} ${fmtTime(pl.leg.start)}–${fmtTime(pl.leg.end)}</b></p>`
    : `<p class="kv-p muted">Not in the selected plan.</p>`;
  const chips = w.length
    ? w.map(([s, e]) => `${fmtDay(s)} ${fmtTime(s)}–${fmtTime(e)} <span class="muted">(${fmtDur(e - s)})</span>`).join('<br>')
    : `<span class="muted">No ${R.datum.toUpperCase()} window in this forecast.</span>`;
  el.innerHTML = `<div class="card">
    <div class="card-head"><h3>Line ${esc(ln.line)} <span class="muted">· ${ln.photos} photos</span></h3>
      <button type="button" class="x" id="close-line" title="Close">×</button></div>
    ${plan}
    <h4>${R.datum.toUpperCase()} windows</h4><p class="kv-p">${chips}</p>
    <p class="hint">Click one of its photo points on the map to see the photo.</p></div>`;
  $('close-line').addEventListener('click', () => { closePopup(); R.sel = null; renderResultsParts(); });
}

// ================================================================ app mode (served by app.py)
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (HTTP ${r.status}).`);
  return j;
}

function showTab(name) {
  if (APP.tab !== name) { closePopup(); if (name !== 'results') PhotoPreview.close(); }
  APP.tab = name;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $('run-panel').hidden = name !== 'run';
  $('results-panel').hidden = name !== 'results';
  if (name !== 'results') stopMeshPlay();
  if (name === 'results' && R.data) fitResults();
  else if (name === 'run' && APP.preview) fitCoords(APP.preview.lines.flatMap(l => l.coords));
  renderAll();
  renderMeshBar();
}

// Preview of the chosen flight-lines file (New run tab).
function setPreview(name, lines) {
  closePopup();
  APP.preview = lines && lines.length ? { name, lines } : null;
  if (APP.tab !== 'run') return;
  renderMap();
  if (APP.preview) {
    fitCoords(APP.preview.lines.flatMap(l => l.coords));
    map.once('moveend', () => { if (APP.tab === 'run') renderMap(); });   // redraw after the flight
  }
}
function renderPreview() {
  const lg = $('map-legend');
  if (!APP.preview) { overlay.setProps({ layers: [] }); lg.hidden = true; return; }
  const lines = APP.preview.lines, col = rgb(BLUE);
  overlay.setProps({
    layers: [
      new deck.PathLayer({ id: 'preview-lines', data: lines, getPath: d => d.coords, getColor: col, getWidth: 3,
                           widthUnits: 'pixels', capRounded: true, pickable: true }),
      new deck.ScatterplotLayer({ id: 'preview-ends', data: lines.flatMap(l => l.coords), getPosition: d => d,
                                  getRadius: 3, radiusUnits: 'pixels', getFillColor: [255, 255, 255], stroked: true,
                                  getLineColor: col, getLineWidth: 1.5, lineWidthUnits: 'pixels' }),
      new deck.TextLayer({ id: 'preview-labels', data: lines, getPosition: d => d.coords[0], getText: d => d.line,
                           getSize: 11, getColor: [11, 11, 11], getPixelOffset: [0, -10], background: true,
                           getBackgroundColor: [255, 255, 255, 220], backgroundPadding: [3, 1], fontFamily: 'system-ui, sans-serif' }),
    ],
    onClick: (info) => { if (info.layer?.id === 'preview-lines') showLinePopup(info.object, info.coordinate); else closePopup(); },
  });
  const photos = lines.reduce((n, l) => n + l.photos, 0);
  lg.hidden = false;
  lg.innerHTML = `<div><span class="swatch" style="background:${BLUE}"></span><b>${esc(APP.preview.name)}</b></div>
    <div>${lines.length} flight lines · ${photos} photos</div>`;
}

async function initApp() {
  let info;
  try { info = await api('/api/info'); } catch { return; }   // opened without app.py: results viewer only
  APP.on = true;
  $('tabs').hidden = false;
  $('empty').hidden = true;
  $('open-file').firstChild.textContent = 'Open file…';
  document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => !b.disabled && showTab(b.dataset.tab)));
  $('f-datums').innerHTML = info.datums.map(d => `<label><input type="checkbox" value="${d}" ${['mllw', 'mhw'].includes(d) ? 'checked' : ''}>
      ${d === 'bmhw' ? 'BMHW (at/below MHW)' : d.toUpperCase()}</label>`).join('');
  $('f-lines').addEventListener('change', onLinesChange);
  $('f-upload').addEventListener('change', (e) => e.target.files[0] && useUpload(e.target.files[0]));
  $('run-form').addEventListener('submit', (e) => { e.preventDefault(); submitRun(); });
  $('prog-cancel').addEventListener('click', () => APP.current && api(`/api/runs/${APP.current}/cancel`, {}));
  showTab('run');
  loadLineFiles();
  loadForecasts();
  await refreshRuns();
  const running = APP.runs.find(r => r.status === 'running');
  if (running) watchRun(running.id);
}

async function loadLineFiles() {
  const { files } = await api('/api/linefiles');
  APP.files = files;
  $('f-lines').innerHTML = files.map(f => `<option value="${esc(f.name)}">${esc(f.name)} (${f.lines} lines)</option>`).join('') +
    `<option value="__upload__">Upload a file…</option>`;
  if (!files.length) $('f-lines').value = '__upload__';
  onLinesChange();
}
const projectFrom = (name) => name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_');
function onLinesChange() {
  const v = $('f-lines').value;
  $('upload-row').hidden = v !== '__upload__';
  if (v === '__upload__') {
    if (APP.upload) $('f-project').value = projectFrom(APP.upload.name);
    setPreview(APP.upload?.name, APP.upload?.lines);
    return;
  }
  APP.upload = null;
  const f = APP.files.find(x => x.name === v);
  if (f) $('f-project').value = f.project;
  api(`/api/linefiles/${encodeURIComponent(v)}`)
    .then(g => { if ($('f-lines').value === v) setPreview(v, g.lines); })
    .catch(() => setPreview(null, null));
}
async function useUpload(file) {
  showTab('run');
  $('f-lines').value = '__upload__';
  $('upload-row').hidden = false;
  const text = await file.text();
  const chk = await api('/api/check-lines', { text });
  $('upload-msg').textContent = `${file.name}: ${chk.message}`;
  $('upload-msg').className = chk.ok ? 'hint' : 'error';
  APP.upload = chk.ok ? { name: file.name, text, lines: chk.geometry.lines } : null;
  if (chk.ok) $('f-project').value = projectFrom(file.name);
  setPreview(file.name, chk.ok ? chk.geometry.lines : null);
}
async function loadForecasts() {
  const sel = $('f-forecast');
  try {
    const { forecasts, error } = await api('/api/forecasts');
    if (error) throw new Error(error);
    if (!forecasts.length) throw new Error('No recent forecasts found on NOAA\'s archive.');
    sel.innerHTML = forecasts.map((f, i) => {
      const d = new Date(f + 'Z');
      return `<option value="${f}">${d.toUTCString().slice(0, 11)} ${f.slice(11, 13)}Z${i === 0 ? ' (latest)' : ''}</option>`;
    }).join('');
  } catch (e) {
    sel.innerHTML = `<option value="">Forecasts unavailable</option>`;
    showFormError(e.message);
  }
}
function showFormError(msg) { const el = $('form-error'); el.hidden = !msg; el.textContent = msg || ''; }

async function submitRun() {
  showFormError('');
  const lines = $('f-lines').value;
  if (lines === '__upload__' && !APP.upload) return showFormError('Choose a flight-lines file to upload.');
  const body = {
    project: $('f-project').value.trim(), forecast: $('f-forecast').value,
    datums: [...document.querySelectorAll('#f-datums input:checked')].map(c => c.value),
    min_sun: +$('f-sun').value, every_nth_point: +$('f-nth').value, time_zone: $('f-tz').value,
    ...(lines === '__upload__' ? { upload_text: APP.upload.text, upload_name: APP.upload.name } : { lines_file: lines }),
  };
  try { const run = await api('/api/runs', body); await refreshRuns(); watchRun(run.id); }
  catch (e) { showFormError(e.message); }
}
function watchRun(id) {
  APP.current = id;
  clearInterval(APP.poll); clearInterval(APP.tick);
  $('progress').hidden = false;
  $('f-run').disabled = true;
  const update = async () => {
    let r;
    try { r = await api(`/api/runs/${id}`); } catch { return; }
    renderProgress(r);
    if (r.status !== 'running') {
      clearInterval(APP.poll); clearInterval(APP.tick);
      $('f-run').disabled = false;
      await refreshRuns();
      if (r.status === 'done') openRun(r);
    }
  };
  update();
  APP.poll = setInterval(update, 1500);
  APP.tick = setInterval(() => APP.last && renderElapsed(APP.last), 1000);
}
function renderProgress(r) {
  APP.last = r;
  $('prog-title').textContent = `${r.project} · ${r.forecast.replace('T', ' ').slice(0, 13)}Z`;
  $('prog-stages').innerHTML = r.stages.map((s, i) => {
    const cls = r.status === 'done' || i < r.stage ? 'done' : (i === r.stage && r.status === 'running' ? 'current' : 'todo');
    return `<li class="${cls}">${esc(s)}</li>`;
  }).join('');
  $('prog-log').textContent = r.log_tail || '';
  $('prog-cancel').hidden = r.status !== 'running';
  const err = $('prog-error');
  err.hidden = !(r.status === 'failed' || r.status === 'cancelled');
  err.textContent = r.error || '';
  if (r.status === 'failed') $('progress').querySelector('details').open = true;
  renderElapsed(r);
}
function renderElapsed(r) {
  const end = r.finished ? Date.parse(r.finished) : Date.now();
  const s = Math.max(0, Math.round((end - Date.parse(r.started)) / 1000));
  const label = { running: 'running', done: 'finished', failed: 'failed', cancelled: 'cancelled' }[r.status];
  $('prog-time').textContent = `${label} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
async function refreshRuns() {
  const { runs } = await api('/api/runs');
  APP.runs = runs;
  const ul = $('past-runs');
  if (!runs.length) { ul.innerHTML = '<li class="hint">None yet.</li>'; return; }
  ul.innerHTML = runs.map(r => {
    const when = new Date(r.started).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `<li data-id="${esc(r.id)}"><b>${esc(r.project)}</b><span class="badge ${r.status}">${r.status}</span><br>
      <span class="muted">forecast ${esc(r.forecast.replace('T', ' ').slice(0, 13))}Z · ${r.datums.map(d => d.toUpperCase()).join(', ')} · run ${when}</span></li>`;
  }).join('');
  ul.querySelectorAll('li[data-id]').forEach(li => li.addEventListener('click', () => {
    const r = APP.runs.find(x => x.id === li.dataset.id);
    if (r.status === 'done') openRun(r); else watchRun(r.id);
  }));
}
async function openRun(r) {
  try { loadResults(await api(`/api/runs/${r.id}/gui`), { meshUrl: `/api/runs/${r.id}/mesh` }); } catch (e) { showFormError(e.message); }
}

// ---------------------------------------------------------------- start
function init() {
  initMap();
  $('file-input').addEventListener('change', (e) => e.target.files[0] && loadFromFile(e.target.files[0]));
  $('mesh-slider').addEventListener('input', (e) => { stopMeshPlay(); setMeshTime(+e.target.value); });
  $('mesh-play').addEventListener('click', playMesh);
  document.addEventListener('keydown', (e) => { if (e.code === 'Escape') closePopup(); });
  const empty = $('empty');
  document.addEventListener('dragover', (e) => { e.preventDefault(); empty.hidden = false; empty.classList.add('drag'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) { empty.classList.remove('drag'); if (R.data || APP.on) empty.hidden = true; } });
  document.addEventListener('drop', (e) => {
    e.preventDefault(); empty.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f && APP.on && !/\.json$/i.test(f.name)) { empty.hidden = true; return useUpload(f); }
    if (f) loadFromFile(f); else if (R.data || APP.on) empty.hidden = true;
  });
  const url = new URLSearchParams(location.search).get('data');
  if (url) map.once('load', () => loadFromUrl(url).catch(showError));
  initApp();
}
init();
