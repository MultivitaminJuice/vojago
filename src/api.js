// Client für die eigene API. Sie läuft unter derselben Adresse wie die App
// (Cloudflare-Pages-Funktion) — deshalb kein CORS, und die Sitzung reist als
// Erst-Anbieter-Cookie mit, das auch Safari auf iOS akzeptiert.

async function request(path, options = {}) {
  // `timeoutMs`: bei schlechter Verbindung hängt ein Abruf sonst ewig (ein
  // Handy im Funkloch bekommt weder Antwort noch Fehler) — und überlappt dann
  // mit dem nächsten Auffrischen. Nach Ablauf wird abgebrochen und ein klarer
  // Fehler geworfen; die App behält ihren letzten guten Stand.
  const { timeoutMs, ...fetchOptions } = options;
  const abbruch = timeoutMs ? new AbortController() : null;
  const timer = abbruch ? setTimeout(() => abbruch.abort(), timeoutMs) : null;
  // FormData (Foto-Upload) braucht ihr eigenes, vom Browser gesetztes
  // content-type mit multipart-Grenze — ein erzwungenes "application/json"
  // würde den Body unlesbar machen.
  const istFormData = typeof FormData !== "undefined" && fetchOptions.body instanceof FormData;
  try {
    const res = await fetch(path, {
      ...fetchOptions,
      signal: abbruch?.signal,
      credentials: "same-origin",
      headers: istFormData ? { ...fetchOptions.headers } : { "content-type": "application/json", ...fetchOptions.headers },
    });
    if (!res.ok) {
      // Die Meldung des Servers ist die aussagekräftigste — sie darf nicht
      // durch eine allgemeine ersetzt werden (sonst steht bei falschem Passwort
      // nur "nicht angemeldet" statt des eigentlichen Grundes).
      let text = "";
      try { text = (await res.json())?.error || ""; } catch { text = await res.text().catch(() => ""); }
      const fehler = new Error(text ? text.slice(0, 200) : `${res.status} ${res.statusText}`);
      fehler.status = res.status;
      if (res.status === 401) fehler.nichtAngemeldet = true;
      throw fehler;
    }
    // await INNERHALB von try: sonst liefe das finally (Zeitgeber löschen) schon
    // vor dem Lesen des Antwortkörpers, und ein abgebrochener Download bliebe unbemerkt.
    return res.status === 204 ? null : await res.json();
  } catch (err) {
    if (abbruch?.signal.aborted) throw new Error("Zeitüberschreitung — die Verbindung ist zu langsam");
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Wiederholt einen Abruf bei Verbindungsfehlern/Zeitüberschreitung/5xx (nicht bei 4xx). */
async function requestWiederholt(path, options = {}, { versuche = 2, pauseMs = 2000 } = {}) {
  let letzter;
  for (let i = 0; i < versuche; i++) {
    try { return await request(path, options); } catch (err) {
      letzter = err;
      const wiederholbar = err.status == null || err.status >= 500;
      if (!wiederholbar || i === versuche - 1) break;
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }
  throw letzter;
}

/* ---------- Anmeldung ---------- */
export const authState = () => request("/api/auth/me");
export const setupAccount = (username, password, email) =>
  request("/api/auth/setup", { method: "POST", body: JSON.stringify({ username, password, email }) });
export const login = (username, password) =>
  request("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
export const logout = () => request("/api/auth/logout", { method: "POST" });
export const changePassword = (alt, neu) =>
  request("/api/auth/password", { method: "POST", body: JSON.stringify({ alt, neu }) });
/** Fordert einen Reset-Link per Mail an — antwortet immer gleich, unabhängig davon, ob das Konto existiert. */
export const forgotPassword = (username) =>
  request("/api/auth/forgot", { method: "POST", body: JSON.stringify({ username }) });
/** Setzt per Reset-Link ein neues Passwort und meldet zugleich an. */
export const resetPassword = (token, password) =>
  request("/api/auth/reset", { method: "POST", body: JSON.stringify({ token, password }) });
/** Hinterlegt/ändert die E-Mail — das aktuelle Passwort ist der Nachweis. */
export const setEmail = (password, email) =>
  request("/api/auth/email", { method: "POST", body: JSON.stringify({ password, email }) });
/** Bestätigt eine E-Mail über den Link aus der Bestätigungsmail. */
export const verifyEmail = (token) =>
  request("/api/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) });

/* ---------- Daten ---------- */
export const health = () => request("/api/health");
export const loadSettings = () => request("/api/settings");
export const storeSettings = (data) => request("/api/settings", { method: "PUT", body: JSON.stringify(data) });

// "Orte" in der Oberfläche sind Besuche (ein Aufenthalt), der Ort-Katalog
// dahinter (orte, über Reisen hinweg wiederverwendbar) ist kein eigener
// Aufruf — siehe api/router.js: GET/POST/PATCH/DELETE /api/besuche.
export const listPlaces = () => request("/api/besuche");
export const createPlace = (place) => request("/api/besuche", { method: "POST", body: JSON.stringify(place) });
export const updatePlace = (id, patch) => request(`/api/besuche/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deletePlace = (id) => request(`/api/besuche/${id}`, { method: "DELETE" });

export const listNotes = () => request("/api/notes");
export const createNote = (note) => request("/api/notes", { method: "POST", body: JSON.stringify(note) });
export const updateNote = (id, patch) => request(`/api/notes/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deleteNote = (id) => request(`/api/notes/${id}`, { method: "DELETE" });

/* ---------- Fotos ---------- */
export const listPhotos = () => request("/api/photos");
/** `meta`: { besuchId | noteId, takenAt?, lat?, lon?, width?, height? } — die
 * Bilddatei kommt bereits clientseitig verkleinert an (siehe ui/photo.js). */
export const uploadPhoto = (blob, meta = {}) => {
  const form = new FormData();
  form.set("file", blob, "foto.jpg");
  if (meta.besuchId) form.set("besuch_id", meta.besuchId);
  if (meta.noteId) form.set("note_id", meta.noteId);
  if (meta.takenAt) form.set("taken_at", meta.takenAt);
  if (meta.lat != null) form.set("lat", String(meta.lat));
  if (meta.lon != null) form.set("lon", String(meta.lon));
  if (meta.width != null) form.set("width", String(meta.width));
  if (meta.height != null) form.set("height", String(meta.height));
  return request("/api/photos", { method: "POST", body: form });
};
export const deletePhoto = (id) => request(`/api/photos/${id}`, { method: "DELETE" });
/** Bild-URL für <img src> — kein fetch() nötig, das Cookie reist automatisch mit. */
export const photoUrl = (id) => `/api/photos/${id}`;

/** Wetter zu Ort und Zeit; `at` weglassen heißt „jetzt". */
export const weather = (lat, lon, at) =>
  request(`/api/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}${at ? `&at=${encodeURIComponent(at)}` : ""}`);

/** Namensvorschlag zu Koordinaten (Reverse-Geocoding) — {name: string|null}. */
export const geocode = (lat, lon) =>
  request(`/api/geocode?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);

export const listTrips = () => request("/api/trips");
export const createTrip = (trip) => request("/api/trips", { method: "POST", body: JSON.stringify(trip) });
export const updateTrip = (id, patch) => request(`/api/trips/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deleteTrip = (id) => request(`/api/trips/${id}`, { method: "DELETE" });

export const listDriveAssignments = () => request("/api/drive-assignments");
/** `tripId`: Reise-ID, `null` für ausdrückliche Alltagsfahrt, `"auto"` für Zeit-Automatik. */
export const assignDrive = (driveKey, tripId, extra = {}) =>
  request("/api/drive-assignments", { method: "PUT", body: JSON.stringify({ drive_key: driveKey, trip_id: tripId, ...extra }) });
export const updateDriveKind = (driveKey, kind) =>
  request("/api/drive-assignments", { method: "PATCH", body: JSON.stringify({ drive_key: driveKey, kind }) });
/** Wetter am Start einer Fahrt zwischenspeichern — rührt die Zuordnung nicht an. */
export const cacheDriveWeather = (driveKey, weatherJson) =>
  request("/api/drive-assignments", { method: "PATCH", body: JSON.stringify({ drive_key: driveKey, weather: weatherJson }) });

export const stops = (deviceId, from, to) =>
  request(`/api/stops?deviceId=${encodeURIComponent(deviceId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
/** Stopps, die der Nutzer als Übernachtung verworfen hat — dürfen nicht wiederkehren. */
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

/* ---------- Wache: Geofence-Ankerpunkt (nur lesbar), Alarm-Einstellungen,
   -Protokoll ---------- */
// Kein Zonen-CRUD (mehr) — der Ankerpunkt wird ausschließlich über
// updateAlarmSetting("geofence", {enabled: true, lat, lon, radius_m}) beim
// Scharfschalten gesetzt (siehe views/guard.js). listGeofences() liest hier
// nur noch mit, um z. B. den zuletzt genutzten Radius vorauszufüllen.
export const listGeofences = () => request("/api/geofences");

export const listAlarmSettings = () => request("/api/alarms");
export const updateAlarmSetting = (key, patch) => request(`/api/alarms/${key}`, { method: "PATCH", body: JSON.stringify(patch) });
export const listAlarmLog = () => request("/api/alarms/log");

/* ---------- Wache: Push-Benachrichtigung ---------- */
export const pushPublicKey = () => request("/api/push-public-key");
export const subscribePush = (subscription) => request("/api/push-subscriptions", { method: "POST", body: JSON.stringify(subscription) });
export const unsubscribePush = (id) => request(`/api/push-subscriptions/${id}`, { method: "DELETE" });

/* ---------- Benutzerverwaltung (nur Admins) ---------- */
export const listUsers = () => request("/api/users");
export const createUser = (u) => request("/api/users", { method: "POST", body: JSON.stringify(u) });
export const updateUser = (id, patch) => request(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deleteUser = (id) => request(`/api/users/${id}`, { method: "DELETE" });

export const positions = (deviceId) => request(`/api/positions?deviceId=${encodeURIComponent(deviceId)}`);
// Die Fahrten- und Routenabrufe sind groß (Route einer 6-Tage-Reise: ~14 MB) —
// mit Zeitlimit und einer Wiederholung bei Verbindungsproblemen.
export const drives = (deviceId, from, to) =>
  requestWiederholt(`/api/drives?deviceId=${encodeURIComponent(deviceId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { timeoutMs: 120_000 });
export const route = (deviceId, from, to, { timeoutMs = 120_000 } = {}) =>
  requestWiederholt(`/api/route?deviceId=${encodeURIComponent(deviceId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { timeoutMs });
/** Bekannte Geräte — bei Traccar dessen Geräteliste, im Selbst-Hosting-
 * Betrieb die Geräte, die schon einmal an die
 * eigene positions-Tabelle gesendet haben. Fürs Zuordnen einer Geräte-ID
 * zu einem Fahrzeug in den Einstellungen, siehe views/settings.js. */
export const devices = () => request("/api/devices");

/* ---------- Reisen teilen ---------- */
/** Erzeugt einen Freigabe-Link. `tripId` weglassen heißt "alle Reisen". */
export const createShare = ({ tripId, scope, label, expiresInDays } = {}) =>
  request("/api/shares", { method: "POST", body: JSON.stringify({ tripId, scope, label, expiresInDays }) });
export const listShares = () => request("/api/shares");
export const revokeShare = (id) => request(`/api/shares/${id}`, { method: "DELETE" });

/** Öffentliche Gast-Ansicht — kein Login, der Link-Schlüssel ist der Nachweis. */
export const fetchShare = (token) => request(`/api/share/${encodeURIComponent(token)}`);
export const fetchShareRoute = (token, tripId) =>
  request(`/api/share/${encodeURIComponent(token)}/route?tripId=${encodeURIComponent(tripId)}`);
export const fetchSharePositions = (token, tripId) =>
  request(`/api/share/${encodeURIComponent(token)}/positions?tripId=${encodeURIComponent(tripId)}`);
export const fetchShareDrives = (token, tripId) =>
  request(`/api/share/${encodeURIComponent(token)}/drives?tripId=${encodeURIComponent(tripId)}`);
/** Bild-URL für Gäste — nur bei Umfang "Karte + Logbuch" tatsächlich erreichbar. */
export const sharePhotoUrl = (token, photoId) => `/api/share/${encodeURIComponent(token)}/photos/${encodeURIComponent(photoId)}`;

/** Angemeldet zu sein ersetzt die frühere Prüfung auf Adresse und Token. */
export let angemeldet = false;
export const setAngemeldet = (wert) => { angemeldet = wert; };
export const isConfigured = () => angemeldet;
