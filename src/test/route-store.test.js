import { test } from "node:test";
import assert from "node:assert/strict";
import { packPath, unpackPath, routeKey, readRoute, writeRoute } from "../route-store.js";

test("packPath/unpackPath: a path survives the round trip", () => {
  const path = [
    { lon: 8.1, lat: 52.2, elev: 100.5, spd: 0, time: "2026-10-26T10:00:00.000Z", day: 1, cum: 0 },
    { lon: 8.2, lat: 52.3, elev: 101, spd: 88.4, time: "2026-10-27T10:00:01.000Z", day: 2, cum: 13.1 },
  ];
  const zurueck = unpackPath(JSON.parse(JSON.stringify(packPath(path))));
  assert.deepEqual(zurueck.map(({ day, ...p }) => p), path.map(({ day, ...p }) => p));
});

test("routeKey: trip, device and range; an open trip is marked", () => {
  assert.equal(routeKey({ id: "t1", range: { from: "a", to: "b" } }, "dev"), "t1|dev|a|b");
  assert.equal(routeKey({ id: "t1", range: { from: "a", to: null } }, "dev"), "t1|dev|a|offen");
});

test("without IndexedDB the store answers null instead of failing", async () => {
  assert.equal(await readRoute("x"), null);
  assert.equal(await writeRoute("x", { rows: [] }), null);
});
