// Gaps in the recorded route: two consecutive points lie far apart because the
// tracker delivered nothing in between (radio gap, GPS outage). The map would
// otherwise join them with a straight line as if that stretch had been driven.
// Pure computation, no DOM; points are { lat, lon, time, … }.
const METERS_PER_DEGREE = 111_320;

/**
 * Gaps in a list of line segments. A gap needs at least `minSeconds` without a
 * point AND at least `minMeters` straight-line distance (when standing, points
 * are missing anyway). Returns [{ from, to, seconds, meters }] in route order.
 */
export function findGaps(segments, { minSeconds = 40, minMeters = 500 } = {}) {
  const out = [];
  for (const segment of segments || []) {
    for (let i = 1; i < segment.length; i++) {
      const a = segment[i - 1];
      const b = segment[i];
      const seconds = (Date.parse(b.time || "") - Date.parse(a.time || "")) / 1000;
      if (!(seconds >= minSeconds)) continue;
      const meters = Math.hypot((b.lat - a.lat) * METERS_PER_DEGREE, (b.lon - a.lon) * METERS_PER_DEGREE * Math.cos((a.lat * Math.PI) / 180));
      if (meters >= minMeters) out.push({ from: a, to: b, seconds: Math.round(seconds), meters: Math.round(meters) });
    }
  }
  return out;
}

/** Distance of a point to a segment in metres (equirectangular approximation, good enough for tap distances). */
export function distanceToSegment(lon, lat, a, b) {
  const mLon = METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
  const px = (lon - a.lon) * mLon;
  const py = (lat - a.lat) * METERS_PER_DEGREE;
  const dx = (b.lon - a.lon) * mLon;
  const dy = (b.lat - a.lat) * METERS_PER_DEGREE;
  const length2 = dx * dx + dy * dy;
  const t = length2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / length2)) : 0;
  return Math.hypot(px - t * dx, py - t * dy);
}

/** Duration as "96 s" or "3 min 20 s". */
export function durationText(seconds) {
  if (seconds < 120) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}
