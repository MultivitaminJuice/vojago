-- VOJAĜO — vereinigtes Schema für den selbstgehosteten Zwei-Container-Betrieb
-- (Phase 2). Eine gemeinsame SQLite-Datei (WAL-Modus)
-- für beide Container:
--   app    (Web-App + /api/*, api/router.js über den D1-Shim)
--   ingest (OsmAnd + Teltonika, tracker-backend/src/protocols/*)
--
-- Diese Datei fasst zwei bisher getrennte Quellen zusammen — bewusst per
-- Kopie, nicht per Verweis, damit jeder Container beim Start unabhängig und
-- idempotent (CREATE TABLE IF NOT EXISTS) sein eigenes Schema sicherstellen
-- kann, ohne vom Startzeitpunkt des jeweils anderen Containers abzuhängen:
--
--   1. api/schema.sql        — die App-Tabellen (Cloudflare-D1-Original,
--                               bleibt DORT die Quelle der Wahrheit für den
--                               Cloudflare-Betrieb; Änderungen dort müssen
--                               von Hand hierher übertragen werden)
--   2. tracker-backend/schema.sql — raw_packets/positions (bleibt DORT die
--                               Quelle der Wahrheit für den reinen
--                               Schattenbetrieb ohne app-Container)
--
-- Tabellennamen überschneiden sich nicht — reines Zusammenfügen, keine
-- Konflikte.

-- ── aus api/schema.sql ──────────────────────────────────────────────────
-- Speichert alles, was Traccar NICHT kann: Orte, Reisen, Geofences, Alarm-Konfig.
-- (Positions-Historie liegt in dieser Phase-2-Variante nicht mehr in Traccar,
-- sondern unten in raw_packets/positions —.)

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

-- Fahrten selbst kommen aus der eigenen positions-Tabelle (siehe unten) und
-- werden nicht dupliziert. Hier steht nur, was manuell von der Zeit-Automatik
-- abweicht und was gecacht wird: assignment auto = Zeit-Automatik;
-- manual + trip_id = Reise; manual + NULL = Alltag. kind etappe = normale
-- Reise-Etappe; abstecher = kurze Versorgungsfahrt.
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
-- Die Reise-Zugehörigkeit eines Besuchs wird — wie bei Fahrten
-- (segmentDrives) — NICHT gespeichert, sondern live aus occurred_at gegen
-- die Reise-Zeiträume berechnet (api/lib.js: zugehoerigeReise). Ein
-- Besuch/eine Notiz kennt also keine trip_id-Spalte mehr; legt man
-- rückwirkend eine Reise an, ordnen sich passende Besuche/Notizen beim
-- nächsten Laden automatisch ein, ganz ohne Sonderbehandlung.
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
-- KEIN "CREATE INDEX ... notes (besuch_id)" hier: auf einer bestehenden
-- Installation ist "notes" zu diesem frühen, EAGER ausgeführten Zeitpunkt
-- (D1Shim-Konstruktor, noch vor jeder Anfrage) unter Umständen noch in der
-- alten Form (place_id statt besuch_id) — CREATE TABLE IF NOT EXISTS wäre
-- dann ein No-op, ein CREATE INDEX auf die neue Spalte schlägt fehl und
-- reißt den kompletten restlichen Schema-Aufbau mit (ein Fund vom
-- 18. August 2026: genau das hat den app-Container in eine Neustart-
-- Schleife geschickt). Den Index auf besuch_id legt stattdessen
-- ensureOrteBesuche() in api/router.js an — LAZY, beim ersten Request,
-- NACHDEM die Tabelle nötigenfalls per DROP+CREATE neu geformt wurde.
CREATE INDEX IF NOT EXISTS notes_time ON notes (occurred_at);

-- Fotos: eine gemeinsame Tabelle für Besuche UND Notizen (besuch_id/note_id
-- je nachdem, wovon nie beide gleichzeitig gesetzt sind — ein Foto gehört
-- zum Moment, nicht dauerhaft zum Ort). Die Bilddatei selbst liegt im
-- R2-Shim (lokales Dateisystem, siehe app-backend/src/r2-shim.js), hier nur
-- die Metadaten — r2_key bleibt bewusst so benannt, auch ohne echtes R2,
-- damit api/router.js unverändert bleibt.
-- Tagebuch (Logbuch-Umbau, Oktober 2026): ein Eintrag je Reise und Kalendertag,
-- geschrieben von einem Konto (author). `blocks` ist eine JSON-Liste aus
-- Textabsätzen und Foto-Gruppen in der Reihenfolge, wie sie erzählt werden:
--   [{"t":"text","text":"…"},{"t":"fotos","ids":["foto-id", …]}]
-- day_key ist der Kalendertag in der Ortszeit des Schreibenden (YYYY-MM-DD).
-- Nachträgliches Schreiben ist ausdrücklich vorgesehen (ein Tag später o. ä.).
CREATE TABLE IF NOT EXISTS tagebuch (
  id         TEXT PRIMARY KEY,
  trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  day_key    TEXT NOT NULL,
  blocks     TEXT NOT NULL DEFAULT '[]',
  author     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (trip_id, day_key)
);

CREATE TABLE IF NOT EXISTS photos (
  id         TEXT PRIMARY KEY,
  besuch_id  TEXT REFERENCES besuche(id) ON DELETE CASCADE,
  note_id    TEXT REFERENCES notes(id) ON DELETE CASCADE,
  tagebuch_id TEXT REFERENCES tagebuch(id) ON DELETE CASCADE,
  r2_key     TEXT NOT NULL,
  taken_at   TEXT,                    -- aus EXIF oder Upload-Zeitpunkt
  lat        REAL,                    -- aus EXIF-GPS, falls vorhanden
  lon        REAL,
  width      INTEGER,
  height     INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Kein Index auf besuch_id hier — dieselbe Begründung wie bei notes oben,
-- ensureOrteBesuche() (api/router.js) legt ihn lazy und sicher an.
CREATE INDEX IF NOT EXISTS photos_note ON photos (note_id);
CREATE INDEX IF NOT EXISTS photos_tagebuch ON photos (tagebuch_id);

CREATE TABLE IF NOT EXISTS vehicles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  traccar_device_id TEXT,        -- entspricht jetzt device_id in positions (siehe unten)
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
CREATE TABLE IF NOT EXISTS app_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  data       TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Anmeldung: mehrere Konten möglich, Sitzungen mit Ablauf.
-- In sessions steht nur der Abdruck des Schlüssels, nie der Schlüssel selbst.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  email             TEXT,                -- optional; Voraussetzung für "Passwort vergessen"
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

-- ── aus tracker-backend/schema.sql ──────────────────────────────────────
-- Zwei Tabellen mit bewusst unterschiedlicher Lebensdauer:
--
-- raw_packets: die tatsächlich empfangenen Rohdaten, kurzlebig (z. B. 30
-- Tage, siehe Aufräum-Logik in tracker-backend/src/store.js). Dient nur dazu,
-- einen Parser-Fehler im Nachhinein nachvollziehen/erneut verarbeiten zu
-- können — ist NICHT die dauerhafte Wahrheit.
--
-- positions: die geparsten, normalisierten Positionen, dauerhaft. Bewusst
-- schmal gehalten — nur Felder, die VOJAĜO auch tatsächlich anzeigt oder
-- auswertet. Kein generisches "attributes"-JSON-Sammelfeld wie bei Traccar;
-- jedes neue Feld kommt erst rein, wenn es wirklich gebraucht wird. Ersetzt
-- vollständig eine frühere externe Positions-API als Quelle —
-- vehicles.traccar_device_id (historischer Spaltenname) entspricht device_id hier.

CREATE TABLE IF NOT EXISTS raw_packets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL,      -- IMEI (Teltonika) oder Geräte-Kennung (OsmAnd)
  protocol    TEXT NOT NULL,      -- 'teltonika' | 'osmand'
  received_at INTEGER NOT NULL,   -- Unix-Millisekunden (Empfangszeit, nicht Fix-Zeit)
  payload     BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS raw_packets_received_at ON raw_packets(received_at);

CREATE TABLE IF NOT EXISTS positions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  TEXT NOT NULL,
  at         INTEGER NOT NULL,    -- Unix-Millisekunden, Fix-Zeit vom Gerät
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  speed_kmh  REAL,
  course     REAL,
  altitude   REAL,
  sats       INTEGER,
  ignition   INTEGER,             -- 0/1/NULL
  motion     INTEGER,             -- 0/1/NULL
  protocol   TEXT NOT NULL,       -- 'teltonika' | 'osmand' — zur Fehlersuche hilfreich
  created_at INTEGER NOT NULL     -- Unix-Millisekunden, wann der Datensatz entstand
);
CREATE INDEX IF NOT EXISTS positions_device_at ON positions(device_id, at);
