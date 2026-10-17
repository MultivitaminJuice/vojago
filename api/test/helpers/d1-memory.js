import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(resolve(__dirname, "../../schema.sql"), "utf8");

export class D1Memory {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(schema);
  }

  prepare(sql) {
    const statement = this.db.prepare(sql);
    const run = (params = []) => {
      const result = statement.run(...params);
      return {
        success: true,
        meta: {
          changes: result.changes,
          last_row_id: Number(result.lastInsertRowid || 0),
        },
      };
    };
    const all = (params = []) => ({ results: statement.all(...params) });
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
