// Shared photo gallery for the note and place editors: show thumbnails, add
// (scaled down on the client, see photo.js), delete. The editors differ only in
// the reference id (noteId vs. besuchId — a "place" in the UI is a visit, see
// dataload.js).
//
// Photos can be chosen for a NEW, unsaved note or place too — but POST
// /api/photos needs an existing note_id/besuch_id (api/router.js), so uploading
// before the first save is impossible. Instead of disabling the add button (an
// earlier version, which looked like a bug), newly chosen photos are kept
// locally until saving ("pending", with an object URL for the preview) and
// uploaded afterwards through commitPending() — one step for the user, not two.
import { el, render, toast, $ } from "../dom.js";
import { photoUrl, uploadPhoto, deletePhoto } from "../api.js";
import { upsertPhoto, removePhoto } from "../state.js";
import { compressPhoto } from "./photo.js";
import { showPhotos } from "./photo-lightbox.js";

/**
 * @param {{galleryId: string, inputId: string, addBtnId: string}} cfg
 * @returns {{update(ref: {noteId?:string,besuchId?:string}|null, photos: object[]): void,
 *   commitPending(ref: {noteId?:string,besuchId?:string}): Promise<void>}}
 */
export function wirePhotoGallery({ galleryId, inputId, addBtnId }) {
  const input = $("#" + inputId);
  const addBtn = $("#" + addBtnId);
  let ref = null; // { noteId } | { besuchId } | null while not saved
  let photos = [];
  let pending = []; // { localId, blob, url, width, height } — chosen locally, not uploaded yet

  function releasePending() {
    for (const p of pending) URL.revokeObjectURL(p.url);
    pending = [];
  }

  function draw() {
    const box = $("#" + galleryId);
    if (!box) return;
    const slides = photos.map((p) => ({ url: photoUrl(p.id) }));
    render(box, [
      ...photos.map((p, i) => el("div.photo-thumb", {}, [
        el("img", { src: slides[i].url, loading: "lazy", alt: "", on: { click: () => showPhotos(slides, i) } }),
        el("button", {
          type: "button", "aria-label": "Foto löschen", text: "✕",
          on: { click: async () => {
            const before = photos.slice();
            photos = photos.filter((x) => x.id !== p.id);
            removePhoto(p.id);
            draw();
            try {
              await deletePhoto(p.id);
              toast("Foto gelöscht");
            } catch (err) {
              photos = before;
              upsertPhoto(p);
              draw();
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
            draw();
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
    const { blob, width, height } = await compressPhoto(file);

    if (!ref) {
      // Not saved yet — only keep it locally, see the comment at the top.
      pending.push({ localId: crypto.randomUUID(), blob, url: URL.createObjectURL(blob), width, height });
      draw();
      return;
    }

    const box = $("#" + galleryId);
    const placeholder = el("div.photo-thumb.uploading");
    box?.appendChild(placeholder);
    try {
      const takenAt = new Date().toISOString();
      const { id } = await uploadPhoto(blob, { ...ref, takenAt, width, height });
      const photo = { id, besuchId: ref.besuchId || null, noteId: ref.noteId || null, takenAt, width, height, lat: null, lon: null };
      photos.push(photo);
      upsertPhoto(photo);
      draw();
      toast("Foto hinzugefügt");
    } catch (err) {
      placeholder.remove();
      toast(err.message || "Foto konnte nicht hochgeladen werden");
    }
  });

  return {
    update(nextRef, nextPhotos) {
      releasePending(); // do not carry the object URLs of a discarded draft along
      ref = nextRef;
      photos = (nextPhotos || []).slice();
      if (addBtn) addBtn.hidden = false;
      draw();
    },
    /** Called after the first successful save of a new note or place: uploads
     * all photos kept so far. */
    async commitPending(savedRef) {
      if (!pending.length) return;
      ref = savedRef;
      const toUpload = pending;
      pending = [];
      for (const p of toUpload) {
        try {
          const takenAt = new Date().toISOString();
          const { id } = await uploadPhoto(p.blob, { ...savedRef, takenAt, width: p.width, height: p.height });
          const photo = { id, besuchId: savedRef.besuchId || null, noteId: savedRef.noteId || null, takenAt, width: p.width, height: p.height, lat: null, lon: null };
          photos.push(photo);
          upsertPhoto(photo);
        } catch (err) {
          toast(err.message || "Foto konnte nicht hochgeladen werden");
        } finally {
          URL.revokeObjectURL(p.url);
        }
      }
      draw();
    },
  };
}
