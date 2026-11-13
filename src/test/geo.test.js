import test from "node:test";
import assert from "node:assert/strict";

import { smoothStandingNoise, distanceKm, simplify } from "../geo.js";

// Seen on 5 September 2026: GPS noise while standing (multipath next to
// buildings) drew a visible loop on a parking lot although the vehicle stood still.

test("smoothStandingNoise: jumping fixes while standing are pulled to one anchor", () => {
  const base = { lon: 6.0, lat: 51.9 };
  const wobble = (dLon, dLat, spd = 0) => ({ lon: base.lon + dLon, lat: base.lat + dLat, elev: 10, spd });
  const points = [
    wobble(0, 0),
    wobble(0.00005, 0.00003), // a few metres of noise
    wobble(-0.00004, 0.00006),
    wobble(0.00003, -0.00004),
  ];
  const smoothed = smoothStandingNoise(points);
  assert.equal(smoothed.length, points.length, "no points disappear");
  for (const p of smoothed) {
    assert.equal(p.lat, smoothed[0].lat);
    assert.equal(p.lon, smoothed[0].lon);
  }
});

test("smoothStandingNoise: real movement stays untouched", () => {
  const points = [
    { lon: 6.0, lat: 51.9, elev: 10, spd: 40 },
    { lon: 6.01, lat: 51.91, elev: 10, spd: 45 },
    { lon: 6.02, lat: 51.92, elev: 10, spd: 42 },
  ];
  assert.deepEqual(smoothStandingNoise(points), points);
});

test("smoothStandingNoise: a real change of place while standing (> radius) sets a new anchor", () => {
  const a = { lon: 6.0, lat: 51.9, elev: 10, spd: 1 };
  // about 50 m away — well above the smoothing radius
  const b = { lon: 6.0006, lat: 51.9, elev: 10, spd: 1 };
  const smoothed = smoothStandingNoise([a, b]);
  assert.equal(smoothed[0].lon, a.lon);
  assert.equal(smoothed[1].lon, b.lon, "a distant fix stays where it is, it is not pulled to the old anchor");
  assert.ok(distanceKm(a.lon, a.lat, b.lon, b.lat) * 1000 > 12);
});

test("simplify: a straight line shrinks to its start and end", () => {
  const line = Array.from({ length: 50 }, (_, i) => ({ lon: 10 + i * 0.0002, lat: 50, cum: i }));
  const r = simplify(line, 3);
  assert.equal(r.length, 2);
  assert.equal(r[0], line[0]);
  assert.equal(r[1], line[49]);
});

test("simplify: a corner stays, and so do the fields of the points", () => {
  const line = [
    { lon: 10.000, lat: 50.000, cum: 0, time: "a" },
    { lon: 10.001, lat: 50.000, cum: 1, time: "b" },
    { lon: 10.002, lat: 50.000, cum: 2, time: "c" },
    { lon: 10.002, lat: 50.001, cum: 3, time: "d" },
    { lon: 10.002, lat: 50.002, cum: 4, time: "e" },
  ];
  const r = simplify(line, 3);
  assert.deepEqual(r.map((p) => p.time), ["a", "c", "e"], "the corner (c) stays, the points in between are dropped");
});

test("simplify: short lines and noise below the tolerance", () => {
  assert.deepEqual(simplify([], 3), []);
  const two = [{ lon: 1, lat: 1 }, { lon: 2, lat: 2 }];
  assert.equal(simplify(two, 3), two);
  // a 1 m sideways outlier is dropped at 3 m tolerance and kept at 0.5 m
  const noisy = [{ lon: 10, lat: 50 }, { lon: 10.0005, lat: 50.00001 }, { lon: 10.001, lat: 50 }];
  assert.equal(simplify(noisy, 3).length, 2);
  assert.equal(simplify(noisy, 0.5).length, 3);
});
