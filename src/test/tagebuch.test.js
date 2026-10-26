import { test } from "node:test";
import assert from "node:assert/strict";
import { ablageFotos, ordneBlocks, entferneFotoAusBlocks, textTrennstellen, setzeFoto, parseBlocks, bereinigeBlocks, titelbildId, ohneFoto, mitVerwaistenFotos, geschriebenText, tageFuerEditor, standardTag, fotoTagHinweis, hatInhalt } from "../tagebuch.js";

test("parseBlocks: liest JSON-Text oder Liste, verwirft Unbrauchbares", () => {
  assert.deepEqual(parseBlocks('[{"t":"text","text":"a"},{"t":"fotos","ids":["x",5]},{"t":"video"}]'), [{ t: "text", text: "a" }, { t: "fotos", ids: ["x"] }]);
  assert.deepEqual(parseBlocks("kein json"), []);
  assert.deepEqual(parseBlocks(null), []);
});

test("bereinigeBlocks: leere Absätze und Gruppen entfallen, Foto-Gruppen hintereinander verschmelzen", () => {
  const r = bereinigeBlocks([
    { t: "text", text: "  \n" }, { t: "text", text: "Erster Absatz\n\n" },
    { t: "fotos", ids: ["a"] }, { t: "fotos", ids: ["b", "c"] }, { t: "fotos", ids: [] },
    { t: "text", text: "Zweiter" },
  ]);
  assert.deepEqual(r, [{ t: "text", text: "Erster Absatz" }, { t: "fotos", ids: ["a", "b", "c"] }, { t: "text", text: "Zweiter" }]);
  assert.equal(hatInhalt([{ t: "text", text: "   " }]), false);
  assert.equal(hatInhalt([{ t: "fotos", ids: ["a"] }]), true);
});

test("Titelbild ist das erste Foto; ohneFoto nimmt es aus den Blöcken, leere Gruppen entfallen", () => {
  const blocks = [{ t: "text", text: "x" }, { t: "fotos", ids: ["a"] }, { t: "text", text: "y" }, { t: "fotos", ids: ["b", "c"] }];
  assert.equal(titelbildId(blocks), "a");
  assert.equal(titelbildId([{ t: "text", text: "x" }]), null);
  assert.deepEqual(ohneFoto(blocks, "a"), [{ t: "text", text: "x" }, { t: "text", text: "y" }, { t: "fotos", ids: ["b", "c"] }]);
  assert.equal(ohneFoto(blocks, null), blocks);
});

test("mitVerwaistenFotos: Fotos des Eintrags, die in keinem Block stehen, kommen ans Ende", () => {
  const blocks = [{ t: "fotos", ids: ["a"] }];
  assert.deepEqual(mitVerwaistenFotos(blocks, ["a", "b"]), [{ t: "fotos", ids: ["a"] }, { t: "fotos", ids: ["b"] }]);
  assert.equal(mitVerwaistenFotos(blocks, ["a"]), blocks);
});

test("geschriebenText: am selben Abend, am nächsten Morgen, n Tage später", () => {
  const lokal = (iso) => new Date(iso).toISOString();
  assert.equal(geschriebenText("2026-07-14", lokal("2026-07-14T20:00:00")), "am selben Abend");
  assert.equal(geschriebenText("2026-07-14", lokal("2026-07-14T10:00:00")), "am selben Tag");
  assert.equal(geschriebenText("2026-07-14", lokal("2026-07-15T08:30:00")), "am nächsten Morgen");
  assert.equal(geschriebenText("2026-07-14", lokal("2026-07-15T15:00:00")), "am nächsten Tag");
  assert.equal(geschriebenText("2026-07-14", lokal("2026-07-17T09:00:00")), "3 Tage später");
  assert.equal(geschriebenText("2026-07-14", lokal("2026-07-13T09:00:00")), "");
  assert.equal(geschriebenText("2026-07-14", ""), "");
  // SQLite-Format ohne Zeitzone wird als UTC gelesen.
  assert.ok(geschriebenText("2026-07-14", "2026-07-15 06:30:00") !== "");
});

test("tageFuerEditor und standardTag: abends heute, sonst gestern, sonst der jüngste", () => {
  const trip = { start: "2026-07-12T08:00:00", end: "2026-07-16T20:00:00" };
  const tage = tageFuerEditor(trip, { jetzt: new Date("2026-07-20T12:00:00") });
  assert.deepEqual(tage.map((t) => [t.key, t.nummer]), [["2026-07-12", 1], ["2026-07-13", 2], ["2026-07-14", 3], ["2026-07-15", 4], ["2026-07-16", 5]]);

  const lauf = { start: "2026-07-12T08:00:00", live: true };
  const laufTage = tageFuerEditor(lauf, { jetzt: new Date("2026-07-14T19:00:00") });
  assert.equal(laufTage.at(-1).key, "2026-07-14");
  const belegt = new Set(["2026-07-12"]);
  assert.equal(standardTag(laufTage, belegt, new Date("2026-07-14T19:00:00")), "2026-07-14", "abends: heute");
  assert.equal(standardTag(laufTage, belegt, new Date("2026-07-14T09:00:00")), "2026-07-13", "morgens: gestern");
  assert.equal(standardTag(laufTage, new Set(laufTage.map((t) => t.key)), new Date("2026-07-14T09:00:00")), "2026-07-14", "alles erzählt: jüngster");
  assert.equal(standardTag([], new Set()), "");
});

