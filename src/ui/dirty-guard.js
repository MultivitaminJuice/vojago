// Warnt vor Datenverlust bei ungespeicherten Inline-Änderungen — statt sie
// beim Verlassen (Tab-Wechsel, Schließen/Neuladen der Seite) kommentarlos
// zu verwerfen ODER sie ungefragt automatisch zu speichern (beides schon
// ausprobiert, beides zu Recht abgelehnt): jetzt wird gefragt, wie in jeder
// normalen App mit einem "Änderungen verwerfen?"-Dialog.
const tracked = new Set();

/** wireInlineEdit registriert sich hier automatisch — kein Zutun an der
 * jeweiligen Aufrufstelle nötig. `el` ist das zugehörige Eingabefeld: bei
 * jedem Neuzeichnen (render() baut ganze Listen neu auf, z. B.
 * renderVehicles()) entstehen frische Felder mit frischen Prüffunktionen,
 * OHNE dass sich die alten abmelden — ohne den Verbindungs-Check unten
 * bliebe die längst durch ein neues Feld ersetzte alte Prüfung für immer
 * hängen und meldete nach der allerersten Änderung überall "ungespeichert",
 * selbst direkt nach echtem Speichern (echter Fund: die Bestätigungsfrage
 * kam noch, obwohl gerade erst gespeichert wurde). */
export function trackDirty(isDirtyFn, el) {
  tracked.add({ isDirty: isDirtyFn, el });
}

function anyDirty() {
  for (const eintrag of tracked) {
    if (!eintrag.el.isConnected) { tracked.delete(eintrag); continue; }
    try { if (eintrag.isDirty()) return true; } catch { tracked.delete(eintrag); }
  }
  return false;
}

/** Vor einem Ansichtswechsel innerhalb der App aufrufen (Tabbar,
 * Mehr-Unterreiter, Sheets schließen, …). Gibt true zurück, wenn man
 * weitermachen darf — entweder war nichts offen, oder der Nutzer hat das
 * Verwerfen ausdrücklich bestätigt. */
export function duerfteWeg() {
  if (!anyDirty()) return true;
  return confirm("Es gibt eine ungespeicherte Änderung. Trotzdem verlassen und verwerfen?");
}

window.addEventListener("beforeunload", (e) => {
  if (anyDirty()) { e.preventDefault(); e.returnValue = ""; }
});
