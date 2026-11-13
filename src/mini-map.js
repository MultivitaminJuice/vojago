// Small map for the day card in the logbook: put together from map tiles, with
// the route drawn on top as a line. Pure computation (Web Mercator), no DOM.
const TILE = 256;

/** World pixel (tile size 256) of a point at a zoom level. */
export function mercatorPx(lon, lat, z) {
  const n = TILE * 2 ** z;
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
}

/**
 * Picks the largest zoom level at which all points fit into w × h (with margin
 * `pad`) and returns the tiles needed with their position, plus `project` for the route.
 */
export function mapView(points, w, h, { pad = 18, minZoom = 4, maxZoom = 15 } = {}) {
  const g = (points || []).filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
  if (g.length < 2) return null;
  const lons = g.map((p) => p.lon);
  const lats = g.map((p) => p.lat);
  const west = Math.min(...lons), east = Math.max(...lons), south = Math.min(...lats), north = Math.max(...lats);
  const extent = (z) => {
    const a = mercatorPx(west, north, z), b = mercatorPx(east, south, z);
    return { a, b, width: b.x - a.x, height: b.y - a.y };
  };

  let zoom = minZoom;
  for (let z = maxZoom; z >= minZoom; z--) {
    const e = extent(z);
    if (e.width <= w - 2 * pad && e.height <= h - 2 * pad) { zoom = z; break; }
  }
  const { a, b } = extent(zoom);
  const ox = (a.x + b.x) / 2 - w / 2;
  const oy = (a.y + b.y) / 2 - h / 2;
  const n = 2 ** zoom;

  const tiles = [];
  for (let ty = Math.floor(oy / TILE); ty <= Math.floor((oy + h - 1) / TILE); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(ox / TILE); tx <= Math.floor((ox + w - 1) / TILE); tx++) {
      tiles.push({ z: zoom, x: ((tx % n) + n) % n, y: ty, left: tx * TILE - ox, top: ty * TILE - oy });
    }
  }
  const project = (lon, lat) => { const p = mercatorPx(lon, lat, zoom); return { x: p.x - ox, y: p.y - oy }; };
  return { zoom, tiles, project };
}

/** Tile address from a template with {z}/{x}/{y}. */
export const tileUrl = (template, t) => template.replace("{z}", t.z).replace("{x}", t.x).replace("{y}", t.y);

/** Route as an SVG path (simplified to at most `maxPoints` points). */
export function routePath(points, project, maxPoints = 90) {
  const g = (points || []).filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
  if (g.length < 2) return "";
  const step = Math.max(1, Math.ceil(g.length / maxPoints));
  const pts = g.filter((_, i) => i % step === 0);
  if (pts[pts.length - 1] !== g[g.length - 1]) pts.push(g[g.length - 1]);
  return "M" + pts.map((p) => { const q = project(p.lon, p.lat); return `${q.x.toFixed(1)},${q.y.toFixed(1)}`; }).join(" L");
}
