/**
 * VOJAĜO API — Cloudflare Worker
 *
 * Läuft als Cloudflare-Pages-Funktion unter derselben Adresse wie die App.
 * Der Zugang erfolgt über Anmeldung (Sitzungs-Cookie), nicht mehr per Token.
 *
 * Zwei Aufgaben:
 *  1. Proxy vor Traccar: hält Zugangsdaten serverseitig, liefert Positionen/Fahrten/Stopps.
 *  2. Eigene Daten in D1: Orte, Reisen, Kategorien, Geofences, Alarme.
 *
 * Konfiguration (via `wrangler secret put` bzw. Variablen):
 *   TRACCAR_URL       z. B. http://10.8.0.1:8082
 *   TRACCAR_TOKEN     Traccar-API-Token  (alternativ TRACCAR_USER/TRACCAR_PASS)
 *   ALLOWED_ORIGINS   nur nötig, falls die App je von einer anderen Adresse käme
 *   CF_ACCESS_ID      Dienst-Token für Cloudflare Access vor Traccar (Client ID)
 *   CF_ACCESS_SECRET  zugehöriges Geheimnis
 *   DEBUG             "true" liefert Fehlerdetails an den Aufrufer
 *   LOCAL_POSITIONS   nur im Selbst-Hosting-Betrieb (app-backend/)
 *                     gesetzt — Positionen/Fahrten/Stopps
 *                     kommen dann aus der eigenen `positions`-Tabelle in
 *                     env.DB statt von Traccar. Auf Cloudflare NIE gesetzt,
 *                     Verhalten dort unverändert.
 */
import {
  corsHeaders, validateOrt, validateBesuch, validateTrip, validateNote, validateTagebuch, validateRange, createRateLimiter, publicError,
  hashPassword, verifyPassword, newSessionToken, hashToken,
  sessionCookie, clearedSessionCookie, istHttps, readCookie, validateCredentials, SESSION_DAYS,
  validateCoords, holeOrtsname, holeWetter,
  validateCategory, validateVehicle,
  isValidEmail, newResetToken, RESET_TOKEN_MINUTES, newVerifyToken, EMAIL_VERIFY_MINUTES,
  newShareToken, isValidShareScope,
  mapPositionRow, segmentDrives, segmentStops,
  isValidId,
} from "./lib.js";

const uid = () => crypto.randomUUID();
// Fester, einziger Datensatz für die Geofence-Wache — kein Zonen-CRUD (mehr),
// siehe PATCH /api/alarms/geofence unten.
const WACHE_ZONE_ID = "wache-aktuell";
const takeToken = createRateLimiter({ limit: 120, windowMs: 60_000 });
// Anmeldeversuche gesondert und deutlich strenger begrenzen.
const takeLogin = createRateLimiter({ limit: 10, windowMs: 15 * 60_000 });
// Öffentliche Freigaben: großzügiger als Login (Live-Position pollt), aber
// begrenzt, damit ein Link nicht zum Hebel für Traccar-Anfragen wird.
const takeShare = createRateLimiter({ limit: 60, windowMs: 60_000 });

/* ---------------- Anmeldung ---------------- */

const antwortMitCookie = (request, env, daten, cookie, status = 200) =>
  new Response(JSON.stringify(daten), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "set-cookie": cookie, ...corsHeaders(request, env) },
  });

/** Gibt es überhaupt schon ein Konto? */
async function kontoVorhanden(env) {
  const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").all();
  return (results?.[0]?.n || 0) > 0;
}

/** Sitzung aus dem Cookie auflösen; abgelaufene werden nebenbei entfernt. */
async function aktuelleSitzung(request, env) {
  const token = readCookie(request, "vojago_session");
  if (!token) return null;
  const abdruck = await hashToken(token);
  const { results } = await env.DB.prepare(
    "SELECT s.user_id, s.expires_at, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?"
  ).bind(abdruck).all();
  const sitzung = results?.[0];
  if (!sitzung) return null;
  if (sitzung.expires_at < Date.now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(abdruck).run();
    return null;
  }
  return { userId: sitzung.user_id, username: sitzung.username, abdruck };
}

async function sitzungAnlegen(env, userId) {
  const token = newSessionToken();
  const abdruck = await hashToken(token);
  const gueltigBis = Date.now() + SESSION_DAYS * 86400 * 1000;
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)")
    .bind(abdruck, userId, gueltigBis).run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()).run();
  return token;
}

const reply = (request, env, data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders(request, env) },
  });

/** Bestehende Datenbanken bekommen Spalte/Tabelle bei Bedarf selbst — wie bei
 * ensureDriveAssignmentMode, damit eine vergessene Migration nicht die ganze
 * Anmeldung lahmlegt. */
async function ensureEmailReset(env) {
  const { results } = await env.DB.prepare("PRAGMA table_info(users)").all();
  const spalten = new Set((results || []).map((row) => row.name));
  if (!spalten.has("email")) {
    try {
      await env.DB.prepare("ALTER TABLE users ADD COLUMN email TEXT").run();
    } catch (e) {
      if (!/duplicate column name/i.test(String(e))) throw e;
    }
  }
  if (!spalten.has("email_verified_at")) {
    try {
      await env.DB.prepare("ALTER TABLE users ADD COLUMN email_verified_at INTEGER").run();
    } catch (e) {
      if (!/duplicate column name/i.test(String(e))) throw e;
    }
  }
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS password_resets (" +
    "token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, " +
    "expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS email_verifications (" +
    "token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, " +
    "email TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
  ).run();
}

/** Benutzerverwaltung: Spalte selbstheilend ergänzen, und — falls es noch
 * keinen Admin gibt (frische Migration) — automatisch das älteste Konto
 * dazu machen. Das war vor dieser Funktion ohnehin das einzige Konto, sonst
 * könnte niemand mehr Konten verwalten. */
async function ensureUserAdmin(env) {
  const { results } = await env.DB.prepare("PRAGMA table_info(users)").all();
  const spalten = new Set((results || []).map((row) => row.name));
  if (!spalten.has("is_admin")) {
    try {
      await env.DB.prepare("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0").run();
    } catch (e) {
      if (!/duplicate column name/i.test(String(e))) throw e;
    }
  }
  const { results: admins } = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1").all();
  if (!admins?.[0]?.n) {
    await env.DB.prepare("UPDATE users SET is_admin = 1 WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)").run();
  }
}

async function istAdmin(env, userId) {
  const { results } = await env.DB.prepare("SELECT is_admin FROM users WHERE id = ?").bind(userId).all();
  return Boolean(results?.[0]?.is_admin);
}

/** Legt den Bestätigungslink an und verschickt ihn — gemeinsam genutzt von
 * Kontoanlage und E-Mail ändern. Frühere, noch offene Links für denselben
 * Nutzer werden dabei bewusst NICHT gelöscht (anders als bei Reset-Links):
 * ändert sich die Adresse zwischendurch, soll ein alter Link für die alte
 * Adresse erkennbar daneben liegen (siehe /verify-email), nicht wortlos
 * verschwinden. Ein fehlgeschlagener Versand fliegt nicht hoch (Konto/
 * Änderung soll trotzdem stehen bleiben); er landet nur im Log, damit er
 * beim Einrichten auffindbar ist. */
async function sendeBestaetigungsmail(request, env, { userId, email }) {
  const token = newVerifyToken();
  const abdruck = await hashToken(token);
  const gueltigBis = Date.now() + EMAIL_VERIFY_MINUTES * 60_000;
  await env.DB.prepare("INSERT INTO email_verifications (token_hash, user_id, email, expires_at) VALUES (?,?,?,?)")
    .bind(abdruck, userId, email, gueltigBis).run();
  const basis = env.APP_URL || new URL(request.url).origin;
  const link = `${basis}/?verify=${token}`;
  try {
    await sendeMail(env, {
      to: email,
      subject: "VOJAĜO — E-Mail bestätigen",
      text: `E-Mail bestätigen (${EMAIL_VERIFY_MINUTES / 60} Stunden gültig): ${link}\n\nWar das nicht du? Dann einfach ignorieren.`,
      html: `<p>E-Mail bestätigen (${EMAIL_VERIFY_MINUTES / 60} Stunden gültig):</p><p><a href="${link}">${link}</a></p><p>War das nicht du? Dann einfach ignorieren.</p>`,
    });
  } catch (e) {
    console.error("Bestätigungsmail fehlgeschlagen:", e?.message || e);
  }
}

/**
 * E-Mail bestätigen — entweder echt per Link (wenn Mailversand konfiguriert
 * ist) oder sofort, wenn nicht. Ohne RESEND_API_KEY (typisch beim
 * Selbst-Hosting B1: app-backend setzt bewusst keinen
 * Mailversand) würde sonst NIE eine Bestätigung ankommen — der
 * Verifizierungslink würde zwar angelegt, aber nie zugestellt, und die
 * Adresse bliebe auf ewig "nicht verifiziert" hängen, obwohl niemand außer
 * dem Kontoinhaber selbst je Zugriff auf die Datenbank hat. Sobald
 * Mailversand konfiguriert wird, greift die echte Bestätigung wieder ganz
 * normal.
 * @returns {boolean} ob die Adresse jetzt schon als verifiziert gilt
 */
async function bestaetigeOderSendeMail(request, env, { userId, email }) {
  if (!env.RESEND_API_KEY) {
    await env.DB.prepare("UPDATE users SET email_verified_at = ? WHERE id = ?").bind(Date.now(), userId).run();
    return true;
  }
  await sendeBestaetigungsmail(request, env, { userId, email });
  return false;
}

async function ensureShares(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS trip_shares (" +
    "id TEXT PRIMARY KEY, token TEXT, token_hash TEXT NOT NULL UNIQUE, " +
    "trip_id TEXT REFERENCES trips(id) ON DELETE CASCADE, scope TEXT NOT NULL DEFAULT 'karte', " +
    "label TEXT, expires_at INTEGER, revoked_at INTEGER, " +
    "created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at INTEGER, view_count INTEGER NOT NULL DEFAULT 0)"
  ).run();
  const { results } = await env.DB.prepare("PRAGMA table_info(trip_shares)").all();
  if (!(results || []).some((row) => row.name === "token")) {
    try {
      await env.DB.prepare("ALTER TABLE trip_shares ADD COLUMN token TEXT").run();
    } catch (e) {
      if (!/duplicate column name/i.test(String(e))) throw e;
    }
  }
}

/**
 * Tagebuch (Logbuch-Umbau, Oktober 2026): ein Eintrag je Reise und Kalendertag
 * plus Fotos, die direkt am Eintrag hängen. Lazy und idempotent wie die anderen
 * ensure*-Funktionen — auf einer bestehenden Installation fehlt die Spalte
 * photos.tagebuch_id noch und wird einmalig nachgetragen.
 */
async function ensureTagebuch(env) {
  await ensureOrteBesuche(env); // legt photos an, falls noch nicht vorhanden
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS tagebuch (" +
    "id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE, " +
    "day_key TEXT NOT NULL, blocks TEXT NOT NULL DEFAULT '[]', author TEXT, " +
    "created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), " +
    "UNIQUE (trip_id, day_key))"
  ).run();
  const { results } = await env.DB.prepare("PRAGMA table_info(photos)").all();
  if (!(results || []).some((row) => row.name === "tagebuch_id")) {
    try {
      await env.DB.prepare("ALTER TABLE photos ADD COLUMN tagebuch_id TEXT REFERENCES tagebuch(id) ON DELETE CASCADE").run();
    } catch (e) {
      if (!/duplicate column name/i.test(String(e))) throw e;
    }
  }
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS photos_tagebuch ON photos (tagebuch_id)").run();
}

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/**
 * Orte/Besuche (18. August 2026, Umbau) — baut orte/besuche/notes/photos
 * idempotent auf UND löst dabei einmalig die alte, verschmolzene Form ab:
 * "places" (Ort+Besuch in einer Zeile) wird vollständig durch orte+besuche
 * ersetzt; notes/photos behalten ihren Namen, verlieren aber trip_id
 * (Reise wird wie bei Fahrten live aus occurred_at berechnet) und bekommen
 * besuch_id statt place_id. Reines `CREATE TABLE IF NOT EXISTS` würde eine
 * bestehende, alt geformte Tabelle unverändert lassen — deshalb hier
 * zusätzlich ein einmaliger, an der jeweils alten Spalte/Tabelle erkannter
 * Neuaufbau (Datenverlust dabei ist hier bewusst in Kauf genommen: der
 * Umbau kam vor genug echten Reisen, um das zu rechtfertigen).
 * Nach der Umstellung greift die Erkennung nie wieder (die alte Spalte/
 * Tabelle existiert dann nicht mehr) — sicher, für jeden Request erneut
 * aufzurufen, wie ensurePhotos() es vorher war.
 */