test("fotoTagHinweis: nennt den Reisetag, zu dem die meisten Fotos eher passen", () => {
  const tage = [{ key: "2026-07-13", nummer: 2 }, { key: "2026-07-14", nummer: 3 }];
  const datei = (iso) => ({ lastModified: new Date(iso).getTime() });
  assert.equal(fotoTagHinweis([datei("2026-07-14T10:00:00")], "2026-07-14", tage), null);
  const h = fotoTagHinweis([datei("2026-07-13T10:00:00"), datei("2026-07-13T11:00:00"), datei("2026-07-14T09:00:00")], "2026-07-14", tage);
  assert.deepEqual(h, { key: "2026-07-13", nummer: 2, anzahl: 2 });
  assert.equal(fotoTagHinweis([datei("2025-01-01T10:00:00")], "2026-07-14", tage), null, "Fotos außerhalb der Reise ergeben keinen Hinweis");
});

const T = (text) => ({ t: "text", text });
const F = (...ids) => ({ t: "fotos", ids });

test("ablageFotos: Fotos des Eintrags, die in keiner Gruppe stehen", () => {
  assert.deepEqual(ablageFotos([T("a"), F("x")], ["x", "y", "z"]), ["y", "z"]);
  assert.deepEqual(ablageFotos([], undefined), []);
});

test("ordneBlocks: Gruppen verschmelzen, Text steht am Anfang und Ende, leere Gruppen weg", () => {
  assert.deepEqual(ordneBlocks([F("a"), F(), F("b")]), [T(""), F("a", "b"), T("")]);
  assert.deepEqual(ordneBlocks([]), [T("")]);
  assert.deepEqual(ordneBlocks([T("x"), F()]), [T("x")]);
});

test("ordneBlocks: benachbarte Texte werden zu einem verbunden, leere Texte zwischen Gruppen entfallen", () => {
  assert.deepEqual(ordneBlocks([T("eins"), T("zwei")]), [T("eins\n\nzwei")]);
  assert.deepEqual(ordneBlocks([T("eins"), T("")]), [T("eins")]);
  assert.deepEqual(ordneBlocks([T("a"), F("x"), T(""), F("y"), T("b")]), [T("a"), F("x", "y"), T("b")]);
  assert.deepEqual(ordneBlocks([T("a"), F("x"), T("  \n"), T("b")]), [T("a"), F("x"), T("b")]);
});

test("entferneFotoAusBlocks: nimmt das Foto aus der Gruppe, leere Gruppe verschwindet", () => {
  assert.deepEqual(entferneFotoAusBlocks([T("x"), F("a", "b")], "a"), [T("x"), F("b"), T("")]);
  assert.deepEqual(entferneFotoAusBlocks([T("x"), F("a")], "a"), [T("x")]);
  // Der Text um das Foto herum wächst wieder zusammen.
  assert.deepEqual(entferneFotoAusBlocks([T("vorher"), F("a"), T("nachher")], "a"), [T("vorher\n\nnachher")]);
});

test("textTrennstellen: jeder Zeilenumbruch, aber nicht am Rand", () => {
  assert.deepEqual(textTrennstellen("eins\nzwei"), [{ von: 4, bis: 5 }]);
  assert.deepEqual(textTrennstellen("eins\n\nzwei \n drei"), [{ von: 4, bis: 6 }, { von: 10, bis: 13 }]);
  assert.deepEqual(textTrennstellen("\nanfang"), []);
  assert.deepEqual(textTrennstellen("ende\n"), []);
  assert.deepEqual(textTrennstellen("ohne umbruch"), []);
});

test("setzeFoto: zwischen zwei Absätze, an eine Gruppe grenzend verschmilzt es", () => {
  assert.deepEqual(setzeFoto([T("a"), T("b")], "x", { art: "zwischen", index: 1 }), [T("a"), F("x"), T("b")]);
  assert.deepEqual(setzeFoto([T("a")], "x", { art: "zwischen", index: 1 }), [T("a"), F("x"), T("")]);
  assert.deepEqual(setzeFoto([T("a"), F("y"), T("b")], "x", { art: "zwischen", index: 1 }), [T("a"), F("x", "y"), T("b")]);
  assert.deepEqual(setzeFoto([T("a"), F("y"), T("b")], "x", { art: "zwischen", index: 2 }), [T("a"), F("y", "x"), T("b")]);
});

test("setzeFoto: mitten im Absatz teilt ihn", () => {
  const ergebnis = setzeFoto([T("Morgens los.\n\nAbends Picknick.")], "x", { art: "text", block: 0, von: 12, bis: 14 });
  assert.deepEqual(ergebnis, [T("Morgens los."), F("x"), T("Abends Picknick.")]);
});

test("setzeFoto: Verschieben im selben Block und zwischen Gruppen", () => {
  // a b c -> c vor a
  assert.deepEqual(setzeFoto([T("t"), F("a", "b", "c")], "c", { art: "gruppe", block: 1, index: 0 }), [T("t"), F("c", "a", "b"), T("")]);
  // a b c -> a hinter c (Position 3 vor dem Entfernen)
  assert.deepEqual(setzeFoto([T("t"), F("a", "b", "c")], "a", { art: "gruppe", block: 1, index: 3 }), [T("t"), F("b", "c", "a"), T("")]);
  // einziges Foto einer Gruppe in eine spätere Gruppe: die leere Gruppe verschwindet, Indizes bleiben richtig
  assert.deepEqual(setzeFoto([F("a"), T("t"), F("b")], "a", { art: "gruppe", block: 2, index: 1 }), [T("t"), F("b", "a"), T("")]);
});

test("setzeFoto: ein Foto aus der Ablage kommt neu hinzu", () => {
  assert.deepEqual(setzeFoto([T("a")], "n", { art: "zwischen", index: 0 }), [T(""), F("n"), T("a")]);
  assert.deepEqual(setzeFoto([T("a")], "n", { art: "zwischen", index: 1 }), [T("a"), F("n"), T("")]);
});
