// Client for the app's own API. It runs on the same origin as the app, so there
// is no CORS and the session travels as a first-party cookie, which Safari on
// iOS accepts too. Request and response fields follow the API (api/router.js).
import { decodeRoute } from "./route-wire.js";

async function request(path, options = {}) {
  // `timeoutMs`: on a bad connection a request would otherwise hang forever (a
  // phone in a dead spot gets neither an answer nor an error) and overlap with
  // the next refresh. After the timeout it is aborted with a clear error; the
  // app keeps its last good state.
  const { timeoutMs, ...fetchOptions } = options;
  const abort = timeoutMs ? new AbortController() : null;
  const timer = abort ? setTimeout(() => abort.abort(), timeoutMs) : null;
  // FormData (photo upload) needs its own content type with the multipart
  // boundary set by the browser — a forced "application/json" would make the
  // body unreadable.
  const isFormData = typeof FormData !== "undefined" && fetchOptions.body instanceof FormData;
  try {
    const res = await fetch(path, {
      ...fetchOptions,
      signal: abort?.signal,
      credentials: "same-origin",
      headers: isFormData ? { ...fetchOptions.headers } : { "content-type": "application/json", ...fetchOptions.headers },
    });
    if (!res.ok) {
      // The server's message is the most telling one — it must not be replaced
      // by a generic one (otherwise a wrong password would only say "not signed in").
      let text = "";
      try { text = (await res.json())?.error || ""; } catch { text = await res.text().catch(() => ""); }
      const error = new Error(text ? text.slice(0, 200) : `${res.status} ${res.statusText}`);
      error.status = res.status;
      if (res.status === 401) error.notSignedIn = true;
      throw error;
    }
    // await INSIDE try: otherwise the finally (clearing the timer) would run
    // before the body is read, and an aborted download would go unnoticed.
    return res.status === 204 ? null : await res.json();
  } catch (err) {
    if (abort?.signal.aborted) throw new Error("Zeitüberschreitung — die Verbindung ist zu langsam");
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Retries a request on connection errors, timeouts and 5xx (not on 4xx). */
async function requestWithRetry(path, options = {}, { attempts = 2, pauseMs = 2000 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await request(path, options); } catch (err) {
      last = err;
      const retryable = err.status == null || err.status >= 500;
      if (!retryable || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }
  throw last;
}

/* ---------- Sign-in ---------- */
export const authState = () => request("/api/auth/me");
export const setupAccount = (username, password, email) =>
  request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username, password, email }) });
