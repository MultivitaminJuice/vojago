import { test } from "node:test";
import assert from "node:assert/strict";
import { routenTipp, tippEintraege, naechsterTreffer } from "../route-tip.js";
import { routenTreffer, gleicheStelle, meterProPixel } from "../geo.js";

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

// Strecke von West nach Ost entlang der Breite 50; Hinweg 10:00–10:10, Rückweg 15:00–15:10.
const punkt = (i, zeit, extra = {}) => ({ lon: 10 + i * 0.001, lat: 50, time: zeit, cum: Math.abs(i), ...extra });
const hinweg = Array.from({ length: 11 }, (_, i) => punkt(i, new Date(Date.UTC(2026, 9, 21, 10, i)).toISOString()));
const rueckweg = Array.from({ length: 11 }, (_, i) => punkt(10 - i, new Date(Date.UTC(2026, 9, 21, 15, i)).toISOString(), { lat: 50.00002 }));

test("routenTreffer: eine Fahrt ergibt einen Treffer, nur innerhalb der Toleranz", () => {
  const treffer = routenTreffer(hinweg, 10.005, 50.0001, 50);
  assert.equal(treffer.length, 1);
  assert.equal(treffer[0].index, 5);
  assert.ok(treffer[0].abstandM < 20);
  assert.deepEqual(routenTreffer(hinweg, 10.005, 50.01, 50), []);
  assert.deepEqual(routenTreffer([], 10, 50, 50), []);
});

test("routenTreffer: Hin- und Rückweg über dieselbe Strecke ergeben zwei Durchfahrten in zeitlicher Reihenfolge", () => {
  const pfad = [...hinweg, ...rueckweg];
  const treffer = routenTreffer(pfad, 10.005, 50.00001, 50);
  assert.equal(treffer.length, 2);
  assert.ok(treffer[0].punkt.time < treffer[1].punkt.time);
  assert.equal(treffer[0].punkt.time.slice(11, 13), "10");
  assert.equal(treffer[1].punkt.time.slice(11, 13), "15");
  // Der Rückweg liegt hier näher am Tipp — er darf den Hinweg nicht verdrängen.
  assert.ok(treffer[1].abstandM < treffer[0].abstandM + 5);
});

test("routenTreffer: eine kleine Pause (unter 5 Minuten) im Toleranzbereich bleibt eine Durchfahrt, eine lange Funklücke trennt", () => {
  const kurz = [punkt(0, "2026-10-21T10:00:00Z"), punkt(0.2, "2026-10-21T10:02:00Z"), punkt(0.1, "2026-10-21T10:04:00Z")];
  assert.equal(routenTreffer(kurz, 10.0001, 50, 60).length, 1);
  const stand = [punkt(0, "2026-10-21T16:12:00Z"), punkt(0.1, "2026-10-22T11:56:00Z")];
  assert.equal(routenTreffer(stand, 10.0001, 50, 60).length, 2);
});

test("routenTreffer: ohne Zeitstempel trennt ein großer Indexabstand", () => {
  const ohne = (i) => ({ lon: 10, lat: 50, cum: i });
  const pfad = [...Array.from({ length: 5 }, (_, i) => ohne(i)), ...Array.from({ length: 40 }, () => ({ lon: 11, lat: 51 })), ...Array.from({ length: 5 }, (_, i) => ohne(i))];
  assert.equal(routenTreffer(pfad, 10, 50, 50).length, 2);
});

test("gleicheStelle: weit entfernte Straßen im großen Tipp-Bereich zählen nicht als dieselbe Stelle", () => {
  // Bei weitem Zoom liegen 3 km Toleranz im Tipp-Bereich: Hinweg, Rückweg auf derselben Straße
  // und eine Parallelstraße 2 km weiter nördlich.
  const parallel = Array.from({ length: 11 }, (_, i) => punkt(i, new Date(Date.UTC(2026, 9, 23, 9, i)).toISOString(), { lat: 50.018 }));
  const treffer = routenTreffer([...hinweg, ...rueckweg, ...parallel], 10.005, 50.0005, 3000);
  assert.equal(treffer.length, 3);
  const gleich = gleicheStelle(treffer);
  assert.equal(gleich.length, 2);
  assert.ok(gleich.every((t) => t.punkt.lat < 50.001));
});

test("gleicheStelle: eine einzelne Durchfahrt bleibt, mehrere auf derselben Straße bleiben alle", () => {
  const eine = routenTreffer(hinweg, 10.005, 50, 50);
  assert.equal(gleicheStelle(eine).length, 1);
  assert.deepEqual(gleicheStelle([]), []);
  assert.equal(gleicheStelle(routenTreffer([...hinweg, ...rueckweg], 10.005, 50.00001, 50)).length, 2);
});

test("tippEintraege: bei mehreren Durchfahrten nummeriert, ab dem Limit wird nur gezählt", () => {
  const t = (i) => ({ punkt: { day: i, cum: i, spd: 80, elev: 400, time: `2026-10-2${i}T10:00:00Z` }, index: i, abstandM: i });
  const eins = tippEintraege([t(1)]);
  assert.equal(eins.eintraege.length, 1);
  assert.equal(eins.eintraege[0].titel, "");
  const viele = tippEintraege([t(1), t(2), t(3), t(4), t(5), t(6), t(7)]);
  assert.equal(viele.eintraege.length, 5);
  assert.equal(viele.eintraege[0].titel, "1 von 7");
  assert.equal(viele.eintraege[4].titel, "5 von 7");
  assert.equal(viele.weitere, 2);
});

test("naechsterTreffer: wählt den mit dem kleinsten Abstand, leere Liste ergibt null", () => {
  assert.equal(naechsterTreffer([{ abstandM: 9 }, { abstandM: 3 }, { abstandM: 5 }]).abstandM, 3);
  assert.equal(naechsterTreffer([]), null);
});

test("meterProPixel: halbiert sich je Zoomstufe, kleiner nach Norden", () => {
  assert.ok(Math.abs(meterProPixel(10, 0) / meterProPixel(11, 0) - 2) < 1e-9);
  assert.ok(meterProPixel(10, 60) < meterProPixel(10, 0));
});
