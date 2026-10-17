// Gemeinsame Foto-Galerie für Notiz- und Ort-Editor: Miniaturen zeigen,
// hinzufügen (clientseitig verkleinert, siehe photo.js), löschen. Beide
// Editoren unterscheiden sich nur in der Bezugs-ID (noteId vs. besuchId —
// ein "Ort" in der Oberfläche ist technisch ein Besuch, siehe dataload.js).
//
// Fotos lassen sich auch bei einer NEUEN, noch ungespeicherten Notiz/einem
// neuen Ort schon auswählen — POST /api/photos verlangt aber zwingend eine
// bereits existierende note_id/besuch_id (api/router.js), ein Hochladen vor
// dem ersten Speichern ist also serverseitig gar nicht möglich. Statt den
// "Hinzufügen"-Knopf deshalb zu sperren (frühere Fassung — wirkte für
// Nutzer wie ein Bug), werden neu ausgewählte Fotos
// bis zum Speichern nur lokal vorgehalten ("pending", mit Objekt-URL für
// die Vorschau) und erst danach über commitPending() tatsächlich
// hochgeladen — ein Arbeitsschritt für den Nutzer statt zwei.
import { el, render, toast, $ } from "../dom.js";
import { photoUrl, uploadPhoto, deletePhoto } from "../api.js";
import { upsertPhoto, removePhoto } from "../state.js";
import { komprimiereFoto } from "./photo.js";
import { zeigeFoto } from "./photo-lightbox.js";

/**
 * @param {{galleryId: string, inputId: string, addBtnId: string}} cfg
 * @returns {{update(ref: {noteId?:string,besuchId?:string}|null, photos: object[]): void,
 *   commitPending(ref: {noteId?:string,besuchId?:string}): Promise<void>}}
 */
export function wirePhotoGallery({ galleryId, inputId, addBtnId }) {
  const input = $("#" + inputId);
  const addBtn = $("#" + addBtnId);
  let ref = null; // { noteId } | { besuchId } | null solange nicht gespeichert
  let photos = [];
  let pending = []; // { localId, blob, url, width, height } — lokal ausgewählt, noch nicht hochgeladen

  function freigebenPending() {
    for (const p of pending) URL.revokeObjectURL(p.url);
    pending = [];
  }

  function zeichne() {
    const box = $("#" + galleryId);
    if (!box) return;
    const echteSlides = photos.map((p) => ({ url: photoUrl(p.id) }));
    render(box, [
      ...photos.map((p, i) => el("div.photo-thumb", {}, [
        el("img", { src: echteSlides[i].url, loading: "lazy", alt: "", on: { click: () => zeigeFoto(echteSlides, i) } }),
        el("button", {
          type: "button", "aria-label": "Foto löschen", text: "✕",
          on: { click: async () => {
            const vorher = photos.slice();
            photos = photos.filter((x) => x.id !== p.id);
            removePhoto(p.id);
            zeichne();
            try {
              await deletePhoto(p.id);
              toast("Foto gelöscht");
            } catch (err) {
              photos = vorher;
              upsertPhoto(p);
              zeichne();
              toast(err.message || "Foto konnte nicht gelöscht werden");
            }
          } },
        }),
      ])),
      ...pending.map((p) => el("div.photo-thumb.pending", {}, [
        el("img", { src: p.url, loading: "lazy", alt: "" }),
        el("button", {
          type: "button", "aria-label": "Foto entfernen", text: "✕",
          on: { click: () => {
            URL.revokeObjectURL(p.url);
            pending = pending.filter((x) => x.localId !== p.localId);
            zeichne();
          } },
        }),
      ])),
    ]);
  }

  addBtn?.addEventListener("click", () => input.click());

  input?.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const { blob, width, height } = await komprimiereFoto(file);

    if (!ref) {
      // Noch nicht gespeichert — nur lokal vormerken, siehe Kopfkommentar.
      pending.push({ localId: crypto.randomUUID(), blob, url: URL.createObjectURL(blob), width, height });
      zeichne();
      return;
    }

    const box = $("#" + galleryId);
    const platzhalter = el("div.photo-thumb.uploading");
    box?.appendChild(platzhalter);
    try {
      const takenAt = new Date().toISOString();
      const { id } = await uploadPhoto(blob, { ...ref, takenAt, width, height });
      const photo = { id, besuchId: ref.besuchId || null, noteId: ref.noteId || null, takenAt, width, height, lat: null, lon: null };
      photos.push(photo);
      upsertPhoto(photo);
      zeichne();
      toast("Foto hinzugefügt");
    } catch (err) {
      platzhalter.remove();
      toast(err.message || "Foto konnte nicht hochgeladen werden");
    }
  });

  return {
    update(neueRef, neuePhotos) {
      freigebenPending(); // Objekt-URLs eines vorher offenen, verworfenen Entwurfs nicht mitschleppen
      ref = neueRef;
      photos = (neuePhotos || []).slice();
      if (addBtn) addBtn.hidden = false;
      zeichne();
    },
    /** Nach erfolgreichem Erst-Speichern einer neuen Notiz/eines neuen Ortes
     * aufgerufen: lädt alle vorgemerkten Fotos jetzt tatsächlich hoch. */
    async commitPending(neuerRef) {
      if (!pending.length) return;
      ref = neuerRef;
      const zuLaden = pending;
      pending = [];
      for (const p of zuLaden) {
        try {
          const takenAt = new Date().toISOString();
          const { id } = await uploadPhoto(p.blob, { ...neuerRef, takenAt, width: p.width, height: p.height });
          const photo = { id, besuchId: neuerRef.besuchId || null, noteId: neuerRef.noteId || null, takenAt, width: p.width, height: p.height, lat: null, lon: null };
          photos.push(photo);
          upsertPhoto(photo);
        } catch (err) {
          toast(err.message || "Foto konnte nicht hochgeladen werden");
        } finally {
          URL.revokeObjectURL(p.url);
        }
      }
      zeichne();
    },
  };
}
