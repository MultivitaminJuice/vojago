// Teltonika Codec8 / Codec8 Extended — reine Encode-/Decode-Funktionen,
// keine Netzwerklogik (die lebt in teltonika.js). Nachgebaut nach
// Teltonikas offen dokumentiertem AVL-Protokoll, mit Traccars quelloffener
// Implementierung (TeltonikaProtocolDecoder) als Bauplan fürs
// Protokollverständnis — nicht übernommener Code, komplett neu in
// JavaScript geschrieben (bewusste Entscheidung gegen das Einbetten von
// Java-Code, wegen der JVM-Abhängigkeit).
//
// ACHTUNG — noch nicht an echten RUTX50-Paketen geprüft: Nur per
// Encode/Decode-Rundlauf gegen sich selbst getestet (siehe .test.js), noch
// keine echte Byte-Sequenz von echter Hardware verglichen. Vor dem ersten
// Echtbetrieb: rohe Bytes eines echten Pakets loggen (siehe teltonika.js,
// TRACKER_LOG_RAW_TELTONIKA) und von Hand mit dieser Spezifikation
// abgleichen.

export const CODEC8 = 0x08;
export const CODEC8_EXTENDED = 0x8e;

// IO-Element-IDs, die VOJAĜO tatsächlich auswertet (siehe schema.sql) — wir
// übernehmen bewusst nicht Traccars komplettes Attribut-Sammelsurium. Beide
// Nummern sind Teltonikas eigene, geräteübergreifend stabile AVL-IDs.
const IO_IGNITION = 239;
const IO_MOVEMENT = 240;

// Schutz gegen ein Längenfeld, das durch einen Bitfehler oder einen
// falsch sprechenden Client Unsinn enthält: ohne Obergrenze würde
// parseAvlPacket()/parseImeiPacket() einfach endlos auf "genug Bytes"
// warten (null zurückgeben) und die Verbindung puffert unbegrenzt weiter.
// Echte Teltonika-Pakete bleiben auch mit vielen Datensätzen weit darunter.
const MAX_DATEN_LAENGE = 100_000;
const MAX_IMEI_LAENGE = 64;

