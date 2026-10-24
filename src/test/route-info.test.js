import { test } from "node:test";
import assert from "node:assert/strict";
import { routenInfoZeilen } from "../route-info.js";

const uhr = (ms) => `t${ms}`;

test("routenInfoZeilen: noch nichts geladen", () => {
  assert.deepEqual(routenInfoZeilen({}, uhr), [["Zuletzt aktualisiert", "—"]]);
  assert.deepEqual(routenInfoZeilen({ zwischenspeicher: true }, uhr), [["Zuletzt aktualisiert", "noch nicht — Zwischenspeicher"]]);
});

test("routenInfoZeilen: Nachladen zeigt die neuen Punkte, Dauer und Hintergrund", () => {
  const z = routenInfoZeilen({ erfolg: { zeit: 5, art: "nur Neues", empfangen: 40, neuePunkte: 37, gesamt: 72500, dauerMs: 640, hintergrund: true } }, uhr);
  assert.deepEqual(z, [
    ["Zuletzt aktualisiert", "t5"],
    ["Art", "nur Neues (+37 Punkte)"],
    ["Punkte insgesamt", "72500"],
    ["Dauer", "0.6 s (im Hintergrund)"],
  ]);
});

test("routenInfoZeilen: komplettes Laden nennt die empfangenen Punkte", () => {
  const z = routenInfoZeilen({ erfolg: { zeit: 5, art: "komplett", empfangen: 72474, neuePunkte: 72474, gesamt: 72474, dauerMs: 12300, hintergrund: false } }, uhr);
  assert.equal(z[1][1], "komplett (72474 Punkte)");
  assert.equal(z[3][1], "12.3 s");
});

test("routenInfoZeilen: ein Fehlversuch nach dem letzten Erfolg wird gezeigt, ein älterer nicht", () => {
  const erfolg = { zeit: 10, art: "nur Neues", empfangen: 1, neuePunkte: 1, gesamt: 5, dauerMs: 100, hintergrund: true };
  const neuerFehler = routenInfoZeilen({ erfolg, fehler: { zeit: 20, fehler: "Zeitüberschreitung", inFolge: 3 } }, uhr);
  assert.deepEqual(neuerFehler.at(-1), ["Letzter Fehlversuch", "t20 — Zeitüberschreitung (3× in Folge)"]);
  const alterFehler = routenInfoZeilen({ erfolg, fehler: { zeit: 5, fehler: "alt", inFolge: 1 } }, uhr);
  assert.equal(alterFehler.length, 4);
  const nurFehler = routenInfoZeilen({ fehler: { zeit: 1, fehler: "x", inFolge: 1 } }, uhr);
  assert.equal(nurFehler.at(-1)[1], "t1 — x");
});
