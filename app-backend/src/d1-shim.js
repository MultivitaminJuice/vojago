// D1-Shim — bildet exakt die Teilmenge der D1-API nach, die api/router.js
// und api/lib.js tatsächlich nutzen: env.DB.prepare(sql).bind(...).all()/.run().
// Kein .first(), kein .batch() — beide werden im ganzen Router nicht benutzt
// (geprüft per grep), müssen also hier nicht nachgebaut werden.
//
// Diese Datei ist die persistente Schwester von
// api/test/helpers/d1-memory.js (dort: node:sqlite + :memory:, nur für
// Tests). Dieselbe Fassade, hier aber auf better-sqlite3 + einer echten
// Datei — passend zum bereits etablierten Muster in
// tracker-backend/src/store.js, und weil api/test/router.integration.test.js
// bereits belegt, dass genau diese Fassade für den ganzen Router ausreicht.
import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hier = dirname(fileURLToPath(import.meta.url));

/** undefined ist für SQLite kein gültiger Bind-Wert (anders als bei manchen
 * JS-Objekten) — defensiv auf null abbilden, statt dass der Fehler erst tief
 * in better-sqlite3 auftaucht. */
const bindbar = (params) => params.map((p) => (p === undefined ? null : p));

// Lokal (Repo-Checkout) liegt db/schema.sql zwei Ebenen über src/ —
// app-backend/src/../../db/schema.sql. Im Container hat sich diese Tiefe
// beim Bauen nicht zwingend gehalten (siehe Dockerfile: WORKDIR /app, aber
// db/schema.sql landet dort nur eine Ebene über src/), deshalb per
// Umgebungsvariable überschreibbar — gleiches Muster wie APP_DB_PATH/
// APP_PHOTOS_PATH.
const STANDARD_SCHEMA_PFAD = join(hier, "..", "..", "db", "schema.sql");

export class D1Shim {
  /** @param {string} dbPfad Pfad zur SQLite-Datei (Verzeichnis wird bei Bedarf angelegt) */
  constructor(dbPfad) {
    mkdirSync(dirname(dbPfad), { recursive: true });
    this.db = new Database(dbPfad);
    this.db.pragma("journal_mode = WAL"); // gleichzeitiger Zugriff vom ingest-Container
    // WICHTIG: better-sqlite3 setzt standardmäßig KEIN busy_timeout — ein
    // Schreibzugriff, der auf eine gerade offene Schreibtransaktion der
    // jeweils anderen Verbindung (app <-> ingest, zwei Prozesse auf
    // derselben Datei) trifft, würde sonst SOFORT mit SQLITE_BUSY
    // fehlschlagen statt kurz zu warten. Genau das hat live einen echten
    // Fehler verursacht (ensureUserAdmin() in api/router.js schlug
    // wiederholt fehl, still verschluckt vom try/catch dort — gefunden
    // durch Nachstellen der Schreib-Konkurrenz, siehe Git-Historie).
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    const schemaPfad = process.env.APP_SCHEMA_PATH || STANDARD_SCHEMA_PFAD;
    this.db.exec(readFileSync(schemaPfad, "utf8"));
  }

  prepare(sql) {
    const statement = this.db.prepare(sql);
    const run = (params = []) => {
      const result = statement.run(...bindbar(params));
      return {
        success: true,
        meta: {
          changes: result.changes,
          last_row_id: Number(result.lastInsertRowid || 0),
        },
      };
    };
    const all = (params = []) => ({ results: statement.all(...bindbar(params)) });
    return {
      bind: (...params) => ({
        all: () => all(params),
        run: () => run(params),
      }),
      all: () => all(),
      run: () => run(),
    };
  }

  close() {
    this.db.close();
  }
}
