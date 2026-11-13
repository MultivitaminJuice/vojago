// Stretches driven more than once. When the same road is driven on several days
// (out and back), the lines lie exactly on top of each other and the later one
// hides the earlier one. This finds the pieces where several passes coincide; the
// map draws them nested on top: the earliest pass wide, every later one narrower,
// so each day's colour stays visible.
// Pure computation, no DOM; points are { lat, lon, time, … }.
const METERS_PER_DEGREE = 111_320;

/**
 * Width of the nested line: rank 0 (earliest pass) is the widest, every later
 * one narrower; at most four steps. The normal route width is 5.
 */
export function lineWidth(rank, count) {
  const steps = Math.min(Math.max(count, 2), 4);
  const r = Math.min(Math.max(rank, 0), steps - 1);
  return Number((6.4 - r * (4.2 / (steps - 1))).toFixed(2));
}

/**
 * Finds the pieces of the route that several passes share.
 * `segments`: the drawn line pieces (lists of points). A pass ends at the end of
 * a piece or at a time gap (`gapMs`) between two points.
 * Returns runs { coords: [[lon, lat], …], point (for the colour), rank (0 = earliest), count }
 * sorted by rank (the narrow ones on top). Short touches (crossings, a shared
 * parking spot) below `minLengthM` do not count.
 */
export function findRepeatedStretches(segments, { radiusM = 45, stepM = 25, minLengthM = 120, maxRunM = 200, gapMs = 300_000 } = {}) {
  // 1. Build the passes
  const passes = [];
  for (const segment of segments || []) {
    let current = null;
    for (const p of segment) {
      const t = Date.parse(p.time || "");
      const isNew = !current || (Number.isFinite(t) && Number.isFinite(current.last) && t - current.last > gapMs);
      if (isNew) { current = { points: [], start: t, last: t }; passes.push(current); }
      current.points.push(p);
      if (Number.isFinite(t)) current.last = t;
    }
  }
  const real = passes.filter((f) => f.points.length > 1);
  if (real.length < 2) return [];
  real.forEach((f, i) => { f.index = i; });
  // Rank = order by first timestamp (without time: by position in the list)
  [...real].sort((a, b) => (Number.isFinite(a.start) && Number.isFinite(b.start) ? a.start - b.start : 0) || a.index - b.index)
    .forEach((f, i) => { f.rank = i; });

  const mLon = METERS_PER_DEGREE * Math.cos(((real[0].points[0].lat || 0) * Math.PI) / 180);
  const X = (p) => p.lon * mLon;
  const Y = (p) => p.lat * METERS_PER_DEGREE;

  // 2. Resample every pass at even distances
  for (const f of real) {
    const s = [];
    f.points.forEach((a, i) => {
      s.push({ x: X(a), y: Y(a), lon: a.lon, lat: a.lat, point: a });
      const b = f.points[i + 1];
      if (!b) return;
      const dx = X(b) - X(a);
      const dy = Y(b) - Y(a);
      const d = Math.hypot(dx, dy);
      for (let k = 1; k * stepM < d - 1e-6; k++) {
        const t = (k * stepM) / d;
        s.push({ x: X(a) + t * dx, y: Y(a) + t * dy, lon: a.lon + t * (b.lon - a.lon), lat: a.lat + t * (b.lat - a.lat), point: a });
      }
    });
    f.samples = s;
  }

  // 3. Grid of cells the size of the radius
  const cell = (v) => Math.floor(v / radiusM);
  const cellKey = (cx, cy) => (cx + 1e6) * 4e6 + (cy + 1e6);
  const grid = new Map();
  for (const f of real) {
    f.samples.forEach((s, i) => {
      const k = cellKey(cell(s.x), cell(s.y));
      (grid.get(k) || grid.set(k, []).get(k)).push([f, i]);
    });
  }

  // 4. Per sample: which other passes are close?
  const r2 = radiusM * radiusM;
  for (const f of real) {
    f.marked = f.samples.map((s) => {
      const others = new Set();
      const cx = cell(s.x);
      const cy = cell(s.y);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const [g, j] of grid.get(cellKey(cx + dx, cy + dy)) || []) {
            if (g === f || others.has(g)) continue;
            const q = g.samples[j];
            if ((q.x - s.x) ** 2 + (q.y - s.y) ** 2 <= r2) others.add(g);
          }
        }
      }
      if (!others.size) return null;
      let rank = 0;
      for (const g of others) if (g.rank < f.rank) rank++;
      return { rank, count: Math.min(others.size + 1, 4) };
    });
  }

  // 5. Build connected pieces, drop short ones, split into runs of the same step
  const runs = [];
  for (const f of real) {
    const s = f.samples;
    let i = 0;
    while (i < s.length) {
      if (!f.marked[i]) { i++; continue; }
      let j = i;
      let length = 0;
      while (j + 1 < s.length && f.marked[j + 1]) { length += Math.hypot(s[j + 1].x - s[j].x, s[j + 1].y - s[j].y); j++; }
      if (length >= minLengthM) {
        let start = i;
        let run = 0;
        for (let k = i + 1; k <= j + 1; k++) {
          const changes = k > j || f.marked[k].rank !== f.marked[start].rank || f.marked[k].count !== f.marked[start].count;
          if (k <= j) run += Math.hypot(s[k].x - s[k - 1].x, s[k].y - s[k - 1].y);
          if (changes || run >= maxRunM) {
            // the run ends at sample k, so two runs join without a gap
            const end = Math.min(k, s.length - 1);
            const part = s.slice(start, end + 1);
            if (part.length > 1) {
              const m = f.marked[start];
              runs.push({ coords: part.map((q) => [q.lon, q.lat]), point: part[Math.floor(part.length / 2)].point, rank: m.rank, count: m.count });
            }
            start = k;
            run = 0;
          }
        }
      }
      i = j + 1;
    }
  }
  return runs.sort((a, b) => a.rank - b.rank);
}
