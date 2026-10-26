import test from "node:test";
import assert from "node:assert/strict";
import { zusammenfassen } from "../views/charts.js";

test("zusammenfassen: kurze Reihen bleiben unverändert", () => {
  const werte = [1, 2, 3];
  assert.deepEqual(zusammenfassen(werte, 400), werte);
});

test("zusammenfassen: lange Reihen werden auf n Punkte gemittelt", () => {
  const werte = Array.from({ length: 1000 }, (_, i) => i);
  const reihe = zusammenfassen(werte, 10);
  assert.equal(reihe.length, 10);
  assert.equal(reihe[0], 49.5); // Mittel von 0..99
  assert.equal(reihe[9], 949.5);
});

test("zusammenfassen: der Gesamtmittelwert bleibt erhalten, auch bei ungleich teilbarer Länge", () => {
  const werte = Array.from({ length: 1003 }, (_, i) => (i % 7) * 10);
  const reihe = zusammenfassen(werte, 100);
  assert.equal(reihe.length, 100);
  const mittel = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(Math.abs(mittel(reihe) - mittel(werte)) < 1);
});

test("zusammenfassen: sehr lange Reihen (200 000 Punkte) gehen ohne Fehler", () => {
  const werte = new Array(200_000).fill(5);
  const reihe = zusammenfassen(werte, 400);
  assert.equal(reihe.length, 400);
  assert.ok(reihe.every((v) => v === 5));
});

test("skala: runde Schritte, höchster Wert passt darunter", async () => {
  const { skala } = await import("../views/charts.js");
  assert.deepEqual(skala(558).ticks, [0, 200, 400, 600]);
  assert.equal(skala(558).max, 600);
  assert.deepEqual(skala(73).ticks, [0, 50, 100]);
  assert.deepEqual(skala(1000).ticks, [0, 500, 1000]);
  assert.deepEqual(skala(4.2).ticks, [0, 2, 4, 6].slice(0, skala(4.2).ticks.length));
  assert.ok(skala(4.2).max >= 4.2);
  assert.deepEqual(skala(0), { max: 1, schritt: 1, ticks: [0, 1] });
  assert.deepEqual(skala(-3).ticks, [0, 1]);
});
