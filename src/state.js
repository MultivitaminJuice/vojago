// Zentrale Datenhaltung — eine Quelle der Wahrheit.
//
// Wichtigste Entscheidung: Es gibt genau EINE Ortsliste (`state.places`).
// Übernachtungen sind dort ganz normale Orte mit `catId: "uebernachtung"`
// und einer laufenden `night`-Nummer. Reisen halten nur ihre Route (`path`)
// und verweisen über `tripId` auf ihre Orte — nichts wird doppelt geführt.

const listeners = new Set();

// Gültige Werte für state.routeDriveFilter — an EINER Stelle, nicht als
// literale Liste an vier Stellen dupliziert (genau das führte beim
// Hinzufügen von "nicht_zugeordnet" dazu, dass der Klick auf den neuen
// Filter zunächst nichts tat: setRouteDriveFilter() hatte noch die alte,
// engere Liste und wies den neuen Wert still ab).
export const ROUTE_DRIVE_FILTERS = ["etappe", "abstecher", "alle", "nicht_zugeordnet"];

// Dieselbe Falle, derselbe Fix: gültige Werte für state.metric (Karten-
// Einfärbung) an EINER Stelle statt an sechs Stellen dupliziert.
export const MAP_METRICS = ["none", "trip", "day", "speed", "elev", "dist"];

export const state = {
  trips: [],          // { id, name, dates, live, km, nights, peak, hue, path, bars, barLabels }
  places: [],         // Besuch+Ort geflacht: { id, ortId, tripId|null (live berechnet), catId, title, note, stars, date, at, lon, lat, source, hue }
  notes: [],          // { id, tripId|null (live berechnet), besuchId|null, text, at, lon, lat, source }
  photos: [],         // { id, besuchId|null, noteId|null, takenAt, lat, lon, width, height }
  livePosition: null, // { lon, lat, at, speed } — letzte Meldung des Fahrzeugs
  drives: [],         // Fahrten vom Server: { id, from, to, km, minutes, startAddress, endAddress, tripId, kind }
  adhocTrip: null,    // einzelne Fahrt, die gerade auf der Karte liegt
  rangeTrip: null,    // temporärer Zeitraum-Kontext: Karte/Statistik über mehrere Reisen hinweg
  driveAssignments: {}, // Fahrt-Kennung -> Reise-ID (null = ausdrücklich Alltag)
  driveKinds: {},     // Fahrt-Kennung -> etappe | abstecher
  driveWeather: {},   // Fahrt-Kennung -> Wetter am Startpunkt (Zwischenspeicher)
  categories: {},     // id -> { name, color }
  vehicles: [],       // { name, device }
  activeVehicle: 0,
  showVehicleName: true,
  alarmTypes: [],
  alarmLog: [],
  guardArmed: true,
  guardRadius: 50, // Meter um die Position beim Scharfschalten (kein Zonen-Konzept, siehe guard.js)
  guardAnchor: null, // { lat, lon } des Ankerpunkts, für die Dauerlicht-Prüfung in main.js
  guardZoneRadius: null, // Meter — der beim letzten Scharfschalten TATSÄCHLICH gespeicherte Radius (guardRadius ist nur das Eingabefeld)
  guardSince: null, // ISO-Zeitpunkt des letzten Scharfschaltens (aus dem Alarm-Protokoll)
  guardAnchorName: null, // Adresse des Ankerpunkts (Reverse-Geocoding), nur zur Anzeige
  dailyDrives: [],

  // Ansichtszustand
  activeTripId: null, // laufende Reise (fachlich)
  mapTripId: null,    // auf der Karte gezeigte Reise (Ansicht)
  metric: "day",      // siehe MAP_METRICS oben
  routeDriveFilter: "etappe", // siehe ROUTE_DRIVE_FILTERS oben
  layers: { nights: true, places: true, notes: true, km: false },
  filters: { text: "", cats: {}, trip: "", source: "", ref: "none", radius: 0 },
  // demo: false als Grundzustand — main.js setzt es beim Start explizit auf
  // true für "nicht angemeldet"/"API nicht erreichbar" (siehe dort). Ein
  // angemeldeter Nutzer bekommt dagegen nie ein explizites `= false`
  // spendiert, sondern läuft mit dem, was hier steht bzw. in localStorage
  // liegt. Stand true als Grundzustand wäre für einen frisch installierten
  // PWA-Neustart (leeres localStorage, z. B. nach Neuinstallation) falsch:
  // ein wirklich angemeldeter Rückkehrer sah dann trotz gültiger Sitzung
  // erst die eingebaute Demo-Reise, bis der Schalter von Hand umgelegt
  // wurde (live beobachtet, 16. August 2026).
  config: { device: "", demo: false, theme: "auto", gelaende: false },
  account: null,     // { username, email, emailVerified, isAdmin } wenn angemeldet
  gast: null,        // { scope, alleReisen, label } wenn per Freigabe-Link geöffnet (nie zusammen mit account)
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Meldet eine Änderung. `topic` erlaubt gezieltes Neuzeichnen. */
export function emit(topic = "*") {
  for (const fn of listeners) fn(topic);
}

/* ---------- Abfragen ---------- */

export const trip = (id) => state.trips.find((t) => t.id === id) || null;
export const activeTrip = () => trip(state.activeTripId);
export const mapTrip = () => state.adhocTrip || state.rangeTrip || trip(state.mapTripId) || state.trips[0] || null;

/**
 * Die Reise, deren Tagebuch gezeigt wird. Bewusst OHNE `adhocTrip`: Zeigt man
 * eine einzelne Fahrt „auf der Karte“ (z. B. per Klick auf eine Fahrten-Zeile),
 * ist das eine Vorschau der Karte — das Tagebuch soll dabei nicht plötzlich
 * eine leere Fahrt statt der echten Reise zeigen (das sah wie verlorene
 * Einträge aus, waren aber nur die falsche Reise).
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

/** Eine einzelne Fahrt auf der Karte zeigen (ohne sie zu einer Reise zu machen). */
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

/** Alle Orte einer Reise: Übernachtungen zuerst, dann der Rest (jeweils chronologisch). */
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

/** Notizen einer Reise, chronologisch. */
export const tripNotes = (tripId) =>
  tripId === state.rangeTrip?.id
    ? state.notes.filter((n) => inIsoRange(n.at, state.rangeTrip.range)).sort((a, b) => String(a.at).localeCompare(String(b.at)))
    : state.notes.filter((n) => n.tripId === tripId).sort((a, b) => String(a.at).localeCompare(String(b.at)));

/** Fotos zu einem Besuch bzw. einer Notiz, nach Aufnahmezeit. `placeId`
 * meint hier wie überall in der Oberfläche die Besuch-ID (besuchId). */
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
 * Laufende Nummer einer Übernachtung innerhalb ihrer Reise — nach Zeitpunkt
 * sortiert und bei jedem Aufruf neu berechnet. So bleibt die Nummerierung
 * immer lückenlos und richtig, auch wenn nachträglich eine frühere
 * Übernachtung eingefügt oder eine gelöscht wird — ganz ohne Umnummerieren.
 */
export function nightNumber(place) {
  if (!place || place.catId !== "uebernachtung") return null;
  const reihenfolge = nightsOf(place.tripId);
  const index = reihenfolge.findIndex((p) => p.id === place.id);
  return index >= 0 ? index + 1 : null;
}

/** Summe der tatsächlich verbrachten Nächte einer Reise (nicht die Zahl der Stopps). */
export const nightsCount = (tripId) =>
  nightsOf(tripId).reduce((summe, p) => summe + (Number.isInteger(p.nights) && p.nights > 0 ? p.nights : 1), 0);

export function placeCounts() {
  const counts = {};
  for (const p of state.places) counts[p.catId] = (counts[p.catId] || 0) + 1;
  return counts;
}

/* ---------- Änderungen ---------- */

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

/* ---------- Dauerhaft merken ---------- */

const CFG_KEY = "vojago.config";
const LOCAL_KEY = "vojago.local";

/**
 * Kategorien und Fahrzeuge gehören dem Benutzer — sie dürfen beim Neustart
 * nicht verschwinden. Bis die API sie führt, werden sie lokal gesichert;
 * gespeichert wird der Ist-Zustand, nicht ein Unterschied zur Vorgabe.
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
  } catch { /* Speicher voll oder gesperrt */ }
}

