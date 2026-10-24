// Hell-/Dunkelmodus: "auto" folgt dem Gerät, "light"/"dark" erzwingt ihn.
// styles.css und die Karte (mapview.js) lesen dasselbe data-theme-Attribut.
export const THEMES = ["auto", "light", "dark"];

export const gueltigesTheme = (wert) => (THEMES.includes(wert) ? wert : "auto");

export function applyTheme(theme, root = document.documentElement) {
  const t = gueltigesTheme(theme);
  if (t === "auto") delete root.dataset.theme;
  else root.dataset.theme = t;
}
