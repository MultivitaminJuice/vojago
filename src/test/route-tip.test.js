import { test } from "node:test";
import assert from "node:assert/strict";
import { routenTipp } from "../route-tip.js";
import { naechsterRoutenpunkt, meterProPixel } from "../geo.js";

test("routenTipp: Tag, Datum, Uhrzeit, Kilometer, Tempo und Höhe", () => {
  const t = routenTipp({ day: 4, time: "2026-10-21T12:32:10.000Z", cum: 1240.4, spd: 81.6, elev: 411.7 });
  assert.match(t.kopf, /^Tag 4 · \w+ 21\.10\. · \d\d:\d\d$/);
  assert.equal(t.werte, "km 1.240 · 82 km/h · 412 m");
});

test("routenTipp: kurze Strecke mit Nachkommastelle, Stand statt 0 km/h, fehlende Werte entfallen", () => {
  assert.equal(routenTipp({ cum: 3.26, spd: 0.4, elev: 10 }).werte, "km 3,3 · steht · 10 m");
  const leer = routenTipp({});
  assert.equal(leer.kopf, "");
  assert.equal(leer.werte, "");
  assert.equal(routenTipp({ time: "kaputt", cum: 5 }).kopf, "");
});

test("naechsterRoutenpunkt: findet den nächsten Punkt nur innerhalb der Toleranz", () => {
  const pfad = [{ lon: 10, lat: 50 }, { lon: 10.001, lat: 50 }, { lon: 10.002, lat: 50 }];
  const treffer = naechsterRoutenpunkt(pfad, 10.00105, 50.0001, 50);
  assert.equal(treffer.index, 1);
  assert.ok(treffer.abstandM < 20);
  assert.equal(naechsterRoutenpunkt(pfad, 10.001, 50.01, 50), null);
  assert.equal(naechsterRoutenpunkt([], 10, 50, 50), null);
});

test("meterProPixel: halbiert sich je Zoomstufe, kleiner nach Norden", () => {
  assert.ok(Math.abs(meterProPixel(10, 0) / meterProPixel(11, 0) - 2) < 1e-9);
  assert.ok(meterProPixel(10, 60) < meterProPixel(10, 0));
});
