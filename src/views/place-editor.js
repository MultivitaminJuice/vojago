// Editing a place (overnight stays too). Changes apply only after "Speichern";
// going back with open changes asks first. UI texts stay German.
import { el, render, icon, toast, $ } from "../dom.js";
import { ICON } from "../icons.js";
import { state, trip, placePhotos } from "../state.js";
import { placesWithVisitCount } from "../dataload.js";
import { storePlace, dropPlace, weatherLine } from "../store.js";
import { wirePhotoGallery } from "../ui/photo-gallery.js";
import { isConfigured } from "../api.js";

const SOURCE_LABEL = { camper: "🚐 Camper", handy: "🚶 Handy", manuell: "📍 manuell" };

/** How far into the trip's route was this visit? Takes the route point nearest
 * in time (if the route is loaded — otherwise it is loaded lazily, see
 * ensureTripPath()) and reads its distance. */
function kmFromStart(place) {
  const t = place.tripId ? trip(place.tripId) : null;
  const path = t?.path;
  const targetMs = Date.parse(place.at || "");
  if (!path?.length || !Number.isFinite(targetMs)) return null;
  let best = null, bestGap = Infinity;
  for (const p of path) {
    const pMs = Date.parse(p.time || "");
    if (!Number.isFinite(pMs)) continue;
    const d = Math.abs(pMs - targetMs);
    if (d < bestGap) { bestGap = d; best = p; }
  }
  return best ? Math.round(best.cum) : null;
}

const dateTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
};

let current = null;
let snapshot = null;
let draft = { catId: "stellplatz", stars: 5, nights: 1 };
let afterChange = () => {};
let offerUndo = null;
let onShowOnMap = null;
let photoGallery = null;

export function initPlaceEditor({ onChange, onUndoOffer, onShowOnMap: showOnMap }) {
  afterChange = onChange;
  offerUndo = onUndoOffer;
  onShowOnMap = showOnMap || null;
  render($("#ef-show-map"), [icon(ICON.map, 15), "Auf Karte zeigen"]);
  $("#ef-show-map").addEventListener("click", () => { if (current) onShowOnMap?.(current); });
  photoGallery = wirePhotoGallery({
    galleryId: "ef-photos", inputId: "ef-photo-input", addBtnId: "ef-photo-add",
  });

  $("#ef-stars").addEventListener("click", (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    draft.stars = Math.max(1, Math.min(5, Math.ceil((e.clientX - rect.left) / (rect.width / 5))));
    drawStars();
  });

  $("#ef-nights-minus").addEventListener("click", () => { draft.nights = Math.max(1, draft.nights - 1); drawNights(); });
  $("#ef-nights-plus").addEventListener("click", () => { draft.nights = Math.min(60, draft.nights + 1); drawNights(); });

  $("#edit-save").addEventListener("click", () => save());
  $("#edit-delete").addEventListener("click", async () => {
    if (!current) return;
    const removed = { ...current };
    current = null;
    if (!removed.isNew) await dropPlace(removed.id);
    afterChange({ closed: true });
    if (removed.isNew) return; // never saved — nothing to bring back
    if (offerUndo) {
      offerUndo(`„${removed.title || "Ort"}" gelöscht`, async () => {
        await storePlace(removed, { isNew: true });
        afterChange({ closed: true });
      });
    } else toast("Ort gelöscht");
  });
}

