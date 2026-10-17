// Notiz erfassen und bearbeiten. Der Text steht im Mittelpunkt; Standort und
// Zeitpunkt werden beim Erfassen automatisch festgehalten, die Zuordnung zu
// einem Ort kann jederzeit nachgeholt werden.
import { el, render, toast, $ } from "../dom.js";
import { state, newId, tripPlaces, notePhotos } from "../state.js";
import { speichereNotiz, loescheNotiz, wetterZeile } from "../store.js";
import { wirePhotoGallery } from "../ui/photo-gallery.js";
import { isConfigured } from "../api.js";

let current = null;
let snapshot = { title: "", text: "", besuchId: "" };
let afterChange = () => {};
let offerUndo = null;
let openSheet = () => {};
let photoGallery = null;

const titleFromText = (text) => {
  const clean = String(text || "").trim().replace(/\s+/g, " ");
  if (!clean) return "";
  return clean.length > 48 ? `${clean.slice(0, 47).trim()}…` : clean;
};

export function initNoteEditor({ onChange, onUndoOffer, onOpen }) {
  afterChange = onChange;
  offerUndo = onUndoOffer;
  openSheet = onOpen || (() => {});
  photoGallery = wirePhotoGallery({
    galleryId: "note-photos", inputId: "note-photo-input", addBtnId: "note-photo-add",
  });

  $("#note-save").addEventListener("click", () => save());

  $("#note-delete").addEventListener("click", async () => {
    if (!current) return;
    const removed = { ...current };
    const wasNew = removed.isNew;
    current = null;
    if (!wasNew) await loescheNotiz(removed.id);
    afterChange();
    if (wasNew) return;
    if (offerUndo) {
      offerUndo("Notiz gelöscht", async () => {
        await speichereNotiz(removed, { neu: true });
        afterChange();
      });
    } else toast("Notiz gelöscht");
  });
}

/** Neue Notiz am aktuellen Gerätestandort beginnen. */
export function captureNote({ fallbackCenter }) {
  const begin = (lon, lat, hinweis) => {
    openNoteEditor({
      id: newId("note"), tripId: state.activeTripId, besuchId: null,
      title: "", text: "", at: new Date().toISOString(), lon, lat, source: "handy", isNew: true,
    });
    if (hinweis) toast(hinweis);
  };

  if (navigator.geolocation) {
    toast("Standort wird ermittelt …");
    navigator.geolocation.getCurrentPosition(
      (pos) => begin(pos.coords.longitude, pos.coords.latitude, "Standort übernommen"),
      () => { const c = fallbackCenter(); begin(c.lng, c.lat, "Kein Gerätestandort – Kartenmitte übernommen"); },
      { enableHighAccuracy: true, timeout: 8000 }
    );
    return;
  }
  const c = fallbackCenter();
  begin(c.lng, c.lat, "Kartenmitte übernommen");
}

export function openNoteEditor(note) {
  current = note;
  const title = note.title || titleFromText(note.text);
  snapshot = { title, text: note.text || "", besuchId: note.besuchId || "" };
  openSheet();

  $("#note-title").value = title;
  $("#note-text").value = note.text || "";

  const when = new Date(note.at);
  render($("#note-meta"), [
    el("span", { text: note.source === "handy" ? "🚶 Handy" : "📍 manuell" }),
    el("span", {
      text: Number.isNaN(when.getTime()) ? "" : when.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
      style: { color: "var(--ink-faint)", fontFamily: "var(--font-mono)", fontSize: "11px" },
    }),
    el("span", {
      text: `${Number(note.lat).toFixed(4)}, ${Number(note.lon).toFixed(4)}`,
      style: { marginLeft: "auto", color: "var(--ink-faint)", fontFamily: "var(--font-mono)", fontSize: "11px" },
    }),
    note.weather ? el("span", { text: wetterZeile(note.weather), style: { flexBasis: "100%", color: "var(--ink-soft)" } }) : null,
  ]);

  const select = $("#note-place");
  render(select, [
    el("option", { value: "", text: "— keinem Ort zugeordnet —" }),
    ...tripPlaces(note.tripId).map((p) => el("option", { value: p.id, text: p.title })),
  ]);
  select.value = note.besuchId || "";

  photoGallery?.update(note.isNew ? null : { noteId: note.id }, note.isNew ? [] : notePhotos(note.id));
}

export const isDirty = () => Boolean(current) && (
  $("#note-title").value !== snapshot.title
  || $("#note-text").value !== snapshot.text
  || ($("#note-place").value || "") !== snapshot.besuchId
  || Boolean(current.isNew)
);

export function save() {
  if (!current) return;
  const neu = Boolean(current.isNew);
  const note = {
    ...current,
    title: $("#note-title").value.trim(),
    text: $("#note-text").value.trim(),
    besuchId: $("#note-place").value || null,
  };
  delete note.isNew;
  if (!note.title) { toast("Titel fehlt"); return; }
  if (!note.text) { toast("Notiz ist leer – nicht gespeichert"); current = null; afterChange(); return; }
  // Erst sichern, dann schließen (siehe place-editor.js).
  // Das Wetter zum Zeitpunkt wird danach nachgetragen (siehe store.js).
  const gesichert = speichereNotiz(note, { neu });
  current = null;
  afterChange();
  gesichert.then((ok) => {
    if (!ok) return;
    toast("Notiz gespeichert");
    // Erst jetzt existiert die Notiz wirklich serverseitig — vorher beim
    // Anlegen ausgewählte Fotos (siehe photo-gallery.js) werden erst hier
    // tatsächlich hochgeladen. Ohne echten Server (Demo/nicht angemeldet)
    // gäbe es ohnehin keinen Fotospeicher dafür.
    if (neu && isConfigured()) photoGallery?.commitPending({ noteId: note.id });
  });
}

export const clearEditor = () => { current = null; };
