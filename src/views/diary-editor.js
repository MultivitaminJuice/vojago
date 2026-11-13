// "Tag erzählen" (tell the day): one diary entry per trip and calendar day —
// paragraphs and photos in the order they are told. Made for writing on an
// iPhone, also afterwards: the day can be chosen, the draft is kept on the device
// as you type, photos are uploaded as soon as they are chosen. The file is
// diary-editor.js; markup ids and CSS classes still use "tag-". UI texts stay German.
import { el, render, toast, $ } from "../dom.js";
import { state, trip, diaryEntryFor, diaryPhotos, upsertPhoto, removePhoto } from "../state.js";
import { storeDiaryEntry, dropDiaryEntry, isCentral } from "../store.js";
import { photoUrl, uploadPhoto, deletePhoto } from "../api.js";
import { compressPhoto } from "../ui/photo.js";
import { localDayKey } from "../day-utils.js";
import { draggable } from "../drag.js";
import {
  cleanBlocks, hasContent, allPhotoIds, daysForEditor, defaultDay, photoDayHint,
  trayPhotos, normalizeBlocks, removePhotoFromBlocks, placePhoto,
} from "../diary.js";

let current = null;       // { tripId, dayKey, id|null }
let blocks = [];          // working state: [{t:"text",text} | {t:"fotos",ids}]
let days = [];            // days of the trip to choose from
let snapshot = "";        // saved state (cleaned, as JSON) — for "unsaved?"
let afterChange = () => {};
let openSheet = () => {};
let draftTimer = null;
let uploadsRunning = 0;

const draftKey = (tripId, dayKey) => `vojago.tagebuch.entwurf.${tripId}.${dayKey}`;
const readJson = (key) => { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; } };
const writeJson = (key, wert) => { try { wert == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(wert)); } catch { /* Speicher voll/blockiert */ } };

const dayLabel = (t, now, written) => {
  const d = new Date(`${t.key}T12:00:00`);
  const today = localDayKey(now.toISOString());
  const yesterday = localDayKey(new Date(now.getTime() - 86400000).toISOString());
  const weekday = d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
  const suffix = t.key === today ? " · heute" : t.key === yesterday ? " · gestern" : "";
  const doneMark = written.has(t.key) ? " ✓" : "";
  return `Tag ${t.number} · ${weekday}${suffix}${doneMark}`;
};

export function initDiaryEditor({ onChange, onOpen }) {
  afterChange = onChange;
  openSheet = onOpen || (() => {});

  $("#tag-save").addEventListener("click", () => save());
  $("#tag-day").addEventListener("change", (e) => switchDay(e.target.value));
  $("#tag-photo-input").addEventListener("change", photosChosen);
  // A photo can never be dropped as text: the system's image drag would otherwise write its address into a paragraph.
  const blockForeignDrop = (e) => { const t = [...(e.dataTransfer?.types || [])]; if (t.some((x) => x === "Files" || x === "text/uri-list" || x === "text/html")) e.preventDefault(); };
  $("#tag-blocks").addEventListener("dragover", blockForeignDrop);
  $("#tag-blocks").addEventListener("drop", blockForeignDrop);

  let deleteArmed = null;
  $("#tag-delete").addEventListener("click", async (e) => {
    const button = e.currentTarget;
    if (!current?.id) return;
    // Two steps instead of a confirm dialog: first "Wirklich löschen?", then delete.
    if (!deleteArmed) {
      button.textContent = "Wirklich löschen?";
      deleteArmed = setTimeout(() => { deleteArmed = null; button.textContent = "Eintrag löschen"; }, 4000);
      return;
    }
    clearTimeout(deleteArmed);
    deleteArmed = null;
    button.textContent = "Eintrag löschen";
    const { tripId, dayKey, id } = current;
    writeJson(draftKey(tripId, dayKey), null);
    current = null;
    await dropDiaryEntry(id);
    afterChange();
    toast("Eintrag gelöscht");
  });
}

