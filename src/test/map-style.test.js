import { test } from "node:test";
import assert from "node:assert/strict";
import { kachelPaint, schummerungPaint } from "../map-style.js";

test("kachelPaint: Dunkelmodus dunkelt die helle Kachel ab, Hellmodus lässt sie unverändert", () => {
  assert.equal(kachelPaint(true)["raster-brightness-max"], 0.5);
  assert.equal(kachelPaint(false)["raster-brightness-max"], 1);
  assert.equal(kachelPaint(false)["raster-saturation"], 0);
});

test("schummerungPaint: beide Modi liefern alle vier Werte", () => {
  for (const dark of [true, false]) {
    const p = schummerungPaint(dark);
    for (const k of ["hillshade-exaggeration", "hillshade-shadow-color", "hillshade-highlight-color", "hillshade-accent-color"]) assert.ok(k in p);
  }
});
