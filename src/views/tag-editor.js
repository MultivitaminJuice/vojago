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
import { ziehbar } from "../drag.js";
import {
  bereinigeBlocks, hatInhalt, alleFotoIds, tageFuerEditor, standardTag, fotoTagHinweis,
  ablageFotos, ordneBlocks, entferneFotoAusBlocks, setzeFoto, textTrennstellen,
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
  // Ein Foto ist nie als Text ablegbar: das System-Ziehen eines Bildes würde sonst seine Adresse in einen Absatz schreiben.
  const fremd = (e) => { const t = [...(e.dataTransfer?.types || [])]; if (t.some((x) => x === "Files" || x === "text/uri-list" || x === "text/html")) e.preventDefault(); };
  $("#tag-blocks").addEventListener("dragover", fremd);
  $("#tag-blocks").addEventListener("drop", fremd);

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
  let start = eintrag ? kopie(eintrag.blocks) : [];
  snapshot = JSON.stringify(bereinigeBlocks(ordneBlocks(start)));

  const entwurf = lies(entwurfKey(tripId, dayKey));
  const stand = Date.parse(String(eintrag?.updatedAt || "").replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(eintrag?.updatedAt || "") ? "" : "Z")) || 0;
  let status = "";
  if (entwurf?.blocks && entwurf.ts > stand && JSON.stringify(bereinigeBlocks(entwurf.blocks)) !== snapshot) {
    start = kopie(entwurf.blocks);
    status = "Entwurf wiederhergestellt";
  }
  blocks = ordneBlocks(start);
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
  feld.style.height = `${Math.max(feld.scrollHeight, 56)}px`;
}

// Absatz, in dem zuletzt geschrieben wurde, und die Cursorstelle darin: dort landen Fotos, die man antippt.
let aktiv = { block: null, stelle: 0 };
// Die gezeichneten Blöcke (für die Zielsuche beim Ziehen): { block, wurzel, feld? , gruppe? }
let zeilen = [];
let zug = null;

const fotoIds = () => (current?.id ? tagebuchFotos(current.id).map((p) => p.id) : []);

function zeichne() {
  const box = $("#tag-blocks");
  if (!box) return;
  const knoten = [];
  zeilen = [];
  blocks.forEach((b, i) => {
    if (b.t === "text") {
      const feld = el("textarea.tag-text", {
        rows: i === 0 ? 3 : 1, "aria-label": i === 0 ? "Was war heute los?" : "Weiter erzählen",
        placeholder: i === 0 ? "Was war los? Wo wart ihr, was habt ihr gesehen?" : "Weiter …",
      });
      feld.value = b.text;
      const merkeStelle = () => { aktiv = { block: b, stelle: feld.selectionStart ?? feld.value.length }; };
      feld.addEventListener("input", () => { b.text = feld.value; wachse(feld); sichereEntwurf(); merkeStelle(); });
      for (const ereignis of ["focus", "click", "keyup", "select"]) feld.addEventListener(ereignis, merkeStelle);
      queueMicrotask(() => wachse(feld));
      const wurzel = el("div.tag-block", {}, [feld]);
      zeilen.push({ block: i, wurzel, feld });
      knoten.push(wurzel);
    } else {
      const wurzel = el("div.tag-fotos", {}, b.ids.map((id) => {
        const thumb = el("div.photo-thumb", { dataset: { id } }, [
          el("img", { src: photoUrl(id), loading: "lazy", alt: "", draggable: false }),
          // Aus dem Text nehmen, nicht löschen: das Foto wandert in die Ablage.
          el("button", { type: "button", "aria-label": "Aus dem Text nehmen", text: "✕", on: { click: (e) => { e.stopPropagation(); aenderBlocks(entferneFotoAusBlocks(blocks, id)); } } }),
        ]);
        fotoZiehbar(thumb, id, "text");
        return thumb;
      }));
      zeilen.push({ block: i, wurzel, gruppe: true });
      knoten.push(wurzel);
    }
  });

  const ablage = current?.id ? ablageFotos(blocks, fotoIds()) : [];
  knoten.push(el("div.tag-leiste", {}, [
    el("div.tag-leiste-knoepfe", {}, [
      el("button.tag-add", { type: "button", text: "📷 Fotos wählen", on: { click: waehleFotos } }),
    ]),
    ablage.length ? el("div.tag-ablage", {}, [
      el("small.tag-hinweis", { text: "Antippen: an den Cursor · Halten und ziehen: an eine Stelle" }),
      el("div.tag-ablage-reihe", {}, ablage.map(ablageFoto)),
    ]) : null,
  ]));
  render(box, knoten);
}

