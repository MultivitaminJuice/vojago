import test from "node:test";
import assert from "node:assert/strict";

import { localDayKey, renumberPathByTripStart, tripDayKeys, tripDayNumberFromKeys } from "../day-utils.js";

test("DayUtils: Tagesnummern zählen ab Reisebeginn, nicht ab erstem Eintrag", () => {
  const startKey = "2026-08-09";

  assert.equal(tripDayNumberFromKeys("2026-08-09", startKey), 1);
  assert.equal(tripDayNumberFromKeys("2026-08-10", startKey), 2);
});

test("DayUtils: geladene Tracks werden auf Reisetage umnummeriert", () => {
  const trip = { start: "2026-08-09T12:00:00.000Z" };
  const path = [
    { time: "2026-08-10T08:00:00.000Z", day: 1 },
    { time: "2026-08-10T09:00:00.000Z", day: 1 },
  ];

  const result = renumberPathByTripStart(path, trip);

  assert.equal(localDayKey(trip.start), "2026-08-09");
  assert.deepEqual(result.map((p) => p.day), [2, 2]);
});

test("DayUtils: Reisetage kommen aus dem Reisezeitraum", () => {
  const trip = {
    start: "2026-08-09T18:00:00.000Z",
    end: "2026-08-11T09:00:00.000Z",
  };

  assert.deepEqual(tripDayKeys(trip), ["2026-08-09", "2026-08-10", "2026-08-11"]);
});
