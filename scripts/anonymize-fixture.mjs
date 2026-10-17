#!/usr/bin/env node
// Macht aus einer Datei mit echten Positionen eine einfügbare Testdatei:
// Breitengrad spiegeln (lat → -lat) und Längengrad verschieben (lon + 20).
// Alle Abstände und Zeitabläufe bleiben dabei EXAKT gleich (die Haversine-
// Formel kennt nur Breite über cos() und Längendifferenzen), die Tests prüfen
// also weiter dasselbe — nur der Ort ist nicht mehr zuzuordnen.
//
//   node scripts/anonymize-fixture.mjs local/fixtures/foo.json api/test/fixtures/foo.json
//
// Erwartet ein JSON-Array von Objekten mit lat/lon (weitere Felder bleiben).
import { readFileSync, writeFileSync } from "node:fs";

const [, , eingabe, ausgabe] = process.argv;
if (!eingabe || !ausgabe) {
  console.error("Aufruf: node scripts/anonymize-fixture.mjs <echte-datei.json> <anonymisierte-datei.json>");
  process.exit(2);
}
const zeilen = JSON.parse(readFileSync(eingabe, "utf8"));
if (!Array.isArray(zeilen)) { console.error("Erwartet ein JSON-Array."); process.exit(2); }
let n = 0;
for (const z of zeilen) {
  if (Number.isFinite(z.lat) && Number.isFinite(z.lon)) { z.lat = -z.lat; z.lon = z.lon + 20; n++; }
}
writeFileSync(ausgabe, JSON.stringify(zeilen));
console.log(`${n} von ${zeilen.length} Einträgen anonymisiert → ${ausgabe}`);
