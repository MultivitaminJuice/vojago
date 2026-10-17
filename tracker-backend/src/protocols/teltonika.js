// Teltonika TCP-Listener — nimmt Codec8/8E-Verbindungen vom RUTX50 (oder
// jedem anderen Teltonika-kompatiblen Gerät) entgegen. Reines node:net,
// kein Framework — passt zum Rest von tracker-backend.
//
// Ablauf je Verbindung (siehe teltonika-codec.js für die Byte-Details):
//   1. Gerät sendet einmalig ein IMEI-Paket → Server antwortet mit einem
//      einzelnen Byte: 0x01 (akzeptiert) oder 0x00 (abgelehnt).
//   2. Danach sendet das Gerät beliebig viele Codec8/8E-AVL-Datenpakete,
//      auf jedes antwortet der Server mit 4 Bytes: der Anzahl der
//      akzeptierten Datensätze. Die Verbindung bleibt offen (das Gerät
//      hält sie meist dauerhaft, auch über Standzeiten hinweg).
// Ein Puffer pro Verbindung sammelt eintreffende Bytes, weil TCP keine
// Nachrichtengrenzen kennt — ein Paket kann über mehrere "data"-Ereignisse
// verteilt ankommen, und mehrere Pakete können in einem einzigen
// "data"-Ereignis zusammen ankommen (typisch nach einer Standzeit ohne
// Verbindung, analog zum bereits beobachteten OsmAnd-Nachliefer-Verhalten).
import { createServer } from "node:net";
import { parseImeiPacket, parseAvlPacket, CODEC8_EXTENDED } from "./teltonika-codec.js";
import { insertPosition, insertRawPacket } from "../store.js";
import { pruefeZonenwechsel } from "../alarms.js";
import { isDeviceAllowed } from "../device-allowlist.js";
import { pruefeStoppsFuerGeraet } from "../auto-import.js";

// Rohe Bytes mitloggen — nur zum Abgleich der ersten echten Pakete gegen
// diese Spezifikation gedacht (siehe Warnung in teltonika-codec.js), im
// Normalbetrieb aus wegen Log-Rauschen.
const ROH_LOGGEN = process.env.TRACKER_LOG_RAW_TELTONIKA === "1";
// Geräte senden oft minutenlang nichts (Standzeit) — Timeout entsprechend
// großzügig, sonst trennen wir aktive, nur gerade stille Verbindungen.
const LEERLAUF_TIMEOUT_MS = 5 * 60_000;

export function createTeltonikaServer(port) {
  const server = createServer((socket) => {
    let puffer = Buffer.alloc(0);
    let imei = null;
    const adresse = `${socket.remoteAddress}:${socket.remotePort}`;
    socket.setTimeout(LEERLAUF_TIMEOUT_MS);
    console.log(`[teltonika] Verbindung von ${adresse}`);

    function verarbeitePuffer() {
      // Mehrere vollständige Pakete können auf einmal angekommen sein —
      // solange sich puffer weiter verkürzt, gibt es noch etwas zu tun.
      for (;;) {
        if (!imei) {
          const ergebnis = parseImeiPacket(puffer);
          if (!ergebnis) return; // noch nicht genug Daten für die IMEI
          imei = ergebnis.imei;
          puffer = puffer.subarray(ergebnis.bytesRead);
          if (!isDeviceAllowed(imei, { protocol: "teltonika" })) {
            console.warn(`[teltonika] IMEI von ${adresse} nicht zugelassen: ${imei}`);
            socket.end(Buffer.from([0x00]));
            return;
          }
          console.log(`[teltonika] IMEI von ${adresse}: ${imei}`);
          socket.write(Buffer.from([0x01])); // akzeptiert
          continue;
        }

        const ergebnis = parseAvlPacket(puffer);
        if (!ergebnis) return; // noch nicht genug Daten für das nächste Paket

        const { codecId, records, bytesRead } = ergebnis;
        insertRawPacket({
          deviceId: imei,
          protocol: "teltonika",
          receivedAt: Date.now(),
          payload: puffer.subarray(0, bytesRead),
        });
        for (const r of records) {
          const id = insertPosition({
            deviceId: imei,
            at: r.at,
            lat: r.lat,
            lon: r.lon,
            speedKmh: r.speedKmh,
            course: r.course,
            altitude: r.altitude,
            sats: r.sats,
            ignition: r.ignition,
            motion: r.motion,
            protocol: "teltonika",
          });
          if (id === null) continue; // erneut gesendetes Duplikat
          // Je Datensatz einzeln prüfen, nicht erst nach dem ganzen Paket —
          // ein nachgeliefertes Paket nach einer Standzeit kann mehrere
          // Zonen-Wechsel in chronologischer Reihenfolge enthalten.
          pruefeZonenwechsel({ id, deviceId: imei, at: r.at, lat: r.lat, lon: r.lon });
        }
        console.log(
          `[teltonika] ${records.length} Datensatz/Datensätze von ${imei} gespeichert ` +
          `(Codec ${codecId === CODEC8_EXTENDED ? "8E" : "8"})`
        );
        // Einmal je Paket, nicht je Datensatz (siehe auto-import.js für die
        // zusätzliche Drosselung je Gerät) — ein nachgeliefertes Paket kann
        // hunderte Datensätze auf einmal enthalten.
        pruefeStoppsFuerGeraet(imei);

        // Bestätigung: Anzahl akzeptierter Datensätze, wie von Teltonika
        // spezifiziert — bei uns immer == der gesendeten Anzahl, da wir bei
        // jedem Strukturfehler die ganze Verbindung trennen statt einzelne
        // Datensätze zu verwerfen (siehe catch unten).
        const antwort = Buffer.alloc(4);
        antwort.writeUInt32BE(records.length, 0);
        socket.write(antwort);

        puffer = puffer.subarray(bytesRead);
      }
    }

    socket.on("data", (chunk) => {
      puffer = puffer.length ? Buffer.concat([puffer, chunk]) : chunk;
      if (ROH_LOGGEN) console.log(`[teltonika] roh von ${adresse}: ${chunk.toString("hex")}`);
      try {
        verarbeitePuffer();
      } catch (err) {
        // Ein Strukturfehler (falscher Vorspann, falsche CRC, unstimmige
        // Datensatzzahl) macht den restlichen Pufferinhalt unzuverlässig —
        // kein sicherer Wiedereinstiegspunkt bekannt, also Verbindung
        // trennen statt raten. Das Gerät verbindet sich von selbst neu.
        console.error(`[teltonika] Protokollfehler von ${adresse} (IMEI ${imei ?? "unbekannt"}): ${err.message}`);
        socket.destroy();
      }
    });

    socket.on("timeout", () => {
      console.log(`[teltonika] Leerlauf-Timeout, trenne ${adresse} (IMEI ${imei ?? "unbekannt"})`);
      socket.destroy();
    });
    socket.on("error", (err) => {
      console.error(`[teltonika] Socket-Fehler von ${adresse} (IMEI ${imei ?? "unbekannt"}): ${err.message}`);
    });
    socket.on("close", () => {
      console.log(`[teltonika] Verbindung geschlossen: ${adresse} (IMEI ${imei ?? "unbekannt"})`);
    });
  });

  server.listen(port, () => {
    console.log(`[tracker-backend] Teltonika-Empfänger läuft auf Port ${port}`);
  });
  return server;
}
