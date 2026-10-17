// Teilen — echt statt behauptet.
//
// Bisher meldeten die Teilen-Knöpfe „Link kopiert", ohne etwas zu tun. Eine
// öffentlich lesbare Ansicht der eigenen Reisen gibt es (noch) nicht, deshalb
// wird geteilt, was ohne Server trägt: bei Orten ein Kartenlink auf die
// Koordinaten, bei Reisen eine kurze Zusammenfassung als Text.
import { toast } from "../dom.js";

const kartenLink = (lat, lon) =>
  `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=15/${lat.toFixed(5)}/${lon.toFixed(5)}`;

/** Gibt den Inhalt an das Teilen-Menü des Geräts oder in die Zwischenablage. */
async function teile({ title, text, url }) {
  if (navigator.share) {
    try {
      await navigator.share(url ? { title, text, url } : { title, text });
      return;
    } catch (err) {
      // Abbruch durch den Nutzer ist kein Fehler — dann still zurück.
      if (err?.name === "AbortError") return;
    }
  }
  const inhalt = [text, url].filter(Boolean).join("\n");
  try {
    await navigator.clipboard.writeText(inhalt);
    toast("In die Zwischenablage kopiert");
  } catch {
    toast("Teilen wird von diesem Browser nicht unterstützt");
  }
}

export function teileOrt(place) {
  const lat = Number(place.lat);
  const lon = Number(place.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    toast("Für diesen Ort fehlen die Koordinaten");
    return;
  }
  const url = kartenLink(lat, lon);
  return teile({ title: place.title || "Ort", text: place.title || "Ort", url });
}

export function teileReise(trip, { naechte = 0, orte = 0 } = {}) {
  const zeilen = [
    trip.name,
    trip.dates,
    `${trip.km.toLocaleString("de-DE")} km · ${naechte} Nächte · ${orte} Orte`,
    "— unterwegs mit VOJAĜO",
  ].filter(Boolean);
  return teile({ title: trip.name, text: zeilen.join("\n") });
}
