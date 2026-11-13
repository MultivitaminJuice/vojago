import { test } from "node:test";
import assert from "node:assert/strict";
import { trayPhotos, normalizeBlocks, removePhotoFromBlocks, textSplitPoints, placePhoto, parseBlocks, cleanBlocks, coverPhotoId, withoutPhoto, withUnplacedPhotos, writtenText, daysForEditor, defaultDay, photoDayHint, hasContent } from "../diary.js";

test("parseBlocks: reads JSON text or a list, drops what is unusable", () => {
  assert.deepEqual(parseBlocks('[{"t":"text","text":"a"},{"t":"fotos","ids":["x",5]},{"t":"video"}]'), [{ t: "text", text: "a" }, { t: "fotos", ids: ["x"] }]);
  assert.deepEqual(parseBlocks("kein json"), []);
  assert.deepEqual(parseBlocks(null), []);
});

test("cleanBlocks: empty paragraphs and groups are dropped, consecutive photo groups merge", () => {
  const r = cleanBlocks([
    { t: "text", text: "  \n" }, { t: "text", text: "Erster Absatz\n\n" },
    { t: "fotos", ids: ["a"] }, { t: "fotos", ids: ["b", "c"] }, { t: "fotos", ids: [] },
    { t: "text", text: "Zweiter" },
  ]);
  assert.deepEqual(r, [{ t: "text", text: "Erster Absatz" }, { t: "fotos", ids: ["a", "b", "c"] }, { t: "text", text: "Zweiter" }]);
  assert.equal(hasContent([{ t: "text", text: "   " }]), false);
  assert.equal(hasContent([{ t: "fotos", ids: ["a"] }]), true);
});

test("a cover only when the entry starts with a photo; withoutPhoto takes it out of the blocks, empty groups are dropped", () => {
  const blocks = [{ t: "fotos", ids: ["a"] }, { t: "text", text: "y" }, { t: "fotos", ids: ["b", "c"] }];
  assert.equal(coverPhotoId(blocks), "a");
  assert.equal(coverPhotoId([{ t: "fotos", ids: ["a", "b"] }, { t: "text", text: "y" }]), null);   // several photos at the start: a collage, no cover
  assert.equal(coverPhotoId([{ t: "fotos", ids: ["a"] }, { t: "text", text: "y" }]), "a");
  assert.equal(coverPhotoId([{ t: "text", text: "" }, { t: "fotos", ids: ["a"] }, { t: "text", text: "y" }]), "a");   // an empty field before it does not count
  // A photo in the middle of the text stays there, it does not become the cover.
  assert.equal(coverPhotoId([{ t: "text", text: "x" }, { t: "fotos", ids: ["a"] }]), null);
  assert.equal(coverPhotoId([{ t: "text", text: "x" }]), null);
  assert.deepEqual(withoutPhoto(blocks, "a"), [{ t: "text", text: "y" }, { t: "fotos", ids: ["b", "c"] }]);
  assert.equal(withoutPhoto(blocks, null), blocks);
});

test("withUnplacedPhotos: photos of the entry that are in no block go to the start", () => {
  const blocks = [{ t: "fotos", ids: ["a"] }];
  assert.deepEqual(withUnplacedPhotos(blocks, ["a", "b"]), [{ t: "fotos", ids: ["b"] }, { t: "fotos", ids: ["a"] }]);
  // Together with text: one unplaced photo becomes the cover, several become a collage.
  assert.equal(coverPhotoId(withUnplacedPhotos([{ t: "text", text: "x" }], ["n"])), "n");
  assert.equal(coverPhotoId(withUnplacedPhotos([{ t: "text", text: "x" }], ["n", "m"])), null);
  assert.equal(withUnplacedPhotos(blocks, ["a"]), blocks);
});

test("writtenText: the same evening, the next morning, n days later", () => {
  const local = (iso) => new Date(iso).toISOString();
  assert.equal(writtenText("2026-07-14", local("2026-07-14T20:00:00")), "am selben Abend");
  assert.equal(writtenText("2026-07-14", local("2026-07-14T10:00:00")), "am selben Tag");
  assert.equal(writtenText("2026-07-14", local("2026-07-15T08:30:00")), "am nächsten Morgen");
  assert.equal(writtenText("2026-07-14", local("2026-07-15T15:00:00")), "am nächsten Tag");
  assert.equal(writtenText("2026-07-14", local("2026-07-17T09:00:00")), "3 Tage später");
  assert.equal(writtenText("2026-07-14", local("2026-07-13T09:00:00")), "");
  assert.equal(writtenText("2026-07-14", ""), "");
  // The SQLite format without a time zone is read as UTC.
  assert.ok(writtenText("2026-07-14", "2026-07-15 06:30:00") !== "");
});

test("daysForEditor and defaultDay: in the evening today, otherwise yesterday, otherwise the most recent", () => {
  const trip = { start: "2026-07-12T08:00:00", end: "2026-07-16T20:00:00" };
  const days = daysForEditor(trip, { now: new Date("2026-07-20T12:00:00") });
  assert.deepEqual(days.map((t) => [t.key, t.number]), [["2026-07-12", 1], ["2026-07-13", 2], ["2026-07-14", 3], ["2026-07-15", 4], ["2026-07-16", 5]]);

  const running = { start: "2026-07-12T08:00:00", live: true };
  const runningDays = daysForEditor(running, { now: new Date("2026-07-14T19:00:00") });
  assert.equal(runningDays.at(-1).key, "2026-07-14");
  const belegt = new Set(["2026-07-12"]);
  assert.equal(defaultDay(runningDays, belegt, new Date("2026-07-14T19:00:00")), "2026-07-14", "evening: today");
  assert.equal(defaultDay(runningDays, belegt, new Date("2026-07-14T09:00:00")), "2026-07-13", "morning: yesterday");
  assert.equal(defaultDay(runningDays, new Set(runningDays.map((t) => t.key)), new Date("2026-07-14T09:00:00")), "2026-07-14", "everything written: the most recent");
  assert.equal(defaultDay([], new Set()), "");
});

