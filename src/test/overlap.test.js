import { test } from "node:test";
import assert from "node:assert/strict";
import { doppeltBefahren, linienBreite } from "../overlap.js";

// Gerade Straße von West nach Ost bei 52° N: 0,001° Länge ≈ 68 m.
const GRAD = 0.001;
const punkt = (i, tag, stunde, extra = {}, folge = i) => ({
  lon: 8 + i * GRAD, lat: 52, day: tag, time: new Date(Date.UTC(2026, 9, 25 + tag, stunde, 0, folge * 20)).toISOString(), ...extra,
});
// Die Zeit läuft in Fahrtrichtung vorwärts, auch bei Fahrten von Ost nach West.
const fahrt = (tag, stunde, von, bis, extra = {}) => {
  const out = [];
  const schritt = von <= bis ? 1 : -1;
  for (let i = von, folge = 0; schritt > 0 ? i <= bis : i >= bis; i += schritt, folge++) out.push(punkt(i, tag, stunde, extra, folge));
  return out;
};

test("linienBreite: früheste Fahrt am breitesten, jede spätere schmaler, mindestens zwei Stufen", () => {
  assert.equal(linienBreite(0, 2), 6.4);
  assert.ok(linienBreite(1, 2) < linienBreite(0, 2));
  assert.ok(linienBreite(0, 3) > linienBreite(1, 3) && linienBreite(1, 3) > linienBreite(2, 3));
  assert.equal(linienBreite(9, 9), linienBreite(3, 4));   // auf vier Stufen begrenzt
  assert.ok(linienBreite(3, 4) >= 2);
});

test("keine Überlappung: eine Fahrt, oder zwei Fahrten auf getrennten Straßen", () => {
  assert.deepEqual(doppeltBefahren([fahrt(1, 8, 0, 60)]), []);
  assert.deepEqual(doppeltBefahren([]), []);
  const nord = fahrt(2, 8, 0, 60).map((p) => ({ ...p, lat: 52.01 }));   // gut 1 km weiter nördlich
  assert.deepEqual(doppeltBefahren([fahrt(1, 8, 0, 60), nord]), []);
});

test("Hin- und Rückweg über dieselbe Strecke: zwei Stufen, die frühere zuerst und breiter", () => {
  const hin = fahrt(1, 8, 0, 60);
  const rueck = fahrt(2, 15, 60, 0, { lat: 52.00015 });   // gut 15 m daneben, andere Richtung
  const laeufe = doppeltBefahren([hin, rueck]);
  assert.ok(laeufe.length >= 2);
  assert.ok(laeufe.every((l) => l.anzahl === 2));
  const raenge = new Set(laeufe.map((l) => l.rang));
  assert.deepEqual([...raenge].sort(), [0, 1]);
  // früheste Fahrt (Rang 0) kommt vor der späteren in der Liste, damit die schmale oben liegt
  assert.ok(laeufe[0].rang <= laeufe[laeufe.length - 1].rang);
  assert.equal(laeufe.find((l) => l.rang === 0).punkt.day, 1);
  assert.equal(laeufe.find((l) => l.rang === 1).punkt.day, 2);
  // Der Lauf deckt die ganze Strecke ab (rund 4 km).
  const laenge = (r) => laeufe.filter((l) => l.rang === r).reduce((n, l) => n + (l.coords.length - 1) * 25, 0);
  assert.ok(laenge(0) > 3000 && laenge(1) > 3000);
});

test("drei Fahrten übereinander: drei Stufen", () => {
  const laeufe = doppeltBefahren([fahrt(1, 8, 0, 60), fahrt(2, 8, 60, 0), fahrt(3, 8, 0, 60)]);
  assert.ok(laeufe.every((l) => l.anzahl === 3));
  assert.deepEqual([...new Set(laeufe.map((l) => l.rang))].sort(), [0, 1, 2]);
});

test("kurze Berührung (unter 120 m) zählt nicht, z. B. gemeinsamer Parkplatz oder Kreuzung", () => {
  const a = fahrt(1, 8, 0, 60);
  const quer = [0, 1, 2, 3, 4].map((i) => ({ lon: 8 + 0.03, lat: 52 - 0.002 + i * 0.001, day: 2, time: new Date(Date.UTC(2026, 9, 27, 9, i)).toISOString() }));
  assert.deepEqual(doppeltBefahren([a, quer]), []);
  // Nur ein kleines gemeinsames Stück am Anfang:
  const b = [...fahrt(2, 9, 0, 1), ...fahrt(2, 9, 1, 1).map((p) => ({ ...p, lat: 52.02 })), { ...punkt(2, 2, 9, {}, 5), lat: 52.03 }];
  assert.deepEqual(doppeltBefahren([a, b]), []);
});

test("eine Zeitlücke im selben Stück trennt zwei Durchfahrten (Hin und Rück am selben Tag)", () => {
  const hin = fahrt(1, 8, 0, 60);
  const rueck = fahrt(1, 16, 60, 0, { lat: 52.0001 });
  const laeufe = doppeltBefahren([[...hin, ...rueck]]);
  assert.ok(laeufe.length >= 2);
  assert.deepEqual([...new Set(laeufe.map((l) => l.rang))].sort(), [0, 1]);
});

test("ohne Zeitstempel zählt die Reihenfolge der Stücke", () => {
  const ohne = (liste) => liste.map(({ lon, lat, day }) => ({ lon, lat, day }));
  const laeufe = doppeltBefahren([ohne(fahrt(1, 8, 0, 60)), ohne(fahrt(2, 8, 60, 0))]);
  assert.ok(laeufe.length >= 2);
  assert.equal(laeufe.find((l) => l.rang === 0).punkt.day, 1);
});
