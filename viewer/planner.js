/* Flight planner for the NGS flight planning viewer.
 *
 * Builds sorties (single flights) that fly as many lines as possible, each
 * line flown entirely inside one of its time windows, then combines sorties
 * into whole-project plans:
 *   fewest   fewest sorties: repeatedly take the day whose best sortie covers
 *            the most remaining lines (one sortie per day)
 *   soonest  finish soonest: go day by day, flying the best sortie each day
 *   single   best single flight: the one sortie that covers the most lines
 *
 * Model and assumptions (all editable in the page):
 *   - constant ground speed for photo runs and transits between lines
 *   - a fixed time per turn / line change, added to each transit
 *   - lines can be flown in either direction; transit is a straight line
 *     from the end of one line to the nearer end of the next
 *   - waiting (loitering) for a window to open is allowed up to maxWait
 *   - a sortie is limited to maxSortie from the first line's start to the
 *     last line's end (time to and from the airport is not included)
 *
 * Sorties are found by beam search over line sequences, which is fast and
 * finds very good (not guaranteed optimal) sequences.
 * Works in the browser (window.Planner) and in Node (module.exports).
 */
(function (root) {
  'use strict';
  const KT = 0.514444;               // m/s per knot
  const R_EARTH = 6371000;

  function dist(a, b) {
    const p1 = a[1] * Math.PI / 180, p2 = b[1] * Math.PI / 180;
    const dp = p2 - p1, dl = (b[0] - a[0]) * Math.PI / 180;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.sqrt(h));
  }

  const DEFAULTS = { speedKt: 180, turnMin: 4, maxSortieH: 4, maxWaitMin: 60, overheadH: 1, beam: 150 };

  // lines: [{line, coords:[[lon,lat],[lon,lat]], photos}]
  // windows: Map line -> [[startMs, endMs], ...]
  // dayOf: function(ms) -> day key (string) in the display time zone
  function prepare(lines, windows, opts) {
    const o = { ...DEFAULTS, ...opts };
    const speed = o.speedKt * KT;
    const L = lines.filter(l => (windows.get(l.line) || []).length).map(l => {
      const len = dist(l.coords[0], l.coords[1]);
      return { ...l, len, dur: len / speed * 1000, wins: windows.get(l.line) };
    });
    return { o, speed, L, turn: o.turnMin * 60e3, maxSortie: o.maxSortieH * 3600e3, maxWait: o.maxWaitMin * 60e3,
             overhead: o.overheadH };
  }

  // Best sorties using only lines in `allowed` (Set of names), starting on day
  // `day` (or any day if null): { most: most lines, value: most lines per hour
  // including the per-flight overhead }. Returns null if none.
  function bestSortie(P, allowed, day, dayOf) {
    const cand = P.L.filter(l => allowed.has(l.line));
    if (!cand.length) return null;
    const key = (s) => [-s.legs.length, s.end - s.start, s.start];
    const better = (a, b) => { const ka = key(a), kb = key(b); for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i]; return false; };

    // Start states: any line, any window on the day, either direction, at the window start.
    let beam = [];
    for (const l of cand) for (const [s, e] of l.wins) {
      if (s + l.dur > e) continue;
      if (day && dayOf(s) !== day) continue;
      for (const dir of [0, 1]) {
        beam.push({ start: s, end: s + l.dur, pos: l.coords[1 - dir], used: new Set([l.line]),
                    legs: [{ line: l.line, start: s, end: s + l.dur, dir, wait: 0, transit: 0 }] });
      }
    }
    if (!beam.length) return null;
    const value = (s) => s.legs.length / ((s.end - s.start) / 3600e3 + P.overhead);
    let best = beam.reduce((a, b) => better(b, a) ? b : a);
    let bestVal = beam.reduce((a, b) => value(b) > value(a) ? b : a);
    while (beam.length) {
      const next = [];
      for (const st of beam) {
        for (const l of cand) {
          if (st.used.has(l.line)) continue;
          for (const dir of [0, 1]) {
            const entry = l.coords[dir], exit = l.coords[1 - dir];
            const transit = dist(st.pos, entry) / P.speed * 1000 + P.turn;
            const arrive = st.end + transit;
            for (const [s, e] of l.wins) {
              const t = Math.max(arrive, s);
              if (t + l.dur > e || t - arrive > P.maxWait) continue;
              if (t + l.dur - st.start > P.maxSortie) continue;
              const used = new Set(st.used); used.add(l.line);
              next.push({ start: st.start, end: t + l.dur, pos: exit, used,
                          legs: st.legs.concat({ line: l.line, start: t, end: t + l.dur, dir, wait: t - arrive, transit }) });
              break;   // earliest feasible window is best for this line/direction
            }
          }
        }
      }
      if (!next.length) break;
      next.sort((a, b) => better(a, b) ? -1 : better(b, a) ? 1 : 0);
      // Keep the best states, preferring distinct line sets.
      const seen = new Set(); beam = [];
      for (const s of next) {
        const k = [...s.used].sort().join(',') + '|' + Math.round(s.end / 60e3);
        if (seen.has(k)) continue;
        seen.add(k); beam.push(s);
        if (beam.length >= P.o.beam) break;
      }
      if (better(beam[0], best)) best = beam[0];
      for (const st of beam) if (value(st) > value(bestVal)) bestVal = st;
    }
    return { most: summarize(P, best), value: summarize(P, bestVal) };
  }

  function summarize(P, s) {
    const byName = new Map(P.L.map(l => [l.line, l]));
    const photos = s.legs.reduce((n, g) => n + byName.get(g.line).photos, 0);
    const photoTime = s.legs.reduce((n, g) => n + (g.end - g.start), 0);
    const hours = (s.end - s.start) / 3600e3;
    return { start: s.start, end: s.end, legs: s.legs, lines: s.legs.length, photos,
             hours, photoHours: photoTime / 3600e3, cost: hours + P.overhead };
  }

  // All plans for a project.
  function plans(lines, windows, dayOf, opts) {
    const P = prepare(lines, windows, opts);
    const all = new Set(P.L.map(l => l.line));
    const days = [...new Set(P.L.flatMap(l => l.wins.map(([s]) => dayOf(s))))].sort();
    const noWindow = lines.filter(l => !(windows.get(l.line) || []).length).map(l => l.line);
    const sortie = (left, d, kind) => { const r = bestSortie(P, left, d, dayOf); return r && { ...r[kind], day: d }; };

    const finish = (name, title, why, sorties) => {
      const covered = sorties.reduce((n, s) => n + s.lines, 0);
      const hours = sorties.reduce((n, s) => n + s.hours, 0);
      const cost = hours + sorties.length * P.overhead;
      return { name, title, why, sorties: sorties.sort((a, b) => a.start - b.start), covered,
               total: lines.length, flyable: all.size, hours, cost, overhead: P.overhead,
               linesPerHour: cost ? covered / cost : 0,
               photos: sorties.reduce((n, s) => n + s.photos, 0),
               finish: sorties.length ? Math.max(...sorties.map(s => s.end)) : null, noWindow };
    };
    // Repeatedly take, over the unused days, the sortie that scores best.
    const greedy = (kind, score) => {
      const out = []; const left = new Set(all); const used = new Set();
      while (left.size) {
        let pick = null;
        for (const d of days) {
          if (used.has(d)) continue;
          const s = sortie(left, d, kind);
          if (s && (!pick || score(s) > score(pick) || (score(s) === score(pick) && s.start < pick.start))) pick = s;
        }
        if (!pick) break;
        out.push(pick); used.add(pick.day);
        pick.legs.forEach(g => left.delete(g.line));
      }
      return out;
    };

    const fewest = greedy('most', s => s.lines);
    const value = greedy('value', s => s.lines / s.cost);
    const soonest = []; const left = new Set(all);
    for (const d of days) {
      if (!left.size) break;
      const s = sortie(left, d, 'most');
      if (s) { soonest.push(s); s.legs.forEach(g => left.delete(g.line)); }
    }
    let single = null;
    for (const d of days) {
      const s = sortie(all, d, 'most');
      if (s && (!single || s.lines > single.lines || (s.lines === single.lines && s.hours < single.hours))) single = s;
    }

    let out = [
      finish('value', 'Best value', 'Fewest total hours for the lines covered, counting time in the air and the overhead of each flight.', value),
      finish('fewest', 'Fewest flights', 'Covers the most lines per flight, so the fewest flights are needed.', fewest),
      finish('soonest', 'Finish soonest', 'Flies every day there are windows, so the project finishes as early as possible.', soonest),
      finish('single', 'Best single flight', 'The one flight that covers the most lines, if only one flight is possible.', single ? [single] : []),
    ];
    // Recommend the full-coverage plan with the lowest total hours.
    const full = out.filter(p => p.covered === p.flyable && p.sorties.length);
    const rec = (full.length ? full : out).reduce((a, b) => (b.cost < a.cost ? b : a));
    rec.recommended = true;
    // Drop alternates identical to an earlier plan, keep the recommended one first.
    const sig = (p) => p.sorties.map(s => s.legs.map(g => g.line + '@' + g.start).join(',')).join('|');
    out = [rec, ...out.filter(p => p !== rec)];
    const seen = new Set();
    return out.filter(p => { const k = sig(p); if (seen.has(k) || !p.sorties.length) return false; seen.add(k); return true; });
  }

  const api = { plans, bestSortie, prepare, dist, DEFAULTS, KT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Planner = api;
})(typeof window !== 'undefined' ? window : globalThis);
