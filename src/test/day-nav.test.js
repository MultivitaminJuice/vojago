import { test } from "node:test";
import assert from "node:assert/strict";
import { tagIdInfo, tagNachbar, tagNavigation } from "../day-nav.js";

const tage = ["T:day:1", "T:day:2", "T:day:4"].map((id) => ({ id, title: id.split(":").pop() }));

test("tagIdInfo: zerlegt Tages-IDs, alles andere ergibt null", () => {
  assert.deepEqual(tagIdInfo("abc-123:day:6"), { reiseId: "abc-123", tag: 6 });
  assert.deepEqual(tagIdInfo("a:b:day:2"), { reiseId: "a:b", tag: 2 });
  for (const v of ["abc", "abc:drive:3", "", null, undefined, "x:day:"]) assert.equal(tagIdInfo(v), null);
});

test("tagNachbar: vorheriger und nächster Tag, an den Enden und bei unbekannter ID null", () => {
  assert.equal(tagNachbar(tage, "T:day:2", -1).id, "T:day:1");
  assert.equal(tagNachbar(tage, "T:day:2", 1).id, "T:day:4");
  assert.equal(tagNachbar(tage, "T:day:1", -1), null);
  assert.equal(tagNachbar(tage, "T:day:4", 1), null);
  assert.equal(tagNachbar(tage, "T:day:9", 1), null);
  assert.equal(tagNachbar(null, "T:day:1", 1), null);
});

test("tagNavigation: Position und Verfügbarkeit, bei nur einem Tag oder unbekannter ID keine Navigation", () => {
  assert.deepEqual(tagNavigation(tage, "T:day:1"), { hatVorher: false, hatNaechster: true, position: 1, anzahl: 3 });
  assert.deepEqual(tagNavigation(tage, "T:day:4"), { hatVorher: true, hatNaechster: false, position: 3, anzahl: 3 });
  assert.equal(tagNavigation([tage[0]], "T:day:1"), null);
  assert.equal(tagNavigation(tage, "unbekannt"), null);
});
