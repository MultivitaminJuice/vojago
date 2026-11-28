import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Every main area of the tab bar, in the fixed order (docs/working-principles.md § Navigation).
// UI-6: each area loads without console errors, the shell and the same tab bar are there, and the
// matching tab is the active one. F-8: axe checks each area against WCAG 2.2 AA.
const AREAS = ["Karte", "Reisen", "Logbuch", "Mehr"];
const WIDTHS = { phone: 390, desktop: 1280 };

// Known axe findings when the check was introduced (2026-11-27, ADR-001). They are to be fixed
// in Phase 3 (design and accessibility); this list may only shrink. A rule not listed here, or
// more affected elements than `maxNodes` in one area, fails the test.
const KNOWN_AXE_FINDINGS = {
  "color-contrast": { maxNodes: 20, reason: "old accent and muted text colours (TOK-COL-3)" },
  "button-name": { maxNodes: 8, reason: "icon-only buttons without a label (WEB-3)" },
  "aria-required-children": { maxNodes: 2, reason: "tablist contains non-tab children" },
  "target-size": { maxNodes: 2, reason: "small touch targets (F-6)" },
  "label-content-name-mismatch": { maxNodes: 2, reason: "aria-label differs from visible text" },
  label: { maxNodes: 1, reason: "form field without a label" },
  "select-name": { maxNodes: 1, reason: "select without an accessible name" },
  "nested-interactive": { maxNodes: 1, reason: "control nested inside another control" },
  "meta-viewport": { maxNodes: 1, reason: "zoom is disabled in the viewport meta tag" },
  "scrollable-region-focusable": { maxNodes: 1, reason: "scroll area not reachable by keyboard" },
};

// Demo data without a server: every API answer is "not signed in".
async function open(page, width) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", (route) => {
    if (route.request().url().endsWith("/api/auth/me")) {
      return route.fulfill({ contentType: "application/json", body: "{" });
    }
    return route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "nicht angemeldet" }),
    });
  });
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Karte" })).toBeVisible();
  return errors;
}

for (const [label, width] of Object.entries(WIDTHS)) {
  test(`Hauptbereiche (${label}): Shell, aktiver Tab, Barrierefreiheit`, async ({ page }) => {
    const errors = await open(page, width);
    const unexpected = [];

    for (const area of AREAS) {
      await page.getByRole("tab", { name: area }).click();

      const tabs = page.locator(".tabbar").getByRole("tab");
      await expect(tabs).toHaveText(AREAS.map((name) => new RegExp(name)));
      for (const name of AREAS) {
        await expect(page.getByRole("tab", { name })).toHaveAttribute(
          "aria-selected",
          String(name === area),
        );
      }

      const { violations } = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      for (const v of violations) {
        const known = KNOWN_AXE_FINDINGS[v.id];
        if (!known || v.nodes.length > known.maxNodes) {
          unexpected.push(`${area}: ${v.id} (${v.impact}, ${v.nodes.length}×) ${v.help}`);
        }
      }
    }

    expect(unexpected, "new accessibility findings").toEqual([]);
    expect(errors).toEqual([]);
  });
}
