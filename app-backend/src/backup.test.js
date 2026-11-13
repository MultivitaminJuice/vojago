// Restore drill: the downloaded archive must unpack with the standard tar
// tool and give back a database with the same rows plus every photo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, writeFileSync as schreibe, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { D1Shim } from "./d1-shim.js";
import { createBackup, tar } from "./backup.js";

test("backup: unpacks with tar and restores database rows and photos", async (t) => {
  const ort = mkdtempSync(join(tmpdir(), "vojago-backup-test-"));
  t.after(() => rmSync(ort, { recursive: true, force: true }));
  const shim = new D1Shim(join(ort, "live.db"));
  shim.prepare("INSERT INTO trips (id, name, start_at) VALUES (?,?,?)").bind("t1", "Test trip", "2026-10-01T08:00:00Z").run();
  shim.prepare("INSERT INTO positions (device_id, at, lat, lon, protocol, created_at) VALUES (?,?,?,?,?,?)").bind("d", 1, 52, 8, "test", 1).run();
  const fotos = join(ort, "fotos");
  mkdirSync(join(fotos, "fotos"), { recursive: true });
  const bild = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
  writeFileSync(join(fotos, "fotos", "a.jpg"), bild);

  const { data, filename, manifest } = await createBackup({ db: shim.db, photosDir: fotos, now: new Date("2026-11-13T10:00:00Z") });
  assert.equal(filename, "vojago-backup-2026-11-13.tar.gz");
  assert.equal(manifest.photos, 1);
  assert.equal(manifest.counts.trips, 1);

  const ziel = join(ort, "restore");
  mkdirSync(ziel);
  schreibe(join(ort, filename), data);
  execFileSync("tar", ["-xzf", join(ort, filename), "-C", ziel]);
  const zurueck = new Database(join(ziel, "vojago.db"), { readonly: true });
  assert.equal(zurueck.prepare("SELECT name FROM trips WHERE id = 't1'").get().name, "Test trip");
  assert.equal(zurueck.prepare("SELECT COUNT(*) AS n FROM positions").get().n, 1);
  zurueck.close();
  assert.deepEqual(readFileSync(join(ziel, "fotos", "fotos", "a.jpg")), bild);
  assert.equal(JSON.parse(readFileSync(join(ziel, "manifest.json"), "utf8")).format, "vojago-backup");
  shim.close();
});

test("tar: long paths use the prefix field, sizes are padded to 512 bytes", () => {
  const lang = `${"a".repeat(80)}/${"b".repeat(60)}.jpg`;
  const out = tar([{ name: lang, data: Buffer.from("x") }]);
  assert.equal(out.length % 512, 0);
  assert.equal(out.length, 512 + 512 + 1024);
});
