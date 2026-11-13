// Central app state — one source of truth.
//
// Key decision: there is exactly ONE list of places (`state.places`).
// Overnight stays are ordinary places with `catId: "uebernachtung"` and a
// running night number. Trips only hold their route (`path`) and refer to
// their places through `tripId` — nothing is kept twice.

const listeners = new Set();

// Valid values for state.routeDriveFilter — in ONE place, not as a literal list
// copied into four places (that is exactly why adding "nicht_zugeordnet" first
// did nothing: setRouteDriveFilter() still had the old, shorter list and
// silently rejected the new value). The values are stored and stay German.
export const ROUTE_DRIVE_FILTERS = ["etappe", "abstecher", "alle", "nicht_zugeordnet"];

// Same trap, same fix: valid values for state.metric (map colouring) in ONE place.
export const MAP_METRICS = ["none", "trip", "day", "speed", "elev", "dist"];

export const state = {
  trips: [],          // { id, name, dates, live, km, nights, peak, hue, path, bars, barLabels }
  places: [],         // visit and place flattened: { id, ortId, tripId|null (computed), catId, title, note, stars, date, at, lon, lat, source, hue }
  notes: [],          // { id, tripId|null (computed), besuchId|null, text, at, lon, lat, source }
  photos: [],         // { id, besuchId|null, noteId|null, tagebuchId|null, takenAt, lat, lon, width, height }
  diary: [],          // { id, tripId, dayKey, blocks, author, createdAt, updatedAt } — one entry per trip and day
  livePosition: null, // { lon, lat, at, speed } — the vehicle's last report
  drives: [],         // drives from the server: { id, from, to, km, minutes, startAddress, endAddress, tripId, kind }
  adhocTrip: null,    // a single drive currently shown on the map
  rangeTrip: null,    // temporary time span: map and statistics across several trips
  driveAssignments: {}, // drive key -> trip id (null = explicitly everyday)
  driveKinds: {},     // drive key -> etappe | abstecher
  driveWeather: {},   // drive key -> weather at the start (cache)
  categories: {},     // id -> { name, color }
  vehicles: [],       // { name, device }
  activeVehicle: 0,
  showVehicleName: true,
  alarmTypes: [],
  alarmLog: [],
  guardArmed: true,
  guardRadius: 50, // metres around the position when arming (no zones, see guard.js)
  guardAnchor: null, // { lat, lon } of the anchor, for the steady-light check in main.js
  guardZoneRadius: null, // metres — the radius ACTUALLY stored when last armed (guardRadius is only the input field)
  guardSince: null, // ISO time of the last arming (from the alarm log)
  guardAnchorName: null, // address of the anchor (reverse geocoding), display only
  dailyDrives: [],

  // View state
  activeTripId: null, // the running trip
  mapTripId: null,    // the trip shown on the map
  metric: "day",      // see MAP_METRICS above
  routeDriveFilter: "etappe", // see ROUTE_DRIVE_FILTERS above
  layers: { nights: true, places: true, notes: true, km: false },
  filters: { text: "", cats: {}, trip: "", source: "", ref: "none", radius: 0 },
  // demo: false by default — main.js sets it to true on start for "not signed
  // in" / "API unreachable" (see there). A signed-in user never gets an explicit
  // `= false`, but runs with what is here or in localStorage. true as the
  // default was wrong for a freshly installed PWA (empty localStorage): a user
  // who was really signed in first saw the built-in demo trip (seen 16 August 2026).
  // mapStyle values "farbig" / "dezent" are stored and stay German.
  config: { device: "", demo: false, theme: "auto", terrain: false, mapStyle: "farbig", markGaps: false },
  account: null,     // { username, email, emailVerified, isAdmin } when signed in
  guest: null,       // { scope, allTrips, label, token } when opened through a sharing link (never together with account)
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Counts every change of the data that trip and day values are computed from.
// Views use it to keep computed values until something actually changed.
const DATA_TOPICS = new Set(["*", "trips", "tripPath", "drives", "notes", "places", "photos", "vehicles", "routeDriveFilter", "config"]);
let revision = 0;
export const dataRevision = () => revision;

/** Announces a change. `topic` allows redrawing only what is affected. */
export function emit(topic = "*") {
  if (DATA_TOPICS.has(topic)) revision++;
  for (const fn of listeners) fn(topic);
}

/* ---------- Queries ---------- */

export const trip = (id) => state.trips.find((t) => t.id === id) || null;
export const activeTrip = () => trip(state.activeTripId);
export const mapTrip = () => state.adhocTrip || state.rangeTrip || trip(state.mapTripId) || state.trips[0] || null;

/**
 * The trip whose logbook is shown. Deliberately WITHOUT `adhocTrip`: showing a
 * single drive on the map is a map preview — the logbook must not suddenly show
 * an empty drive instead of the real trip (that looked like lost entries).
 */
export const journalTrip = () => state.rangeTrip || trip(state.mapTripId) || state.trips[0] || null;

export function isRangeTrip(t) {
  return Boolean(t?.type === "zeitraum");
}

function inIsoRange(iso, range) {
  const value = Date.parse(iso || "");
  const from = Date.parse(range?.from || "");
  const to = Date.parse(range?.to || "");
  if (!Number.isFinite(value) || !Number.isFinite(from)) return false;
  return value >= from && (!Number.isFinite(to) || value <= to);
}

export function rangeTrips(range = state.rangeTrip?.range) {
  if (!range?.from) return [];
  return state.trips
    .filter((t) => {
      const from = Date.parse(t.range?.from || t.start || "");
      const to = Date.parse(t.range?.to || t.end || new Date().toISOString());
      const rangeFrom = Date.parse(range.from);
      const rangeTo = Date.parse(range.to || new Date().toISOString());
      return Number.isFinite(from) && Number.isFinite(to) && to >= rangeFrom && from <= rangeTo;
    })
    .sort((a, b) => String(b.range?.from || b.start || "").localeCompare(String(a.range?.from || a.start || "")));
}

/** Show a single drive on the map (without making it a trip). */
export function showAdhocOnMap(tripLike) {
  state.adhocTrip = tripLike;
  emit("mapTrip");
}
export function clearAdhoc() {
  if (!state.adhocTrip) return;
  state.adhocTrip = null;
  emit("mapTrip");
}
export const category = (id) => state.categories[id] || { name: "—", color: "#888" };

/** All places of a trip: overnight stays first, then the rest (each in time order). */
export function tripPlaces(tripId) {
  if (tripId === state.rangeTrip?.id) {
    return state.places
      .filter((p) => inIsoRange(p.at, state.rangeTrip.range))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }
  return state.places
    .filter((p) => p.tripId === tripId)
    .sort((a, b) => {
      const an = a.catId === "uebernachtung" ? 0 : 1;
      const bn = b.catId === "uebernachtung" ? 0 : 1;
      return an !== bn ? an - bn : String(a.at).localeCompare(String(b.at));
    });
}

/** Notes of a trip, in time order. */
export const tripNotes = (tripId) =>
  tripId === state.rangeTrip?.id
    ? state.notes.filter((n) => inIsoRange(n.at, state.rangeTrip.range)).sort((a, b) => String(a.at).localeCompare(String(b.at)))
    : state.notes.filter((n) => n.tripId === tripId).sort((a, b) => String(a.at).localeCompare(String(b.at)));

/** Photos of a visit or a note, by time taken. `placeId` means the visit id
 * (besuchId), as everywhere in the UI. */
export const placePhotos = (placeId) =>
  state.photos.filter((p) => p.besuchId === placeId).sort((a, b) => String(a.takenAt).localeCompare(String(b.takenAt)));
export const notePhotos = (noteId) =>
  state.photos.filter((p) => p.noteId === noteId).sort((a, b) => String(a.takenAt).localeCompare(String(b.takenAt)));

export function upsertPhoto(photo) {
  const i = state.photos.findIndex((p) => p.id === photo.id);
  if (i >= 0) state.photos[i] = { ...state.photos[i], ...photo };
  else state.photos.push(photo);
  emit("photos");
}

export function removePhoto(id) {
  const i = state.photos.findIndex((p) => p.id === id);
  if (i >= 0) state.photos.splice(i, 1);
  emit("photos");
}

/** Photos of a diary entry, by time taken. */
export const diaryPhotos = (entryId) =>
  state.photos.filter((p) => p.tagebuchId === entryId).sort((a, b) => String(a.takenAt).localeCompare(String(b.takenAt)));

export const diaryEntryFor = (tripId, dayKey) => state.diary.find((e) => e.tripId === tripId && e.dayKey === dayKey) || null;

export function upsertDiaryEntry(entry) {
  const i = state.diary.findIndex((e) => e.id === entry.id || (e.tripId === entry.tripId && e.dayKey === entry.dayKey));
  if (i >= 0) state.diary[i] = { ...state.diary[i], ...entry };
  else state.diary.push(entry);
  emit("notes");
}

export function removeDiaryEntry(id) {
  const i = state.diary.findIndex((e) => e.id === id);
  if (i >= 0) state.diary.splice(i, 1);
  state.photos = state.photos.filter((p) => p.tagebuchId !== id);
  emit("notes");
}

export function upsertNote(note) {
  const i = state.notes.findIndex((n) => n.id === note.id);
  if (i >= 0) state.notes[i] = { ...state.notes[i], ...note };
  else state.notes.push(note);
  emit("notes");
}

export function removeNote(id) {
  const i = state.notes.findIndex((n) => n.id === id);
  if (i >= 0) state.notes.splice(i, 1);
  emit("notes");
}

export const nightsOf = (tripId) =>
  state.places
    .filter((p) => p.tripId === tripId && p.catId === "uebernachtung")
    .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")) || String(a.id).localeCompare(String(b.id)));

/**
 * Running number of an overnight stay within its trip — sorted by time and
 * computed on every call, so the numbering stays complete and right when an
 * earlier stay is added or one is deleted, without renumbering anything.
 */
export function nightNumber(place) {
  if (!place || place.catId !== "uebernachtung") return null;
  const order = nightsOf(place.tripId);
  const index = order.findIndex((p) => p.id === place.id);
  return index >= 0 ? index + 1 : null;
}

/** Sum of the nights actually spent on a trip (not the number of stops). */
export const nightsCount = (tripId) =>
  nightsOf(tripId).reduce((sum, p) => sum + (Number.isInteger(p.nights) && p.nights > 0 ? p.nights : 1), 0);

export function placeCounts() {
  const counts = {};
  for (const p of state.places) counts[p.catId] = (counts[p.catId] || 0) + 1;
  return counts;
}

/* ---------- Changes ---------- */

let seq = 0;
export const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}`;

export function upsertPlace(place) {
  const i = state.places.findIndex((p) => p.id === place.id);
  if (i >= 0) state.places[i] = { ...state.places[i], ...place };
  else state.places.push(place);
  emit("places");
}

export function removePlace(id) {
  const i = state.places.findIndex((p) => p.id === id);
  if (i >= 0) state.places.splice(i, 1);
  emit("places");
}

export function setMetric(metric) {
  if (!MAP_METRICS.includes(metric)) return;
  state.metric = metric;
  emit("metric");
}

export function setRouteDriveFilter(filter) {
  if (!ROUTE_DRIVE_FILTERS.includes(filter)) return;
  state.routeDriveFilter = filter;
  saveLocalData();
  emit("routeDriveFilter");
}

export function showTripOnMap(id) {
  state.adhocTrip = null;
  state.rangeTrip = null;
  state.mapTripId = id;
  emit("mapTrip");
}

export function showRangeOnMap(rangeTrip) {
  state.adhocTrip = null;
  state.rangeTrip = rangeTrip;
  emit("mapTrip");
}

export function endTrip() {
  const t = activeTrip();
  if (!t) return;
  t.live = false;
  t.dates = t.dates.replace(/^seit /, "").replace(/ · unterwegs$/, "") + " (beendet)";
  state.activeTripId = null;
  emit("trips");
}

export function resumeTrip(id) {
  const t = trip(id);
  if (!t) return;
  const current = activeTrip();
  if (current && current !== t) current.live = false;
  t.live = true;
  t.dates = t.dates.replace(" (beendet)", "");
  state.activeTripId = id;
  emit("trips");
}

export function startTrip(path) {
  const id = newId("trip");
  state.trips.unshift({
    id, name: "Neue Reise", dates: "seit heute · Tag 1 · unterwegs", live: true,
    km: 0, nights: 0, peak: 0, hue: 15, path, bars: [0], barLabels: ["Tag 1"],
  });
  state.activeTripId = id;
  state.mapTripId = id;
  emit("trips");
  return id;
}

export function deleteTrip(id) {
  if (id === state.activeTripId) return;
  const i = state.trips.findIndex((t) => t.id === id);
  if (i >= 0) state.trips.splice(i, 1);
  for (const p of state.places) if (p.tripId === id) p.tripId = null;
  if (state.mapTripId === id) state.mapTripId = state.activeTripId || (state.trips[0] && state.trips[0].id) || null;
  emit("trips");
}

/* ---------- Kept on the device ---------- */

const CFG_KEY = "vojago.config";
const LOCAL_KEY = "vojago.local";

/**
 * Categories and vehicles belong to the user — they must not disappear on a
 * restart. They are kept locally as a fallback; what is stored is the current
 * state, not a difference to the defaults.
 */
export function saveLocalData() {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify({
      categories: state.categories,
      vehicles: state.vehicles,
      activeVehicle: state.activeVehicle,
      showVehicleName: state.showVehicleName,
      metric: state.metric,
      routeDriveFilter: state.routeDriveFilter,
      layers: state.layers,
    }));
  } catch { /* storage full or blocked */ }
}

/** Lay the stored state over the loaded defaults. */
export function applyLocalData() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null"); } catch { return; }
  if (!saved) return;
  if (saved.categories && Object.keys(saved.categories).length) state.categories = saved.categories;
  if (Array.isArray(saved.vehicles) && saved.vehicles.length) state.vehicles = saved.vehicles;
  if (Number.isInteger(saved.activeVehicle)) state.activeVehicle = Math.min(saved.activeVehicle, state.vehicles.length - 1);
  if (typeof saved.showVehicleName === "boolean") state.showVehicleName = saved.showVehicleName;
  if (MAP_METRICS.includes(saved.metric)) state.metric = saved.metric;
  if (ROUTE_DRIVE_FILTERS.includes(saved.routeDriveFilter)) state.routeDriveFilter = saved.routeDriveFilter;
  if (saved.layers && typeof saved.layers === "object") Object.assign(state.layers, saved.layers);
}

/**
 * What applies across devices. Deliberately NOT included: vehicles,
 * activeVehicle and device. Seen on 16 August 2026: this collected store is
 * replaced as a whole only on load — when a second device signed in before the
 * first had saved, both saw different states and the device saving last simply
 * won. Vehicles have their own synchronised table (`vehicles`, api/router.js);
 * dataload.js loads it fresh on every start.
 */
export const collectPreferences = () => ({
  categories: state.categories,
  showVehicleName: state.showVehicleName,
  metric: MAP_METRICS.includes(state.metric) ? state.metric : "day",
  routeDriveFilter: ROUTE_DRIVE_FILTERS.includes(state.routeDriveFilter) ? state.routeDriveFilter : "etappe",
  layers: state.layers,
});

export function applyPreferences(prefs) {
  if (!prefs || typeof prefs !== "object") return;
  if (prefs.categories && Object.keys(prefs.categories).length) state.categories = prefs.categories;
  if (typeof prefs.showVehicleName === "boolean") state.showVehicleName = prefs.showVehicleName;
  if (MAP_METRICS.includes(prefs.metric)) state.metric = prefs.metric;
  if (ROUTE_DRIVE_FILTERS.includes(prefs.routeDriveFilter)) state.routeDriveFilter = prefs.routeDriveFilter;
  if (prefs.layers && typeof prefs.layers === "object") Object.assign(state.layers, prefs.layers);
}

/** Reset to factory state (reachable in the settings). */
export function forgetLocalData() {
  try { localStorage.removeItem(LOCAL_KEY); } catch { /* ignore */ }
}

// Config keys used before the code moved to English; stored values are taken over once.
const OLD_CONFIG_KEYS = { gelaende: "terrain", kartenstil: "mapStyle", lueckenMarkieren: "markGaps" };

/** Config as stored on the device, with the old German keys renamed. */
export function migrateConfig(stored) {
  const out = { ...(stored && typeof stored === "object" ? stored : {}) };
  for (const [old, now] of Object.entries(OLD_CONFIG_KEYS)) {
    if (old in out) {
      if (!(now in out)) out[now] = out[old];
      delete out[old];
    }
  }
  return out;
}

export function loadConfig() {
  try {
    Object.assign(state.config, migrateConfig(JSON.parse(localStorage.getItem(CFG_KEY) || "{}")));
  } catch { /* ignore invalid data */ }
}

export function saveConfig() {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(state.config)); } catch { /* storage full or blocked */ }
  emit("config");
}
