import { test } from "node:test";
import assert from "node:assert/strict";
import { findRepeatedStretches, lineWidth } from "../overlap.js";

// Straight road from west to east at 52° N: 0.001° longitude ≈ 68 m.
const DEG = 0.001;
const pt = (i, day, hour, extra = {}, order = i) => ({
  lon: 8 + i * DEG, lat: 52, day, time: new Date(Date.UTC(2026, 9, 25 + day, hour, 0, order * 20)).toISOString(), ...extra,
});
// Time runs forward in the direction of travel, also for drives from east to west.
const drive = (day, hour, from, to, extra = {}) => {
  const out = [];
  const step = from <= to ? 1 : -1;
  for (let i = from, order = 0; step > 0 ? i <= to : i >= to; i += step, order++) out.push(pt(i, day, hour, extra, order));
  return out;
};

test("lineWidth: earliest pass widest, every later one narrower, at least two steps", () => {
  assert.equal(lineWidth(0, 2), 6.4);
  assert.ok(lineWidth(1, 2) < lineWidth(0, 2));
  assert.ok(lineWidth(0, 3) > lineWidth(1, 3) && lineWidth(1, 3) > lineWidth(2, 3));
  assert.equal(lineWidth(9, 9), lineWidth(3, 4));   // limited to four steps
  assert.ok(lineWidth(3, 4) >= 2);
});

test("no overlap: one drive, or two drives on separate roads", () => {
  assert.deepEqual(findRepeatedStretches([drive(1, 8, 0, 60)]), []);
  assert.deepEqual(findRepeatedStretches([]), []);
  const north = drive(2, 8, 0, 60).map((p) => ({ ...p, lat: 52.01 }));   // a good 1 km further north
  assert.deepEqual(findRepeatedStretches([drive(1, 8, 0, 60), north]), []);
});

test("out and back on the same road: two steps, the earlier first and wider", () => {
  const outward = drive(1, 8, 0, 60);
  const back = drive(2, 15, 60, 0, { lat: 52.00015 });   // a good 15 m beside it, other direction
  const runs = findRepeatedStretches([outward, back]);
  assert.ok(runs.length >= 2);
  assert.ok(runs.every((l) => l.count === 2));
  const ranks = new Set(runs.map((l) => l.rank));
  assert.deepEqual([...ranks].sort(), [0, 1]);
  // the earliest pass (rank 0) comes before the later one, so the narrow one lies on top
  assert.ok(runs[0].rank <= runs[runs.length - 1].rank);
  assert.equal(runs.find((l) => l.rank === 0).point.day, 1);
  assert.equal(runs.find((l) => l.rank === 1).point.day, 2);
  // The run covers the whole stretch (about 4 km).
  const length = (r) => runs.filter((l) => l.rank === r).reduce((n, l) => n + (l.coords.length - 1) * 25, 0);
  assert.ok(length(0) > 3000 && length(1) > 3000);
});

test("three drives on top of each other: three steps", () => {
  const runs = findRepeatedStretches([drive(1, 8, 0, 60), drive(2, 8, 60, 0), drive(3, 8, 0, 60)]);
  assert.ok(runs.every((l) => l.count === 3));
  assert.deepEqual([...new Set(runs.map((l) => l.rank))].sort(), [0, 1, 2]);
});

test("a short touch (under 120 m) does not count, e.g. a shared parking spot or a crossing", () => {
  const a = drive(1, 8, 0, 60);
  const across = [0, 1, 2, 3, 4].map((i) => ({ lon: 8 + 0.03, lat: 52 - 0.002 + i * 0.001, day: 2, time: new Date(Date.UTC(2026, 9, 27, 9, i)).toISOString() }));
  assert.deepEqual(findRepeatedStretches([a, across]), []);
  // Only a small shared piece at the start:
  const b = [...drive(2, 9, 0, 1), ...drive(2, 9, 1, 1).map((p) => ({ ...p, lat: 52.02 })), { ...pt(2, 2, 9, {}, 5), lat: 52.03 }];
  assert.deepEqual(findRepeatedStretches([a, b]), []);
});

test("a time gap within the same piece separates two passes (out and back on the same day)", () => {
  const outward = drive(1, 8, 0, 60);
  const back = drive(1, 16, 60, 0, { lat: 52.0001 });
  const runs = findRepeatedStretches([[...outward, ...back]]);
  assert.ok(runs.length >= 2);
  assert.deepEqual([...new Set(runs.map((l) => l.rank))].sort(), [0, 1]);
});

test("without timestamps the order of the pieces counts", () => {
  const untimed = (list) => list.map(({ lon, lat, day }) => ({ lon, lat, day }));
  const runs = findRepeatedStretches([untimed(drive(1, 8, 0, 60)), untimed(drive(2, 8, 60, 0))]);
  assert.ok(runs.length >= 2);
  assert.equal(runs.find((l) => l.rank === 0).point.day, 1);
});
