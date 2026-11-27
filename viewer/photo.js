/* Simulated aerial photo for one photo point.
 *
 * Renders what a vertical photo would roughly look like:
 *   - Esri World Imagery cut to the photo's exact ground footprint, turned so
 *     the flight direction is up (as in the camera's frame)
 *   - lighting for the sun at the photo time: overall brightness and contrast
 *     follow the sun elevation; low sun adds warm light and haze
 *   - sun glint: on water only (water outlines from the basemap's vector
 *     tiles), brightness falls off with the angle from the sun's mirror
 *     direction (geometry.js), like the reflection off a lightly rippled sea
 * Limits: the satellite image has its own sun, shadows, tide and season baked
 * in; clouds and waves are not modelled. Treat it as an illustration.
 */
(function (root) {
  'use strict';
  const IMAGERY = {
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256, maxzoom: 19,
    attribution: 'Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  };
  const VECTOR_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
  const MAX_W = 460;
  let el = null, photoMap = null, maskMap = null, vectorSource = null, current = null, onCloseCb = null;

  const DEG = Math.PI / 180;
  const zoomFor = (lat, metersPerPixel) => Math.log2(40075016.686 * Math.cos(lat * DEG) / (512 * metersPerPixel));

  async function getVectorSource() {
    if (vectorSource) return vectorSource;
    const style = await (await fetch(VECTOR_STYLE)).json();
    const [name, src] = Object.entries(style.sources).find(([, s]) => s.type === 'vector');
    const waterLayer = style.layers.find(l => l.type === 'fill' && l['source-layer'] === 'water');
    vectorSource = { name, src, sourceLayer: waterLayer ? waterLayer['source-layer'] : 'water' };
    return vectorSource;
  }

  function build(container) {
    el = document.createElement('div');
    el.className = 'photo-preview';
    el.innerHTML = `
      <div class="pp-head"><b id="pp-title"></b><button type="button" class="x" id="pp-close" title="Close">×</button></div>
      <div class="pp-stage" id="pp-stage">
        <div class="pp-map" id="pp-map"></div>
        <div class="pp-light" id="pp-light"></div>
        <canvas class="pp-glint" id="pp-glint"></canvas>
        <svg class="pp-compass" id="pp-compass" width="58" height="58"></svg>
        <div class="pp-status" id="pp-status">Rendering…</div>
      </div>
      <div class="pp-mask" id="pp-mask-wrap"><div id="pp-mask"></div></div>
      <div class="pp-info" id="pp-info"></div>
      <div class="pp-credit">${IMAGERY.attribution}. Simulated lighting and glint; the imagery has its own sun, shadows and tide.</div>`;
    container.appendChild(el);
    el.querySelector('#pp-close').addEventListener('click', close);
  }

  function close() {
    if (photoMap) { photoMap.remove(); photoMap = null; }
    if (maskMap) { maskMap.remove(); maskMap = null; }
    if (el) { el.remove(); el = null; }
    current = null;
    if (onCloseCb) onCloseCb();
  }

  // opts: { container, lon, lat, cam, ms, title, subtitle, tz, minSun, onClose }
  async function open(opts) {
    onCloseCb = opts.onClose || null;
    if (!el) build(opts.container);
    const token = current = {};
    const { lon, lat, cam, ms } = opts;
    const sun = Geo.sunPosition(ms, lat, lon);
    const W = Math.min(MAX_W, opts.container.clientWidth - 40);
    const H = Math.round(W * cam.along / cam.across);       // across-track is horizontal
    const stage = el.querySelector('#pp-stage');
    stage.style.width = `${W}px`; stage.style.height = `${H}px`;
    el.querySelector('#pp-mask-wrap').style.cssText = `width:${W}px;height:${H}px`;
    el.querySelector('#pp-title').textContent = opts.title;
    const status = el.querySelector('#pp-status');
    status.hidden = false; status.textContent = 'Rendering…';

    const camera = { center: [lon, lat], zoom: zoomFor(lat, cam.along / H), bearing: cam.heading, pitch: 0 };
    const light = lighting(sun);

    // Satellite image, cropped to the footprint and turned to the flight direction.
    if (!photoMap) {
      photoMap = new maplibregl.Map({
        container: el.querySelector('#pp-map'), interactive: false, attributionControl: false, fadeDuration: 0,
        style: { version: 8, sources: { img: { type: 'raster', ...IMAGERY } },
                 layers: [{ id: 'img', type: 'raster', source: 'img', paint: {} }] },
        ...camera,
      });
    } else {
      photoMap.resize(); photoMap.jumpTo(camera);
    }
    const applyLight = () => {
      photoMap.setPaintProperty('img', 'raster-brightness-max', light.brightness);
      photoMap.setPaintProperty('img', 'raster-contrast', light.contrast);
      photoMap.setPaintProperty('img', 'raster-saturation', light.saturation);
    };
    if (photoMap.isStyleLoaded()) applyLight(); else photoMap.once('load', applyLight);
    const lightDiv = el.querySelector('#pp-light');
    lightDiv.style.background = light.overlay;
    lightDiv.style.mixBlendMode = light.blend;

    drawCompass(cam.heading, sun);
    el.querySelector('#pp-info').innerHTML = info(opts, sun, cam);

    // Glint on water.
    const canvas = el.querySelector('#pp-glint');
    canvas.width = W; canvas.height = H;
    canvas.getContext('2d').clearRect(0, 0, W, H);
    if (sun.elevation <= 0) { status.textContent = 'Night: no light for a photo.'; return; }
    try {
      const mask = await waterMask(camera, W, H);
      if (token !== current) return;
      paintGlint(canvas, mask, cam, sun, W, H);
    } catch (e) {
      if (token !== current) return;
      status.textContent = 'Glint not shown (water outlines unavailable).';
      return;
    }
    await new Promise(r => photoMap.loaded() ? r() : photoMap.once('idle', r));
    if (token === current) status.hidden = true;
  }

  // Overall lighting from sun elevation.
  function lighting(sun) {
    const e = Math.max(0, sun.elevation);
    const k = Math.max(0.3, Math.min(1, Math.sin(e * DEG) / Math.sin(45 * DEG)));   // irradiance vs a 45° sun
    const low = Math.max(0, Math.min(1, (30 - e) / 30));                            // 1 at horizon, 0 above 30°
    return {
      brightness: 0.35 + 0.65 * k,
      contrast: -0.25 * low,
      saturation: -0.15 * low,
      overlay: `linear-gradient(rgba(255,150,70,${(0.32 * low).toFixed(2)}), rgba(255,150,70,${(0.32 * low).toFixed(2)})), rgba(190,205,225,${(0.12 * low).toFixed(2)})`,
      blend: 'soft-light',
    };
  }

  // Render water polygons white-on-black with the same camera, then read the pixels.
  async function waterMask(camera, W, H) {
    const vs = await getVectorSource();
    const style = {
      version: 8, sources: { v: vs.src },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#000' } },
        { id: 'water', type: 'fill', source: 'v', 'source-layer': vs.sourceLayer, paint: { 'fill-color': '#fff', 'fill-antialias': false } },
      ],
    };
    if (!maskMap) {
      maskMap = new maplibregl.Map({
        container: el.querySelector('#pp-mask'), interactive: false, attributionControl: false, fadeDuration: 0,
        preserveDrawingBuffer: true, pixelRatio: 1, style, ...camera,
      });
    } else {
      maskMap.resize(); maskMap.jumpTo(camera);
    }
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 15000);
      const done = () => { clearTimeout(t); resolve(); };
      maskMap.once('idle', done);
      maskMap.triggerRepaint();
    });
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.drawImage(maskMap.getCanvas(), 0, 0, W, H);
    return ctx.getImageData(0, 0, W, H).data;
  }

  // Glint brightness per pixel, on water only.
  // Cox & Munk (1954) wave-slope statistics: a ground point glints when a wave
  // facet tilted by half the off-mirror angle exists; the chance of that tilt is
  // exp(-tan²(tilt) / σ²), with σ² = 0.003 + 0.00512 × wind speed (m/s).
  // The sun is so bright that even a small fraction of glinting facets
  // saturates the photo, so strength is scaled up and clipped.
  const WIND = 5;      // m/s, light breeze
  function paintGlint(canvas, mask, cam, sun, W, H) {
    const off = Geo.offAngleFn(cam, sun);
    const h = cam.heading * DEG, sh = Math.sin(h), ch = Math.cos(h);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(W, H);
    const sigma2 = 0.003 + 0.00512 * WIND;
    let max = 0;
    for (let py = 0; py < H; py++) {
      const ua = (0.5 - (py + 0.5) / H) * cam.along;          // metres forward of the photo centre
      for (let px = 0; px < W; px++) {
        const i = (py * W + px) * 4;
        if (mask[i] < 128) continue;                            // not water
        const uc = ((px + 0.5) / W - 0.5) * cam.across;        // metres right of the photo centre
        const x = ua * sh + uc * ch, y = ua * ch - uc * sh;     // east, north
        const a = off(x, y);
        const t = Math.tan(a / 2 * DEG);
        const g = Math.exp(-(t * t) / sigma2);                  // share of glinting facets, 0..1
        if (g < 0.02) continue;
        max = Math.max(max, g);
        img.data[i] = 255; img.data[i + 1] = 250; img.data[i + 2] = 235;
        img.data[i + 3] = Math.round(255 * Math.min(1, 1.8 * g));
      }
    }
    ctx.putImageData(img, 0, 0);
    canvas.dataset.maxGlint = max.toFixed(3);
  }

  function drawCompass(heading, sun) {
    const svg = el.querySelector('#pp-compass');
    const rot = (deg) => deg - heading;      // screen angle of a compass direction (up = flight direction)
    const arrow = (deg, len, color, label) => {
      const a = rot(deg) * DEG, x = 29 + Math.sin(a) * len, y = 29 - Math.cos(a) * len;
      return `<line x1="29" y1="29" x2="${x}" y2="${y}" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
              <text x="${29 + Math.sin(a) * (len + 8)}" y="${29 - Math.cos(a) * (len + 8) + 4}" text-anchor="middle" fill="${color}" font-size="10" font-weight="700">${label}</text>`;
    };
    svg.innerHTML = `<circle cx="29" cy="29" r="27" fill="rgba(0,0,0,.45)"/>` +
      arrow(0, 15, '#fff', 'N') + (sun.elevation > 0 ? arrow(sun.azimuth, 15, '#ffcf4a', '☀') : '');
  }

  function info(o, sun, cam) {
    const g = Geo.glare(o.lon, o.lat, o.ms, cam);
    const glint = sun.elevation <= 0 ? '—'
      : g.inFrame ? '<span class="pp-bad">in the photo</span>'
      : g.glareInFrame ? '<span class="pp-warn">possible near the edge</span>' : '<span class="pp-good">none</span>';
    const sh = Geo.shadow(sun);
    return `<div class="kv">
      <span>Time</span><b>${o.subtitle}</b>
      <span>Sun</span><b>${sun.elevation > 0 ? `${sun.elevation.toFixed(1)}° high, from the ${Geo.compass(sun.azimuth)}` : 'below the horizon'}${sun.elevation > 0 && sun.elevation < o.minSun ? ` <span class="pp-warn">below the ${o.minSun}° minimum</span>` : ''}</b>
      <span>Sun glint</span><b>${glint}</b>
      <span>Shadows</span><b>${sh ? `toward the ${Geo.compass(sh.direction)}, ${sh.length.toFixed(0)} m for a 10 m object` : '—'}</b>
      <span>Footprint</span><b>${(cam.across / 1000).toFixed(2)} × ${(cam.along / 1000).toFixed(2)} km from ${Math.round(cam.height).toLocaleString()} m</b>
    </div>`;
  }

  const api = { open, close, isOpen: () => !!el };
  root.PhotoPreview = api;
})(window);
