// Text für Mehr → Status → Route: wann und wie die Route zuletzt aktualisiert
// wurde. Rein darstellend, bekommt das Protokoll aus dataload.js (routenAbruf).
const uhrzeit = (ms) => new Date(ms).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function routenInfoZeilen({ erfolg, fehler, zwischenspeicher } = {}, uhr = uhrzeit) {
  const zeilen = [];
  if (erfolg) {
    zeilen.push(["Zuletzt aktualisiert", uhr(erfolg.zeit)]);
    zeilen.push(["Art", erfolg.art === "nur Neues"
      ? `nur Neues (+${erfolg.neuePunkte} Punkte)`
      : `komplett (${erfolg.empfangen} Punkte)`]);
    zeilen.push(["Punkte insgesamt", String(erfolg.gesamt)]);
    zeilen.push(["Dauer", `${(erfolg.dauerMs / 1000).toFixed(1)} s${erfolg.hintergrund ? " (im Hintergrund)" : ""}`]);
  } else {
    zeilen.push(["Zuletzt aktualisiert", zwischenspeicher ? "noch nicht — Zwischenspeicher" : "—"]);
  }
  if (fehler && (!erfolg || fehler.zeit > erfolg.zeit)) {
    zeilen.push(["Letzter Fehlversuch", `${uhr(fehler.zeit)} — ${fehler.fehler}${fehler.inFolge > 1 ? ` (${fehler.inFolge}× in Folge)` : ""}`]);
  }
  return zeilen;
}
