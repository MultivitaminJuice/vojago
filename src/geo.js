// Geographic helpers: distances, smoothing, bounding boxes.

const R = 6371; // earth radius in km

/** Distance between two points in kilometres. */
export function distanceKm(lon1, lat1, lon2, lat2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const crValue = (p0, p1, p2, p3, t, key) => {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (
    2 * p1[key] +
    (-p0[key] + p2[key]) * t +
    (2 * p0[key] - 5 * p1[key] + 4 * p2[key] - p3[key]) * t2 +
    (-p0[key] + 3 * p1[key] - 3 * p2[key] + p3[key]) * t3
  );
};

/**
 * Densifies waypoints into a smooth route (Catmull-Rom) and adds the running
 * distance `cum` (km) and the trip day `day` to every point.
 * @param {Array<{lon,lat,elev,spd,night?:boolean}>} waypoints
 * @param {number} steps intermediate points per section
 */
export function buildPath(waypoints, steps = 14) {
  const pts = [];
  let day = 1;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const p0 = waypoints[i - 1] || waypoints[i];
    const p1 = waypoints[i];
    const p2 = waypoints[i + 1];
    const p3 = waypoints[i + 2] || waypoints[i + 1];
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      pts.push({
        lon: crValue(p0, p1, p2, p3, t, "lon"),
        lat: crValue(p0, p1, p2, p3, t, "lat"),
        elev: p1.elev + (p2.elev - p1.elev) * t,
        spd: p1.spd + (p2.spd - p1.spd) * t,
        day,
      });
    }
    if (p2.night) day++;
  }
  const last = waypoints[waypoints.length - 1];
  pts.push({ lon: last.lon, lat: last.lat, elev: last.elev, spd: last.spd, day });

  let cum = 0;
  pts[0].cum = 0;
  for (let i = 1; i < pts.length; i++) {
    cum += distanceKm(pts[i - 1].lon, pts[i - 1].lat, pts[i].lon, pts[i].lat);
    pts[i].cum = cum;
  }
  return pts;
}

export const pathLengthKm = (path) => (path.length ? path[path.length - 1].cum : 0);

// GPS noise while standing: consecutive fixes "jump" a few metres back and
// forth (e.g. multipath next to buildings — seen on 5 September 2026 as a
// visible loop on a parking lot while the vehicle stood still). Display only:
// just the derived path is smoothed, the stored positions stay untouched (see
// callers). A fix within STANDING_RADIUS_M of the current anchor AND with a low
// speed takes the anchor's position instead of its own; a fix outside the
// radius sets a new anchor (real, if slow, movement stays visible). The speed
// threshold is lower than the one for detecting stops: this only smooths
// obvious noise while clearly standing still.
const STANDING_RADIUS_M = 12;
const STANDING_MAX_KMH = 3;

export function smoothStandingNoise(waypoints) {
  let anchor = null;
  return waypoints.map((w) => {
    if ((w.spd || 0) > STANDING_MAX_KMH) { anchor = null; return w; }
    if (anchor && distanceKm(anchor.lon, anchor.lat, w.lon, w.lat) * 1000 <= STANDING_RADIUS_M) {
      return { ...w, lat: anchor.lat, lon: anchor.lon };
    }
    anchor = { lat: w.lat, lon: w.lon };
    return w;
  });
}

export function bounds(path) {
  const b = { minLon: 180, minLat: 90, maxLon: -180, maxLat: -90 };
  for (const p of path) {
    if (p.lon < b.minLon) b.minLon = p.lon;
    if (p.lon > b.maxLon) b.maxLon = p.lon;
    if (p.lat < b.minLat) b.minLat = p.lat;
    if (p.lat > b.maxLat) b.maxLat = p.lat;
  }
  return b;
}

export function elevationRange(path) {
  let min = Infinity, max = -Infinity;
  for (const p of path) {
    if (p.elev < min) min = p.elev;
    if (p.elev > max) max = p.elev;
  }
  if (max - min < 1) max = min + 1;
  return { min, max };
}

/** Point on the route at a given kilometre mark. */
export function pointAtKm(path, km) {
  for (let i = 1; i < path.length; i++) {
    if (path[i].cum >= km) {
      const a = path[i - 1], b = path[i];
      const f = b.cum > a.cum ? (km - a.cum) / (b.cum - a.cum) : 0;
      return { lon: a.lon + (b.lon - a.lon) * f, lat: a.lat + (b.lat - a.lat) * f };
    }
  }
  return path[path.length - 1];
}

