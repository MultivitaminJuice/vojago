// Versioned migrations for the shared SQLite database.
//
// Both containers run this on start, right after db/schema.sql:
//   - schema.sql creates every table in its current shape (CREATE ... IF NOT
//     EXISTS), so a fresh database is complete after it;
//   - an existing database keeps its tables as they are; the migrations below
//     bring it up to date. PRAGMA user_version stores how far it is.
//
// Rules for a new migration: append it with the next version number, never
// change one that has shipped, and keep it safe to run on a database that
// already has the change (fresh databases get it from schema.sql). Indexes on
// columns a migration adds belong here, not in schema.sql: schema.sql runs
// first, on the old shape.
//
// Works with better-sqlite3 (containers) and node:sqlite (tests): only
// exec() and prepare().all()/get()/run() are used.

const spalten = (db, tabelle) => new Set(db.prepare(`PRAGMA table_info(${tabelle})`).all().map((r) => r.name));
const tabelleDa = (db, tabelle) => Boolean(db.prepare("SELECT 1 AS da FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabelle));

function spalteErgaenzen(db, tabelle, spalte, definition) {
  if (!tabelleDa(db, tabelle) || spalten(db, tabelle).has(spalte)) return false;
  db.exec(`ALTER TABLE ${tabelle} ADD COLUMN ${spalte} ${definition}`);
  return true;
}

export const MIGRATIONS = [
  {
    version: 1,
    name: "baseline: the changes the API used to apply lazily on requests",
    up(db, { schemaSql }) {
      // Places used to be one table with place_id in notes/photos (before
      // 18 August 2026). Replaced by orte + besuche; the old rows were not
      // carried over then either.
      let neuAufbauen = false;
      if (tabelleDa(db, "photos") && spalten(db, "photos").has("place_id")) { db.exec("DROP TABLE photos"); neuAufbauen = true; }
      if (tabelleDa(db, "notes") && spalten(db, "notes").has("place_id")) { db.exec("DROP TABLE notes"); neuAufbauen = true; }
      if (tabelleDa(db, "places")) { db.exec("DROP TABLE places"); neuAufbauen = true; }
      if (neuAufbauen) db.exec(schemaSql);

      spalteErgaenzen(db, "users", "email", "TEXT");
      spalteErgaenzen(db, "users", "email_verified_at", "INTEGER");
      spalteErgaenzen(db, "users", "is_admin", "INTEGER NOT NULL DEFAULT 0");
      spalteErgaenzen(db, "trip_shares", "token", "TEXT");
      spalteErgaenzen(db, "orte", "address", "TEXT");
      spalteErgaenzen(db, "photos", "tagebuch_id", "TEXT REFERENCES tagebuch(id) ON DELETE CASCADE");
      db.exec("CREATE INDEX IF NOT EXISTS photos_tagebuch ON photos (tagebuch_id)");
      if (spalteErgaenzen(db, "drive_assignments", "assignment", "TEXT NOT NULL DEFAULT 'auto'")) {
        db.exec("UPDATE drive_assignments SET assignment = CASE WHEN trip_id IS NULL THEN 'auto' ELSE 'manual' END");
      }
      spalteErgaenzen(db, "drive_assignments", "kind", "TEXT NOT NULL DEFAULT 'etappe'");
    },
  },
];

export const schemaVersion = (db) => db.prepare("PRAGMA user_version").get().user_version;

/**
 * Applies every migration newer than the database. Each one runs in its own
 * write transaction together with the new version number, so a failed
 * migration leaves the database as it was. The version is read again inside
 * the transaction: when both containers start at once, the second one finds
 * the work done.
 */
export function migrate(db, { schemaSql, migrations = MIGRATIONS, log = () => {} } = {}) {
  const ausgefuehrt = [];
  for (const m of migrations) {
    if (schemaVersion(db) >= m.version) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (schemaVersion(db) < m.version) {
        m.up(db, { schemaSql });
        db.exec(`PRAGMA user_version = ${Number(m.version)}`);
        ausgefuehrt.push(m.version);
        log(`database migrated to version ${m.version}: ${m.name}`);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return ausgefuehrt;
}