/** Open "Tag erzählen". Without `dayKey` the app suggests the obvious day. */
export function openDiaryEditor({ tripId, dayKey = null }) {
  const t = trip(tripId);
  if (!t) { toast("Für diese Ansicht gibt es kein Tagebuch"); return; }
  const now = new Date();
  const entries = state.diary.filter((e) => e.tripId === tripId);
  days = daysForEditor(t, { now: now, extraKeys: entries.map((e) => e.dayKey) });
  const chosen = dayKey && days.some((x) => x.key === dayKey)
    ? dayKey
    : defaultDay(days, new Set(entries.map((e) => e.dayKey)), now);
  openSheet();
  const written = new Set(entries.map((e) => e.dayKey));
  render($("#tag-day"), days.map((x) => el("option", { value: x.key, text: dayLabel(x, now, written) })));
  load(tripId, chosen);
}

function load(tripId, dayKey) {
  const entry = diaryEntryFor(tripId, dayKey);
  current = { tripId, dayKey, id: entry?.id || null };
  deleteQuestion = null;
  $("#tag-day").value = dayKey;
  const copyBlocks = (liste) => JSON.parse(JSON.stringify(liste));
  let start = entry ? copyBlocks(entry.blocks) : [];
  snapshot = JSON.stringify(cleanBlocks(normalizeBlocks(start)));

  const draft = readJson(draftKey(tripId, dayKey));
  const savedAt = Date.parse(String(entry?.updatedAt || "").replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(entry?.updatedAt || "") ? "" : "Z")) || 0;
  let status = "";
  if (draft?.blocks && draft.ts > savedAt && JSON.stringify(cleanBlocks(draft.blocks)) !== snapshot) {
    start = copyBlocks(draft.blocks);
    status = "Entwurf wiederhergestellt";
  }
  blocks = normalizeBlocks(start);
  $("#tag-delete").hidden = !current.id;
  $("#tag-day-hint").textContent = "";
  setStatus(status);
  draw();
}

function switchDay(newDay) {
  if (!current || newDay === current.dayKey) return;
  saveDraft(true);
  load(current.tripId, newDay);
}

const setStatus = (text) => { const e = $("#tag-status"); if (e) e.textContent = text || ""; };

function saveDraft(sofort = false) {
  if (!current) return;
  const now = () => {
    const target = draftKey(current.tripId, current.dayKey);
    const currentJson = JSON.stringify(cleanBlocks(blocks));
    if (currentJson === snapshot) { writeJson(target, null); return; }
    writeJson(target, { blocks: cleanBlocks(blocks), ts: Date.now() });
    const chars = cleanBlocks(blocks).reduce((n, b) => n + (b.t === "text" ? b.text.length : 0), 0);
    setStatus(`Entwurf gespeichert · ${chars} Zeichen`);
  };
  clearTimeout(draftTimer);
  if (sofort) now(); else draftTimer = setTimeout(now, 500);
}

function grow(field) {
  field.style.height = "auto";
  field.style.height = `${Math.max(field.scrollHeight, 56)}px`;
}

// The paragraph written in last and the cursor position in it: photos that are tapped land there.
let activeSpot = { block: null, offset: 0 };
// The drawn blocks (for finding the target while dragging): { block, root, field?, group? }
let rows = [];
let drag = null;
let deleteQuestion = null;   // tray photo currently asking "delete for good?"

const photoIds = () => (current?.id ? diaryPhotos(current.id).map((p) => p.id) : []);

