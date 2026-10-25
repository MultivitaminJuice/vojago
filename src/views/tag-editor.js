// Tag erzählen: ein Tagebucheintrag je Reise und Kalendertag — Absätze und Fotos
// in der Reihenfolge, wie sie erzählt werden. Gedacht für das Schreiben am
// iPhone, auch nachträglich: der Tag lässt sich wählen, der Entwurf wird laufend
// auf dem Gerät gesichert, Fotos werden gleich beim Auswählen hochgeladen.
import { el, render, toast, $ } from "../dom.js";
import { state, trip, tagebuchFuer, tagebuchFotos, upsertPhoto, removePhoto } from "../state.js";
import { speichereTagebuch, loescheTagebuch, zentral } from "../store.js";
import { photoUrl, uploadPhoto, deletePhoto } from "../api.js";
import { komprimiereFoto } from "../ui/photo.js";
import { localDayKey } from "../day-utils.js";
import {
  bereinigeBlocks, hatInhalt, alleFotoIds, mitVerwaistenFotos, tageFuerEditor, standardTag, fotoTagHinweis,
} from "../tagebuch.js";

let current = null;       // { tripId, dayKey, id|null }
let blocks = [];          // Arbeitsstand: [{t:"text",text} | {t:"fotos",ids}]
let tage = [];            // Tage der Reise zum Auswählen
let snapshot = "";        // gesicherter Stand (bereinigt, als JSON) — für "ungespeichert?"
let afterChange = () => {};
let openSheet = () => {};
let entwurfTimer = null;
let ladeVorgaenge = 0;

const entwurfKey = (tripId, dayKey) => `vojago.tagebuch.entwurf.${tripId}.${dayKey}`;
const lies = (key) => { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; } };
const schreibe = (key, wert) => { try { wert == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(wert)); } catch { /* Speicher voll/blockiert */ } };

const tagLabel = (t, jetzt, belegt) => {
  const d = new Date(`${t.key}T12:00:00`);
  const heute = localDayKey(jetzt.toISOString());
  const gestern = localDayKey(new Date(jetzt.getTime() - 86400000).toISOString());
  const wochentag = d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
  const zusatz = t.key === heute ? " · heute" : t.key === gestern ? " · gestern" : "";
  const erzaehlt = belegt.has(t.key) ? " ✓" : "";
  return `Tag ${t.nummer} · ${wochentag}${zusatz}${erzaehlt}`;
};

export function initTagEditor({ onChange, onOpen }) {
  afterChange = onChange;
  openSheet = onOpen || (() => {});

  $("#tag-save").addEventListener("click", () => save());
  $("#tag-day").addEventListener("change", (e) => wechsleTag(e.target.value));
  $("#tag-photo-input").addEventListener("change", fotosGewaehlt);

  let loeschenBereit = null;
  $("#tag-delete").addEventListener("click", async (e) => {
    const knopf = e.currentTarget;
    if (!current?.id) return;
    // Zwei Schritte statt Rückfrage-Dialog: erst "Wirklich löschen?", dann löschen.
    if (!loeschenBereit) {
      knopf.textContent = "Wirklich löschen?";
      loeschenBereit = setTimeout(() => { loeschenBereit = null; knopf.textContent = "Eintrag löschen"; }, 4000);
      return;
    }
    clearTimeout(loeschenBereit);
    loeschenBereit = null;
    knopf.textContent = "Eintrag löschen";
    const { tripId, dayKey, id } = current;
    schreibe(entwurfKey(tripId, dayKey), null);
    current = null;
    await loescheTagebuch(id);
    afterChange();
    toast("Eintrag gelöscht");
  });
}

/** Tag erzählen öffnen. Ohne `dayKey` schlägt die App den naheliegenden Tag vor. */
export function openTagEditor({ tripId, dayKey = null }) {
  const t = trip(tripId);
  if (!t) { toast("Für diese Ansicht gibt es kein Tagebuch"); return; }
  const jetzt = new Date();
  const eintraege = state.tagebuch.filter((e) => e.tripId === tripId);
  tage = tageFuerEditor(t, { jetzt, extraKeys: eintraege.map((e) => e.dayKey) });
  const wahl = dayKey && tage.some((x) => x.key === dayKey)
    ? dayKey
    : standardTag(tage, new Set(eintraege.map((e) => e.dayKey)), jetzt);
  openSheet();
  const belegt = new Set(eintraege.map((e) => e.dayKey));
  render($("#tag-day"), tage.map((x) => el("option", { value: x.key, text: tagLabel(x, jetzt, belegt) })));
  laden(tripId, wahl);
}