/** Ein Foto der Ablage: antippen setzt es an den Cursor, halten und ziehen an eine beliebige Stelle. */
function ablageFoto(id) {
  const loeschen = el("button", { type: "button", "aria-label": "Foto löschen", text: "✕", on: { click: (e) => {
    e.stopPropagation();
    // Endgültig weg — deshalb erst nach einer zweiten Berührung.
    if (!loeschen.dataset.sicher) {
      loeschen.dataset.sicher = "1";
      loeschen.textContent = "Löschen?";
      loeschen.classList.add("sicher");
      setTimeout(() => { if (loeschen.isConnected) { delete loeschen.dataset.sicher; loeschen.textContent = "✕"; loeschen.classList.remove("sicher"); } }, 3000);
      return;
    }
    loescheFoto(id);
  } } });
  const thumb = el("div.photo-thumb.klein", { dataset: { id }, on: { click: () => setzeAnCursor(id) } }, [
    el("img", { src: photoUrl(id), loading: "lazy", alt: "", draggable: false }),
    loeschen,
  ]);
  fotoZiehbar(thumb, id, "ablage");
  return thumb;
}

function aenderBlocks(neu) {
  blocks = neu;
  sichereEntwurf(true);
  zeichne();
}

/** Antippen in der Ablage: dorthin, wo zuletzt geschrieben wurde (mitten im Satz wird der Absatz geteilt). */
function setzeAnCursor(id) {
  const texte = blocks.filter((x) => x.t === "text");
  const ziel = blocks.includes(aktiv.block) ? aktiv.block : texte[texte.length - 1];
  const i = blocks.indexOf(ziel);
  const stelle = ziel === aktiv.block ? Math.min(aktiv.stelle, ziel.text.length) : ziel.text.length;
  if (!ziel.text.trim() || stelle === 0) aenderBlocks(setzeFoto(blocks, id, { art: "zwischen", index: i }));
  else if (stelle >= ziel.text.length) aenderBlocks(setzeFoto(blocks, id, { art: "zwischen", index: i + 1 }));
  else aenderBlocks(setzeFoto(blocks, id, { art: "text", block: i, von: stelle, bis: stelle }));
}

/* ---------- Ziehen: Fotos an eine Stelle im Text setzen oder zurück in die Ablage ---------- */

function fotoZiehbar(knoten, id, herkunft) {
  ziehbar(knoten, {
    start: (pos) => zugStart(knoten, id, herkunft, pos),
    bewegung: (pos) => { if (zug) { zug.pos = pos; zugAnzeige(); } },
    ende: (pos) => zugEnde(pos),
    abbruch: () => zugAbbruch(),
  });
}

/**
 * Mögliche Schnittstellen in einem Eingabefeld: das Ende jeder sichtbaren Zeile
 * (an einer Wortgrenze) und jeder Zeilenumbruch. So lässt sich ein Foto auch
 * mitten in einem langen Absatz einsetzen. Gemessen wird an einer unsichtbaren
 * Kopie des Feldes; y ist der Abstand der Schnittlinie von der Oberkante des Feldes.
 */
