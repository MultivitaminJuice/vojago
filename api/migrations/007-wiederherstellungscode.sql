-- Migration 007 — Wiederherstellungscode fürs Passwort (N11)
--
-- ÜBERHOLT: Diese Idee wurde noch am selben Tag durch echten E-Mail-Reset
-- ersetzt (siehe Migration 008/009) — ein Wiederherstellungscode ist im
-- Kern "noch ein Passwort zum Verwahren", genau das wollten wir vermeiden.
-- Datei bleibt als historische Spur stehen, nicht mehr ausführen.

ALTER TABLE users ADD COLUMN recovery_code_hash TEXT;
