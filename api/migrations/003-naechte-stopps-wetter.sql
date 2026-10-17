-- Migration 003 — Übernachtungsdauer, automatische Stopp-Erkennung, Fahrt-Wetter
--
-- Anwenden auf die bestehende Datenbank:
--   npx wrangler d1 execute vojago --remote --file=api/migrations/003-naechte-stopps-wetter.sql
--
-- Neue Tabellen und der Index sind unkritisch (IF NOT EXISTS). Die drei
-- ALTER-Zeilen laufen auf einer bereits migrierten Datenbank auf einen Fehler
-- ("duplicate column") — das ist in Ordnung, dann sind sie schon vorhanden.

ALTER TABLE places ADD COLUMN nights INTEGER NOT NULL DEFAULT 1;
ALTER TABLE places ADD COLUMN stop_key TEXT;
ALTER TABLE drive_assignments ADD COLUMN weather TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS places_stop_key ON places (stop_key) WHERE stop_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS ignored_stops (
  stop_key   TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
