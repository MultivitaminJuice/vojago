// Geografische Helfer: Entfernungen, Glättung, Begrenzungsrahmen.

const R = 6371; // Erdradius in km

/** Entfernung zweier Punkte in Kilometern. */
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
 * Verdichtet Stützpunkte zu einer weichen Route (Catmull-Rom) und ergänzt
 * je Punkt die aufsummierte Strecke `cum` (km) sowie den Reisetag `day`.
 * @param {Array<{lon,lat,elev,spd,night?:boolean}>} waypoints
 * @param {number} steps Zwischenpunkte je Abschnitt
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

// GPS-Rauschen im Stand: aufeinanderfolgende Fixe "springen" ein paar Meter
// hin und her (z. B. Mehrwegeausbreitung an Gebäuden — Nutzer-Fund,
// 5. September 2026: sichtbare Schleife auf einem Parkplatz, obwohl das
// Fahrzeug fest stand), ohne dass real Bewegung stattfand. Reine
// Anzeigekorrektur — nur der abgeleitete Pfad wird geglättet, die
// gespeicherten Rohpositionen bleiben unangetastet (siehe Aufrufer). Bleibt
// ein Fix innerhalb von STAND_GLAETTUNG_RADIUS_M vom zuletzt gesetzten
// Anker UND meldet er nur geringe Geschwindigkeit, übernimmt er dessen
// Position statt seiner eigenen; ein Fix außerhalb des Radius setzt einen
// neuen Anker (echte, wenn auch langsame Weiterfahrt bleibt sichtbar).
// Geschwindigkeits-Schwelle bewusst niedriger als STAND_SPEED_MAX_KMH (5,
// src/dataload.js) — hier geht es nicht darum, "steht" im Sinne eines
// Stopps zu erkennen, sondern nur offensichtliches Rauschen bei
// eindeutigem Stillstand zu glätten.
const STAND_GLAETTUNG_RADIUS_M = 12;
const STAND_GLAETTUNG_MAX_KMH = 3;

export function glaetteStandRauschen(waypoints) {
  let anker = null;
  return waypoints.map((w) => {
    if ((w.spd || 0) > STAND_GLAETTUNG_MAX_KMH) { anker = null; return w; }
    if (anker && distanceKm(anker.lon, anker.lat, w.lon, w.lat) * 1000 <= STAND_GLAETTUNG_RADIUS_M) {
      return { ...w, lat: anker.lat, lon: anker.lon };
    }
    anker = { lat: w.lat, lon: w.lon };
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

/** Punkt auf der Route bei einer bestimmten Kilometermarke. */
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

/** Sinnvoller Abstand für Kilometermarken (ca. 7 Stück). */
export function kmMarkerStep(total) {
  const raw = total / 7;
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  const n = raw / p;
  return Math.max(10, (n >= 5 ? 5 : n >= 2 ? 2 : 1) * p);
}
