import test from "node:test";
import assert from "node:assert/strict";

import { routeSummaryToTrip, summarizeDrive, summarizeTrip, summarizeTripDays } from "../route-summary.js";

const path = [
  { lon: 7, lat: 51, elev: 50, spd: 20, time: "2026-08-09T08:00:00.000Z", day: 1, cum: 0 },
  { lon: 7.1, lat: 51.1, elev: 90, spd: 80, time: "2026-08-09T09:00:00.000Z", day: 1, cum: 12 },
  { lon: 7.2, lat: 51.2, elev: 130, spd: 70, time: "2026-08-10T08:00:00.000Z", day: 2, cum: 12 },
  // ~27 km in 90 min (18 km/h im Schnitt) — als Lücke zählt sie nur, wenn die
  // Strecke einer echten Fahrt entspricht (siehe bewegungsMinuten).
  { lon: 7.4, lat: 51.4, elev: 180, spd: 100, time: "2026-08-10T09:30:00.000Z", day: 2, cum: 30 },
];

test("RouteSummary: Reise bündelt Strecke, Fahrzeit, Tempo, Orte und Nächte", () => {
  const summary = summarizeTrip({
    id: "trip_1",
    name: "Testreise",
    hue: 28,
    live: true,
    start: "2026-08-09T08:00:00.000Z",
    end: "2026-08-10T10:00:00.000Z",
    path,
  }, {
    drives: [
      { minutes: 60, km: 12, maxKmh: 88 },
      { minutes: 90, km: 18, maxKmh: 104 },
    ],
    places: [
      { catId: "uebernachtung", nights: 1, at: "2026-08-09T18:00:00.000Z" },
      { catId: "restaurant", at: "2026-08-10T12:00:00.000Z" },
    ],
    notes: [{ at: "2026-08-10T12:30:00.000Z" }],
  });

  assert.equal(summary.type, "reise");
  assert.equal(summary.stats.distanceKm, 30);
  assert.equal(summary.stats.driveMinutes, 150);
  assert.equal(summary.stats.averageKmh, 12);
  assert.equal(summary.stats.maxKmh, 104);
  assert.equal(summary.stats.peakM, 180);
  assert.equal(summary.stats.overnightPlaces, 1);
  assert.equal(summary.stats.nights, 1);
  assert.equal(summary.stats.days, 2);
});

test("RouteSummary: wiederholte Übernachtungen am selben Ort bleiben ein Übernachtungsplatz", () => {
  const summary = summarizeTrip({
    id: "trip_overnight",
    name: "Übernachtungsreise",
    hue: 28,
    start: "2026-08-09T08:00:00.000Z",
    end: "2026-08-12T08:00:00.000Z",
    path,
  }, {
    places: [
      { catId: "uebernachtung", nights: 1, at: "2026-08-10T18:00:00.000Z", lat: 51.5, lon: 7.5 },
      { catId: "uebernachtung", nights: 1, at: "2026-08-11T18:00:00.000Z", lat: 51.5004, lon: 7.5004 },
    ],
  });

  assert.equal(summary.stats.overnightPlaces, 1);
  assert.equal(summary.stats.nights, 2);
});

test("RouteSummary: Tages-Summaries normalisieren den Kilometerstand", () => {
  const days = summarizeTripDays({ id: "trip_1", name: "Testreise", hue: 28, path });

  assert.equal(days.length, 2);
  assert.equal(days[0].stats.distanceKm, 12);
  assert.equal(days[1].stats.distanceKm, 18);
  assert.equal(days[1].path[0].cum, 0);
  assert.equal(days[1].path.at(-1).cum, 18);
});

test("RouteSummary: Fahrzeit ignoriert lange Standzeiten in der GPS-Spur", () => {
  const summary = summarizeTrip({
    id: "trip_stand",
    name: "Standreise",
    hue: 28,
    start: "2026-08-09T08:00:00.000Z",
    end: "2026-08-13T04:00:00.000Z",
    path: [
      { lon: 7, lat: 51, elev: 50, spd: 50, time: "2026-08-09T08:00:00.000Z", day: 1, cum: 0 },
      { lon: 7.2, lat: 51.2, elev: 60, spd: 70, time: "2026-08-09T09:00:00.000Z", day: 1, cum: 50 },
      { lon: 7.2, lat: 51.2, elev: 60, spd: 0, time: "2026-08-12T22:00:00.000Z", day: 4, cum: 50 },
      { lon: 7.4, lat: 51.4, elev: 70, spd: 60, time: "2026-08-12T23:00:00.000Z", day: 4, cum: 100 },
    ],
  }, {
    drives: [{ minutes: 5555, km: 100, maxKmh: 80 }],
  });

  assert.equal(summary.stats.distanceKm, 100);
  assert.equal(summary.stats.driveMinutes, 120);
  assert.equal(summary.stats.averageKmh, 50);
});

