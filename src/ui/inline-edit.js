// Inline-Umbenennen mit ausdrücklichem Speichern (Enter oder ✓). Escape
// verwirft ausdrücklich. Automatisches Speichern beim bloßen Verlassen des
// Feldes wurde ausprobiert und wieder verworfen (fühlte sich nach "spiechert
// einfach, ohne gefragt zu haben" an) — stattdessen warnt dirty-guard.js vor
// einem Ansichtswechsel, solange hier etwas offen/ungespeichert ist.
import { toast } from "../dom.js";
import { trackDirty } from "./dirty-guard.js";

export function wireInlineEdit(input, saveButton, getCurrent, apply) {
  // Echter Fund (17. August 2026): Ein komplett geleertes Feld zählte hier
  // bisher NIE als "geändert" (`v !== ""` schloss es aus) — gedacht als
  // Schutz gegen versehentliches Leer-Speichern, aber mit der Nebenwirkung,
  // dass weder der Speichern-Haken erschien noch dirty-guard.js (nutzt
  // dieselbe dirty()-Prüfung) beim Verlassen der Seite warnte. Wer die
  // Geräte-ID/den Kategorie-Namen löschte und wegnavigierte, bekam also gar
  // keine Rückmeldung, dass die Löschung verworfen wird. Jetzt: Leeren zählt
  // als geändert (Warnung erscheint korrekt), commit() weist den Versuch,
  // leer zu speichern, stattdessen mit einer klaren Meldung zurück.
  const dirty = () => input.value.trim() !== getCurrent();
  const refresh = () => saveButton.classList.toggle("show", dirty());
  const commit = () => {
    if (!dirty()) return;
    const v = input.value.trim();
    if (!v) { toast("Darf nicht leer sein"); return; }
    apply(v);
    refresh();
    toast("Gespeichert");
  };

  input.addEventListener("input", refresh);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { input.value = getCurrent(); refresh(); input.blur(); }
  });
  saveButton.addEventListener("click", commit);
  trackDirty(dirty, input);
  refresh();
  return { isDirty: dirty, commit };
}
