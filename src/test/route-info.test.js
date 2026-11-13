import { test } from "node:test";
import assert from "node:assert/strict";
import { routeInfoRows } from "../route-info.js";

const clock = (ms) => `t${ms}`;

test("routeInfoRows: nothing loaded yet", () => {
  assert.deepEqual(routeInfoRows({}, clock), [["Zuletzt aktualisiert", "—"]]);
  assert.deepEqual(routeInfoRows({ fromCache: true }, clock), [["Zuletzt aktualisiert", "noch nicht — Zwischenspeicher"]]);
});

test("routeInfoRows: loading only new points shows them, the duration and background", () => {
  const z = routeInfoRows({ success: { time: 5, kind: "new", received: 40, newPoints: 37, total: 72500, durationMs: 640, background: true } }, clock);
  assert.deepEqual(z, [
    ["Zuletzt aktualisiert", "t5"],
    ["Art", "nur Neues (+37 Punkte)"],
    ["Punkte insgesamt", "72500"],
    ["Dauer", "0.6 s (im Hintergrund)"],
  ]);
});

test("routeInfoRows: a full load names the received points", () => {
  const z = routeInfoRows({ success: { time: 5, kind: "full", received: 72474, newPoints: 72474, total: 72474, durationMs: 12300, background: false } }, clock);
  assert.equal(z[1][1], "komplett (72474 Punkte)");
  assert.equal(z[3][1], "12.3 s");
});

test("routeInfoRows: a failure after the last success is shown, an older one is not", () => {
  const success = { time: 10, kind: "new", received: 1, newPoints: 1, total: 5, durationMs: 100, background: true };
  const newerFailure = routeInfoRows({ success, failure: { time: 20, error: "Zeitüberschreitung", inARow: 3 } }, clock);
  assert.deepEqual(newerFailure.at(-1), ["Letzter Fehlversuch", "t20 — Zeitüberschreitung (3× in Folge)"]);
  const olderFailure = routeInfoRows({ success, failure: { time: 5, error: "alt", inARow: 1 } }, clock);
  assert.equal(olderFailure.length, 4);
  const onlyFailure = routeInfoRows({ failure: { time: 1, error: "x", inARow: 1 } }, clock);
  assert.equal(onlyFailure.at(-1)[1], "t1 — x");
});

test("routeInfoRows: a finished trip that was only checked", () => {
  const rows = routeInfoRows({ success: { time: 0, kind: "unchanged", received: 0, newPoints: 0, total: 18979, durationMs: 11 } }, () => "10:00:00");
  assert.deepEqual(rows[1], ["Art", "geprüft, unverändert"]);
});