test("RouteSummary: Fahrt nutzt GPS-Bewegungszeit vor aufgeblähter Berichtsdauer", () => {
  const summary = summarizeDrive({
    id: "drive_stand",
    tripId: "trip_1",
    from: "2026-08-09T08:00:00.000Z",
    to: "2026-08-12T23:00:00.000Z",
    km: 100,
    minutes: 5220,
    maxKmh: 80,
  }, {
    path: [
      { lon: 7, lat: 51, elev: 50, spd: 40, time: "2026-08-09T08:00:00.000Z", day: 1, cum: 0 },
      { lon: 7.2, lat: 51.2, elev: 60, spd: 70, time: "2026-08-09T09:00:00.000Z", day: 1, cum: 50 },
      { lon: 7.2, lat: 51.2, elev: 60, spd: 0, time: "2026-08-12T22:00:00.000Z", day: 4, cum: 50 },
      { lon: 7.4, lat: 51.4, elev: 70, spd: 60, time: "2026-08-12T23:00:00.000Z", day: 4, cum: 100 },
    ],
  });

  assert.equal(summary.stats.driveMinutes, 120);
  assert.equal(summary.stats.averageKmh, 50);
});

test("RouteSummary: leere Reisetage werden in der Tagesliste ausgeblendet", () => {
  const days = summarizeTripDays({
    id: "trip_empty_days",
    name: "Kalenderreise",
    hue: 28,
    start: "2026-08-09T08:00:00.000Z",
    end: "2026-08-12T08:00:00.000Z",
    path: [
      { lon: 7, lat: 51, elev: 50, spd: 0, time: "2026-08-10T08:00:00.000Z", day: 2, cum: 0 },
      { lon: 7.001, lat: 51.001, elev: 50, spd: 0, time: "2026-08-10T18:00:00.000Z", day: 2, cum: 0.2 },
    ],
  }, {
    places: [{ catId: "uebernachtung", nights: 1, at: "2026-08-11T18:00:00.000Z", lat: 51, lon: 7 }],
    notes: [{ at: "2026-08-12T10:00:00.000Z" }],
  });

  assert.deepEqual(days.map((d) => d.title), []);
});

test("RouteSummary: Reisetage entstehen aus Track und Fahrten im Reisezeitraum", () => {
  const days = summarizeTripDays({
    id: "trip_calendar",
    name: "Kalenderreise",
    hue: 28,
    start: "2026-08-09T18:00:00.000Z",
    end: "2026-08-11T09:00:00.000Z",
    path: [
      { lon: 7, lat: 51, elev: 50, spd: 20, time: "2026-08-10T08:00:00.000Z", day: 2, cum: 0 },
      { lon: 7.1, lat: 51.1, elev: 60, spd: 60, time: "2026-08-10T09:00:00.000Z", day: 2, cum: 10 },
    ],
  }, {
    drives: [{ from: "2026-08-09T19:00:00.000Z", to: "2026-08-09T20:00:00.000Z", km: 12, minutes: 60 }],
  });

  assert.deepEqual(days.map((d) => d.title), ["Tag 1", "Tag 2"]);
  assert.equal(days[0].stats.distanceKm, 12);
  assert.equal(days[1].stats.distanceKm, 10);
});

test("RouteSummary: laufende Reise bleibt zeitlich offen", () => {
  const summary = summarizeTrip({
    id: "trip_live",
    name: "Laufende Reise",
    hue: 28,
    live: true,
    start: "2026-08-09T08:00:00.000Z",
    end: null,
    path,
  });

  assert.equal(summary.live, true);
  assert.equal(summary.to, null);
  assert.ok(summary.stats.periodMinutes > 0);
});