/** A sensible spacing for kilometre markers (about seven of them). */
export function kmMarkerStep(total) {
  const raw = total / 7;
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  const n = raw / p;
  return Math.max(10, (n >= 5 ? 5 : n >= 2 ? 2 : 1) * p);
}

/**
 * Simplify a line for drawing (Douglas-Peucker): points that deviate less than
 * `toleranceM` metres from the connection of their neighbours are dropped. The
 * first and last points stay, the remaining points are unchanged (with all
 * fields such as `cum`, `time`, `day`). For drawing only — statistics
 * (kilometres, elevation, driving time) keep using the full path.
 *
 * Background: phones struggled to draw tens of thousands of points twice (base
 * line and colour gradient) — parts of the line were missing or drawn as a
 * straight line across the map. With 3 m tolerance about 10 % of the points
 * remain, with no visible difference.
 */
export function simplify(points, toleranceM = 3) {
  const n = points?.length || 0;
  if (n <= 2) return points || [];
  const k = Math.cos((points[0].lat * Math.PI) / 180);
  const m = 111320;
  const X = (p) => p.lon * k * m;
  const Y = (p) => p.lat * m;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = X(points[a]), ay = Y(points[a]);
    const dx = X(points[b]) - ax, dy = Y(points[b]) - ay;
    const length2 = dx * dx + dy * dy;
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = X(points[i]) - ax, py = Y(points[i]) - ay;
      const t = length2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / length2)) : 0;
      const distance = Math.hypot(px - t * dx, py - t * dy);
      if (distance > max) { max = distance; idx = i; }
    }
    if (max > toleranceM && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Metres per screen pixel at a zoom level (MapLibre, 512 px tiles) on a latitude. */
export const metersPerPixel = (zoom, lat) => (78271.517 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;

/**
 * All passes of the route at a tap position. When the same road was driven
 * more than once (out and back), several pieces of the route lie within the
 * tolerance — for each pass the nearest point is returned, in time order. Two
 * points belong to the same pass while at most `gapMs` lies between them
 * (without timestamps: 30 points). Works on the full path (not the simplified
 * drawing), so kilometres, time and speed are exact. Equirectangular
 * approximation: plenty for tap distances of a few hundred metres.
 */
export function routeHits(path, lon, lat, toleranceM, gapMs = 300_000) {
  if (!Array.isArray(path) || !path.length) return [];
  const mLat = 111_320;
  const mLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  const limit = toleranceM * toleranceM;
  const passes = [];
  let current = null;
  for (let i = 0; i < path.length; i++) {
    const dx = (path[i].lon - lon) * mLon;
    const dy = (path[i].lat - lat) * mLat;
    const distance2 = dx * dx + dy * dy;
    if (distance2 > limit) continue;
    const time = Date.parse(path[i].time || "");
    const samePass = current && (Number.isFinite(time) && Number.isFinite(current.lastTime)
      ? time - current.lastTime <= gapMs
      : i - current.lastIndex <= 30);
    if (!samePass) {
      current = { point: path[i], index: i, distance2, lastIndex: i, lastTime: time };
      passes.push(current);
      continue;
    }
    if (distance2 < current.distance2) { current.point = path[i]; current.index = i; current.distance2 = distance2; }
    current.lastIndex = i;
    current.lastTime = time;
  }
  return passes.map((d) => ({ point: d.point, index: d.index, distanceM: Math.sqrt(d.distance2) }));
}

/**
 * Of several passes only those that really lie at the same spot as the one
 * nearest to the finger. At a wide zoom 22 pixels are many kilometres — out and
 * back and a detour on separate roads would otherwise all be in the tap area,
 * although they only overlap on screen. `maxM` covers the offset of two drives
 * on the same road (lane, GPS noise, sample spacing).
 */
export function sameSpot(hits, maxM = 100) {
  if (hits.length < 2) return hits;
  const anchor = hits.reduce((b, t) => (t.distanceM < b.distanceM ? t : b)).point;
  const mLat = 111_320;
  const mLon = 111_320 * Math.cos((anchor.lat * Math.PI) / 180);
  return hits.filter((t) => Math.hypot((t.point.lon - anchor.lon) * mLon, (t.point.lat - anchor.lat) * mLat) <= maxM);
}