/** CRC-16/ARC (IBM) — die Prüfsumme, die Teltonika für den Rahmen nutzt. */
export function crc16(buf) {
  let crc = 0x0000;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

/**
 * Versucht, das einmalige IMEI-Paket vom Anfang des Puffers zu lesen (nur
 * direkt beim Verbindungsaufbau, vor jedem Codec-Paket).
 * @returns {{imei: string, bytesRead: number} | null} null = noch nicht genug Daten angekommen
 */
export function parseImeiPacket(buf) {
  if (buf.length < 2) return null;
  const laenge = buf.readUInt16BE(0);
  if (laenge > MAX_IMEI_LAENGE) throw new Error(`IMEI-Länge unplausibel: ${laenge}`);
  if (buf.length < 2 + laenge) return null;
  const imei = buf.toString("ascii", 2, 2 + laenge);
  return { imei, bytesRead: 2 + laenge };
}

function decodeIoElement(buf, offset, idBytes, lenBytes) {
  const id = idBytes === 2 ? buf.readUInt16BE(offset) : buf.readUInt8(offset);
  offset += idBytes;
  let value;
  if (lenBytes === 1) value = buf.readUInt8(offset);
  else if (lenBytes === 2) value = buf.readUInt16BE(offset);
  else if (lenBytes === 4) value = buf.readUInt32BE(offset);
  else if (lenBytes === 8) value = buf.readBigUInt64BE(offset);
  offset += lenBytes;
  return { id, value, offset };
}

/** Eine AVL-Datenzeile lesen (Zeitstempel, GPS, IO-Elemente). */
function decodeAvlRecord(buf, offset, codecId) {
  const at = Number(buf.readBigUInt64BE(offset)); offset += 8;
  const priority = buf.readUInt8(offset); offset += 1;
  const lon = buf.readInt32BE(offset) / 1e7; offset += 4;
  const lat = buf.readInt32BE(offset) / 1e7; offset += 4;
  const altitude = buf.readInt16BE(offset); offset += 2;
  const course = buf.readUInt16BE(offset); offset += 2;
  const sats = buf.readUInt8(offset); offset += 1;
  const speedKmh = buf.readUInt16BE(offset); offset += 2;

  // Codec8 Extended nutzt 2-Byte IDs/Zähler statt 1-Byte, plus eine
  // zusätzliche Gruppe variabler Länge (NX) am Ende.
  const idBytes = codecId === CODEC8_EXTENDED ? 2 : 1;
  const countBytes = codecId === CODEC8_EXTENDED ? 2 : 1;
  const liesAnzahl = () => {
    const n = countBytes === 2 ? buf.readUInt16BE(offset) : buf.readUInt8(offset);
    offset += countBytes;
    return n;
  };

  offset += idBytes; // Event-IO-ID — welches Element das Ereignis auslöste, werten wir nicht aus
  liesAnzahl(); // Gesamtzahl IO-Elemente — nur zur Information, wir lesen die vier/fünf Gruppen einzeln

  const io = new Map();
  for (const lenBytes of [1, 2, 4, 8]) {
    const n = liesAnzahl();
    for (let i = 0; i < n; i++) {
      const el = decodeIoElement(buf, offset, idBytes, lenBytes);
      io.set(el.id, el.value);
      offset = el.offset;
    }
  }
  if (codecId === CODEC8_EXTENDED) {
    // NX — Elemente variabler Länge. VOJAĜO braucht aktuell keins davon,
    // aber wir müssen sie überlesen, um an die nächste Zeile/Prüfsumme
    // zu kommen.
    const nx = liesAnzahl();
    for (let i = 0; i < nx; i++) {
      offset += idBytes;
      const laenge = buf.readUInt16BE(offset); offset += 2;
      offset += laenge;
    }
  }

  return {
    offset,
    record: {
      at, priority, lat, lon, altitude, course, sats, speedKmh,
      ignition: io.has(IO_IGNITION) ? Boolean(Number(io.get(IO_IGNITION))) : undefined,
      motion: io.has(IO_MOVEMENT) ? Boolean(Number(io.get(IO_MOVEMENT))) : undefined,
    },
  };
}

/**
 * Versucht, ein vollständiges Codec8/8E-AVL-Datenpaket vom Anfang des
 * Puffers zu lesen. Wirft bei einem strukturell ungültigen Paket (falscher
 * Vorspann, falsche Prüfsumme, unstimmige Datensatzzahl) — das unterscheidet
 * "kaputt" bewusst von "noch nicht vollständig da" (null).
 * @returns {{codecId: number, records: object[], bytesRead: number} | null}
 */
export function parseAvlPacket(buf) {
  if (buf.length < 8) return null; // noch nicht mal Vorspann + Länge da
  const praeambel = buf.readUInt32BE(0);
  if (praeambel !== 0) throw new Error(`Vorspann ungültig: 0x${praeambel.toString(16)}`);
  const datenLaenge = buf.readUInt32BE(4);
  if (datenLaenge > MAX_DATEN_LAENGE) throw new Error(`Datenfeldlänge unplausibel: ${datenLaenge}`);
  const gesamtLaenge = 4 + 4 + datenLaenge + 4; // Vorspann + Länge + Daten + CRC
  if (buf.length < gesamtLaenge) return null; // noch nicht alles da

  const daten = buf.subarray(8, 8 + datenLaenge);
  const erwarteteCrc = crc16(daten);
  const tatsaechlicheCrc = buf.readUInt32BE(8 + datenLaenge) & 0xffff;
  if (erwarteteCrc !== tatsaechlicheCrc) {
    throw new Error(`CRC ungültig: erwartet 0x${erwarteteCrc.toString(16)}, bekommen 0x${tatsaechlicheCrc.toString(16)}`);
  }

  const codecId = daten.readUInt8(0);
  const nod1 = daten.readUInt8(1);
  let offset = 2;
  const records = [];
  for (let i = 0; i < nod1; i++) {
    const { record, offset: neuerOffset } = decodeAvlRecord(daten, offset, codecId);
    records.push(record);
    offset = neuerOffset;
  }
  const nod2 = daten.readUInt8(offset); offset += 1;
  if (nod2 !== nod1) throw new Error(`Datensatzzahl stimmt nicht: NOD1=${nod1}, NOD2=${nod2}`);

  return { codecId, records, bytesRead: gesamtLaenge };
}
