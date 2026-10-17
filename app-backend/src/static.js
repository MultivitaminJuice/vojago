// Statische Auslieferung von public/ (der gebauten PWA) — auf Cloudflare
// Pages übernimmt das Pages selbst, hier brauchen wir ein kleines
// Äquivalent. Bewusst simpel: kein Cache-Busting, keine Kompression, kein
// Range-Request-Support — für einen Heimserver mit einer Handvoll Nutzern
// unnötig, kann bei Bedarf später ergänzt werden.
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const TYP_NACH_ENDUNG = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  // MapLibre 6 wird als ES-Modul geladen — Browser lehnen Modulskripte mit
  // falschem Dateityp (z. B. application/octet-stream) ab.
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export function createStaticHandler(basisVerzeichnis) {
  const basis = normalize(basisVerzeichnis);

  return async function serveStatic(request) {
    const url = new URL(request.url);
    let pfadname = decodeURIComponent(url.pathname);
    if (pfadname === "/") pfadname = "/index.html";

    const ziel = normalize(join(basis, pfadname));
    if (!ziel.startsWith(basis)) {
      return new Response("nicht gefunden", { status: 404 });
    }

    try {
      const info = await stat(ziel);
      if (!info.isFile()) throw new Error("kein File");
      const inhalt = await readFile(ziel);
      const typ = TYP_NACH_ENDUNG[extname(ziel)] || "application/octet-stream";
      return new Response(inhalt, { headers: { "content-type": typ } });
    } catch {
      // src/main.js liest eigene Client-Routen direkt aus location.pathname
      // (z. B. "/share/:token" für öffentliche Freigaben) — ein Pfad ohne
      // Dateiendung, der keine echte Datei trifft, bekommt deshalb
      // index.html statt eines 404en, genau wie bei einer SPA üblich. Ein
      // Pfad MIT Endung (z. B. ein Tippfehler bei einem Bild) bleibt ein
      // echtes 404.
      if (!extname(pfadname)) {
        try {
          const inhalt = await readFile(join(basis, "index.html"));
          return new Response(inhalt, { headers: { "content-type": "text/html; charset=utf-8" } });
        } catch { /* fällt unten auf 404 durch */ }
      }
      return new Response("nicht gefunden", { status: 404 });
    }
  };
}