/** Gesicherten Stand über die geladenen Vorgaben legen. */
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
 * Was geräteübergreifend gelten soll. Bewusst NICHT dabei: API-Adresse und
 * Token — sie sind der Schlüssel zu dieser Ablage und liegen deshalb auf dem
 * Gerät (sonst bräuchte man sie, um an sie heranzukommen).
 *
 * Ebenfalls bewusst NICHT dabei (mehr): vehicles/activeVehicle/device.
 * Echter Fund (16. August 2026): diese Sammel-Ablage wird nur BEIM LADEN
 * einmal komplett überschrieben — meldet sich ein zweites Gerät an, bevor
 * das erste je gespeichert hat, sehen beide unterschiedliche Stände, und
 * das zuletzt speichernde Gerät gewinnt einfach, ohne Rücksicht auf das
 * andere. Fahrzeuge haben mit der `vehicles`-Tabelle (api/router.js) längst
 * eine echte, sauber synchronisierte Ablage (jede Änderung landet
 * augenblicklich beim Server, nicht erst gesammelt) — dataload.js lädt sie
 * jetzt bei jedem Start frisch, das macht diese Sammel-Kopie überflüssig
 * (und potenziell irreführend, siehe oben).
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

/** Auf Werkszustand zurücksetzen (in den Einstellungen erreichbar). */
export function forgetLocalData() {
  try { localStorage.removeItem(LOCAL_KEY); } catch { /* egal */ }
}

export function loadConfig() {
  try {
    Object.assign(state.config, JSON.parse(localStorage.getItem(CFG_KEY) || "{}"));
  } catch { /* ungültige Daten ignorieren */ }
}

export function saveConfig() {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(state.config)); } catch { /* Speicher voll/blockiert */ }
  emit("config");
}
