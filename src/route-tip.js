// Text of the info card that appears when tapping the route: day, date, time,
// kilometres from the start, speed and elevation of the nearest route point.
// The texts are UI and stay German.
const WEEKDAY = new Intl.DateTimeFormat("de-DE", { weekday: "short" });
const DATE = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit" });
const CLOCK = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });

const withoutDot = (text) => text.replace(/\.$/, "");

export function routeTip(p) {
  const time = p.time ? new Date(p.time) : null;
  const valid = time && !Number.isNaN(time.getTime());
  const heading = [];
  if (Number.isFinite(p.day)) heading.push(`Tag ${p.day}`);
  if (valid) heading.push(`${withoutDot(WEEKDAY.format(time))} ${withoutDot(DATE.format(time))}.`, CLOCK.format(time));

  const number = (n, digits) => n.toLocaleString("de-DE", { maximumFractionDigits: digits });
  const values = [];
  if (Number.isFinite(p.cum)) values.push(`km ${number(p.cum, p.cum < 100 ? 1 : 0)}`);
  if (Number.isFinite(p.spd)) values.push(p.spd < 1 ? "steht" : `${number(Math.round(p.spd), 0)} km/h`);
  if (Number.isFinite(p.elev)) values.push(`${number(Math.round(p.elev), 0)} m`);
  return { heading: heading.join(" · "), values: values.join(" · ") };
}

/**
 * Entries of the info card for all passes at a spot. With several, each entry
 * gets a title "1 von 3"; beyond `maxEntries` the rest are only counted
 * ("+ n weitere").
 */
export function tipEntries(hits, maxEntries = 5) {
  const shown = hits.slice(0, maxEntries);
  return {
    entries: shown.map((t, i) => ({
      title: hits.length > 1 ? `${i + 1} von ${hits.length}` : "",
      ...routeTip(t.point),
    })),
    more: Math.max(0, hits.length - shown.length),
  };
}

/** The hit nearest to the finger (anchor for the marker and the map). */
export const nearestHit = (hits) => hits.reduce((b, t) => (!b || t.distanceM < b.distanceM ? t : b), null);
