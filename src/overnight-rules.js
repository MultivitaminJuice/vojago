// Rules for automatic overnight stays and short stops, shared by the app and the
// ingest container (tracker-backend/src/auto-import.js). They work with LOCAL
// times (the night window 22–6, calendar days), so the ingest container runs
// with the time zone of its users (see tracker-backend/Dockerfile).
// The category ids "uebernachtung" and "stopp" are stored values and stay as they are.
const MS_PER_HOUR = 3600000;

export const OVERNIGHT_MIN_STANDING_HOURS = 5;
export const OVERNIGHT_NIGHT_START = 22;
export const OVERNIGHT_NIGHT_END = 6;
export const OVERNIGHT_MIN_NIGHT_HOURS = 2;

function dateFromIso(iso) {
  const ms = Date.parse(iso || "");
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function plusDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** Hours between two times (0 when invalid or reversed). */
export function standingHours(fromIso, toIso = new Date().toISOString()) {
  const from = Date.parse(fromIso || "");
  const to = Date.parse(toIso || "");
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  return (to - from) / MS_PER_HOUR;
}

/** Hours of a stand that fall into the night window (22:00–06:00 local time). */
export function nightWindowHours(fromIso, toIso = new Date().toISOString()) {
  const fromDate = dateFromIso(fromIso);
  const toDate = dateFromIso(toIso);
  if (!fromDate || !toDate || toDate <= fromDate) return 0;

  let day = plusDays(startOfLocalDay(fromDate), -1);
  const lastDay = plusDays(startOfLocalDay(toDate), 1);
  let sum = 0;
  while (day <= lastDay) {
    const start = new Date(day);
    start.setHours(OVERNIGHT_NIGHT_START, 0, 0, 0);
    const end = plusDays(start, OVERNIGHT_NIGHT_START > OVERNIGHT_NIGHT_END ? 1 : 0);
    end.setHours(OVERNIGHT_NIGHT_END, 0, 0, 0);

    const overlap = Math.min(toDate.getTime(), end.getTime()) - Math.max(fromDate.getTime(), start.getTime());
    if (overlap > 0) sum += overlap / MS_PER_HOUR;
    day = plusDays(day, 1);
  }
  return sum;
}

/** Does a stand count as an automatic overnight stay? Returns the decision with its numbers. */
export function checkAutomaticOvernight(fromIso, toIso = new Date().toISOString()) {
  const standing = standingHours(fromIso, toIso);
  const night = nightWindowHours(fromIso, toIso);
  const qualifies = standing >= OVERNIGHT_MIN_STANDING_HOURS && night >= OVERNIGHT_MIN_NIGHT_HOURS;
  return {
    qualifies,
    standingHours: standing,
    nightHours: night,
    minStandingHours: OVERNIGHT_MIN_STANDING_HOURS,
    minNightHours: OVERNIGHT_MIN_NIGHT_HOURS,
    nightStart: OVERNIGHT_NIGHT_START,
    nightEnd: OVERNIGHT_NIGHT_END,
  };
}

// Clearly shorter stops (shopping, a restaurant, a museum) are recorded too,
// not only overnight stays. 20 minutes: long enough not to be a traffic light
// or a GPS glitch, short enough to catch a short visit (requested 05.09.2026).
export const SHORT_STOP_MIN_HOURS = 20 / 60;

/**
 * Decides WHETHER and AS WHAT a stand is recorded automatically: as an
 * overnight stay (the usual rules), otherwise as a short stop (only a minimum
 * duration, no night window), or not at all (too short for both).
 * Returns { catId: "uebernachtung" | "stopp", check } or null.
 */
export function classifyStand(fromIso, toIso = new Date().toISOString()) {
  const overnight = checkAutomaticOvernight(fromIso, toIso);
  if (overnight.qualifies) return { catId: "uebernachtung", check: overnight };
  if (overnight.standingHours >= SHORT_STOP_MIN_HOURS) return { catId: "stopp", check: overnight };
  return null;
}
