import test from "node:test";
import assert from "node:assert/strict";
import {
  ALLGEMEINE_REGELN, regelnAusSperrliste, findeTreffer, hinzugefuegteZeilen,
} from "../../scripts/sensitive-lib.mjs";

test("Sperrliste: Kommentare und Leerzeilen werden ignoriert, Groß-/Kleinschreibung egal", () => {
  const regeln = regelnAusSperrliste("# Kommentar\n\nBeispielstadt\n  \nmeine-domain\\.example\n");
  assert.equal(regeln.length, 2);
  assert.equal(findeTreffer("Ich wohne in BEISPIELSTADT", regeln).length, 1);
  assert.equal(findeTreffer("https://meine-domain.example/app", regeln).length, 1);
  assert.equal(findeTreffer("nichts Privates hier", regeln).length, 0);
});

test("Sperrliste: ein ungültiger regulärer Ausdruck meldet die Zeile", () => {
  assert.throws(() => regelnAusSperrliste("ok\n(kaputt"), /Zeile 2/);
});

test("Sperrliste: der Lookbehind lässt anonymisierte (gespiegelte/verschobene) Koordinaten durch", () => {
  const regeln = regelnAusSperrliste("(?<![-0-9])48\\.137[0-9]{3,}\n(?<![0-9])11\\.575[0-9]{3,}");
  assert.equal(findeTreffer('{"lat": 48.137154, "lon": 11.575382}', regeln).length, 2, "Koordinaten dieser Gegend treffen");
  assert.equal(findeTreffer('{"lat": -48.137154, "lon": 31.575382}', regeln).length, 0, "anonymisierte nicht");
});

test("allgemeine Regeln: Schlüssel und Tokens werden erkannt", () => {
  const regeln = ALLGEMEINE_REGELN;
  assert.equal(findeTreffer("-----BEGIN " + "PRIVATE KEY-----", regeln).length, 1);
  assert.equal(findeTreffer("token ghp_" + "a".repeat(30), regeln).length, 1);
  assert.equal(findeTreffer("VAPID_PRIVATE_KEY=" + "A".repeat(30), regeln).length, 1);
  assert.equal(findeTreffer("VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY:-}", regeln).length, 0, "Platzhalter ist kein Geheimnis");
  assert.equal(findeTreffer("ganz normaler Text", regeln).length, 0);
});

test("hinzugefuegteZeilen: liest nur neue Zeilen samt Datei und Zeilennummer", () => {
  const diff = [
    "diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1,2 +5,2 @@",
    "-alt", "+neu eins", " Kontext", "+neu zwei",
    "diff --git a/b.txt b/b.txt", "--- a/b.txt", "+++ b/b.txt", "@@ -0,0 +1 @@", "+zeile in b",
  ].join("\n");
  assert.deepEqual(hinzugefuegteZeilen(diff), [
    { datei: "a.txt", zeile: 5, text: "neu eins" },
    { datei: "a.txt", zeile: 7, text: "neu zwei" },
    { datei: "b.txt", zeile: 1, text: "zeile in b" },
  ]);
});
