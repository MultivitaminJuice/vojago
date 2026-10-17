-- Migration 008 — Wiederherstellungscode (Migration 007) rückgängig gemacht
--
-- Anwenden auf die bestehende Datenbank:
--   npx wrangler d1 execute vojago --remote --file=api/migrations/008-wiederherstellungscode-entfernt.sql
--
-- D1/SQLite unterstützt DROP COLUMN (SQLite ≥ 3.35). Läuft die Zeile ins
-- Leere, weil die Spalte schon fehlt, bricht sie mit "no such column" ab —
-- dann ist nichts zu tun.

ALTER TABLE users DROP COLUMN recovery_code_hash;
