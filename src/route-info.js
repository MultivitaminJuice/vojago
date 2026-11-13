// Rows for More → Status → Route: when and how the route was last updated.
// Display only; gets the log from dataload.js (routeLoadLog). Labels are UI and stay German.
const clockTime = (ms) => new Date(ms).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function routeInfoRows({ success, failure, fromCache } = {}, clock = clockTime) {
  const rows = [];
  if (success) {
    rows.push(["Zuletzt aktualisiert", clock(success.time)]);
    rows.push(["Art", success.kind === "new"
      ? `nur Neues (+${success.newPoints} Punkte)`
      : success.kind === "unchanged"
        ? "geprüft, unverändert"
        : `komplett (${success.received} Punkte)`]);
    rows.push(["Punkte insgesamt", String(success.total)]);
    rows.push(["Dauer", `${(success.durationMs / 1000).toFixed(1)} s${success.background ? " (im Hintergrund)" : ""}`]);
  } else {
    rows.push(["Zuletzt aktualisiert", fromCache ? "noch nicht — Zwischenspeicher" : "—"]);
  }
  if (failure && (!success || failure.time > success.time)) {
    rows.push(["Letzter Fehlversuch", `${clock(failure.time)} — ${failure.error}${failure.inARow > 1 ? ` (${failure.inARow}× in Folge)` : ""}`]);
  }
  return rows;
}
