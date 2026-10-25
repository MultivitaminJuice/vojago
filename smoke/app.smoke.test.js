import { expect, test } from "@playwright/test";

test("App-Smoke: Hauptbereiche laden ohne Konsolenfehler", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.route("**/api/**", (route) => {
    if (route.request().url().endsWith("/api/auth/me")) {
      return route.fulfill({
        contentType: "application/json",
        body: "{",
      });
    }
    return route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "nicht angemeldet" }),
    });
  });

  await page.goto("/");

  await expect(page.getByRole("button", { name: /VOJAĜO/ })).toBeVisible();
  await expect(page.locator("#trip-context-reise").getByText("Alpen-Runde")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Karte" })).toBeVisible();

  await page.getByRole("button", { name: /Fahrtenfilter/ }).click();
  await expect(page.getByRole("dialog", { name: "Fahrten filtern" })).toBeVisible();
  await page.getByRole("dialog", { name: "Fahrten filtern" }).getByRole("button", { name: /Alle/ }).click();

  await page.getByRole("tab", { name: "Karte" }).click();
  await expect(page.getByLabel("Karte", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Logbuch" }).click();
  // Die Filter stecken hinter der leisen "Anzeigen"-Zeile.
  await page.getByRole("button", { name: /anzeigen/i }).first().click();
  await expect(page.getByRole("group", { name: "Einträge filtern" })).toBeVisible();

  await page.getByRole("tab", { name: "Mehr" }).click();
  await expect(page.getByRole("tablist", { name: "Mehr" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Wache" })).toHaveAttribute("aria-pressed", "true");

  expect(errors).toEqual([]);
});
