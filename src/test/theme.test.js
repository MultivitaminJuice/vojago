import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTheme, gueltigesTheme } from "../theme.js";

test("gueltigesTheme: unbekannte oder fehlende Werte fallen auf auto zurück", () => {
  assert.equal(gueltigesTheme("dark"), "dark");
  assert.equal(gueltigesTheme("light"), "light");
  assert.equal(gueltigesTheme("auto"), "auto");
  for (const v of [undefined, null, "", "blau", 3]) assert.equal(gueltigesTheme(v), "auto");
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
