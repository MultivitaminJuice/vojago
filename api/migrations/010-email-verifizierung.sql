-- Migration 010 — E-Mail-Bestätigung bei Registrierung (N11-Fortsetzung)
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;

CREATE TABLE IF NOT EXISTS email_verifications (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Wer schon eine E-Mail hinterlegt hat, hat sie faktisch bewiesen (der
-- Reset-Versand kam ja an) — deshalb rückwirkend als bestätigt einstufen,
-- statt bestehende Konten auszusperren.
UPDATE users SET email_verified_at = CAST(strftime('%s','now') AS INTEGER) * 1000
  WHERE email IS NOT NULL AND email_verified_at IS NULL;
