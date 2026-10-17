// R2-Shim — bildet die Teilmenge der R2-API nach, die api/router.js
// tatsächlich nutzt (geprüft per grep): env.PHOTOS.get()/.put()/.delete().
// Lokales Dateisystem statt Cloudflare R2, ein Verzeichnis pro Ablage.
//
// Vereinfachung, bewusst: R2 speichert Content-Type als echtes Metadatum
// (httpMetadata.contentType) unabhängig vom Schlüsselnamen. Hier reicht die
// Dateiendung im Schlüssel — router.js erzeugt sie beim Hochladen selbst so
// (`fotos/${id}.png` oder `.jpg`, siehe api/router.js) und braucht nichts
// anderes. Kein separates Metadatenformat nötig, solange sich das nicht
// ändert.
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const ENDUNG_ZU_TYP = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

function contentTypeFuerSchluessel(key) {
  const punkt = key.lastIndexOf(".");
  const endung = punkt >= 0 ? key.slice(punkt).toLowerCase() : "";
  return ENDUNG_ZU_TYP[endung] || "application/octet-stream";
}

export class R2Shim {
  /** @param {string} basisVerzeichnis */
  constructor(basisVerzeichnis) {
    this.basis = basisVerzeichnis;
    mkdirSync(this.basis, { recursive: true });
  }

  /** Bildet einen R2-Schlüssel (z. B. "fotos/abc123.jpg") auf einen Pfad
   * innerhalb des Basisverzeichnisses ab — nie außerhalb, auch nicht bei
   * einem manipulierten Schlüssel mit "..". */
  #pfad(key) {
    const ziel = normalize(join(this.basis, key));
    if (!ziel.startsWith(normalize(this.basis))) {
      throw new Error(`R2-Shim: Schlüssel außerhalb des Basisverzeichnisses: ${key}`);
    }
    return ziel;
  }

  async get(key) {
    const pfad = this.#pfad(key);
    if (!existsSync(pfad)) return null;
    return {
      body: readFileSync(pfad),
      httpMetadata: { contentType: contentTypeFuerSchluessel(key) },
    };
  }

  async put(key, data /* ArrayBuffer | Buffer */) {
    const pfad = this.#pfad(key);
    mkdirSync(dirname(pfad), { recursive: true });
    writeFileSync(pfad, Buffer.isBuffer(data) ? data : Buffer.from(data));
  }

  async delete(key) {
    const pfad = this.#pfad(key);
    rmSync(pfad, { force: true });
  }
}
