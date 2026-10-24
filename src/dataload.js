// Woher die Daten kommen: eingebaute Beispiele oder die eigene API.
// Der Schalter in den Einstellungen entscheidet — und wirkt wirklich.
import { state, emit, applyLocalData, applyPreferences, saveConfig, MAP_METRICS } from "./state.js";
import { loadDemoData } from "./demo.js";
import {
  isConfigured, listTrips, listPlaces, listNotes, listCategories, listPhotos, listVehicles, route as fetchRoute,
  positions as fetchPositions, drives as fetchDrives, loadSettings, listDriveAssignments,
  cacheDriveWeather, weather as fetchWeather,
} from "./api.js";
import { pathLengthKm, elevationRange, glaetteStandRauschen } from "./geo.js";
import { debugLog } from "./debug.js";
import { renumberPathByTripStart } from "./day-utils.js";
import { haengeNeuePunkteAn } from "./path-merge.js";

/** Zustand des Datenbezugs — die Oberfläche zeigt ihn im Statusband. */
export const status = { mode: "demo", loading: false, error: null };
const LIVE_POSITION_KEY = "vojago.live.last";
const SNAPSHOT_KEY = "vojago.snapshot";

function setStatus(patch) {
  Object.assign(status, patch);
  emit("status");
}

const HUES = [35, 205, 40, 150, 280, 15];

/** Reise aus der Datenbank in die Form bringen, die die Oberfläche nutzt. */
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
    // Für welches Gerät `path` zuletzt geladen wurde — ensureTripPath()
    // vergleicht das gegen state.config.device, sonst bliebe nach einem
    // Fahrzeugwechsel die Route des vorherigen Geräts (oder eine leere,
    // von damals gecachte) auf der Karte stehen, obwohl Reise/Fahrten
    // längst die Daten des neuen Geräts zeigen (echter Fund: 05.09.2026).
    pathDevice: null,
    km: 0, nights: 0, peak: 0,
    bars: [0], barLabels: ["—"],
    range: { from: row.start_at, to: row.end_at },
    // Rohe Zeitpunkte fürs Bearbeiten (N13) — `dates` ist nur die Anzeige.
    start: row.start_at || null,
    end: row.end_at || null,
  };
}

export function standardReise(trips) {
  const zeit = (t) => {
    const ms = Date.parse(t.range?.from || t.start || "");
    return Number.isFinite(ms) ? ms : 0;
  };
  const sortiert = [...(trips || [])].sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    return zeit(b) - zeit(a);
  });
  return sortiert[0] || null;
}

function routeFuerSnapshot(path, max = 2500) {
  if (!Array.isArray(path) || path.length <= max) return Array.isArray(path) ? path : [];
  const schritt = Math.ceil(path.length / max);
  const reduziert = path.filter((_, i) => i % schritt === 0);
  const letzter = path[path.length - 1];
  if (letzter && reduziert[reduziert.length - 1] !== letzter) reduziert.push(letzter);
  return reduziert;
}

function tripFuerSnapshot(t, routeIds) {
  const behalten = routeIds.has(t.id);
  return {
    ...t,
    path: behalten ? routeFuerSnapshot(t.path) : [],
    pathDevice: behalten ? t.pathDevice ?? null : null,
  };
}

function tripMitLetztemStand(t, vorher) {
  if (!vorher?.path?.length) return t;
  return {
    ...t,
    path: renumberPathByTripStart(vorher.path || [], t),
    pathDevice: vorher.pathDevice ?? null,
    pathGrob: vorher.pathGrob ?? false,
    pfadVollUm: vorher.pfadVollUm ?? 0,
    km: Number.isFinite(vorher.km) ? vorher.km : t.km,
    nights: Number.isFinite(vorher.nights) ? vorher.nights : t.nights,
    peak: Number.isFinite(vorher.peak) ? vorher.peak : t.peak,
    bars: Array.isArray(vorher.bars) && vorher.bars.length ? vorher.bars : t.bars,
    barLabels: Array.isArray(vorher.barLabels) && vorher.barLabels.length ? vorher.barLabels : t.barLabels,
  };
}

