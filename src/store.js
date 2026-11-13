// Making changes to places, notes and diary entries permanent.
//
// Show locally first (the app stays quick), then save centrally — and if saving
// fails, the display is taken back. Nothing should be on screen that is not
// stored anywhere. Messages are UI text and stay German.
import { state, newId, upsertPlace, removePlace, upsertNote, removeNote, upsertDiaryEntry, removeDiaryEntry, emit } from "./state.js";
import { toast } from "./dom.js";
import { findExistingPlace, AUTO_PLACE_PLACEHOLDER_TITLES } from "./dataload.js";
import {
  isConfigured, createPlace, updatePlace, deletePlace,
  createNote, updateNote, deleteNote, saveDiaryEntry, deleteDiaryEntry, weather as fetchWeather, geocode as fetchGeocode,
} from "./api.js";

/** Only when connected is there a central store. */
export const isCentral = () => !state.config.demo && isConfigured();

/* ---------- Translation into the database shape ---------- */

// tripId is not sent — like for drives, the trip is computed from occurred_at
// (see api/router.js and tripAt() in src/dataload.js).
const placeToRow = (p) => ({
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

const noteToRow = (n) => ({
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

/* ---------- Places ---------- */

export async function storePlace(place, { isNew = false } = {}) {
  const previous = state.places.find((p) => p.id === place.id) || null;
  upsertPlace(place);
  if (!isCentral()) return true;

  try {
    if (isNew) {
      // Look across all trips whether this place exists already — then attach
      // the visit there instead of creating a second, unlinked place (so "how
      // often was I here" is right for places entered by hand too).
      const ortId = findExistingPlace({ lat: Number(place.lat), lon: Number(place.lon), catId: place.catId });
      const answer = await createPlace({ ...placeToRow(place), ...(ortId ? { ort_id: ortId } : {}) });
      if (answer?.ort_id) upsertPlace({ ...place, ortId: answer.ort_id });
    } else {
      await updatePlace(place.id, placeToRow(place));
    }
    if (isNew) addWeather("place", place);
    return true;
  } catch (err) {
    if (previous) upsertPlace(previous); else removePlace(place.id);
    toast(`Nicht gespeichert: ${err.message}`);
    return false;
  }
}

export async function dropPlace(id) {
  const previous = state.places.find((p) => p.id === id) || null;
  removePlace(id);
  if (!isCentral()) return true;
  try {
    await deletePlace(id);
    return true;
  } catch (err) {
    if (previous) upsertPlace(previous);
    toast(`Nicht gelöscht: ${err.message}`);
    return false;
  }
}

/* ---------- Notes ---------- */

export async function storeNote(note, { isNew = false } = {}) {
  const previous = state.notes.find((n) => n.id === note.id) || null;
  upsertNote(note);
  if (!isCentral()) return true;

  try {
    if (isNew) await createNote(noteToRow(note));
    else await updateNote(note.id, noteToRow(note));
    if (isNew) addWeather("note", note);
    return true;
  } catch (err) {
    if (previous) upsertNote(previous); else removeNote(note.id);
    toast(`Nicht gespeichert: ${err.message}`);
    return false;
  }
}

export async function dropNote(id) {
  const previous = state.notes.find((n) => n.id === id) || null;
  removeNote(id);
  if (!isCentral()) return true;
  try {
    await deleteNote(id);
    return true;
  } catch (err) {
    if (previous) upsertNote(previous);
    toast(`Nicht gelöscht: ${err.message}`);
    return false;
  }
}

/* ---------- Diary ---------- */

/**
 * Save a diary entry (create or overwrite — there is exactly one per trip and
 * day). Returns { ok, id }.
 */
export async function storeDiaryEntry(entry) {
  const previous = state.diary.find((e) => e.tripId === entry.tripId && e.dayKey === entry.dayKey) || null;
  if (!isCentral()) {
    const id = previous?.id || entry.id || newId("tag");
    upsertDiaryEntry({ ...entry, id });
    return { ok: true, id };
  }
  try {
    const answer = await saveDiaryEntry({ trip_id: entry.tripId, day_key: entry.dayKey, blocks: entry.blocks });
    const now = new Date().toISOString();
    upsertDiaryEntry({
      ...entry, id: answer.id,
      author: previous?.author || state.account?.username || entry.author || "",
      createdAt: previous?.createdAt || now, updatedAt: now,
    });
    return { ok: true, id: answer.id };
  } catch (err) {
    toast(`Nicht gespeichert: ${err.message}`);
    return { ok: false, id: null };
  }
}

export async function dropDiaryEntry(id) {
  const previous = state.diary.find((e) => e.id === id) || null;
  const photos = state.photos.filter((p) => p.tagebuchId === id);
  removeDiaryEntry(id);
  if (!isCentral()) return true;
  try {
    await deleteDiaryEntry(id);
    return true;
  } catch (err) {
    if (previous) { upsertDiaryEntry(previous); state.photos.push(...photos); emit("photos"); }
    toast(`Nicht gelöscht: ${err.message}`);
    return false;
  }
}

/* ---------- Weather ---------- */

/**
 * Loads the weather for a place and time and attaches it to the entry. Done
 * afterwards on purpose: saving must not depend on a weather service answering.
 * If it fails, the entry simply stays without weather. `kind`: "place" | "note".
 */
export async function addWeather(kind, entry) {
  if (!isCentral()) return null;
  const lat = Number(entry.lat);
  const lon = Number(entry.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  try {
    const weather = await fetchWeather(lat, lon, entry.at);
    const raw = JSON.stringify(weather);
    if (kind === "place") {
      await updatePlace(entry.id, { weather: raw });
      const p = state.places.find((x) => x.id === entry.id);
      if (p) { p.weather = weather; emit("places"); }
    } else {
      await updateNote(entry.id, { weather: raw });
      const n = state.notes.find((x) => x.id === entry.id);
      if (n) { n.weather = weather; emit("notes"); }
    }
    return weather;
  } catch {
    return null; // without weather the entry is still complete
  }
}

/* ---------- Name suggestion (reverse geocoding) ---------- */

/**
 * Adds a name suggestion to an automatically created place (overnight stay or
 * stop without a known address) afterwards — like addWeather(), deliberately
 * AFTER creating it and without making creation depend on it: if the naming
 * service fails, the placeholder title stays, editable as always.
 *
 * The address is ALWAYS kept (its own `address` field, apart from the title) —
 * the title itself is only replaced while it is still one of the generic
 * placeholders in AUTO_PLACE_PLACEHOLDER_TITLES. If the person renamed it in the
 * meantime, the title stays but the address is kept as a reference (requested
 * 6 September 2026). The CURRENT state in state.places is checked (not the one
 * passed in), so a quick manual rename is not overwritten by a late answer.
 */
export async function addPlaceName({ id, lat, lon }) {
  if (!isCentral()) return null;
  const la = Number(lat), lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;

  try {
    const { name } = await fetchGeocode(la, lo);
    if (!name) return null;
    const current = state.places.find((p) => p.id === id);
    if (!current) return null;
    const patch = { address: name };
    if (AUTO_PLACE_PLACEHOLDER_TITLES.includes(current.title)) patch.title = name;
    await updatePlace(id, patch);
    Object.assign(current, patch);
    emit("places");
    return name;
  } catch {
    return null; // without a suggestion the placeholder title stays
  }
}

/** Short form for display: "🌤️ 21 °C · wechselnd bewölkt". */
export function weatherLine(weather) {
  if (!weather || weather.temp == null) return "";
  const temp = `${String(weather.temp).replace(".", ",")} °C`;
  return `${weather.symbol || "🌡️"} ${temp}${weather.text ? ` · ${weather.text}` : ""}`;
}
