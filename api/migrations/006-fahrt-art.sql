-- Migration 006 — Fahrtart für Etappen und Abstecher
--
-- Fahrten selbst bleiben in Traccar. VOJAGO merkt hier nur die fachliche
-- Einordnung: normale Reise-Etappe oder kurzer Abstecher/Versorgungsfahrt.

ALTER TABLE drive_assignments
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'etappe'
  CHECK (kind IN ('etappe', 'abstecher'));
