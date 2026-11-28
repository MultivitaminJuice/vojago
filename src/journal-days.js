// Logbook: the trip as a sequence of days (chapters). Pure computation, no DOM —
// journal.js draws the heading, the reminders, place cards and notes from it.
import { localDayKey, tripDayNumberFromKeys } from "./day-utils.js";

export const shortAddress = (text) => (text || "").split(",").slice(0, 2).join(",").trim();

/** Weather of a day from the weather of its visits: the range and the most frequent condition. */
export function dayWeather(weatherList) {
  const w = (weatherList || []).filter((x) => x && Number.isFinite(Number(x.temp)));
  if (!w.length) return null;
  const temps = w.map((x) => Number(x.temp));
  const min = Math.round(Math.min(...temps));
  const max = Math.round(Math.max(...temps));
  const counter = new Map();
  for (const x of w) {
    if (!x.text) continue;
    const e = counter.get(x.text) || { n: 0, symbol: x.symbol || "" };
    e.n += 1;
    counter.set(x.text, e);
  }
  const [text, e] = [...counter.entries()].sort((a, b) => b[1].n - a[1].n)[0] || [
    "",
    { symbol: "" },
  ];
  return { temp: min === max ? `${min}°` : `${min} bis ${max}°`, text, symbol: e.symbol };
}

/** The events of a day in time order: start, stops, overnight stay. kind: "start" | "stop" | "night". */
export function dayTimeline(entries, drives) {
  const timeline = [];
  const first = [...drives].sort((a, b) => String(a.from).localeCompare(String(b.from)))[0];
  if (first?.from)
    timeline.push({ time: first.from, kind: "start", title: shortAddress(first.startAddress) });
  for (const e of entries) {
    if (e.kind !== "place") continue;
    timeline.push({
      time: e.at || e.data.at || "",
      kind: e.data.catId === "uebernachtung" ? "night" : "stop",
      title: e.data.title || "",
      placeId: e.data.id,
    });
  }
  return timeline.sort((a, b) => String(a.time).localeCompare(String(b.time)));
}

/**
 * Days of the trip with everything that belongs to them. `entries`: flat list
 * from journal.js ({ kind: "place" | "night-continuation" | "note", at, data }),
 * `drives`: drives of the trip, `path`: track with a `day` number per point.
 * `extraDays`: days that get a chapter even without visit, drive or track (e.g.
 * because a diary entry exists). Days without any content are dropped.
 * Returns [{ key, number, entries, notes, points, km, from, to, weather, timeline }].
 */
export function tripDays({ startIso, entries, drives, path, extraDays = [] }) {
  const days = new Map();
  const day = (key) => {
    if (!days.has(key)) days.set(key, { key, entries: [], drives: [], points: [] });
    return days.get(key);
  };
  for (const e of entries) {
    const k = localDayKey(e.at);
    if (k) day(k).entries.push(e);
  }
  for (const d of drives) {
    const k = localDayKey(d.from);
    if (k) day(k).drives.push(d);
  }
  const extra = new Set(extraDays);
  for (const k of extra) day(k);

  // Track: points carry their day number; the key comes from the first point of the day.
  const byNumber = new Map();
  for (const p of path || []) {
    if (!byNumber.has(p.day)) byNumber.set(p.day, []);
    byNumber.get(p.day).push(p);
  }
  for (const points of byNumber.values()) {
    const k = localDayKey(points[0]?.time);
    if (k && points.length >= 2) day(k).points = points;
  }

  const startKey = localDayKey(startIso);
  return [...days.values()]
    .filter((t) => t.entries.length || t.drives.length || t.points.length >= 2 || extra.has(t.key))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((t, i) => {
      const places = t.entries.filter((e) => e.kind === "place");
      const notes = t.entries.filter((e) => e.kind === "note");
      const kmDrives = t.drives.reduce((s, d) => s + (Number(d.km) || 0), 0);
      const kmTrack = t.points.length >= 2 ? t.points.at(-1).cum - t.points[0].cum : 0;
      const sorted = [...t.drives].sort((a, b) => String(a.from).localeCompare(String(b.from)));
      return {
        key: t.key,
        number: tripDayNumberFromKeys(t.key, startKey) || i + 1,
        entries: t.entries,
        notes,
        points: t.points,
        km: Math.round((t.drives.length ? kmDrives : kmTrack) * 10) / 10,
        from: shortAddress(sorted[0]?.startAddress),
        to: shortAddress(sorted.at(-1)?.endAddress),
        weather: dayWeather([
          ...places.map((e) => e.data.weather),
          ...notes.map((e) => e.data.weather),
        ]),
        timeline: dayTimeline(t.entries, t.drives),
      };
    });
}