test("RouteSummary: Fahrt kann auch ohne geladene Spur ausgewertet werden", () => {
  const summary = summarizeDrive({
    id: "drive_1",
    tripId: "trip_1",
    from: "2026-08-10T08:00:00.000Z",
    to: "2026-08-10T09:30:00.000Z",
    km: 18,
    minutes: 90,
    maxKmh: 104,
  });

  assert.equal(summary.type, "fahrt");
  assert.equal(summary.stats.distanceKm, 18);
  assert.equal(summary.stats.averageKmh, 12);
  assert.equal(summary.stats.maxKmh, 104);
});

test("RouteSummary: Karten-Vorschau bleibt kompatibel mit Trip-Like-Objekten", () => {
  const summary = summarizeDrive({
    id: "drive_1",
    from: "2026-08-10T08:00:00.000Z",
    km: 18,
    minutes: 90,
  }, { path: path.slice(2) });

  const tripLike = routeSummaryToTrip(summary, "Fahrt 10. Aug.");
  assert.equal(tripLike.name, "Fahrt 10. Aug.");
  assert.equal(tripLike.km, 18);
  assert.equal(tripLike.bars[0], 18);
  assert.equal(tripLike.path[0].cum, 0);
});

// Echter Fund (16. Oktober 2026): ein Stopp, in dem der Router verstummt, zählte
// als Fahrzeit, sobald die letzte Meldung davor oder die erste danach noch
// ≥ 5 km/h trug (Restgeschwindigkeit/Anfahren) — Gesamt/Tage 1589 min statt ~1295.
test("RouteSummary: eine Meldelücke am selben Fleck zählt nicht als Fahrzeit, auch wenn ein Randpunkt schnell war", () => {
  const summary = summarizeDrive({ id: "d", from: "2026-09-25T08:00:00.000Z", to: "2026-09-25T10:00:00.000Z", km: 5, minutes: 120 }, {
    path: [
      { lon: 10.0, lat: 48.0, elev: 0, spd: 40, time: "2026-09-25T08:00:00.000Z", day: 1, cum: 0 },
      { lon: 10.001, lat: 48.0, elev: 0, spd: 5, time: "2026-09-25T08:01:00.000Z", day: 1, cum: 0.07 },
      // 65 Minuten Stille am selben Ort, Randpunkte beide ≥ 5 km/h
      { lon: 10.001, lat: 48.0, elev: 0, spd: 5, time: "2026-09-25T09:06:00.000Z", day: 1, cum: 0.07 },
      { lon: 10.002, lat: 48.0, elev: 0, spd: 30, time: "2026-09-25T09:07:00.000Z", day: 1, cum: 0.14 },
    ],
  });
  assert.equal(summary.stats.driveMinutes, 2, "nur die beiden 1-Minuten-Intervalle zählen");
});

test("RouteSummary: eine Meldelücke mit echter Fortbewegung (Tunnel) bleibt Fahrzeit", () => {
  const summary = summarizeDrive({ id: "d", from: "2026-09-24T16:20:00.000Z", to: "2026-09-24T16:30:00.000Z", km: 20, minutes: 10 }, {
    path: [
      { lon: 10.0, lat: 48.0, elev: 0, spd: 119, time: "2026-09-24T16:20:00.000Z", day: 1, cum: 0 },
      // 7 Minuten ohne Meldung, ~14 km weiter (≈ 120 km/h im Schnitt)
      { lon: 10.17, lat: 48.0, elev: 0, spd: 112, time: "2026-09-24T16:27:00.000Z", day: 1, cum: 12.6 },
    ],
  });
  assert.equal(summary.stats.driveMinutes, 7);
});

test("RouteSummary: normale Messintervalle zählen bei bewegtem Fahrzeug, bei Stand nicht (ohne gemeldete Fahrtdauer als Rückfall)", () => {
  const punkte = (spd) => Array.from({ length: 31 }, (_, i) => ({
    lon: 10 + i * 0.0003, lat: 48, elev: 0, spd, time: new Date(Date.UTC(2026, 8, 25, 8, 0, i * 2)).toISOString(), day: 1, cum: i * 0.02,
  }));
  const fahrend = summarizeDrive({ id: "a", from: "x", to: "y", km: 1, minutes: 1 }, { path: punkte(50) });
  const stehend = summarizeDrive({ id: "b", from: "x", to: "y", km: 0, minutes: 0 }, { path: punkte(0) });
  assert.equal(fahrend.stats.driveMinutes, 1); // 30 Intervalle à 2 s = 60 s
  assert.equal(stehend.stats.driveMinutes, 0);
});
