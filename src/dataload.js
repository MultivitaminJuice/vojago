// Where the data comes from: built-in examples (demo) or the app's own API.
// The switch in the settings decides — and really takes effect.
import { state, emit, applyLocalData, applyPreferences, saveConfig, MAP_METRICS } from "./state.js";
import { loadDemoData } from "./demo.js";
import {
  isConfigured, listTrips, listPlaces, listNotes, listDiary, listCategories, listPhotos, listVehicles, route as fetchRoute, routeStand as fetchRouteStand,
  positions as fetchPositions, drives as fetchDrives, loadSettings, listDriveAssignments,
  cacheDriveWeather, weather as fetchWeather,
} from "./api.js";
import { pathLengthKm, elevationRange, smoothStandingNoise } from "./geo.js";
import { debugLog } from "./debug.js";
import { parseBlocks } from "./diary.js";
import { renumberPathByTripStart } from "./day-utils.js";
import { appendNewPoints } from "./path-merge.js";
import { routeKey, readRoute, writeRoute, clearRoutes, packPath, unpackPath } from "./route-store.js";

/** State of the data source — the UI shows it in the status band. */
export const status = { mode: "demo", loading: false, error: null };
const LIVE_POSITION_KEY = "vojago.live.last";
const SNAPSHOT_KEY = "vojago.snapshot";

function setStatus(patch) {
  Object.assign(status, patch);
  emit("status");
}

const HUES = [35, 205, 40, 150, 280, 15];

/** A trip from the database in the shape the UI uses. */
export function toTrip(row, index) {
  const start = row.start_at ? new Date(row.start_at) : null;
  const end = row.end_at ? new Date(row.end_at) : null;
  const fmt = (d) => d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
  return {
    id: row.id,
    name: row.name || "Reise",
    dates: start ? (end ? `${fmt(start)} – ${fmt(end)}` : `seit ${fmt(start)} · unterwegs`) : "",
    live: !row.end_at,
    hue: HUES[index % HUES.length],
    path: [],
    // The device `path` was last loaded for — ensureTripPath() compares it with
    // state.config.device; otherwise after switching vehicles the previous
    // device's route (or an empty cached one) would stay on the map although
    // trips and drives already show the new device (seen 05.09.2026).
    pathDevice: null,
    km: 0, nights: 0, peak: 0,
    bars: [0], barLabels: ["—"],
    range: { from: row.start_at, to: row.end_at },
    // Raw times for editing — `dates` is display only.
    start: row.start_at || null,
    end: row.end_at || null,
  };
}

/** The trip shown by default: the running one, otherwise the most recent. */
export function defaultTrip(trips) {
  const time = (t) => {
    const ms = Date.parse(t.range?.from || t.start || "");
    return Number.isFinite(ms) ? ms : 0;
  };
  const sorted = [...(trips || [])].sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    return time(b) - time(a);
  });
  return sorted[0] || null;
}

function routeForSnapshot(path, max = 2500) {
  if (!Array.isArray(path) || path.length <= max) return Array.isArray(path) ? path : [];
  const step = Math.ceil(path.length / max);
  const reduced = path.filter((_, i) => i % step === 0);
  const last = path[path.length - 1];
  if (last && reduced[reduced.length - 1] !== last) reduced.push(last);
  return reduced;
}

function tripForSnapshot(t, routeIds) {
  const keep = routeIds.has(t.id);
  return {
    ...t,
    path: keep ? routeForSnapshot(t.path) : [],
    pathDevice: keep ? t.pathDevice ?? null : null,
    pathChecked: false,
    pathCount: null,
  };
}

/** A freshly loaded trip keeps the route and values it already had in this session. */
function tripWithLastState(t, previous) {
  if (!previous?.path?.length) return t;
  return {
    ...t,
    path: renumberPathByTripStart(previous.path || [], t),
    pathDevice: previous.pathDevice ?? null,
    pathCoarse: previous.pathCoarse ?? false,
    fullLoadAt: previous.fullLoadAt ?? 0,
    pathCount: previous.pathCount ?? null,
    pathChecked: previous.pathChecked ?? false,
    pathCheckedAt: previous.pathCheckedAt ?? 0,
    km: Number.isFinite(previous.km) ? previous.km : t.km,
    nights: Number.isFinite(previous.nights) ? previous.nights : t.nights,
    peak: Number.isFinite(previous.peak) ? previous.peak : t.peak,
    bars: Array.isArray(previous.bars) && previous.bars.length ? previous.bars : t.bars,
    barLabels: Array.isArray(previous.barLabels) && previous.barLabels.length ? previous.barLabels : t.barLabels,
  };
}

export function saveSnapshot() {
  if (state.config.demo || !state.trips.length) return;
  const routeIds = new Set([state.mapTripId, state.activeTripId].filter(Boolean));
  const snapshot = {
    savedAt: new Date().toISOString(),
    trips: state.trips.map((t) => tripForSnapshot(t, routeIds)),
    places: state.places,
    notes: state.notes,
    diary: state.diary,
    drives: state.drives,
    activeTripId: state.activeTripId,
    mapTripId: state.mapTripId,
    metric: MAP_METRICS.includes(state.metric) ? state.metric : "day",
    layers: state.layers,
    categories: state.categories,
    vehicles: state.vehicles,
    activeVehicle: state.activeVehicle,
    showVehicleName: state.showVehicleName,
    livePosition: state.livePosition,
  };
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch (err) {
    debugLog("snapshot.save-failed", { error: err.message || String(err) });
  }
}

