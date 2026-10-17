-- VOJAĜO Tracker-Backend — eigene, schlanke Datenhaltung.
--
-- Zwei Tabellen mit bewusst unterschiedlicher Lebensdauer:
--
-- raw_packets: die tatsächlich empfangenen Rohdaten, kurzlebig (z. B. 30
-- Tage, siehe Aufräum-Logik in store.js). Dient nur dazu, einen Parser-Fehler
-- im Nachhinein nachvollziehen/erneut verarbeiten zu können — ist NICHT die
-- dauerhafte Wahrheit, das wäre das Gegenteil von "schlank".
--
-- positions: die geparsten, normalisierten Positionen, dauerhaft. Bewusst
-- schmal gehalten — nur Felder, die VOJAĜO auch tatsächlich anzeigt oder
-- auswertet. Kein generisches "attributes"-JSON-Sammelfeld wie bei Traccar;
-- jedes neue Feld kommt erst rein, wenn es wirklich gebraucht wird.

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

-- Fahrzeug-Zuordnung und Ingest-Lernmodus: idempotent hier mit angelegt,
-- damit der Tracker-Container auch starten darf, bevor die App die gemeinsame
-- Datenbank initialisiert hat.
CREATE TABLE IF NOT EXISTS vehicles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  traccar_device_id TEXT,
  active       INTEGER NOT NULL DEFAULT 0
);

-- Übernachtungs-/Stopp-Erkennung (src/auto-import.js, 6. September 2026):
-- dieselben Tabellen wie in db/schema.sql (dort die Quelle der Wahrheit
-- für den App-Container), hier noch einmal idempotent angelegt — genau
-- derselbe Grund wie bei vehicles oben: der ingest-Container muss auch
-- starten dürfen, bevor die App die gemeinsame Datenbank initialisiert
-- hat. Die categories-Startwerte MÜSSEN hier mit rein (anders als erst
-- gedacht): better-sqlite3 erzwingt Fremdschlüssel standardmäßig (anders
-- als reines SQLite) — orte.category_id REFERENCES categories(id) würde
-- sonst bei jeder Ort-Anlage scheitern, falls ingest vor app startet und
-- categories noch leer ist (live im Test entdeckt). "WHERE NOT EXISTS"
-- wie in db/schema.sql/api/schema.sql: nur eine WIRKLICH leere Tabelle
-- bekommt die Vorgaben, eine vom Menschen getroffene Löschung (siehe der
-- "gelöschte Kategorie kommt zurück"-Bug, 6. September 2026) bleibt
-- bestehen, ganz gleich welcher der beiden Container zuerst schreibt.
CREATE TABLE IF NOT EXISTS trips (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  start_at    TEXT NOT NULL,
  end_at      TEXT,
  vehicle_id  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  is_active   INTEGER GENERATED ALWAYS AS (CASE WHEN end_at IS NULL THEN 1 END) VIRTUAL
);

CREATE TABLE IF NOT EXISTS categories (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  color   TEXT NOT NULL,
  sort    INTEGER NOT NULL DEFAULT 0
);
-- Bei Änderung hier auch db/schema.sql UND api/schema.sql nachziehen (drei
-- Kopien, wie bei den Tabellen oben) — dieselbe Liste, derselbe Grund.
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

CREATE TABLE IF NOT EXISTS orte (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
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
  source       TEXT NOT NULL DEFAULT 'manuell',
  kind         TEXT NOT NULL DEFAULT 'manual',
  occurred_at  TEXT,
  nights       INTEGER NOT NULL DEFAULT 1,
  weather      TEXT,
  stop_key     TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS besuche_ort  ON besuche (ort_id);
CREATE INDEX IF NOT EXISTS besuche_time ON besuche (occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS besuche_stop_key ON besuche (stop_key) WHERE stop_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS ignored_stops (
  stop_key   TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Nur für den ingest-Container (auto-import.js): Besuche, die aus einem noch
-- OFFENEN Stand entstanden sind (Fahrzeug meldet sich seit Stunden nicht mehr,
-- der Server nimmt "steht noch" an). Sobald wieder Daten kommen, wird jeder
-- Eintrag hier bestätigt (bleibt) oder widerlegt (Auto-Eintrag wird entfernt,
-- falls unberührt). Bewusst eigene Tabelle statt neuer Spalte in besuche —
-- kein Schema-Eingriff in die vom app-Container verwalteten Tabellen.
CREATE TABLE IF NOT EXISTS auto_vorlaeufig (
  stop_key   TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

-- Zonen-Überwachung (Wache): dieselben drei Tabellen wie
-- in db/schema.sql (dort die Quelle der Wahrheit für den App-Container) —
-- hier noch einmal idempotent angelegt, damit der ingest-Container sie
-- sicher hat, EGAL in welcher Reihenfolge die beiden Container starten.
-- Zonen-Verlassen muss unmittelbar bei der neuen Position erkannt werden
-- (Diebstahlschutz, Zeitnähe zählt) — deshalb lebt die Auswertung hier im
-- ingest-Container, nicht nachträglich im app-Container (siehe alarms.js).
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
INSERT OR IGNORE INTO alarm_settings (key, enabled, threshold) VALUES
  ('motion',       1, NULL),
  ('geofence',     1, NULL),
  ('undervoltage', 1, 12.0),
  ('powercut',     1, NULL),
  ('speeding',     0, 120);

CREATE TABLE IF NOT EXISTS alarm_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'warn',   -- ok | warn | crit
  message     TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS alarm_log_time ON alarm_log (occurred_at DESC);

-- Web-Push-Abos — ein Datensatz
-- je Gerät/Browser, das sich angemeldet hat. Wie geofences/alarm_settings/
-- alarm_log: dieselbe Tabelle wie in db/schema.sql, hier noch einmal
-- idempotent angelegt, damit ingest sie sicher hat. ingest liest sie beim
-- Zonen-Wechsel und verschickt den Push direkt (siehe alarms.js) — kein
-- Umweg über den app-Container nötig, ingest sieht das Ereignis als Erstes.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
