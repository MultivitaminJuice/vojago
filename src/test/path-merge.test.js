import test from "node:test";
import assert from "node:assert/strict";
import { haengeNeuePunkteAn } from "../path-merge.js";

const punkt = (min, lon, cum, day = 1) => ({ lon, lat: 50, cum, day, time: new Date(Date.UTC(2026, 9, 18, 10, min)).toISOString() });

test("haengeNeuePunkteAn: nur zeitlich neuere Punkte werden angehängt, Kilometerstand läuft weiter", () => {
  const alt = [punkt(0, 10.000, 0), punkt(1, 10.001, 0.07)];
  // frisch gebauter Pfad (cum ab 0): der erste Punkt ist der schon bekannte (min 1)
  const neu = [punkt(1, 10.001, 0), punkt(2, 10.002, 0.07), punkt(3, 10.003, 0.14)];
  const r = haengeNeuePunkteAn(alt, neu);
  assert.equal(r.length, 4);
  assert.deepEqual(r.map((p) => p.lon), [10.000, 10.001, 10.002, 10.003]);
  assert.ok(r[2].cum > r[1].cum && r[3].cum > r[2].cum, "cum steigt weiter");
  assert.ok(Math.abs(r[3].cum - 0.21) < 0.02, "≈ 3 × 70 m");
  assert.equal(alt.length, 2, "der alte Pfad wird nicht verändert");
});

test("haengeNeuePunkteAn: ohne Neues kommt derselbe Pfad zurück", () => {
  const alt = [punkt(0, 10, 0), punkt(1, 10.001, 0.07)];
  assert.equal(haengeNeuePunkteAn(alt, [punkt(0, 10, 0), punkt(1, 10.001, 0)]), alt);
  assert.equal(haengeNeuePunkteAn(alt, []), alt);
});

test("haengeNeuePunkteAn: leerer alter Pfad übernimmt den neuen", () => {
  const neu = [punkt(0, 10, 0)];
  assert.equal(haengeNeuePunkteAn([], neu), neu);
});
