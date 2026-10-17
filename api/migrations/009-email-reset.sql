-- Migration 009 — Passwort per E-Mail zurücksetzen (N11, zweiter Anlauf)
--
-- Anwenden auf die bestehende Datenbank:
--   npx wrangler d1 execute vojago --remote --file=api/migrations/009-email-reset.sql
--
-- Der Worker legt Spalte/Tabelle bei Bedarf auch selbst an (ensureEmailReset
-- in api/router.js, nach dem Vorbild von ensureDriveAssignmentMode) — diese
-- Datei ist trotzdem die dokumentierte, nachvollziehbare Quelle der Wahrheit.
-- Die ALTER-Zeile läuft auf einer bereits migrierten Datenbank auf einen
-- Fehler ("duplicate column name") — das ist in Ordnung, dann ist sie schon da.

ALTER TABLE users ADD COLUMN email TEXT;

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
