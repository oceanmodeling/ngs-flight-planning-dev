/* STOFS water levels on the mesh, for the results viewer.
 *
 * Reads <name>.mesh.bin written by predict.py (outputs.mesh_levels_prediction):
 * node positions, mesh triangles, datum heights and hourly water levels (cm
 * above local mean sea level) for every mesh node in the survey area. Builds
 * the triangle and edge geometry for deck.gl and colours each triangle by its
 * average water level relative to LMSL or a tidal datum.
 */
(function (root) {
  'use strict';
  const NEG = [42, 120, 214], MID = [236, 235, 231], POS = [235, 104, 52];   // blue - neutral - orange

  function parse(buf) {
    const dv = new DataView(buf);
    if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== 'NGSM') throw new Error('Not a mesh water-level file.');
    const hl = dv.getUint32(4, true);
    const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl)));
    const base = 8 + hl, o = h.offsets, n = h.nodes, m = h.triangles, t = h.times.length;
    const lon = new Float32Array(buf, base + o.lon, n), lat = new Float32Array(buf, base + o.lat, n);
    const tri = new Uint32Array(buf, base + o.tri, m * 3);
    const datums = {};
    for (const d of h.datums) datums[d] = new Int16Array(buf, base + o[`datum:${d}`], n);
    const zeta = new Int16Array(buf, base + o.zeta, t * n);

    // Triangle vertices for deck.gl (binary polygons, 3 vertices each).
    const positions = new Float32Array(m * 6), startIndices = new Uint32Array(m);
    for (let f = 0; f < m; f++) {
      startIndices[f] = f * 3;
      for (let c = 0; c < 3; c++) { const v = tri[f * 3 + c]; positions[f * 6 + c * 2] = lon[v]; positions[f * 6 + c * 2 + 1] = lat[v]; }
    }
    // Unique edges.
    const seen = new Set(), src = [], tgt = [];
    for (let f = 0; f < m; f++) for (let c = 0; c < 3; c++) {
      const a = tri[f * 3 + c], b = tri[f * 3 + (c + 1) % 3];
      const key = a < b ? a * n + b : b * n + a;
      if (seen.has(key)) continue;
      seen.add(key); src.push(lon[a], lat[a]); tgt.push(lon[b], lat[b]);
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) { x0 = Math.min(x0, lon[i]); x1 = Math.max(x1, lon[i]); y0 = Math.min(y0, lat[i]); y1 = Math.max(y1, lat[i]); }
    return {
      header: h, n, m, t, lon, lat, tri, datums, zeta, positions, startIndices,
      edgeSrc: new Float32Array(src), edgeTgt: new Float32Array(tgt), nEdges: src.length / 2,
      times: h.times.map(Date.parse), nodata: h.nodata, bounds: [x0, y0, x1, y1],
      colors: new Uint8Array(m * 4), values: new Float32Array(m), scales: {},
    };
  }

  // Water level (m) at a node relative to ref ('lmsl' or a datum name); NaN if missing.
  function nodeValue(M, ti, v, ref) {
    const z = M.zeta[ti * M.n + v];
    if (z === M.nodata) return NaN;
    if (ref === 'lmsl') return z / 100;
    const r = M.datums[ref][v];
    return r === M.nodata ? NaN : (z - r) / 100;
  }

  // Colour scale half-range (m): the 98th percentile of |level| over sampled hours, rounded up.
  function scaleFor(M, ref) {
    if (M.scales[ref]) return M.scales[ref];
    const vals = [];
    const stepT = Math.max(1, Math.floor(M.t / 24)), stepN = Math.max(1, Math.floor(M.n / 5000));
    for (let ti = 0; ti < M.t; ti += stepT) for (let v = 0; v < M.n; v += stepN) {
      const x = nodeValue(M, ti, v, ref); if (Number.isFinite(x)) vals.push(Math.abs(x));
    }
    vals.sort((a, b) => a - b);
    const p = vals.length ? vals[Math.floor(vals.length * 0.98)] : 1;
    return (M.scales[ref] = Math.max(0.2, Math.ceil(p * 10) / 10));
  }

  // Fill M.values (triangle mean, m) and M.colors for time index ti.
  function update(M, ti, ref, alpha = 175) {
    const S = scaleFor(M, ref);
    for (let f = 0; f < M.m; f++) {
      let sum = 0, ok = true;
      for (let c = 0; c < 3; c++) { const x = nodeValue(M, ti, M.tri[f * 3 + c], ref); if (!Number.isFinite(x)) { ok = false; break; } sum += x; }
      const k = f * 4;
      if (!ok) { M.values[f] = NaN; M.colors[k + 3] = 0; continue; }
      const val = sum / 3, u = Math.max(-1, Math.min(1, val / S));
      const end = u < 0 ? NEG : POS, w = Math.abs(u);
      M.values[f] = val;
      M.colors[k] = MID[0] + (end[0] - MID[0]) * w;
      M.colors[k + 1] = MID[1] + (end[1] - MID[1]) * w;
      M.colors[k + 2] = MID[2] + (end[2] - MID[2]) * w;
      M.colors[k + 3] = alpha;
    }
    return S;
  }

  function gradientCss() {
    return `linear-gradient(90deg, rgb(${NEG}), rgb(${MID}), rgb(${POS}))`;
  }

  root.Mesh = { parse, update, scaleFor, nodeValue, gradientCss };
})(window);