export function restoreSnapshot() {
  if (state.config.demo) return false;
  let snapshot;
  try { snapshot = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "null"); } catch { return false; }
  if (!snapshot || !Array.isArray(snapshot.trips) || !snapshot.trips.length) return false;

  // The snapshot only holds a thinned path (see routeForSnapshot) — mark it as
  // coarse until a real download succeeded.
  state.trips = snapshot.trips.map((t) => ({ ...t, path: renumberPathByTripStart(t.path || [], t), pathCoarse: Boolean(t.path?.length), pathChecked: false }));
  routeLoadLog.fromCache = state.trips.some((t) => t.path?.length);
  state.places = Array.isArray(snapshot.places) ? snapshot.places : [];
  state.notes = Array.isArray(snapshot.notes) ? snapshot.notes : [];
  // "tagebuch" is the key snapshots used before the code moved to English.
  state.diary = Array.isArray(snapshot.diary) ? snapshot.diary : Array.isArray(snapshot.tagebuch) ? snapshot.tagebuch : [];
  state.drives = Array.isArray(snapshot.drives) ? snapshot.drives : [];
  state.adhocTrip = null;
  state.categories = snapshot.categories && typeof snapshot.categories === "object" ? snapshot.categories : state.categories;
  state.vehicles = Array.isArray(snapshot.vehicles) ? snapshot.vehicles : state.vehicles;
  state.activeVehicle = Number.isInteger(snapshot.activeVehicle) ? snapshot.activeVehicle : state.activeVehicle;
  state.showVehicleName = typeof snapshot.showVehicleName === "boolean" ? snapshot.showVehicleName : state.showVehicleName;
  if (MAP_METRICS.includes(snapshot.metric)) state.metric = snapshot.metric;
  if (snapshot.layers && typeof snapshot.layers === "object") Object.assign(state.layers, snapshot.layers);
  if (snapshot.livePosition && Number.isFinite(snapshot.livePosition.lon) && Number.isFinite(snapshot.livePosition.lat)) {
    state.livePosition = snapshot.livePosition;
  }

  const hasTrip = (id) => id && state.trips.some((t) => t.id === id);
  const fallback = defaultTrip(state.trips);
  state.activeTripId = hasTrip(snapshot.activeTripId) ? snapshot.activeTripId : (fallback?.live ? fallback.id : null);
  state.mapTripId = hasTrip(snapshot.mapTripId) ? snapshot.mapTripId : (fallback?.id || null);
  debugLog("snapshot.restored", { savedAt: snapshot.savedAt, trips: state.trips.length, mapTripId: state.mapTripId });
  emit("trips");
  return true;
}

// A "place" in the UI is a visit with its catalogue place flattened in
// (title/note/category_id/rating/lat/lon come from the place, everything else
// from the visit — see api/router.js: GET /api/besuche returns exactly this
// shape). `id` stays the visit id (map and logbook show single stays), `ortId`
// links several visits to the same place across trips (see
// placesWithVisitCount()). tripId is NOT stored but computed from the time, like
// for drives — creating a trip afterwards sorts matching visits in on the next load.
export function toPlace(row) {
  return {
    id: row.id,
    ortId: row.ort_id || null,
    tripId: tripAt(row.occurred_at),
    catId: row.category_id || "stellplatz",
    title: row.title || "(ohne Titel)",
    // Address from reverse geocoding, kept apart from the (editable) title —
    // stays visible after the title was renamed (requested 6 September 2026).
    address: row.address || "",
    note: row.note || "",
    stars: row.rating ?? 0,
    // `at` is the time (for the logbook), `date` its short display.
    at: row.occurred_at || "",
    date: row.occurred_at ? new Date(row.occurred_at).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "",
    lon: Number(row.lon),
    lat: Number(row.lat),
    source: row.source || "camper",
    hue: 30,
    nights: Number.isInteger(row.nights) && row.nights > 0 ? row.nights : 1,
    weather: parseWeather(row.weather),
    stopKey: row.stop_key || null,
  };
}

export function toNote(row) {
  return {
    id: row.id,
    tripId: tripAt(row.occurred_at),
    besuchId: row.besuch_id || null,
    title: row.title || titleFromNoteText(row.text),
    text: row.text || "",
    at: row.occurred_at || "",
    lon: row.lon == null ? null : Number(row.lon),
    lat: row.lat == null ? null : Number(row.lat),
    source: row.source || "handy",
    weather: parseWeather(row.weather),
  };
}

/** A diary entry from the database (blocks arrive as JSON text). */
export function toDiaryEntry(row) {
  return {
    id: row.id,
    tripId: row.trip_id,
    dayKey: row.day_key,
    blocks: parseBlocks(row.blocks),
    author: row.author || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
  };
}

