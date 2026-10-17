// Testdaten laden: liegt lokal ein Satz mit ECHTEN Daten in local/fixtures/ (nie
// im Repository, siehe docs/local-setup.md), wird der genommen — sonst die
// anonymisierte, eingecheckte Fassung in api/test/fixtures/. Beide haben
// dieselbe Form und dieselben Zeitstempel; nur die Koordinaten sind verschoben.
// FIXTURES=public erzwingt die eingecheckten Daten (so läuft auch die CI).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hier = dirname(fileURLToPath(import.meta.url));

export function ladeFixture(name) {
  const lokal = join(hier, "..", "..", "local", "fixtures", `${name}.json`);
  const oeffentlich = join(hier, "fixtures", `${name}.json`);
  const pfad = existsSync(lokal) && process.env.FIXTURES !== "public" ? lokal : oeffentlich;
  return JSON.parse(readFileSync(pfad, "utf8"));
}
