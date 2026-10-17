import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticHandler } from "./static.js";

function mitVerzeichnis(dateien, pruefung) {
  const dir = mkdtempSync(join(tmpdir(), "static-"));
  for (const [name, inhalt] of Object.entries(dateien)) writeFileSync(join(dir, name), inhalt);
  const handler = createStaticHandler(dir);
  return Promise.resolve(pruefung(handler)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const hole = (handler, pfad) => handler(new Request(`http://localhost${pfad}`));

// MapLibre 6 wird als ES-Modul geladen: Browser lehnen Modulskripte mit einem
// anderen Dateityp als JavaScript ab (die Karte startet dann gar nicht).
test("Static: .mjs wird als JavaScript ausgeliefert", () =>
  mitVerzeichnis({ "maplibre-gl.mjs": "export {}", "maplibre-gl-worker.mjs": "export {}" }, async (h) => {
    for (const datei of ["/maplibre-gl.mjs", "/maplibre-gl-worker.mjs"]) {
      const res = await hole(h, datei);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /^text\/javascript/);
    }
  }));

test("Static: bekannte Typen und SPA-Rückfall auf index.html", () =>
  mitVerzeichnis({ "app.js": "1", "app.css": "a{}", "index.html": "<html></html>" }, async (h) => {
    assert.match((await hole(h, "/app.js")).headers.get("content-type"), /javascript/);
    assert.match((await hole(h, "/app.css")).headers.get("content-type"), /css/);
    const spa = await hole(h, "/share/abc");
    assert.equal(spa.status, 200);
    assert.match(spa.headers.get("content-type"), /html/);
    assert.equal((await hole(h, "/fehlt.png")).status, 404);
  }));
