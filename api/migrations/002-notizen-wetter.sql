-- Migration 002 — Notizen, Fahrt-Zuordnungen, Wetter
--
-- Anwenden auf die bestehende Datenbank:
--   npx wrangler d1 execute vojago --remote --file=api/migrations/002-notizen-wetter.sql
--
-- Neue Tabellen sind unkritisch (IF NOT EXISTS). Die drei ALTER-Zeilen laufen
-- auf einer bereits migrierten Datenbank auf einen Fehler („duplicate column")
-- — das ist in Ordnung, dann sind sie schon vorhanden.

CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  trip_id     TEXT REFERENCES trips(id) ON DELETE SET NULL,
  place_id    TEXT REFERENCES places(id) ON DELETE SET NULL,
  text        TEXT NOT NULL,
  occurred_at TEXT,
  lat         REAL,
  lon         REAL,
  source      TEXT NOT NULL DEFAULT 'handy',
  weather     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS notes_trip ON notes (trip_id);
CREATE INDEX IF NOT EXISTS notes_place ON notes (place_id);
CREATE INDEX IF NOT EXISTS notes_time ON notes (occurred_at);

CREATE TABLE IF NOT EXISTS drive_assignments (
  drive_key  TEXT PRIMARY KEY,
  trip_id    TEXT REFERENCES trips(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS drive_assignments_trip ON drive_assignments (trip_id);

ALTER TABLE places ADD COLUMN night INTEGER;
ALTER TABLE places ADD COLUMN weather TEXT;
