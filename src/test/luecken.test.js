import { test } from "node:test";
import assert from "node:assert/strict";
import { findeLuecken, abstandZurStrecke, dauerText } from "../luecken.js";

const p = (sek, lon, lat = 52) => ({ time: new Date(Date.UTC(2026, 9, 26, 10, 0, sek)).toISOString(), lon, lat });

test("findeLuecken: lange Pause UND weiter Sprung ergibt eine Lücke", () => {
  // 0,01° Länge bei 52° ≈ 685 m
  const l = findeLuecken([[p(0, 8), p(2, 8.0001), p(98, 8.0141), p(100, 8.0142)]]);
  assert.equal(l.length, 1);
  assert.equal(l[0].sekunden, 96);
  assert.ok(l[0].meter > 900 && l[0].meter < 1000);
  assert.equal(l[0].von.lon, 8.0001);
  assert.equal(l[0].nach.lon, 8.0141);
});

test("findeLuecken: normaler Abstand, Stand mit langer Pause und kurzer Sprung zählen nicht", () => {
  assert.deepEqual(findeLuecken([[p(0, 8), p(3, 8.0004), p(6, 8.0008)]]), []);
  assert.deepEqual(findeLuecken([[p(0, 8), p(3600, 8.00005)]]), []);          // Stand: 1 h, 3 m
  assert.deepEqual(findeLuecken([[p(0, 8), p(30, 8.02)]]), []);                // 1,4 km, aber nur 30 s
  assert.deepEqual(findeLuecken([[p(0, 8), p(60, 8.0050)]]), []);              // 60 s, aber nur ~340 m
});

test("findeLuecken: über Linienstücke hinweg, ohne Zeitstempel keine Lücke", () => {
  const l = findeLuecken([[p(0, 8), p(5, 8.001)], [p(0, 9), p(120, 9.03)]]);
  assert.equal(l.length, 1);
  assert.equal(l[0].sekunden, 120);
  assert.deepEqual(findeLuecken([[{ lon: 8, lat: 52 }, { lon: 8.05, lat: 52 }]]), []);
  assert.deepEqual(findeLuecken(null), []);
});

test("abstandZurStrecke: Punkt neben der Mitte, hinter dem Ende, auf der Strecke", () => {
  const a = { lon: 8, lat: 52 };
  const b = { lon: 8.02, lat: 52 };
  assert.ok(Math.abs(abstandZurStrecke(8.01, 52.0009, a, b) - 100) < 2);   // ≈ 0,0009° Breite ≈ 100 m
  assert.ok(Math.abs(abstandZurStrecke(8.03, 52, a, b) - 685) < 5);        // 0,01° hinter dem Ende
  assert.ok(abstandZurStrecke(8.005, 52, a, b) < 0.5);
  assert.ok(abstandZurStrecke(8, 52, a, a) < 0.5);                          // entartete Strecke
});

test("dauerText", () => {
  assert.equal(dauerText(96), "96 s");
  assert.equal(dauerText(120), "2 min");
  assert.equal(dauerText(205), "3 min 25 s");
});