async function ensureOrteBesuche(env) {
  // Reihenfolge wichtig: photos referenziert notes UND places, notes
  // referenziert places — SQLite lehnt "DROP TABLE notes" ab, solange eine
  // ANDERE Tabelle (hier photos) noch eine (und sei es bereits verwaiste)
  // FOREIGN KEY-Deklaration auf eine schon gelöschte Tabelle trägt ("no
  // such table: main.places"). Deshalb erst photos droppen, dann notes,
  // dann places — nie umgekehrt (echter Fund beim ersten Deploy-Versuch,
  // 18. August 2026: Server crashte nicht mehr an dieser Stelle, aber die
  // Migration selbst brach mittendrin ab).
  const { results: photosSpalten } = await env.DB.prepare("PRAGMA table_info(photos)").all();
  if ((photosSpalten || []).some((s) => s.name === "place_id")) {
    await env.DB.prepare("DROP TABLE photos").run();
  }
  const { results: notesSpalten } = await env.DB.prepare("PRAGMA table_info(notes)").all();
  if ((notesSpalten || []).some((s) => s.name === "place_id")) {
    await env.DB.prepare("DROP TABLE notes").run();
  }
  // "places" wird nie wieder verwendet — einmaliger Neuaufbau als orte+besuche
  // passiert client-/serverseitig ohnehin (alte Daten hier bewusst nicht
  // übernommen, siehe Kommentar oben), also reicht ein einfaches Löschen.
  const { results: placesVorhanden } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='places'"
  ).all();
  if (placesVorhanden?.length) {
    await env.DB.prepare("DROP TABLE places").run();
  }

  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS orte (" +
    "id TEXT PRIMARY KEY, title TEXT NOT NULL, note TEXT, category_id TEXT REFERENCES categories(id), " +
    "rating INTEGER CHECK (rating BETWEEN 0 AND 5), lat REAL NOT NULL, lon REAL NOT NULL, " +
    "created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))"
  ).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS orte_cat ON orte (category_id)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS orte_geo ON orte (lat, lon)").run();

  // Nachträglich ergänzt (6. September 2026): die per Reverse-Geocoding
  // ermittelte Adresse getrennt vom (überschreibbaren) Titel festhalten —
  // Nutzerwunsch, damit ein umbenannter Ort seine ursprüngliche Adresse
  // nicht verliert. Lazy-Migration wie ensureEmailReset() oben.
  const { results: orteSpalten } = await env.DB.prepare("PRAGMA table_info(orte)").all();
  if (!(orteSpalten || []).some((s) => s.name === "address")) {
    try {
      await env.DB.prepare("ALTER TABLE orte ADD COLUMN address TEXT").run();
    } catch (e) {
      if (!/duplicate column name/i.test(String(e))) throw e;
    }
  }

  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS besuche (" +
    "id TEXT PRIMARY KEY, ort_id TEXT NOT NULL REFERENCES orte(id) ON DELETE CASCADE, " +
    "source TEXT NOT NULL DEFAULT 'manuell', kind TEXT NOT NULL DEFAULT 'manual', " +
    "occurred_at TEXT, nights INTEGER NOT NULL DEFAULT 1, weather TEXT, stop_key TEXT, " +
    "created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))"
  ).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS besuche_ort ON besuche (ort_id)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS besuche_time ON besuche (occurred_at)").run();
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS besuche_stop_key ON besuche (stop_key) WHERE stop_key IS NOT NULL").run();

  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS notes (" +
    "id TEXT PRIMARY KEY, besuch_id TEXT REFERENCES besuche(id) ON DELETE SET NULL, " +
    "title TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, occurred_at TEXT, lat REAL, lon REAL, " +
    "source TEXT NOT NULL DEFAULT 'handy', weather TEXT, " +
    "created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))"
  ).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS notes_besuch ON notes (besuch_id)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS notes_time ON notes (occurred_at)").run();

  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS photos (" +
    "id TEXT PRIMARY KEY, besuch_id TEXT REFERENCES besuche(id) ON DELETE CASCADE, " +
    "note_id TEXT REFERENCES notes(id) ON DELETE CASCADE, " +
    "r2_key TEXT NOT NULL, taken_at TEXT, lat REAL, lon REAL, width INTEGER, height INTEGER, " +
    "created_at TEXT NOT NULL DEFAULT (datetime('now')))"
  ).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS photos_besuch ON photos (besuch_id)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS photos_note ON photos (note_id)").run();
}

/** Streamt ein Foto aus R2 — gemeinsam genutzt vom angemeldeten und vom
 * öffentlichen Freigabe-Endpunkt. `r2Key` kommt in beiden Fällen erst nach
 * einer eigenen Berechtigungsprüfung hierher. */
async function liefereFoto(request, env, r2Key) {
  if (!env.PHOTOS) return reply(request, env, { error: "Fotospeicher ist noch nicht eingerichtet" }, 503);
  const obj = await env.PHOTOS.get(r2Key);
  if (!obj) return reply(request, env, { error: "Foto nicht gefunden" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "image/jpeg",
      "cache-control": "private, max-age=86400",
      ...corsHeaders(request, env),
    },
  });
}

/** Holt eine aktive (nicht abgelaufene, nicht widerrufene) Freigabe zu einem
 * Link-Token — gemeinsam genutzt von allen öffentlichen /api/share-Routen. */
async function aktiveFreigabe(env, token) {
  const abdruck = await hashToken(token);
  const { results } = await env.DB.prepare("SELECT * FROM trip_shares WHERE token_hash = ?").bind(abdruck).all();
  const freigabe = results?.[0];
  if (!freigabe) return null;
  if (freigabe.revoked_at) return null;
  if (freigabe.expires_at && freigabe.expires_at < Date.now()) return null;
  return freigabe;
}

/** Welches Traccar-Gerät zu einer Reise gehört — dieselbe Herleitung wie im
 * angemeldeten Betrieb (state.config.device dort, dieselbe Einstellung liegt
 * hier in app_settings): die App führt aktuell EIN global konfiguriertes
 * Gerät, nicht je Reise. trips.vehicle_id wird nur genutzt, wenn es
 * tatsächlich gesetzt ist und zu einem Fahrzeug mit hinterlegter Geräte-ID
 * passt — sonst zählt die globale Einstellung, wie überall sonst auch. */
async function ermittleGeraeteId(env, reise) {
  if (reise.vehicle_id) {
    const { results } = await env.DB.prepare("SELECT traccar_device_id FROM vehicles WHERE id = ?")
      .bind(reise.vehicle_id).all();
    if (results?.[0]?.traccar_device_id) return results[0].traccar_device_id;
  }
  const { results } = await env.DB.prepare("SELECT data FROM app_settings WHERE id = 1").all();
  try {
    const data = JSON.parse(results?.[0]?.data || "{}");
    return data.device || null;
  } catch {
    return null;
  }
}

/**
 * Fällt ein Zeitpunkt in den Zeitraum einer der übergebenen Reisen (rohe
 * DB-Zeilen mit start_at/end_at)? Dieselbe Grundidee wie
 * zugehoerigeReise()/zugehoerigeReiseFahrt() im Frontend
 * (src/dataload.js) — Reise-Zugehörigkeit wird nie gespeichert, immer aus
 * der Zeit berechnet. Hier serverseitig für die Gast-Freigabe gebraucht,
 * wo Besuche/Notizen/Fotos keine trip_id mehr besitzen.
 */
function faelltInReisezeitraum(occurredAt, reisen) {
  const t = Date.parse(occurredAt || "");
  if (!Number.isFinite(t)) return false;
  return reisen.some((reise) => {
    const von = Date.parse(reise.start_at || "");
    const bis = reise.end_at ? Date.parse(reise.end_at) : Date.now();
    return Number.isFinite(von) && t >= von && t <= bis;
  });
}

async function ensureDriveAssignmentMode(env) {
  const { results } = await env.DB.prepare("PRAGMA table_info(drive_assignments)").all();
  const spalten = new Set((results || []).map((row) => row.name));
  if (!spalten.has("assignment")) {
    try {
      await env.DB.prepare("ALTER TABLE drive_assignments ADD COLUMN assignment TEXT NOT NULL DEFAULT 'auto'").run();
    } catch (e) {
      if (!/duplicate column name/i.test(String(e))) throw e;
    }
    await env.DB.prepare("UPDATE drive_assignments SET assignment = CASE WHEN trip_id IS NULL THEN 'auto' ELSE 'manual' END").run();
  }
  if (!spalten.has("kind")) {
    try {
      await env.DB.prepare("ALTER TABLE drive_assignments ADD COLUMN kind TEXT NOT NULL DEFAULT 'etappe'").run();
    } catch (e) {
      if (!/duplicate column name/i.test(String(e))) throw e;
    }
  }
}

/* ---------------- Traccar ---------------- */

function traccarHeaders(env) {
  const h = { accept: "application/json" };
  if (env.TRACCAR_TOKEN) h.authorization = `Bearer ${env.TRACCAR_TOKEN}`;
  else if (env.TRACCAR_USER) h.authorization = "Basic " + btoa(`${env.TRACCAR_USER}:${env.TRACCAR_PASS || ""}`);
  // Liegt Cloudflare Access vor Traccar, weist sich der Worker per Dienst-Token aus.
  if (env.CF_ACCESS_ID && env.CF_ACCESS_SECRET) {
    h["CF-Access-Client-Id"] = env.CF_ACCESS_ID;
    h["CF-Access-Client-Secret"] = env.CF_ACCESS_SECRET;
  }
  return h;
}

async function traccar(env, path, params = {}) {
  if (!env.TRACCAR_URL) throw new Error("TRACCAR_URL nicht konfiguriert");
  const url = new URL(path, env.TRACCAR_URL);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: traccarHeaders(env) });
  if (!res.ok) throw new Error(`Traccar antwortete mit ${res.status}`);
  return res.json();
}

/* ---------------- Eigene Positionsquelle (Phase 2) ----------------
 * Nur aktiv, wenn env.LOCAL_POSITIONS gesetzt ist (app-backend/src/server.js).
 * Sonst unverändert Traccar — der Cloudflare-Betrieb setzt diese Variable nie. */

async function holePositionsZeitraum(env, deviceId, from, to) {
  if (!deviceId) return [];
  const vonMs = Date.parse(from);
  const bisMs = Date.parse(to);
  const { results } = await env.DB.prepare(
    "SELECT * FROM positions WHERE device_id = ? AND at >= ? AND at <= ? ORDER BY at ASC"
  ).bind(deviceId, Number.isFinite(vonMs) ? vonMs : 0, Number.isFinite(bisMs) ? bisMs : Date.now()).all();
  return results;
}

async function holeLokaleGeraete(env) {
  const { results } = await env.DB.prepare(
    `WITH seen AS (
       SELECT device_id, MAX(at) AS last_seen, 0 AS accepted, MAX(protocol) AS protocol FROM positions GROUP BY device_id
       UNION ALL
       SELECT device_id, last_seen, accepted, protocol FROM known_devices
     )
     SELECT seen.device_id, MAX(seen.last_seen) AS letzte,
       CASE WHEN MAX(seen.accepted) = 1 OR MAX(CASE WHEN vehicles.traccar_device_id IS NOT NULL THEN 1 ELSE 0 END) = 1 THEN 1 ELSE 0 END AS accepted,
       MAX(seen.protocol) AS protocol
     FROM seen
     LEFT JOIN vehicles ON trim(coalesce(vehicles.traccar_device_id, '')) = seen.device_id
     GROUP BY seen.device_id
     ORDER BY letzte DESC`
  ).all();
  return results.map((r) => ({
    id: r.device_id, name: r.device_id, uniqueId: r.device_id,
    lastUpdate: r.letzte ? new Date(r.letzte).toISOString() : null,
    accepted: Boolean(r.accepted),
    protocol: r.protocol || null,
  }));
}