export function saveSnapshot() {
  if (state.config.demo || !state.trips.length) return;
  const routeIds = new Set([state.mapTripId, state.activeTripId].filter(Boolean));
  const snapshot = {
    savedAt: new Date().toISOString(),
    trips: state.trips.map((t) => tripFuerSnapshot(t, routeIds)),
    places: state.places,
    notes: state.notes,
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

  state.trips = snapshot.trips;
  // Der Zwischenspeicher hält nur einen ausgedünnten Pfad (siehe routeFuerSnapshot) —
  // als "grob" markieren, bis ein echter Abruf gelungen ist.
  state.trips = state.trips.map((t) => ({ ...t, path: renumberPathByTripStart(t.path || [], t), pathGrob: Boolean(t.path?.length) }));
  routenAbruf.zwischenspeicher = state.trips.some((t) => t.path?.length);
  state.places = Array.isArray(snapshot.places) ? snapshot.places : [];
  state.notes = Array.isArray(snapshot.notes) ? snapshot.notes : [];
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

  const hatReise = (id) => id && state.trips.some((t) => t.id === id);
  const standard = standardReise(state.trips);
  state.activeTripId = hatReise(snapshot.activeTripId) ? snapshot.activeTripId : (standard?.live ? standard.id : null);
  state.mapTripId = hatReise(snapshot.mapTripId) ? snapshot.mapTripId : (standard?.id || null);
  debugLog("snapshot.restored", { savedAt: snapshot.savedAt, trips: state.trips.length, mapTripId: state.mapTripId });
  emit("trips");
  return true;
}

// Ein "Ort" in der Oberfläche ist ein Besuch mit dem Katalog-Ort geflacht
// hinein (title/note/category_id/rating/lat/lon kommen vom Ort, alles
// andere vom einzelnen Besuch — siehe api/router.js: GET /api/besuche
// liefert genau diese Form). `id` bleibt die Besuch-ID (die Karte/das
// Logbuch zeigt einzelne Aufenthalte), `ortId` verbindet mehrere Besuche
// desselben Ortes über Reisen hinweg (siehe orteMitBesuchszahl()).
// tripId wird NICHT gespeichert, sondern wie bei Fahrten live aus dem
// Zeitpunkt berechnet — legt man rückwirkend eine Reise an, ordnen sich
// passende Besuche beim nächsten Laden automatisch ein.
export function toPlace(row) {
  return {
    id: row.id,
    ortId: row.ort_id || null,
    tripId: zugehoerigeReise(row.occurred_at),
    catId: row.category_id || "stellplatz",
    title: row.title || "(ohne Titel)",
    // Vom Reverse-Geocoding ermittelte Adresse, getrennt vom (überschreib-
    // baren) Titel — bleibt auch dann sichtbar, wenn der Titel längst
    // umbenannt wurde (Nutzerwunsch, 6. September 2026).
    address: row.address || "",
    note: row.note || "",
    stars: row.rating ?? 0,
    // `at` ist der Zeitpunkt (fürs Tagebuch), `date` seine kurze Anzeige.
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
    tripId: zugehoerigeReise(row.occurred_at),
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

export function toPhoto(row) {
  return {
    id: row.id,
    besuchId: row.besuch_id || null,
    noteId: row.note_id || null,
    takenAt: row.taken_at || "",
    lat: row.lat == null ? null : Number(row.lat),
    lon: row.lon == null ? null : Number(row.lon),
    width: row.width || null,
    height: row.height || null,
  };
}

/**
 * Wie oft wurde an diesem Ort schon übernachtet, über alle Reisen hinweg —
 * cross-trip echte Identität über ortId, nicht über Koordinaten-Nähe
 * geraten (siehe api/router.js: besuche.ort_id). Gruppiert die geladenen
 * Besuche nach Ort, summiert Nächte, merkt sich den letzten Besuch.
 */
export function orteMitBesuchszahl() {
  const gruppen = new Map();
  for (const p of state.places) {
    if (!p.ortId) continue;
    const g = gruppen.get(p.ortId) || { ortId: p.ortId, title: p.title, catId: p.catId, lat: p.lat, lon: p.lon, besuche: 0, naechteGesamt: 0, letzterBesuch: null };
    g.besuche += 1;
    // Nächte nur für echte Übernachtungen zählen — bei einem "Stopp" ist
    // nights nur der Datenbank-Mindestwert (1), keine echte Nächte-Zahl
    // (siehe TITEL_STOPP-Kommentar in dataload.js). Sonst zeigte "wie oft
    // war ich hier" fälschlich Nächte für Orte an, an denen nie
    // übernachtet wurde
    // (echter Fund; reine Tages-Stopps).
    if (p.catId === "uebernachtung") g.naechteGesamt += p.nights || 1;
    if (!g.letzterBesuch || (p.at && p.at > g.letzterBesuch)) g.letzterBesuch = p.at;
    gruppen.set(p.ortId, g);
  }
  return gruppen;
}

/** Serverzeile -> Client-Form für views/settings.js (renderVehicles):
 * `device` statt `traccar_device_id`, damit sich der Feldname nicht ändern
 * muss, egal welche Positionsquelle dahinter steckt. */
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

/** Das Wetter liegt als JSON-Text in der Datenbank. */
function parseWeather(roh) {
  if (!roh) return null;
  try { return JSON.parse(roh); } catch { return null; }
}

/** Positionen des Servers in Routenpunkte übersetzen (Knoten → km/h). */
export function positionsToPath(positions) {
  const waypoints = glaetteStandRauschen(positions
    .filter((p) => Number.isFinite(p.longitude) && Number.isFinite(p.latitude))
    .map((p) => ({
      lon: p.longitude,
      lat: p.latitude,
      elev: Number.isFinite(p.altitude) ? p.altitude : 0,
      spd: Number.isFinite(p.speed) ? p.speed * 1.852 : 0,
      time: p.fixTime || p.deviceTime,
    })));
  if (waypoints.length < 2) return [];

  // Reihenfolge/Anzahl der Punkte bleibt unangetastet — nur GPS-Rauschen im
  // Stand wird auf einen Anker gezogen (glaetteStandRauschen, src/geo.js),
  // echte Bewegung bleibt die echte Spur wie eh und je. Die gespeicherten
  // Rohdaten in der Datenbank sind davon ohnehin nicht betroffen.
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
 * Kilometer je Reisetag aus der Spur. Jeder Punkt kennt seinen Tag und die
 * bis dahin gefahrene Strecke — die Tagesleistung ist die Differenz.
 */
export function tagesKilometer(path) {
  if (!path?.length) return { bars: [0], labels: ["—"] };
  const proTag = new Map();
  for (const p of path) {
    const bisher = proTag.get(p.day);
    if (!bisher) proTag.set(p.day, { von: p.cum, bis: p.cum });
    else bisher.bis = p.cum;
  }
  const tage = [...proTag.entries()].sort((a, b) => a[0] - b[0]);
  return {
    bars: tage.map(([, s]) => Math.round((s.bis - s.von) * 10) / 10),
    labels: tage.map(([tag]) => `Tag ${tag}`),
  };
}

/**
 * Route einer Reise laden. `force` holt auch dann neu, wenn schon eine Spur
 * da ist — nötig, weil die Spur der laufenden Reise wächst, während man
 * fährt. `silent` unterdrückt Fehleranzeige und Neueinpassen der Karte; das
 * braucht der regelmäßige Hintergrund-Refresh (siehe main.js), damit er die
 * Ansicht nicht alle paar Minuten wegspringen lässt.
 *
 * Gegen schlechte Verbindungen (Nutzerfund, 24. Oktober 2026: Teile der Linie
 * fehlten, eine Gerade lief quer über die Karte):
 *  - Nie zwei Abrufe derselben Reise gleichzeitig: ein langsamer alter Abruf
 *    konnte sonst nach einem neueren eintreffen und dessen Stand überschreiben.
 *  - Bei laufender Reise werden nur die NEUEN Punkte nachgeladen und angehängt
 *    (statt jedes Mal die ganze Route, bei 6 Tagen ~14 MB alle 2 Minuten).
 *  - Der aus dem Zwischenspeicher wiederhergestellte, ausgedünnte Pfad gilt als
 *    "grob" (pathGrob), bis ein echter Abruf gelungen ist.
 *  - Scheitert das Auffrischen mehrfach, steht ein Hinweis da — und der letzte
 *    gute Stand bleibt stehen.
 */
const ABRUFE_LAUFEN = new Map();
// Nachladen verpasst Punkte, die der Router erst später nachliefert (Funkloch,
// Zwischenspeicher) und die älter sind als der letzte bekannte — daher spätestens
// alle 30 Minuten wieder die ganze Route holen.
const VOLLABRUF_ALLE_MS = 30 * 60_000;
let pfadFehlerInFolge = 0;

/**
 * Was die Routen-Aktualisierung zuletzt getan hat — für Mehr → Status und das
 * Debug-Log. Enthält bewusst keine Koordinaten, nur Zeiten und Zählungen.
 */
export const routenAbruf = { erfolg: null, fehler: null, zwischenspeicher: false };
function protokolliere(eintrag) {
  const { ok, ...daten } = eintrag;
  if (ok) { routenAbruf.erfolg = { zeit: Date.now(), ...daten }; routenAbruf.zwischenspeicher = false; }
  else routenAbruf.fehler = { zeit: Date.now(), ...daten };
  debugLog(ok ? "route.geladen" : "route.fetch-failed", daten);
  emit("routeInfo");
}
const VERBINDUNG_HINWEIS = "Verbindung schwach — die Route ist evtl. nicht aktuell oder unvollständig.";

export function ensureTripPath(trip, { force = false, silent = false } = {}) {
  // Nicht nur "haben wir schon eine Spur", sondern "für das gerade aktive
  // Gerät" — sonst bleibt nach einem Fahrzeugwechsel die (evtl. leere)
  // Spur des vorherigen Geräts stehen, obwohl Reise/Fahrten längst neu
  // geladen wurden (echter Fund: 05.09.2026, zweites Fahrzeug aktiviert,
  // Karte zeigte weiter nichts).
  const nochAktuell = trip?.path.length && trip.pathDevice === state.config.device && !trip.pathGrob;
  if (!trip || (nochAktuell && !force) || status.mode !== "live") return Promise.resolve();
  if (!state.config.device || !trip.range?.from) return Promise.resolve();
  const schluessel = `${trip.id}|${state.config.device}`;
  if (ABRUFE_LAUFEN.has(schluessel)) return ABRUFE_LAUFEN.get(schluessel);
  const abruf = ladePfad(trip, silent).finally(() => ABRUFE_LAUFEN.delete(schluessel));
  ABRUFE_LAUFEN.set(schluessel, abruf);
  return abruf;
}

async function ladePfad(trip, silent) {
  const start = Date.now();
  const vorherLaenge = trip.path?.length || 0;
  let art = "komplett";
  let empfangen = 0;
  try {
    const geraet = state.config.device;
    const bis = trip.range.to || new Date().toISOString();
    // Nur Neues nachladen: laufende Reise, frischer (nicht grober) Pfad für dasselbe Gerät.
    const letzter = trip.path?.length ? trip.path[trip.path.length - 1] : null;
    const anhaengen = Boolean(letzter?.time) && trip.pathDevice === geraet && !trip.pathGrob && !trip.range.to
      && Date.now() - (trip.pfadVollUm || 0) < VOLLABRUF_ALLE_MS;
    if (anhaengen) {
      art = "nur Neues";
      const positions = await fetchRoute(geraet, letzter.time, bis, { timeoutMs: 45_000 });
      empfangen = Array.isArray(positions) ? positions.length : 0;
      const neu = renumberPathByTripStart(positionsToPath(Array.isArray(positions) ? positions : []), trip);
      const zusammen = haengeNeuePunkteAn(trip.path, neu);
      if (zusammen === trip.path) {
        pfadGelungen();
        protokolliere({ ok: true, art, empfangen, neuePunkte: 0, gesamt: trip.path.length, dauerMs: Date.now() - start, hintergrund: silent });
        return;
      }
      trip.path = zusammen;
    } else {
      const positions = await fetchRoute(geraet, trip.range.from, bis);
      empfangen = Array.isArray(positions) ? positions.length : 0;
      trip.path = renumberPathByTripStart(positionsToPath(positions), trip);
      trip.pfadVollUm = Date.now();
    }
    trip.pathDevice = geraet;
    trip.pathGrob = false;
    if (trip.path.length) {
      trip.km = Math.round(pathLengthKm(trip.path));
      trip.peak = Math.round(elevationRange(trip.path).max);
      const tage = tagesKilometer(trip.path);
      trip.bars = tage.bars;
      trip.barLabels = tage.labels;
    }
    pfadGelungen();
    protokolliere({ ok: true, art, empfangen, neuePunkte: art === "nur Neues" ? trip.path.length - vorherLaenge : trip.path.length, gesamt: trip.path.length, dauerMs: Date.now() - start, hintergrund: silent });
    emit(silent ? "tripPath" : "trips");
    saveSnapshot();
  } catch (err) {
    pfadFehlerInFolge++;
    protokolliere({ ok: false, art, fehler: err.message || String(err), inFolge: pfadFehlerInFolge, dauerMs: Date.now() - start, hintergrund: silent });
    if (!silent) setStatus({ error: `Route konnte nicht geladen werden: ${err.message}` });
    else if (pfadFehlerInFolge >= 2 && !status.error) setStatus({ error: VERBINDUNG_HINWEIS });
  }
}

function pfadGelungen() {
  pfadFehlerInFolge = 0;
  if (status.error === VERBINDUNG_HINWEIS) setStatus({ error: null });
}

export async function buildRangeTrip({ from, to, label = "Zeitraum" } = {}) {
  if (!state.config.device || !from) return null;
  const bis = to || new Date().toISOString();
  const positions = await fetchRoute(state.config.device, from, bis);
  const path = annotateRangePath(positionsToPath(Array.isArray(positions) ? positions : []));
  const tage = tagesKilometer(path);
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
    bars: tage.bars,
    barLabels: tage.labels,
    range: { from, to: bis },
    start: from,
    end: bis,
  };
}

function annotateRangePath(path) {
  const reiseMap = new Map(state.trips.map((reise) => [reise.id, reise]));
  return path.map((point) => {
    const tripId = zugehoerigeReise(point.time);
    const reise = tripId ? reiseMap.get(tripId) : null;
    return reise
      ? { ...point, tripId, tripHue: reise.hue, tripName: reise.name }
      : { ...point, tripId: null, tripHue: null, tripName: "" };
  });
}

/** Holt die letzte gemeldete Position des Fahrzeugs. */
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
    try { localStorage.setItem(LIVE_POSITION_KEY, JSON.stringify(state.livePosition)); } catch { /* egal */ }
    saveSnapshot();
    emit("livePosition");
    return state.livePosition;
  } catch {
    return null; // stiller Fehlschlag: die Karte bleibt einfach, wie sie ist
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

/** S4 — „Lokale Daten löschen" in den Einstellungen: der Offline-/Schnellstart-
 * Zwischenstand (Reisen, Orte, Notizen, Route) und die letzte bekannte
 * Position. Betrifft nur den lokalen Spiegel — bei bestehender Verbindung
 * lädt die App danach einfach neu von der API. */
export function forgetSnapshot() {
  try { localStorage.removeItem(SNAPSHOT_KEY); } catch { /* egal */ }
  try { localStorage.removeItem(LIVE_POSITION_KEY); } catch { /* egal */ }
}

/**
 * Fahrten erkennt der Server selbst aus der Bewegung (segmentDrives).
 * Wir speichern sie nicht, sondern holen sie für einen Zeitraum und ordnen
 * sie über die Zeit den eigenen Reisen zu. Fällt eine Fahrt in keine Reise,
 * ist es eine Alltagsfahrt.
 */
export async function loadDrives({ tage = 30, from = null, to = null, silent = false } = {}) {
  if (state.config.demo || !isConfigured() || !state.config.device) { state.drives = []; return; }
  const von = from || new Date(Date.now() - tage * 86400000).toISOString();
  const bis = to || new Date().toISOString();
  try {
    const [roh] = await Promise.all([fetchDrives(state.config.device, von, bis), loadDriveAssignments()]);
    state.drives = (Array.isArray(roh) ? roh : []).flatMap((t, i) => {
      const from = t.startTime || t.start_time || t.from || t.start;
      if (!from) return [];
      const to = t.endTime || t.end_time || t.to || t.end || null;
      const key = driveKey(t.deviceId, from);
      const automatischeReise = zugehoerigeReiseFahrt(from, to);
      const hatManuelleZuordnung = Object.prototype.hasOwnProperty.call(state.driveAssignments, key);
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
        // Eine von Hand getroffene Zuordnung sticht die Zeit-Automatik.
        tripId: hatManuelleZuordnung ? state.driveAssignments[key] : automatischeReise,
        manuell: hatManuelleZuordnung,
        kind: state.driveKinds[key] === "abstecher" ? "abstecher" : "etappe",
        weather: state.driveWeather[key] || null,
      }];
    }).sort((a, b) => String(b.from).localeCompare(String(a.from)));
    debugLog("drives.loaded", {
      requestedFrom: von, requestedTo: bis, raw: Array.isArray(roh) ? roh.length : "not-array",
      activeTripId: state.activeTripId,
      trips: state.trips.map((t) => ({ id: t.id, name: t.name, range: t.range, live: t.live })),
      drives: state.drives.map((d) => ({ key: d.key, from: d.from, to: d.to, tripId: d.tripId, manuell: d.manuell })),
    });
    emit("drives");
    saveSnapshot();
    holeFahrtWetter();
  } catch (err) {
    // Die zuletzt geladene Fahrtenliste BEHALTEN: sie auf [] zu setzen ließ die
    // Karte bei schlechter Verbindung auf "alle Punkte, keine Fahrten" kippen
    // (Etappen-Filter aus, Abstecher sichtbar, Stücke zusammengezogen).
    debugLog("drives.fetch-failed", { error: err.message || String(err), behalten: state.drives.length, silent });
    if (!silent) setStatus({ error: `Fahrten konnten nicht geladen werden: ${err.message}` });
  }
}

/**
 * Kennung einer Fahrt/eines Stopps: Gerät und Startzeit identifizieren sie
 * eindeutig. Bewusst die TATSÄCHLICHE Geräte-ID der Positionsdaten
 * (`deviceId` aus der API-Antwort, siehe api/lib.js baueFahrt/baueStopp),
 * nicht die aktuell im Fahrzeug konfigurierte (`state.config.device`) —
 * sonst würde ein späteres Umbenennen der Geräte-ID in den Einstellungen
 * alle bisherigen manuellen Zuordnungen und Besuche unauffindbar machen
 * (dieselbe Kennung ergäbe plötzlich einen anderen String). Fallback auf
 * `state.config.device` nur, wenn keine deviceId bekannt ist (z. B. für den
 * aktuell laufenden Aufenthalt, wo das ohnehin dasselbe Gerät ist).
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
      abstecherKeys: Object.keys(state.driveKinds),
    });
  } catch {
    state.driveAssignments = {}; // ohne Zuordnungen greift weiter die Zeit-Automatik
    state.driveKinds = {};
    state.driveWeather = {};
  }
}

/**
 * Wetter am Start jeder Fahrt nachladen, die noch keins hat — im Hintergrund
 * und auf wenige Fahrten je Aufruf begrenzt, damit ein Blick auf 30 Tage
 * Historie nicht 30 Tage Wetterabfragen auf einmal auslöst. Der Rest folgt
 * beim nächsten Laden, weil dann wieder nur die noch fehlenden dran sind.
 */
async function holeFahrtWetter({ max = 8 } = {}) {
  if (state.config.demo || !isConfigured()) return;
  const kandidaten = state.drives
    .filter((d) => !d.weather && Number.isFinite(d.startLat) && Number.isFinite(d.startLon))
    .slice(0, max);
  for (const d of kandidaten) {
    try {
      const wetter = await fetchWeather(d.startLat, d.startLon, d.from);
      const roh = JSON.stringify(wetter);
      await cacheDriveWeather(d.key, roh);
      state.driveWeather[d.key] = wetter;
      const eintrag = state.drives.find((x) => x.key === d.key);
      if (eintrag) eintrag.weather = wetter;
    } catch {
      // Ohne Wetter bleibt die Fahrt vollständig — nur ohne diese Angabe.
    }
  }
  if (kandidaten.length) emit("drives");
  if (kandidaten.length) saveSnapshot();
}

/** Welche Reise umschließt diesen Zeitpunkt? */
function zugehoerigeReise(zeitpunkt) {
  const t = Date.parse(zeitpunkt);
  if (!Number.isFinite(t)) return null;
  for (const reise of state.trips) {
    const von = Date.parse(reise.range?.from ?? "");
    const bis = reise.range?.to ? Date.parse(reise.range.to) : Date.now();
    if (Number.isFinite(von) && t >= von && t <= bis) return reise.id;
  }
  return null;
}

/** Welche Reise überschneidet das Zeitfenster einer Fahrt? */
function zugehoerigeReiseFahrt(vonZeit, bisZeit) {
  const start = Date.parse(vonZeit);
  const ende = bisZeit ? Date.parse(bisZeit) : start;
  if (!Number.isFinite(start)) return null;
  const bisFahrt = Number.isFinite(ende) ? ende : start;
  for (const reise of state.trips) {
    const von = Date.parse(reise.range?.from ?? "");
    const bis = reise.range?.to ? Date.parse(reise.range.to) : Date.now();
    if (Number.isFinite(von) && bisFahrt >= von && start <= bis) return reise.id;
  }
  return null;
}

/** Die Spur einer einzelnen Fahrt nachladen. */
export async function drivePath(drive) {
  if (!state.config.device) return [];
  const von = verschobeneISO(drive.from, -2 * 60000);
  const bis = verschobeneISO(drive.to || new Date().toISOString(), 2 * 60000);
  debugLog("drive-path.request", { key: drive.key, from: drive.from, to: drive.to, requestedFrom: von, requestedTo: bis });
  const roh = await fetchRoute(state.config.device, von, bis);
  const path = positionsToPath(roh);
  debugLog("drive-path.loaded", { key: drive.key, raw: Array.isArray(roh) ? roh.length : "not-array", pathPoints: path.length });
  return path;
}

function verschobeneISO(iso, deltaMs) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t + deltaMs).toISOString();
}

