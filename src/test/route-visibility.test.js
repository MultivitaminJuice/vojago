import test from "node:test";
import assert from "node:assert/strict";

import {
  driveMatchesRouteFilter,
  filteredRouteDrives,
  itemMatchesRouteFilter,
  visibleRoutePath,
  visibleRouteSegments,
} from "../route-visibility.js";

const path = [
  { lon: 7.0, lat: 51.0, elev: 50, spd: 40, day: 1, time: "2026-08-10T08:00:00.000Z", cum: 0 },
  { lon: 7.1, lat: 51.1, elev: 55, spd: 50, day: 1, time: "2026-08-10T09:00:00.000Z", cum: 15 },
  { lon: 7.2, lat: 51.2, elev: 60, spd: 30, day: 1, time: "2026-08-10T10:00:00.000Z", cum: 30 },
  { lon: 7.3, lat: 51.3, elev: 65, spd: 30, day: 1, time: "2026-08-10T11:00:00.000Z", cum: 45 },
  { lon: 7.4, lat: 51.4, elev: 70, spd: 60, day: 1, time: "2026-08-10T12:00:00.000Z", cum: 60 },
  { lon: 7.5, lat: 51.5, elev: 75, spd: 60, day: 1, time: "2026-08-10T13:00:00.000Z", cum: 75 },
];

test("RouteVisibility: Etappenfilter zeigt keine Strecke, wenn nur Abstecher markiert sind", () => {
  const drives = [
    { tripId: "reise-1", kind: "abstecher", from: "2026-08-10T10:00:00.000Z", to: "2026-08-10T11:00:00.000Z" },
  ];

  const segments = visibleRouteSegments(path, drives, "reise-1");
  const visible = segments.flat();

  assert.equal(segments.length, 0);
  assert.equal(visible.length, 0);
});

test("RouteVisibility: normale Etappen bleiben sichtbar", () => {
  const drives = [
    { tripId: "reise-1", kind: "etappe", from: "2026-08-10T10:00:00.000Z", to: "2026-08-10T11:00:00.000Z" },
  ];

  assert.deepEqual(
    visibleRoutePath(path, drives, "reise-1").map((p) => p.time),
    [
      "2026-08-10T10:00:00.000Z",
      "2026-08-10T11:00:00.000Z",
    ]
  );
});

test("RouteVisibility: Etappenfilter zeigt markierte Etappe zwischen Abstechern", () => {
  const drives = [
    { tripId: "reise-1", kind: "abstecher", from: "2026-08-10T08:00:00.000Z", to: "2026-08-10T09:00:00.000Z" },
    { tripId: "reise-1", kind: "etappe", from: "2026-08-10T10:00:00.000Z", to: "2026-08-10T11:00:00.000Z" },
    { tripId: "reise-1", kind: "abstecher", from: "2026-08-10T12:00:00.000Z", to: "2026-08-10T13:00:00.000Z" },
  ];

  assert.deepEqual(
    visibleRoutePath(path, drives, "reise-1", "etappe").map((p) => p.time),
    [
      "2026-08-10T10:00:00.000Z",
      "2026-08-10T11:00:00.000Z",
    ]
  );
});

test("RouteVisibility: Alle zeigt Etappen und Abstecher", () => {
  const drives = [
    { tripId: "reise-1", kind: "abstecher", from: "2026-08-10T10:00:00.000Z", to: "2026-08-10T11:00:00.000Z" },
  ];

  assert.equal(visibleRoutePath(path, drives, "reise-1", "alle").length, path.length);
});

test("RouteVisibility: Versorgungsfilter zeigt nur Abstecher", () => {
  const drives = [
    { tripId: "reise-1", kind: "etappe", from: "2026-08-10T08:00:00.000Z", to: "2026-08-10T09:00:00.000Z" },
    { tripId: "reise-1", kind: "abstecher", from: "2026-08-10T10:00:00.000Z", to: "2026-08-10T11:00:00.000Z" },
  ];

  assert.deepEqual(
    visibleRoutePath(path, drives, "reise-1", "abstecher").map((p) => p.time),
    [
      "2026-08-10T10:00:00.000Z",
      "2026-08-10T11:00:00.000Z",
    ]
  );
  assert.equal(filteredRouteDrives(drives, "reise-1", "abstecher").length, 1);
  assert.equal(driveMatchesRouteFilter(drives[0], "abstecher"), false);
  assert.equal(driveMatchesRouteFilter(drives[1], "abstecher"), true);
});

test("RouteVisibility: Orte und Notizen folgen dem Fahrtenfilter", () => {
  const drives = [
    { tripId: "reise-1", kind: "abstecher", from: "2026-08-10T10:00:00.000Z", to: "2026-08-10T11:00:00.000Z" },
  ];

  assert.equal(itemMatchesRouteFilter({ at: "2026-08-10T10:30:00.000Z" }, drives, "reise-1", "abstecher"), true);
  assert.equal(itemMatchesRouteFilter({ at: "2026-08-10T08:30:00.000Z" }, drives, "reise-1", "abstecher"), false);
  assert.equal(itemMatchesRouteFilter({}, drives, "reise-1", "abstecher"), false);
});

// Echter Fund (24. Oktober 2026): Die Fahrtenliste wird seltener geladen als der
// Pfad. Bei laufender Reise fehlte deshalb das jüngste Stück der Strecke.
test("RouteVisibility: offenes Ende zeigt Punkte nach der letzten bekannten Fahrt", () => {
  const drives = [
    { tripId: "reise-1", kind: "etappe", from: "2026-08-10T08:00:00.000Z", to: "2026-08-10T10:00:00.000Z" },
  ];
  const ohne = visibleRouteSegments(path, drives, "reise-1").flat().map((p) => p.time);
  const mit = visibleRouteSegments(path, drives, "reise-1", "etappe", { offenesEnde: true }).flat().map((p) => p.time);
  assert.equal(ohne.at(-1), "2026-08-10T10:00:00.000Z");
  assert.equal(mit.at(-1), "2026-08-10T13:00:00.000Z", "die neueren Punkte sind sichtbar");
});

test("RouteVisibility: offenes Ende beginnt erst nach der letzten bekannten Fahrt jeder Art (Abstecher bleibt ausgeblendet)", () => {
  const drives = [
    { tripId: "reise-1", kind: "etappe", from: "2026-08-10T08:00:00.000Z", to: "2026-08-10T09:00:00.000Z" },
    { tripId: "reise-1", kind: "abstecher", from: "2026-08-10T10:00:00.000Z", to: "2026-08-10T11:00:00.000Z" },
  ];
  const segmente = visibleRouteSegments(path, drives, "reise-1", "etappe", { offenesEnde: true });
  assert.deepEqual(
    segmente.map((s) => s.map((p) => p.time.slice(11, 13))),
    [["08", "09"], ["12", "13"]],
    "Etappe sichtbar, Abstecher (10–11 Uhr) weg, jüngere Punkte (12–13 Uhr) sichtbar",
  );
});
