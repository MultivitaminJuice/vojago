import test from "node:test";
import assert from "node:assert/strict";
import { ladeFixture } from "./lade-fixture.js";

test("ladeFixture: FIXTURES=public liefert die eingecheckte, anonymisierte Fassung", () => {
  const vorher = process.env.FIXTURES;
  process.env.FIXTURES = "public";
  try {
    const zeilen = ladeFixture("echte-spaziergaenge-17-08-2026");
    assert.ok(zeilen.length > 1000);
    assert.ok(zeilen.every((z) => z.lat < 0), "Breitengrad gespiegelt (anonymisiert)");
  } finally {
    if (vorher === undefined) delete process.env.FIXTURES; else process.env.FIXTURES = vorher;
  }
});

test("ladeFixture: ohne lokale Datei wird die eingecheckte genommen", () => {
  const zeilen = ladeFixture("echte-uebernachtung-mit-funkluecke-31-08-2026");
  assert.ok(Array.isArray(zeilen) && zeilen.length > 1000);
  assert.deepEqual(Object.keys(zeilen[0]).sort(), ["at", "lat", "lon", "speed_kmh"]);
});