/* ---------- Übernachtungen automatisch erkennen (N15) ---------- */

// Titel, die eine automatische Erkennung vergibt, solange keine Adresse
// bekannt ist. Die eigentliche Erkennung (Übernachtung/Stopp anlegen)
// läuft seit dem 6. September 2026 serverseitig im ingest-Container
// (tracker-backend/src/auto-import.js, periodisch für ALLE Fahrzeuge) —
// die frühere Browser-Variante hier (autoImportCurrentStay()/
// autoImportStays()) wurde entfernt: beide gleichzeitig zu betreiben war
// redundant und hat wiederholt zu Inkonsistenzen geführt (u. a. der
// nights=0- und der verwaiste-Orte-Bug, beide 6. September 2026). Diese
// Titel-Liste bleibt trotzdem hier, weil store.js (ergaenzeOrtsname())
// sie braucht, um zu entscheiden, ob ein später eintreffender
// Namensvorschlag den Titel noch ersetzen darf oder der Mensch ihn längst
// selbst geändert hat — eine eigene Kopie dieser Liste dort wäre genau
// die Art Falle, die ROUTE_DRIVE_FILTERS/MAP_METRICS in state.js schon
// einmal waren, deshalb eine einzige, exportierte Quelle statt
// verstreuter String-Literale.
export const AUTO_ORT_PLATZHALTER_TITEL = ["Aktuelle Übernachtung", "Übernachtung", "Stopp"];

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

