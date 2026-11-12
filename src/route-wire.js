// Wire format of a route. The server sends a thinned route as compact arrays
// (api/lib.js: compactRoute); the rest of the app works with position objects
// (latitude, longitude, altitude, speed in knots, fixTime). This module turns
// one into the other, and passes the older object list through unchanged.
const KNOTS_PER_KMH = 1 / 1.852;

/** @returns {Array<{latitude:number, longitude:number, altitude:number, speed:number, fixTime:string}>} */
export function decodeRoute(data) {
  if (Array.isArray(data)) return data;
  if (!data || !Array.isArray(data.points)) return [];
  return data.points.map(([at, lat, lon, altitude, kmh]) => ({
    latitude: lat,
    longitude: lon,
    altitude,
    speed: kmh * KNOTS_PER_KMH,
    fixTime: new Date(at).toISOString(),
  }));
}