function laden(tripId, dayKey) {
  const eintrag = tagebuchFuer(tripId, dayKey);
  current = { tripId, dayKey, id: eintrag?.id || null };
  $("#tag-day").value = dayKey;
  const kopie = (liste) => JSON.parse(JSON.stringify(liste));
  let start = eintrag ? mitVerwaistenFotos(kopie(eintrag.blocks), tagebuchFotos(eintrag.id).map((p) => p.id)) : [];
  snapshot = JSON.stringify(bereinigeBlocks(start));

  const entwurf = lies(entwurfKey(tripId, dayKey));
  const stand = Date.parse(String(eintrag?.updatedAt || "").replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(eintrag?.updatedAt || "") ? "" : "Z")) || 0;
  let status = "";
  if (entwurf?.blocks && entwurf.ts > stand && JSON.stringify(bereinigeBlocks(entwurf.blocks)) !== snapshot) {
    start = kopie(entwurf.blocks);
    status = "Entwurf wiederhergestellt";
  }
  blocks = start.length ? start : [{ t: "text", text: "" }];
  $("#tag-delete").hidden = !current.id;
  $("#tag-day-hint").textContent = "";
  setzeStatus(status);
  zeichne();
}

function wechsleTag(neuerTag) {
  if (!current || neuerTag === current.dayKey) return;
  sichereEntwurf(true);
  laden(current.tripId, neuerTag);
}

const setzeStatus = (text) => { const e = $("#tag-status"); if (e) e.textContent = text || ""; };

function sichereEntwurf(sofort = false) {
  if (!current) return;
  const jetzt = () => {
    const ziel = entwurfKey(current.tripId, current.dayKey);
    const aktuell = JSON.stringify(bereinigeBlocks(blocks));
    if (aktuell === snapshot) { schreibe(ziel, null); return; }
    schreibe(ziel, { blocks: bereinigeBlocks(blocks), ts: Date.now() });
    const zeichen = bereinigeBlocks(blocks).reduce((n, b) => n + (b.t === "text" ? b.text.length : 0), 0);
    setzeStatus(`Entwurf gespeichert · ${zeichen} Zeichen`);
  };
  clearTimeout(entwurfTimer);
  if (sofort) jetzt(); else entwurfTimer = setTimeout(jetzt, 500);
}

function wachse(feld) {
  feld.style.height = "auto";
  feld.style.height = `${Math.max(feld.scrollHeight, 96)}px`;
}

function zeichne() {
  const box = $("#tag-blocks");
  if (!box) return;
  const knoten = [];
  // "＋ Absatz" erscheint, sobald der letzte Absatz Text hat (oder Fotos am Ende stehen) — ohne neu zu zeichnen,
  // damit beim Tippen weder Fokus noch Tastatur verloren gehen.
  const absatzKnopf = el("button.tag-add", { type: "button", text: "＋ Absatz", on: { click: () => {
    blocks.push({ t: "text", text: "" });
    zeichne();
    fokussiereLetztenAbsatz();
  } } });
  const zeigeAbsatz = () => {
    const l = blocks[blocks.length - 1];
    absatzKnopf.hidden = !(l?.t === "fotos" || (l?.t === "text" && l.text.trim()));
  };
  blocks.forEach((b, i) => {
    if (b.t === "text") {
      const feld = el("textarea.tag-text", {
        rows: 3, "aria-label": i === 0 ? "Was war heute los?" : "Weiterer Absatz",
        placeholder: i === 0 ? "Was war los? Wo wart ihr, was habt ihr gesehen?" : "Weiter …",
      });
      feld.value = b.text;
      feld.addEventListener("input", () => { b.text = feld.value; wachse(feld); sichereEntwurf(); zeigeAbsatz(); });
      queueMicrotask(() => wachse(feld));
      knoten.push(feld);
      const naechster = blocks[i + 1];
      const kannEntfernen = blocks.filter((x) => x.t === "text").length > 1;
      knoten.push(el("div.tag-aktionen", {}, [
        !naechster || naechster.t !== "fotos"
          ? el("button.tag-add", { type: "button", text: "＋ Fotos", on: { click: () => waehleFotos({ nachBlock: i, feld }) } })
          : null,
        kannEntfernen ? el("button.tag-add.tag-weg", { type: "button", text: "Absatz entfernen", on: { click: (e) => entferneAbsatz(b, e.currentTarget) } }) : null,
      ]));
    } else {
      knoten.push(el("div.tag-fotos", {}, [
        ...b.ids.map((id) => el("div.photo-thumb", {}, [
          el("img", { src: photoUrl(id), loading: "lazy", alt: "" }),
          el("button", { type: "button", "aria-label": "Foto entfernen", text: "✕", on: { click: () => entferneFoto(b, id) } }),
        ])),
        el("button.tag-plus", { type: "button", "aria-label": "Weitere Fotos", text: "＋", on: { click: () => waehleFotos({ anBlock: i }) } }),
      ]));
    }
  });
  knoten.push(absatzKnopf);
  zeigeAbsatz();
  render(box, knoten);
}