// Radius für die Wiedererkennung eines schon bekannten ORTES über Reisen
// hinweg — dieselbe Schwelle wie DOPPELTER_STOPP_RADIUS_KM/
// ORT_WIEDERERKENNUNG_RADIUS_KM in tracker-backend/src/auto-import.js
// (dort bei Änderung mit nachziehen).
const ORT_WIEDERERKENNUNG_RADIUS_KM = 0.3;

/**
 * Gibt es (über ALLE Reisen hinweg, nicht nur die aktuelle) bereits einen
 * Ort in der Nähe derselben Kategorie? Für einen echt NEUEN Besuch an
 * einem schon bekannten Ort — z. B. derselbe Stellplatz wie letztes Jahr,
 * manuell über den Orte-Editor erfasst (die automatische Erkennung läuft
 * serverseitig, siehe oben, und hat ihre eigene, gleichwertige Kopie
 * dieser Logik). Wird der bestehende ort_id wiederverwendet, zählt
 * "wie oft war ich hier" (orteMitBesuchszahl()) automatisch richtig,
 * statt für jeden Besuch einen neuen, unverknüpften Ort anzulegen. Nimmt
 * den nächstgelegenen Treffer, nicht einfach den ersten.
 */
export function findeVorhandenenOrt({ lat, lon, catId }) {
  let bester = null, besteEntfernung = Infinity;
  for (const p of state.places) {
    if (!p.ortId || p.catId !== catId) continue;
    const d = entfernungKm({ lat, lon }, p);
    if (d <= ORT_WIEDERERKENNUNG_RADIUS_KM && d < besteEntfernung) { bester = p; besteEntfernung = d; }
  }
  return bester?.ortId || null;
}

