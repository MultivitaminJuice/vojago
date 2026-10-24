import { test } from "node:test";
import assert from "node:assert/strict";
import { routenSignatur } from "../map-signature.js";

const pkt = (i, extra = {}) => ({ lon: 10 + i / 1000, lat: 50 + i / 1000, time: `2026-10-2${i % 9}T10:00:00Z`, cum: i, ...extra });
const seg = (n) => Array.from({ length: n }, (_, i) => pkt(i));
const ctx = { elevMin: 0, elevMax: 100, totalKm: 12.3456, days: 3, hue: 20, rangeMode: false, trips: [] };

test("routenSignatur: gleiche Daten ergeben denselben Fingerabdruck", () => {
  assert.equal(routenSignatur("T", [seg(10)], "day", ctx), routenSignatur("T", [seg(10)], "day", { ...ctx }));
});

test("routenSignatur: neue Punkte, andere Darstellung, andere Reise oder andere Stücke verändern ihn", () => {
  const basis = routenSignatur("T", [seg(10)], "day", ctx);
  assert.notEqual(basis, routenSignatur("T", [seg(11)], "day", ctx));
  assert.notEqual(basis, routenSignatur("T", [seg(10)], "speed", ctx));
  assert.notEqual(basis, routenSignatur("U", [seg(10)], "day", ctx));
  assert.notEqual(basis, routenSignatur("T", [seg(5), seg(5)], "day", ctx));
  assert.notEqual(basis, routenSignatur("T", [seg(10)], "day", { ...ctx, days: 4 }));
  assert.notEqual(basis, routenSignatur("T", [seg(10)], "day", { ...ctx, totalKm: 50 }));
});
