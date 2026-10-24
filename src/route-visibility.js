import { distanceKm } from "./geo.js";

const ABSTECHER_PAD_MINUTEN = 2;

function rangesForDrives(drives, tripId, predicate) {
  return (drives || [])
    .filter((d) => d.tripId === tripId && predicate(d))
    .map((d) => {
      const from = Date.parse(d.from || "");
      const to = Date.parse(d.to || "");
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
      return {
        from: from - ABSTECHER_PAD_MINUTEN * 60_000,
        to: to + ABSTECHER_PAD_MINUTEN * 60_000,
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

function segmentsInsideRanges(path, ranges, offenAbMs = null) {
  const segments = [];
  let current = [];
  for (const point of path) {
    const zeit = Date.parse(point?.time || "");
    // Offenes Ende: Punkte NACH der zuletzt bekannten Fahrt gehören vermutlich zu
    // einer Fahrt, die die (seltener aktualisierte) Fahrtenliste noch nicht kennt.
    const imOffenenEnde = offenAbMs != null && Number.isFinite(zeit) && zeit > offenAbMs;
    if (imOffenenEnde || inRange(point, ranges)) {
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
    const etappeRanges = rangesForFilter(drives, tripId, "etappe");
    if (etappeRanges.some((range) => time >= range.from && time <= range.to)) return true;
  }
  const ranges = detourRanges(drives, tripId);
  const isDetour = ranges.some((range) => time >= range.from && time <= range.to);
  return filter === "abstecher" ? isDetour : !isDetour;
}

/**
 * @param {object} [optionen]
 * @param {boolean} [optionen.offenesEnde] Bei laufender Reise: Punkte nach der
 *   letzten bekannten Fahrt trotzdem zeigen (die Fahrtenliste hinkt dem Pfad
 *   hinterher, sonst fehlt das jüngste Stück der Strecke).
 */
export function visibleRouteSegments(path, drives, tripId, filter = "etappe", { offenesEnde = false } = {}) {
  if (!Array.isArray(path) || !path.length) return [];
  if (filter === "alle") return normaliseSegments([path]);

  if (filter === "abstecher") {
    const ranges = rangesForFilter(drives, tripId, "abstecher");
    if (!ranges.length) return [];
    return normaliseSegments(segmentsInsideRanges(path, ranges));
  }

  const drivesInTrip = tripDrives(drives, tripId);
  const etappeRanges = rangesForFilter(drivesInTrip, tripId, "etappe");
  if (etappeRanges.length) {
    // "Offen" beginnt erst nach der letzten bekannten Fahrt JEDER Art — ein
    // Abstecher am Ende bleibt ausgeblendet.
    const alleEnden = rangesForDrives(drivesInTrip, tripId, () => true).map((r) => r.to);
    const offenAb = offenesEnde && alleEnden.length ? Math.max(...alleEnden) : null;
    return normaliseSegments(segmentsInsideRanges(path, etappeRanges, offenAb));
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

export function visibleRoutePath(path, drives, tripId, filter = "etappe", optionen = {}) {
  return visibleRouteSegments(path, drives, tripId, filter, optionen).flat();
}
