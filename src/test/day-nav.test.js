import { test } from "node:test";
import assert from "node:assert/strict";
import { neighbour, dayNavigation } from "../day-nav.js";

const days = ["T:day:1", "T:day:2", "T:day:4"].map((id) => ({ id, title: id.split(":").pop() }));

test("neighbour: previous and next day, null at the ends and for an unknown id", () => {
  assert.equal(neighbour(days, "T:day:2", -1).id, "T:day:1");
  assert.equal(neighbour(days, "T:day:2", 1).id, "T:day:4");
  assert.equal(neighbour(days, "T:day:1", -1), null);
  assert.equal(neighbour(days, "T:day:4", 1), null);
  assert.equal(neighbour(days, "T:day:9", 1), null);
  assert.equal(neighbour(null, "T:day:1", 1), null);
});

test("dayNavigation: position and availability, no navigation for a single day or an unknown id", () => {
  assert.deepEqual(dayNavigation(days, "T:day:1"), { hasPrevious: false, hasNext: true, position: 1, count: 3 });
  assert.deepEqual(dayNavigation(days, "T:day:4"), { hasPrevious: true, hasNext: false, position: 3, count: 3 });
  assert.equal(dayNavigation([days[0]], "T:day:1"), null);
  assert.equal(dayNavigation(days, "unbekannt"), null);
});
