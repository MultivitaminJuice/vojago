-- Benutzerverwaltung: mehrere Konten, die alle dieselben Reisen/Orte/Notizen
-- sehen (keine getrennten Daten je Nutzer). Nur Admins dürfen Konten
-- anlegen/ändern/löschen. Das bisher einzige Konto wird automatisch zum
-- ersten Admin, sonst könnte niemand mehr Konten verwalten.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

UPDATE users SET is_admin = 1
WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1);
