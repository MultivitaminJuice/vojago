-- VOJAĜO — D1-Schema
-- Speichert alles, was Traccar NICHT kann: Orte, Reisen, Geofences, Alarm-Konfig.
-- Positionen/Fahrten bleiben in Traccar und werden per API geholt (nicht dupliziert).

CREATE TABLE IF NOT EXISTS trips (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  start_at    TEXT NOT NULL,            -- ISO 8601
  end_at      TEXT,                     -- NULL = laufende Reise
  vehicle_id  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- Hilfsspalte für die Regel unten: 1 bei laufender Reise, sonst NULL.
  -- (Ein Unique-Index direkt auf end_at greift nicht, weil SQLite NULLs als
  --  voneinander verschieden behandelt — mehrere offene Reisen wären möglich.)
  is_active   INTEGER GENERATED ALWAYS AS (CASE WHEN end_at IS NULL THEN 1 END) VIRTUAL
);
-- Höchstens eine laufende Reise:
CREATE UNIQUE INDEX IF NOT EXISTS trips_one_active ON trips (is_active);
CREATE INDEX IF NOT EXISTS trips_start ON trips (start_at);

-- Fahrten selbst liegen in Traccar und werden nicht dupliziert. Hier steht nur,
-- was manuell von der Zeit-Automatik abweicht und was gecacht wird:
-- assignment auto = Zeit-Automatik; manual + trip_id = Reise; manual + NULL = Alltag.
-- kind etappe = normale Reise-Etappe; abstecher = kurze Versorgungsfahrt.
CREATE TABLE IF NOT EXISTS drive_assignments (
  drive_key  TEXT PRIMARY KEY,       -- Geräte-ID + '|' + Startzeit der Fahrt
  trip_id    TEXT REFERENCES trips(id) ON DELETE CASCADE,
  assignment TEXT NOT NULL DEFAULT 'auto' CHECK (assignment IN ('auto', 'manual')),
  kind       TEXT NOT NULL DEFAULT 'etappe' CHECK (kind IN ('etappe', 'abstecher')),
  weather    TEXT,                   -- Wetter am Startpunkt der Fahrt (JSON, Zwischenspeicher)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS drive_assignments_trip ON drive_assignments (trip_id);

CREATE TABLE IF NOT EXISTS categories (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  color   TEXT NOT NULL,
  sort    INTEGER NOT NULL DEFAULT 0
);

-- Orte/Besuche (18. August 2026, Umbau): ein Ort ist ein wiederverwendbarer
-- Katalogeintrag (derselbe Stellplatz, über beliebig viele Reisen hinweg),
-- ein Besuch ist ein einzelner Aufenthalt dort. Vorher war das in einer
-- einzigen "places"-Zeile verschmolzen — zwei Besuche desselben Stellplatzes
-- auf zwei Reisen waren zwei unverknüpfte Zeilen, "wie oft war ich hier"
-- ließ sich nur über Koordinaten-Nähe raten. Jetzt: echte Identität über
-- ort_id, exakt zählbar.
--
-- Die Reise-Zugehörigkeit eines Besuchs wird — wie bei Fahrten — NICHT
-- gespeichert, sondern live aus occurred_at gegen die Reise-Zeiträume
-- berechnet. Ein Besuch/eine Notiz kennt also keine trip_id-Spalte mehr;
-- legt man rückwirkend eine Reise an, ordnen sich passende Besuche/Notizen
-- beim nächsten Laden automatisch ein, ganz ohne Sonderbehandlung.
CREATE TABLE IF NOT EXISTS orte (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  -- Vom Reverse-Geocoding ermittelte Adresse, getrennt vom (überschreib-
  -- baren) Titel — ein umbenannter Ort verliert so nicht seine ursprüng-
  -- liche Adresse (Nutzerwunsch, 6. September 2026).
  address      TEXT,
  note         TEXT,
  category_id  TEXT REFERENCES categories(id),
  rating       INTEGER CHECK (rating BETWEEN 0 AND 5),
  lat          REAL NOT NULL,
  lon          REAL NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS orte_cat ON orte (category_id);
CREATE INDEX IF NOT EXISTS orte_geo ON orte (lat, lon);

CREATE TABLE IF NOT EXISTS besuche (
  id           TEXT PRIMARY KEY,
  ort_id       TEXT NOT NULL REFERENCES orte(id) ON DELETE CASCADE,
  source       TEXT NOT NULL DEFAULT 'manuell',  -- camper | handy | manuell
  kind         TEXT NOT NULL DEFAULT 'manual',   -- manual | auto (automatisch erkannte Übernachtung)
  occurred_at  TEXT,                              -- Zeitpunkt/Nacht des Aufenthalts
  nights       INTEGER NOT NULL DEFAULT 1,        -- Anzahl der Nächte bei diesem Besuch
  weather      TEXT,                              -- Wetter zum Zeitpunkt (JSON)
  -- Herkunft: die tatsächliche Geräte-ID der Positionsdaten (nicht die
  -- AKTUELL im Fahrzeug konfigurierte) + Startzeit des erkannten Stopps.
  -- Bewusst von der editierbaren Fahrzeug-Geräte-ID entkoppelt — sonst
  -- würde ein Umbenennen der Geräte-ID in den Einstellungen den stop_key
  -- alter Besuche unauffindbar machen (dieselbe Falle wie früher bei
  -- drive_assignments.drive_key, siehe dort).
  stop_key     TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS besuche_ort  ON besuche (ort_id);
CREATE INDEX IF NOT EXISTS besuche_time ON besuche (occurred_at);
-- Ein Stopp wird höchstens einmal automatisch übernommen.
CREATE UNIQUE INDEX IF NOT EXISTS besuche_stop_key ON besuche (stop_key) WHERE stop_key IS NOT NULL;

-- Vom Nutzer verworfene automatische Übernachtungsvorschläge. Ohne diese
-- Liste würde ein gelöschter Vorschlag beim nächsten Laden wieder auftauchen.
CREATE TABLE IF NOT EXISTS ignored_stops (
  stop_key   TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Notizen des Reisetagebuchs. Wahlweise an einen Besuch gehängt (dieser eine
-- Aufenthalt, nicht der Ort dauerhaft — eine Notiz beschreibt einen Moment,
-- kein bleibendes Ort-Merkmal); Standort/Zeitpunkt hält die App beim
-- Erfassen selbst fest. Reise-Zugehörigkeit wird wie bei Besuchen live aus
-- occurred_at berechnet, keine trip_id-Spalte mehr.
CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  besuch_id   TEXT REFERENCES besuche(id) ON DELETE SET NULL,
  title       TEXT NOT NULL DEFAULT '',
  text        TEXT NOT NULL,
  occurred_at TEXT,
  lat         REAL,
  lon         REAL,
  source      TEXT NOT NULL DEFAULT 'handy',
  weather     TEXT,                            -- Wetter zum Zeitpunkt (JSON)
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Kein Index auf besuch_id hier — siehe db/schema.sql für die Begründung
-- (auf einer bestehenden Installation kann notes zu diesem eager
-- ausgeführten Zeitpunkt noch die alte Form haben; ensureOrteBesuche() in
-- api/router.js legt den Index lazy und sicher NACH der Migration an).
CREATE INDEX IF NOT EXISTS notes_time ON notes (occurred_at);

-- Fotos: eine gemeinsame Tabelle für Besuche UND Notizen (besuch_id/note_id
-- je nachdem, wovon nie beide gleichzeitig gesetzt sind — ein Foto gehört
-- zum Moment, nicht dauerhaft zum Ort) statt zweier getrennter Tabellen.
-- Die Bilddatei selbst liegt in R2 (r2_key), hier nur die Metadaten.
CREATE TABLE IF NOT EXISTS photos (
  id         TEXT PRIMARY KEY,
  besuch_id  TEXT REFERENCES besuche(id) ON DELETE CASCADE,
  note_id    TEXT REFERENCES notes(id) ON DELETE CASCADE,
  r2_key     TEXT NOT NULL,
  taken_at   TEXT,                    -- aus EXIF oder Upload-Zeitpunkt
  lat        REAL,                    -- aus EXIF-GPS, falls vorhanden
  lon        REAL,
  width      INTEGER,
  height     INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Kein Index auf besuch_id hier — siehe db/schema.sql für die Begründung.
CREATE INDEX IF NOT EXISTS photos_note ON photos (note_id);

CREATE TABLE IF NOT EXISTS vehicles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  traccar_device_id TEXT,        -- Bezeichner/ID des Geräts in Traccar
  active       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ingest_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS known_devices (
  device_id  TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  protocol   TEXT,
  accepted   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS known_devices_last_seen ON known_devices(last_seen DESC);

CREATE TABLE IF NOT EXISTS geofences (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  lat       REAL NOT NULL,
  lon       REAL NOT NULL,
  radius_m  INTEGER NOT NULL,
  active    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS alarm_settings (
  key       TEXT PRIMARY KEY,    -- motion | geofence | undervoltage | powercut | speeding
  enabled   INTEGER NOT NULL DEFAULT 1,
  threshold REAL                 -- z. B. 12.0 (Volt) oder 120 (km/h)
);

CREATE TABLE IF NOT EXISTS alarm_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'warn',   -- ok | warn | crit
  message     TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS alarm_log_time ON alarm_log (occurred_at DESC);

-- Web-Push-Abos: ein Datensatz je Gerät/Browser, das Benachrichtigungen
-- erhalten will (persönliche Einstellung, nicht an eine gemeinsame
-- Konfiguration gebunden — jeder meldet sein eigenes Gerät an). Der
-- eigentliche Versand beim Zonen-Wechsel passiert im ingest-Container
-- (tracker-backend/src/alarms.js), der diese Tabelle über dasselbe
-- geteilte SQLite-Volume mitliest — hier nur Verwaltung (anlegen/löschen).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Startwerte
-- "INSERT OR IGNORE" allein reicht nicht: das schützt zwar vorhandene
-- Zeilen, bringt aber eine vom Menschen GELÖSCHTE Standard-Kategorie bei
-- jedem erneuten Ausführen dieses Skripts (bei uns: bei jedem
-- Container-Neustart, siehe d1-shim.js) zurück, weil ihre ID dann nicht
-- mehr existiert. "WHERE NOT EXISTS" macht daraus ein echtes Einmal-
-- Seeding: nur eine WIRKLICH leere Tabelle (frische Installation) bekommt
-- die Vorgaben, jede spätere Löschung bleibt bestehen. Echter Fund,
-- 6. September 2026: eine auf 3 Kategorien reduzierte Liste kam nach dem
-- nächsten Deploy vollständig zurück.
INSERT INTO categories (id, name, color, sort)
SELECT * FROM (VALUES
  ('uebernachtung',    'Übernachtung',     '#4b47a8', 10),
  ('stopp',            'Stopp',            '#6b7280', 15),
  ('stellplatz',       'Stellplatz',       '#e8802b', 20),
  ('wild',             'Wildcamping',      '#3f9d5a', 30),
  ('versorgung',       'Ver-/Entsorgung',  '#3b82c4', 40),
  ('aussicht',         'Aussicht',         '#7a5cd6', 50),
  ('restaurant',       'Restaurant',       '#b5476b', 60),
  ('sehenswuerdigkeit','Sehenswürdigkeit', '#caa23a', 70),
  ('werkstatt',        'Werkstatt',        '#d84a4a', 80),
  ('einkauf',          'Einkauf',          '#1f9e8f', 90)
)
WHERE NOT EXISTS (SELECT 1 FROM categories);

INSERT OR IGNORE INTO alarm_settings (key, enabled, threshold) VALUES
  ('motion',       1, NULL),
  ('geofence',     1, NULL),
  ('undervoltage', 1, 12.0),
  ('powercut',     1, NULL),
  ('speeding',     0, 120);

-- Geräteübergreifende Einstellungen (ein Datensatz, JSON-Inhalt).
-- Nicht enthalten: API-Adresse und Token — die sind der Schlüssel zu dieser
-- Ablage und müssen deshalb auf dem Gerät liegen.
CREATE TABLE IF NOT EXISTS app_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  data       TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);


-- Anmeldung: genau ein Konto (erweiterbar), Sitzungen mit Ablauf.
-- In sessions steht nur der Abdruck des Schlüssels, nie der Schlüssel selbst.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  email             TEXT,                -- optional; Voraussetzung für "Passwort vergessen" (N11)
  email_verified_at INTEGER,              -- NULL = unbestätigt; erst bestätigt zählt für den Reset-Versand
  -- Benutzerverwaltung: alle Konten sehen dieselben Reisen/Orte/Notizen (keine
  -- getrennten Daten je Nutzer), nur Admins dürfen Konten anlegen/ändern/löschen.
  is_admin          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);

-- Reset-Links: kurzlebig, ein Eintrag je aktivem Link. In der Datenbank
-- steht nur der Abdruck des Tokens, nie der Wert selbst (wie bei sessions).
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- E-Mail-Bestätigung: wie password_resets, trägt aber zusätzlich die
-- Adresse, für die der Link ausgestellt wurde — ändert sich die E-Mail
-- währenddessen erneut, bestätigt ein alter Link nicht versehentlich die
-- neue.
CREATE TABLE IF NOT EXISTS email_verifications (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Reisen mit Dritten teilen: schreibgeschützter, öffentlicher Link ohne
-- Anmeldung. `id` ist die "Verwaltungs-Kennung" (Liste/Widerruf durch den
-- Besitzer). `token` steht bewusst im Klartext (anders als bei
-- sessions/password_resets/email_verifications!) — der Besitzer muss den
-- Link jederzeit erneut herausgeben können, ohne ihn neu zu erzeugen; anders
-- als ein Passwort ist er kein Geheimnis gegenüber dem eigenen Account,
-- sondern genau dafür gedacht, weitergegeben zu werden. `token_hash` bleibt
-- zusätzlich für die schnelle Suche beim öffentlichen Abruf.
-- trip_id = NULL bedeutet "alle Reisen" statt einer einzelnen.
CREATE TABLE IF NOT EXISTS trip_shares (
  id           TEXT PRIMARY KEY,
  token        TEXT,                           -- Klartext, für "erneut kopieren"
  token_hash   TEXT NOT NULL UNIQUE,
  trip_id      TEXT REFERENCES trips(id) ON DELETE CASCADE,
  scope        TEXT NOT NULL DEFAULT 'karte',   -- karte | karte_logbuch
  label        TEXT,                            -- freier Vermerk, z. B. "für Oma"
  expires_at   INTEGER,                         -- NULL = kein Ablauf (bewusst gewählt)
  revoked_at   INTEGER,                         -- Widerruf statt Löschen: Nachvollziehbarkeit
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at INTEGER,
  view_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS trip_shares_trip ON trip_shares (trip_id);
