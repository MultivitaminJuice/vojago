// Einstiegspunkt — reines Fetch-API-Routing wie api/router.js im
// Hauptprojekt, bewusst ohne Web-Framework (siehe Kommentar in
// protocols/osmand.js). Läuft auf Node statt Bun (siehe store.js) — Node
// hat einen kleinen Adapter zwischen seiner eigenen http-API und der
// Web-Standard Request/Response-API nötig, die handleRequest() erwartet.
// Teltonika läuft daneben als eigener, unabhängiger TCP-Listener
// (node:net statt node:http — AVL-Pakete sind binär, kein HTTP).
import { createServer } from "node:http";
import { handleOsmand } from "./protocols/osmand.js";
import { createTeltonikaServer } from "./protocols/teltonika.js";
import { pruneRawPackets, positionCount } from "./store.js";
import { renderPositionsPage } from "./positions-view.js";
import { fuehreAutoImportAus } from "./auto-import.js";
import { pruefeAlleZonenzustaende } from "./alarms.js";

const PORT = Number(process.env.TRACKER_HTTP_PORT || 5055); // 5055 = bisheriger OsmAnd-Port bei Traccar
const TELTONIKA_PORT = Number(process.env.TRACKER_TCP_PORT || 5027); // 5027 = Traccars üblicher Teltonika-Port

/** @param {Request} request */
async function handleRequest(request) {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    return Response.json({ ok: true, service: "vojago-tracker-backend", positions: positionCount() });
  }

  if (url.pathname === "/positions") {
    return renderPositionsPage();
  }

  // OsmAnd-Clients (auch der ESP32-Logger) senden traditionell direkt auf
  // "/" — "/osmand" zusätzlich anzubieten schadet nicht.
  if (url.pathname === "/" || url.pathname === "/osmand") {
    return handleOsmand(request);
  }

  return Response.json({ error: "nicht gefunden" }, { status: 404 });
}

/** Node-Request in ein Web-Standard Request übersetzen — damit dieselbe
 * Routing-/Handler-Logik unverändert auf jeder fetch-fähigen Laufzeit läuft
 * (Cloudflare Workers heute, hier Node, potenziell wieder Bun, falls die
 * CPU-Hürde auf dem Server mal wegfällt). */
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

// Rohpakete sind bewusst kurzlebig (siehe schema.sql) — stündlich aufräumen,
// nicht bei jedem Schreibvorgang, damit der heiße Pfad schlank bleibt.
setInterval(() => {
  const geloescht = pruneRawPackets();
  if (geloescht) console.log(`[tracker-backend] ${geloescht} alte Rohpakete aufgeräumt`);
}, 60 * 60_000);

// Übernachtungen/Stopps automatisch erkennen — serverseitig statt nur im
// Browser (siehe auto-import.js). Bewusst KEIN festes Zeitintervall mehr
// (Nutzerwunsch, 6. September 2026): der eigentliche Regelfall ist
// ereignisgesteuert — teltonika.js/osmand.js rufen pruefeStoppsFuerGeraet()
// direkt auf, sobald eine neue Position gespeichert wurde (siehe dort).
// Hier nur EIN einmaliger Durchlauf über alle Fahrzeuge beim Start — holt
// nach, was während einer Downtime liegen geblieben ist, oder wenn sich
// z. B. eine Geräte-Zuordnung geändert hat, ohne dass seither neue
// Positionen für dieses Gerät eintrafen.
fuehreAutoImportAus({ planen: true }).catch((err) => console.error("[auto-import] Start-Durchlauf fehlgeschlagen:", err));

// Wache: Zustand der letzten Meldung nachprüfen (siehe alarms.js, Stille nach
// der letzten Meldung) — holt eine Rückkehr nach, die vor einem Neustart offen blieb.
try { pruefeAlleZonenzustaende(); } catch (err) { console.error("[alarms] Start-Prüfung fehlgeschlagen:", err); }

const server = createServer(async (nodeReq, nodeRes) => {
  try {
    const response = await handleRequest(alsWebRequest(nodeReq));
    await sendeWebResponse(response, nodeRes);
  } catch (err) {
    console.error("[tracker-backend] Fehler bei der Anfrage:", err);
    nodeRes.statusCode = 500;
    nodeRes.end(JSON.stringify({ error: "interner Fehler" }));
  }
});

server.listen(PORT, () => {
  console.log(`[tracker-backend] OsmAnd-Empfänger läuft auf Port ${PORT}`);
});

createTeltonikaServer(TELTONIKA_PORT);
