// Bearbeiten eines Ortes (auch Übernachtungen). Änderungen gelten erst
// nach „Speichern"; beim Zurückgehen mit offenen Änderungen wird gefragt.
import { el, render, icon, toast, $ } from "../dom.js";
import { ICON } from "../icons.js";
import { state, trip, placePhotos } from "../state.js";
import { orteMitBesuchszahl } from "../dataload.js";
import { speichereOrt, loescheOrt, wetterZeile } from "../store.js";
import { wirePhotoGallery } from "../ui/photo-gallery.js";
import { isConfigured } from "../api.js";

const SOURCE_LABEL = { camper: "🚐 Camper", handy: "🚶 Handy", manuell: "📍 manuell" };

/** Wie weit war dieser Besuch in die Reiseroute hinein? Nimmt den
 * zeitlich nächsten Punkt der geladenen Route (falls schon geladen — die
 * Route wird sonst nur lazy nachgeladen, siehe ensureTripPath()) und
 * liest dessen bereits berechnete Kilometerstand. */
function kmAbStart(place) {
  const t = place.tripId ? trip(place.tripId) : null;
  const path = t?.path;
  const zielMs = Date.parse(place.at || "");
  if (!path?.length || !Number.isFinite(zielMs)) return null;
  let bester = null, besterAbstand = Infinity;
  for (const p of path) {
    const pMs = Date.parse(p.time || "");
    if (!Number.isFinite(pMs)) continue;
    const d = Math.abs(pMs - zielMs);
    if (d < besterAbstand) { besterAbstand = d; bester = p; }
  }
  return bester ? Math.round(bester.cum) : null;
}

const datumUhrzeit = (iso) => {
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
    if (!removed.isNew) await loescheOrt(removed.id);
    afterChange({ closed: true });
    if (removed.isNew) return; // nie gespeichert — nichts zum Zurückholen
    if (offerUndo) {
      offerUndo(`„${removed.title || "Ort"}" gelöscht`, async () => {
        await speichereOrt(removed, { neu: true });
        afterChange({ closed: true });
      });
    } else toast("Ort gelöscht");
  });
}

export function openPlaceEditor(place) {
  current = place;
  const naechte = Number.isInteger(place.nights) && place.nights > 0 ? place.nights : 1;
  draft = { catId: place.catId, stars: place.stars, nights: naechte };
  snapshot = { title: place.title, note: place.note, stars: place.stars, catId: place.catId, nights: naechte };

  $("#ef-title").value = place.title;
  $("#ef-note").value = place.note;
  renderCategoryPicker();
  drawStars();
  drawNights();

  // Oberste Zeile: nur noch der Titel (Nutzerwunsch, 6. September 2026 —
  // die vorherige Mischung aus links- und rechtsbündigen Feldern wirkte
  // unruhig). Quelle/Reise/km/Zeitpunkt stehen jetzt gesammelt, alle
  // linksbündig, in der eigenen Zeile darunter (#ef-meta).
  render($("#ef-src"), [el("b", { text: place.title })]);

  // Nur noch Reise + km — das Fahrzeug (SOURCE_LABEL) störte hier ohne
  // erkennbaren Nutzen (Nutzerwunsch, 6. September 2026); wird bei Bedarf
  // später an passenderer Stelle ergänzt. Datum/Uhrzeit steht in der
  // Wetter/Position-Zeile unten.
  const tripName = place.tripId && trip(place.tripId) ? trip(place.tripId).name : "Alltag";
  const km = kmAbStart(place);
  render($("#ef-meta"), [
    el("span", { text: (place.isNew ? "neu · " : "") + tripName }),
    km != null ? el("span", { text: `${km} km ab Start`, style: { color: "var(--ink-faint)" } }) : null,
  ]);

  // Wie oft war ich schon hier — über alle Reisen hinweg, echte Identität
  // über ortId (nicht nur an diesem einen Besuch abzulesen).
  const besuchsInfo = place.ortId ? orteMitBesuchszahl().get(place.ortId) : null;
  const mehrfach = besuchsInfo && besuchsInfo.besuche > 1;
  // Nächte nur erwähnen, wenn dort tatsächlich schon mal übernachtet wurde
  // — bei einem Ort, der nur als kurzer Stopp bekannt ist, wäre "insgesamt
  // 0 Nächte" irreführend (Nutzer-Fund, 6. September 2026).
  const naechteZusatz = besuchsInfo?.naechteGesamt
    ? `, insgesamt ${besuchsInfo.naechteGesamt} ${besuchsInfo.naechteGesamt === 1 ? "Nacht" : "Nächte"}`
    : "";
  render($("#ef-visits"), mehrfach ? [el("span", {
    text: `📍 schon ${besuchsInfo.besuche}× hier${naechteZusatz}`,
  })] : []);
  $("#ef-visits").hidden = !mehrfach;

  // Datum+Uhrzeit, Position und Wetter in einer Zeile, in dieser
  // Reihenfolge (Nutzerwunsch, 6. September 2026) — jedes mit eigenem
  // kleinen "Icon" wie beim Wetter (☀️/🌤️/…). Kein "automatisch
  // erkannt"-Symbol mehr hier — das steht stattdessen im Logbuch selbst
  // (journal.js), konsistent mit Übernachtungen dort, statt hier ein
  // zweites Mal. Die Zeile umbricht (flex-wrap, siehe .ef-src in
  // styles.css), bleibt also auch mit langer Adresse lesbar, und ist
  // immer sichtbar (nicht nur bei vorhandenem Wetter).
  const wetter = wetterZeile(place.weather);
  render($("#ef-weather"), [
    place.at ? el("span", { text: `📅 ${datumUhrzeit(place.at)}` }) : null,
    // Die rohen Koordinaten stehen nicht mehr offen da — antippen kopiert
    // sie in die Zwischenablage, das reicht für den seltenen Bedarf, sie
    // woanders einzufügen.
    el("span", {
      text: `📍 ${place.address || "Position"}`,
      style: { color: "var(--ink-soft)", cursor: "pointer", textDecoration: "underline dotted" },
      title: "Antippen, um die Koordinaten zu kopieren",
      on: { click: () => kopiereKoordinaten(place) },
    }),
    wetter ? el("span", { text: wetter }) : null,
  ]);
  $("#ef-weather").hidden = false;

  photoGallery?.update(place.isNew ? null : { besuchId: place.id }, place.isNew ? [] : placePhotos(place.id));
}

async function kopiereKoordinaten(place) {
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

/** Die Anzahl Nächte betrifft nur Übernachtungen — sonst bleibt das Feld verborgen. */
function drawNights() {
  const zeigen = draft.catId === "uebernachtung";
  $("#ef-nights-wrap").hidden = !zeigen;
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
  const neu = Boolean(current.isNew);
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
  // Erst sichern, dann schließen: Der lokale Teil von speichereOrt läuft
  // sofort, sonst zeichnete die Liste noch den alten Stand.
  const gesichert = speichereOrt(place, { neu });
  current = null;
  afterChange({ closed: true });
  gesichert.then((ok) => {
    if (!ok) return;
    toast("Ort gespeichert");
    // Siehe note-editor.js: erst jetzt existiert der Ort wirklich
    // serverseitig, vorher ausgewählte Fotos werden erst hier hochgeladen.
    if (neu && isConfigured()) photoGallery?.commitPending({ besuchId: place.id });
  });
}

export const clearEditor = () => { current = null; };
