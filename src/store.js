// Änderungen an Orten und Notizen dauerhaft machen.
//
// Bisher fehlte genau diese Schicht: Die Oberfläche änderte nur den Speicher
// im Browser, beim nächsten Start war alles weg. Hier gilt jetzt:
// erst lokal zeigen (die App bleibt flott), dann zentral sichern — und wenn
// das Sichern scheitert, wird die Anzeige zurückgenommen. Nichts soll auf dem
// Bildschirm stehen, was nirgends gespeichert ist.
import { state, upsertPlace, removePlace, upsertNote, removeNote, emit } from "./state.js";
import { toast } from "./dom.js";
import { findeVorhandenenOrt, AUTO_ORT_PLATZHALTER_TITEL } from "./dataload.js";
import {
  isConfigured, createPlace, updatePlace, deletePlace,
  createNote, updateNote, deleteNote, weather as fetchWeather, geocode as fetchGeocode,
} from "./api.js";

/** Nur im verbundenen Betrieb gibt es eine zentrale Ablage. */
export const zentral = () => !state.config.demo && isConfigured();

/* ---------- Übersetzung in die Form der Datenbank ---------- */

// tripId wird nicht mehr mitgeschickt — Reise-Zugehörigkeit wird wie bei
// Fahrten live aus occurred_at berechnet (siehe api/router.js, src/dataload.js
// zugehoerigeReise). `night` war schon vorher ungenutzt (siehe altes
// Schema-Kommentar) und ist beim Orte/Besuche-Umbau ganz entfallen.
const ortZuRoh = (p) => ({
  id: p.id,
  title: p.title || "(ohne Titel)",
  note: p.note || "",
  category_id: p.catId || null,
  rating: Number.isInteger(p.stars) ? p.stars : null,
  lat: Number(p.lat),
  lon: Number(p.lon),
  source: ["camper", "handy", "manuell"].includes(p.source) ? p.source : "manuell",
  kind: p.catId === "uebernachtung" ? "auto" : "manual",
  occurred_at: p.at || null,
  nights: Number.isInteger(p.nights) && p.nights > 0 ? p.nights : 1,
  weather: p.weather ? JSON.stringify(p.weather) : null,
  stop_key: p.stopKey || null,
});

const notizZuRoh = (n) => ({
  id: n.id,
  besuch_id: n.besuchId || null,
  title: n.title,
  text: n.text,
  occurred_at: n.at || null,
  lat: n.lat == null ? null : Number(n.lat),
  lon: n.lon == null ? null : Number(n.lon),
  source: ["camper", "handy", "manuell"].includes(n.source) ? n.source : "handy",
  weather: n.weather ? JSON.stringify(n.weather) : null,
});

/* ---------- Orte ---------- */

export async function speichereOrt(place, { neu = false } = {}) {
  const vorher = state.places.find((p) => p.id === place.id) || null;
  upsertPlace(place);
  if (!zentral()) return true;

  try {
    if (neu) {
      // Über alle Reisen hinweg nachsehen, ob es diesen Ort schon gibt —
      // dann den Besuch dort anhängen statt einen unverknüpften zweiten
      // Ort anzulegen (damit "wie oft war ich hier" auch bei manuell
      // erfassten Orten stimmt, nicht nur bei automatisch erkannten).
      const ortId = findeVorhandenenOrt({ lat: Number(place.lat), lon: Number(place.lon), catId: place.catId });
      const antwort = await createPlace({ ...ortZuRoh(place), ...(ortId ? { ort_id: ortId } : {}) });
      if (antwort?.ort_id) upsertPlace({ ...place, ortId: antwort.ort_id });
    } else {
      await updatePlace(place.id, ortZuRoh(place));
    }
    if (neu) ergaenzeWetter("ort", place);
    return true;
  } catch (err) {
    if (vorher) upsertPlace(vorher); else removePlace(place.id);
    toast(`Nicht gespeichert: ${err.message}`);
    return false;
  }
}

export async function loescheOrt(id) {
  const vorher = state.places.find((p) => p.id === id) || null;
  removePlace(id);
  if (!zentral()) return true;
  try {
    await deletePlace(id);
    return true;
  } catch (err) {
    if (vorher) upsertPlace(vorher);
    toast(`Nicht gelöscht: ${err.message}`);
    return false;
  }
}

/* ---------- Notizen ---------- */

