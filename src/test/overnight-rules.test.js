import test from "node:test";
import assert from "node:assert/strict";

import { nightWindowHours, checkAutomaticOvernight, standingHours, classifyStand } from "../overnight-rules.js";

const local = (day, hour, minute = 0) => new Date(2026, 7, day, hour, minute).toISOString();

test("overnight: 23:00 to 04:00 is recognised despite only 5 hours of standing", () => {
  const check = checkAutomaticOvernight(local(10, 23), local(11, 4));

  assert.equal(check.qualifies, true);
  assert.equal(Math.round(check.standingHours), 5);
  assert.equal(Math.round(check.nightHours), 5);
});

test("overnight: a change of date alone is not enough", () => {
  const check = checkAutomaticOvernight(local(10, 21), local(11, 1));

  assert.equal(check.qualifies, false);
  assert.equal(Math.round(check.standingHours), 4);
  assert.equal(Math.round(check.nightHours), 3);
});

test("overnight: a long day stop without the night window is not recognised", () => {
  const check = checkAutomaticOvernight(local(10, 10), local(10, 16));

  assert.equal(check.qualifies, false);
  assert.equal(Math.round(check.standingHours), 6);
  assert.equal(check.nightHours, 0);
});

test("overnight: the night window share is computed across midnight", () => {
  assert.equal(standingHours(local(10, 20), local(11, 2)), 6);
  assert.equal(nightWindowHours(local(10, 20), local(11, 2)), 4);
  assert.equal(checkAutomaticOvernight(local(10, 20), local(11, 2)).qualifies, true);
});

// classifyStand() — short stops (e.g. shopping during the day) are recorded
// without weakening the overnight detection (requested 05.09.2026: a shopping
// visit used to slip through entirely).
test("stand category: what qualifies as an overnight stay is classified as one", () => {
  assert.equal(classifyStand(local(10, 23), local(11, 4)).catId, "uebernachtung");
});

test("stand category: a short day stop (e.g. shopping) is recorded as a stop", () => {
  assert.equal(classifyStand(local(10, 14), local(10, 15, 30)).catId, "stopp"); // 1.5 h in the middle of the day
});

test("stand category: a long day stop without the night window stays a stop, not an overnight stay", () => {
  assert.equal(classifyStand(local(10, 10), local(10, 16)).catId, "stopp"); // 6 h, no night window
});

test("stand category: too short for both (e.g. a traffic light) is not recorded", () => {
  assert.equal(classifyStand(local(10, 14), local(10, 14, 5)), null); // 5 minutes
});