export function openPlaceEditor(place) {
  current = place;
  const nights = Number.isInteger(place.nights) && place.nights > 0 ? place.nights : 1;
  draft = { catId: place.catId, stars: place.stars, nights };
  snapshot = { title: place.title, note: place.note, stars: place.stars, catId: place.catId, nights };

  $("#ef-title").value = place.title;
  $("#ef-note").value = place.note;
  renderCategoryPicker();
  drawStars();
  drawNights();

  // Top line: only the title (requested 6 September 2026 — the earlier mix of
  // left and right aligned fields looked restless). Trip and km follow in their
  // own left-aligned line below (#ef-meta).
  render($("#ef-src"), [el("b", { text: place.title })]);

  // Only trip and km — the vehicle (SOURCE_LABEL) got in the way here without a
  // clear use (requested 6 September 2026). Date and time are in the
  // weather/position line below.
  const tripName = place.tripId && trip(place.tripId) ? trip(place.tripId).name : "Alltag";
  const km = kmFromStart(place);
  render($("#ef-meta"), [
    el("span", { text: (place.isNew ? "neu · " : "") + tripName }),
    km != null ? el("span", { text: `${km} km ab Start`, style: { color: "var(--ink-faint)" } }) : null,
  ]);

  // How often was I here — across all trips, real identity through ortId.
  const visitInfo = place.ortId ? placesWithVisitCount().get(place.ortId) : null;
  const repeated = visitInfo && visitInfo.visits > 1;
  // Only mention nights when someone actually slept there — for a place known
  // only as a short stop, "0 nights in total" would mislead (6 September 2026).
  const nightsNote = visitInfo?.totalNights
    ? `, insgesamt ${visitInfo.totalNights} ${visitInfo.totalNights === 1 ? "Nacht" : "Nächte"}`
    : "";
  render($("#ef-visits"), repeated ? [el("span", {
    text: `📍 schon ${visitInfo.visits}× hier${nightsNote}`,
  })] : []);
  $("#ef-visits").hidden = !repeated;

  // Date and time, position and weather in one line, in this order (requested
  // 6 September 2026), each with its own small icon. The "detected
  // automatically" symbol is shown in the logbook (journal.js) instead. The line
  // wraps (flex-wrap, see .ef-src in styles.css), so it stays readable with a
  // long address, and it is always visible.
  const weather = weatherLine(place.weather);
  render($("#ef-weather"), [
    place.at ? el("span", { text: `📅 ${dateTime(place.at)}` }) : null,
    // The raw coordinates are not shown — tapping copies them to the clipboard,
    // enough for the rare need to paste them elsewhere.
    el("span", {
      text: `📍 ${place.address || "Position"}`,
      style: { color: "var(--ink-soft)", cursor: "pointer", textDecoration: "underline dotted" },
      title: "Antippen, um die Koordinaten zu kopieren",
      on: { click: () => copyCoordinates(place) },
    }),
    weather ? el("span", { text: weather }) : null,
  ]);
  $("#ef-weather").hidden = false;

  photoGallery?.update(place.isNew ? null : { besuchId: place.id }, place.isNew ? [] : placePhotos(place.id));
}

async function copyCoordinates(place) {
  const text = `${place.lat.toFixed(6)}, ${place.lon.toFixed(6)}`;
  try {
    await navigator.clipboard.writeText(text);
    toast("Koordinaten kopiert");
  } catch {
    toast("Kopieren wird von diesem Browser nicht unterstützt");
  }
}

export function renderCategoryPicker() {
  render($("#ef-cats"), Object.entries(state.categories).map(([id, cat]) => {
    const btn = el("button", {
      dataset: { cat: id },
      "aria-pressed": String(id === draft.catId),
      on: { click: () => {
        draft.catId = id;
        Array.from($("#ef-cats").children).forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.cat === id)));
        drawNights();
      } },
    }, [el("i", { style: { background: cat.color } }), cat.name]);
    return btn;
  }));
}

const drawStars = () => { $("#ef-stars").textContent = "★".repeat(draft.stars) + "☆".repeat(5 - draft.stars); };

/** The number of nights only applies to overnight stays — otherwise the field stays hidden. */
function drawNights() {
  const show = draft.catId === "uebernachtung";
  $("#ef-nights-wrap").hidden = !show;
  $("#ef-nights-val").textContent = String(draft.nights);
}

export function isDirty() {
  if (!current) return false;
  if (current.isNew) return true;
  return $("#ef-title").value !== snapshot.title
      || $("#ef-note").value !== snapshot.note
      || draft.stars !== snapshot.stars
      || draft.catId !== snapshot.catId
      || (draft.catId === "uebernachtung" && draft.nights !== snapshot.nights);
}

export function save() {
  if (!current) return;
  const isNew = Boolean(current.isNew);
  const place = {
    ...current,
    title: $("#ef-title").value.trim() || "(ohne Titel)",
    note: $("#ef-note").value,
    stars: draft.stars,
    catId: draft.catId,
    nights: draft.catId === "uebernachtung" ? draft.nights : 1,
    at: current.at || new Date().toISOString(),
  };
  delete place.isNew;
  // Save first, then close: the local part of storePlace runs at once,
  // otherwise the list would still draw the old state.
  const saved = storePlace(place, { isNew });
  current = null;
  afterChange({ closed: true });
  saved.then((ok) => {
    if (!ok) return;
    toast("Ort gespeichert");
    // See note-editor.js: only now does the place exist on the server; photos
    // chosen earlier are uploaded here.
    if (isNew && isConfigured()) photoGallery?.commitPending({ besuchId: place.id });
  });
}

export const clearEditor = () => { current = null; };
