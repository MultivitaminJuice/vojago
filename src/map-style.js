// Display values of the map (pure, without MapLibre — so they can be tested).
//
// CARTO needs a (free) API key for the tiles. It is not in the repository but set
// from CARTO_API_KEY at build time (see scripts/build-site.mjs and README); after
// that it is visible in the tile addresses, which is what it is meant for.
export const CARTO_KEY = typeof __CARTO_API_KEY__ === "string" ? __CARTO_API_KEY__ : "";

// Map style (Settings → Appearance): "farbig" = CARTO Voyager (blue water, green
// woods and parks, clear roads), "dezent" = CARTO Positron (neutral grey).
// The values are stored settings and stay German.
export const MAP_STYLES = ["farbig", "dezent"];
export const validMapStyle = (value) => (MAP_STYLES.includes(value) ? value : "farbig");

export const tileUrl = (style, key) => {
  const path = validMapStyle(style) === "dezent" ? "light_all" : "rastertiles/voyager";
  return `https://a.basemaps.cartocdn.com/${path}/{z}/{x}/{y}@2x.png?key=${key}`;
};

// Dark mode: not the almost black CARTO tile "dark_all" (roads and names hardly
// readable, brightening it with a raster filter did little) but the light tile,
// darkened: a dark ground with clear labels. The colourful style keeps its
// saturation so water and woods stay recognisable.
export const tilePaint = (dark, style = "farbig") => (dark
  ? (validMapStyle(style) === "dezent"
    ? { "raster-brightness-max": 0.5, "raster-brightness-min": 0, "raster-contrast": 0.25, "raster-saturation": -0.2 }
    : { "raster-brightness-max": 0.48, "raster-brightness-min": 0, "raster-contrast": 0.25, "raster-saturation": 0.3 })
  : { "raster-brightness-max": 1, "raster-brightness-min": 0, "raster-contrast": 0, "raster-saturation": 0 });

// Terrain shading (AWS Terrain Tiles elevation model, free to use, no key).
export const hillshadePaint = (dark) => (dark
  ? { "hillshade-exaggeration": 0.4, "hillshade-shadow-color": "#000000", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#444444" }
  : { "hillshade-exaggeration": 0.28, "hillshade-shadow-color": "#2f3d38", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#5a6b64" });

export const ELEVATION_TILES = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png";
export const ELEVATION_ATTRIBUTION = '© <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>';