export function toPhoto(row) {
  return {
    id: row.id,
    besuchId: row.besuch_id || null,
    noteId: row.note_id || null,
    tagebuchId: row.tagebuch_id || null,
    takenAt: row.taken_at || "",
    lat: row.lat == null ? null : Number(row.lat),
    lon: row.lon == null ? null : Number(row.lon),
    width: row.width || null,
    height: row.height || null,
  };
}

/**
 * How often a place was visited and slept at, across all trips — the real
 * identity across trips through ortId, not guessed from nearby coordinates (see
 * api/router.js: besuche.ort_id). Groups the loaded visits by place, sums the
 * nights and remembers the last visit.
 * Returns Map(ortId → { ortId, title, catId, lat, lon, visits, totalNights, lastVisit }).
 */
export function placesWithVisitCount() {
  const groups = new Map();
  for (const p of state.places) {
    if (!p.ortId) continue;
    const g = groups.get(p.ortId) || { ortId: p.ortId, title: p.title, catId: p.catId, lat: p.lat, lon: p.lon, visits: 0, totalNights: 0, lastVisit: null };
    g.visits += 1;
    // Only real overnight stays count nights — for a "stop" nights is just the
    // database minimum (1). Otherwise "how often was I here" showed nights for
    // places where nobody slept (seen with plain day stops).
    if (p.catId === "uebernachtung") g.totalNights += p.nights || 1;
    if (!g.lastVisit || (p.at && p.at > g.lastVisit)) g.lastVisit = p.at;
    groups.set(p.ortId, g);
  }
  return groups;
}

/** Server row → client shape for views/settings.js (renderVehicles). */
function toVehicle(row) {
  return {
    id: row.id,
    name: row.name || "Fahrzeug",
    device: row.traccar_device_id || "",
  };
}

function titleFromNoteText(text) {
  const clean = String(text || "").trim().replace(/\s+/g, " ");
  if (!clean) return "Notiz";
  return clean.length > 48 ? `${clean.slice(0, 47).trim()}…` : clean;
}

