/** "gerade eben" / "vor 12 min" / "vor 5 Std" / "vor 3 Tagen" for a point in
 * time — the status pill (main.js) and the guard info card (views/guard.js)
 * show the same age of the same GPS report. The texts are UI and stay German. */
export function liveAgeText(iso) {
  const time = Date.parse(iso || "");
  if (!Number.isFinite(time)) return "ohne GPS";
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return "gerade eben";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `vor ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `vor ${hours} Std`;
  const days = Math.round(hours / 24);
  return `vor ${days} Tagen`;
}
