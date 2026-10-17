-- Migration 013 — Fotos zu Orten und Notizen (Speicher: Cloudflare R2)
--
-- Ersetzt die nie angebundene place_photos (nur Orte) durch eine
-- gemeinsame photos-Tabelle für Orte UND Notizen. place_photos war leer
-- (nie verwendet), das Löschen verliert also keine Daten.
DROP TABLE IF EXISTS place_photos;

CREATE TABLE IF NOT EXISTS photos (
  id         TEXT PRIMARY KEY,
  trip_id    TEXT REFERENCES trips(id) ON DELETE CASCADE,
  place_id   TEXT REFERENCES places(id) ON DELETE CASCADE,
  note_id    TEXT REFERENCES notes(id) ON DELETE CASCADE,
  r2_key     TEXT NOT NULL,
  taken_at   TEXT,
  lat        REAL,
  lon        REAL,
  width      INTEGER,
  height     INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS photos_trip ON photos (trip_id);
CREATE INDEX IF NOT EXISTS photos_place ON photos (place_id);
CREATE INDEX IF NOT EXISTS photos_note ON photos (note_id);
