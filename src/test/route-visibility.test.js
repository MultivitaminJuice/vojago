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

test("RouteVisibility: the stage filter shows no route when only detours are marked", () => {
  const drives = [
    { tripId: "reise-1", kind: "abstecher", from: "2026-08-10T10:00:00.000Z", to: "2026-08-10T11:00:00.000Z" },
  ];

  const segments = visibleRouteSegments(path, drives, "reise-1");
  const visible = segments.flat();

  assert.equal(segments.length, 0);
  assert.equal(visible.length, 0);
});

test("RouteVisibility: normal stages stay visible", () => {
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

test("RouteVisibility: the stage filter shows a marked stage between detours", () => {
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

test("RouteVisibility: the all filter shows stages and detours", () => {
  const drives = [
    { tripId: "reise-1", kind: "abstecher", from: "2026-08-10T10:00:00.000Z", to: "2026-08-10T11:00:00.000Z" },
  ];

  assert.equal(visibleRoutePath(path, drives, "reise-1", "alle").length, path.length);
});

test("RouteVisibility: the supply filter shows only detours", () => {
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

test("RouteVisibility: places and notes follow the drive filter", () => {
  const drives = [
    { tripId: "reise-1", kind: "abstecher", from: "2026-08-10T10:00:00.000Z", to: "2026-08-10T11:00:00.000Z" },
  ];

  assert.equal(itemMatchesRouteFilter({ at: "2026-08-10T10:30:00.000Z" }, drives, "reise-1", "abstecher"), true);
  assert.equal(itemMatchesRouteFilter({ at: "2026-08-10T08:30:00.000Z" }, drives, "reise-1", "abstecher"), false);
  assert.equal(itemMatchesRouteFilter({}, drives, "reise-1", "abstecher"), false);
});

// Seen on 24 October 2026: the drive list is loaded less often than the
// path, so for a running trip the most recent piece of the route was missing.
test("RouteVisibility: the open end shows points after the last known drive", () => {
  const drives = [
    { tripId: "reise-1", kind: "etappe", from: "2026-08-10T08:00:00.000Z", to: "2026-08-10T10:00:00.000Z" },
  ];
  const ohne = visibleRouteSegments(path, drives, "reise-1").flat().map((p) => p.time);
  const mit = visibleRouteSegments(path, drives, "reise-1", "etappe", { openEnd: true }).flat().map((p) => p.time);
  assert.equal(ohne.at(-1), "2026-08-10T10:00:00.000Z");
  assert.equal(mit.at(-1), "2026-08-10T13:00:00.000Z", "die neueren Punkte sind sichtbar");
});

test("RouteVisibility: the open end starts only after the last known drive of any kind (a detour stays hidden)", () => {
  const drives = [
    { tripId: "reise-1", kind: "etappe", from: "2026-08-10T08:00:00.000Z", to: "2026-08-10T09:00:00.000Z" },
    { tripId: "reise-1", kind: "abstecher", from: "2026-08-10T10:00:00.000Z", to: "2026-08-10T11:00:00.000Z" },
  ];
  const segmente = visibleRouteSegments(path, drives, "reise-1", "etappe", { openEnd: true });
  assert.deepEqual(
    segmente.map((s) => s.map((p) => p.time.slice(11, 13))),
    [["08", "09"], ["12", "13"]],
    "stage visible, detour (10–11) gone, newer points (12–13) visible",
  );
});
