// OsmAnd-HTTP-Protokoll — deckt sowohl generische OsmAnd-fähige Tracker
// (z. B. Handy-Apps) als auch den eigenen ESP32-GPS-Logger ab (der laut
// dessen Dokumentation genau dieses Protokoll per WLAN-Nachtrag spricht).
//
// Bewusst der erste Baustein, nicht Teltonika: reines HTTP mit Textparametern,
// kein Binär-Framing/CRC — prüft Schema und Speicherpfad an echten Daten,
// bevor der aufwändigere Codec8/8E-Teil kommt.
//
// Bewusst ohne Web-Framework/Validierungsbibliothek — reines Fetch-API
// JavaScript, wie api/router.js im Hauptprojekt. Cloudflare Workers, Node
// (server.js übersetzt dorthin) und Bun sprechen alle dieselbe
// (Request) => Response-Schnittstelle; das hält einen späteren Umzug der
// übrigen VOJAĜO-API auf denselben Server (Phase 2) mechanisch statt
// aufwändig — jede Route bräuchte sonst zusätzlich einen Umbau in Honos
// Schreibweise. Diese Datei selbst kennt keinen Unterschied zwischen den
// Laufzeiten, nur store.js und server.js tun das.
//
// ACHTUNG — noch nicht an echten Logger-Daten geprüft: Einheiten (speed in
// Knoten?, ignition/motion als "true"/"false"?) folgen hier der üblichen
// OsmAnd/Traccar-Konvention, sind aber noch nicht gegen die tatsächliche
// ESP32-Firmware verifiziert. Vor dem ersten echten Test gegenprüfen.
import { insertRawPacket, insertPosition } from "../store.js";
import { pruefeZonenwechsel } from "../alarms.js";
import { isDeviceAllowed } from "../device-allowlist.js";
import { pruefeStoppsFuerGeraet } from "../auto-import.js";

/** Dieselbe Form wie validateCoords()/validateTrip() in api/lib.js:
 * { ok, errors, ...geparste Werte }. */
function validateOsmand(params) {
  const errors = [];
  const zahl = (name, { min, max, optional = true } = {}) => {
    const roh = params.get(name);
    if (roh === null || roh === "") {
      if (!optional) errors.push(`${name} fehlt`);
      return undefined;
    }
    const v = Number(roh);
    if (!Number.isFinite(v)) { errors.push(`${name} ist keine Zahl`); return undefined; }
    if (min !== undefined && v < min) errors.push(`${name} zu klein`);
    if (max !== undefined && v > max) errors.push(`${name} zu groß`);
    return v;
  };
  // "false" ist ein nicht-leerer String — Boolean("false") wäre true, daher
  // von Hand auf den tatsächlichen Text prüfen statt naiv zu casten.
  const boolWert = (name) => {
    const roh = params.get(name);
    if (roh === null) return undefined;
    return roh === "true" || roh === "1";
  };

  const id = params.get("id");
  if (!id) errors.push("id fehlt");

  const lat = zahl("lat", { min: -90, max: 90, optional: false });
  const lon = zahl("lon", { min: -180, max: 180, optional: false });
  const timestamp = zahl("timestamp");
  const speed = zahl("speed");
  const bearing = zahl("bearing");
  const altitude = zahl("altitude");
  const sat = zahl("sat");
  const ignition = boolWert("ignition");
  const motion = boolWert("motion");

  return { ok: errors.length === 0, errors, id, lat, lon, timestamp, speed, bearing, altitude, sat, ignition, motion };
}

/** @param {Request} request */
export async function handleOsmand(request) {
  const url = new URL(request.url);
  let params = url.searchParams;
  if (request.method === "POST") {
    // OsmAnd-Clients senden praktisch immer per GET; POST-Formular-Bodies
    // trotzdem unterstützen, falls ein Tracker das mal so macht.
    try {
      const body = await request.clone().formData();
      params = new URLSearchParams([...url.searchParams, ...body.entries()]);
    } catch { /* kein Formular-Body, nur Query — auch gültig */ }
  }

  const p = validateOsmand(params);
  if (!p.ok) {
    return Response.json({ error: p.errors.join("; ") }, { status: 400 });
  }
  if (!isDeviceAllowed(p.id, { protocol: "osmand" })) {
    return Response.json({ error: "Gerät nicht zugelassen" }, { status: 403 });
  }

  const empfangenAm = Date.now();
  const fixZeit = p.timestamp ? p.timestamp * 1000 : empfangenAm;

  insertRawPacket({
    deviceId: p.id,
    protocol: "osmand",
    receivedAt: empfangenAm,
    payload: Buffer.from(params.toString()),
  });
  const id = insertPosition({
    deviceId: p.id,
    at: fixZeit,
    lat: p.lat,
    lon: p.lon,
    speedKmh: p.speed === undefined ? undefined : p.speed * 1.852, // Knoten → km/h
    course: p.bearing,
    altitude: p.altitude,
    sats: p.sat,
    ignition: p.ignition,
    motion: p.motion,
    protocol: "osmand",
  });
  if (id !== null) pruefeZonenwechsel({ id, deviceId: p.id, at: fixZeit, lat: p.lat, lon: p.lon });
  // Fire-and-forget: blockiert die Antwort an den Tracker nicht, siehe
  // auto-import.js für die Drosselung je Gerät.
  pruefeStoppsFuerGeraet(p.id);

  // OsmAnd-Clients erwarten nur einen 200er, kein bestimmtes Format.
  return new Response("OK");
}
