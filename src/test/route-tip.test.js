import { test } from "node:test";
import assert from "node:assert/strict";
import { routeTip, tipEntries, nearestHit } from "../route-tip.js";
import { routeHits, sameSpot, metersPerPixel } from "../geo.js";

test("routeTip: day, date, time, kilometres, speed and elevation", () => {
  const t = routeTip({ day: 4, time: "2026-10-21T12:32:10.000Z", cum: 1240.4, spd: 81.6, elev: 411.7 });
  assert.match(t.heading, /^Tag 4 · \w+ 21\.10\. · \d\d:\d\d$/);
  assert.equal(t.values, "km 1.240 · 82 km/h · 412 m");
});

test("routeTip: a short distance with one decimal, standing instead of 0 km/h, missing values are left out", () => {
  assert.equal(routeTip({ cum: 3.26, spd: 0.4, elev: 10 }).values, "km 3,3 · steht · 10 m");
  const empty = routeTip({});
  assert.equal(empty.heading, "");
  assert.equal(empty.values, "");
  assert.equal(routeTip({ time: "broken", cum: 5 }).heading, "");
});

// A road from west to east along latitude 50; out 10:00–10:10, back 15:00–15:10.
const pt = (i, time, extra = {}) => ({ lon: 10 + i * 0.001, lat: 50, time, cum: Math.abs(i), ...extra });
const outward = Array.from({ length: 11 }, (_, i) => pt(i, new Date(Date.UTC(2026, 9, 21, 10, i)).toISOString()));
const back = Array.from({ length: 11 }, (_, i) => pt(10 - i, new Date(Date.UTC(2026, 9, 21, 15, i)).toISOString(), { lat: 50.00002 }));

test("routeHits: one drive gives one hit, only within the tolerance", () => {
  const hits = routeHits(outward, 10.005, 50.0001, 50);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].index, 5);
  assert.ok(hits[0].distanceM < 20);
  assert.deepEqual(routeHits(outward, 10.005, 50.01, 50), []);
  assert.deepEqual(routeHits([], 10, 50, 50), []);
});

test("routeHits: out and back on the same road give two passes in time order", () => {
  const path = [...outward, ...back];
  const hits = routeHits(path, 10.005, 50.00001, 50);
  assert.equal(hits.length, 2);
  assert.ok(hits[0].point.time < hits[1].point.time);
  assert.equal(hits[0].point.time.slice(11, 13), "10");
  assert.equal(hits[1].point.time.slice(11, 13), "15");
  // The way back lies closer to the tap here — it must not push the way out aside.
  assert.ok(hits[1].distanceM < hits[0].distanceM + 5);
});

test("routeHits: a short pause (under 5 minutes) within the tolerance stays one pass, a long radio gap separates", () => {
  const short = [pt(0, "2026-10-21T10:00:00Z"), pt(0.2, "2026-10-21T10:02:00Z"), pt(0.1, "2026-10-21T10:04:00Z")];
  assert.equal(routeHits(short, 10.0001, 50, 60).length, 1);
  const standing = [pt(0, "2026-10-21T16:12:00Z"), pt(0.1, "2026-10-22T11:56:00Z")];
  assert.equal(routeHits(standing, 10.0001, 50, 60).length, 2);
});

test("routeHits: without timestamps a large index distance separates", () => {
  const untimed = (i) => ({ lon: 10, lat: 50, cum: i });
  const path = [...Array.from({ length: 5 }, (_, i) => untimed(i)), ...Array.from({ length: 40 }, () => ({ lon: 11, lat: 51 })), ...Array.from({ length: 5 }, (_, i) => untimed(i))];
  assert.equal(routeHits(path, 10, 50, 50).length, 2);
});

test("sameSpot: distant roads in a large tap area do not count as the same spot", () => {
  // At a wide zoom 3 km of tolerance lie in the tap area: out and back on the same
  // road and a parallel road 2 km further north.
  const parallel = Array.from({ length: 11 }, (_, i) => pt(i, new Date(Date.UTC(2026, 9, 23, 9, i)).toISOString(), { lat: 50.018 }));
  const hits = routeHits([...outward, ...back, ...parallel], 10.005, 50.0005, 3000);
  assert.equal(hits.length, 3);
  const same = sameSpot(hits);
  assert.equal(same.length, 2);
  assert.ok(same.every((t) => t.point.lat < 50.001));
});

test("sameSpot: a single pass stays, several on the same road all stay", () => {
  const one = routeHits(outward, 10.005, 50, 50);
  assert.equal(sameSpot(one).length, 1);
  assert.deepEqual(sameSpot([]), []);
  assert.equal(sameSpot(routeHits([...outward, ...back], 10.005, 50.00001, 50)).length, 2);
});

test("tipEntries: numbered with several passes, beyond the limit only counted", () => {
  const t = (i) => ({ point: { day: i, cum: i, spd: 80, elev: 400, time: `2026-10-2${i}T10:00:00Z` }, index: i, distanceM: i });
  const single = tipEntries([t(1)]);
  assert.equal(single.entries.length, 1);
  assert.equal(single.entries[0].title, "");
  const many = tipEntries([t(1), t(2), t(3), t(4), t(5), t(6), t(7)]);
  assert.equal(many.entries.length, 5);
  assert.equal(many.entries[0].title, "1 von 7");
  assert.equal(many.entries[4].title, "5 von 7");
  assert.equal(many.more, 2);
});

test("nearestHit: picks the one with the smallest distance, an empty list gives null", () => {
  assert.equal(nearestHit([{ distanceM: 9 }, { distanceM: 3 }, { distanceM: 5 }]).distanceM, 3);
  assert.equal(nearestHit([]), null);
});

test("metersPerPixel: halves with every zoom level, smaller towards the north", () => {
  assert.ok(Math.abs(metersPerPixel(10, 0) / metersPerPixel(11, 0) - 2) < 1e-9);
  assert.ok(metersPerPixel(10, 60) < metersPerPixel(10, 0));
});
