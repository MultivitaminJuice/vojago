import { test } from "node:test";
import assert from "node:assert/strict";
import { routeInfoRows } from "../route-info.js";

const clock = (ms) => `t${ms}`;

test("routeInfoRows: nothing loaded yet", () => {
  assert.deepEqual(routeInfoRows({}, clock), [["Zuletzt aktualisiert", "—"]]);
  assert.deepEqual(routeInfoRows({ zwischenspeicher: true }, clock), [["Zuletzt aktualisiert", "noch nicht — Zwischenspeicher"]]);
});

test("routeInfoRows: loading only new points shows them, the duration and background", () => {
  const z = routeInfoRows({ erfolg: { zeit: 5, art: "nur Neues", empfangen: 40, neuePunkte: 37, gesamt: 72500, dauerMs: 640, hintergrund: true } }, clock);
  assert.deepEqual(z, [
    ["Zuletzt aktualisiert", "t5"],
    ["Art", "nur Neues (+37 Punkte)"],
    ["Punkte insgesamt", "72500"],
    ["Dauer", "0.6 s (im Hintergrund)"],
  ]);
});

test("routeInfoRows: a full load names the received points", () => {
  const z = routeInfoRows({ erfolg: { zeit: 5, art: "komplett", empfangen: 72474, neuePunkte: 72474, gesamt: 72474, dauerMs: 12300, hintergrund: false } }, clock);
  assert.equal(z[1][1], "komplett (72474 Punkte)");
  assert.equal(z[3][1], "12.3 s");
});

test("routeInfoRows: a failure after the last success is shown, an older one is not", () => {
  const erfolg = { zeit: 10, art: "nur Neues", empfangen: 1, neuePunkte: 1, gesamt: 5, dauerMs: 100, hintergrund: true };
  const newerFailure = routeInfoRows({ erfolg, fehler: { zeit: 20, fehler: "Zeitüberschreitung", inFolge: 3 } }, clock);
  assert.deepEqual(newerFailure.at(-1), ["Letzter Fehlversuch", "t20 — Zeitüberschreitung (3× in Folge)"]);
  const olderFailure = routeInfoRows({ erfolg, fehler: { zeit: 5, fehler: "alt", inFolge: 1 } }, clock);
  assert.equal(olderFailure.length, 4);
  const onlyFailure = routeInfoRows({ fehler: { zeit: 1, fehler: "x", inFolge: 1 } }, clock);
  assert.equal(onlyFailure.at(-1)[1], "t1 — x");
});

test("routeInfoRows: a finished trip that was only checked", () => {
  const rows = routeInfoRows({ erfolg: { zeit: 0, art: "unverändert", empfangen: 0, neuePunkte: 0, gesamt: 18979, dauerMs: 11 } }, () => "10:00:00");
  assert.deepEqual(rows[1], ["Art", "geprüft, unverändert"]);
});
