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
