// Eigene Test-Datenbank, damit Tests nie die echte data/tracker.db anfassen.
// TRACKER_DB_PATH muss vor dem (dynamischen) Import von store.js gesetzt
// sein — store.js öffnet die Datenbank beim Laden des Moduls.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

const TEST_DB = `/tmp/vojago-tracker-test-${Date.now()}.db`;
process.env.TRACKER_DB_PATH = TEST_DB;
process.env.TRACKER_ALLOWED_DEVICE_IDS = "test1,test2,test3,test6,erlaubt";

let handleOsmand, db;

before(async () => {
  ({ handleOsmand } = await import("./osmand.js"));
  ({ db } = await import("../store.js"));
});

after(() => {
  db.close();
  rmSync(TEST_DB, { force: true });
  rmSync(`${TEST_DB}-wal`, { force: true });
  rmSync(`${TEST_DB}-shm`, { force: true });
});

const anfrage = (query) => handleOsmand(new Request(`http://localhost/?${query}`));

test("gültige Position wird gespeichert, Knoten werden zu km/h umgerechnet", async () => {
  const res = await anfrage("id=test1&lat=52.1&lon=7.3&timestamp=1700000000&speed=10&bearing=90&altitude=45&sat=8&ignition=true&motion=true");
  assert.equal(res.status, 200);

  const zeile = db.prepare("SELECT * FROM positions WHERE device_id = 'test1'").get();
  assert.equal(zeile.lat, 52.1);
  assert.equal(zeile.lon, 7.3);
  assert.equal(zeile.at, 1700000000 * 1000);
  assert.ok(Math.abs(zeile.speed_kmh - 18.52) < 0.01); // 10 Knoten
  assert.equal(zeile.ignition, 1);
  assert.equal(zeile.motion, 1);
  assert.equal(zeile.protocol, "osmand");
});

test("ignition=false wird als falsch gespeichert (nicht die Boolean('false')-Falle)", async () => {
  const res = await anfrage("id=test2&lat=52.2&lon=7.4&ignition=false&motion=false");
  assert.equal(res.status, 200);

  const zeile = db.prepare("SELECT ignition, motion FROM positions WHERE device_id = 'test2'").get();
  assert.equal(zeile.ignition, 0);
  assert.equal(zeile.motion, 0);
});

test("ohne Zeitstempel wird die Empfangszeit verwendet", async () => {
  const vorher = Date.now();
  const res = await anfrage("id=test3&lat=52.1&lon=7.3");
  assert.equal(res.status, 200);

  const zeile = db.prepare("SELECT at FROM positions WHERE device_id = 'test3'").get();
  assert.ok(zeile.at >= vorher);
});

test("fehlende Pflichtfelder werden abgewiesen", async () => {
  const res = await anfrage("id=test4");
  assert.equal(res.status, 400);
});

test("ungültige Koordinaten werden abgewiesen", async () => {
  const res = await anfrage("id=test5&lat=999&lon=7.3");
  assert.equal(res.status, 400);
});

test("jede Anfrage legt auch ein Rohpaket an", async () => {
  const vorher = db.prepare("SELECT COUNT(*) AS n FROM raw_packets").get().n;
  await anfrage("id=test6&lat=52.1&lon=7.3");
  const nachher = db.prepare("SELECT COUNT(*) AS n FROM raw_packets").get().n;
  assert.equal(nachher, vorher + 1);
});

test("Zulassungsliste: unbekannte OsmAnd-Geräte werden abgewiesen und nicht gespeichert", async () => {
  process.env.TRACKER_ALLOWED_DEVICE_IDS = "erlaubt";
  try {
    const vorher = db.prepare("SELECT COUNT(*) AS n FROM raw_packets").get().n;
    const res = await anfrage("id=fremd&lat=52.1&lon=7.3");
    assert.equal(res.status, 403);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM raw_packets").get().n, vorher);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM positions WHERE device_id = 'fremd'").get().n, 0);
  } finally {
    process.env.TRACKER_ALLOWED_DEVICE_IDS = "test1,test2,test3,test6,erlaubt";
  }
});

test("Zulassungsliste: eingetragene OsmAnd-Geräte werden angenommen", async () => {
  process.env.TRACKER_ALLOWED_DEVICE_IDS = "erlaubt,andere-id";
  try {
    const res = await anfrage("id=erlaubt&lat=52.1&lon=7.3");
    assert.equal(res.status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM positions WHERE device_id = 'erlaubt'").get().n, 1);
  } finally {
    process.env.TRACKER_ALLOWED_DEVICE_IDS = "test1,test2,test3,test6,erlaubt";
  }
});