function draw() {
  const box = $("#tag-blocks");
  if (!box) return;
  const node = [];
  rows = [];
  blocks.forEach((b, i) => {
    if (b.t === "text") {
      const field = el("textarea.tag-text", {
        rows: i === 0 ? 3 : 1, "aria-label": i === 0 ? "Was war heute los?" : "Weiter erzählen",
        placeholder: i === 0 ? "Was war los? Wo wart ihr, was habt ihr gesehen?" : "Weiter …",
      });
      field.value = b.text;
      const rememberSpot = () => { activeSpot = { block: b, offset: field.selectionStart ?? field.value.length }; };
      field.addEventListener("input", () => { b.text = field.value; grow(field); saveDraft(); rememberSpot(); });
      for (const evt of ["focus", "click", "keyup", "select"]) field.addEventListener(evt, rememberSpot);
      queueMicrotask(() => grow(field));
      const root = el("div.tag-block", {}, [field]);
      rows.push({ block: i, root, field });
      node.push(root);
    } else {
      const root = el("div.tag-fotos", {}, b.ids.map((id) => {
        const thumb = el("div.photo-thumb", { dataset: { id } }, [
          el("img", { src: photoUrl(id), loading: "lazy", alt: "", draggable: false }),
          // Take it out of the text, do not delete: the photo moves to the tray.
          el("button", { type: "button", "aria-label": "Aus dem Text nehmen", text: "✕", on: { click: (e) => { e.stopPropagation(); changeBlocks(removePhotoFromBlocks(blocks, id)); } } }),
        ]);
        makePhotoDraggable(thumb, id, "text");
        return thumb;
      }));
      rows.push({ block: i, root, group: true });
      node.push(root);
    }
  });

  const tray = current?.id ? trayPhotos(blocks, photoIds()) : [];
  node.push(el("div.tag-leiste", {}, [
    el("div.tag-leiste-knoepfe", {}, [
      el("button.tag-add", { type: "button", text: "📷 Fotos wählen", on: { click: choosePhotos } }),
    ]),
    tray.includes(deleteQuestion) ? deleteDialog(deleteQuestion)
      : tray.length ? el("div.tag-ablage", {}, [
        el("small.tag-hinweis", { text: "Antippen: an den Cursor · Halten und ziehen: an eine Stelle" }),
        el("div.tag-ablage-reihe", {}, tray.map(trayPhoto)),
      ]) : null,
  ]));
  render(box, node);
}

/** Question before deleting for good: large, with the photo, so nothing disappears by accident. */
function deleteDialog(id) {
  const close = () => { deleteQuestion = null; draw(); };
  return el("div.tag-loeschen", { role: "alertdialog", "aria-label": "Foto löschen?" }, [
    el("div.tag-loeschen-kopf", {}, [
      el("img", { src: photoUrl(id), alt: "" }),
      el("div", {}, [el("b", { text: "Foto endgültig löschen?" }), el("span", { text: "Es verschwindet auch aus dem Konto und lässt sich nicht zurückholen." })]),
    ]),
    el("div.tag-loeschen-knoepfe", {}, [
      el("button", { type: "button", text: "Abbrechen", on: { click: close } }),
      el("button.gefahr", { type: "button", text: "Löschen", on: { click: () => { deleteQuestion = null; deletePhotoForGood(id); } } }),
    ]),
  ]);
}

/** A tray photo: tapping places it at the cursor, holding and dragging puts it anywhere. */
function trayPhoto(id) {
  // Gone for good — so only after the question (see deleteQuestion in draw).
  const deleteButton = el("button", { type: "button", "aria-label": "Foto löschen", text: "✕", on: { click: (e) => {
    e.stopPropagation();
    deleteQuestion = id;
    draw();
  } } });
  const thumb = el("div.photo-thumb.klein", { dataset: { id }, on: { click: () => placeAtCursor(id) } }, [
    el("img", { src: photoUrl(id), loading: "lazy", alt: "", draggable: false }),
    deleteButton,
  ]);
  makePhotoDraggable(thumb, id, "ablage");
  return thumb;
}

function changeBlocks(neu) {
  blocks = neu;
  saveDraft(true);
  draw();
}

/** Tapping in the tray: where you wrote last (in the middle of a sentence the paragraph is split). */
function placeAtCursor(id) {
  const texts = blocks.filter((x) => x.t === "text");
  const target = blocks.includes(activeSpot.block) ? activeSpot.block : texts[texts.length - 1];
  const i = blocks.indexOf(target);
  const offset = target === activeSpot.block ? Math.min(activeSpot.offset, target.text.length) : target.text.length;
  if (!target.text.trim() || offset === 0) changeBlocks(placePhoto(blocks, id, { kind: "between", index: i }));
  else if (offset >= target.text.length) changeBlocks(placePhoto(blocks, id, { kind: "between", index: i + 1 }));
  else changeBlocks(placePhoto(blocks, id, { kind: "text", block: i, from: offset, to: offset }));
}

/* ---------- Ziehen: Fotos an eine Stelle im Text setzen oder zurück in die Ablage ---------- */

function makePhotoDraggable(node, id, origin) {
  draggable(node, {
    start: (pos) => dragStart(node, id, origin, pos),
    move: (pos) => { if (drag) { drag.pos = pos; dragShow(); } },
    end: (pos) => dragEnd(pos),
    cancel: () => dragCancel(),
  });
}