/**
 * Reisen neu holen — nach jeder Änderung, die zentral gespeichert wurde.
 * So zeigt die App den Stand der Datenbank und nicht eine lokale Annahme.
 */
export async function reloadTrips() {
  if (state.config.demo || !isConfigured()) return;
  const vorherMapTripId = state.mapTripId;
  const vorherWarAktiv = vorherMapTripId && vorherMapTripId === state.activeTripId;
  const rows = await listTrips();
  state.trips = (rows || []).map(toTrip);
  const standard = standardReise(state.trips);
  const active = standard?.live ? standard : null;
  state.activeTripId = active?.id || null;
  const aktuelleKarteExistiert = state.trips.some((t) => t.id === state.mapTripId);
  if (!aktuelleKarteExistiert || vorherWarAktiv) {
    state.mapTripId = standard?.id || null;
  }
  emit("trips");
  debugLog("trips.reloaded", {
    trips: state.trips.map((t) => ({ id: t.id, name: t.name, range: t.range, live: t.live })),
    activeTripId: state.activeTripId, mapTripId: state.mapTripId,
  });
  await loadDrives();
  const gezeigt = state.trips.find((t) => t.id === state.mapTripId) || standard;
  if (gezeigt) await ensureTripPath(gezeigt);
  saveSnapshot();
}

