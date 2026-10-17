// Verdrahtungs-Tests für state.js — bewusst anders als route-visibility.test.js:
// dort werden reine Funktionen mit fest eingetippten Filterwerten aufgerufen,
// das prüft nie, ob ein neuer Wert überhaupt bis zu ihnen durchkommt. Genau
// diese Lücke hat einen echten Fehler verdeckt (18. August 2026): der Picker
// bot "nicht_zugeordnet" an, setRouteDriveFilter() hatte aber noch die alte,
// engere Liste und wies den Klick still ab — kein Test hier hätte das
// bemerkt, weil es keinen hier gab. Diese Datei prüft die Verdrahtung selbst:
// jeder in ROUTE_DRIVE_FILTERS gelistete Wert muss durch JEDES Tor kommen,
// mit dem state.js ihn validiert.
import test from "node:test";
import assert from "node:assert/strict";

import { state, ROUTE_DRIVE_FILTERS, MAP_METRICS, setRouteDriveFilter, setMetric, collectPreferences, applyPreferences } from "../state.js";

test("setRouteDriveFilter: jeder gültige Wert wird tatsächlich übernommen", () => {
  for (const wert of ROUTE_DRIVE_FILTERS) {
    setRouteDriveFilter(wert);
    assert.equal(state.routeDriveFilter, wert, `setRouteDriveFilter("${wert}") wurde nicht übernommen`);
  }
});

test("setRouteDriveFilter: unbekannte Werte werden abgelehnt, nicht stillschweigend übernommen", () => {
  setRouteDriveFilter("etappe");
  setRouteDriveFilter("erfunden");
  assert.equal(state.routeDriveFilter, "etappe");
});

test("collectPreferences/applyPreferences: jeder gültige Filterwert übersteht den Rundlauf", () => {
  for (const wert of ROUTE_DRIVE_FILTERS) {
    setRouteDriveFilter(wert);
    const prefs = collectPreferences();
    assert.equal(prefs.routeDriveFilter, wert, `collectPreferences() verwarf "${wert}"`);

    setRouteDriveFilter("etappe"); // zurücksetzen, um applyPreferences ehrlich zu prüfen
    applyPreferences(prefs);
    assert.equal(state.routeDriveFilter, wert, `applyPreferences() übernahm "${wert}" nicht`);
  }
});

// Dieselbe Absicherung für die Karten-Kenngröße (state.metric) — genauso
// an mehreren Stellen dupliziert wie routeDriveFilter, genauso anfällig
// dafür, dass ein neuer Wert (hier: "dist") an einer der Stellen vergessen
// wird.
test("setMetric: jeder gültige Wert wird tatsächlich übernommen", () => {
  for (const wert of MAP_METRICS) {
    setMetric(wert);
    assert.equal(state.metric, wert, `setMetric("${wert}") wurde nicht übernommen`);
  }
});

test("setMetric: unbekannte Werte werden abgelehnt, nicht stillschweigend übernommen", () => {
  setMetric("day");
  setMetric("erfunden");
  assert.equal(state.metric, "day");
});

test("collectPreferences/applyPreferences: jeder gültige Metric-Wert übersteht den Rundlauf", () => {
  for (const wert of MAP_METRICS) {
    setMetric(wert);
    const prefs = collectPreferences();
    assert.equal(prefs.metric, wert, `collectPreferences() verwarf "${wert}"`);

    setMetric("day");
    applyPreferences(prefs);
    assert.equal(state.metric, wert, `applyPreferences() übernahm "${wert}" nicht`);
  }
});
