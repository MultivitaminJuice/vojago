import { elevationRange, pathLengthKm } from "./geo.js";
import { dayKeyForTripDay, localDayKey, tripDayKeys, tripDayNumberForIso } from "./day-utils.js";

const UEBERNACHTUNGSPLATZ_RADIUS_KM = 0.3;
const SICHTBARER_TRACK_TAG_MIN_KM = 5;
const BEWEGUNG_MIN_KMH = 5;
const MAX_BEWEGUNGSLUECKE_MINUTEN = 120;
// Bis zu dieser Länge ist ein Abstand zwischen zwei Punkten ein normales
// Messintervall (bewegt der Router sich, meldet er alle paar Sekunden); alles
// darüber ist eine Meldelücke, die nur zählt, wenn sich das Fahrzeug darin
// tatsächlich fortbewegt hat (siehe bewegungsMinuten).
const NORMALES_INTERVALL_MINUTEN = 2;
const LUECKE_MIN_KMH = 10;

const isoDate = (iso) => {
  return localDayKey(iso);
};

const minutesBetween = (from, to) => {
  const a = Date.parse(from || "");
  const b = Date.parse(to || "");
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 60000);
};

const numberSum = (items, key) =>
  items.reduce((sum, item) => sum + (Number.isFinite(item[key]) ? item[key] : 0), 0);

const inRange = (iso, from, to) => {
  const value = Date.parse(iso || "");
  const start = Date.parse(from || "");
  const end = Date.parse(to || "");
  if (!Number.isFinite(value) || !Number.isFinite(start)) return false;
  return value >= start && (!Number.isFinite(end) || value <= end);
};

function normalisePath(path) {
  if (!path?.length) return [];
  const start = path[0].cum || 0;
  return path.map((p) => ({ ...p, cum: Math.max(0, (p.cum || 0) - start) }));
}

function pathDistance(path) {
  if (!path?.length) return 0;
  const start = path[0].cum || 0;
  const end = path[path.length - 1].cum;
  return Number.isFinite(end) ? Math.max(0, end - start) : pathLengthKm(path);
}

function pathRange(path) {
  const first = path?.find((p) => p.time)?.time || null;
  const last = [...(path || [])].reverse().find((p) => p.time)?.time || null;
  return { from: first, to: last };
}

/**
 * Effektive Fahrzeit: Summe der Zeitabstände, in denen das Fahrzeug fuhr.
 *
 * Früher zählte jeder Abstand ≤ 120 min als Fahrzeit, sobald EINER der beiden
 * Randpunkte ≥ 5 km/h meldete — beim Parken meldet der Router aber gar nichts
 * mehr, die letzte Meldung vor und die erste nach der Stille tragen oft noch
 * Restgeschwindigkeit (GPS-Rauschen, Anfahren). Ein 65-minütiger Stopp zählte
 * so komplett als Fahrt (echter Fund, 16. Oktober 2026: Gesamt/Tage 1589 min,
 * die Fahrten-Liste und eine reine Intervall-Zählung kamen übereinstimmend auf
 * rund 1295). Jetzt: normale Intervalle (≤ 2 min) zählen bei bewegtem
 * Randpunkt wie bisher; eine längere Lücke zählt nur, wenn die zurückgelegte
 * Strecke darin einer echten Fahrt entspricht (≥ 10 km/h im Schnitt) — ein
 * Tunnel auf der Autobahn bleibt Fahrzeit, ein Stopp am selben Fleck nicht.
 */