/**
 * Fokus auf den letzten Absatz setzen, ohne dass der Browser dafür den äußeren Bildschirm
 * verschiebt (er würde die unten wartenden Blätter freilegen) — nur der Editor scrollt.
 */
function fokussiereLetztenAbsatz() {
  const feld = [...$("#tag-blocks").querySelectorAll("textarea")].at(-1);
  if (!feld) return;
  feld.focus({ preventScroll: true });
  const koerper = feld.closest(".sheet-body");
  if (koerper) koerper.scrollTop += feld.getBoundingClientRect().top - koerper.getBoundingClientRect().top - 80;
}

/** Absatz entfernen: ein leerer sofort, einer mit Text erst nach einer zweiten Berührung. */
function entferneAbsatz(block, knopf) {
  if (block.text.trim() && !knopf.dataset.sicher) {
    knopf.dataset.sicher = "1";
    knopf.textContent = "Wirklich entfernen?";
    setTimeout(() => { if (knopf.isConnected) { delete knopf.dataset.sicher; knopf.textContent = "Absatz entfernen"; } }, 3500);
    return;
  }
  blocks = blocks.filter((x) => x !== block);
  // Foto-Gruppen, die dadurch aneinanderstoßen, verschmelzen; ein Absatz bleibt immer übrig.
  blocks = blocks.reduce((out, b) => {
    const letzter = out[out.length - 1];
    if (b.t === "fotos" && letzter?.t === "fotos") letzter.ids = [...letzter.ids, ...b.ids];
    else out.push(b);
    return out;
  }, []);
  if (!blocks.some((x) => x.t === "text")) blocks.push({ t: "text", text: "" });
  sichereEntwurf();
  zeichne();
}

let fotoZiel = null;
function waehleFotos(ziel) {
  if (!current) return;
  if (!zentral()) { toast("Fotos brauchen eine Verbindung zum Konto"); return; }
  fotoZiel = ziel;
  $("#tag-photo-input").click();
}

/** Der Eintrag muss serverseitig existieren, bevor Fotos daran hängen können. */
async function sichereEintrag() {
  if (current.id) return current.id;
  const ergebnis = await speichereTagebuch({ tripId: current.tripId, dayKey: current.dayKey, blocks: bereinigeBlocks(blocks) });
  if (ergebnis.ok) { current.id = ergebnis.id; $("#tag-delete").hidden = false; }
  return ergebnis.ok ? ergebnis.id : null;
}

