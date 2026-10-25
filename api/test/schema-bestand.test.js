// Das Schema läuft beim Start der App auf der BESTEHENDEN Datenbank (app-backend/src/d1-shim.js).
// Dort fehlen neuere Spalten noch — alles, was sie verwendet (Indizes, Ansichten, Trigger),
// muss deshalb lazy nachgeholt werden (siehe ensure*() in api/router.js), nie im Schema selbst.
// Ein Index auf photos.tagebuch_id im Schema legte die App beim ersten Deploy lahm.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const hier = dirname(fileURLToPath(import.meta.url));

for (const datei of ["../schema.sql", "../../db/schema.sql"]) {
  test(`Schema ${datei}: läuft auch auf einer bestehenden Datenbank ohne neuere Spalten`, () => {
    const schema = readFileSync(resolve(hier, datei), "utf8");
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(schema);

    // Zustand vor dem Tagebuch-Update: photos ohne tagebuch_id, keine Tagebuch-Tabelle.
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DROP TABLE photos; DROP TABLE tagebuch;");
    db.exec(`CREATE TABLE photos (
      id TEXT PRIMARY KEY, besuch_id TEXT REFERENCES besuche(id) ON DELETE CASCADE,
      note_id TEXT REFERENCES notes(id) ON DELETE CASCADE, r2_key TEXT NOT NULL, taken_at TEXT,
      lat REAL, lon REAL, width INTEGER, height INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    db.exec("PRAGMA foreign_keys = ON");

    // Der Start der App führt das Schema erneut aus — das darf nicht fehlschlagen.
    assert.doesNotThrow(() => db.exec(schema));
    db.close();
  });
}