test("photoDayHint: names the trip day most photos fit better", () => {
  const days = [{ key: "2026-07-13", number: 2 }, { key: "2026-07-14", number: 3 }];
  const file = (iso) => ({ lastModified: new Date(iso).getTime() });
  assert.equal(photoDayHint([file("2026-07-14T10:00:00")], "2026-07-14", days), null);
  const h = photoDayHint([file("2026-07-13T10:00:00"), file("2026-07-13T11:00:00"), file("2026-07-14T09:00:00")], "2026-07-14", days);
  assert.deepEqual(h, { key: "2026-07-13", number: 2, count: 2 });
  assert.equal(photoDayHint([file("2025-01-01T10:00:00")], "2026-07-14", days), null, "photos outside the trip give no hint");
});

const T = (text) => ({ t: "text", text });
const F = (...ids) => ({ t: "fotos", ids });

test("trayPhotos: photos of the entry that are in no group", () => {
  assert.deepEqual(trayPhotos([T("a"), F("x")], ["x", "y", "z"]), ["y", "z"]);
  assert.deepEqual(trayPhotos([], undefined), []);
});

test("normalizeBlocks: groups merge, text at the start and the end, empty groups gone", () => {
  assert.deepEqual(normalizeBlocks([F("a"), F(), F("b")]), [T(""), F("a", "b"), T("")]);
  assert.deepEqual(normalizeBlocks([]), [T("")]);
  assert.deepEqual(normalizeBlocks([T("x"), F()]), [T("x")]);
});

test("normalizeBlocks: neighbouring texts are joined, empty texts between groups are dropped", () => {
  assert.deepEqual(normalizeBlocks([T("eins"), T("zwei")]), [T("eins\n\nzwei")]);
  assert.deepEqual(normalizeBlocks([T("eins"), T("")]), [T("eins")]);
  assert.deepEqual(normalizeBlocks([T("a"), F("x"), T(""), F("y"), T("b")]), [T("a"), F("x", "y"), T("b")]);
  assert.deepEqual(normalizeBlocks([T("a"), F("x"), T("  \n"), T("b")]), [T("a"), F("x"), T("b")]);
});

test("removePhotoFromBlocks: takes the photo out of its group, an empty group disappears", () => {
  assert.deepEqual(removePhotoFromBlocks([T("x"), F("a", "b")], "a"), [T("x"), F("b"), T("")]);
  assert.deepEqual(removePhotoFromBlocks([T("x"), F("a")], "a"), [T("x")]);
  // The text around the photo grows back together.
  assert.deepEqual(removePhotoFromBlocks([T("vorher"), F("a"), T("nachher")], "a"), [T("vorher\n\nnachher")]);
});

test("textSplitPoints: every line break, but not at the edges", () => {
  assert.deepEqual(textSplitPoints("eins\nzwei"), [{ from: 4, to: 5 }]);
  assert.deepEqual(textSplitPoints("eins\n\nzwei \n drei"), [{ from: 4, to: 6 }, { from: 10, to: 13 }]);
  assert.deepEqual(textSplitPoints("\nanfang"), []);
  assert.deepEqual(textSplitPoints("ende\n"), []);
  assert.deepEqual(textSplitPoints("ohne umbruch"), []);
});

test("placePhoto: between two paragraphs; next to a group it merges", () => {
  assert.deepEqual(placePhoto([T("a"), T("b")], "x", { kind: "between", index: 1 }), [T("a"), F("x"), T("b")]);
  assert.deepEqual(placePhoto([T("a")], "x", { kind: "between", index: 1 }), [T("a"), F("x"), T("")]);
  assert.deepEqual(placePhoto([T("a"), F("y"), T("b")], "x", { kind: "between", index: 1 }), [T("a"), F("x", "y"), T("b")]);
  assert.deepEqual(placePhoto([T("a"), F("y"), T("b")], "x", { kind: "between", index: 2 }), [T("a"), F("y", "x"), T("b")]);
});

test("placePhoto: in the middle of a paragraph splits it", () => {
  const result = placePhoto([T("Morgens los.\n\nAbends Picknick.")], "x", { kind: "text", block: 0, from: 12, to: 14 });
  assert.deepEqual(result, [T("Morgens los."), F("x"), T("Abends Picknick.")]);
});

test("placePhoto: moving within a block and between groups", () => {
  // a b c -> c before a
  assert.deepEqual(placePhoto([T("t"), F("a", "b", "c")], "c", { kind: "group", block: 1, index: 0 }), [T("t"), F("c", "a", "b"), T("")]);
  // a b c -> a after c (position 3 before removing)
  assert.deepEqual(placePhoto([T("t"), F("a", "b", "c")], "a", { kind: "group", block: 1, index: 3 }), [T("t"), F("b", "c", "a"), T("")]);
  // the only photo of a group into a later group: the empty group disappears, indexes stay right
  assert.deepEqual(placePhoto([F("a"), T("t"), F("b")], "a", { kind: "group", block: 2, index: 1 }), [T("t"), F("b", "a"), T("")]);
});

test("placePhoto: a photo from the tray is added", () => {
  assert.deepEqual(placePhoto([T("a")], "n", { kind: "between", index: 0 }), [T(""), F("n"), T("a")]);
  assert.deepEqual(placePhoto([T("a")], "n", { kind: "between", index: 1 }), [T("a"), F("n"), T("")]);
});
