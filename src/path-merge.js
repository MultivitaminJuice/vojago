import { distanceKm } from "./geo.js";

/**
 * Appends newly arrived route points to an existing path instead of loading
 * the whole route again. `fresh` is a path just built from positions (cum and
 * day starting at 0 and 1): only what lies AFTER the last known point is
 * taken, and the distance is carried on (including the way from the last old
 * to the first new point). Returns the unchanged `existing` path when nothing
 * new arrived.
 */
export function appendNewPoints(existing, fresh) {
  if (!Array.isArray(existing) || !existing.length) return Array.isArray(fresh) ? fresh : [];
  const lastMs = Date.parse(existing[existing.length - 1].time || "");
  const newer = (fresh || []).filter((p) => Date.parse(p.time || "") > lastMs);
  if (!newer.length) return existing;
  const last = existing[existing.length - 1];
  const first = newer[0];
  const offset = (last.cum || 0) + distanceKm(last.lon, last.lat, first.lon, first.lat) - (first.cum || 0);
  return existing.concat(newer.map((p) => ({ ...p, cum: (p.cum || 0) + offset })));
}