async function fotosGewaehlt(e) {
  const dateien = [...(e.target.files || [])];
  e.target.value = "";
  if (!dateien.length || !current || !fotoZiel) return;
  const ziel = fotoZiel;
  fotoZiel = null;

  const hinweis = fotoTagHinweis(dateien, current.dayKey, tage);
  if (hinweis) $("#tag-day-hint").textContent = `${hinweis.anzahl} ${hinweis.anzahl === 1 ? "Foto ist" : "Fotos sind"} wohl von Tag ${hinweis.nummer}.`;

  // Zielblock bestimmen: an eine vorhandene Foto-Gruppe anhängen, sonst nach dem Absatz
  // (an der Cursorstelle geteilt) eine neue Gruppe einfügen.
  let gruppe;
  if (ziel.anBlock != null) gruppe = blocks[ziel.anBlock];
  else {
    const i = ziel.nachBlock;
    const text = blocks[i];
    const stelle = ziel.feld?.selectionStart ?? text.text.length;
    if (stelle > 0 && stelle < text.text.length) {
      const hinten = text.text.slice(stelle).replace(/^\s+/, "");
      text.text = text.text.slice(0, stelle).replace(/\s+$/, "");
      blocks.splice(i + 1, 0, { t: "text", text: hinten });
    }
    gruppe = { t: "fotos", ids: [] };
    blocks.splice(i + 1, 0, gruppe);
  }

  const id = await sichereEintrag();
  if (!id) { blocks = blocks.filter((b) => b !== gruppe || b.ids.length); zeichne(); return; }

  ladeVorgaenge += dateien.length;
  setzeStatus(`Fotos werden hochgeladen … (${ladeVorgaenge})`);
  zeichne();
  for (const datei of dateien) {
    try {
      const { blob, width, height } = await komprimiereFoto(datei);
      const takenAt = datei.lastModified ? new Date(datei.lastModified).toISOString() : new Date().toISOString();
      const { id: fotoId } = await uploadPhoto(blob, { tagebuchId: id, takenAt, width, height });
      upsertPhoto({ id: fotoId, besuchId: null, noteId: null, tagebuchId: id, takenAt, width, height, lat: null, lon: null });
      gruppe.ids.push(fotoId);
      zeichne();
    } catch (err) {
      toast(err.message || "Foto konnte nicht hochgeladen werden");
    } finally {
      ladeVorgaenge -= 1;
    }
  }
  if (!gruppe.ids.length) blocks = blocks.filter((b) => b !== gruppe);
  setzeStatus(ladeVorgaenge ? `Fotos werden hochgeladen … (${ladeVorgaenge})` : "");
  zeichne();
  sichereEntwurf(true);
}

async function entferneFoto(gruppe, fotoId) {
  const vorher = [...gruppe.ids];
  gruppe.ids = gruppe.ids.filter((x) => x !== fotoId);
  zeichne();
  try {
    await deletePhoto(fotoId);
    removePhoto(fotoId);
    // Die letzte entfernte Aufnahme nimmt auch ihre leere Gruppe mit.
    if (!gruppe.ids.length) { blocks = blocks.filter((b) => b !== gruppe); zeichne(); }
    sichereEntwurf();
  } catch (err) {
    gruppe.ids = vorher;
    zeichne();
    toast(err.message || "Foto konnte nicht gelöscht werden");
  }
}

export const isDirty = () => Boolean(current) && JSON.stringify(bereinigeBlocks(blocks)) !== snapshot;

export async function save() {
  if (!current) return;
  if (ladeVorgaenge > 0) { toast("Die Fotos werden noch hochgeladen"); return; }
  const bereinigt = bereinigeBlocks(blocks);
  if (!hatInhalt(bereinigt)) {
    toast(current.id ? "Eintrag ist leer – Eintrag löschen, wenn er weg soll" : "Noch nichts geschrieben");
    return;
  }
  const { tripId, dayKey } = current;
  const ergebnis = await speichereTagebuch({ tripId, dayKey, blocks: bereinigt });
  if (!ergebnis.ok) return;   // der Entwurf bleibt auf dem Gerät
  schreibe(entwurfKey(tripId, dayKey), null);
  snapshot = JSON.stringify(bereinigt);
  current = null;
  afterChange();
  toast("Tag gespeichert");
}

export const clearEditor = () => {
  clearTimeout(entwurfTimer);
  if (current) sichereEntwurf(true);
  current = null;
};

// Fotos eines Eintrags, die nirgends stehen, gehen nicht verloren (siehe mitVerwaistenFotos).
export const verwendeteFotos = () => alleFotoIds(blocks);
