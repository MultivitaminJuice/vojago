const ENABLED_KEY = "vojago.debug.enabled";
const PRECISE_KEY = "vojago.debug.precise";
const LOG_KEY = "vojago.debug.entries";
const MAX_ENTRIES = 500;
const REDACTED = "[redacted]";

let entries = ladeEintraege();

function ladeEintraege() {
  try {
    const raw = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
    return Array.isArray(raw) ? raw.slice(-MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

function speichereEintraege() {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES))); } catch { /* ignorieren */ }
}

function klone(data) {
  try { return JSON.parse(JSON.stringify(data)); } catch { return String(data); }
}

export function debugEnabled() {
  try { return localStorage.getItem(ENABLED_KEY) === "1"; } catch { return false; }
}

export function preciseDebugDataEnabled() {
  try { return localStorage.getItem(PRECISE_KEY) === "1"; } catch { return false; }
}

export function setDebugEnabled(on) {
  try { localStorage.setItem(ENABLED_KEY, on ? "1" : "0"); } catch { /* ignorieren */ }
  debugLog(on ? "debug.enabled" : "debug.disabled", { userAgent: navigator.userAgent }, { force: true });
}

export function setPreciseDebugDataEnabled(on) {
  try { localStorage.setItem(PRECISE_KEY, on ? "1" : "0"); } catch { /* ignorieren */ }
  debugLog(on ? "debug.precise.enabled" : "debug.precise.disabled", {}, { force: true });
}

export function debugLog(event, data = {}, { force = false } = {}) {
  if (!force && !debugEnabled()) return;
  const entry = { ts: new Date().toISOString(), event, data: klone(data) };
  entries.push(entry);
  entries = entries.slice(-MAX_ENTRIES);
  speichereEintraege();
  console.info("[VOJAGO DEBUG]", event, data);
}

export function clearDebugLog() {
  entries = [];
  speichereEintraege();
}

export const debugCount = () => entries.length;

function istPrivatesFeld(key) {
  const k = String(key || "").toLowerCase();
  return k === "path" || k === "positions" || k === "position" || k === "coords" || k === "coordinates" ||
    k === "lat" || k === "lon" || k === "lng" || k === "latitude" || k === "longitude" ||
    k === "startlat" || k === "startlon" || k === "endlat" || k === "endlon" ||
    k.includes("address") || k.includes("adresse") || k === "title" || k === "note";
}

function ohnePrivateDaten(value, key = "") {
  if (istPrivatesFeld(key)) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => ohnePrivateDaten(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, ohnePrivateDaten(v, k)]));
  }
  return value;
}

function viewportInfo() {
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    screenWidth: window.screen?.width || null,
    screenHeight: window.screen?.height || null,
    devicePixelRatio: window.devicePixelRatio || null,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
    visualViewport: window.visualViewport ? {
      width: window.visualViewport.width,
      height: window.visualViewport.height,
      offsetTop: window.visualViewport.offsetTop,
      offsetLeft: window.visualViewport.offsetLeft,
      scale: window.visualViewport.scale,
    } : null,
    standalone: window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true,
    appHeightVar: getComputedStyle(document.documentElement).getPropertyValue("--app-h").trim(),
  };
}

function tripExport(t, precise) {
  return {
    id: t.id, name: precise ? t.name : REDACTED, live: t.live, range: t.range, start: t.start, end: t.end,
    km: t.km, pathPoints: t.path?.length || 0, path: precise ? t.path || [] : REDACTED,
  };
}

export function exportDebugLog(state, status) {
  const precise = preciseDebugDataEnabled();
  const payload = {
    exportedAt: new Date().toISOString(),
    app: "VOJAGO",
    userAgent: navigator.userAgent,
    privacy: {
      preciseGpsData: precise,
      note: precise
        ? "Dieser Export enthält exakte GPS-Pfade, Koordinaten, Orte und Adressen."
        : "Exakte GPS-Pfade, Koordinaten, Ortsnamen, Notizen und Adressen wurden entfernt.",
    },
    viewport: viewportInfo(),
    status: precise ? klone(status) : ohnePrivateDaten(status),
    config: { demo: state.config.demo, device: state.config.device || null },
    activeTripId: state.activeTripId,
    mapTripId: state.mapTripId,
    trips: state.trips.map((t) => tripExport(t, precise)),
    drives: state.drives.map((d) => ({
      key: d.key, from: d.from, to: d.to, tripId: d.tripId, manuell: d.manuell,
      km: d.km, minutes: d.minutes, hasWeather: Boolean(d.weather),
      hasStartPosition: Number.isFinite(d.startLat) && Number.isFinite(d.startLon),
      startAddress: precise ? d.startAddress : REDACTED,
      endAddress: precise ? d.endAddress : REDACTED,
      startLat: precise ? d.startLat : REDACTED,
      startLon: precise ? d.startLon : REDACTED,
    })),
    driveAssignments: klone(state.driveAssignments),
    driveWeatherKeys: Object.keys(state.driveWeather || {}),
    overnightPlaces: state.places
      .filter((p) => p.catId === "uebernachtung" || p.stopKey)
      .map((p) => ({
        id: p.id, tripId: p.tripId, title: precise ? p.title : REDACTED, at: p.at,
        lat: precise ? p.lat : REDACTED, lon: precise ? p.lon : REDACTED,
        nights: p.nights, stopKey: p.stopKey, source: p.source,
      })),
    logs: precise ? entries : entries.map((entry) => ({ ...entry, data: ohnePrivateDaten(entry.data) })),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `vojago-debug-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  if (precise) setPreciseDebugDataEnabled(false);
  debugLog("debug.exported", { entries: entries.length, drives: state.drives.length, trips: state.trips.length, precise });
}
