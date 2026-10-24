// Darstellungswerte der Karte (rein, ohne MapLibre — dadurch testbar).
//
// Kartenstil (Einstellungen → Darstellung): "farbig" = CARTO Voyager (Wasser blau,
// Wälder und Parks grün, deutliche Straßen), "dezent" = CARTO Positron (neutral grau).
export const KARTENSTILE = ["farbig", "dezent"];
export const gueltigerKartenstil = (wert) => (KARTENSTILE.includes(wert) ? wert : "farbig");

export const kachelUrl = (stil, schluessel) => {
  const pfad = gueltigerKartenstil(stil) === "dezent" ? "light_all" : "rastertiles/voyager";
  return `https://a.basemaps.cartocdn.com/${pfad}/{z}/{x}/{y}@2x.png?key=${schluessel}`;
};

// Dunkelmodus: nicht die fast schwarze CARTO-Kachel "dark_all" (Straßen und
// Namen kaum lesbar, Aufhellen per Raster-Filter brachte wenig), sondern die
// helle Kachel, abgedunkelt: dunkler Grund, Beschriftung bleibt klar. Beim
// farbigen Stil bleibt die Sättigung, damit Wasser und Wald erkennbar bleiben.
export const kachelPaint = (dark, stil = "farbig") => (dark
  ? (gueltigerKartenstil(stil) === "dezent"
    ? { "raster-brightness-max": 0.5, "raster-brightness-min": 0, "raster-contrast": 0.25, "raster-saturation": -0.2 }
    : { "raster-brightness-max": 0.48, "raster-brightness-min": 0, "raster-contrast": 0.25, "raster-saturation": 0.3 })
  : { "raster-brightness-max": 1, "raster-brightness-min": 0, "raster-contrast": 0, "raster-saturation": 0 });

// Geländeschummerung (Höhenmodell AWS Terrain Tiles, frei nutzbar, ohne Schlüssel).
export const schummerungPaint = (dark) => (dark
  ? { "hillshade-exaggeration": 0.4, "hillshade-shadow-color": "#000000", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#444444" }
  : { "hillshade-exaggeration": 0.28, "hillshade-shadow-color": "#2f3d38", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#5a6b64" });

export const HOEHEN_KACHELN = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png";
export const HOEHEN_QUELLE = '© <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>';
