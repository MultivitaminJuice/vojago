/** "gerade eben" / "vor 12 min" / "vor 5 Std" / "vor 3 Tagen" für einen
 * Zeitpunkt — Statuspille (main.js) und Wache-Infokarte (views/guard.js)
 * zeigen dasselbe Alter derselben GPS-Meldung. */
export function liveAlterText(iso) {
  const zeit = Date.parse(iso || "");
  if (!Number.isFinite(zeit)) return "ohne GPS";
  const sekunden = Math.max(0, Math.round((Date.now() - zeit) / 1000));
  if (sekunden < 60) return "gerade eben";
  const minuten = Math.round(sekunden / 60);
  if (minuten < 60) return `vor ${minuten} min`;
  const stunden = Math.round(minuten / 60);
  if (stunden < 48) return `vor ${stunden} Std`;
  const tage = Math.round(stunden / 24);
  return `vor ${tage} Tagen`;
}
