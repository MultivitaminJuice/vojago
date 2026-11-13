// Calendar logic for picking dates (choose a time span, edit a trip). Pure
// computation, no DOM — the calendar view (ui/calendar.js) draws from it. Days
// are local calendar days as "YYYY-MM-DD"; the week starts on Monday.
// Month and weekday names are UI and stay German.
const pad = (n) => String(n).padStart(2, "0");

export const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
export const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

export const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** "2026-10-27" → local date at 0:00, or null. */
export function parseDay(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) || dayKey(d) !== key ? null : d;
}

/** "2026-10-27" → "27.10.2026". */
export function dateText(key) {
  const d = parseDay(key);
  return d ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}` : "";
}

/** Month to show: year and month (0–11) of a day. */
export function monthOf(key, now = new Date()) {
  const d = parseDay(key) || now;
  return { year: d.getFullYear(), month: d.getMonth() };
}

export function shiftMonth({ year, month }, delta) {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/** Six weeks of seven days for a month (stable height); days outside the month are marked. */
export function monthGrid({ year, month }, now = new Date()) {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const today = dayKey(now);
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const week = [];
    for (let t = 0; t < 7; t++) {
      const d = new Date(year, month, 1 - offset + w * 7 + t);
      const key = dayKey(d);
      week.push({ key, day: d.getDate(), inMonth: d.getMonth() === month, today: key === today });
    }
    weeks.push(week);
  }
  return { title: `${MONTHS[month]} ${year}`, weeks };
}

/**
 * Tapping a day while choosing a time span: the first tap sets the start, the
 * second the end (an earlier day swaps both, the same day gives a single day),
 * a further tap starts again.
 */
export function pickDay({ from = null, to = null } = {}, key) {
  if (!from || to) return { from: key, to: null };
  if (key < from) return { from: key, to: from };
  return { from, to: key };
}

/** Role of a day in the chosen span: "single" | "start" | "end" | "middle" | null. */
export function roleInRange({ from = null, to = null } = {}, key) {
  if (!from) return null;
  const end = to || from;
  if (key === from && key === end) return "single";
  if (key === from) return "start";
  if (key === end) return "end";
  return key > from && key < end ? "middle" : null;
}

const timeParts = (time, fallback) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ""));
  return m ? [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))] : fallback;
};

/**
 * Chosen days (and times, by default the whole day) as ISO times. The end never
 * reaches into the future. Returns null without a start or when the end lies before the start.
 */
export function rangeToIso({ from, to }, { fromTime = "00:00", toTime = "23:59", now = new Date() } = {}) {
  const start = parseDay(from);
  const end = parseDay(to || from);
  if (!start || !end) return null;
  const [fh, fm] = timeParts(fromTime, [0, 0]);
  const [th, tm] = timeParts(toTime, [23, 59]);
  const fromDate = new Date(start.getFullYear(), start.getMonth(), start.getDate(), fh, fm, 0, 0);
  let toDate = new Date(end.getFullYear(), end.getMonth(), end.getDate(), th, tm, 59, 999);
  if (toDate.getTime() > now.getTime()) toDate = new Date(now);
  if (toDate.getTime() < fromDate.getTime()) return null;
  return { from: fromDate.toISOString(), to: toDate.toISOString() };
}

/** Times (Date) → selection with days and times. */
export function rangeFromDates(from, to) {
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { from: dayKey(from), to: dayKey(to), fromTime: hm(from), toTime: hm(to) };
}

/** Presets as whole days. "all" needs the bounds of the trips. */
export function rangePreset(name, now = new Date(), all = null) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = (n) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);
  if (name === "today") return { from: dayKey(today), to: dayKey(today) };
  if (name === "yesterday") return { from: dayKey(days(-1)), to: dayKey(days(-1)) };
  if (name === "last7") return { from: dayKey(days(-6)), to: dayKey(today) };
  if (name === "month") return { from: dayKey(new Date(today.getFullYear(), today.getMonth(), 1)), to: dayKey(today) };
  const from = all?.from ? new Date(all.from) : days(-30);
  const to = all?.to ? new Date(all.to) : today;
  return { from: dayKey(from), to: dayKey(to) };
}
