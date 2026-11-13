import { test } from "node:test";
import assert from "node:assert/strict";
import { routeSignature } from "../map-signature.js";

const pt = (i, extra = {}) => ({ lon: 10 + i / 1000, lat: 50 + i / 1000, time: `2026-10-2${i % 9}T10:00:00Z`, cum: i, ...extra });
const seg = (n) => Array.from({ length: n }, (_, i) => pt(i));
const ctx = { elevMin: 0, elevMax: 100, totalKm: 12.3456, days: 3, hue: 20, rangeMode: false, trips: [] };

test("routeSignature: the same data gives the same fingerprint", () => {
  assert.equal(routeSignature("T", [seg(10)], "day", ctx), routeSignature("T", [seg(10)], "day", { ...ctx }));
});

test("routeSignature: new points, another colouring, another trip or other pieces change it", () => {
  const base = routeSignature("T", [seg(10)], "day", ctx);
  assert.notEqual(base, routeSignature("T", [seg(11)], "day", ctx));
  assert.notEqual(base, routeSignature("T", [seg(10)], "speed", ctx));
  assert.notEqual(base, routeSignature("U", [seg(10)], "day", ctx));
  assert.notEqual(base, routeSignature("T", [seg(5), seg(5)], "day", ctx));
  assert.notEqual(base, routeSignature("T", [seg(10)], "day", { ...ctx, days: 4 }));
  assert.notEqual(base, routeSignature("T", [seg(10)], "day", { ...ctx, totalKm: 50 }));
});
