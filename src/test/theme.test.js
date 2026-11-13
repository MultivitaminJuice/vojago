import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTheme, validTheme } from "../theme.js";

test("validTheme: unknown or missing values fall back to auto", () => {
  assert.equal(validTheme("dark"), "dark");
  assert.equal(validTheme("light"), "light");
  assert.equal(validTheme("auto"), "auto");
  for (const v of [undefined, null, "", "blau", 3]) assert.equal(validTheme(v), "auto");
});

test("applyTheme: erzwingt Hell/Dunkel, auto entfernt die Vorgabe wieder", () => {
  const root = { dataset: {} };
  applyTheme("dark", root);
  assert.equal(root.dataset.theme, "dark");
  applyTheme("light", root);
  assert.equal(root.dataset.theme, "light");
  applyTheme("auto", root);
  assert.equal("theme" in root.dataset, false);
  applyTheme("kaputt", root);
  assert.equal("theme" in root.dataset, false);
});
