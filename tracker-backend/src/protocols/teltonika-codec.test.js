// Rundlauf-Tests: encodeAvlPacket() (nur hier, testinterner Gegenspieler zu
// parseAvlPacket) baut ein Paket aus bekannten Werten, parseAvlPacket() liest
// es zurück — stimmen die Werte überein, sind Decoder und die vom Decoder
// vorausgesetzte Bytereihenfolge/-größe zumindest in sich konsistent.
//
// WICHTIG: Das allein beweist NICHT, dass unsere Spezifikations-Annahme
// (Feldreihenfolge/-größen) mit echten Teltonika-Geräten übereinstimmt —
// Encoder und Decoder teilen ja dieselbe Annahme und könnten gemeinsam
// danebenliegen. Der echte Beweis kommt erst mit einer rohen Byte-Sequenz
// vom RUTX50 (siehe Warnung in teltonika-codec.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  crc16, parseImeiPacket, parseAvlPacket, CODEC8, CODEC8_EXTENDED,
} from "./teltonika-codec.js";

function encodeIoElement(id, value, idBytes, lenBytes) {
  const buf = Buffer.alloc(idBytes + lenBytes);
  if (idBytes === 2) buf.writeUInt16BE(id, 0); else buf.writeUInt8(id, 0);
  if (lenBytes === 1) buf.writeUInt8(value, idBytes);
  else if (lenBytes === 2) buf.writeUInt16BE(value, idBytes);
  else if (lenBytes === 4) buf.writeUInt32BE(value, idBytes);
  else if (lenBytes === 8) buf.writeBigUInt64BE(BigInt(value), idBytes);
  return buf;
}

function encodeAvlRecord(r, codecId) {
  const idBytes = codecId === CODEC8_EXTENDED ? 2 : 1;
  const countBytes = codecId === CODEC8_EXTENDED ? 2 : 1;
  const parts = [];

  const kopf = Buffer.alloc(8 + 1 + 4 + 4 + 2 + 2 + 1 + 2);
  kopf.writeBigUInt64BE(BigInt(r.at), 0);
  kopf.writeUInt8(r.priority ?? 0, 8);
  kopf.writeInt32BE(Math.round(r.lon * 1e7), 9);
  kopf.writeInt32BE(Math.round(r.lat * 1e7), 13);
  kopf.writeInt16BE(r.altitude ?? 0, 17);
  kopf.writeUInt16BE(r.course ?? 0, 19);
  kopf.writeUInt8(r.sats ?? 0, 21);
  kopf.writeUInt16BE(r.speedKmh ?? 0, 22);
  parts.push(kopf);

  const einByteElemente = [];
  if (r.ignition !== undefined) einByteElemente.push([239, r.ignition ? 1 : 0]);
  if (r.motion !== undefined) einByteElemente.push([240, r.motion ? 1 : 0]);

  const schreibZaehler = (n) => {
    const b = Buffer.alloc(countBytes);
    if (countBytes === 2) b.writeUInt16BE(n, 0); else b.writeUInt8(n, 0);
    return b;
  };

  parts.push(Buffer.alloc(idBytes)); // Event-IO-ID = 0 (kein Ereignis)
  parts.push(schreibZaehler(einByteElemente.length)); // Gesamtzahl IO-Elemente

  parts.push(schreibZaehler(einByteElemente.length)); // N1
  for (const [id, val] of einByteElemente) parts.push(encodeIoElement(id, val, idBytes, 1));
  parts.push(schreibZaehler(0)); // N2
  parts.push(schreibZaehler(0)); // N4
  parts.push(schreibZaehler(0)); // N8
  if (codecId === CODEC8_EXTENDED) parts.push(schreibZaehler(0)); // NX

  return Buffer.concat(parts);
}

function encodeAvlPacket(codecId, records) {
  const satzBuffer = records.map((r) => encodeAvlRecord(r, codecId));
  const daten = Buffer.concat([
    Buffer.from([codecId, records.length]),
    ...satzBuffer,
    Buffer.from([records.length]),
  ]);
  const kopf = Buffer.alloc(8);
  kopf.writeUInt32BE(0, 0);
  kopf.writeUInt32BE(daten.length, 4);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc16(daten), 0);
  return Buffer.concat([kopf, daten, crcBuf]);
}

test("crc16 ist deterministisch und reagiert auf jedes veränderte Byte", () => {
  const a = Buffer.from([0x08, 0x01, 0x02, 0x03]);
  const b = Buffer.from([0x08, 0x01, 0x02, 0x04]);
  assert.equal(crc16(a), crc16(a));
  assert.notEqual(crc16(a), crc16(b));
  assert.equal(crc16(Buffer.alloc(0)), 0);
});

test("parseImeiPacket liest Länge + ASCII-IMEI korrekt, meldet fehlende Daten als null", () => {
  const imei = "352094081234567";
  const buf = Buffer.concat([
    Buffer.from([0x00, imei.length]),
    Buffer.from(imei, "ascii"),
  ]);
  assert.equal(parseImeiPacket(buf.subarray(0, 1)), null); // nicht mal Länge da
  assert.equal(parseImeiPacket(buf.subarray(0, buf.length - 3)), null); // IMEI unvollständig
  const ergebnis = parseImeiPacket(buf);
  assert.equal(ergebnis.imei, imei);
  assert.equal(ergebnis.bytesRead, buf.length);
});

