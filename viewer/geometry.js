/* Photo geometry for the NGS flight planning viewer ("level 1" photo preview).
 *
 * Everything here is derived from the flight-lines file and the time:
 *   camera   flying height = focal length x photo scale; footprint = image
 *            format x scale; field of view from footprint and height.
 *   sun      solar elevation and azimuth (standard astronomical formulas,
 *            accurate to a few tenths of a degree).
 *   glare    where the sun's mirror reflection on calm water lands relative
 *            to the photo, and the zone where wavy water (facets tilted up to
 *            GLARE_TILT degrees) can still reflect the sun into the camera.
 *   shadows  direction and length of shadows.
 * Assumes a vertical (nadir) camera and flat ground/water at the ground
 * elevation in the file (0 for all files seen so far).
 *
 * Works in the browser (window.Geo) and in Node (module.exports) for tests.
 */
(function (root) {
  'use strict';
  const DEG = Math.PI / 180, FT = 0.3048, DAY_MS = 86400000;
  const GLARE_TILT = 10;   // degrees: typical wave-facet tilt for a moderate breeze

  // ---------------------------------------------------------------- sun
  // Solar position (geometric, no refraction), after the NOAA/Meeus low-precision formulas.
  function sunPosition(ms, lat, lon) {
    const d = ms / DAY_MS - 0.5 + 2440588 - 2451545;         // days since J2000.0
    const M = DEG * (357.5291 + 0.98560028 * d);              // mean anomaly
    const C = DEG * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const L = M + C + DEG * 102.9372 + Math.PI;               // ecliptic longitude
    const e = DEG * 23.4397;                                  // obliquity
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
    const H = DEG * (280.16 + 360.9856235 * d) + DEG * lon - ra;   // local hour angle
    const phi = DEG * lat;
    const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
    const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
    return { elevation: alt / DEG, azimuth: ((az / DEG) + 180 + 360) % 360 };   // azimuth from north, clockwise
  }

  // ---------------------------------------------------------------- local coordinates
  const M_PER_DEG_LAT = 111132;
  function offset(lon, lat, east, north) {
    return [lon + east / (M_PER_DEG_LAT * Math.cos(lat * DEG)), lat + north / M_PER_DEG_LAT];
  }
  function bearing(lon1, lat1, lon2, lat2) {
    const p1 = lat1 * DEG, p2 = lat2 * DEG, dl = (lon2 - lon1) * DEG;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return ((Math.atan2(y, x) / DEG) + 360) % 360;
  }
  function compass(deg) {
    return ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(deg / 22.5) % 16];
  }

  // ---------------------------------------------------------------- camera
  // Camera geometry for one flight line, from its flight-lines file row.
  // Returns null if the needed columns are missing.
  function camera(line) {
    const a = line.attrs || {};
    const num = (k) => { const v = parseFloat(a[k]); return Number.isFinite(v) ? v : null; };
    const scale = num('SCALE'), focal = num('FocalLength(M)'), fx = num('FormatX(FT)'), fy = num('FormatY(FT)');
    if (!scale || !focal || !fx || !fy) return null;
    const ground = num('GRND_EL') || 0;
    const lap = num('LAP') ?? 60, photos = num('PHOTOS') || line.photos, feet = num('FEET');
    const sizeX = fx * scale * FT, sizeY = fy * scale * FT;           // ground footprint (m)
    // Which image side runs along the flight line? The one whose (1 - overlap)
    // share matches the spacing between photos (FormatX in all files seen).
    const spacing = feet && photos > 1 ? feet * FT / (photos - 1) : null;
    let along = sizeX, across = sizeY;
    if (spacing && Math.abs(sizeY * (1 - lap / 100) - spacing) < Math.abs(sizeX * (1 - lap / 100) - spacing)) {
      along = sizeY; across = sizeX;
    }
    const height = focal * scale;                                     // above ground (m)
    const [s, e] = line.coords;
    return {
      height, groundElevation: ground, along, across, spacing, overlap: lap, scale, focal,
      fovAlong: 2 * Math.atan(along / 2 / height) / DEG,
      fovAcross: 2 * Math.atan(across / 2 / height) / DEG,
      heading: bearing(s[0], s[1], e[0], e[1]),
    };
  }

  // Footprint rectangle of one photo, as [lon, lat] corners.
  function footprint(lon, lat, cam) {
    const h = cam.heading * DEG;
    const a = [Math.sin(h), Math.cos(h)], c = [Math.cos(h), -Math.sin(h)];   // along, across unit vectors (E, N)
    return [[1, 1], [1, -1], [-1, -1], [-1, 1], [1, 1]].map(([i, j]) =>
      offset(lon, lat, i * a[0] * cam.along / 2 + j * c[0] * cam.across / 2,
                       i * a[1] * cam.along / 2 + j * c[1] * cam.across / 2));
  }

  // ---------------------------------------------------------------- glare
  // Sun glare for a vertical photo taken at (lon, lat) at time ms.
  function glare(lon, lat, ms, cam, tilt = GLARE_TILT) {
    const sun = sunPosition(ms, lat, lon);
    if (sun.elevation <= 0) return { sun, night: true };
    const H = cam.height, el = sun.elevation * DEG, az = sun.azimuth * DEG;
    const sh = [Math.sin(az), Math.cos(az)];                         // toward the sun, horizontal
    const dist = H * Math.tan(Math.PI / 2 - el);                     // nadir -> mirror point (m)
    const centre = [sh[0] * dist, sh[1] * dist];                     // mirror point, metres E/N of nadir
    const refl = [-sh[0] * Math.cos(el), -sh[1] * Math.cos(el), Math.sin(el)];   // reflected sun ray
    // Angle (deg) between the reflected sun ray and the line of sight from ground point (x, y) to the camera.
    const offAngle = (x, y) => {
      const n = Math.hypot(x, y, H);
      const dot = (-x * refl[0] - y * refl[1] + H * refl[2]) / n;
      return Math.acos(Math.max(-1, Math.min(1, dot))) / DEG;
    };
    // Position of the mirror point in the photo's own frame (along/across track).
    const h = cam.heading * DEG;
    const alongOff = centre[0] * Math.sin(h) + centre[1] * Math.cos(h);
    const acrossOff = centre[0] * Math.cos(h) - centre[1] * Math.sin(h);
    const inFrame = Math.abs(alongOff) <= cam.along / 2 && Math.abs(acrossOff) <= cam.across / 2;
    // Smallest off-mirror angle anywhere in the frame (11 x 11 grid).
    let minAngle = Infinity;
    for (let i = -5; i <= 5; i++) for (let j = -5; j <= 5; j++) {
      const ua = i / 10 * cam.along, uc = j / 10 * cam.across;
      const x = ua * Math.sin(h) + uc * Math.cos(h), y = ua * Math.cos(h) - uc * Math.sin(h);
      minAngle = Math.min(minAngle, offAngle(x, y));
    }
    if (inFrame) minAngle = 0;
    // Glare zone: ground points within 2 x tilt of the mirror direction.
    let zone = null;
    if (dist < 6 * H) {
      zone = [];
      for (let b = 0; b <= 360; b += 10) {
        const dir = [Math.sin(b * DEG), Math.cos(b * DEG)];
        let lo = 0, hi = 6 * H;
        if (offAngle(centre[0] + dir[0] * hi, centre[1] + dir[1] * hi) < 2 * tilt) lo = hi;
        else for (let k = 0; k < 30; k++) {
          const mid = (lo + hi) / 2;
          if (offAngle(centre[0] + dir[0] * mid, centre[1] + dir[1] * mid) < 2 * tilt) lo = mid; else hi = mid;
        }
        zone.push(offset(lon, lat, centre[0] + dir[0] * lo, centre[1] + dir[1] * lo));
      }
    }
    return {
      sun, night: false, distance: dist, centre: offset(lon, lat, centre[0], centre[1]),
      inFrame, minAngle, glareInFrame: minAngle <= 2 * tilt, zone, tilt,
      // Sun elevation above which the mirror point enters the frame (sun straight along/across track).
      enterElevation: 90 - Math.atan(Math.min(cam.along, cam.across) / 2 / H) / DEG,
    };
  }

  // Function (x, y) -> angle (deg) between the line of sight from ground
  // point (x m east, y m north of the photo centre) to the camera and the
  // sun's mirror reflection. 0 = looking straight at the sun's reflection.
  function offAngleFn(cam, sun) {
    const H = cam.height, el = sun.elevation * DEG, az = sun.azimuth * DEG;
    const refl = [-Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), Math.sin(el)];
    return (x, y) => {
      const n = Math.hypot(x, y, H);
      const dot = (-x * refl[0] - y * refl[1] + H * refl[2]) / n;
      return Math.acos(Math.max(-1, Math.min(1, dot))) / DEG;
    };
  }

  // Shadow of a vertical object.
  function shadow(sun, objectHeight = 10) {
    if (sun.elevation <= 0) return null;
    return { length: objectHeight / Math.tan(sun.elevation * DEG), direction: (sun.azimuth + 180) % 360, objectHeight };
  }

  const api = { sunPosition, bearing, compass, camera, footprint, glare, shadow, offset, offAngleFn, GLARE_TILT, FT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Geo = api;
})(typeof window !== 'undefined' ? window : globalThis);
