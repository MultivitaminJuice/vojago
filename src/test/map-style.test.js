import { test } from "node:test";
import assert from "node:assert/strict";
import { tilePaint, hillshadePaint, tileUrl, validMapStyle } from "../map-style.js";

test("tilePaint: dark mode darkens the light tile, light mode leaves it unchanged", () => {
  for (const style of ["farbig", "dezent"]) {
    assert.ok(tilePaint(true, style)["raster-brightness-max"] < 0.7, `${style} is darkened`);
    assert.equal(tilePaint(false, style)["raster-brightness-max"], 1);
  }
  assert.equal(tilePaint(false)["raster-saturation"], 0);
});

test("hillshadePaint: both modes give all four values", () => {
  for (const dark of [true, false]) {
    const p = hillshadePaint(dark);
    for (const k of ["hillshade-exaggeration", "hillshade-shadow-color", "hillshade-highlight-color", "hillshade-accent-color"]) assert.ok(k in p);
  }
});

test("tileUrl: farbig = Voyager, dezent = Positron, anything unknown falls back to farbig", () => {
  assert.match(tileUrl("farbig", "K"), /\/rastertiles\/voyager\/\{z\}\/\{x\}\/\{y\}@2x\.png\?key=K$/);
  assert.match(tileUrl("dezent", "K"), /\/light_all\//);
  assert.equal(validMapStyle("blau"), "farbig");
  assert.equal(validMapStyle(undefined), "farbig");
});

test("tilePaint: in dark mode the colourful style keeps its saturation, the subtle one loses some", () => {
  assert.ok(tilePaint(true, "farbig")["raster-saturation"] > 0);
  assert.ok(tilePaint(true, "dezent")["raster-saturation"] < 0);
});
