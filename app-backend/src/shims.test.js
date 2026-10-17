// Eigene Tests für die Shims selbst (nicht für api/router.js — das prüft
// bereits api/test/router.integration.test.js gegen D1Memory, unverändert).
// Hier geht es nur darum, dass D1Shim/R2Shim die erwartete Fassade korrekt
// gegen echte Dateien erfüllen.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { D1Shim } from "./d1-shim.js";
import { R2Shim } from "./r2-shim.js";

test("D1Shim: Startwerte aus db/schema.sql sind nach dem Öffnen da", () => {
  const dir = mkdtempSync(join(tmpdir(), "d1shim-"));
  const db = new D1Shim(join(dir, "test.db"));
  const { results } = db.prepare("SELECT COUNT(*) AS n FROM categories").all();
  assert.equal(results[0].n, 10); // die zehn Standardkategorien aus db/schema.sql
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("D1Shim: bind().run()/.all() entsprechen der D1-Fassade (success/meta/results)", () => {
  const dir = mkdtempSync(join(tmpdir(), "d1shim-"));
  const db = new D1Shim(join(dir, "test.db"));
  const insert = db.prepare("INSERT INTO categories (id, name, color, sort) VALUES (?,?,?,?)")
    .bind("neu", "Neu", "#000000", 100).run();
  assert.equal(insert.success, true);
  assert.equal(insert.meta.changes, 1);

  const { results } = db.prepare("SELECT name FROM categories WHERE id = ?").bind("neu").all();
  assert.deepEqual(results, [{ name: "Neu" }]);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("D1Shim: undefined als Bind-Wert wird auf null abgebildet, nicht geworfen", () => {
  const dir = mkdtempSync(join(tmpdir(), "d1shim-"));
  const db = new D1Shim(join(dir, "test.db"));
  // resolved_at ist eine nullbare Spalte (alarm_log) — hier zeigt sich der
  // Unterschied zwischen "undefined würde better-sqlite3 direkt zum Werfen
  // bringen" und "der Shim fängt das vorher ab und macht daraus NULL".
  assert.doesNotThrow(() => {
    db.prepare("INSERT INTO alarm_log (type, resolved_at) VALUES (?,?)")
      .bind("test", undefined).run();
  });
  const { results } = db.prepare("SELECT resolved_at FROM alarm_log WHERE type = ?").bind("test").all();
  assert.equal(results[0].resolved_at, null);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("R2Shim: put/get/delete-Rundlauf, Content-Type aus Dateiendung", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r2shim-"));
  const r2 = new R2Shim(dir);
  await r2.put("fotos/abc.png", Buffer.from("bilddaten"));
  const obj = await r2.get("fotos/abc.png");
  assert.equal(obj.body.toString(), "bilddaten");
  assert.equal(obj.httpMetadata.contentType, "image/png");
  await r2.delete("fotos/abc.png");
  assert.equal(await r2.get("fotos/abc.png"), null);
  rmSync(dir, { recursive: true, force: true });
});

test("R2Shim: Schlüssel mit Pfadausbruch wird abgelehnt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r2shim-"));
  const r2 = new R2Shim(dir);
  await assert.rejects(() => r2.get("../../../etc/passwd"));
  rmSync(dir, { recursive: true, force: true });
});
