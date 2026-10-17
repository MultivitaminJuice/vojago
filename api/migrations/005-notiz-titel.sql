-- Migration 005 — Titel für Reisetagebuch-Notizen
--
-- Notizen bekommen einen kurzen Pflicht-Titel. Bestehende Notizen werden
-- rückwirkend aus dem Anfang ihres Texts benannt.

ALTER TABLE notes ADD COLUMN title TEXT NOT NULL DEFAULT '';

UPDATE notes
SET title = COALESCE(NULLIF(TRIM(SUBSTR(text, 1, 48)), ''), 'Notiz')
WHERE title = '';
