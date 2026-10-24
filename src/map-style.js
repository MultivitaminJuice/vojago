// Darstellungswerte der Karte (rein, ohne MapLibre — dadurch testbar).
//
// Dunkelmodus: nicht die fast schwarze CARTO-Kachel "dark_all" (Straßen und
// Namen kaum lesbar, Aufhellen per Raster-Filter brachte wenig), sondern die
// helle Kachel, abgedunkelt: dunkelgrauer Grund, Beschriftung bleibt klar.
export const kachelPaint = (dark) => (dark
  ? { "raster-brightness-max": 0.5, "raster-brightness-min": 0, "raster-contrast": 0.25, "raster-saturation": -0.2 }
  : { "raster-brightness-max": 1, "raster-brightness-min": 0, "raster-contrast": 0, "raster-saturation": 0 });

// Geländeschummerung (Höhenmodell AWS Terrain Tiles, frei nutzbar, ohne Schlüssel).
export const schummerungPaint = (dark) => (dark
  ? { "hillshade-exaggeration": 0.4, "hillshade-shadow-color": "#000000", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#444444" }
  : { "hillshade-exaggeration": 0.28, "hillshade-shadow-color": "#2f3d38", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#5a6b64" });

export const HOEHEN_KACHELN = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png";
export const HOEHEN_QUELLE = '© <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>';