/** Zentrale Verzweigung: lokale positions-Tabelle oder Traccar-Proxy —
 * damit die eigentlichen Routen unten nicht wissen müssen, woher die Daten
 * kommen. */
async function positionsQuelle(env, art, { deviceId, from, to } = {}) {
  if (env.LOCAL_POSITIONS) {
    switch (art) {
      case "positions": {
        if (!deviceId) return [];
        const { results } = await env.DB.prepare(
          "SELECT * FROM positions WHERE device_id = ? ORDER BY at DESC LIMIT 1"
        ).bind(deviceId).all();
        return results.map(mapPositionRow);
      }
      case "route": return (await holePositionsZeitraum(env, deviceId, from, to)).map(mapPositionRow);
      case "drives": return segmentDrives(await holePositionsZeitraum(env, deviceId, from, to));
      case "stops": return segmentStops(await holePositionsZeitraum(env, deviceId, from, to));
      case "devices": return holeLokaleGeraete(env);
    }
  }
  const pfad = {
    positions: "/api/positions", route: "/api/reports/route",
    drives: "/api/reports/trips", stops: "/api/reports/stops", devices: "/api/devices",
  }[art];
  return traccar(env, pfad, { deviceId, from, to });
}

/** Zeitraum-Berichte teilen sich Prüfung und Aufruf. */
async function rangeReport(request, env, url, art) {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const check = validateRange(from, to);
  if (!check.ok) return reply(request, env, { error: check.errors.join("; ") }, 400);
  const data = await positionsQuelle(env, art, { deviceId: url.searchParams.get("deviceId"), from, to });
  return reply(request, env, data);
}

/* ---------------- Mailversand ---------------- */

/**
 * Reset-Link per Mail über Resend (https://resend.com) — reine HTTP-API,
 * kein SDK nötig. `RESEND_API_KEY` ist ein Worker-Secret; ohne ihn wird kein
 * Versand versucht, das ist beim Einrichten normal und kein Absturzgrund.
 */
async function sendeMail(env, { to, subject, html, text }) {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY nicht konfiguriert");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM || "VOJAĜO <onboarding@resend.dev>", to: [to], subject, html, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Mailversand antwortete mit ${res.status}: ${body.slice(0, 300)}`);
  }
}

/* ---------------- Router ---------------- */

export async function handle(request, env) {
  try {
    return await route(request, env);
  } catch (err) {
    console.error("API-Fehler:", err?.stack || err);
    return new Response(JSON.stringify(publicError(err, env)), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders(request, env) },
    });
  }
}