export const login = (username, password) =>
  request("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
export const logout = () => request("/api/auth/logout", { method: "POST" });
export const changePassword = (alt, neu) =>
  request("/api/auth/password", { method: "POST", body: JSON.stringify({ alt, neu }) });
/** Requests a reset link by mail — always answers the same, whether the account exists or not. */
export const forgotPassword = (username) =>
  request("/api/auth/forgot", { method: "POST", body: JSON.stringify({ username }) });
/** Sets a new password through the reset link and signs in at the same time. */
export const resetPassword = (token, password) =>
  request("/api/auth/reset", { method: "POST", body: JSON.stringify({ token, password }) });
/** Stores or changes the e-mail address — the current password is the proof. */
export const setEmail = (password, email) =>
  request("/api/auth/email", { method: "POST", body: JSON.stringify({ password, email }) });
/** Confirms an e-mail address through the link from the confirmation mail. */
export const verifyEmail = (token) =>
  request("/api/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) });

/* ---------- Data ---------- */
export const health = () => request("/api/health");
export const loadSettings = () => request("/api/settings");
export const storeSettings = (data) => request("/api/settings", { method: "PUT", body: JSON.stringify(data) });

// "Places" in the UI are visits (one stay); the catalogue of places behind them
// (orte, reused across trips) has no call of its own — see api/router.js:
// GET/POST/PATCH/DELETE /api/besuche.
export const listPlaces = () => request("/api/besuche");
export const createPlace = (place) => request("/api/besuche", { method: "POST", body: JSON.stringify(place) });
export const updatePlace = (id, patch) => request(`/api/besuche/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deletePlace = (id) => request(`/api/besuche/${id}`, { method: "DELETE" });

export const listNotes = () => request("/api/notes");

/* ---------- Diary: one entry per trip and calendar day ---------- */
export const listDiary = () => request("/api/tagebuch");
/** Creates or overwrites the entry (exactly one per trip and day): { id, neu }. */
export const saveDiaryEntry = (entry) => request("/api/tagebuch", { method: "PUT", body: JSON.stringify(entry) });
export const deleteDiaryEntry = (id) => request(`/api/tagebuch/${id}`, { method: "DELETE" });
export const createNote = (note) => request("/api/notes", { method: "POST", body: JSON.stringify(note) });
export const updateNote = (id, patch) => request(`/api/notes/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deleteNote = (id) => request(`/api/notes/${id}`, { method: "DELETE" });

/* ---------- Photos ---------- */
export const listPhotos = () => request("/api/photos");
/** `meta`: { besuchId | noteId | tagebuchId, takenAt?, lat?, lon?, width?, height? } — the
 * image arrives already scaled down on the client (see ui/photo.js). */
export const uploadPhoto = (blob, meta = {}) => {
  const form = new FormData();
  form.set("file", blob, "foto.jpg");
  if (meta.besuchId) form.set("besuch_id", meta.besuchId);
  if (meta.noteId) form.set("note_id", meta.noteId);
  if (meta.tagebuchId) form.set("tagebuch_id", meta.tagebuchId);
  if (meta.takenAt) form.set("taken_at", meta.takenAt);
  if (meta.lat != null) form.set("lat", String(meta.lat));
  if (meta.lon != null) form.set("lon", String(meta.lon));
  if (meta.width != null) form.set("width", String(meta.width));
  if (meta.height != null) form.set("height", String(meta.height));
  return request("/api/photos", { method: "POST", body: form });
};
export const deletePhoto = (id) => request(`/api/photos/${id}`, { method: "DELETE" });
/** Image URL for <img src> — no fetch() needed, the cookie travels along. */
export const photoUrl = (id) => `/api/photos/${id}`;

/** Weather for a place and time; without `at` it means "now". */
export const weather = (lat, lon, at) =>
  request(`/api/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}${at ? `&at=${encodeURIComponent(at)}` : ""}`);

/** Suggested name for coordinates (reverse geocoding) — { name: string|null }. */
export const geocode = (lat, lon) =>
  request(`/api/geocode?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);

export const listTrips = () => request("/api/trips");
export const createTrip = (trip) => request("/api/trips", { method: "POST", body: JSON.stringify(trip) });
export const updateTrip = (id, patch) => request(`/api/trips/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deleteTrip = (id) => request(`/api/trips/${id}`, { method: "DELETE" });

export const listDriveAssignments = () => request("/api/drive-assignments");
/** `tripId`: a trip id, `null` for an explicit everyday drive, `"auto"` for assignment by time. */
export const assignDrive = (driveKey, tripId, extra = {}) =>
  request("/api/drive-assignments", { method: "PUT", body: JSON.stringify({ drive_key: driveKey, trip_id: tripId, ...extra }) });
export const updateDriveKind = (driveKey, kind) =>
  request("/api/drive-assignments", { method: "PATCH", body: JSON.stringify({ drive_key: driveKey, kind }) });
/** Cache the weather at the start of a drive — leaves the assignment alone. */
export const cacheDriveWeather = (driveKey, weatherJson) =>
  request("/api/drive-assignments", { method: "PATCH", body: JSON.stringify({ drive_key: driveKey, weather: weatherJson }) });

export const stops = (deviceId, from, to) =>
  request(`/api/stops?deviceId=${encodeURIComponent(deviceId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
/** Stops the user dismissed as overnight stays — they must not come back. */
export const listIgnoredStops = () => request("/api/ignored-stops");

export const listCategories = () => request("/api/categories");
export const createCategory = (c) => request("/api/categories", { method: "POST", body: JSON.stringify(c) });
export const updateCategory = (id, patch) => request(`/api/categories/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deleteCategory = (id) => request(`/api/categories/${id}`, { method: "DELETE" });

export const listVehicles = () => request("/api/vehicles");
export const createVehicle = (v) => request("/api/vehicles", { method: "POST", body: JSON.stringify(v) });
export const updateVehicle = (id, patch) => request(`/api/vehicles/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deleteVehicle = (id) => request(`/api/vehicles/${id}`, { method: "DELETE" });
export const ingestStatus = () => request("/api/ingest");
export const setIngestLearning = ({ minutes = 10, enabled = true } = {}) =>
  request("/api/ingest/learning", { method: "PATCH", body: JSON.stringify({ minutes, enabled }) });

/* ---------- Guard: geofence anchor (read only), alarm settings, log ---------- */
// No zone CRUD — the anchor is only set through
// updateAlarmSetting("geofence", { enabled: true, lat, lon, radius_m }) when
// arming (see views/guard.js). listGeofences() only reads, e.g. to prefill the
// radius used last.
export const listGeofences = () => request("/api/geofences");

export const listAlarmSettings = () => request("/api/alarms");
export const updateAlarmSetting = (key, patch) => request(`/api/alarms/${key}`, { method: "PATCH", body: JSON.stringify(patch) });
export const listAlarmLog = () => request("/api/alarms/log");

/* ---------- Guard: push notifications ---------- */
export const pushPublicKey = () => request("/api/push-public-key");
export const subscribePush = (subscription) => request("/api/push-subscriptions", { method: "POST", body: JSON.stringify(subscription) });
export const unsubscribePush = (id) => request(`/api/push-subscriptions/${id}`, { method: "DELETE" });

/* ---------- User management (admins only) ---------- */
export const listUsers = () => request("/api/users");
export const createUser = (u) => request("/api/users", { method: "POST", body: JSON.stringify(u) });
export const updateUser = (id, patch) => request(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deleteUser = (id) => request(`/api/users/${id}`, { method: "DELETE" });

export const positions = (deviceId) => request(`/api/positions?deviceId=${encodeURIComponent(deviceId)}`);
// Drives and routes are large requests (the route is sent thinned and compact,
// see route-wire.js): with a time limit and one retry on connection problems.
export const drives = (deviceId, from, to) =>
  requestWithRetry(`/api/drives?deviceId=${encodeURIComponent(deviceId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { timeoutMs: 120_000 });
/** Number of recorded points and the newest one in a range (no route data). */
export const routeStand = (deviceId, from, to) =>
  request(`/api/route?stand=1&deviceId=${encodeURIComponent(deviceId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { timeoutMs: 20_000 });
export const route = (deviceId, from, to, { timeoutMs = 120_000 } = {}) =>
  requestWithRetry(`/api/route?compact=1&deviceId=${encodeURIComponent(deviceId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { timeoutMs }).then(decodeRoute);
/** Known devices: those that have sent to the positions table at least once.
 * For assigning a device id to a vehicle in the settings (views/settings.js). */
export const devices = () => request("/api/devices");

/* ---------- Sharing trips ---------- */
/** Creates a sharing link. Without `tripId` it means "all trips". */
export const createShare = ({ tripId, scope, label, expiresInDays } = {}) =>
  request("/api/shares", { method: "POST", body: JSON.stringify({ tripId, scope, label, expiresInDays }) });
export const listShares = () => request("/api/shares");
export const revokeShare = (id) => request(`/api/shares/${id}`, { method: "DELETE" });

/** Public guest view — no login, the link token is the proof. */
export const fetchShare = (token) => request(`/api/share/${encodeURIComponent(token)}`);
export const fetchShareRoute = (token, tripId) =>
  request(`/api/share/${encodeURIComponent(token)}/route?compact=1&tripId=${encodeURIComponent(tripId)}`).then(decodeRoute);
export const fetchSharePositions = (token, tripId) =>
  request(`/api/share/${encodeURIComponent(token)}/positions?tripId=${encodeURIComponent(tripId)}`);
export const fetchShareDrives = (token, tripId) =>
  request(`/api/share/${encodeURIComponent(token)}/drives?tripId=${encodeURIComponent(tripId)}`);
/** Image URL for guests — only reachable with the scope "map + logbook". */
export const sharePhotoUrl = (token, photoId) => `/api/share/${encodeURIComponent(token)}/photos/${encodeURIComponent(photoId)}`;

/** Whether the user is signed in; the app talks to the API only then. */
export let signedIn = false;
export const setSignedIn = (value) => { signedIn = value; };
export const isConfigured = () => signedIn;
