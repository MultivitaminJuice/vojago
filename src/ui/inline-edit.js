// Inline renaming with explicit saving (Enter or ✓). Escape explicitly
// discards. Saving automatically when leaving the field was tried and dropped
// (it felt like "it just saves without asking") — instead dirty-guard.js warns
// before a view change while something here is unsaved.
import { toast } from "../dom.js";
import { trackDirty } from "./dirty-guard.js";

export function wireInlineEdit(input, saveButton, getCurrent, apply) {
  // Seen 17 August 2026: a completely emptied field never counted as "changed"
  // (meant as protection against saving it empty), so neither the save tick nor
  // the dirty-guard warning appeared — deleting a device id or category name and
  // navigating away gave no feedback that the deletion was discarded. Now an
  // emptied field counts as changed, and commit() rejects saving it empty with
  // a clear message.
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
