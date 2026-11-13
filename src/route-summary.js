// Statistics of a trip, a day or a drive (distance, driving time, speeds,
// elevation, overnight places) computed from the route path and the drives.
// The summary types "reise", "tag" and "fahrt" are used by the views.
import { elevationRange, pathLengthKm } from "./geo.js";
import { dayKeyForTripDay, localDayKey, tripDayKeys, tripDayNumberForIso } from "./day-utils.js";

const OVERNIGHT_PLACE_RADIUS_KM = 0.3;
const VISIBLE_TRACK_DAY_MIN_KM = 5;
const MOVING_MIN_KMH = 5;
const MAX_MOVING_GAP_MINUTES = 120;
// Up to this length a gap between two points is a normal sampling interval
// (while moving, the router reports every few seconds); anything longer is a
// reporting gap that only counts when the vehicle actually moved during it
// (see movingMinutes).
const NORMAL_INTERVAL_MINUTES = 2;
const GAP_MIN_KMH = 10;

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
 * Effective driving time: the sum of the intervals in which the vehicle moved.
 *
 * Earlier every gap of up to 120 min counted as driving time as soon as ONE
 * of its two end points reported ≥ 5 km/h — but a parked router reports
 * nothing, and the last report before and the first after the silence often
 * still carry some speed (GPS noise, pulling away). A 65-minute stop counted
 * fully as driving (seen 16 October 2026: totals 1589 min, while the drive list
 * and a plain interval count both gave about 1295). Now normal intervals
 * (≤ 2 min) count when an end point moves, as before; a longer gap only counts
 * when the distance covered in it matches real driving (≥ 10 km/h on average)
 * — a motorway tunnel stays driving time, a stop at the same spot does not.
 */
function movingMinutes(path) {
  if (!path?.length) return 0;
  let minutes = 0;
  for (let i = 1; i < path.length; i++) {
    const previous = path[i - 1];
    const point = path[i];
    const from = Date.parse(previous.time || "");
    const to = Date.parse(point.time || "");
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
    const delta = (to - from) / 60000;
    if (delta > MAX_MOVING_GAP_MINUTES) continue;
    if (delta <= NORMAL_INTERVAL_MINUTES) {
      const moved = Math.max(Number(previous.spd) || 0, Number(point.spd) || 0) >= MOVING_MIN_KMH;
      if (moved) minutes += delta;
    } else {
      const km = distanceBetweenKm(previous, point);
      if (Number.isFinite(km) && km / (delta / 60) >= GAP_MIN_KMH) minutes += delta;
    }
  }
  return Math.round(minutes);
}

function distanceBetweenKm(a, b) {
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

/** Number of distinct overnight places: stays within OVERNIGHT_PLACE_RADIUS_KM of each other count once. */
function overnightPlaceCount(places) {
  const groups = [];
  for (const place of places) {
    if (!Number.isFinite(Number(place.lat)) || !Number.isFinite(Number(place.lon))) {
      groups.push(place);
      continue;
    }
    const known = groups.some((group) =>
      Number.isFinite(Number(group.lat)) &&
      Number.isFinite(Number(group.lon)) &&
      distanceBetweenKm(place, group) <= OVERNIGHT_PLACE_RADIUS_KM
    );
    if (!known) groups.push(place);
  }
  return groups.length;
}

/** A day is listed only when something happened: drives, driving time or a visible track. */
function hasDayActivity(summary) {
  if (!summary) return false;
  return summary.drives.length > 0 ||
    summary.stats.driveMinutes > 0 ||
    summary.stats.distanceKm >= VISIBLE_TRACK_DAY_MIN_KM;
}

function commonSummary({ type, id, title, parentId = null, hue = 28, live = false, path = [], from = null, to = null, drives = [], places = [], notes = [], fallbackKm = 0 }) {
  const routePath = normalisePath(path);
  const routeKm = pathDistance(routePath);
  const km = type === "fahrt" && drives[0]?.km != null
    ? drives[0].km
    : routeKm || (Number.isFinite(fallbackKm) ? fallbackKm : 0);
  const pathDriveMinutes = movingMinutes(routePath);
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
      overnightPlaces: overnightPlaceCount(overnightPlaces),
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
    .filter(hasDayActivity);
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
