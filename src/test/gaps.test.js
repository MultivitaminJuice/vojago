import { test } from "node:test";
import assert from "node:assert/strict";
import { findGaps, distanceToSegment, durationText } from "../gaps.js";

const p = (sec, lon, lat = 52) => ({ time: new Date(Date.UTC(2026, 9, 26, 10, 0, sec)).toISOString(), lon, lat });

test("findGaps: a long pause AND a wide jump make a gap", () => {
  // 0.01° longitude at 52° ≈ 685 m
  const l = findGaps([[p(0, 8), p(2, 8.0001), p(98, 8.0141), p(100, 8.0142)]]);
  assert.equal(l.length, 1);
  assert.equal(l[0].seconds, 96);
  assert.ok(l[0].meters > 900 && l[0].meters < 1000);
  assert.equal(l[0].from.lon, 8.0001);
  assert.equal(l[0].to.lon, 8.0141);
});

test("findGaps: normal spacing, a long stand and a short jump do not count", () => {
  assert.deepEqual(findGaps([[p(0, 8), p(3, 8.0004), p(6, 8.0008)]]), []);
  assert.deepEqual(findGaps([[p(0, 8), p(3600, 8.00005)]]), []);          // standing: 1 h, 3 m
  assert.deepEqual(findGaps([[p(0, 8), p(30, 8.02)]]), []);                // 1.4 km, but only 30 s
  assert.deepEqual(findGaps([[p(0, 8), p(60, 8.0050)]]), []);              // 60 s, but only ~340 m
});

test("findGaps: across line pieces; without timestamps no gap", () => {
  const l = findGaps([[p(0, 8), p(5, 8.001)], [p(0, 9), p(120, 9.03)]]);
  assert.equal(l.length, 1);
  assert.equal(l[0].seconds, 120);
  assert.deepEqual(findGaps([[{ lon: 8, lat: 52 }, { lon: 8.05, lat: 52 }]]), []);
  assert.deepEqual(findGaps(null), []);
});

test("distanceToSegment: point beside the middle, beyond the end, on the segment", () => {
  const a = { lon: 8, lat: 52 };
  const b = { lon: 8.02, lat: 52 };
  assert.ok(Math.abs(distanceToSegment(8.01, 52.0009, a, b) - 100) < 2);   // ≈ 0.0009° latitude ≈ 100 m
  assert.ok(Math.abs(distanceToSegment(8.03, 52, a, b) - 685) < 5);        // 0.01° beyond the end
  assert.ok(distanceToSegment(8.005, 52, a, b) < 0.5);
  assert.ok(distanceToSegment(8, 52, a, a) < 0.5);                          // degenerate segment
});

test("durationText", () => {
  assert.equal(durationText(96), "96 s");
  assert.equal(durationText(120), "2 min");
  assert.equal(durationText(205), "3 min 25 s");
});
