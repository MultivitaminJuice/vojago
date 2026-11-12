import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeRoute } from "../route-wire.js";

test("decodeRoute: compact arrays become position objects", () => {
  const at = Date.UTC(2026, 9, 26, 10, 0, 0);
  const out = decodeRoute({ v: 1, total: 5, points: [[at, 52.1, 8.2, 123.4, 92.6]] });
  assert.equal(out.length, 1);
  assert.equal(out[0].latitude, 52.1);
  assert.equal(out[0].longitude, 8.2);
  assert.equal(out[0].altitude, 123.4);
  assert.ok(Math.abs(out[0].speed * 1.852 - 92.6) < 1e-9);
  assert.equal(out[0].fixTime, "2026-10-26T10:00:00.000Z");
});

test("decodeRoute: the older object list passes through, anything else is empty", () => {
  const alt = [{ latitude: 1, longitude: 2 }];
  assert.equal(decodeRoute(alt), alt);
  assert.deepEqual(decodeRoute(null), []);
  assert.deepEqual(decodeRoute({ error: "x" }), []);
});