test("Codec8: ein Datensatz mit Ignition+Movement geht per Rundlauf unverändert durch", () => {
  const eingabe = {
    at: 1755350000000, priority: 1,
    lat: 52.1234567, lon: 7.7654321,
    altitude: 123, course: 270, sats: 9, speedKmh: 42,
    ignition: true, motion: false,
  };
  const paket = encodeAvlPacket(CODEC8, [eingabe]);
  const ergebnis = parseAvlPacket(paket);
  assert.equal(ergebnis.bytesRead, paket.length);
  assert.equal(ergebnis.codecId, CODEC8);
  assert.equal(ergebnis.records.length, 1);
  const r = ergebnis.records[0];
  assert.equal(r.at, eingabe.at);
  assert.equal(r.priority, eingabe.priority);
  assert.ok(Math.abs(r.lat - eingabe.lat) < 1e-6);
  assert.ok(Math.abs(r.lon - eingabe.lon) < 1e-6);
  assert.equal(r.altitude, eingabe.altitude);
  assert.equal(r.course, eingabe.course);
  assert.equal(r.sats, eingabe.sats);
  assert.equal(r.speedKmh, eingabe.speedKmh);
  assert.equal(r.ignition, true);
  assert.equal(r.motion, false);
});

test("Codec8: negative Koordinaten (südliche/westliche Halbkugel) und negative Höhe bleiben korrekt", () => {
  const eingabe = { at: 1755350000000, lat: -33.865143, lon: -63.987654, altitude: -15, speedKmh: 0 };
  const paket = encodeAvlPacket(CODEC8, [eingabe]);
  const { records } = parseAvlPacket(paket);
  assert.ok(Math.abs(records[0].lat - eingabe.lat) < 1e-6);
  assert.ok(Math.abs(records[0].lon - eingabe.lon) < 1e-6);
  assert.equal(records[0].altitude, -15);
});

test("Codec8: mehrere Datensätze in einem Paket (gepuffert-und-nachgeliefert, wie beim ESP32-Logger erwartet)", () => {
  const eingaben = [
    { at: 1755350000000, lat: 52.1, lon: 7.1, speedKmh: 10 },
    { at: 1755350010000, lat: 52.2, lon: 7.2, speedKmh: 20 },
    { at: 1755350020000, lat: 52.3, lon: 7.3, speedKmh: 0, ignition: false, motion: false },
  ];
  const paket = encodeAvlPacket(CODEC8, eingaben);
  const { records, bytesRead } = parseAvlPacket(paket);
  assert.equal(bytesRead, paket.length);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((r) => r.at), eingaben.map((e) => e.at));
});

test("Codec8 Extended: 2-Byte IO-IDs/Zähler werden korrekt gelesen (nicht mit Codec8 verwechselt)", () => {
  const eingabe = { at: 1755350000000, lat: 48.137154, lon: 11.576124, ignition: true, motion: true, speedKmh: 5 };
  const paket = encodeAvlPacket(CODEC8_EXTENDED, [eingabe]);
  const ergebnis = parseAvlPacket(paket);
  assert.equal(ergebnis.codecId, CODEC8_EXTENDED);
  assert.equal(ergebnis.records[0].ignition, true);
  assert.equal(ergebnis.records[0].motion, true);
});

test("parseAvlPacket meldet unvollständige Pakete als null statt zu werfen (TCP kann in Häppchen liefern)", () => {
  const paket = encodeAvlPacket(CODEC8, [{ at: 1, lat: 1, lon: 1 }]);
  assert.equal(parseAvlPacket(paket.subarray(0, 4)), null); // nicht mal die Länge komplett
  assert.equal(parseAvlPacket(paket.subarray(0, paket.length - 1)), null); // 1 Byte fehlt am Ende (CRC unvollständig)
});

test("parseAvlPacket wirft bei falschem Vorspann", () => {
  const paket = encodeAvlPacket(CODEC8, [{ at: 1, lat: 1, lon: 1 }]);
  paket.writeUInt32BE(0x01, 0); // Vorspann kaputt machen
  assert.throws(() => parseAvlPacket(paket), /Vorspann/);
});

test("parseAvlPacket wirft bei verfälschter Prüfsumme (z. B. Bitfehler auf der Leitung)", () => {
  const paket = encodeAvlPacket(CODEC8, [{ at: 1, lat: 1, lon: 1 }]);
  paket[paket.length - 1] ^= 0xff; // letztes CRC-Byte kippen
  assert.throws(() => parseAvlPacket(paket), /CRC/);
});

test("parseAvlPacket wirft, wenn NOD1 und NOD2 nicht übereinstimmen (Rahmen inkonsistent)", () => {
  const paket = encodeAvlPacket(CODEC8, [{ at: 1, lat: 1, lon: 1 }]);
  // NOD2 steht am Ende der Nutzdaten, direkt vor der 4-Byte-CRC. Nach dem
  // Verfälschen muss die CRC neu berechnet werden — sonst würde schon die
  // CRC-Prüfung (die vor der NOD-Prüfung läuft) zuschlagen, nicht die hier
  // eigentlich getestete Konsistenzprüfung.
  paket[paket.length - 4 - 1] = 5; // NOD2 auf einen falschen Wert setzen
  const daten = paket.subarray(8, paket.length - 4);
  paket.writeUInt32BE(crc16(daten), paket.length - 4);
  assert.throws(() => parseAvlPacket(paket), /Datensatzzahl/);
});
