import test from "node:test";
import assert from "node:assert/strict";

import { nachtfensterStunden, pruefeAutomatischeUebernachtung, standdauerStunden, entscheideStandKategorie } from "../overnight-rules.js";

const lokal = (tag, stunde, minute = 0) => new Date(2026, 7, tag, stunde, minute).toISOString();

test("Übernachtung: 23 bis 4 Uhr wird trotz nur 5 Stunden Stand erkannt", () => {
  const pruefung = pruefeAutomatischeUebernachtung(lokal(10, 23), lokal(11, 4));

  assert.equal(pruefung.qualifiziert, true);
  assert.equal(Math.round(pruefung.standStunden), 5);
  assert.equal(Math.round(pruefung.nachtStunden), 5);
});

test("Übernachtung: Datumswechsel allein reicht nicht", () => {
  const pruefung = pruefeAutomatischeUebernachtung(lokal(10, 21), lokal(11, 1));

  assert.equal(pruefung.qualifiziert, false);
  assert.equal(Math.round(pruefung.standStunden), 4);
  assert.equal(Math.round(pruefung.nachtStunden), 3);
});

test("Übernachtung: langer Tagesstopp ohne Nachtfenster wird nicht erkannt", () => {
  const pruefung = pruefeAutomatischeUebernachtung(lokal(10, 10), lokal(10, 16));

  assert.equal(pruefung.qualifiziert, false);
  assert.equal(Math.round(pruefung.standStunden), 6);
  assert.equal(pruefung.nachtStunden, 0);
});

test("Übernachtung: Nachtfenster-Anteil wird über Mitternacht berechnet", () => {
  assert.equal(standdauerStunden(lokal(10, 20), lokal(11, 2)), 6);
  assert.equal(nachtfensterStunden(lokal(10, 20), lokal(11, 2)), 4);
  assert.equal(pruefeAutomatischeUebernachtung(lokal(10, 20), lokal(11, 2)).qualifiziert, true);
});

// entscheideStandKategorie() — kurze Stopps (z. B. ein Einkauf tagsüber)
// sollen erfasst werden, ohne die eigentliche Übernachtungserkennung
// aufzuweichen (Nutzerwunsch, 05.09.2026: ein Einkaufsbesuch fiel bisher
// komplett durchs Raster).
test("Stand-Kategorie: qualifiziert sich als Übernachtung, wird auch so eingestuft", () => {
  const e = entscheideStandKategorie(lokal(10, 23), lokal(11, 4));
  assert.equal(e.catId, "uebernachtung");
});

test("Stand-Kategorie: kurzer Tagesstopp (z. B. Einkaufsbesuch) wird als Stopp erfasst", () => {
  const e = entscheideStandKategorie(lokal(10, 14), lokal(10, 15, 30)); // 1,5h, mitten am Tag
  assert.equal(e.catId, "stopp");
});

test("Stand-Kategorie: langer Tagesstopp ohne Nachtfenster bleibt ein Stopp, keine Übernachtung", () => {
  const e = entscheideStandKategorie(lokal(10, 10), lokal(10, 16)); // 6h, kein Nachtfenster
  assert.equal(e.catId, "stopp");
});

test("Stand-Kategorie: zu kurz für beides (z. B. eine Ampel) wird gar nicht erfasst", () => {
  const e = entscheideStandKategorie(lokal(10, 14), lokal(10, 14, 5)); // 5 Minuten
  assert.equal(e, null);
});
