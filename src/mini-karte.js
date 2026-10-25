// Kleine Karte für die Tageskarte im Logbuch: aus Kartenkacheln zusammengesetzt,
// die Route als Linie darüber. Rein rechnend (Web-Mercator), ohne DOM.
const KACHEL = 256;

/** Weltpixel (Kachelgröße 256) eines Punktes bei einer Zoomstufe. */
export function mercatorPx(lon, lat, z) {
  const n = KACHEL * 2 ** z;
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
}

/**
 * Wählt die größte Zoomstufe, bei der alle Punkte in w × h passen (mit Rand `pad`),
 * und liefert die dazu nötigen Kacheln samt Position sowie `projiziere` für die Route.
 */
export function kartenAnsicht(punkte, w, h, { pad = 18, minZoom = 4, maxZoom = 15 } = {}) {
  const g = (punkte || []).filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
  if (g.length < 2) return null;
  const lons = g.map((p) => p.lon);
  const lats = g.map((p) => p.lat);
  const west = Math.min(...lons), ost = Math.max(...lons), sued = Math.min(...lats), nord = Math.max(...lats);
  const ausdehnung = (z) => {
    const a = mercatorPx(west, nord, z), b = mercatorPx(ost, sued, z);
    return { a, b, breite: b.x - a.x, hoehe: b.y - a.y };
  };

  let zoom = minZoom;
  for (let z = maxZoom; z >= minZoom; z--) {
    const e = ausdehnung(z);
    if (e.breite <= w - 2 * pad && e.hoehe <= h - 2 * pad) { zoom = z; break; }
  }
  const { a, b } = ausdehnung(zoom);
  const ox = (a.x + b.x) / 2 - w / 2;
  const oy = (a.y + b.y) / 2 - h / 2;
  const n = 2 ** zoom;

  const kacheln = [];
  for (let ty = Math.floor(oy / KACHEL); ty <= Math.floor((oy + h - 1) / KACHEL); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(ox / KACHEL); tx <= Math.floor((ox + w - 1) / KACHEL); tx++) {
      kacheln.push({ z: zoom, x: ((tx % n) + n) % n, y: ty, links: tx * KACHEL - ox, oben: ty * KACHEL - oy });
    }
  }
  const projiziere = (lon, lat) => { const p = mercatorPx(lon, lat, zoom); return { x: p.x - ox, y: p.y - oy }; };
  return { zoom, kacheln, projiziere };
}

/** Kachel-Adresse aus einer Vorlage mit {z}/{x}/{y}. */
export const kachelAdresse = (vorlage, k) => vorlage.replace("{z}", k.z).replace("{x}", k.x).replace("{y}", k.y);

/** Route als SVG-Pfad (auf höchstens `maxPunkte` Punkte vereinfacht). */
export function routenPfad(punkte, projiziere, maxPunkte = 90) {
  const g = (punkte || []).filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
  if (g.length < 2) return "";
  const schritt = Math.max(1, Math.ceil(g.length / maxPunkte));
  const pts = g.filter((_, i) => i % schritt === 0);
  if (pts[pts.length - 1] !== g[g.length - 1]) pts.push(g[g.length - 1]);
  return "M" + pts.map((p) => { const q = projiziere(p.lon, p.lat); return `${q.x.toFixed(1)},${q.y.toFixed(1)}`; }).join(" L");
}
