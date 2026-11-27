import { test } from "node:test";
import assert from "node:assert/strict";
import { dayWeather, dayTimeline, tripDays, shortAddress } from "../journal-days.js";

const place = (id, catId, at, extra = {}) => ({ kind: "place", at, data: { id, title: id, catId, at, ...extra } });
const note = (id, at) => ({ kind: "note", at, data: { id, at } });

test("dayWeather: range of temperatures and the most frequent condition, null without data", () => {
  assert.equal(dayWeather([]), null);
  assert.equal(dayWeather([null, { text: "klar" }]), null);
  const w = dayWeather([{ temp: 14.2, text: "klar", symbol: "S" }, { temp: 19.4, text: "klar", symbol: "S" }, { temp: 16, text: "bedeckt", symbol: "B" }]);
  assert.deepEqual(w, { temp: "14 bis 19°", text: "klar", symbol: "S" });
  assert.equal(dayWeather([{ temp: 17, text: "klar" }]).temp, "17°");
});

test("dayTimeline: start, stops and night in time order, continued nights do not count", () => {
  const v = dayTimeline(
    [place("night", "uebernachtung", "2026-10-19T18:20:00Z"), place("cafe", "stopp", "2026-10-19T13:10:00Z"), { kind: "night-continuation", at: "2026-10-19T20:00:00Z", data: { id: "x" } }],
    [{ from: "2026-10-19T07:10:00Z", startAddress: "Hauptstraße 1, Imst, Tirol" }],
  );
  assert.deepEqual(v.map((x) => x.kind), ["start", "stop", "night"]);
  assert.equal(v[0].title, "Hauptstraße 1, Imst");
  assert.equal(shortAddress("A, B, C"), "A, B");
});

test("tripDays: days from entries, drives and track, with number, kilometres, weather and timeline", () => {
  const pt = (day, time, cum) => ({ day, time, cum, lon: 10, lat: 50 });
  const days = tripDays({
    startIso: "2026-10-19T08:00:00Z",
    entries: [
      place("n1", "uebernachtung", "2026-10-19T18:00:00Z", { weather: { temp: 15, text: "klar", symbol: "S" } }),
      { kind: "night-continuation", at: "2026-10-20T18:00:00Z", data: { id: "n1" } },
      note("z1", "2026-10-21T09:00:00Z"),
    ],
    drives: [{ from: "2026-10-19T08:30:00Z", km: 120.04, startAddress: "Imst", endAddress: "Landeck" }],
    path: [pt(1, "2026-10-19T08:30:00Z", 0), pt(1, "2026-10-19T09:30:00Z", 118), pt(3, "2026-10-21T09:00:00Z", 118), pt(3, "2026-10-21T10:00:00Z", 160)],
  });
  assert.deepEqual(days.map((t) => t.number), [1, 2, 3]);
  assert.equal(days[0].km, 120);
  assert.equal(days[0].from, "Imst");
  assert.equal(days[0].to, "Landeck");
  assert.equal(days[0].weather.temp, "15°");
  assert.deepEqual(days[0].timeline.map((v) => v.kind), ["start", "night"]);
  assert.equal(days[1].entries.length, 1);
  assert.equal(days[1].km, 0);
  assert.equal(days[2].km, 42);
  assert.equal(days[2].notes.length, 1);
});

test("tripDays: days without any content are dropped, numbering follows the trip start", () => {
  const days = tripDays({ startIso: "2026-10-19T08:00:00Z", entries: [place("a", "stopp", "2026-10-22T10:00:00Z")], drives: [], path: [{ day: 5, time: "2026-10-23T10:00:00Z", cum: 0, lon: 1, lat: 1 }] });
  assert.deepEqual(days.map((t) => t.key), ["2026-10-22"]);
  assert.equal(days[0].number, 4);
});

test("tripDays: extra days (e.g. with a diary entry) get a chapter even without data", () => {
  const days = tripDays({ startIso: "2026-10-19T08:00:00Z", entries: [], drives: [], path: [], extraDays: ["2026-10-21"] });
  assert.deepEqual(days.map((t) => [t.key, t.number, t.km]), [["2026-10-21", 3, 0]]);
  assert.deepEqual(days[0].timeline, []);
});
