// Datenlücken in der Route erkennen: zwei aufeinanderfolgende Punkte liegen weit
// auseinander, weil der Tracker dazwischen nichts geliefert hat (Funkpause, GPS-Ausfall).
// Die Karte verbindet sie sonst geradlinig, als wäre die Strecke dort gefahren worden.
// Rein rechnend, ohne DOM; Punkte sind { lat, lon, time, … }.
const M_LAT = 111_320;

/**
 * Lücken in einer Liste von Linienstücken. Eine Lücke braucht mindestens `minSekunden`
 * ohne Messung UND mindestens `minMeter` Luftlinie (im Stand fehlen Punkte ohnehin).
 * Liefert [{ von, nach, sekunden, meter }] in der Reihenfolge der Route.
 */
export function findeLuecken(segments, { minSekunden = 40, minMeter = 500 } = {}) {
  const out = [];
  for (const segment of segments || []) {
    for (let i = 1; i < segment.length; i++) {
      const a = segment[i - 1];
      const b = segment[i];
      const sekunden = (Date.parse(b.time || "") - Date.parse(a.time || "")) / 1000;
      if (!(sekunden >= minSekunden)) continue;
      const meter = Math.hypot((b.lat - a.lat) * M_LAT, (b.lon - a.lon) * M_LAT * Math.cos((a.lat * Math.PI) / 180));
      if (meter >= minMeter) out.push({ von: a, nach: b, sekunden: Math.round(sekunden), meter: Math.round(meter) });
    }
  }
  return out;
}

/** Abstand eines Punktes zu einer Strecke in Metern (gleichwinklige Näherung, reicht für Tipp-Abstände). */
export function abstandZurStrecke(lon, lat, a, b) {
  const mLon = M_LAT * Math.cos((lat * Math.PI) / 180);
  const px = (lon - a.lon) * mLon;
  const py = (lat - a.lat) * M_LAT;
  const dx = (b.lon - a.lon) * mLon;
  const dy = (b.lat - a.lat) * M_LAT;
  const laenge2 = dx * dx + dy * dy;
  const t = laenge2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / laenge2)) : 0;
  return Math.hypot(px - t * dx, py - t * dy);
}

/** Dauer als "96 s" oder "3 min 20 s". */
export function dauerText(sekunden) {
  if (sekunden < 120) return `${sekunden} s`;
  const m = Math.floor(sekunden / 60);
  const s = sekunden % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}
