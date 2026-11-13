import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dayKey, parseDay, dateText, monthOf, shiftMonth, monthGrid, pickDay, roleInRange,
  rangeToIso, rangeFromDates, rangePreset,
} from "../calendar.js";

test("dayKey, parseDay, dateText: local calendar days there and back, nonsense is rejected", () => {
  assert.equal(dayKey(new Date(2026, 9, 7, 23, 59)), "2026-10-07");
  assert.equal(dayKey(parseDay("2026-10-27")), "2026-10-27");
  assert.equal(parseDay("2026-02-30"), null);
  assert.equal(parseDay("broken"), null);
  assert.equal(dateText("2026-10-07"), "07.10.2026");
  assert.equal(dateText(""), "");
});

test("shiftMonth: across year boundaries", () => {
  assert.deepEqual(shiftMonth({ year: 2026, month: 11 }, 1), { year: 2027, month: 0 });
  assert.deepEqual(shiftMonth({ year: 2026, month: 0 }, -1), { year: 2025, month: 11 });
  assert.deepEqual(monthOf("2026-10-27"), { year: 2026, month: 9 });
});

test("monthGrid: October 2026 starts on a Thursday, six weeks, Monday first", () => {
  const r = monthGrid({ year: 2026, month: 9 }, new Date(2026, 9, 27));
  assert.equal(r.title, "Oktober 2026");
  assert.equal(r.weeks.length, 6);
  assert.ok(r.weeks.every((w) => w.length === 7));
  // 1 October 2026 is a Thursday: before it Mon 28.9. to Wed 30.9.
  assert.deepEqual(r.weeks[0].map((d) => d.day), [28, 29, 30, 1, 2, 3, 4]);
  assert.deepEqual(r.weeks[0].map((d) => d.inMonth), [false, false, false, true, true, true, true]);
  assert.equal(r.weeks.flat().filter((d) => d.today).map((d) => d.key).join(), "2026-10-27");
  assert.equal(r.weeks.flat().filter((d) => d.inMonth).length, 31);
});

test("monthGrid: a month starting on a Monday has no previous month in the first row", () => {
  const r = monthGrid({ year: 2026, month: 5 }, new Date(2026, 0, 1)); // 1 June 2026 = Monday
  assert.equal(r.weeks[0][0].key, "2026-06-01");
  assert.ok(r.weeks[0][0].inMonth);
});

test("pickDay: start first, then end; an earlier day swaps; the same day is one day; then anew", () => {
  let a = pickDay({}, "2026-10-10");
  assert.deepEqual(a, { from: "2026-10-10", to: null });
  a = pickDay(a, "2026-10-14");
  assert.deepEqual(a, { from: "2026-10-10", to: "2026-10-14" });
  assert.deepEqual(pickDay(a, "2026-10-20"), { from: "2026-10-20", to: null });
  assert.deepEqual(pickDay({ from: "2026-10-10", to: null }, "2026-10-03"), { from: "2026-10-03", to: "2026-10-10" });
  assert.deepEqual(pickDay({ from: "2026-10-10", to: null }, "2026-10-10"), { from: "2026-10-10", to: "2026-10-10" });
});

test("roleInRange", () => {
  const b = { from: "2026-10-10", to: "2026-10-12" };
  assert.deepEqual(["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"].map((k) => roleInRange(b, k)), [null, "start", "middle", "end", null]);
  assert.equal(roleInRange({ from: "2026-10-10", to: null }, "2026-10-10"), "single");
  assert.equal(roleInRange({}, "2026-10-10"), null);
});

test("rangeToIso: whole days from 0:00 to 23:59:59, the end never in the future", () => {
  const now = new Date(2026, 9, 27, 15, 30);
  const r = rangeToIso({ from: "2026-10-18", to: "2026-10-20" }, { now });
  assert.equal(new Date(r.from).getTime(), new Date(2026, 9, 18, 0, 0, 0, 0).getTime());
  assert.equal(new Date(r.to).getTime(), new Date(2026, 9, 20, 23, 59, 59, 999).getTime());
  // Up to today: the end is now, not 23:59.
  const today = rangeToIso({ from: "2026-10-27", to: "2026-10-27" }, { now });
  assert.equal(today.to, now.toISOString());
  // Only one day picked: one day.
  const oneDay = rangeToIso({ from: "2026-10-20", to: null }, { now });
  assert.equal(new Date(oneDay.to).getTime(), new Date(2026, 9, 20, 23, 59, 59, 999).getTime());
});

test("rangeToIso: own times, a wrong order and a missing start", () => {
  const now = new Date(2026, 9, 27, 15, 30);
  const r = rangeToIso({ from: "2026-10-20", to: "2026-10-20" }, { fromTime: "08:15", toTime: "12:00", now });
  assert.equal(new Date(r.from).getTime(), new Date(2026, 9, 20, 8, 15, 0, 0).getTime());
  assert.equal(new Date(r.to).getTime(), new Date(2026, 9, 20, 12, 0, 59, 999).getTime());
  assert.equal(rangeToIso({ from: "2026-10-20", to: "2026-10-20" }, { fromTime: "14:00", toTime: "09:00", now }), null);
  assert.equal(rangeToIso({ from: null, to: null }, { now }), null);
});

test("rangeFromDates and presets", () => {
  assert.deepEqual(rangeFromDates(new Date(2026, 9, 18, 6, 5), new Date(2026, 9, 20, 22, 0)), { from: "2026-10-18", to: "2026-10-20", fromTime: "06:05", toTime: "22:00" });
  const now = new Date(2026, 9, 27, 15, 30);
  assert.deepEqual(rangePreset("today", now), { from: "2026-10-27", to: "2026-10-27" });
  assert.deepEqual(rangePreset("yesterday", now), { from: "2026-10-26", to: "2026-10-26" });
  assert.deepEqual(rangePreset("last7", now), { from: "2026-10-21", to: "2026-10-27" });
  assert.deepEqual(rangePreset("month", now), { from: "2026-10-01", to: "2026-10-27" });
  assert.deepEqual(rangePreset("all", now, { from: new Date(2026, 5, 2), to: new Date(2026, 6, 9) }), { from: "2026-06-02", to: "2026-07-09" });
});
