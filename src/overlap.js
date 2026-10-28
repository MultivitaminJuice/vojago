// Doppelt befahrene Strecken erkennen. Fährt man dieselbe Straße an mehreren Tagen
// (Hin- und Rückweg), liegen die Linien der Fahrten auf der Karte exakt übereinander
// und die spätere deckt die frühere zu. Hier werden die Stücke gefunden, an denen
// mehrere Durchfahrten zusammenfallen; die Karte zeichnet sie darüber verschachtelt:
// die früheste Fahrt breit, jede spätere schmaler darauf — so bleibt jede Tagesfarbe zu sehen.
// Rein rechnend, ohne DOM; Punkte sind { lat, lon, time, … }.
const M_LAT = 111_320;

/**
 * Breite der verschachtelten Linie: Rang 0 (früheste Durchfahrt) ist die breiteste,
 * jede spätere schmaler; höchstens vier Stufen. Die normale Routenbreite ist 5.
 */
export function linienBreite(rang, anzahl) {
  const stufen = Math.min(Math.max(anzahl, 2), 4);
  const r = Math.min(Math.max(rang, 0), stufen - 1);
  return Number((6.4 - r * (4.2 / (stufen - 1))).toFixed(2));
}

/**
 * Findet die Stücke der Route, die mehrere Durchfahrten gemeinsam haben.
 * `segments`: die gezeichneten Linienstücke (Listen von Punkten). Eine Durchfahrt endet an einem
 * Stück-Ende oder bei einer Zeitlücke (`lueckeMs`) zwischen zwei Punkten.
 * Liefert Läufe { coords: [[lon, lat], …], punkt (für die Farbe), rang (0 = früheste), anzahl }
 * nach Rang aufsteigend (die schmalen oben). Kurze Berührungen (Kreuzungen, gemeinsamer
 * Parkplatz) unter `minLaengeM` zählen nicht.
 */
export function doppeltBefahren(segments, { radiusM = 45, schrittM = 25, minLaengeM = 120, maxLaufM = 200, lueckeMs = 300_000 } = {}) {
  // 1. Durchfahrten bilden
  const fahrten = [];
  for (const segment of segments || []) {
    let aktuell = null;
    for (const p of segment) {
      const t = Date.parse(p.time || "");
      const neu = !aktuell || (Number.isFinite(t) && Number.isFinite(aktuell.letzte) && t - aktuell.letzte > lueckeMs);
      if (neu) { aktuell = { punkte: [], start: t, letzte: t }; fahrten.push(aktuell); }
      aktuell.punkte.push(p);
      if (Number.isFinite(t)) aktuell.letzte = t;
    }
  }
  const echte = fahrten.filter((f) => f.punkte.length > 1);
  if (echte.length < 2) return [];
  echte.forEach((f, i) => { f.nr = i; });
  // Rang = Reihenfolge nach dem ersten Zeitstempel (ohne Zeit: nach Lage in der Liste)
  [...echte].sort((a, b) => (Number.isFinite(a.start) && Number.isFinite(b.start) ? a.start - b.start : 0) || a.nr - b.nr)
    .forEach((f, i) => { f.rang = i; });

  const mLon = M_LAT * Math.cos(((echte[0].punkte[0].lat || 0) * Math.PI) / 180);
  const X = (p) => p.lon * mLon;
  const Y = (p) => p.lat * M_LAT;

  // 2. Jede Durchfahrt in gleichmäßige Abstände zerlegen
  for (const f of echte) {
    const s = [];
    f.punkte.forEach((a, i) => {
      s.push({ x: X(a), y: Y(a), lon: a.lon, lat: a.lat, punkt: a });
      const b = f.punkte[i + 1];
      if (!b) return;
      const dx = X(b) - X(a);
      const dy = Y(b) - Y(a);
      const d = Math.hypot(dx, dy);
      for (let k = 1; k * schrittM < d - 1e-6; k++) {
        const t = (k * schrittM) / d;
        s.push({ x: X(a) + t * dx, y: Y(a) + t * dy, lon: a.lon + t * (b.lon - a.lon), lat: a.lat + t * (b.lat - a.lat), punkt: a });
      }
    });
    f.samples = s;
  }

  // 3. Raster aus Zellen von der Größe des Radius
  const zelle = (v) => Math.floor(v / radiusM);
  const schluessel = (cx, cy) => (cx + 1e6) * 4e6 + (cy + 1e6);
  const raster = new Map();
  for (const f of echte) {
    f.samples.forEach((s, i) => {
      const k = schluessel(zelle(s.x), zelle(s.y));
      (raster.get(k) || raster.set(k, []).get(k)).push([f, i]);
    });
  }

  // 4. Je Stützpunkt: welche anderen Durchfahrten liegen in der Nähe?
  const r2 = radiusM * radiusM;
  for (const f of echte) {
    f.markiert = f.samples.map((s) => {
      const andere = new Set();
      const cx = zelle(s.x);
      const cy = zelle(s.y);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const [g, j] of raster.get(schluessel(cx + dx, cy + dy)) || []) {
            if (g === f || andere.has(g)) continue;
            const q = g.samples[j];
            if ((q.x - s.x) ** 2 + (q.y - s.y) ** 2 <= r2) andere.add(g);
          }
        }
      }
      if (!andere.size) return null;
      let rang = 0;
      for (const g of andere) if (g.rang < f.rang) rang++;
      return { rang, anzahl: Math.min(andere.size + 1, 4) };
    });
  }

  // 5. Zusammenhängende Stücke bilden, zu kurze verwerfen, in Läufe gleicher Stufe teilen
  const laeufe = [];
  for (const f of echte) {
    const s = f.samples;
    let i = 0;
    while (i < s.length) {
      if (!f.markiert[i]) { i++; continue; }
      let j = i;
      let laenge = 0;
      while (j + 1 < s.length && f.markiert[j + 1]) { laenge += Math.hypot(s[j + 1].x - s[j].x, s[j + 1].y - s[j].y); j++; }
      if (laenge >= minLaengeM) {
        let start = i;
        let lauf = 0;
        for (let k = i + 1; k <= j + 1; k++) {
          const wechsel = k > j || f.markiert[k].rang !== f.markiert[start].rang || f.markiert[k].anzahl !== f.markiert[start].anzahl;
          if (k <= j) lauf += Math.hypot(s[k].x - s[k - 1].x, s[k].y - s[k - 1].y);
          if (wechsel || lauf >= maxLaufM) {
            // der Lauf endet im Stützpunkt k, damit zwei Läufe ohne Lücke aneinanderstoßen
            const bis = Math.min(k, s.length - 1);
            const teil = s.slice(start, bis + 1);
            if (teil.length > 1) {
              const m = f.markiert[start];
              laeufe.push({ coords: teil.map((q) => [q.lon, q.lat]), punkt: teil[Math.floor(teil.length / 2)].punkt, rang: m.rang, anzahl: m.anzahl });
            }
            start = k;
            lauf = 0;
          }
        }
      }
      i = j + 1;
    }
  }
  return laeufe.sort((a, b) => a.rang - b.rang);
}
