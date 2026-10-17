// Ein einziger Ort für den Datenbankzugriff — Protokoll-Parser kennen nur
// diese Funktionen, nie SQL direkt. So bleibt store.js die einzige Stelle,
// die weiß, wie die Daten tatsächlich abgelegt sind.
//
// better-sqlite3 statt bun:sqlite (ursprünglicher Plan) — der Heimserver
// hat eine CPU ohne AVX-Unterstützung, auf der Bun grundsätzlich abstürzt
// (siehe Git-Historie). better-sqlite3 ist API-kompatibel zu bun:sqlite
// (bewusst so von Bun übernommen), der Rest dieser Datei ist unverändert.
import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hier = dirname(fileURLToPath(import.meta.url));
const DB_PFAD = process.env.TRACKER_DB_PATH || join(hier, "..", "data", "tracker.db");
// Rohpakete sind bewusst kurzlebig (siehe schema.sql) — nur zur Fehlersuche,
// nicht die dauerhafte Wahrheit.
const ROHPAKETE_TAGE = Number(process.env.TRACKER_RAW_RETENTION_DAYS || 30);

mkdirSync(dirname(DB_PFAD), { recursive: true });
export const db = new Database(DB_PFAD);
db.exec("PRAGMA journal_mode = WAL;"); // gleichzeitiges Lesen (z. B. spätere API) blockiert nicht das Schreiben
// Ohne busy_timeout schlägt ein Schreibzugriff, der auf eine gerade offene
// Schreibtransaktion der jeweils anderen Verbindung trifft (app-backend im
// Zwei-Container-Betrieb, siehe docker-compose.yml), SOFORT mit
// SQLITE_BUSY fehl statt kurz zu warten — live beobachtet als still
// verschluckter Fehler in api/router.js (ensureUserAdmin()).
db.exec("PRAGMA busy_timeout = 5000;");

const schemaPfad = join(hier, "..", "schema.sql");
db.exec(readFileSync(schemaPfad, "utf8"));

const insertRawStmt = db.prepare(
  "INSERT INTO raw_packets (device_id, protocol, received_at, payload) VALUES (?, ?, ?, ?)"
);
export function insertRawPacket({ deviceId, protocol, receivedAt, payload }) {
  insertRawStmt.run(deviceId, protocol, receivedAt, payload);
}

const insertPositionStmt = db.prepare(
  `INSERT INTO positions
   (device_id, at, lat, lon, speed_kmh, course, altitude, sats, ignition, motion, protocol, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const existiertPositionStmt = db.prepare("SELECT 1 FROM positions WHERE device_id = ? AND at = ? LIMIT 1");
/**
 * @param {{deviceId: string, at: number, lat: number, lon: number,
 *   speedKmh?: number, course?: number, altitude?: number, sats?: number,
 *   ignition?: boolean, motion?: boolean, protocol: string}} p
 * @returns {number|null} die id der neu eingefügten Zeile, oder null, wenn
 *   dieselbe Position (Gerät + Fix-Zeit) schon gespeichert ist. Der Router
 *   sendet Pakete bei verpasster Bestätigung erneut (echter Fund, 11. Oktober
 *   2026: 14 doppelte Fix-Zeiten, ein Duplikat am Rand der Wache-Zone ergab
 *   verlassen/betreten/verlassen binnen einer Minute) — ein Duplikat wird
 *   weder gespeichert noch ausgewertet.
 */
export function insertPosition(p) {
  if (existiertPositionStmt.get(p.deviceId, p.at)) return null;
  const ergebnis = insertPositionStmt.run(
    p.deviceId, p.at, p.lat, p.lon,
    p.speedKmh ?? null, p.course ?? null, p.altitude ?? null, p.sats ?? null,
    p.ignition === undefined ? null : p.ignition ? 1 : 0,
    p.motion === undefined ? null : p.motion ? 1 : 0,
    p.protocol, Date.now()
  );
  return ergebnis.lastInsertRowid;
}

/** Räumt alte Rohpakete auf — als eigener Aufruf, nicht automatisch bei
 * jedem Schreiben, damit der heiße Pfad (Paket empfangen → speichern)
 * schlank bleibt. server.js ruft das periodisch auf. */
export function pruneRawPackets() {
  const grenze = Date.now() - ROHPAKETE_TAGE * 86400_000;
  const { changes } = db.prepare("DELETE FROM raw_packets WHERE received_at < ?").run(grenze);
  return changes;
}

export function positionCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM positions").get().n;
}

/** Für die einfache /positions-Ansicht — neueste zuerst. */
export function listRecentPositions(limit = 200) {
  return db.prepare("SELECT * FROM positions ORDER BY id DESC LIMIT ?").all(limit);
}
