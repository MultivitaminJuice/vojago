// Seitliche Detail-Ansichten mit Schutz vor ungewolltem Verwerfen.
// Wer mit ungespeicherten Änderungen zurückgeht, wird gefragt.
import { $ } from "../dom.js";

export function createSheet({ id, confirmId, isDirty = () => false, onSave, onClose }) {
  const sheet = $("#" + id);
  const bar = confirmId ? $("#" + confirmId) : null;

  const close = () => {
    bar?.classList.remove("show");
    sheet.classList.remove("show");
    onClose?.();
  };

  const requestClose = () => {
    if (isDirty() && bar) bar.classList.add("show");
    else close();
  };

  bar?.querySelector(".discard")?.addEventListener("click", close);
  bar?.querySelector(".save")?.addEventListener("click", () => { onSave?.(); close(); });

  return {
    element: sheet,
    open() { bar?.classList.remove("show"); sheet.classList.add("show"); },
    close,
    requestClose,
    isOpen: () => sheet.classList.contains("show"),
    isDirty,
  };
}

/** Escape schließt die oberste offene Ansicht. */
export function wireEscape(sheets) {
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (document.activeElement?.matches("input, textarea, select")) return;
    const open = sheets.filter((s) => s.isOpen());
    if (open.length) { e.preventDefault(); open[open.length - 1].requestClose(); }
  });
}
