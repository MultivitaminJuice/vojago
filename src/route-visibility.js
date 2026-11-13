// Which parts of a trip's route are shown for the drive filter (stages,
// detours, all). The filter values "etappe", "abstecher", "alle" and the drive
// kinds are stored values and stay as they are.
import { distanceKm } from "./geo.js";

const DETOUR_PAD_MINUTES = 2;

function rangesForDrives(drives, tripId, predicate) {
  return (drives || [])
    .filter((d) => d.tripId === tripId && predicate(d))
    .map((d) => {
      const from = Date.parse(d.from || "");
      const to = Date.parse(d.to || "");
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
      return {
        from: from - DETOUR_PAD_MINUTES * 60_000,
        to: to + DETOUR_PAD_MINUTES * 60_000,
      };
    })
    .filter(Boolean);
}

function detourRanges(drives, tripId) {
  return rangesForDrives(drives, tripId, (d) => d.kind === "abstecher");
}

function tripDrives(drives, tripId) {
  return (drives || []).filter((drive) => drive.tripId === tripId);
}

function rangesForFilter(drives, tripId, filter) {
  return rangesForDrives(drives, tripId, (drive) => driveMatchesRouteFilter(drive, filter));
}

function inRange(point, ranges) {
  const time = Date.parse(point?.time || "");
  return Number.isFinite(time) && ranges.some((range) => time >= range.from && time <= range.to);
}

function segmentsInsideRanges(path, ranges, openFromMs = null) {
  const segments = [];
  let current = [];
  for (const point of path) {
    const time = Date.parse(point?.time || "");
    // Open end: points AFTER the last known drive probably belong to a drive
    // the (less often refreshed) drive list does not know yet.
    const inOpenEnd = openFromMs != null && Number.isFinite(time) && time > openFromMs;
    if (inOpenEnd || inRange(point, ranges)) {
      current.push(point);
    } else {
      if (current.length > 1) segments.push(current);
      current = [];
    }
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

function normaliseSegments(segments) {
  let cum = 0;
  return segments.map((segment) => segment.map((point, index) => {
    if (index > 0) {
      const previous = segment[index - 1];
      cum += distanceKm(previous.lon, previous.lat, point.lon, point.lat);
    }
    return { ...point, cum };
  }));
}

export function driveMatchesRouteFilter(drive, filter = "etappe") {
  if (filter === "alle") return true;
  if (filter === "abstecher") return drive?.kind === "abstecher";
  return drive?.kind !== "abstecher";
}

export function filteredRouteDrives(drives, tripId, filter = "etappe") {
  return (drives || []).filter((drive) => drive.tripId === tripId && driveMatchesRouteFilter(drive, filter));
}

export function itemMatchesRouteFilter(item, drives, tripId, filter = "etappe") {
  if (filter === "alle") return true;
  const time = Date.parse(item?.at || item?.time || "");
  if (!Number.isFinite(time)) return filter !== "abstecher";
  if (filter === "etappe") {
    const stageRanges = rangesForFilter(drives, tripId, "etappe");
    if (stageRanges.some((range) => time >= range.from && time <= range.to)) return true;
  }
  const ranges = detourRanges(drives, tripId);
  const isDetour = ranges.some((range) => time >= range.from && time <= range.to);
  return filter === "abstecher" ? isDetour : !isDetour;
}

/**
 * @param {object} [options]
 * @param {boolean} [options.openEnd] For a running trip: still show points after
 *   the last known drive (the drive list lags behind the path; otherwise the
 *   most recent piece of the route would be missing).
 */
export function visibleRouteSegments(path, drives, tripId, filter = "etappe", { openEnd = false } = {}) {
  if (!Array.isArray(path) || !path.length) return [];
  if (filter === "alle") return normaliseSegments([path]);

  if (filter === "abstecher") {
    const ranges = rangesForFilter(drives, tripId, "abstecher");
    if (!ranges.length) return [];
    return normaliseSegments(segmentsInsideRanges(path, ranges));
  }

  const drivesInTrip = tripDrives(drives, tripId);
  const stageRanges = rangesForFilter(drivesInTrip, tripId, "etappe");
  if (stageRanges.length) {
    // "Open" starts only after the last known drive of ANY kind — a detour at
    // the end stays hidden.
    const allEnds = rangesForDrives(drivesInTrip, tripId, () => true).map((r) => r.to);
    const openFrom = openEnd && allEnds.length ? Math.max(...allEnds) : null;
    return normaliseSegments(segmentsInsideRanges(path, stageRanges, openFrom));
  }

  if (drivesInTrip.length) return [];

  const ranges = detourRanges(drives, tripId);
  if (!ranges.length) return normaliseSegments([path]);

  const segments = [];
  let current = [];
  for (const point of path) {
    if (inRange(point, ranges)) {
      if (current.length > 1) segments.push(current);
      current = [];
      continue;
    }
    current.push(point);
  }
  if (current.length > 1) segments.push(current);
  return normaliseSegments(segments);
}

export function visibleRoutePath(path, drives, tripId, filter = "etappe", options = {}) {
  return visibleRouteSegments(path, drives, tripId, filter, options).flat();
}
