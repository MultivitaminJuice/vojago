import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

const TEST_DB = `/tmp/vojago-tracker-allowlist-test-${Date.now()}.db`;
process.env.TRACKER_DB_PATH = TEST_DB;

let db, parseAllowedDeviceIds, isDeviceAllowed, setLearningUntil;

before(async () => {
  ({ db } = await import("./store.js"));
  ({ parseAllowedDeviceIds, isDeviceAllowed, setLearningUntil } = await import("./device-allowlist.js"));
});

after(() => {
  db.close();
  rmSync(TEST_DB, { force: true });
  rmSync(`${TEST_DB}-wal`, { force: true });
  rmSync(`${TEST_DB}-shm`, { force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM vehicles; DELETE FROM known_devices; DELETE FROM ingest_settings;");
  delete process.env.TRACKER_ALLOWED_DEVICE_IDS;
});

test("parseAllowedDeviceIds: Kommas, Leerraum und leere Einträge werden bereinigt", () => {
  assert.deepEqual([...parseAllowedDeviceIds(" abc,def\n  ghi  ,, ")], ["abc", "def", "ghi"]);
});

test("isDeviceAllowed: unbekannte Geräte werden standardmäßig abgewiesen und gemerkt", () => {
  assert.equal(isDeviceAllowed("beliebig", { allowed: parseAllowedDeviceIds(""), protocol: "test" }), false);
  const row = db.prepare("SELECT * FROM known_devices WHERE device_id = 'beliebig'").get();
  assert.equal(row.accepted, 0);
  assert.equal(row.protocol, "test");
});

test("isDeviceAllowed: gesetzte Liste lässt nur exakte Geräte-IDs zu", () => {
  const allowed = parseAllowedDeviceIds("abc,def");
  assert.equal(isDeviceAllowed("abc", { allowed }), true);
  assert.equal(isDeviceAllowed(" def ", { allowed }), true);
  assert.equal(isDeviceAllowed("xyz", { allowed }), false);
});

test("isDeviceAllowed: Geräte-ID eines Fahrzeugs ist zugelassen", () => {
  db.prepare("INSERT INTO vehicles (id, name, traccar_device_id, active) VALUES ('v1', 'Camper', 'imei-1', 1)").run();
  assert.equal(isDeviceAllowed("imei-1"), true);
});

test("isDeviceAllowed: Lernmodus nimmt unbekannte Geräte kurzzeitig an", () => {
  setLearningUntil(Date.now() + 60000);
  assert.equal(isDeviceAllowed("neu", { protocol: "osmand" }), true);
  const row = db.prepare("SELECT * FROM known_devices WHERE device_id = 'neu'").get();
  assert.equal(row.accepted, 0);
  assert.equal(row.protocol, "osmand");
});