async function route(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const seg = path.split("/").filter(Boolean);

    if (seg[0] !== "api") return reply(request, env, { error: "nicht gefunden" }, 404);

    // Lastbegrenzung je Aufrufer
    const caller = request.headers.get("cf-connecting-ip") || "unbekannt";
    const quota = takeToken(caller);
    if (!quota.ok) {
      return new Response(JSON.stringify({ error: "zu viele Anfragen" }), {
        status: 429,
        headers: { "content-type": "application/json; charset=utf-8", "retry-after": String(quota.retryAfter), ...corsHeaders(request, env) },
      });
    }

    /* ---- Anmeldung ---- */
    if (seg[1] === "auth") {
      const schritt = seg[2];

      // Zustand: Muss erst ein Konto angelegt werden? Wer ist angemeldet?
      if (schritt === "me" && request.method === "GET") {
        const eingerichtet = await kontoVorhanden(env);
        const sitzung = eingerichtet ? await aktuelleSitzung(request, env) : null;
        let email = null;
        let emailVerified = false;
        let isAdmin = false;
        if (sitzung) {
          try {
            const { results } = await env.DB.prepare("SELECT email, email_verified_at FROM users WHERE id = ?").bind(sitzung.userId).all();
            email = results?.[0]?.email || null;
            emailVerified = Boolean(results?.[0]?.email_verified_at);
          } catch { /* Spalten evtl. noch nicht migriert — dann zeigt sich einfach "keine E-Mail" */ }
          try {
            await ensureUserAdmin(env);
            isAdmin = await istAdmin(env, sitzung.userId);
          } catch { /* Benutzerverwaltung noch nicht migriert — dann bleibt isAdmin false */ }
        }
        return reply(request, env, {
          eingerichtet,
          angemeldet: Boolean(sitzung),
          username: sitzung?.username || null,
          email,
          emailVerified,
          isAdmin,
        });
      }

      // Erstes Konto anlegen — nur solange es keines gibt. Die E-Mail ist
      // optional (sonst wäre die erste Kontoanlage vom Mailversand
      // abhängig, bevor der überhaupt eingerichtet sein kann) — wird sie
      // angegeben, verschicken wir sofort einen Bestätigungslink; erst eine
      // bestätigte E-Mail zählt später für "Passwort vergessen".
      if (schritt === "setup" && request.method === "POST") {
        if (await kontoVorhanden(env)) return reply(request, env, { error: "Es gibt bereits ein Konto" }, 409);
        await ensureEmailReset(env);
        const b = await request.json().catch(() => ({}));
        const pruefung = validateCredentials(b, { neu: true });
        if (!pruefung.ok) return reply(request, env, { error: pruefung.errors.join("; ") }, 400);
        const email = b.email ? String(b.email).trim() : "";
        if (email && !isValidEmail(email)) {
          return reply(request, env, { error: "Das sieht nicht nach einer gültigen E-Mail-Adresse aus" }, 400);
        }
        const id = uid();
        await env.DB.prepare("INSERT INTO users (id, username, password_hash, email) VALUES (?,?,?,?)")
          .bind(id, b.username.trim(), await hashPassword(b.password), email || null).run();
        const emailVerified = email ? await bestaetigeOderSendeMail(request, env, { userId: id, email }) : false;
        const token = await sitzungAnlegen(env, id);
        return antwortMitCookie(request, env, { ok: true, username: b.username.trim(), emailPending: Boolean(email) && !emailVerified }, sessionCookie(token, { secure: istHttps(request) }), 201);
      }

      if (schritt === "login" && request.method === "POST") {
        const kennung = request.headers.get("cf-connecting-ip") || "unbekannt";
        if (!takeLogin(kennung).ok) {
          return reply(request, env, { error: "Zu viele Anmeldeversuche. Bitte später erneut." }, 429);
        }
        const b = await request.json().catch(() => ({}));
        const pruefung = validateCredentials(b);
        if (!pruefung.ok) return reply(request, env, { error: pruefung.errors.join("; ") }, 400);

        const { results } = await env.DB.prepare("SELECT id, password_hash FROM users WHERE username = ?")
          .bind(String(b.username || "").trim()).all();
        const benutzer = results?.[0];
        // Auch ohne Treffer rechnen, damit die Antwortzeit nichts verrät.
        const passt = benutzer
          ? await verifyPassword(b.password, benutzer.password_hash)
          : await verifyPassword(b.password, "pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
        if (!benutzer || !passt) return reply(request, env, { error: "Benutzername oder Passwort stimmen nicht" }, 401);

        const token = await sitzungAnlegen(env, benutzer.id);
        return antwortMitCookie(request, env, { ok: true }, sessionCookie(token, { secure: istHttps(request) }));
      }

      // Reset-Link per Mail anfordern — ohne Anmeldung, genau dafür ist er
      // da. Antwortet absichtlich immer gleich (kein Verrat, ob der
      // Benutzername existiert oder eine Mail hinterlegt ist).
      if (schritt === "forgot" && request.method === "POST") {
        await ensureEmailReset(env);
        const kennung = request.headers.get("cf-connecting-ip") || "unbekannt";
        if (!takeLogin(kennung).ok) {
          return reply(request, env, { error: "Zu viele Versuche. Bitte später erneut." }, 429);
        }
        const b = await request.json().catch(() => ({}));
        const antwort = { ok: true, message: "Falls das Konto existiert und eine E-Mail hinterlegt ist, wurde ein Link verschickt." };

        const { results } = await env.DB.prepare("SELECT id, email, email_verified_at FROM users WHERE username = ?")
          .bind(String(b?.username || "").trim()).all();
        const benutzer = results?.[0];
        // Nur an eine bestätigte Adresse senden — sonst ließe sich der Reset
        // an eine fremde, noch nicht bestätigte E-Mail auslösen.
        if (benutzer?.email && benutzer?.email_verified_at) {
          const token = newResetToken();
          const abdruck = await hashToken(token);
          const gueltigBis = Date.now() + RESET_TOKEN_MINUTES * 60_000;
          await env.DB.prepare("DELETE FROM password_resets WHERE user_id = ?").bind(benutzer.id).run();
          await env.DB.prepare("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?,?,?)")
            .bind(abdruck, benutzer.id, gueltigBis).run();
          // Kein hartkodierter Domainname im Code — im Zweifel zählt die
          // Adresse, unter der die Anfrage tatsächlich hereinkam.
          const basis = env.APP_URL || new URL(request.url).origin;
          const link = `${basis}/?reset=${token}`;
          try {
            await sendeMail(env, {
              to: benutzer.email,
              subject: "VOJAĜO — Passwort zurücksetzen",
              text: `Ein neues Passwort setzen (${RESET_TOKEN_MINUTES} Minuten gültig): ${link}\n\nWar das nicht du? Dann einfach ignorieren.`,
              html: `<p>Ein neues Passwort setzen (${RESET_TOKEN_MINUTES} Minuten gültig):</p><p><a href="${link}">${link}</a></p><p>War das nicht du? Dann einfach ignorieren.</p>`,
            });
          } catch (e) {
            // Nach außen bleibt die Antwort gleich (kein Verrat) — der Fehler
            // landet im Log, damit er beim Einrichten auffindbar ist.
            console.error("Mailversand fehlgeschlagen:", e?.message || e);
          }
        }
        return reply(request, env, antwort);
      }

      // Neues Passwort per Reset-Link setzen — beendet alle Sitzungen und
      // meldet sofort mit dem neuen Passwort an.
      if (schritt === "reset" && request.method === "POST") {
        await ensureEmailReset(env);
        const b = await request.json().catch(() => ({}));
        if (typeof b.token !== "string" || !b.token.trim()) {
          return reply(request, env, { error: "Reset-Link fehlt oder ist ungültig" }, 400);
        }
        if (typeof b.password !== "string" || b.password.length < 10 || b.password.length > 200) {
          return reply(request, env, { error: "Passwort muss mindestens 10 Zeichen haben" }, 400);
        }

        const abdruck = await hashToken(b.token);
        const { results } = await env.DB.prepare(
          "SELECT pr.user_id, pr.expires_at, u.username FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE pr.token_hash = ?"
        ).bind(abdruck).all();
        const eintrag = results?.[0];
        if (!eintrag || eintrag.expires_at < Date.now()) {
          return reply(request, env, { error: "Der Link ist ungültig oder abgelaufen — neuen anfordern." }, 401);
        }

        await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
          .bind(await hashPassword(b.password), eintrag.user_id).run();
        await env.DB.prepare("DELETE FROM password_resets WHERE user_id = ?").bind(eintrag.user_id).run();
        await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(eintrag.user_id).run();
        const token = await sitzungAnlegen(env, eintrag.user_id);
        return antwortMitCookie(request, env, { ok: true, username: eintrag.username }, sessionCookie(token, { secure: istHttps(request) }));
      }

      // E-Mail hinterlegen/ändern — Voraussetzung für "Passwort vergessen".
      // Das aktuelle Passwort ist der Nachweis, wie bei der Passwortänderung.
      // Jede neue Adresse gilt erst nach Bestätigung — der Link geht sofort raus.
      if (schritt === "email" && request.method === "POST") {
        await ensureEmailReset(env);
        const sitzung = await aktuelleSitzung(request, env);
        if (!sitzung) return reply(request, env, { error: "nicht angemeldet" }, 401);
        const b = await request.json().catch(() => ({}));
        if (!isValidEmail(b.email)) return reply(request, env, { error: "Das sieht nicht nach einer gültigen E-Mail-Adresse aus" }, 400);
        const { results } = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(sitzung.userId).all();
        if (!await verifyPassword(b.password || "", results?.[0]?.password_hash)) {
          return reply(request, env, { error: "Passwort stimmt nicht" }, 401);
        }
        const email = b.email.trim();
        await env.DB.prepare("UPDATE users SET email = ?, email_verified_at = NULL WHERE id = ?").bind(email, sitzung.userId).run();
        const emailVerified = await bestaetigeOderSendeMail(request, env, { userId: sitzung.userId, email });
        return reply(request, env, { ok: true, email, emailVerified });
      }

      // E-Mail über den Link aus der Bestätigungsmail bestätigen — braucht
      // keine Sitzung, der Besitz des Links reicht (wie beim Reset-Link).
      if (schritt === "verify-email" && request.method === "POST") {
        await ensureEmailReset(env);
        const b = await request.json().catch(() => ({}));
        if (typeof b.token !== "string" || !b.token.trim()) {
          return reply(request, env, { error: "Bestätigungslink fehlt oder ist ungültig" }, 400);
        }
        const abdruck = await hashToken(b.token);
        const { results } = await env.DB.prepare(
          "SELECT ev.user_id, ev.email, ev.expires_at, u.email AS aktuelle_email " +
          "FROM email_verifications ev JOIN users u ON u.id = ev.user_id WHERE ev.token_hash = ?"
        ).bind(abdruck).all();
        const eintrag = results?.[0];
        if (!eintrag || eintrag.expires_at < Date.now()) {
          return reply(request, env, { error: "Der Link ist ungültig oder abgelaufen — E-Mail erneut speichern, um einen neuen zu bekommen." }, 401);
        }
        // Zwischenzeitlich nochmal geändert? Dann bestätigt der alte Link
        // nicht versehentlich die inzwischen andere aktuelle Adresse.
        if (eintrag.email !== eintrag.aktuelle_email) {
          return reply(request, env, { error: "Diese E-Mail wurde inzwischen geändert — bitte erneut bestätigen." }, 409);
        }
        await env.DB.prepare("UPDATE users SET email_verified_at = ? WHERE id = ?")
          .bind(Date.now(), eintrag.user_id).run();
        await env.DB.prepare("DELETE FROM email_verifications WHERE user_id = ?").bind(eintrag.user_id).run();
        return reply(request, env, { ok: true, email: eintrag.email });
      }

      if (schritt === "logout" && request.method === "POST") {
        const sitzung = await aktuelleSitzung(request, env);
        if (sitzung) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(sitzung.abdruck).run();
        return antwortMitCookie(request, env, { ok: true }, clearedSessionCookie(istHttps(request)));
      }

      if (schritt === "password" && request.method === "POST") {
        const sitzung = await aktuelleSitzung(request, env);
        if (!sitzung) return reply(request, env, { error: "nicht angemeldet" }, 401);
        const b = await request.json().catch(() => ({}));
        const pruefung = validateCredentials({ username: sitzung.username, password: b.neu }, { neu: true });
        if (!pruefung.ok) return reply(request, env, { error: pruefung.errors.join("; ") }, 400);
        const { results } = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(sitzung.userId).all();
        if (!await verifyPassword(b.alt || "", results?.[0]?.password_hash)) {
          return reply(request, env, { error: "Bisheriges Passwort stimmt nicht" }, 401);
        }
        await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
          .bind(await hashPassword(b.neu), sitzung.userId).run();
        // Alle anderen Sitzungen beenden — ein Passwortwechsel soll wirken.
        await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
          .bind(sitzung.userId, sitzung.abdruck).run();
        return reply(request, env, { ok: true });
      }

      return reply(request, env, { error: "nicht gefunden" }, 404);
    }

    // /api/health — Verbindungstest der App.
    if (seg[1] === "health") {
      const sitzung = await aktuelleSitzung(request, env);
      if (!sitzung) return reply(request, env, { ok: true, service: "vojago-api", authenticated: false }, 200);

      // Selbst-Hosting (env.LOCAL_POSITIONS): Traccar wird für Positionen gar
      // nicht mehr angesprochen (siehe positionsQuelle()) — der bisherige
      // Erreichbarkeits-Test würde hier IMMER "nicht erreichbar" melden
      // (TRACCAR_URL ist bewusst nicht gesetzt) und das fälschlich wie einen
      // Fehler aussehen lassen. Stattdessen ehrlich über die eigene
      // positions-Tabelle berichten.
      if (env.LOCAL_POSITIONS) {
        const { results } = await env.DB.prepare(
          "SELECT COUNT(DISTINCT device_id) AS geraete, COUNT(*) AS positionen, MAX(at) AS letzte FROM positions"
        ).all();
        const info = results?.[0] || {};
        return reply(request, env, {
          ok: true, service: "vojago-api", authenticated: true,
          positionsQuelle: "lokal",
          geraete: info.geraete || 0,
          positionen: info.positionen || 0,
          letztePosition: info.letzte ? new Date(info.letzte).toISOString() : null,
          db: env.DB ? "gebunden" : "fehlt",
          time: new Date().toISOString(),
        });
      }

      let traccarOk = false;
      let detail = null;
      try { await traccar(env, "/api/server"); traccarOk = true; }
      catch (e) { detail = String(e.message || e); }
      return reply(request, env, {
        ok: true, service: "vojago-api", authenticated: true,
        traccar: traccarOk ? "erreichbar" : "nicht erreichbar", detail,
        // S1/W6: zeigt ehrlich, ob der Worker sich per Access-Dienst-Token
        // ausweist — nicht, ob Access selbst vor Traccar aktiv ist (das lässt
        // sich vom Worker aus nicht prüfen, ohne die Zugangsdaten testweise
        // wegzulassen, was hier bewusst nicht passiert).
        traccarAccessAuth: Boolean(env.CF_ACCESS_ID && env.CF_ACCESS_SECRET),
        db: env.DB ? "gebunden" : "fehlt",
        time: new Date().toISOString(),
      });
    }

    // /api/share/... — öffentliche, schreibgeschützte Freigaben, bewusst VOR
    // dem Anmelde-Gate: das ist ja der Zweck, Dritte ohne eigenes Konto an
    // einzelnen oder allen Reisen teilhaben zu lassen.
    if (seg[1] === "share" && seg[2]) {
      const kennung = request.headers.get("cf-connecting-ip") || "unbekannt";
      if (!takeShare(kennung).ok) {
        return reply(request, env, { error: "Zu viele Anfragen. Bitte später erneut." }, 429);
      }
      await ensureShares(env);
      const token = seg[2];
      const teilaspekt = seg[3]; // undefined | "route" | "positions" | "drives" | "photos"

      const freigabe = await aktiveFreigabe(env, token);
      if (!freigabe) return reply(request, env, { error: "Der Link ist ungültig, abgelaufen oder wurde widerrufen." }, 404);

      // trip_id NULL heißt "alle Reisen" — dann zählt jede vorhandene
      // (auch künftige, ohne dass der Link erneuert werden müsste).
      const reisenQuery = freigabe.trip_id
        ? env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(freigabe.trip_id)
        : env.DB.prepare("SELECT * FROM trips ORDER BY (end_at IS NULL) DESC, start_at DESC");
      const { results: reisen } = await reisenQuery.all();
      if (freigabe.trip_id && !reisen.length) {
        return reply(request, env, { error: "Diese Reise gibt es nicht mehr." }, 404);
      }

      if (teilaspekt === "route" || teilaspekt === "positions" || teilaspekt === "drives") {
        const tripId = url.searchParams.get("tripId");
        const reise = reisen.find((r) => r.id === tripId);
        if (!reise) return reply(request, env, { error: "Diese Reise ist über diesen Link nicht freigegeben." }, 403);
        const deviceId = await ermittleGeraeteId(env, reise);
        if (!deviceId) return reply(request, env, { error: "Für diese Reise ist kein Gerät hinterlegt." }, 404);

        if (teilaspekt === "positions") {
          // Live-Position nur, solange die Reise wirklich noch läuft.
          if (reise.end_at) return reply(request, env, []);
          return reply(request, env, await positionsQuelle(env, "positions", { deviceId }));
        }
        // Zeitraum kommt strikt aus der Reise selbst, nie von der Anfrage —
        // sonst ließe sich über den Link jeder beliebige Zeitraum abfragen.
        const von = reise.start_at;
        const bis = reise.end_at || new Date().toISOString();

        if (teilaspekt === "drives") {
          // Etappe/Abstecher-Einordnung der Fahrten — ohne die zeigt die
          // Karte sonst auch Versorgungs-/Abstecherfahrten als Teil der
          // durchgehenden Streckenfarbe (Standardfilter ist "nur Etappen").
          const roh = await positionsQuelle(env, "drives", { deviceId, from: von, to: bis });
          const { results: zuordnungen } = await env.DB.prepare(
            "SELECT drive_key, kind FROM drive_assignments WHERE drive_key LIKE ?"
          ).bind(`${deviceId}|%`).all();
          const kindByKey = Object.fromEntries((zuordnungen || []).map((z) => [z.drive_key, z.kind]));
          const drives = (Array.isArray(roh) ? roh : []).flatMap((t, i) => {
            const from = t.startTime || t.start_time || t.from || t.start;
            if (!from) return [];
            const to = t.endTime || t.end_time || t.to || t.end || null;
            const key = `${deviceId}|${from}`;
            return [{
              id: `drive_${i}_${from}`, key, from, to, tripId: reise.id,
              kind: kindByKey[key] === "abstecher" ? "abstecher" : "etappe",
            }];
          });
          return reply(request, env, drives);
        }

        const data = await positionsQuelle(env, "route", { deviceId, from: von, to: bis });
        return reply(request, env, data);
      }

      // Foto ausliefern — nur bei "Karte + Logbuch" und nur, wenn es
      // tatsächlich zu einer der freigegebenen Reisen gehört. Fotos haben
      // keine eigene trip_id mehr (wie Besuche/Notizen: Reise-Zugehörigkeit
      // wird live aus der Zeit berechnet) — also über den verknüpften
      // Besuch/die Notiz nachsehen, wann das Foto tatsächlich entstand.
      if (teilaspekt === "photos" && seg[4]) {
        if (freigabe.scope !== "karte_logbuch") return reply(request, env, { error: "Über diesen Link nicht freigegeben" }, 403);
        await ensureTagebuch(env);
        const { results } = await env.DB.prepare(
          `SELECT p.r2_key, COALESCE(p.taken_at, b.occurred_at, n.occurred_at) AS wann, tb.trip_id AS tagebuch_reise
           FROM photos p
           LEFT JOIN besuche b ON b.id = p.besuch_id
           LEFT JOIN notes n ON n.id = p.note_id
           LEFT JOIN tagebuch tb ON tb.id = p.tagebuch_id
           WHERE p.id = ?`
        ).bind(seg[4]).all();
        const foto = results?.[0];
        // Tagebuchfotos gehören über ihren Eintrag zur Reise, nicht über die Aufnahmezeit.
        const freigegeben = foto?.tagebuch_reise
          ? reisen.some((r) => r.id === foto.tagebuch_reise)
          : faelltInReisezeitraum(foto?.wann, reisen);
        if (!foto?.r2_key || !freigegeben) {
          return reply(request, env, { error: "Foto nicht gefunden" }, 404);
        }
        return await liefereFoto(request, env, foto.r2_key);
      }

      // Übersicht: Reise(n) + (nur bei entsprechendem Umfang) Logbuch.
      // Kategorien sind reine Beschriftungen (Name/Farbe), nichts Vertrauliches
      // — ohne sie kennt die Gast-Ansicht nur die rohe category_id.
      // Besuche/Notizen/Fotos werden komplett geladen und dann wie beim
      // eigenen Konto per Zeitfenster gefiltert (faelltInReisezeitraum) —
      // dieselbe Live-Berechnung wie bei Fahrten, nicht über eine
      // gespeicherte trip_id (die es hier nicht mehr gibt).
      let orte = [];
      let notizen = [];
      let kategorien = [];
      let fotos = [];
      let tagebuch = [];
      if (freigabe.scope === "karte_logbuch" && reisen.length) {
        await ensureTagebuch(env);
        const alleBesuche = (await env.DB.prepare(
          `SELECT b.id, b.ort_id, o.title, o.address, o.note, o.category_id, o.rating, o.lat, o.lon,
                  b.source, b.kind, b.occurred_at, b.nights, b.weather, b.stop_key
           FROM besuche b JOIN orte o ON o.id = b.ort_id`
        ).all()).results;
        orte = alleBesuche.filter((b) => faelltInReisezeitraum(b.occurred_at, reisen));

        const alleNotizen = (await env.DB.prepare("SELECT * FROM notes").all()).results;
        notizen = alleNotizen.filter((n) => faelltInReisezeitraum(n.occurred_at, reisen));

        kategorien = (await env.DB.prepare("SELECT id, name, color FROM categories").all()).results;

        const alleFotos = (await env.DB.prepare(
          `SELECT p.id, p.besuch_id, p.note_id, p.tagebuch_id, p.taken_at, p.lat, p.lon, p.width, p.height,
                  COALESCE(p.taken_at, b.occurred_at, n.occurred_at) AS wann, tb.trip_id AS tagebuch_reise
           FROM photos p
           LEFT JOIN besuche b ON b.id = p.besuch_id
           LEFT JOIN notes n ON n.id = p.note_id
           LEFT JOIN tagebuch tb ON tb.id = p.tagebuch_id`
        ).all()).results;
        fotos = alleFotos
          .filter((f) => (f.tagebuch_reise ? reisen.some((r) => r.id === f.tagebuch_reise) : faelltInReisezeitraum(f.wann, reisen)))
          .map(({ wann, tagebuch_reise, ...f }) => f);

        const alleEintraege = (await env.DB.prepare(
          "SELECT id, trip_id, day_key, blocks, author, created_at, updated_at FROM tagebuch"
        ).all()).results;
        tagebuch = alleEintraege.filter((e) => reisen.some((r) => r.id === e.trip_id));
      }

      // Sichtbarkeit protokollieren — bewusst nur beim eigentlichen
      // Seitenaufruf, nicht bei jedem Live-Poll über /route bzw. /positions.
      await env.DB.prepare("UPDATE trip_shares SET last_used_at = ?, view_count = view_count + 1 WHERE id = ?")
        .bind(Date.now(), freigabe.id).run();

      return reply(request, env, {
        scope: freigabe.scope,
        alleReisen: !freigabe.trip_id,
        label: freigabe.label,
        trips: reisen,
        places: orte,
        notes: notizen,
        categories: kategorien,
        photos: fotos,
        tagebuch,
      });
    }

    const sitzung = await aktuelleSitzung(request, env);
    if (!sitzung) return reply(request, env, { error: "nicht angemeldet" }, 401);

    try {
      /* ---- Positionen: Traccar-Proxy oder eigene positions-Tabelle ---- */
      if (seg[1] === "positions") {
        return reply(request, env, await positionsQuelle(env, "positions", { deviceId: url.searchParams.get("deviceId") }));
      }
      if (seg[1] === "route")  return await rangeReport(request, env, url, "route");
      if (seg[1] === "stops")  return await rangeReport(request, env, url, "stops");
      if (seg[1] === "drives") return await rangeReport(request, env, url, "drives");
      if (seg[1] === "devices") return reply(request, env, await positionsQuelle(env, "devices"));

      /* ---- D1: Reisen ---- */
      if (seg[1] === "trips") {
        const id = seg[2];
        if (request.method === "GET" && !id) {
          const { results } = await env.DB.prepare(
            "SELECT * FROM trips ORDER BY (end_at IS NULL) DESC, start_at DESC"
          ).all();
          return reply(request, env, results);
        }
        if (request.method === "POST") {
          const b = await request.json();
          const check = validateTrip(b);
          if (!check.ok) return reply(request, env, { error: check.errors.join("; ") }, 400);
          const nid = b.id || uid();
          try {
            await env.DB.prepare(
              "INSERT INTO trips (id, name, start_at, end_at, vehicle_id) VALUES (?,?,?,?,?)"
            ).bind(nid, b.name || "Neue Reise", b.start_at || new Date().toISOString(), b.end_at ?? null, b.vehicle_id ?? null).run();
          } catch (e) {
            if (/UNIQUE constraint failed: trips\.is_active/.test(String(e))) {
              return reply(request, env, { error: "Es läuft bereits eine Reise. Beende sie zuerst." }, 409);
            }
            throw e;
          }
          return reply(request, env, { id: nid }, 201);
        }
        if (request.method === "PATCH" && id) {
          const b = await request.json();
          const check = validateTrip(b, { partial: true });
          if (!check.ok) return reply(request, env, { error: check.errors.join("; ") }, 400);
          const fields = [], vals = [];
          for (const k of ["name", "start_at", "end_at", "vehicle_id"]) {
            if (k in b) { fields.push(`${k} = ?`); vals.push(b[k]); }
          }
          if (!fields.length) return reply(request, env, { error: "nichts zu ändern" }, 400);
          fields.push("updated_at = datetime('now')");
          try {
            await env.DB.prepare(`UPDATE trips SET ${fields.join(", ")} WHERE id = ?`).bind(...vals, id).run();
          } catch (e) {
            if (/UNIQUE constraint failed: trips\.is_active/.test(String(e))) {
              return reply(request, env, { error: "Es läuft bereits eine Reise. Beende sie zuerst." }, 409);
            }
            throw e;
          }
          return reply(request, env, { ok: true });
        }
        if (request.method === "DELETE" && id) {
          await env.DB.prepare("DELETE FROM trips WHERE id = ?").bind(id).run();
          return reply(request, env, { ok: true });
        }
      }

      /* ---- D1: Reisen teilen (Verwaltung — Erzeugen/Auflisten/Widerrufen) ----
         Die eigentliche Auslieferung an Gäste läuft öffentlich über
         /api/share/:token weiter oben, vor dem Anmelde-Gate. */
      if (seg[1] === "shares") {
        await ensureShares(env);
        const id = seg[2];
        if (request.method === "GET" && !id) {
          const { results } = await env.DB.prepare(
            "SELECT s.*, t.name AS trip_name FROM trip_shares s LEFT JOIN trips t ON t.id = s.trip_id ORDER BY s.created_at DESC"
          ).all();
          return reply(request, env, results);
        }
        if (request.method === "POST" && !id) {
          const b = await request.json().catch(() => ({}));
          const scope = b.scope || "karte";
          if (!isValidShareScope(scope)) return reply(request, env, { error: "Ungültiger Umfang" }, 400);
          if (b.tripId) {
            const { results } = await env.DB.prepare("SELECT id FROM trips WHERE id = ?").bind(b.tripId).all();
            if (!results?.length) return reply(request, env, { error: "Reise nicht gefunden" }, 404);
          }
          const label = typeof b.label === "string" ? b.label.trim().slice(0, 120) || null : null;
          let expiresAt = null;
          if (b.expiresInDays != null) {
            const tage = Number(b.expiresInDays);
            if (!Number.isFinite(tage) || tage <= 0 || tage > 365) {
              return reply(request, env, { error: "Ablauf muss zwischen 1 und 365 Tagen liegen" }, 400);
            }
            expiresAt = Date.now() + tage * 86_400_000;
          }
          const token = newShareToken();
          const nid = uid();
          await env.DB.prepare(
            "INSERT INTO trip_shares (id, token, token_hash, trip_id, scope, label, expires_at) VALUES (?,?,?,?,?,?,?)"
          ).bind(nid, token, await hashToken(token), b.tripId || null, scope, label, expiresAt).run();
          return reply(request, env, { id: nid, token }, 201);
        }
        if (request.method === "DELETE" && id) {
          await env.DB.prepare("UPDATE trip_shares SET revoked_at = ? WHERE id = ?").bind(Date.now(), id).run();
          return reply(request, env, { ok: true });
        }
        return reply(request, env, { error: "nicht gefunden" }, 404);
      }

      /* ---- D1: Fahrt-Zuordnungen ----
         Die Fahrt selbst bleibt in Traccar; hier steht nur, was von der
         Automatik abweicht bzw. was sich nicht neu berechnen lässt:
         - assignment "manual" + trip_id gesetzt = dieser Reise.
         - assignment "manual" + trip_id NULL = ausdrücklich Alltagsfahrt.
         - assignment "auto" = Zeitraum-Automatik entscheidet.
         - trip_id "auto" (nur beim Schreiben) nimmt die Zuordnung zurück.
         - kind "etappe" oder "abstecher": fachliche Einordnung der Fahrt.
         - weather: Wetter am Startpunkt, einmal geholt und hier zwischengespeichert. */
      if (seg[1] === "drive-assignments") {
        if (request.method === "GET") {
          await ensureDriveAssignmentMode(env);
          const { results } = await env.DB.prepare("SELECT drive_key, trip_id, weather, assignment, kind FROM drive_assignments").all();
          return reply(request, env, results);
        }
        if (request.method === "PUT" || request.method === "PATCH") {
          await ensureDriveAssignmentMode(env);
          const b = await request.json().catch(() => ({}));
          const key = typeof b?.drive_key === "string" ? b.drive_key.trim() : "";
          if (!key || key.length > 200) return reply(request, env, { error: "drive_key fehlt oder ist zu lang" }, 400);

          // Bestehende Zeile lesen — ein Feld darf gesetzt werden, ohne das
          // andere zu verlieren (z. B. Wetter cachen, ohne die Zuordnung anzufassen).
          const { results } = await env.DB.prepare(
            "SELECT trip_id, weather, assignment, kind FROM drive_assignments WHERE drive_key = ?"
          ).bind(key).all();
          const vorhanden = results?.[0] || { trip_id: null, weather: null, assignment: "auto", kind: "etappe" };

          let tripId = vorhanden.trip_id;
          let assignment = vorhanden.assignment || (vorhanden.trip_id ? "manual" : "auto");
          let kind = vorhanden.kind === "abstecher" ? "abstecher" : "etappe";
          if ("trip_id" in b) {
            if (b.trip_id === "auto") {
              tripId = null;
              assignment = "auto";
            } else if (b.trip_id == null) {
              tripId = null;
              assignment = "manual";
            } else {
              tripId = String(b.trip_id);
              assignment = "manual";
            }
            if (tripId) {
              const treffer = await env.DB.prepare("SELECT id FROM trips WHERE id = ?").bind(tripId).all();
              if (!treffer.results?.length) return reply(request, env, { error: "Reise nicht gefunden" }, 404);
            }
          }
          if ("kind" in b) {
            if (!["etappe", "abstecher"].includes(b.kind)) {
              return reply(request, env, { error: "Fahrtart muss etappe oder abstecher sein" }, 400);
            }
            kind = b.kind;
          }
          let weather = vorhanden.weather;
          if ("weather" in b) {
            if (b.weather != null && (typeof b.weather !== "string" || b.weather.length > 1000)) {
              return reply(request, env, { error: "weather zu lang" }, 400);
            }
            weather = b.weather ?? null;
          }

          await env.DB.prepare(
            "INSERT INTO drive_assignments (drive_key, trip_id, assignment, kind, weather) VALUES (?,?,?,?,?) " +
            "ON CONFLICT(drive_key) DO UPDATE SET trip_id = excluded.trip_id, assignment = excluded.assignment, kind = excluded.kind, weather = excluded.weather"
          ).bind(key, tripId, assignment, kind, weather).run();
          return reply(request, env, { ok: true, zuordnung: assignment === "manual" ? "manuell" : "automatisch" });
        }
      }

      /* ---- Automatische Übernachtungserkennung: verworfene Vorschläge ----
         Ein gelöschter Vorschlag darf beim nächsten Laden nicht wiederkehren. */
      if (seg[1] === "ignored-stops") {
        if (request.method === "GET") {
          const { results } = await env.DB.prepare("SELECT stop_key FROM ignored_stops").all();
          return reply(request, env, (results || []).map((r) => r.stop_key));
        }
      }

      /* ---- D1: Orte ---- */
      /* ---- D1: Besuche (Aufenthalte an einem Ort — Orte selbst sind der
       * Katalog dahinter, siehe ensureOrteBesuche/orte). Der Endpunkt
       * bleibt bewusst EIN Aufruf für die Ansicht (Ort+Besuch geflacht wie
       * früher bei "places") — title/note/category_id/rating/lat/lon
       * gehören zum Ort (gemeinsam für alle Besuche dort), alles andere
       * zum einzelnen Besuch. Ohne ort_id im Body wird ein neuer Ort
       * angelegt (Normalfall); mit ort_id wird ein bestehender wieder-
       * verwendet (z. B. wenn die Nähe-Erkennung schon einen fand). */
      if (seg[1] === "besuche") {
        await ensureOrteBesuche(env);
        const id = seg[2];
        if (request.method === "GET" && !id) {
          const { results } = await env.DB.prepare(
            `SELECT b.id, b.ort_id, o.title, o.address, o.note, o.category_id, o.rating, o.lat, o.lon,
                    b.source, b.kind, b.occurred_at, b.nights, b.weather, b.stop_key
             FROM besuche b JOIN orte o ON o.id = b.ort_id
             ORDER BY b.occurred_at DESC, b.created_at DESC`
          ).all();
          return reply(request, env, results);
        }
        if (request.method === "POST") {
          const b = await request.json();
          let ortId = b.ort_id || null;
          if (ortId) {
            if (!isValidId(ortId)) return reply(request, env, { error: "ort_id ist ungültig" }, 400);
            const { results } = await env.DB.prepare("SELECT id FROM orte WHERE id = ?").bind(ortId).all();
            if (!results?.length) return reply(request, env, { error: "Ort nicht gefunden" }, 404);
          } else {
            const checkOrt = validateOrt(b);
            if (!checkOrt.ok) return reply(request, env, { error: checkOrt.errors.join("; ") }, 400);
          }
          // Alle Prüfungen (auch fürs ggf. neue Ort) VOR jedem Schreiben
          // abschließen — sonst bliebe bei einem später scheiternden Check
          // ein gerade erst angelegter Ort als Datenleiche zurück, nie mit
          // einem Besuch verknüpft. Echter Fund, 6. September 2026: 353
          // genau solcher verwaisten Orte, weil die Nächte-Prüfung
          // wiederholt NACH der Ort-Anlage fehlschlug (autoImportCurrentStay
          // versuchte es alle paar Minuten erneut, solange geparkt).
          const neueOrtId = ortId || uid();
          const checkBesuch = validateBesuch({ ...b, ort_id: neueOrtId });
          if (!checkBesuch.ok) return reply(request, env, { error: checkBesuch.errors.join("; ") }, 400);
          // Ein Besuch, der aus einem erkannten Stopp stammt, bekommt eine
          // stop_key — ein zweiter Versuch, denselben Stopp anzulegen,
          // prallt am Unique-Index ab.
          if (b.stop_key) {
            const bereits = await env.DB.prepare("SELECT id FROM besuche WHERE stop_key = ?").bind(b.stop_key).all();
            if (bereits.results?.length) return reply(request, env, { error: "Für diesen Stopp gibt es bereits einen Besuch" }, 409);
          }
          if (!ortId) {
            ortId = neueOrtId;
            await env.DB.prepare(
              "INSERT INTO orte (id, title, address, note, category_id, rating, lat, lon) VALUES (?,?,?,?,?,?,?,?)"
            ).bind(ortId, b.title || "(ohne Titel)", b.address ?? null, b.note ?? null, b.category_id ?? null, b.rating ?? null, b.lat, b.lon).run();
          }
          const nid = b.id || uid();
          await env.DB.prepare(
            `INSERT INTO besuche (id, ort_id, source, kind, occurred_at, nights, weather, stop_key)
             VALUES (?,?,?,?,?,?,?,?)`
          ).bind(
            nid, ortId, b.source || "manuell", b.kind || "manual", b.occurred_at ?? null,
            Number.isInteger(b.nights) ? b.nights : 1, b.weather ?? null, b.stop_key ?? null
          ).run();
          return reply(request, env, { id: nid, ort_id: ortId }, 201);
        }
        if (request.method === "PATCH" && id) {
          const b = await request.json();
          const checkOrt = validateOrt(b, { partial: true });
          if (!checkOrt.ok) return reply(request, env, { error: checkOrt.errors.join("; ") }, 400);
          const checkBesuch = validateBesuch(b, { partial: true });
          if (!checkBesuch.ok) return reply(request, env, { error: checkBesuch.errors.join("; ") }, 400);

          const { results: besuchRows } = await env.DB.prepare("SELECT ort_id FROM besuche WHERE id = ?").bind(id).all();
          if (!besuchRows?.length) return reply(request, env, { error: "Besuch nicht gefunden" }, 404);
          const ortId = besuchRows[0].ort_id;

          const ortFields = [], ortVals = [];
          for (const k of ["title", "address", "note", "category_id", "rating", "lat", "lon"]) {
            if (k in b) { ortFields.push(`${k} = ?`); ortVals.push(b[k]); }
          }
          if (ortFields.length) {
            ortFields.push("updated_at = datetime('now')");
            await env.DB.prepare(`UPDATE orte SET ${ortFields.join(", ")} WHERE id = ?`).bind(...ortVals, ortId).run();
          }

          const besuchFields = [], besuchVals = [];
          for (const k of ["source", "kind", "occurred_at", "nights", "weather"]) {
            if (k in b) { besuchFields.push(`${k} = ?`); besuchVals.push(b[k]); }
          }
          if (besuchFields.length) {
            besuchFields.push("updated_at = datetime('now')");
            await env.DB.prepare(`UPDATE besuche SET ${besuchFields.join(", ")} WHERE id = ?`).bind(...besuchVals, id).run();
          }

          if (!ortFields.length && !besuchFields.length) return reply(request, env, { error: "nichts zu ändern" }, 400);
          return reply(request, env, { ok: true });
        }
        if (request.method === "DELETE" && id) {
          // Stammt der Besuch aus einer automatischen Erkennung, merkt sich
          // die App das Verwerfen — sonst schlüge derselbe Stopp beim
          // nächsten Laden wieder als Übernachtung vor.
          const { results } = await env.DB.prepare("SELECT ort_id, stop_key FROM besuche WHERE id = ?").bind(id).all();
          const row = results?.[0];
          if (row?.stop_key) await env.DB.prepare("INSERT OR IGNORE INTO ignored_stops (stop_key) VALUES (?)").bind(row.stop_key).run();
          await env.DB.prepare("DELETE FROM besuche WHERE id = ?").bind(id).run();
          // Ein Ort ohne verbleibende Besuche wäre nur noch eine Datenleiche
          // im Katalog — mit aufräumen (entspricht dem alten Verhalten
          // "Ort löschen = weg" für den häufigen Fall: ein Besuch, ein Ort).
          if (row?.ort_id) {
            const { results: rest } = await env.DB.prepare("SELECT COUNT(*) AS n FROM besuche WHERE ort_id = ?").bind(row.ort_id).all();
            if (!rest?.[0]?.n) await env.DB.prepare("DELETE FROM orte WHERE id = ?").bind(row.ort_id).run();
          }
          return reply(request, env, { ok: true });
        }
      }

      /* ---- Wetter zu Ort und Zeit ---- */
      if (seg[1] === "weather" && request.method === "GET") {
        const pruefung = validateCoords(url.searchParams.get("lat"), url.searchParams.get("lon"));
        if (!pruefung.ok) return reply(request, env, { error: pruefung.errors.join("; ") }, 400);
        try {
          return reply(request, env, await holeWetter(pruefung.lat, pruefung.lon, url.searchParams.get("at")));
        } catch (e) {
          // Ohne Wetter geht der Eintrag trotzdem — deshalb kein harter Fehler.
          return reply(request, env, { error: String(e.message || e) }, 503);
        }
      }

      /* ---- Namensvorschlag zu Koordinaten (Reverse-Geocoding) ---- */
      if (seg[1] === "geocode" && request.method === "GET") {
        const pruefung = validateCoords(url.searchParams.get("lat"), url.searchParams.get("lon"));
        if (!pruefung.ok) return reply(request, env, { error: pruefung.errors.join("; ") }, 400);
        try {
          const name = await holeOrtsname(pruefung.lat, pruefung.lon);
          return reply(request, env, { name });
        } catch (e) {
          // Ohne Namensvorschlag bleibt der Platzhaltertitel stehen — kein harter Fehler.
          return reply(request, env, { error: String(e.message || e) }, 503);
        }
      }

      /* ---- D1: Notizen ---- */
      if (seg[1] === "notes") {
        await ensureOrteBesuche(env);
        const id = seg[2];
        if (request.method === "GET" && !id) {
          const { results } = await env.DB.prepare("SELECT * FROM notes ORDER BY occurred_at").all();
          return reply(request, env, results);
        }
        if (request.method === "POST") {
          const b = await request.json();
          const check = validateNote(b);
          if (!check.ok) return reply(request, env, { error: check.errors.join("; ") }, 400);
          const nid = b.id || uid();
          await env.DB.prepare(
            `INSERT INTO notes (id, besuch_id, title, text, occurred_at, lat, lon, source, weather)
             VALUES (?,?,?,?,?,?,?,?,?)`
          ).bind(
            nid, b.besuch_id ?? null, b.title.trim(), b.text, b.occurred_at ?? null,
            b.lat ?? null, b.lon ?? null, b.source || "handy", b.weather ?? null
          ).run();
          return reply(request, env, { id: nid }, 201);
        }
        if (request.method === "PATCH" && id) {
          const b = await request.json();
          const check = validateNote(b, { partial: true });
          if (!check.ok) return reply(request, env, { error: check.errors.join("; ") }, 400);
          const fields = [], vals = [];
          for (const k of ["besuch_id", "title", "text", "occurred_at", "lat", "lon", "source", "weather"]) {
            if (k in b) { fields.push(`${k} = ?`); vals.push(b[k]); }
          }
          if (!fields.length) return reply(request, env, { error: "nichts zu ändern" }, 400);
          fields.push("updated_at = datetime('now')");
          await env.DB.prepare(`UPDATE notes SET ${fields.join(", ")} WHERE id = ?`).bind(...vals, id).run();
          return reply(request, env, { ok: true });
        }
        if (request.method === "DELETE" && id) {
          await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(id).run();
          return reply(request, env, { ok: true });
        }
      }

      /* ---- D1: Tagebuch — ein Eintrag je Reise und Kalendertag ---- */
      if (seg[1] === "tagebuch") {
        await ensureTagebuch(env);
        const id = seg[2];
        if (request.method === "GET" && !id) {
          const { results } = await env.DB.prepare(
            "SELECT id, trip_id, day_key, blocks, author, created_at, updated_at FROM tagebuch ORDER BY day_key"
          ).all();
          return reply(request, env, results);
        }
        if (request.method === "PUT" && !id) {
          const b = await request.json();
          const check = validateTagebuch(b);
          if (!check.ok) return reply(request, env, { error: check.errors.join("; ") }, 400);
          const { results: reise } = await env.DB.prepare("SELECT id FROM trips WHERE id = ?").bind(b.trip_id).all();
          if (!reise?.length) return reply(request, env, { error: "Reise nicht gefunden" }, 404);
          const blocks = JSON.stringify(check.blocks);
          const { results: vorhanden } = await env.DB.prepare(
            "SELECT id FROM tagebuch WHERE trip_id = ? AND day_key = ?"
          ).bind(b.trip_id, b.day_key).all();
          if (vorhanden?.length) {
            // Der erste Schreibende bleibt als Autor stehen, auch wenn jemand anderes nachbessert.
            await env.DB.prepare("UPDATE tagebuch SET blocks = ?, updated_at = datetime('now') WHERE id = ?")
              .bind(blocks, vorhanden[0].id).run();
            return reply(request, env, { id: vorhanden[0].id, neu: false });
          }
          const nid = uid();
          await env.DB.prepare(
            "INSERT INTO tagebuch (id, trip_id, day_key, blocks, author) VALUES (?,?,?,?,?)"
          ).bind(nid, b.trip_id, b.day_key, blocks, sitzung.username).run();
          return reply(request, env, { id: nid, neu: true }, 201);
        }
        if (request.method === "DELETE" && id) {
          const { results: fotos } = await env.DB.prepare("SELECT r2_key FROM photos WHERE tagebuch_id = ?").bind(id).all();
          await env.DB.prepare("DELETE FROM photos WHERE tagebuch_id = ?").bind(id).run();
          await env.DB.prepare("DELETE FROM tagebuch WHERE id = ?").bind(id).run();
          if (env.PHOTOS) for (const f of fotos || []) await env.PHOTOS.delete(f.r2_key).catch(() => {});
          return reply(request, env, { ok: true });
        }
        return reply(request, env, { error: "nicht gefunden" }, 404);
      }

      /* ---- D1 + R2: Fotos zu Besuchen, Notizen und Tagebuch ---- */
      if (seg[1] === "photos") {
        await ensureTagebuch(env);
        const id = seg[2];

        if (request.method === "GET" && !id) {
          // Nur Metadaten — die Bilddatei selbst kommt über GET /api/photos/:id.
          const { results } = await env.DB.prepare(
            "SELECT id, besuch_id, note_id, tagebuch_id, taken_at, lat, lon, width, height FROM photos ORDER BY created_at"
          ).all();
          return reply(request, env, results);
        }

        if (request.method === "GET" && id) {
          const { results } = await env.DB.prepare("SELECT r2_key FROM photos WHERE id = ?").bind(id).all();
          const key = results?.[0]?.r2_key;
          if (!key) return reply(request, env, { error: "Foto nicht gefunden" }, 404);
          return await liefereFoto(request, env, key);
        }

        if (request.method === "POST" && !id) {
          // Erst prüfen, dann erst nach R2 fragen — so bleiben Fehlermeldungen
          // aussagekräftig, auch bevor der Speicher eingerichtet ist.
          let form;
          try { form = await request.formData(); } catch { return reply(request, env, { error: "Ungültige Anfrage" }, 400); }
          const file = form.get("file");
          if (!file || typeof file.arrayBuffer !== "function") return reply(request, env, { error: "Keine Datei erhalten" }, 400);
          if (!/^image\//.test(file.type || "")) return reply(request, env, { error: "Nur Bilder sind erlaubt" }, 400);
          if (file.size > MAX_PHOTO_BYTES) return reply(request, env, { error: "Datei zu groß (max. 8 MB)" }, 413);

          const besuchId = form.get("besuch_id") || null;
          const noteId = form.get("note_id") || null;
          const tagebuchId = form.get("tagebuch_id") || null;
          if (!besuchId && !noteId && !tagebuchId) return reply(request, env, { error: "Foto braucht einen Besuch, eine Notiz oder einen Tagebucheintrag" }, 400);

          if (besuchId) {
            const { results } = await env.DB.prepare("SELECT id FROM besuche WHERE id = ?").bind(besuchId).all();
            if (!results?.length) return reply(request, env, { error: "Besuch nicht gefunden" }, 404);
          } else if (noteId) {
            const { results } = await env.DB.prepare("SELECT id FROM notes WHERE id = ?").bind(noteId).all();
            if (!results?.length) return reply(request, env, { error: "Notiz nicht gefunden" }, 404);
          } else {
            const { results } = await env.DB.prepare("SELECT id FROM tagebuch WHERE id = ?").bind(tagebuchId).all();
            if (!results?.length) return reply(request, env, { error: "Tagebucheintrag nicht gefunden" }, 404);
          }

          if (!env.PHOTOS) return reply(request, env, { error: "Fotospeicher ist noch nicht eingerichtet" }, 503);
          const nid = uid();
          const r2Key = `fotos/${nid}.${/png/.test(file.type) ? "png" : "jpg"}`;
          await env.PHOTOS.put(r2Key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || "image/jpeg" } });

          const num = (v) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
          const takenAt = form.get("taken_at") || null;
          const lat = num(form.get("lat"));
          const lon = num(form.get("lon"));
          const width = num(form.get("width"));
          const height = num(form.get("height"));

          try {
            await env.DB.prepare(
              "INSERT INTO photos (id, besuch_id, note_id, tagebuch_id, r2_key, taken_at, lat, lon, width, height) VALUES (?,?,?,?,?,?,?,?,?,?)"
            ).bind(nid, besuchId, noteId, tagebuchId, r2Key, takenAt, lat, lon, width, height).run();
          } catch (e) {
            await env.PHOTOS.delete(r2Key).catch(() => {}); // kein verwaistes Objekt in R2 zurücklassen
            throw e;
          }
          return reply(request, env, { id: nid }, 201);
        }

        if (request.method === "DELETE" && id) {
          const { results } = await env.DB.prepare("SELECT r2_key FROM photos WHERE id = ?").bind(id).all();
          const key = results?.[0]?.r2_key;
          await env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id).run();
          if (key && env.PHOTOS) {
            // R2-Aufräumen darf ein bereits erfolgtes Löschen in D1 nicht rückgängig machen.
            await env.PHOTOS.delete(key).catch(() => {});
          }
          return reply(request, env, { ok: true });
        }

        return reply(request, env, { error: "nicht gefunden" }, 404);
      }

      /* ---- D1: Geräteübergreifende Einstellungen ---- */
      if (seg[1] === "settings") {
        if (request.method === "GET") {
          const { results } = await env.DB.prepare("SELECT data FROM app_settings WHERE id = 1").all();
          let data = {};
          try { data = JSON.parse(results?.[0]?.data || "{}"); } catch { data = {}; }
          return reply(request, env, data);
        }
        if (request.method === "PUT" || request.method === "PATCH") {
          const b = await request.json();
          if (!b || typeof b !== "object" || Array.isArray(b)) {
            return reply(request, env, { error: "Objekt erwartet" }, 400);
          }
          const text = JSON.stringify(b);
          if (text.length > 20000) return reply(request, env, { error: "Einstellungen zu umfangreich" }, 413);
          await env.DB.prepare(
            "INSERT INTO app_settings (id, data, updated_at) VALUES (1, ?, datetime('now')) " +
            "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
          ).bind(text).run();
          return reply(request, env, { ok: true });
        }
      }

      /* ---- D1: Kategorien ---- */
      if (seg[1] === "categories") {
        const id = seg[2];
        if (request.method === "GET" && !id) {
          const { results } = await env.DB.prepare("SELECT * FROM categories ORDER BY sort, name").all();
          return reply(request, env, results);
        }
        // Lesen bleibt für alle offen (Orte/Karte brauchen die Kategorien),
        // Ändern nur für Admins — dieselbe gemeinsame Konfiguration für alle.
        await ensureUserAdmin(env);
        if (!(await istAdmin(env, sitzung.userId))) return reply(request, env, { error: "nur für Admins" }, 403);
        if (request.method === "POST") {
          const b = await request.json();
          const check = validateCategory(b);
          if (!check.ok) return reply(request, env, { error: check.errors.join("; ") }, 400);
          const nid = b.id || uid();
          await env.DB.prepare("INSERT OR REPLACE INTO categories (id, name, color, sort) VALUES (?,?,?,?)")
            .bind(nid, b.name.trim(), b.color || "#888888", Number.isInteger(b.sort) ? b.sort : 0).run();
          return reply(request, env, { id: nid }, 201);
        }
        if (request.method === "PATCH" && id) {
          const b = await request.json();
          const check = validateCategory(b, { partial: true });
          if (!check.ok) return reply(request, env, { error: check.errors.join("; ") }, 400);
          const fields = [], vals = [];
          for (const k of ["name", "color", "sort"]) if (k in b) { fields.push(`${k} = ?`); vals.push(b[k]); }
          if (!fields.length) return reply(request, env, { error: "nichts zu ändern" }, 400);
          await env.DB.prepare(`UPDATE categories SET ${fields.join(", ")} WHERE id = ?`).bind(...vals, id).run();
          return reply(request, env, { ok: true });
        }
        if (request.method === "DELETE" && id) {
          await ensureOrteBesuche(env);
          const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM orte WHERE category_id = ?").bind(id).all();
          if (results?.[0]?.n > 0) {
            return reply(request, env, { error: `Wird von ${results[0].n} Ort(en) genutzt` }, 409);
          }
          await env.DB.prepare("DELETE FROM categories WHERE id = ?").bind(id).run();
          return reply(request, env, { ok: true });
        }
      }

      /* ---- D1: Fahrzeuge ---- */
      if (seg[1] === "vehicles") {
        const id = seg[2];
        if (request.method === "GET" && !id) {
          const { results } = await env.DB.prepare("SELECT * FROM vehicles ORDER BY active DESC, name").all();
          return reply(request, env, results);
        }
        // Lesen bleibt für alle offen (aktives Fahrzeug zeigt sich in der
        // Kopfzeile), Ändern nur für Admins.
        await ensureUserAdmin(env);
        if (!(await istAdmin(env, sitzung.userId))) return reply(request, env, { error: "nur für Admins" }, 403);
        if (request.method === "POST") {
          const b = await request.json();
          const check = validateVehicle(b);
          if (!check.ok) return reply(request, env, { error: check.errors.join("; ") }, 400);
          const nid = b.id || uid();
          await env.DB.prepare("INSERT OR REPLACE INTO vehicles (id, name, traccar_device_id, active) VALUES (?,?,?,?)")
            .bind(nid, b.name.trim(), b.traccar_device_id ?? null, b.active ? 1 : 0).run();
          if (b.active) await env.DB.prepare("UPDATE vehicles SET active = 0 WHERE id != ?").bind(nid).run();
          return reply(request, env, { id: nid }, 201);
        }
        if (request.method === "PATCH" && id) {
          const b = await request.json();
          const check = validateVehicle(b, { partial: true });
          if (!check.ok) return reply(request, env, { error: check.errors.join("; ") }, 400);
          const fields = [], vals = [];
          for (const k of ["name", "traccar_device_id", "active"]) {
            if (k in b) { fields.push(`${k} = ?`); vals.push(k === "active" ? (b[k] ? 1 : 0) : b[k]); }
          }
          if (!fields.length) return reply(request, env, { error: "nichts zu ändern" }, 400);
          await env.DB.prepare(`UPDATE vehicles SET ${fields.join(", ")} WHERE id = ?`).bind(...vals, id).run();
          // Es kann nur ein Fahrzeug aktiv sein.
          if (b.active) await env.DB.prepare("UPDATE vehicles SET active = 0 WHERE id != ?").bind(id).run();
          return reply(request, env, { ok: true });
        }
        if (request.method === "DELETE" && id) {
          await env.DB.prepare("DELETE FROM vehicles WHERE id = ?").bind(id).run();
          return reply(request, env, { ok: true });
        }
      }

      /* ---- D1: Ingest-Lernmodus und bekannte Geräte ---- */
      if (seg[1] === "ingest") {
        await ensureUserAdmin(env);
        if (!(await istAdmin(env, sitzung.userId))) return reply(request, env, { error: "nur für Admins" }, 403);

        if (request.method === "GET" && !seg[2]) {
          const { results: settings } = await env.DB.prepare(
            "SELECT value FROM ingest_settings WHERE key = 'learning_until'"
          ).all();
          const learningUntil = Number(settings?.[0]?.value || 0);
          const { results: devices } = await env.DB.prepare(
            "SELECT * FROM known_devices ORDER BY last_seen DESC LIMIT 50"
          ).all();
          return reply(request, env, {
            learningUntil: Number.isFinite(learningUntil) ? learningUntil : 0,
            learningActive: Number.isFinite(learningUntil) && learningUntil > Date.now(),
            devices: devices.map((d) => ({
              id: d.device_id,
              firstSeen: d.first_seen ? new Date(d.first_seen).toISOString() : null,
              lastSeen: d.last_seen ? new Date(d.last_seen).toISOString() : null,
              protocol: d.protocol || null,
              accepted: Boolean(d.accepted),
            })),
          });
        }

        if (request.method === "PATCH" && seg[2] === "learning") {
          const b = await request.json().catch(() => ({}));
          const minutes = Math.max(1, Math.min(30, Number(b.minutes || 10)));
          const until = b.enabled === false ? 0 : Date.now() + minutes * 60000;
          await env.DB.prepare(
            "INSERT INTO ingest_settings (key, value) VALUES ('learning_until', ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
          ).bind(String(until)).run();
          return reply(request, env, { learningUntil: until, learningActive: until > Date.now() });
        }
      }

      /* ---- Benutzerverwaltung ---- alle Konten sehen dieselben Daten
       * (keine Trennung je Nutzer), nur Admins dürfen hier etwas ändern. */
      if (seg[1] === "users") {
        await ensureUserAdmin(env);
        if (!(await istAdmin(env, sitzung.userId))) {
          return reply(request, env, { error: "nur für Admins" }, 403);
        }
        const id = seg[2];
        if (request.method === "GET" && !id) {
          const { results } = await env.DB.prepare(
            "SELECT id, username, email, email_verified_at, is_admin, created_at FROM users ORDER BY created_at"
          ).all();
          return reply(request, env, (results || []).map((u) => ({
            id: u.id, username: u.username, email: u.email || null,
            emailVerified: Boolean(u.email_verified_at), isAdmin: Boolean(u.is_admin),
            createdAt: u.created_at,
          })));
        }
        if (request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const pruefung = validateCredentials(b, { neu: true });
          if (!pruefung.ok) return reply(request, env, { error: pruefung.errors.join("; ") }, 400);
          const username = b.username.trim();
          const { results: existiert } = await env.DB.prepare("SELECT 1 FROM users WHERE username = ?").bind(username).all();
          if (existiert?.length) return reply(request, env, { error: "Dieser Benutzername ist schon vergeben" }, 409);
          const nid = uid();
          await env.DB.prepare("INSERT INTO users (id, username, password_hash, is_admin) VALUES (?,?,?,?)")
            .bind(nid, username, await hashPassword(b.password), b.isAdmin ? 1 : 0).run();
          return reply(request, env, { id: nid }, 201);
        }
        if (request.method === "PATCH" && id) {
          const b = await request.json().catch(() => ({}));
          const fields = [], vals = [];
          if (typeof b.username === "string") {
            const username = b.username.trim();
            if (username.length < 3 || username.length > 60) {
              return reply(request, env, { error: "Benutzername muss 3 bis 60 Zeichen haben" }, 400);
            }
            const { results: existiert } = await env.DB.prepare("SELECT 1 FROM users WHERE username = ? AND id != ?").bind(username, id).all();
            if (existiert?.length) return reply(request, env, { error: "Dieser Benutzername ist schon vergeben" }, 409);
            fields.push("username = ?"); vals.push(username);
          }
          if (typeof b.password === "string") {
            if (b.password.length < 10 || b.password.length > 200) {
              return reply(request, env, { error: "Passwort muss mindestens 10 Zeichen haben" }, 400);
            }
            fields.push("password_hash = ?"); vals.push(await hashPassword(b.password));
          }
          if (typeof b.isAdmin === "boolean" && !b.isAdmin) {
            // Den letzten Admin nicht entmachten — sonst könnte niemand mehr Konten verwalten.
            const { results: eigen } = await env.DB.prepare("SELECT is_admin FROM users WHERE id = ?").bind(id).all();
            const { results: admins } = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1").all();
            if (eigen?.[0]?.is_admin && (admins?.[0]?.n || 0) <= 1) {
              return reply(request, env, { error: "Der letzte Admin kann nicht entfernt werden" }, 409);
            }
            fields.push("is_admin = ?"); vals.push(0);
          } else if (b.isAdmin === true) {
            fields.push("is_admin = ?"); vals.push(1);
          }
          if (!fields.length) return reply(request, env, { error: "nichts zu ändern" }, 400);
          await env.DB.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).bind(...vals, id).run();
          // Setzt ein Admin das Passwort eines anderen Kontos neu, sollen
          // dessen bisherige Sitzungen enden — wie beim Selbst-Ändern.
          if (typeof b.password === "string") {
            await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
          }
          return reply(request, env, { ok: true });
        }
        if (request.method === "DELETE" && id) {
          if (id === sitzung.userId) {
            return reply(request, env, { error: "Das eigene Konto lässt sich hier nicht löschen" }, 409);
          }
          const { results: gesamt } = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").all();
          if ((gesamt?.[0]?.n || 0) <= 1) {
            return reply(request, env, { error: "Das letzte Konto kann nicht gelöscht werden" }, 409);
          }
          const { results: eigen } = await env.DB.prepare("SELECT is_admin FROM users WHERE id = ?").bind(id).all();
          if (eigen?.[0]?.is_admin) {
            const { results: admins } = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1").all();
            if ((admins?.[0]?.n || 0) <= 1) {
              return reply(request, env, { error: "Der letzte Admin kann nicht gelöscht werden" }, 409);
            }
          }
          await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
          return reply(request, env, { ok: true });
        }
      }

      /* ---- D1: Geofence-Wache — nur lesbar, geschrieben wird ausschließlich
       * beim Scharfschalten (siehe PATCH /api/alarms/geofence unten). Kein
       * Zonen-CRUD (mehr) — für den Diebstahlschutz-Anwendungsfall reicht
       * ein einziger Ankerpunkt (die Position beim Scharfschalten: "Camper
       * abstellen, Wache scharf schalten"), statt vorher benannte Zonen zu
       * verwalten (Flotten-Denken, hier nicht der richtige Anwendungsfall). */
      if (seg[1] === "geofences" && request.method === "GET" && !seg[2]) {
        const { results } = await env.DB.prepare("SELECT * FROM geofences ORDER BY name").all();
        return reply(request, env, results);
      }

      /* ---- D1: Alarm-Einstellungen und -Protokoll ---- */
      if (seg[1] === "alarms") {
        if (seg[2] === "log" && request.method === "GET") {
          const { results } = await env.DB.prepare("SELECT * FROM alarm_log ORDER BY occurred_at DESC LIMIT 100").all();
          return reply(request, env, results);
        }
        if (request.method === "GET" && !seg[2]) {
          const { results } = await env.DB.prepare("SELECT * FROM alarm_settings").all();
          return reply(request, env, results);
        }
        // Scharf-/Unscharf-Schalten (z. B. Geofence-Prüfung an/aus) betrifft
        // die gemeinsame Überwachung aller Nutzer — nur Admins.
        if (request.method === "PATCH" && seg[2]) {
          await ensureUserAdmin(env);
          if (!(await istAdmin(env, sitzung.userId))) return reply(request, env, { error: "nur für Admins" }, 403);
          const b = await request.json();
          const fields = [], vals = [];
          let scharfRadius = null;
          if ("enabled" in b) {
            if (typeof b.enabled !== "boolean") return reply(request, env, { error: "enabled muss true oder false sein" }, 400);
            // Scharfschalten der Geofence-Wache: die aktuelle Fahrzeugposition
            // wird zum einzigen überwachten Ankerpunkt — ersetzt bei jedem
            // Scharfschalten den vorherigen (fester Datensatz "wache-aktuell",
            // kein Zonen-CRUD mehr). Unscharfschalten braucht keine Position.
            if (seg[2] === "geofence" && b.enabled) {
              const coords = validateCoords(b.lat, b.lon);
              if (!coords.ok) return reply(request, env, { error: "Aktuelle Position fehlt oder ist ungültig" }, 400);
              const radius = Number(b.radius_m ?? 50);
              if (!Number.isFinite(radius) || radius < 10 || radius > 50000) {
                return reply(request, env, { error: "radius_m muss zwischen 10 und 50000 liegen" }, 400);
              }
              await env.DB.prepare("INSERT OR REPLACE INTO geofences (id, name, lat, lon, radius_m, active) VALUES (?,?,?,?,?,1)")
                .bind(WACHE_ZONE_ID, "Wache", coords.lat, coords.lon, Math.round(radius)).run();
              scharfRadius = Math.round(radius);
            }
            fields.push("enabled = ?"); vals.push(b.enabled ? 1 : 0);
          }
          if ("threshold" in b) {
            if (b.threshold !== null && !Number.isFinite(Number(b.threshold))) {
              return reply(request, env, { error: "threshold muss eine Zahl oder null sein" }, 400);
            }
            fields.push("threshold = ?"); vals.push(b.threshold === null ? null : Number(b.threshold));
          }
          if (!fields.length) return reply(request, env, { error: "nichts zu ändern" }, 400);
          const { meta } = await env.DB.prepare(`UPDATE alarm_settings SET ${fields.join(", ")} WHERE key = ?`).bind(...vals, seg[2]).run();
          if (!meta?.changes) return reply(request, env, { error: "unbekannter Alarm-Typ" }, 404);
          // Scharf-/Unscharfschalten im Protokoll festhalten — daran erkennt
          // die Wache-Ansicht "scharf seit …" (geofences kennt keinen
          // Zeitpunkt), und man sieht im Nachhinein, wann wer was geschaltet hat.
          if (seg[2] === "geofence" && "enabled" in b) {
            await env.DB.prepare("INSERT INTO alarm_log (type, severity, message) VALUES ('geofence', 'ok', ?)")
              .bind(b.enabled ? `Wache scharf geschaltet (Radius ${scharfRadius} m)` : "Wache unscharf geschaltet").run();
          }
          return reply(request, env, { ok: true });
        }
      }

      /* ---- Web-Push: öffentlicher Schlüssel fürs Abo im Browser ----
       * Kein Geheimnis (nur der private Schlüssel in ingest ist eins) —
       * läuft trotzdem hinter derselben Anmeldung wie alles andere hier,
       * keine eigene Ausnahme nötig. Ohne konfigurierten Schlüssel (z. B.
       * im Cloudflare-Betrieb, wo kein ingest-Container Push verschickt)
       * ehrlich "nicht eingerichtet" statt eines leeren/falschen Werts. */
      if (seg[1] === "push-public-key" && request.method === "GET") {
        if (!env.VAPID_PUBLIC_KEY) return reply(request, env, { error: "Push ist nicht eingerichtet" }, 503);
        return reply(request, env, { key: env.VAPID_PUBLIC_KEY });
      }

      /* ---- D1: Web-Push-Abos — persönliche Einstellung, jeder meldet sein
       * eigenes Gerät an/ab, keine gemeinsame Konfiguration wie Kategorien/
       * Fahrzeuge (deshalb kein Admin-Erfordernis). Der eigentliche Versand
       * beim Zonen-Wechsel passiert im ingest-Container (siehe
       * tracker-backend/src/alarms.js), hier nur Verwaltung. */
      if (seg[1] === "push-subscriptions") {
        if (request.method === "POST" && !seg[2]) {
          const b = await request.json().catch(() => ({}));
          if (!b?.endpoint || !b?.keys?.p256dh || !b?.keys?.auth) {
            return reply(request, env, { error: "endpoint/keys.p256dh/keys.auth fehlen" }, 400);
          }
          const nid = uid();
          // INSERT OR REPLACE über den eindeutigen endpoint: meldet sich
          // dasselbe Gerät erneut an (z. B. nach dem Löschen lokaler Daten),
          // ersetzt das der Browser ohnehin identische Abo statt einen
          // Duplikat-Fehler zu werfen.
          await env.DB.prepare(
            "INSERT OR REPLACE INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES (?,?,?,?,?)"
          ).bind(nid, sitzung.userId, b.endpoint, b.keys.p256dh, b.keys.auth).run();
          return reply(request, env, { id: nid }, 201);
        }
        if (request.method === "DELETE" && seg[2]) {
          // Nur das eigene Abo löschbar — nicht das eines anderen Kontos,
          // selbst wenn die ID erraten würde.
          await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?").bind(seg[2], sitzung.userId).run();
          return reply(request, env, { ok: true });
        }
      }

      return reply(request, env, { error: "nicht gefunden" }, 404);
    } catch (err) {
      console.error("API-Fehler:", err?.stack || err);
      return reply(request, env, publicError(err, env), 502);
    }
  }
