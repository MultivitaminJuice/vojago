-- Tagebuch: ein Eintrag je Reise und Kalendertag (Text und Fotos in Reihenfolge),
-- Fotos können jetzt auch an einen Tagebucheintrag gehängt werden.
CREATE TABLE IF NOT EXISTS tagebuch (
  id         TEXT PRIMARY KEY,
  trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  day_key    TEXT NOT NULL,
  blocks     TEXT NOT NULL DEFAULT '[]',
  author     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (trip_id, day_key)
);
ALTER TABLE photos ADD COLUMN tagebuch_id TEXT REFERENCES tagebuch(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS photos_tagebuch ON photos (tagebuch_id);
