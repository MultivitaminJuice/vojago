import test from "node:test";
import assert from "node:assert/strict";

import { glaetteStandRauschen, distanceKm } from "../geo.js";

// Nutzer-Fund, 5. September 2026: GPS-Rauschen im Stand (Mehrwegeausbreitung
// an Gebäuden) zeichnete eine sichtbare Schleife auf einem Parkplatz, obwohl
// das Fahrzeug fest stand.

test("glaetteStandRauschen: springende Fixe im Stand werden auf einen Anker gezogen", () => {
  const basis = { lon: 6.0, lat: 51.9 };
  const wackler = (dLon, dLat, spd = 0) => ({ lon: basis.lon + dLon, lat: basis.lat + dLat, elev: 10, spd });
  const punkte = [
    wackler(0, 0),
    wackler(0.00005, 0.00003), // wenige Meter Rauschen
    wackler(-0.00004, 0.00006),
    wackler(0.00003, -0.00004),
  ];
  const geglaettet = glaetteStandRauschen(punkte);
  assert.equal(geglaettet.length, punkte.length, "keine Punkte verschwinden");
  for (const p of geglaettet) {
    assert.equal(p.lat, geglaettet[0].lat);
    assert.equal(p.lon, geglaettet[0].lon);
  }
});

test("glaetteStandRauschen: echte Bewegung bleibt unangetastet", () => {
  const punkte = [
    { lon: 6.0, lat: 51.9, elev: 10, spd: 40 },
    { lon: 6.01, lat: 51.91, elev: 10, spd: 45 },
    { lon: 6.02, lat: 51.92, elev: 10, spd: 42 },
  ];
  const geglaettet = glaetteStandRauschen(punkte);
  assert.deepEqual(geglaettet, punkte);
});

test("glaetteStandRauschen: ein echter Ortswechsel im Stand (>Radius) setzt einen neuen Anker", () => {
  const a = { lon: 6.0, lat: 51.9, elev: 10, spd: 1 };
  // rund 50m entfernt — deutlich über dem Glättungsradius
  const b = { lon: 6.0006, lat: 51.9, elev: 10, spd: 1 };
  const geglaettet = glaetteStandRauschen([a, b]);
  assert.equal(geglaettet[0].lon, a.lon);
  assert.equal(geglaettet[1].lon, b.lon, "weit entfernter Fix bleibt eigenständig, kein Wegziehen zum alten Anker");
  assert.ok(distanceKm(a.lon, a.lat, b.lon, b.lat) * 1000 > 12);
});

import { vereinfache } from "../geo.js";

test("vereinfache: eine gerade Linie schrumpft auf Anfang und Ende", () => {
  const linie = Array.from({ length: 50 }, (_, i) => ({ lon: 10 + i * 0.0002, lat: 50, cum: i }));
  const r = vereinfache(linie, 3);
  assert.equal(r.length, 2);
  assert.equal(r[0], linie[0]);
  assert.equal(r[1], linie[49]);
});

test("vereinfache: eine Ecke bleibt erhalten, Felder der Punkte auch", () => {
  const linie = [
    { lon: 10.000, lat: 50.000, cum: 0, time: "a" },
    { lon: 10.001, lat: 50.000, cum: 1, time: "b" },
    { lon: 10.002, lat: 50.000, cum: 2, time: "c" },
    { lon: 10.002, lat: 50.001, cum: 3, time: "d" },
    { lon: 10.002, lat: 50.002, cum: 4, time: "e" },
  ];
  const r = vereinfache(linie, 3);
  assert.deepEqual(r.map((p) => p.time), ["a", "c", "e"], "Ecke (c) bleibt, Zwischenpunkte entfallen");
});

test("vereinfache: Kürzere Linien und Rauschen unter der Toleranz", () => {
  assert.deepEqual(vereinfache([], 3), []);
  const zwei = [{ lon: 1, lat: 1 }, { lon: 2, lat: 2 }];
  assert.equal(vereinfache(zwei, 3), zwei);
  // 1 m seitlicher Ausreißer bei 3 m Toleranz entfällt, bei 0,5 m bleibt er
  const mitRauschen = [{ lon: 10, lat: 50 }, { lon: 10.0005, lat: 50.00001 }, { lon: 10.001, lat: 50 }];
  assert.equal(vereinfache(mitRauschen, 3).length, 2);
  assert.equal(vereinfache(mitRauschen, 0.5).length, 3);
});