/**
 * Possible cut points in an input field: every line and paragraph break of the
 * text (not the automatic wrap at the end of a line). Measured on an invisible
 * copy of the field; y is the distance of the cut line from the top of the field.
 */
function measureLines(field, text) {
  if (!text.trim()) return [];
  const css = getComputedStyle(field);
  const mirror = document.createElement("div");
  mirror.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;left:-9999px;top:0;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box;width:${field.clientWidth + parseFloat(css.borderLeftWidth) + parseFloat(css.borderRightWidth)}px;font:${css.font};letter-spacing:${css.letterSpacing};line-height:${css.lineHeight};padding:${css.padding};border:${css.border}`;
  document.body.appendChild(mirror);
  const lineHeight = parseFloat(css.lineHeight) || parseFloat(css.fontSize) * 1.5;
  const topPad = parseFloat(css.paddingTop) + parseFloat(css.borderTopWidth);
  const bottomPad = parseFloat(css.paddingBottom) + parseFloat(css.borderBottomWidth);
  const linesOf = (t) => { mirror.textContent = t; return Math.round((mirror.offsetHeight - topPad - bottomPad) / lineHeight); };
  const totalLines = linesOf(text);
  const cuts = new Map();
  for (let k = 1; k < totalLines; k++) {
    // The longest piece of text that still fits into k lines ends at the end of line k.
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (linesOf(text.slice(0, mid)) <= k) lo = mid; else hi = mid - 1;
    }
    let i = lo;
    if (i < text.length && !/\s/.test(text[i])) {            // in the middle of a word: back to the word boundary
      const w = text.slice(0, i).search(/\s\S*$/);
      if (w < 0) continue;
      i = w;
    }
    const from = text.slice(0, i).replace(/\s+$/, "").length;
    const rest = text.slice(i);
    const to = i + (rest.length - rest.replace(/^\s+/, "").length);
    if (from <= 0 || to >= text.length) continue;
    // Only real line and paragraph breaks are insertion points, not every wrap.
    if (!text.slice(from, to).includes("\n")) continue;
    const y = topPad + k * lineHeight;
    const existing = cuts.get(`${from}:${to}`);
    if (existing) existing.ys.push(y); else cuts.set(`${from}:${to}`, { from, to, ys: [y] });
  }
  mirror.remove();
  // A blank line gives two lines with the same cut: the marker goes in the middle.
  return [...cuts.values()].map(({ from, to, ys }) => ({ from, to, y: ys.reduce((a, b) => a + b, 0) / ys.length }));
}

function dragStart(sourceNode, id, origin, pos) {
  if (drag) return;
  const ghost = el("div.tag-geist", {}, [el("img", { src: photoUrl(id), alt: "" })]);
  const marker = el("div.tag-marke", { hidden: true });
  document.body.append(ghost, marker);
  sourceNode.classList.add("zieht");
  document.body.classList.add("tag-zieht");
  drag = {
    id, origin, sourceNode, ghost, marker, pos, target: null,
    splits: new Map(rows.filter((z) => z.field).map((z) => [z.block, measureLines(z.field, blocks[z.block].text)])),
    raf: requestAnimationFrame(dragTick),
    start: performance.now(), edgeSince: 0,
  };
  // While dragging nothing else should scroll; the editor scrolls itself at the edges.
  const sheetBody = $("#tag-blocks")?.closest(".sheet-body");
  if (sheetBody) { drag.sheetBody = sheetBody; drag.overflow = sheetBody.style.overflowY; sheetBody.style.overflowY = "hidden"; }
  dragShow();
}

/**
 * Every animation frame: scroll slowly at the edges (only after a short dwell, so a
 * target near the edge does not run away) and find the target again, because the
 * content moves.
 */
function dragTick(now = performance.now()) {
  if (!drag) return;
  const sheetBody = drag.sheetBody;
  const trayBar = $(".tag-leiste")?.getBoundingClientRect();
  if (sheetBody && trayBar) {
    const k = sheetBody.getBoundingClientRect();
    const RAND = 56;
    const topPad = drag.pos.y - k.top;
    const bottomPad = (trayBar.top - 4) - drag.pos.y;
    const direction = topPad < RAND ? -1 : bottomPad < RAND && bottomPad > 0 ? 1 : 0;
    if (!direction) drag.edgeSince = 0;
    else {
      drag.edgeSince ||= now;
      if (now - drag.edgeSince > 350) {
        const near = direction < 0 ? RAND - Math.max(topPad, 0) : RAND - bottomPad;
        sheetBody.scrollTop += direction * Math.max(1, Math.ceil((near / RAND) * 7));
      }
    }
  }
  dragShow();
  drag.raf = requestAnimationFrame(dragTick);
}

/** The target under the finger. Returns { kind, ... } like `placePhoto`, or { kind: "tray" }, or null. */
function dragTarget(pos) {
  const trayBar = $(".tag-leiste")?.getBoundingClientRect();
  if (trayBar && pos.y >= trayBar.top - 2) return drag.origin === "text" ? { kind: "tray" } : null;

  // Over a photo group: sort in between its photos.
  for (const z of rows) {
    if (!z.group) continue;
    const r = z.root.getBoundingClientRect();
    if (pos.y < r.top - 4 || pos.y > r.bottom + 4) continue;
    const thumbs = [...z.root.querySelectorAll(".photo-thumb")];
    const rowHeight = thumbs[0]?.getBoundingClientRect().height || 72;
    let index = 0;
    thumbs.forEach((t, k) => {
      const tr = t.getBoundingClientRect();
      const midY = tr.top + tr.height / 2;
      const before = midY + rowHeight / 2 < pos.y || (Math.abs(midY - pos.y) <= rowHeight / 2 && tr.left + tr.width / 2 < pos.x);
      if (before) index = k + 1;
    });
    const refRect = thumbs[Math.min(index, thumbs.length - 1)]?.getBoundingClientRect();
    return {
      kind: "group", block: z.block, index,
      line: refRect ? { x: index < thumbs.length ? refRect.left - 4 : refRect.right + 3, y: refRect.top, h: refRect.height, vertical: true } : null,
    };
  }

  // Otherwise the nearest seam: between two blocks or at a line break in the text.
  let best = null;
  const consider = (y, target, x0, breite) => {
    const d = Math.abs(y - pos.y);
    if (!best || d < best.d) best = { d, target: { ...target, line: { x: x0, y, w: breite } } };
  };
  rows.forEach((z, k) => {
    const r = z.root.getBoundingClientRect();
    if (k === 0) consider(r.top, { kind: "between", index: z.block }, r.left, r.width);
    const next = rows[k + 1];
    if (next) consider((r.bottom + next.root.getBoundingClientRect().top) / 2, { kind: "between", index: next.block }, r.left, r.width);
    else consider(r.bottom, { kind: "between", index: z.block + 1 }, r.left, r.width);
    if (z.field) {
      const fr = z.field.getBoundingClientRect();
      for (const t of drag.splits.get(z.block) || []) consider(fr.top + t.y, { kind: "text", block: z.block, from: t.from, to: t.to }, fr.left, fr.width);
    }
  });
  return best?.target || null;
}

function dragShow() {
  if (!drag) return;
  drag.ghost.style.transform = `translate(${drag.pos.x - 36}px, ${drag.pos.y - 92}px)`;
  drag.target = dragTarget(drag.pos);
  const trayBar = $(".tag-leiste");
  trayBar?.classList.toggle("ziel", drag.target?.kind === "tray");
  const l = drag.target?.line;
  drag.marker.hidden = !l;
  if (l) {
    drag.marker.className = l.vertical ? "tag-marke senkrecht" : "tag-marke";
    Object.assign(drag.marker.style, l.vertical
      ? { left: `${l.x}px`, top: `${l.y}px`, height: `${l.h}px`, width: "", }
      : { left: `${l.x}px`, top: `${l.y - 1.5}px`, width: `${l.w}px`, height: "" });
  }
}

function dragCleanup() {
  if (!drag) return null;
  cancelAnimationFrame(drag.raf);
  drag.ghost.remove();
  drag.marker.remove();
  if (drag.sheetBody) drag.sheetBody.style.overflowY = drag.overflow || "";
  drag.sourceNode.classList.remove("zieht");
  document.body.classList.remove("tag-zieht");
  $(".tag-leiste")?.classList.remove("ziel");
  const finished = drag;
  drag = null;
  return finished;
}

function dragEnd(pos) {
  if (!drag) return;
  drag.pos = pos;
  const target = dragTarget(pos);
  const { id, origin } = dragCleanup();
  if (target?.kind === "tray") changeBlocks(removePhotoFromBlocks(blocks, id));
  else if (target) changeBlocks(placePhoto(blocks, id, target));
  else draw();   // nothing hit: everything stays as it was (an upload finished during the drag shows up too)
  void origin;
}

function dragCancel() {
  if (!drag) return;
  dragCleanup();
  draw();
}

/** Redraw, but not in the middle of a drag (that would lose the dragged photo and its events). */
const drawWhenIdle = () => { if (!drag) draw(); };

function choosePhotos() {
  if (!current) return;
  if (!isCentral()) { toast("Fotos brauchen eine Verbindung zum Konto"); return; }
  $("#tag-photo-input").click();
}

/** The entry must exist on the server before photos can be attached. */
async function ensureEntry() {
  if (current.id) return current.id;
  const result = await storeDiaryEntry({ tripId: current.tripId, dayKey: current.dayKey, blocks: cleanBlocks(blocks) });
  if (result.ok) { current.id = result.id; $("#tag-delete").hidden = false; }
  return result.ok ? result.id : null;
}

/** Upload the chosen photos. They land in the tray first; placing them comes afterwards, at leisure. */
async function photosChosen(e) {
  const files = [...(e.target.files || [])];
  e.target.value = "";
  if (!files.length || !current) return;

  const hint = photoDayHint(files, current.dayKey, days);
  if (hint) $("#tag-day-hint").textContent = `${hint.count} ${hint.count === 1 ? "Foto ist" : "Fotos sind"} wohl von Tag ${hint.number}.`;

  const id = await ensureEntry();
  if (!id) return;

  uploadsRunning += files.length;
  setStatus(`Fotos werden hochgeladen … (${uploadsRunning})`);
  for (const file of files) {
    try {
      const { blob, width, height } = await compressPhoto(file);
      const takenAt = file.lastModified ? new Date(file.lastModified).toISOString() : new Date().toISOString();
      const { id: fotoId } = await uploadPhoto(blob, { tagebuchId: id, takenAt, width, height });
      upsertPhoto({ id: fotoId, besuchId: null, noteId: null, tagebuchId: id, takenAt, width, height, lat: null, lon: null });
      drawWhenIdle();
    } catch (err) {
      toast(err.message || "Foto konnte nicht hochgeladen werden");
    } finally {
      uploadsRunning -= 1;
      setStatus(uploadsRunning ? `Fotos werden hochgeladen … (${uploadsRunning})` : "");
    }
  }
  drawWhenIdle();
}

/** Delete a tray photo for good (it is in no paragraph). */
async function deletePhotoForGood(fotoId) {
  try {
    await deletePhoto(fotoId);
    removePhoto(fotoId);
    drawWhenIdle();
    toast("Foto gelöscht");
  } catch (err) {
    toast(err.message || "Foto konnte nicht gelöscht werden");
  }
}

export const isDirty = () => Boolean(current) && JSON.stringify(cleanBlocks(blocks)) !== snapshot;

export async function save() {
  if (!current) return;
  if (uploadsRunning > 0) { toast("Die Fotos werden noch hochgeladen"); return; }
  const cleaned = cleanBlocks(blocks);
  if (!hasContent(cleaned)) {
    toast(current.id ? "Eintrag ist leer – Eintrag löschen, wenn er weg soll" : "Noch nichts geschrieben");
    return;
  }
  const { tripId, dayKey } = current;
  const result = await storeDiaryEntry({ tripId, dayKey, blocks: cleaned });
  if (!result.ok) return;   // the draft stays on the device
  writeJson(draftKey(tripId, dayKey), null);
  snapshot = JSON.stringify(cleaned);
  current = null;
  afterChange();
  toast("Tag gespeichert");
}

export const clearEditor = () => {
  clearTimeout(draftTimer);
  if (current) saveDraft(true);
  current = null;
};

// Photos of an entry that are nowhere in the text lie in the tray and appear in the logbook at the start of the day, as cover or collage (see withUnplacedPhotos in diary.js).
export const usedPhotoIds = () => allPhotoIds(blocks);
