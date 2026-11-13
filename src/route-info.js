// Rows for More → Status → Route: when and how the route was last updated.
// Display only; gets the log from dataload.js (routenAbruf). Labels are UI and stay German.
const clockTime = (ms) => new Date(ms).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function routeInfoRows({ erfolg, fehler, zwischenspeicher } = {}, clock = clockTime) {
  const rows = [];
  if (erfolg) {
    rows.push(["Zuletzt aktualisiert", clock(erfolg.zeit)]);
    rows.push(["Art", erfolg.art === "nur Neues"
      ? `nur Neues (+${erfolg.neuePunkte} Punkte)`
      : erfolg.art === "unverändert"
        ? "geprüft, unverändert"
        : `komplett (${erfolg.empfangen} Punkte)`]);
    rows.push(["Punkte insgesamt", String(erfolg.gesamt)]);
    rows.push(["Dauer", `${(erfolg.dauerMs / 1000).toFixed(1)} s${erfolg.hintergrund ? " (im Hintergrund)" : ""}`]);
  } else {
    rows.push(["Zuletzt aktualisiert", zwischenspeicher ? "noch nicht — Zwischenspeicher" : "—"]);
  }
  if (fehler && (!erfolg || fehler.zeit > erfolg.zeit)) {
    rows.push(["Letzter Fehlversuch", `${clock(fehler.zeit)} — ${fehler.fehler}${fehler.inFolge > 1 ? ` (${fehler.inFolge}× in Folge)` : ""}`]);
  }
  return rows;
}
