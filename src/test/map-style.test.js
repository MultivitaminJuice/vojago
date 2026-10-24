import { test } from "node:test";
import assert from "node:assert/strict";
import { kachelPaint, schummerungPaint, kachelUrl, gueltigerKartenstil } from "../map-style.js";

test("kachelPaint: Dunkelmodus dunkelt die helle Kachel ab, Hellmodus lässt sie unverändert", () => {
  for (const stil of ["farbig", "dezent"]) {
    assert.ok(kachelPaint(true, stil)["raster-brightness-max"] < 0.7, `${stil} wird abgedunkelt`);
    assert.equal(kachelPaint(false, stil)["raster-brightness-max"], 1);
  }
  assert.equal(kachelPaint(false)["raster-saturation"], 0);
});

test("schummerungPaint: beide Modi liefern alle vier Werte", () => {
  for (const dark of [true, false]) {
    const p = schummerungPaint(dark);
    for (const k of ["hillshade-exaggeration", "hillshade-shadow-color", "hillshade-highlight-color", "hillshade-accent-color"]) assert.ok(k in p);
  }
});

test("kachelUrl: farbig = Voyager, dezent = Positron, Unbekanntes fällt auf farbig zurück", () => {
  assert.match(kachelUrl("farbig", "K"), /\/rastertiles\/voyager\/\{z\}\/\{x\}\/\{y\}@2x\.png\?key=K$/);
  assert.match(kachelUrl("dezent", "K"), /\/light_all\//);
  assert.equal(gueltigerKartenstil("blau"), "farbig");
  assert.equal(gueltigerKartenstil(undefined), "farbig");
});

test("kachelPaint: im Dunkelmodus bleibt beim farbigen Stil die Sättigung, beim dezenten sinkt sie", () => {
  assert.ok(kachelPaint(true, "farbig")["raster-saturation"] > 0);
  assert.ok(kachelPaint(true, "dezent")["raster-saturation"] < 0);
});
