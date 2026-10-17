-- Migration 004 — Fahrt-Zuordnung von Wetter-Cache trennen
--
-- Vorher konnte eine Zeile in drive_assignments zwei Dinge bedeuten:
-- 1. manuell als Alltagsfahrt markiert
-- 2. nur Wetter zwischengespeichert
--
-- Beides hatte trip_id NULL. Dadurch wurden wettergecachte Fahrten dauerhaft
-- als Alltagsfahrten gelesen und nicht mehr automatisch einer laufenden Reise
-- zugeordnet.

ALTER TABLE drive_assignments ADD COLUMN assignment TEXT NOT NULL DEFAULT 'auto';

UPDATE drive_assignments
SET assignment = CASE WHEN trip_id IS NULL THEN 'auto' ELSE 'manual' END;
