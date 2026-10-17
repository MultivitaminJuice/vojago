// Einstiegspunkt des app-Containers (Phase 2) —
// führt api/router.js UNVERÄNDERT auf Node aus (dieselbe Quelle, die auch
// die Cloudflare-Pages-Funktion in functions/api/[[path]].js verwendet),
// nur env.DB/env.PHOTOS sind hier Shims statt echter D1-/R2-Bindings. Der
// Node↔Fetch-Adapter (alsWebRequest/sendeWebResponse) ist derselbe wie in
// tracker-backend/src/server.js — dort schon bewährt, hier unverändert
// übernommen (bewusst dupliziert statt geteilt: app-backend und
// tracker-backend sind zwei eigenständige, unabhängig baubare Container).
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handle } from "../../api/router.js";
import { D1Shim } from "./d1-shim.js";
import { R2Shim } from "./r2-shim.js";
import { createStaticHandler } from "./static.js";

const hier = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.APP_HTTP_PORT || 8080);
const DB_PFAD = process.env.APP_DB_PATH || join(hier, "..", "data", "vojago.db");
const FOTOS_PFAD = process.env.APP_PHOTOS_PATH || join(hier, "..", "data", "fotos");
const PUBLIC_PFAD = process.env.APP_PUBLIC_PATH || join(hier, "..", "..", "public");

const db = new D1Shim(DB_PFAD);
const fotos = new R2Shim(FOTOS_PFAD);
const serveStatic = createStaticHandler(PUBLIC_PFAD);

// Dieselben env-Namen wie beim Cloudflare-Betrieb (siehe Kopfkommentar in
// api/router.js). LOCAL_POSITIONS schaltet Positionen/Fahrten/Stopps auf
// die eigene positions-Tabelle um (api/lib.js: mapPositionRow/segmentDrives/
// segmentStops) statt Traccar zu proxen — TRACCAR_* bleibt deshalb bewusst
// ungesetzt, kein Zugangsdaten-Bedarf mehr für den Selbst-Hosting-Betrieb.
function buildEnv() {
  return {
    DB: db,
    PHOTOS: fotos,
    LOCAL_POSITIONS: "1",
    APP_URL: process.env.APP_URL,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || "",
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    MAIL_FROM: process.env.MAIL_FROM,
    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
  };
}

/** @param {Request} request */
async function handleRequest(request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) {
    return serveStatic(request);
  }
  return handle(request, buildEnv());
}

function alsWebRequest(nodeReq) {
  const url = `http://${nodeReq.headers.host || `localhost:${PORT}`}${nodeReq.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const hatBody = nodeReq.method !== "GET" && nodeReq.method !== "HEAD";
  return new Request(url, {
    method: nodeReq.method,
    headers,
    body: hatBody ? nodeReq : undefined,
    duplex: hatBody ? "half" : undefined,
  });
}

async function sendeWebResponse(response, nodeRes) {
  nodeRes.statusCode = response.status;
  for (const [k, v] of response.headers) nodeRes.setHeader(k, v);
  const body = response.body ? Buffer.from(await response.arrayBuffer()) : null;
  nodeRes.end(body);
}

const server = createServer(async (nodeReq, nodeRes) => {
  try {
    const response = await handleRequest(alsWebRequest(nodeReq));
    await sendeWebResponse(response, nodeRes);
  } catch (err) {
    console.error("[app-backend] Fehler bei der Anfrage:", err);
    nodeRes.statusCode = 500;
    nodeRes.end(JSON.stringify({ error: "interner Fehler" }));
  }
});

server.listen(PORT, () => {
  console.log(`[app-backend] läuft auf Port ${PORT} (DB: ${DB_PFAD}, Fotos: ${FOTOS_PFAD})`);
});
