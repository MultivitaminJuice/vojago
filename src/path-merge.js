import { distanceKm } from "./geo.js";

/**
 * Hängt neu eingetroffene Routenpunkte an einen vorhandenen Pfad an, statt
 * die ganze Route (bei einer 6-Tage-Reise 13,7 MB) erneut zu laden. `neu` ist
 * ein frisch aus Positionen gebauter Pfad (cum/day ab 0 bzw. 1) — hier wird
 * nur übernommen, was zeitlich NACH dem letzten bekannten Punkt liegt, und
 * der Kilometerstand fortgeführt (inklusive Weg vom letzten alten zum ersten
 * neuen Punkt). Gibt den unveränderten `alt`-Pfad zurück, wenn nichts Neues dabei ist.
 */
export function haengeNeuePunkteAn(alt, neu) {
  if (!Array.isArray(alt) || !alt.length) return Array.isArray(neu) ? neu : [];
  const letzterMs = Date.parse(alt[alt.length - 1].time || "");
  const frisch = (neu || []).filter((p) => Date.parse(p.time || "") > letzterMs);
  if (!frisch.length) return alt;
  const letzter = alt[alt.length - 1];
  const start = frisch[0];
  const versatz = (letzter.cum || 0) + distanceKm(letzter.lon, letzter.lat, start.lon, start.lat) - (start.cum || 0);
  return alt.concat(frisch.map((p) => ({ ...p, cum: (p.cum || 0) + versatz })));
}