/** Lädt die Daten passend zur eingestellten Quelle. */
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
  const vorherMapTripId = state.mapTripId;
  const vorherigeTrips = new Map(state.trips.map((t) => [t.id, t]));
  try {
    const [trips, places, notes, categories, photos, vehicles] = await Promise.all([
      listTrips(), listPlaces(), listNotes().catch(() => []), listCategories().catch(() => []), listPhotos().catch(() => []),
      listVehicles().catch(() => []),
    ]);

    state.trips = (trips || []).map((row, index) => tripMitLetztemStand(toTrip(row, index), vorherigeTrips.get(row.id)));
    state.places = (places || []).map(toPlace);
    state.notes = (notes || []).map(toNote);
    state.photos = (photos || []).map(toPhoto);
    const standard = standardReise(state.trips);
    const active = standard?.live ? standard : null;
    state.activeTripId = active?.id || null;
    state.mapTripId = state.trips.some((t) => t.id === vorherMapTripId) ? vorherMapTripId : (standard?.id || null);

    // Geräteübergreifende Einstellungen haben Vorrang vor dem lokalen Stand.
    const prefs = await loadSettings().catch(() => null);
    if (prefs && Object.keys(prefs).length) applyPreferences(prefs);
    else applyLocalData();

    // Kategorien UND Fahrzeuge NACH applyPreferences/applyLocalData
    // anwenden, damit sie garantiert gewinnen, nicht umgekehrt überschrieben
    // werden. Echter Fund (16. August 2026 für Fahrzeuge, 6. September 2026
    // fürs selbe Muster bei Kategorien): beide liefen vorher (auch) über
    // die Einstellungen-Sammelablage (oben) — die wird nur beim Laden
    // komplett ersetzt, ein zweites Gerät sah dann seinen eigenen,
    // womöglich veralteten Stand, und "wer zuletzt speichert" gewann, ohne
    // Rücksicht auf zwischenzeitlich echte Änderungen (neue Kategorie
    // angelegt, Fahrzeug wechselt). Die categories-/vehicles-Tabellen
    // synchronisieren dagegen sofort bei jeder Änderung — jetzt für beide
    // die einzige Quelle beim Laden. Konkret beobachtet: der Ort-Editor
    // zeigte nur zwei uralte Kategorien statt aller elf, weil genau diese
    // veraltete Sammelablage state.categories nach dem korrekten Laden
    // wieder überschrieben hatte.
    if (categories?.length) {
      state.categories = Object.fromEntries(categories.map((c) => [c.id, { name: c.name, color: c.color || "#888" }]));
    }
    if (vehicles?.length) {
      state.vehicles = vehicles.map(toVehicle);
      const aktiverIndex = vehicles.findIndex((v) => v.active);
      state.activeVehicle = aktiverIndex >= 0 ? aktiverIndex : 0;
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
    const gezeigt = state.trips.find((t) => t.id === state.mapTripId) || standard;
    if (gezeigt) await ensureTripPath(gezeigt);
    saveSnapshot();
  } catch (err) {
    setStatus({ mode: "live", loading: false, error: `Daten konnten nicht geladen werden: ${err.message}` });
    emit("trips");
  }
}