/** Weather is stored as JSON text in the database. */
function parseWeather(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** Positions from the server as route points (knots → km/h). */
export function positionsToPath(positions) {
  const waypoints = smoothStandingNoise(positions
    .filter((p) => Number.isFinite(p.longitude) && Number.isFinite(p.latitude))
    .map((p) => ({
      lon: p.longitude,
      lat: p.latitude,
      elev: Number.isFinite(p.altitude) ? p.altitude : 0,
      spd: Number.isFinite(p.speed) ? p.speed * 1.852 : 0,
      time: p.fixTime || p.deviceTime,
    })));
  if (waypoints.length < 2) return [];

  // Order and number of points stay untouched — only GPS noise while standing
  // is pulled to an anchor (smoothStandingNoise, src/geo.js). The stored raw
  // data in the database is not affected either way.
  let day = 1;
  let previousDate = waypoints[0].time ? new Date(waypoints[0].time).toDateString() : null;
  let cum = 0;
  return waypoints.map((w, i) => {
    if (w.time) {
      const d = new Date(w.time).toDateString();
      if (previousDate && d !== previousDate) day++;
      previousDate = d;
    }
    if (i > 0) {
      const a = waypoints[i - 1];
      const dLat = ((w.lat - a.lat) * Math.PI) / 180;
      const dLon = ((w.lon - a.lon) * Math.PI) / 180;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((w.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
      cum += 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }
    return { lon: w.lon, lat: w.lat, elev: w.elev, spd: w.spd, time: w.time, day, cum };
  });
}

/**
 * Kilometres per trip day from the track. Every point knows its day and the
 * distance driven so far — the day's distance is the difference.
 */
export function kmPerDay(path) {
  if (!path?.length) return { bars: [0], labels: ["—"] };
  const perDay = new Map();
  for (const p of path) {
    const known = perDay.get(p.day);
    if (!known) perDay.set(p.day, { from: p.cum, to: p.cum });
    else known.to = p.cum;
  }
  const days = [...perDay.entries()].sort((a, b) => a[0] - b[0]);
  return {
    bars: days.map(([, s]) => Math.round((s.to - s.from) * 10) / 10),
    labels: days.map(([day]) => `Tag ${day}`),
  };
}

/**
 * Load the route of a trip. `force` loads again even when a track is there —
 * needed because the running trip's track grows while driving. `silent`
 * suppresses the error display and refitting the map; the periodic background
 * refresh (see main.js) needs that so the view does not jump every few minutes.
 *
 * Against bad connections (seen 24 October 2026: parts of the line were
 * missing, a straight line ran across the map):
 *  - Never two loads of the same trip at once: a slow old load could otherwise
 *    arrive after a newer one and overwrite it.
 *  - For a running trip only the NEW points are loaded and appended.
 *  - A thinned path restored from the snapshot counts as coarse (pathCoarse)
 *    until a real download succeeded.
 *  - If refreshing fails repeatedly, a hint is shown — and the last good state stays.
 */
const LOADS_RUNNING = new Map();
// Loading only new points misses points the router delivers late (dead spot,
// buffer) that are older than the last known one — so the whole route is
// loaded again at least every 30 minutes.
const FULL_LOAD_EVERY_MS = 30 * 60_000;
// How long a finished trip counts as checked against the server.
const CHECK_VALID_MS = 10 * 60_000;
let pathFailuresInARow = 0;

/**
 * What the route refresh did last — for More → Status and the debug log.
 * Holds no coordinates on purpose, only times and counts.
 * Entries: { time, kind: "full" | "new" | "unchanged", received, newPoints, total, durationMs, background }
 * and failures { time, kind, error, inARow, durationMs, background }.
 */
export const routeLoadLog = { success: null, failure: null, fromCache: false };
function logRouteLoad(entry) {
  const { ok, ...data } = entry;
  if (ok) { routeLoadLog.success = { time: Date.now(), ...data }; routeLoadLog.fromCache = false; }
  else routeLoadLog.failure = { time: Date.now(), ...data };
  debugLog(ok ? "route.loaded" : "route.fetch-failed", data);
  emit("routeInfo");
}
const WEAK_CONNECTION_HINT = "Verbindung schwach — die Route ist evtl. nicht aktuell oder unvollständig.";

export function ensureTripPath(trip, { force = false, silent = false } = {}) {
  // Not just "do we have a track" but "for the currently active device" —
  // otherwise after switching vehicles the previous device's (possibly empty)
  // track stays although trips and drives were reloaded (seen 05.09.2026).
  const upToDate = trip?.path.length && trip.pathDevice === state.config.device && !trip.pathCoarse && trip.pathChecked;
  // A finished trip does not grow: a forced refresh (map tab, timer) only
  // checks it again after CHECK_VALID_MS, not every time.
  const checkedRecently = upToDate && trip.range?.to && Date.now() - (trip.pathCheckedAt || 0) < CHECK_VALID_MS;
  if (!trip || (upToDate && (!force || checkedRecently)) || status.mode !== "live") return Promise.resolve();
  if (!state.config.device || !trip.range?.from) return Promise.resolve();
  const key = `${trip.id}|${state.config.device}`;
  if (LOADS_RUNNING.has(key)) return LOADS_RUNNING.get(key);
  const load = loadPath(trip, silent).finally(() => LOADS_RUNNING.delete(key));
  LOADS_RUNNING.set(key, load);
  return load;
}

async function loadPath(trip, silent) {
  const start = Date.now();
  const lengthBefore = trip.path?.length || 0;
  let kind = "full";
  let received = 0;
  try {
    const device = state.config.device;
    const to = trip.range.to || new Date().toISOString();
    const storeKey = routeKey(trip, device);
    // Stored route of this trip: show it right away, before anything is downloaded.
    if (!trip.path?.length || trip.pathCoarse || trip.pathDevice !== device) {
      const stored = await readRoute(storeKey);
      if (stored?.rows?.length && stored.device === device) {
        takeStoredPath(trip, stored);
        emit(silent ? "tripPath" : "trips");
      }
    }
    // Finished trip with a complete stored route: only ask whether the server
    // holds the same points. Late deliveries from the router change the count.
    if (trip.range.to && trip.pathCount && trip.pathDevice === device && !trip.pathCoarse) {
      kind = "unchanged";
      const count = await fetchRouteStand(device, trip.range.from, to);
      if (count && count.total === trip.pathCount.total && count.lastAt === trip.pathCount.lastAt) {
        trip.pathChecked = true;
        trip.pathCheckedAt = Date.now();
        pathLoaded();
        logRouteLoad({ ok: true, kind, received: 0, newPoints: 0, total: trip.path.length, durationMs: Date.now() - start, background: silent });
        return;
      }
      kind = "full";
    }
    // Only load new points: running trip, fresh (not coarse) path for the same device.
    const last = trip.path?.length ? trip.path[trip.path.length - 1] : null;
    const append = Boolean(last?.time) && trip.pathDevice === device && !trip.pathCoarse && !trip.range.to
      && Date.now() - (trip.fullLoadAt || 0) < FULL_LOAD_EVERY_MS;
    if (append) {
      kind = "new";
      const positions = await fetchRoute(device, last.time, to, { timeoutMs: 45_000 });
      received = Array.isArray(positions) ? positions.length : 0;
      const fresh = renumberPathByTripStart(positionsToPath(Array.isArray(positions) ? positions : []), trip);
      const joined = appendNewPoints(trip.path, fresh);
      if (joined === trip.path) {
        pathLoaded();
        logRouteLoad({ ok: true, kind, received, newPoints: 0, total: trip.path.length, durationMs: Date.now() - start, background: silent });
        return;
      }
      trip.path = joined;
      trip.pathCount = null; // appended pieces: the count no longer matches one download
    } else {
      const positions = await fetchRoute(device, trip.range.from, to);
      received = Array.isArray(positions) ? positions.length : 0;
      trip.path = renumberPathByTripStart(positionsToPath(positions), trip);
      trip.fullLoadAt = Date.now();
      trip.pathCount = positions?.stand || null;
    }
    trip.pathDevice = device;
    trip.pathCoarse = false;
    trip.pathChecked = true;
    trip.pathCheckedAt = Date.now();
    setTripFigures(trip);
    writeRoute(storeKey, {
      device, rows: packPath(trip.path), count: trip.pathCount, fullLoadAt: trip.fullLoadAt || 0, savedAt: Date.now(),
    });
    pathLoaded();
    logRouteLoad({ ok: true, kind, received, newPoints: kind === "new" ? trip.path.length - lengthBefore : trip.path.length, total: trip.path.length, durationMs: Date.now() - start, background: silent });
    emit(silent ? "tripPath" : "trips");
    saveSnapshot();
  } catch (err) {
    pathFailuresInARow++;
    logRouteLoad({ ok: false, kind, error: err.message || String(err), inARow: pathFailuresInARow, durationMs: Date.now() - start, background: silent });
    if (!silent) setStatus({ error: `Route konnte nicht geladen werden: ${err.message}` });
    else if (pathFailuresInARow >= 2 && !status.error) setStatus({ error: WEAK_CONNECTION_HINT });
  }
}

/** Trip figures from the track (kilometres, highest point, kilometres per day). */
function setTripFigures(trip) {
  if (!trip.path?.length) return;
  trip.km = Math.round(pathLengthKm(trip.path));
  trip.peak = Math.round(elevationRange(trip.path).max);
  const days = kmPerDay(trip.path);
  trip.bars = days.bars;
  trip.barLabels = days.labels;
}

/** Take a route stored on the device. Records written before the code moved to
 * English use the keys "stand" and "pfadVollUm". */
function takeStoredPath(trip, stored) {
  trip.path = renumberPathByTripStart(unpackPath(stored.rows), trip);
  trip.pathDevice = stored.device;
  trip.pathCoarse = false;
  trip.pathChecked = false;
  trip.pathCount = stored.count || stored.stand || null;
  trip.fullLoadAt = stored.fullLoadAt || stored.pfadVollUm || 0;
  setTripFigures(trip);
}

/**
 * On start: take the routes of all trips stored on the device, so the map,
 * trip and day values are there at once. They are checked or reloaded
 * afterwards through ensureTripPath() as usual.
 */
export async function restoreStoredRoutes() {
  if (state.config.demo || !state.config.device) return;
  const device = state.config.device;
  let changed = false;
  for (const t of [...state.trips]) {
    if (t.path?.length && !t.pathCoarse && t.pathDevice === device) continue;
    const stored = await readRoute(routeKey(t, device));
    // The trip may have been replaced by a fresh state in the meantime.
    const current = state.trips.find((x) => x.id === t.id);
    if (!current || !stored?.rows?.length || stored.device !== device) continue;
    if (current.path?.length && !current.pathCoarse && current.pathDevice === device) continue;
    takeStoredPath(current, stored);
    changed = true;
  }
  if (changed) emit("trips");
}

function pathLoaded() {
  pathFailuresInARow = 0;
  if (status.error === WEAK_CONNECTION_HINT) setStatus({ error: null });
}

export async function buildRangeTrip({ from, to, label = "Zeitraum" } = {}) {
  if (!state.config.device || !from) return null;
  const end = to || new Date().toISOString();
  const positions = await fetchRoute(state.config.device, from, end);
  const path = annotateRangePath(positionsToPath(Array.isArray(positions) ? positions : []));
  const days = kmPerDay(path);
  return {
    id: "__range",
    type: "zeitraum",
    name: label,
    dates: "",
    live: false,
    hue: 198,
    path,
    km: Math.round(pathLengthKm(path)),
    nights: 0,
    peak: Math.round(elevationRange(path).max),
    bars: days.bars,
    barLabels: days.labels,
    range: { from, to: end },
    start: from,
    end,
  };
}

function annotateRangePath(path) {
  const tripsById = new Map(state.trips.map((trip) => [trip.id, trip]));
  return path.map((point) => {
    const tripId = tripAt(point.time);
    const trip = tripId ? tripsById.get(tripId) : null;
    return trip
      ? { ...point, tripId, tripHue: trip.hue, tripName: trip.name }
      : { ...point, tripId: null, tripHue: null, tripName: "" };
  });
}

/** Loads the vehicle's last reported position. */
export async function loadLivePosition() {
  if (state.config.demo || !isConfigured() || !state.config.device) return null;
  try {
    const list = await fetchPositions(state.config.device);
    const p = Array.isArray(list) ? list[0] : null;
    if (!p || !Number.isFinite(p.longitude) || !Number.isFinite(p.latitude)) return null;
    state.livePosition = {
      lon: p.longitude, lat: p.latitude,
      at: p.fixTime || p.deviceTime || null,
      speed: Number.isFinite(p.speed) ? p.speed * 1.852 : 0,
    };
    try { localStorage.setItem(LIVE_POSITION_KEY, JSON.stringify(state.livePosition)); } catch { /* ignore */ }
    saveSnapshot();
    emit("livePosition");
    return state.livePosition;
  } catch {
    return null; // silent failure: the map simply stays as it is
  }
}

export function restoreLivePosition() {
  try {
    const p = JSON.parse(localStorage.getItem(LIVE_POSITION_KEY) || "null");
    if (!p || !Number.isFinite(p.lon) || !Number.isFinite(p.lat)) return null;
    state.livePosition = {
      lon: p.lon,
      lat: p.lat,
      at: p.at || null,
      speed: Number.isFinite(p.speed) ? p.speed : 0,
    };
    return state.livePosition;
  } catch {
    return null;
  }
}

/** "Lokale Daten löschen" in the settings: the offline / quick-start snapshot
 * (trips, places, notes, routes) and the last known position. Only the local
 * mirror — with a connection the app simply loads again from the API. */
export function forgetSnapshot() {
  clearRoutes();
  try { localStorage.removeItem(SNAPSHOT_KEY); } catch { /* ignore */ }
  try { localStorage.removeItem(LIVE_POSITION_KEY); } catch { /* ignore */ }
}

/**
 * The server detects drives from the movement itself (segmentDrives). They are
 * not stored but loaded for a time span and assigned to the trips by time. A
 * drive that falls into no trip is an everyday drive.
 */
export async function loadDrives({ days = 30, from = null, to = null, silent = false } = {}) {
  if (state.config.demo || !isConfigured() || !state.config.device) { state.drives = []; return; }
  const rangeFrom = from || new Date(Date.now() - days * 86400000).toISOString();
  const rangeTo = to || new Date().toISOString();
  try {
    const [raw] = await Promise.all([fetchDrives(state.config.device, rangeFrom, rangeTo), loadDriveAssignments()]);
    state.drives = (Array.isArray(raw) ? raw : []).flatMap((t, i) => {
      const from = t.startTime || t.start_time || t.from || t.start;
      if (!from) return [];
      const to = t.endTime || t.end_time || t.to || t.end || null;
      const key = driveKey(t.deviceId, from);
      const tripByTime = tripOverlapping(from, to);
      const assignedByHand = Object.prototype.hasOwnProperty.call(state.driveAssignments, key);
      const startLat = Number(t.startLat ?? t.startLatitude);
      const startLon = Number(t.startLon ?? t.startLongitude);
      return [{
        id: `drive_${i}_${from}`,
        key,
        deviceId: t.deviceId || state.config.device,
        from,
        to,
        km: Number.isFinite(t.distance) ? t.distance / 1000 : 0,
        minutes: Number.isFinite(t.duration) ? Math.round(t.duration / 60000) : 0,
        avgKmh: Number.isFinite(t.averageSpeed) ? t.averageSpeed * 1.852 : 0,
        maxKmh: Number.isFinite(t.maxSpeed) ? t.maxSpeed * 1.852 : 0,
        startAddress: t.startAddress || "",
        endAddress: t.endAddress || "",
        startLat: Number.isFinite(startLat) ? startLat : null,
        startLon: Number.isFinite(startLon) ? startLon : null,
        // An assignment made by hand beats the assignment by time.
        tripId: assignedByHand ? state.driveAssignments[key] : tripByTime,
        manual: assignedByHand,
        kind: state.driveKinds[key] === "abstecher" ? "abstecher" : "etappe",
        weather: state.driveWeather[key] || null,
      }];
    }).sort((a, b) => String(b.from).localeCompare(String(a.from)));
    debugLog("drives.loaded", {
      requestedFrom: rangeFrom, requestedTo: rangeTo, raw: Array.isArray(raw) ? raw.length : "not-array",
      activeTripId: state.activeTripId,
      trips: state.trips.map((t) => ({ id: t.id, name: t.name, range: t.range, live: t.live })),
      drives: state.drives.map((d) => ({ key: d.key, from: d.from, to: d.to, tripId: d.tripId, manual: d.manual })),
    });
    emit("drives");
    saveSnapshot();
    loadDriveWeather();
  } catch (err) {
    // KEEP the last loaded drive list: setting it to [] made the map fall back to
    // "all points, no drives" on a bad connection (stage filter off, detours
    // visible, pieces joined).
    debugLog("drives.fetch-failed", { error: err.message || String(err), kept: state.drives.length, silent });
    if (!silent) setStatus({ error: `Fahrten konnten nicht geladen werden: ${err.message}` });
  }
}

/**
 * Key of a drive or stop: device and start time identify it. Deliberately the
 * ACTUAL device id of the position data (`deviceId` from the API response, see
 * api/lib.js), not the one currently configured for the vehicle
 * (`state.config.device`) — otherwise renaming the device id in the settings
 * would make all earlier manual assignments and visits unfindable. Falls back
 * to `state.config.device` only when no deviceId is known.
 */
export const driveKey = (deviceId, from) => `${deviceId || state.config.device}|${from}`;

async function loadDriveAssignments() {
  try {
    const rows = await listDriveAssignments();
    state.driveAssignments = Object.fromEntries((rows || [])
      .filter((r) => r.assignment === "manual" || (r.assignment == null && r.trip_id))
      .map((r) => [r.drive_key, r.trip_id || null]));
    state.driveWeather = Object.fromEntries(
      (rows || []).filter((r) => r.weather).map((r) => [r.drive_key, parseWeather(r.weather)])
    );
    state.driveKinds = Object.fromEntries((rows || [])
      .filter((r) => r.kind === "abstecher")
      .map((r) => [r.drive_key, "abstecher"]));
    debugLog("drive-assignments.loaded", {
      rows: (rows || []).map((r) => ({ key: r.drive_key, tripId: r.trip_id, assignment: r.assignment, kind: r.kind, hasWeather: Boolean(r.weather) })),
      manualKeys: Object.keys(state.driveAssignments),
      detourKeys: Object.keys(state.driveKinds),
    });
  } catch {
    state.driveAssignments = {}; // without assignments the assignment by time applies
    state.driveKinds = {};
    state.driveWeather = {};
  }
}

/**
 * Load the weather at the start of every drive that has none yet — in the
 * background and limited to a few drives per call, so a look at 30 days of
 * history does not trigger 30 days of weather requests at once. The rest
 * follows on the next load.
 */
async function loadDriveWeather({ max = 8 } = {}) {
  if (state.config.demo || !isConfigured()) return;
  const candidates = state.drives
    .filter((d) => !d.weather && Number.isFinite(d.startLat) && Number.isFinite(d.startLon))
    .slice(0, max);
  for (const d of candidates) {
    try {
      const weather = await fetchWeather(d.startLat, d.startLon, d.from);
      await cacheDriveWeather(d.key, JSON.stringify(weather));
      state.driveWeather[d.key] = weather;
      const drive = state.drives.find((x) => x.key === d.key);
      if (drive) drive.weather = weather;
    } catch {
      // Without weather the drive stays complete — just without this detail.
    }
  }
  if (candidates.length) emit("drives");
  if (candidates.length) saveSnapshot();
}

/** Which trip encloses this point in time? */
function tripAt(time) {
  const t = Date.parse(time);
  if (!Number.isFinite(t)) return null;
  for (const trip of state.trips) {
    const from = Date.parse(trip.range?.from ?? "");
    const to = trip.range?.to ? Date.parse(trip.range.to) : Date.now();
    if (Number.isFinite(from) && t >= from && t <= to) return trip.id;
  }
  return null;
}

/** Which trip overlaps the time span of a drive? */
function tripOverlapping(fromTime, toTime) {
  const start = Date.parse(fromTime);
  const end = toTime ? Date.parse(toTime) : start;
  if (!Number.isFinite(start)) return null;
  const driveEnd = Number.isFinite(end) ? end : start;
  for (const trip of state.trips) {
    const from = Date.parse(trip.range?.from ?? "");
    const to = trip.range?.to ? Date.parse(trip.range.to) : Date.now();
    if (Number.isFinite(from) && driveEnd >= from && start <= to) return trip.id;
  }
  return null;
}

/** Load the track of a single drive. */
export async function drivePath(drive) {
  if (!state.config.device) return [];
  const from = shiftedIso(drive.from, -2 * 60000);
  const to = shiftedIso(drive.to || new Date().toISOString(), 2 * 60000);
  debugLog("drive-path.request", { key: drive.key, from: drive.from, to: drive.to, requestedFrom: from, requestedTo: to });
  const raw = await fetchRoute(state.config.device, from, to);
  const path = positionsToPath(raw);
  debugLog("drive-path.loaded", { key: drive.key, raw: Array.isArray(raw) ? raw.length : "not-array", pathPoints: path.length });
  return path;
}

function shiftedIso(iso, deltaMs) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t + deltaMs).toISOString();
}

/* ---------- Automatic overnight stays ---------- */

// Titles an automatic detection gives while no address is known. The detection
// itself (creating overnight stays and stops) runs on the server in the ingest
// container (tracker-backend/src/auto-import.js) since 6 September 2026. This
// list stays here because store.js needs it to decide whether a name suggestion
// arriving later may still replace the title, or whether a person already
// changed it — one exported source instead of scattered string literals.
// The titles are UI text and stay German.
export const AUTO_PLACE_PLACEHOLDER_TITLES = ["Aktuelle Übernachtung", "Übernachtung", "Stopp"];

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

// Radius for recognising an already known PLACE across trips — the same
// threshold as in tracker-backend/src/auto-import.js (change both together).
const PLACE_RECOGNITION_RADIUS_KM = 0.3;

/**
 * Is there (across ALL trips, not only the current one) already a place of the
 * same category nearby? For a really NEW visit at a known place — e.g. the same
 * camp site as last year, entered by hand in the place editor (the automatic
 * detection runs on the server and has its own copy of this logic). Reusing the
 * existing ort_id makes "how often was I here" (placesWithVisitCount()) count
 * right instead of creating a new, unlinked place for every visit. Takes the
 * nearest match, not just the first.
 */
export function findExistingPlace({ lat, lon, catId }) {
  let best = null, bestDistance = Infinity;
  for (const p of state.places) {
    if (!p.ortId || p.catId !== catId) continue;
    const d = distanceBetweenKm({ lat, lon }, p);
    if (d <= PLACE_RECOGNITION_RADIUS_KM && d < bestDistance) { best = p; bestDistance = d; }
  }
  return best?.ortId || null;
}

/**
 * Load the trips again — after every change stored centrally, so the app shows
 * the state of the database and not a local assumption.
 */
export async function reloadTrips() {
  if (state.config.demo || !isConfigured()) return;
  const previousMapTripId = state.mapTripId;
  const previousWasActive = previousMapTripId && previousMapTripId === state.activeTripId;
  const rows = await listTrips();
  state.trips = (rows || []).map(toTrip);
  const fallback = defaultTrip(state.trips);
  const active = fallback?.live ? fallback : null;
  state.activeTripId = active?.id || null;
  const mapTripStillExists = state.trips.some((t) => t.id === state.mapTripId);
  if (!mapTripStillExists || previousWasActive) {
    state.mapTripId = fallback?.id || null;
  }
  emit("trips");
  debugLog("trips.reloaded", {
    trips: state.trips.map((t) => ({ id: t.id, name: t.name, range: t.range, live: t.live })),
    activeTripId: state.activeTripId, mapTripId: state.mapTripId,
  });
  await loadDrives();
  const shown = state.trips.find((t) => t.id === state.mapTripId) || fallback;
  if (shown) await ensureTripPath(shown);
  saveSnapshot();
}

/** Loads the data for the chosen source. */
export async function loadData() {
  if (state.config.demo) {
    state.livePosition = null;
    state.drives = [];
    loadDemoData();
    applyLocalData();
    setStatus({ mode: "demo", loading: false, error: null });
    emit("trips");
    return;
  }

  if (!isConfigured()) {
    state.trips = [];
    state.places = [];
    state.notes = [];
    state.activeTripId = null;
    state.mapTripId = null;
    setStatus({ mode: "live", loading: false, error: "Nicht angemeldet — bitte neu laden und anmelden." });
    emit("trips");
    return;
  }

  setStatus({ mode: "live", loading: true, error: null });
  const previousMapTripId = state.mapTripId;
  const previousTrips = new Map(state.trips.map((t) => [t.id, t]));
  try {
    const [trips, places, notes, categories, photos, vehicles, diary] = await Promise.all([
      listTrips(), listPlaces(), listNotes().catch(() => []), listCategories().catch(() => []), listPhotos().catch(() => []),
      listVehicles().catch(() => []), listDiary().catch(() => null),
    ]);

    state.trips = (trips || []).map((row, index) => tripWithLastState(toTrip(row, index), previousTrips.get(row.id)));
    state.places = (places || []).map(toPlace);
    state.notes = (notes || []).map(toNote);
    state.photos = (photos || []).map(toPhoto);
    // If loading the diary fails (e.g. briefly offline), the previous state stays.
    if (diary) state.diary = diary.map(toDiaryEntry);
    const fallback = defaultTrip(state.trips);
    const active = fallback?.live ? fallback : null;
    state.activeTripId = active?.id || null;
    state.mapTripId = state.trips.some((t) => t.id === previousMapTripId) ? previousMapTripId : (fallback?.id || null);

    // Settings shared across devices win over the local state.
    const prefs = await loadSettings().catch(() => null);
    if (prefs && Object.keys(prefs).length) applyPreferences(prefs);
    else applyLocalData();

    // Categories AND vehicles are applied AFTER applyPreferences/applyLocalData,
    // so they are sure to win and are not overwritten. Seen 16 August 2026
    // (vehicles) and 6 September 2026 (categories): both used to go through
    // the collected settings store, which is only replaced as a whole on load —
    // a second device saw its own, possibly outdated state and "whoever saves
    // last" won. The categories and vehicles tables are synchronised on every
    // change and are now the only source on load.
    if (categories?.length) {
      state.categories = Object.fromEntries(categories.map((c) => [c.id, { name: c.name, color: c.color || "#888" }]));
    }
    if (vehicles?.length) {
      state.vehicles = vehicles.map(toVehicle);
      const activeIndex = vehicles.findIndex((v) => v.active);
      state.activeVehicle = activeIndex >= 0 ? activeIndex : 0;
      state.config.device = state.vehicles[state.activeVehicle]?.device || "";
      saveConfig();
    }
    setStatus({ mode: "live", loading: false, error: null });
    emit("trips");
    debugLog("data.loaded", {
      trips: state.trips.map((t) => ({ id: t.id, name: t.name, range: t.range, live: t.live })),
      places: state.places.length, notes: state.notes.length, categories: Object.keys(state.categories).length,
      activeTripId: state.activeTripId, mapTripId: state.mapTripId,
    });
    await loadDrives();
    const shown = state.trips.find((t) => t.id === state.mapTripId) || fallback;
    if (shown) await ensureTripPath(shown);
    saveSnapshot();
  } catch (err) {
    setStatus({ mode: "live", loading: false, error: `Daten konnten nicht geladen werden: ${err.message}` });
    emit("trips");
  }
}
