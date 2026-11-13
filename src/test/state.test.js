// Wiring tests for state.js — deliberately different from route-visibility.test.js,
// which calls pure functions with hard-coded filter values and so never checks
// whether a new value gets through to them at all. That gap hid a real bug
// (18 August 2026): the picker offered "nicht_zugeordnet", but
// setRouteDriveFilter() still had the old, shorter list and silently rejected
// the tap. This file checks the wiring itself: every value listed in
// ROUTE_DRIVE_FILTERS must pass EVERY gate state.js validates it with.
import test from "node:test";
import assert from "node:assert/strict";

import { state, ROUTE_DRIVE_FILTERS, MAP_METRICS, setRouteDriveFilter, setMetric, collectPreferences, applyPreferences, migrateConfig } from "../state.js";

test("setRouteDriveFilter: every valid value is actually taken", () => {
  for (const value of ROUTE_DRIVE_FILTERS) {
    setRouteDriveFilter(value);
    assert.equal(state.routeDriveFilter, value, `setRouteDriveFilter("${value}") was not taken`);
  }
});

test("setRouteDriveFilter: unknown values are rejected, not silently taken", () => {
  setRouteDriveFilter("etappe");
  setRouteDriveFilter("made-up");
  assert.equal(state.routeDriveFilter, "etappe");
});

test("collectPreferences/applyPreferences: every valid filter value survives the round trip", () => {
  for (const value of ROUTE_DRIVE_FILTERS) {
    setRouteDriveFilter(value);
    const prefs = collectPreferences();
    assert.equal(prefs.routeDriveFilter, value, `collectPreferences() dropped "${value}"`);

    setRouteDriveFilter("etappe"); // reset, so applyPreferences is checked honestly
    applyPreferences(prefs);
    assert.equal(state.routeDriveFilter, value, `applyPreferences() did not take "${value}"`);
  }
});

// The same safeguard for the map colouring (state.metric) — duplicated in as
// many places as routeDriveFilter and just as prone to a new value (here:
// "dist") being forgotten in one of them.
test("setMetric: every valid value is actually taken", () => {
  for (const value of MAP_METRICS) {
    setMetric(value);
    assert.equal(state.metric, value, `setMetric("${value}") was not taken`);
  }
});

test("setMetric: unknown values are rejected, not silently taken", () => {
  setMetric("day");
  setMetric("made-up");
  assert.equal(state.metric, "day");
});

test("collectPreferences/applyPreferences: every valid metric value survives the round trip", () => {
  for (const value of MAP_METRICS) {
    setMetric(value);
    const prefs = collectPreferences();
    assert.equal(prefs.metric, value, `collectPreferences() dropped "${value}"`);

    setMetric("day");
    applyPreferences(prefs);
    assert.equal(state.metric, value, `applyPreferences() did not take "${value}"`);
  }
});

test("migrateConfig: settings stored under the old German keys are taken over", () => {
  assert.deepEqual(migrateConfig({ theme: "dark", gelaende: true, kartenstil: "dezent", lueckenMarkieren: true }),
    { theme: "dark", terrain: true, mapStyle: "dezent", markGaps: true });
  // a value already stored under the new key wins
  assert.deepEqual(migrateConfig({ kartenstil: "dezent", mapStyle: "farbig" }), { mapStyle: "farbig" });
  assert.deepEqual(migrateConfig(null), {});
});
