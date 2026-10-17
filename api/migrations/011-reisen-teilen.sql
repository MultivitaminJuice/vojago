-- Migration 011 — Reisen mit Dritten teilen (schreibgeschützter Link ohne Anmeldung)
CREATE TABLE IF NOT EXISTS trip_shares (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  trip_id      TEXT REFERENCES trips(id) ON DELETE CASCADE,
  scope        TEXT NOT NULL DEFAULT 'karte',
  label        TEXT,
  expires_at   INTEGER,
  revoked_at   INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at INTEGER,
  view_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS trip_shares_trip ON trip_shares (trip_id);
