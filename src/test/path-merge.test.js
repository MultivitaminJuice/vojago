import test from "node:test";
import assert from "node:assert/strict";
import { appendNewPoints } from "../path-merge.js";

const pt = (min, lon, cum, day = 1) => ({ lon, lat: 50, cum, day, time: new Date(Date.UTC(2026, 9, 18, 10, min)).toISOString() });

test("appendNewPoints: only newer points are appended, the distance carries on", () => {
  const existing = [pt(0, 10.000, 0), pt(1, 10.001, 0.07)];
  // freshly built path (cum from 0): the first point is the one already known (min 1)
  const fresh = [pt(1, 10.001, 0), pt(2, 10.002, 0.07), pt(3, 10.003, 0.14)];
  const r = appendNewPoints(existing, fresh);
  assert.equal(r.length, 4);
  assert.deepEqual(r.map((p) => p.lon), [10.000, 10.001, 10.002, 10.003]);
  assert.ok(r[2].cum > r[1].cum && r[3].cum > r[2].cum, "cum steigt weiter");
  assert.ok(Math.abs(r[3].cum - 0.21) < 0.02, "≈ 3 × 70 m");
  assert.equal(existing.length, 2, "the existing path is not changed");
});

test("appendNewPoints: without anything new the same path comes back", () => {
  const existing = [pt(0, 10, 0), pt(1, 10.001, 0.07)];
  assert.equal(appendNewPoints(existing, [pt(0, 10, 0), pt(1, 10.001, 0)]), existing);
  assert.equal(appendNewPoints(existing, []), existing);
});

test("appendNewPoints: an empty old path takes the new one", () => {
  const fresh = [pt(0, 10, 0)];
  assert.equal(appendNewPoints([], fresh), fresh);
});
