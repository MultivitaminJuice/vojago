// Light/dark mode: "auto" follows the device, "light"/"dark" forces it.
// styles.css and the map (mapview.js) read the same data-theme attribute.
export const THEMES = ["auto", "light", "dark"];

export const validTheme = (value) => (THEMES.includes(value) ? value : "auto");

export function applyTheme(theme, root = document.documentElement) {
  const t = validTheme(theme);
  if (t === "auto") delete root.dataset.theme;
  else root.dataset.theme = t;
}