export async function speichereNotiz(note, { neu = false } = {}) {
  const vorher = state.notes.find((n) => n.id === note.id) || null;
  upsertNote(note);
  if (!zentral()) return true;

  try {
    if (neu) await createNote(notizZuRoh(note));
    else await updateNote(note.id, notizZuRoh(note));
    if (neu) ergaenzeWetter("notiz", note);
    return true;
  } catch (err) {
    if (vorher) upsertNote(vorher); else removeNote(note.id);
    toast(`Nicht gespeichert: ${err.message}`);
    return false;
  }
}

export async function loescheNotiz(id) {
  const vorher = state.notes.find((n) => n.id === id) || null;
  removeNote(id);
  if (!zentral()) return true;
  try {
    await deleteNote(id);
    return true;
  } catch (err) {
    if (vorher) upsertNote(vorher);
    toast(`Nicht gelöscht: ${err.message}`);
    return false;
  }
}

/* ---------- Wetter ---------- */

/**
 * Holt das Wetter zu Ort und Zeitpunkt und hängt es an den Eintrag. Bewusst
 * nachgelagert: Das Speichern soll nicht davon abhängen, ob ein Wetterdienst
 * gerade antwortet. Klappt es nicht, bleibt der Eintrag einfach ohne Wetter.
 */
export async function ergaenzeWetter(art, eintrag) {
  if (!zentral()) return null;
  const lat = Number(eintrag.lat);
  const lon = Number(eintrag.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  try {
    const wetter = await fetchWeather(lat, lon, eintrag.at);
    const roh = JSON.stringify(wetter);
    if (art === "ort") {
      await updatePlace(eintrag.id, { weather: roh });
      const p = state.places.find((x) => x.id === eintrag.id);
      if (p) { p.weather = wetter; emit("places"); }
    } else {
      await updateNote(eintrag.id, { weather: roh });
      const n = state.notes.find((x) => x.id === eintrag.id);
      if (n) { n.weather = wetter; emit("notes"); }
    }
    return wetter;
  } catch {
    return null; // ohne Wetter ist der Eintrag trotzdem vollständig
  }
}

/* ---------- Namensvorschlag (Reverse-Geocoding) ---------- */

/**
 * Ergänzt nachträglich einen Namensvorschlag für einen automatisch
 * angelegten Ort (Übernachtung/Stopp ohne bekannte Adresse) — wie
 * ergaenzeWetter() bewusst NACH dem Anlegen und ohne das Anlegen selbst
 * davon abhängig zu machen: klappt der Namensdienst nicht, bleibt der
 * Platzhaltertitel einfach stehen, änderbar wie eh und je im Editor.
 *
 * Die ermittelte Adresse wird IMMER festgehalten (eigenes `address`-Feld,
 * getrennt vom Titel) — der Titel selbst nur ersetzt, solange dort noch
 * einer der generischen Platzhalter aus AUTO_ORT_PLATZHALTER_TITEL steht.
 * Hat die Person zwischenzeitlich selbst umbenannt, bleibt der Titel
 * unangetastet, aber die Adresse bleibt trotzdem als Referenz erhalten
 * (Nutzerwunsch, 6. September 2026 — vorher ging die Original-Adresse
 * beim Umbenennen komplett verloren). Geprüft wird der AKTUELLE Stand in
 * state.places (nicht der bei Aufruf übergebene), damit eine schnelle
 * manuelle Umbenennung nicht durch die erst später eintreffende
 * Namensvorschlag-Antwort überschrieben wird.
 */
export async function ergaenzeOrtsname({ id, lat, lon }) {
  if (!zentral()) return null;
  const la = Number(lat), lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;

  try {
    const { name } = await fetchGeocode(la, lo);
    if (!name) return null;
    const aktuell = state.places.find((p) => p.id === id);
    if (!aktuell) return null;
    const patch = { address: name };
    if (AUTO_ORT_PLATZHALTER_TITEL.includes(aktuell.title)) patch.title = name;
    await updatePlace(id, patch);
    Object.assign(aktuell, patch);
    emit("places");
    return name;
  } catch {
    return null; // ohne Namensvorschlag bleibt der Platzhaltertitel stehen
  }
}

/** Kurzform fürs Anzeigen: „🌤️ 21 °C · wechselnd bewölkt". */
export function wetterZeile(wetter) {
  if (!wetter || wetter.temp == null) return "";
  const temp = `${String(wetter.temp).replace(".", ",")} °C`;
  return `${wetter.symbol || "🌡️"} ${temp}${wetter.text ? ` · ${wetter.text}` : ""}`;
}
