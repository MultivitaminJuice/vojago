// Sharing a place or a trip through the device's share menu (or the clipboard):
// a place as a map link to its coordinates, a trip as a short text summary.
// Read-only links to trips are created elsewhere (Settings → Reisen teilen).
// The texts are UI and stay German.
import { toast } from "../dom.js";

const mapLink = (lat, lon) =>
  `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=15/${lat.toFixed(5)}/${lon.toFixed(5)}`;

/** Hands the content to the device's share menu or to the clipboard. */
async function share({ title, text, url }) {
  if (navigator.share) {
    try {
      await navigator.share(url ? { title, text, url } : { title, text });
      return;
    } catch (err) {
      // Cancelled by the user is not an error — then return quietly.
      if (err?.name === "AbortError") return;
    }
  }
  const content = [text, url].filter(Boolean).join("\n");
  try {
    await navigator.clipboard.writeText(content);
    toast("In die Zwischenablage kopiert");
  } catch {
    toast("Teilen wird von diesem Browser nicht unterstützt");
  }
}

export function sharePlace(place) {
  const lat = Number(place.lat);
  const lon = Number(place.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    toast("Für diesen Ort fehlen die Koordinaten");
    return;
  }
  const url = mapLink(lat, lon);
  return share({ title: place.title || "Ort", text: place.title || "Ort", url });
}

export function shareTrip(trip, { nights = 0, places = 0 } = {}) {
  const lines = [
    trip.name,
    trip.dates,
    `${trip.km.toLocaleString("de-DE")} km · ${nights} Nächte · ${places} Orte`,
    "— unterwegs mit VOJAĜO",
  ].filter(Boolean);
  return share({ title: trip.name, text: lines.join("\n") });
}
