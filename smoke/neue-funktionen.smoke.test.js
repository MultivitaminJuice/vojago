import { expect, test } from "@playwright/test";

// Die Demo-Daten kommen ohne Server aus: jede API-Antwort ist "nicht angemeldet".
async function starte(page, breite = 1280) {
  const fehler = [];
  page.on("console", (message) => { if (message.type() === "error") fehler.push(message.text()); });
  page.on("pageerror", (error) => fehler.push(error.message));
  await page.route("**/api/**", (route) => {
    if (route.request().url().endsWith("/api/auth/me")) {
      return route.fulfill({ contentType: "application/json", body: "{" });
    }
    return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "nicht angemeldet" }) });
  });
  await page.setViewportSize({ width: breite, height: 900 });
  await page.goto("/");
  await expect(page.locator("#trip-context-reise").getByText("Alpen-Runde")).toBeVisible();
  return fehler;
}

test("Zeitraum wählen: eigener Kalender statt Browser-Datumsfelder", async ({ page }) => {
  const fehler = await starte(page);

  await page.locator("#trip-context-reise").click();
  await page.getByRole("button", { name: /Zeitraum wählen/ }).click();
  const dialog = page.getByRole("dialog", { name: "Zeitraum wählen" });
  await expect(dialog).toBeVisible();

  // Ein Monatskalender mit sechs Wochen, keine nativen Datumsfelder.
  await expect(dialog.locator(".kal-tag")).toHaveCount(42);
  await expect(dialog.locator('input[type="datetime-local"], input[type="date"]')).toHaveCount(0);

  // Erst Anfang, dann Ende tippen: der Bereich dazwischen wird markiert.
  const tage = dialog.locator(".kal-tag:not(.aussen)");
  await tage.nth(9).click();
  await expect(page.locator("#range-summe")).toContainText("ein Tag");
  await tage.nth(12).click();
  await expect(page.locator("#range-summe")).toContainText("–");
  await expect(dialog.locator(".kal-tag.rolle-mitte")).toHaveCount(2);

  await dialog.getByRole("button", { name: "Schließen" }).click();
  await expect(dialog).toBeHidden();
  expect(fehler).toEqual([]);
});

test("Einstellungen: Datenlücken markieren ist standardmäßig aus und lässt sich einschalten", async ({ page }) => {
  const fehler = await starte(page);

  await page.getByRole("tab", { name: "Mehr" }).click();
  await page.getByRole("button", { name: "Einstellungen", exact: true }).click();
  const schalter = page.locator("#cfg-luecken");
  await expect(schalter).toHaveAttribute("aria-checked", "false");
  await schalter.click();
  await expect(schalter).toHaveAttribute("aria-checked", "true");
  expect(fehler).toEqual([]);
});

test("Logbuch: auf breiten Fenstern in Spalten, auf schmalen untereinander", async ({ page }) => {
  const fehler = await starte(page, 1400);

  await page.getByRole("tab", { name: "Logbuch" }).click();
  await expect.poll(() => page.locator("#journal .jt-spalte").count()).toBeGreaterThanOrEqual(2);

  await page.setViewportSize({ width: 600, height: 900 });
  await expect.poll(() => page.locator("#journal .jt-spalte").count()).toBe(0);
  await expect(page.locator("#journal .jt-tag").first()).toBeVisible();
  expect(fehler).toEqual([]);
});

test("Reisen: Kilometer pro Tag mit Skala, ein Tipp auf den Balken zeigt die Kilometer", async ({ page }) => {
  const fehler = await starte(page);

  await page.getByRole("tab", { name: "Reisen" }).click();
  const balken = page.locator(".balken .bars .b");
  await expect(balken.first()).toBeVisible();
  await expect(page.locator(".balken-achse span").first()).toHaveText("0");

  await balken.nth(1).click();
  await expect(balken.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(balken.nth(1).locator(".wert")).toBeVisible();
  await expect(balken.nth(1).locator(".wert")).toContainText("km");
  expect(fehler).toEqual([]);
});

test("Tag erzählen: Text schreiben sichert einen Entwurf, es gibt keine Absatz-Knöpfe mehr", async ({ page }) => {
  const fehler = await starte(page);

  await page.getByRole("tab", { name: "Logbuch" }).click();
  await page.getByRole("button", { name: "Tag erzählen" }).first().click();
  const feld = page.getByRole("textbox", { name: "Was war heute los?" });
  await expect(feld).toBeVisible();
  await feld.fill("Heute ging es über den Pass.");
  await expect(page.locator("#tag-status")).toContainText("Entwurf gespeichert");

  await expect(page.getByRole("button", { name: /Absatz/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Fotos wählen/ })).toBeVisible();
  expect(fehler).toEqual([]);
});