function bewegungsMinuten(path) {
  if (!path?.length) return 0;
  let minuten = 0;
  for (let i = 1; i < path.length; i++) {
    const vorher = path[i - 1];
    const punkt = path[i];
    const von = Date.parse(vorher.time || "");
    const bis = Date.parse(punkt.time || "");
    if (!Number.isFinite(von) || !Number.isFinite(bis) || bis <= von) continue;
    const delta = (bis - von) / 60000;
    if (delta > MAX_BEWEGUNGSLUECKE_MINUTEN) continue;
    if (delta <= NORMALES_INTERVALL_MINUTEN) {
      const bewegt = Math.max(Number(vorher.spd) || 0, Number(punkt.spd) || 0) >= BEWEGUNG_MIN_KMH;
      if (bewegt) minuten += delta;
    } else {
      const km = entfernungKm(vorher, punkt);
      if (Number.isFinite(km) && km / (delta / 60) >= LUECKE_MIN_KMH) minuten += delta;
    }
  }
  return Math.round(minuten);
}

function entfernungKm(a, b) {
  if (!a || !b) return Infinity;
  const lat1 = Number(a.lat), lon1 = Number(a.lon);
  const lat2 = Number(b.lat), lon2 = Number(b.lon);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function uebernachtungsplatzAnzahl(places) {
  const gruppen = [];
  for (const place of places) {
    if (!Number.isFinite(Number(place.lat)) || !Number.isFinite(Number(place.lon))) {
      gruppen.push(place);
      continue;
    }
    const vorhanden = gruppen.some((gruppe) =>
      Number.isFinite(Number(gruppe.lat)) &&
      Number.isFinite(Number(gruppe.lon)) &&
      entfernungKm(place, gruppe) <= UEBERNACHTUNGSPLATZ_RADIUS_KM
    );
    if (!vorhanden) gruppen.push(place);
  }
  return gruppen.length;
}

function hatReiseTagAktivitaet(summary) {
  if (!summary) return false;
  return summary.drives.length > 0 ||
    summary.stats.driveMinutes > 0 ||
    summary.stats.distanceKm >= SICHTBARER_TRACK_TAG_MIN_KM;
}

function commonSummary({ type, id, title, parentId = null, hue = 28, live = false, path = [], from = null, to = null, drives = [], places = [], notes = [], fallbackKm = 0 }) {
  const routePath = normalisePath(path);
  const routeKm = pathDistance(routePath);
  const km = type === "fahrt" && drives[0]?.km != null
    ? drives[0].km
    : routeKm || (Number.isFinite(fallbackKm) ? fallbackKm : 0);
  const pathDriveMinutes = bewegungsMinuten(routePath);
  const driveMinutes = pathDriveMinutes || numberSum(drives, "minutes") || (type === "fahrt" ? minutesBetween(from, to) : 0);
  const avgKmh = driveMinutes > 0 ? km / (driveMinutes / 60) : 0;
  const pathMax = routePath.length ? Math.max(0, ...routePath.map((p) => p.spd || 0)) : 0;
  const driveMax = Math.max(0, ...drives.map((d) => d.maxKmh || 0));
  const elev = routePath.length ? elevationRange(routePath) : { min: 0, max: 0 };
  const overnightPlaces = places.filter((p) => p.catId === "uebernachtung");
  const nights = overnightPlaces.reduce((sum, p) => sum + (Number.isInteger(p.nights) && p.nights > 0 ? p.nights : 1), 0);
  const days = new Set(routePath.map((p) => p.day).filter(Number.isFinite));

  return {
    type,
    id,
    parentId,
    title,
    hue,
    live,
    from,
    to,
    path: routePath,
    drives,
    places,
    notes,
    stats: {
      distanceKm: km,
      periodMinutes: minutesBetween(from, to || new Date().toISOString()),
      driveMinutes,
      averageKmh: avgKmh,
      maxKmh: Math.max(pathMax, driveMax),
      peakM: elev.max,
      minM: elev.min,
      overnightPlaces: uebernachtungsplatzAnzahl(overnightPlaces),
      nights,
      days: days.size || 0,
      drives: drives.length,
      places: places.length,
      notes: notes.length,
    },
  };
}

export function summarizeTrip(trip, { drives = [], places = [], notes = [] } = {}) {
  if (!trip) return null;
  const range = pathRange(trip.path);
  const explicitTo = trip.end || trip.range?.to || null;
  const live = Boolean(trip.live) && !explicitTo;
  return commonSummary({
    type: "reise",
    id: trip.id,
    title: trip.name,
    hue: trip.hue,
    live,
    path: trip.path || [],
    from: trip.start || trip.range?.from || range.from,
    to: live ? null : (explicitTo || range.to),
    fallbackKm: trip.km,
    drives,
    places,
    notes,
  });
}

export function summarizeDay(trip, day, { drives = [], places = [], notes = [] } = {}) {
  if (!trip) return null;
  const path = (trip.path || []).filter((p) => p.day === day);
  const range = pathRange(path);
  const fallbackDate = isoDate(range.from) || dayKeyForTripDay(trip, day);
  const dayDrives = drives.filter((d) => tripDayNumberForIso(d.from, trip) === day || isoDate(d.from) === fallbackDate || inRange(d.from, range.from, range.to));
  const dayPlaces = places.filter((p) => tripDayNumberForIso(p.at, trip) === day || isoDate(p.at) === fallbackDate || inRange(p.at, range.from, range.to));
  const dayNotes = notes.filter((n) => tripDayNumberForIso(n.at, trip) === day || isoDate(n.at) === fallbackDate || inRange(n.at, range.from, range.to));
  return commonSummary({
    type: "tag",
    id: `${trip.id}:day:${day}`,
    parentId: trip.id,
    title: `Tag ${day}`,
    hue: trip.hue,
    path,
    from: range.from || dayDrives[0]?.from || dayPlaces[0]?.at || dayNotes[0]?.at || (fallbackDate ? `${fallbackDate}T00:00:00` : null),
    to: range.to || dayDrives.at(-1)?.to || dayDrives.at(-1)?.from || dayPlaces.at(-1)?.at || dayNotes.at(-1)?.at || (fallbackDate ? `${fallbackDate}T23:59:59` : null),
    drives: dayDrives,
    places: dayPlaces,
    notes: dayNotes,
    fallbackKm: numberSum(dayDrives, "km"),
  });
}

export function summarizeTripDays(trip, options = {}) {
  if (!trip?.start && !trip?.range?.from) {
    const fallbackDays = [...new Set((trip?.path || []).map((p) => p.day).filter(Number.isFinite))].sort((a, b) => a - b);
    return fallbackDays.map((day) => summarizeDay(trip, day, options)).filter(Boolean);
  }
  const extraKeys = [
    ...(trip?.path || []).map((p) => isoDate(p.time)),
    ...(options.drives || []).map((d) => isoDate(d.from)),
    ...(options.places || []).map((p) => isoDate(p.at)),
    ...(options.notes || []).map((n) => isoDate(n.at)),
  ];
  const days = tripDayKeys(trip, { extraKeys })
    .map((key) => tripDayNumberForIso(`${key}T12:00:00`, trip))
    .filter(Number.isFinite);
  return days
    .map((day) => summarizeDay(trip, day, options))
    .filter(hatReiseTagAktivitaet);
}

export function summarizeDrive(drive, { path = [] } = {}) {
  if (!drive) return null;
  return commonSummary({
    type: "fahrt",
    id: drive.id,
    parentId: drive.tripId || null,
    title: "Fahrt",
    hue: 200,
    path,
    from: drive.from,
    to: drive.to,
    drives: [drive],
  });
}

export function routeSummaryToTrip(summary, name = summary?.title || "Route") {
  if (!summary) return null;
  return {
    id: summary.id,
    name,
    dates: "",
    live: summary.live,
    hue: summary.hue,
    path: summary.path,
    km: Math.round(summary.stats.distanceKm),
    nights: summary.stats.nights,
    peak: Math.round(summary.stats.peakM),
    bars: [summary.stats.distanceKm],
    barLabels: [summary.title],
  };
}
