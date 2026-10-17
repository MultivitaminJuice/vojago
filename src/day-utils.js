const DAY_MS = 86400000;

export function localDayKey(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dateFromDayKey(key) {
  const d = key ? new Date(`${key}T12:00:00`) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

export function tripStartIso(trip) {
  return trip?.start || trip?.range?.from || null;
}

export function tripEndIso(trip, nowIso = new Date().toISOString()) {
  return trip?.end || trip?.range?.to || (trip?.live ? nowIso : null);
}

export function shiftIsoByLocalDays(iso, days) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export function dayKeyForTripDay(trip, day) {
  const start = tripStartIso(trip);
  if (!start || !Number.isFinite(day)) return "";
  return localDayKey(shiftIsoByLocalDays(start, Math.max(0, day - 1)));
}

export function tripDayNumberFromKeys(key, startKey) {
  const day = dateFromDayKey(key);
  const start = dateFromDayKey(startKey);
  if (!day || !start) return null;
  return Math.max(1, Math.round((day.getTime() - start.getTime()) / DAY_MS) + 1);
}

export function tripDayNumberForIso(iso, tripOrStartIso) {
  const startIso = typeof tripOrStartIso === "string" ? tripOrStartIso : tripStartIso(tripOrStartIso);
  return tripDayNumberFromKeys(localDayKey(iso), localDayKey(startIso));
}

export function renumberPathByTripStart(path, trip) {
  if (!Array.isArray(path) || !path.length || !tripStartIso(trip)) return Array.isArray(path) ? path : [];
  return path.map((point) => {
    const day = tripDayNumberForIso(point.time, trip);
    return Number.isFinite(day) ? { ...point, day } : point;
  });
}

export function tripDayKeys(trip, { nowIso = new Date().toISOString(), extraKeys = [] } = {}) {
  const cleanExtra = extraKeys.filter(Boolean).sort();
  const startKey = localDayKey(tripStartIso(trip)) || cleanExtra[0] || "";
  if (!startKey) return [];
  const tripEndKey = localDayKey(tripEndIso(trip, nowIso));
  const endKey = [tripEndKey, cleanExtra.at(-1)].filter(Boolean).sort().at(-1) || startKey;
  const start = dateFromDayKey(startKey);
  const end = dateFromDayKey(endKey);
  if (!start || !end) return cleanExtra.length ? cleanExtra : [startKey];

  const keys = [];
  const cursor = new Date(start);
  for (let guard = 0; cursor <= end && guard < 400; guard++) {
    keys.push(localDayKey(cursor.toISOString()));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}
