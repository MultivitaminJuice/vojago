// Routes of trips kept on the device, so the app shows them (and the values
// computed from them) right at start, and does not download the route of a
// finished trip again when nothing changed. IndexedDB, because a few routes
// do not fit into localStorage. Every access may fail (private mode, storage
// blocked, no IndexedDB in tests): then the app simply loads from the server.
const DB_NAME = "vojago-routes";
const STORE = "routes";

let dbPromise = null;
function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run(mode, fn) {
  return open().then((db) => new Promise((resolve) => {
    if (!db) return resolve(null);
    try {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result ?? null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));
}

/** Key of a stored route: trip, device and time range — editing the range or switching the vehicle makes it a different route. */
export const routeKey = (trip, device) => [trip.id, device, trip.range?.from || "", trip.range?.to || "offen"].join("|");

export const readRoute = (key) => run("readonly", (s) => s.get(key));
export const writeRoute = (key, value) => run("readwrite", (s) => s.put(value, key));
export const clearRoutes = () => run("readwrite", (s) => s.clear());
/** All stored keys — to drop routes of trips that no longer exist. */
export const routeKeys = () => run("readonly", (s) => s.getAllKeys());
export const deleteRoute = (key) => run("readwrite", (s) => s.delete(key));

/** Path → compact rows for storage: [lon, lat, elev, spd, timeMs, cum]. */
export function packPath(path) {
  return (path || []).map((p) => [p.lon, p.lat, p.elev, p.spd, Date.parse(p.time || "") || null, p.cum]);
}

/** Inverse of packPath. The day number is set again by the caller (renumberPathByTripStart). */
export function unpackPath(rows) {
  return (rows || []).map(([lon, lat, elev, spd, at, cum]) => ({
    lon, lat, elev, spd, time: at ? new Date(at).toISOString() : null, day: 1, cum,
  }));
}