function messeZeilen(feld, text) {
  if (!text.trim()) return [];
  const css = getComputedStyle(feld);
  const spiegel = document.createElement("div");
  spiegel.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;left:-9999px;top:0;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box;width:${feld.clientWidth + parseFloat(css.borderLeftWidth) + parseFloat(css.borderRightWidth)}px;font:${css.font};letter-spacing:${css.letterSpacing};line-height:${css.lineHeight};padding:${css.padding};border:${css.border}`;
  document.body.appendChild(spiegel);
  const hoehe = parseFloat(css.lineHeight) || parseFloat(css.fontSize) * 1.5;
  const oben = parseFloat(css.paddingTop) + parseFloat(css.borderTopWidth);
  const unten = parseFloat(css.paddingBottom) + parseFloat(css.borderBottomWidth);
  const zeilenVon = (t) => { spiegel.textContent = t; return Math.round((spiegel.offsetHeight - oben - unten) / hoehe); };
  const gesamt = zeilenVon(text);
  const stellen = new Map();
  for (let k = 1; k < gesamt; k++) {
    // Das längste Textstück, das noch in k Zeilen passt, endet am Ende der k-ten Zeile.
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mitte = (lo + hi + 1) >> 1;
      if (zeilenVon(text.slice(0, mitte)) <= k) lo = mitte; else hi = mitte - 1;
    }
    let i = lo;
    if (i < text.length && !/\s/.test(text[i])) {            // mitten in einem Wort: zurück zur Wortgrenze
      const w = text.slice(0, i).search(/\s\S*$/);
      if (w < 0) continue;
      i = w;
    }
    const von = text.slice(0, i).replace(/\s+$/, "").length;
    const rest = text.slice(i);
    const bis = i + (rest.length - rest.replace(/^\s+/, "").length);
    if (von <= 0 || bis >= text.length) continue;
    const y = oben + k * hoehe;
    const alt = stellen.get(`${von}:${bis}`);
    if (alt) alt.ys.push(y); else stellen.set(`${von}:${bis}`, { von, bis, ys: [y] });
  }
  spiegel.remove();
  // Eine Leerzeile erzeugt zwei Linien mit derselben Schnittstelle: die Marke kommt in die Mitte.
  return [...stellen.values()].map(({ von, bis, ys }) => ({ von, bis, y: ys.reduce((a, b) => a + b, 0) / ys.length }));
}

function zugStart(quelle, id, herkunft, pos) {
  if (zug) return;
  const geist = el("div.tag-geist", {}, [el("img", { src: photoUrl(id), alt: "" })]);
  const marke = el("div.tag-marke", { hidden: true });
  document.body.append(geist, marke);
  quelle.classList.add("zieht");
  document.body.classList.add("tag-zieht");
  zug = {
    id, herkunft, quelle, geist, marke, pos, ziel: null,
    trenn: new Map(zeilen.filter((z) => z.feld).map((z) => [z.block, messeZeilen(z.feld, blocks[z.block].text)])),
    raf: requestAnimationFrame(zugTakt),
    start: performance.now(), randSeit: 0,
  };
  // Während des Ziehens soll nichts anderes scrollen; der Editor scrollt nur selbst am Rand.
  const koerper = $("#tag-blocks")?.closest(".sheet-body");
  if (koerper) { zug.koerper = koerper; zug.overflow = koerper.style.overflowY; koerper.style.overflowY = "hidden"; }
  zugAnzeige();
}

/**
 * Jeder Bildschirm-Takt: am Rand langsam scrollen (erst nach kurzem Verweilen, damit ein
 * Ziel in Randnähe nicht davonläuft) und das Ziel neu bestimmen, weil der Inhalt wandert.
 */
function zugTakt(jetzt = performance.now()) {
  if (!zug) return;
  const koerper = zug.koerper;
  const leiste = $(".tag-leiste")?.getBoundingClientRect();
  if (koerper && leiste) {
    const k = koerper.getBoundingClientRect();
    const RAND = 56;
    const oben = zug.pos.y - k.top;
    const unten = (leiste.top - 4) - zug.pos.y;
    const richtung = oben < RAND ? -1 : unten < RAND && unten > 0 ? 1 : 0;
    if (!richtung) zug.randSeit = 0;
    else {
      zug.randSeit ||= jetzt;
      if (jetzt - zug.randSeit > 350) {
        const naehe = richtung < 0 ? RAND - Math.max(oben, 0) : RAND - unten;
        koerper.scrollTop += richtung * Math.max(1, Math.ceil((naehe / RAND) * 7));
      }
    }
  }
  zugAnzeige();
  zug.raf = requestAnimationFrame(zugTakt);
}

/** Das Ziel unter dem Finger. Liefert { art, ... } wie `setzeFoto`, oder { art: "ablage" } bzw. null. */
function zugZiel(pos) {
  const leiste = $(".tag-leiste")?.getBoundingClientRect();
  if (leiste && pos.y >= leiste.top - 2) return zug.herkunft === "text" ? { art: "ablage" } : null;

  // Über einer Foto-Gruppe: zwischen deren Fotos einsortieren.
  for (const z of zeilen) {
    if (!z.gruppe) continue;
    const r = z.wurzel.getBoundingClientRect();
    if (pos.y < r.top - 4 || pos.y > r.bottom + 4) continue;
    const thumbs = [...z.wurzel.querySelectorAll(".photo-thumb")];
    const zeilenHoehe = thumbs[0]?.getBoundingClientRect().height || 72;
    let index = 0;
    thumbs.forEach((t, k) => {
      const tr = t.getBoundingClientRect();
      const mitteY = tr.top + tr.height / 2;
      const davor = mitteY + zeilenHoehe / 2 < pos.y || (Math.abs(mitteY - pos.y) <= zeilenHoehe / 2 && tr.left + tr.width / 2 < pos.x);
      if (davor) index = k + 1;
    });
    const bezug = thumbs[Math.min(index, thumbs.length - 1)]?.getBoundingClientRect();
    return {
      art: "gruppe", block: z.block, index,
      linie: bezug ? { x: index < thumbs.length ? bezug.left - 4 : bezug.right + 3, y: bezug.top, h: bezug.height, senkrecht: true } : null,
    };
  }

  // Sonst die nächste Naht: zwischen zwei Blöcken oder an einem Zeilenumbruch im Text.
  let beste = null;
  const prüfe = (y, ziel, x0, breite) => {
    const d = Math.abs(y - pos.y);
    if (!beste || d < beste.d) beste = { d, ziel: { ...ziel, linie: { x: x0, y, w: breite } } };
  };
  zeilen.forEach((z, k) => {
    const r = z.wurzel.getBoundingClientRect();
    if (k === 0) prüfe(r.top, { art: "zwischen", index: z.block }, r.left, r.width);
    const naechste = zeilen[k + 1];
    if (naechste) prüfe((r.bottom + naechste.wurzel.getBoundingClientRect().top) / 2, { art: "zwischen", index: naechste.block }, r.left, r.width);
    else prüfe(r.bottom, { art: "zwischen", index: z.block + 1 }, r.left, r.width);
    if (z.feld) {
      const fr = z.feld.getBoundingClientRect();
      for (const t of zug.trenn.get(z.block) || []) prüfe(fr.top + t.y, { art: "text", block: z.block, von: t.von, bis: t.bis }, fr.left, fr.width);
    }
  });
  return beste?.ziel || null;
}

function zugAnzeige() {
  if (!zug) return;
  zug.geist.style.transform = `translate(${zug.pos.x - 36}px, ${zug.pos.y - 92}px)`;
  zug.ziel = zugZiel(zug.pos);
  const leiste = $(".tag-leiste");
  leiste?.classList.toggle("ziel", zug.ziel?.art === "ablage");
  const l = zug.ziel?.linie;
  zug.marke.hidden = !l;
  if (l) {
    zug.marke.className = l.senkrecht ? "tag-marke senkrecht" : "tag-marke";
    Object.assign(zug.marke.style, l.senkrecht
      ? { left: `${l.x}px`, top: `${l.y}px`, height: `${l.h}px`, width: "", }
      : { left: `${l.x}px`, top: `${l.y - 1.5}px`, width: `${l.w}px`, height: "" });
  }
}

function zugAufraeumen() {
  if (!zug) return null;
  cancelAnimationFrame(zug.raf);
  zug.geist.remove();
  zug.marke.remove();
  if (zug.koerper) zug.koerper.style.overflowY = zug.overflow || "";
  zug.quelle.classList.remove("zieht");
  document.body.classList.remove("tag-zieht");
  $(".tag-leiste")?.classList.remove("ziel");
  const alt = zug;
  zug = null;
  return alt;
}

function zugEnde(pos) {
  if (!zug) return;
  zug.pos = pos;
  const ziel = zugZiel(pos);
  const { id, herkunft } = zugAufraeumen();
  if (ziel?.art === "ablage") aenderBlocks(entferneFotoAusBlocks(blocks, id));
  else if (ziel) aenderBlocks(setzeFoto(blocks, id, ziel));
  else zeichne();   // nichts getroffen: alles bleibt, wie es war (auch ein während des Zugs fertiger Upload erscheint)
  void herkunft;
}

function zugAbbruch() {
  if (!zug) return;
  zugAufraeumen();
  zeichne();
}

/** Neu zeichnen, aber nicht mitten in einem Zug (das würde das gezogene Foto samt Ereignissen verlieren). */
const zeichneWennRuhig = () => { if (!zug) zeichne(); };

function waehleFotos() {
  if (!current) return;
  if (!zentral()) { toast("Fotos brauchen eine Verbindung zum Konto"); return; }
  $("#tag-photo-input").click();
}

/** Der Eintrag muss serverseitig existieren, bevor Fotos daran hängen können. */
async function sichereEintrag() {
  if (current.id) return current.id;
  const ergebnis = await speichereTagebuch({ tripId: current.tripId, dayKey: current.dayKey, blocks: bereinigeBlocks(blocks) });
  if (ergebnis.ok) { current.id = ergebnis.id; $("#tag-delete").hidden = false; }
  return ergebnis.ok ? ergebnis.id : null;
}

/** Ausgewählte Fotos hochladen. Sie landen zunächst in der Ablage; platziert wird danach, in Ruhe. */
async function fotosGewaehlt(e) {
  const dateien = [...(e.target.files || [])];
  e.target.value = "";
  if (!dateien.length || !current) return;

  const hinweis = fotoTagHinweis(dateien, current.dayKey, tage);
  if (hinweis) $("#tag-day-hint").textContent = `${hinweis.anzahl} ${hinweis.anzahl === 1 ? "Foto ist" : "Fotos sind"} wohl von Tag ${hinweis.nummer}.`;

  const id = await sichereEintrag();
  if (!id) return;

  ladeVorgaenge += dateien.length;
  setzeStatus(`Fotos werden hochgeladen … (${ladeVorgaenge})`);
  for (const datei of dateien) {
    try {
      const { blob, width, height } = await komprimiereFoto(datei);
      const takenAt = datei.lastModified ? new Date(datei.lastModified).toISOString() : new Date().toISOString();
      const { id: fotoId } = await uploadPhoto(blob, { tagebuchId: id, takenAt, width, height });
      upsertPhoto({ id: fotoId, besuchId: null, noteId: null, tagebuchId: id, takenAt, width, height, lat: null, lon: null });
      zeichneWennRuhig();
    } catch (err) {
      toast(err.message || "Foto konnte nicht hochgeladen werden");
    } finally {
      ladeVorgaenge -= 1;
      setzeStatus(ladeVorgaenge ? `Fotos werden hochgeladen … (${ladeVorgaenge})` : "");
    }
  }
  zeichneWennRuhig();
}

/** Ein Foto der Ablage endgültig löschen (liegt in keinem Absatz). */
async function loescheFoto(fotoId) {
  try {
    await deletePhoto(fotoId);
    removePhoto(fotoId);
    zeichneWennRuhig();
  } catch (err) {
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

// Fotos eines Eintrags, die nirgends stehen, liegen in der Ablage und erscheinen im Logbuch am Ende (siehe mitVerwaistenFotos).
export const verwendeteFotos = () => alleFotoIds(blocks);
