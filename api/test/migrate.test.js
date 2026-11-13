import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { migrate, schemaVersion, MIGRATIONS } from "../../db/migrate.js";

const schemaSql = readFileSync(new URL("../../db/schema.sql", import.meta.url), "utf8");
const spalten = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);

test("migrate: a fresh database ends at the newest version without changes to its shape", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(schemaSql);
  const vorher = db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
  assert.deepEqual(migrate(db, { schemaSql }), MIGRATIONS.map((m) => m.version));
  assert.equal(schemaVersion(db), MIGRATIONS.at(-1).version);
  const nachher = db.prepare("SELECT sql FROM sqlite_master WHERE name != 'photos_tagebuch' ORDER BY name").all();
  assert.deepEqual(nachher, vorher.filter((r) => !/photos_tagebuch/.test(r.sql || "")));
  assert.deepEqual(migrate(db, { schemaSql }), []);
});

test("migrate 1: an old database gets the columns the API used to add on requests", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(schemaSql);
  db.exec("PRAGMA foreign_keys = OFF");
  // Shapes from before the lazy additions
  db.exec("DROP TABLE users; CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  db.exec("DROP TABLE drive_assignments; CREATE TABLE drive_assignments (drive_key TEXT PRIMARY KEY, trip_id TEXT, updated_at TEXT)");
  db.exec("INSERT INTO drive_assignments (drive_key, trip_id) VALUES ('a', 't1'), ('b', NULL)");
  db.exec("DROP TABLE trip_shares; CREATE TABLE trip_shares (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, trip_id TEXT, scope TEXT NOT NULL DEFAULT 'karte', label TEXT, expires_at INTEGER, revoked_at INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at INTEGER, view_count INTEGER NOT NULL DEFAULT 0)");
  db.exec("CREATE TABLE places (id TEXT PRIMARY KEY)");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(schemaSql); // container start: schema first …
  assert.deepEqual(migrate(db, { schemaSql }), [1]); // … then the migrations

  for (const s of ["email", "email_verified_at", "is_admin"]) assert.ok(spalten(db, "users").includes(s), s);
  assert.ok(spalten(db, "trip_shares").includes("token"));
  assert.ok(spalten(db, "drive_assignments").includes("kind"));
  assert.deepEqual(db.prepare("SELECT drive_key, assignment FROM drive_assignments ORDER BY drive_key").all().map((r) => ({ ...r })),
    [{ drive_key: "a", assignment: "manual" }, { drive_key: "b", assignment: "auto" }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'places'").get().n, 0);
});

test("migrate: a failing migration leaves version and data untouched", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE x (a INTEGER)");
  const kaputt = [{ version: 1, name: "fails", up(d) { d.exec("INSERT INTO x VALUES (1)"); throw new Error("boom"); } }];
  assert.throws(() => migrate(db, { schemaSql: "", migrations: kaputt }), /boom/);
  assert.equal(schemaVersion(db), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM x").get().n, 0);
});
