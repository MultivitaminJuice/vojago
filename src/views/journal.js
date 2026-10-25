// Reisetagebuch: die Reise als Folge von Tagen (Kapiteln), durchgehend zu
// scrollen. Jeder Tag hat einen Kopf, eine Gedankenstütze (Route, Wetter,
// Verlauf), Stellplatz-Karten, eigene Stationen und Notizen. Technische
// Angaben stehen eine Ebene tiefer unter "Details".
import { el, render, icon, toast, $, $$ } from "../dom.js";
import { ICON } from "../icons.js";
import { state, journalTrip, tripPlaces, tripNotes, placePhotos, notePhotos, category, isRangeTrip, tagebuchFotos } from "../state.js";
import { localDayKey, shiftIsoByLocalDays, tripStartIso } from "../day-utils.js";
import { speichereOrt, wetterZeile } from "../store.js";
import { ensureTripPath } from "../dataload.js";
import { tageDerReise } from "../journal-days.js";
import { kartenAnsicht, kachelAdresse, routenPfad } from "../mini-karte.js";
import { CARTO_KEY, kachelUrl, gueltigerKartenstil } from "../map-style.js";
import { ohneFoto, titelbildId } from "../tagebuch.js";
import { photoUrl, sharePhotoUrl } from "../api.js";
import { zeigeFoto } from "../ui/photo-lightbox.js";

const SOURCE_LABEL = { camper: "🚐 Camper", handy: "🚶 Handy", manuell: "📍 manuell" };

/** Bild-URL, angemeldet oder als Gast — der Gast-Endpunkt braucht den
 * Freigabe-Token, der Eigentümer-Endpunkt die normale Sitzung. */
const bildUrl = (id) => (state.gast ? sharePhotoUrl(state.gast.token, id) : photoUrl(id));

// Eine Reihe pro renderJournal()-Aufruf: alle sichtbaren Fotos der Reise
// (unter Berücksichtigung des aktuellen Filters), chronologisch — damit
// Vor/Zurück in der Lightbox auch über eine Notiz/einen Ort hinaus zur
// nächsten weiterblättert, nicht nur innerhalb einer Karte.
let tripSlides = [];
let photoSlideIndex = new Map();

const dateTimeLabel = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
};

/** Baut dieselbe Kopf-/Text-/Badge-Struktur wie die echte Logbuch-Karte
 * (.j-head/.j-attrs/.j-cat/.j-foot/.mbadge) — die Infokarte über dem Foto
 * soll aussehen wie ein Ausschnitt aus dem Logbuch, nicht wie ein eigener Stil. */
const noteCaption = (note) => {
  const ort = note.besuchId ? state.places.find((p) => p.id === note.besuchId) : null;
  return el("div", {}, [
    el("div.j-head", {}, [
      el("b", { text: noteTitle(note) }),
      el("span.j-attrs", {}, [el("span.j-cat.j-cat-note", { text: "Notiz" })]),
    ]),
    note.text ? el("p", { text: note.text }) : null,
    el("div.j-foot", {}, [
      dateTimeLabel(note.at) ? el("span.mbadge", { text: dateTimeLabel(note.at) }) : null,
      wetterZeile(note.weather) ? el("span.mbadge", { text: wetterZeile(note.weather) }) : null,
      ort ? el("span.mbadge", { text: `bei: ${ort.title}` }) : null,
    ]),
  ]);
};
const placeCaption = (place) => {
  const kat = place.catId === "uebernachtung"
    ? `Übernachtung${place.nights > 1 ? ` (${place.nights} Nächte)` : ""}`
    : (category(place.catId)?.name || "Ort");
  const sterne = place.stars ? "★".repeat(place.stars) + "☆".repeat(5 - place.stars) : "";
  return el("div", {}, [
    el("div.j-head", {}, [
      el("b", { text: place.title }),
      el("span.j-attrs", {}, [el("span.j-cat", { text: kat })]),
    ]),
    place.note ? el("p", { text: place.note }) : null,
    el("div.j-foot", {}, [
      dateTimeLabel(place.at) ? el("span.mbadge", { text: dateTimeLabel(place.at) }) : null,
      sterne ? el("span.mbadge", { text: sterne, style: { color: "var(--accent)" } }) : null,
      wetterZeile(place.weather) ? el("span.mbadge", { text: wetterZeile(place.weather) }) : null,
      SOURCE_LABEL[place.source] ? el("span.mbadge", { text: SOURCE_LABEL[place.source] }) : null,
    ]),
  ]);
};

/** Klick auf die ganze Karte: Eigentümer kommen in den Editor, Gäste haben
 * dort nichts zu bearbeiten (der Klick tat bisher schlicht nichts) — für sie
 * öffnet er stattdessen, falls vorhanden, gleich das erste Foto groß. */
function kartenKlick(oeffneEditor, fotos) {
  if (!state.gast) return oeffneEditor;
  if (!fotos.length) return () => {};
  return () => zeigeFoto(tripSlides, photoSlideIndex.get(fotos[0].id) ?? 0);
}

function fotoStreifen(fotos) {
  if (!fotos.length) return null;
  return el("div.j-photos", {}, fotos.map((f) => el("img", {
    src: bildUrl(f.id), loading: "lazy", alt: "",
    // Nicht auch noch den Ort/die Notiz öffnen — das Bild antippen soll nur
    // groß zeigen, nichts zum Bearbeiten aufmachen.
    on: { click: (e) => { e.stopPropagation(); zeigeFoto(tripSlides, photoSlideIndex.get(f.id) ?? 0); } },
  })));
}

let openPlace = () => {};
let openNote = () => {};
let openTag = () => {};
let logFilters = new Set(["night", "place", "note"]);
const spurAnfrage = new Map();

export function initJournal({ onPlaceClick, onNoteClick, onTagClick }) {
  openPlace = onPlaceClick;
  openNote = onNoteClick;
  openTag = onTagClick || (() => {});

  $$("#log-menue [data-log-filter]").forEach((sw) => {
    sw.addEventListener("click", () => {
      const key = sw.dataset.logFilter || "";
      if (!key) return;
      if (logFilters.has(key)) logFilters.delete(key);
      else logFilters.add(key);
      renderJournal();
    });
  });

  // Das "⋯"-Menü: Hinzufügen und Anzeige-Schalter in einer zweiten Ebene.
  const knopf = $("#log-mehr-btn");
  const menue = $("#log-menue");
  const schliessen = () => { menue?.classList.remove("open"); knopf?.setAttribute("aria-expanded", "false"); };
  knopf?.addEventListener("click", (e) => {
    e.stopPropagation();
    const offen = !menue.classList.contains("open");
    menue.classList.toggle("open", offen);
    knopf.setAttribute("aria-expanded", String(offen));
  });
  menue?.querySelector("#log-add")?.addEventListener("click", schliessen);
  document.addEventListener("click", (e) => {
    if (menue?.classList.contains("open") && !menue.contains(e.target) && !knopf.contains(e.target)) schliessen();
  });
}

const dayKey = localDayKey;

const dayLabel = (key) => {
  const d = new Date(key + "T12:00:00");
  return Number.isNaN(d.getTime())
    ? "Ohne Datum"
    : d.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
};

const timeLabel = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
};

const noteTitle = (note) => {
  const title = String(note.title || "").trim();
  if (title) return title;
  const text = String(note.text || "").trim().replace(/\s+/g, " ");
  return text ? (text.length > 48 ? `${text.slice(0, 47).trim()}…` : text) : "Notiz";
};

/** Alle Einträge einer Reise als flache, chronologische Liste. */
function entriesOf(trip) {
  const entries = [];
  for (const p of tripPlaces(trip.id)) {
    if (p.catId !== "uebernachtung") {
      entries.push({ kind: "place", at: p.at || "", data: p });
      continue;
    }
    const nights = Number.isInteger(p.nights) && p.nights > 0 ? p.nights : 1;
    for (let i = 0; i < nights; i++) {
      entries.push({
        kind: i ? "night-continuation" : "place",
        at: i ? shiftIsoByLocalDays(p.at, i) : p.at || "",
        data: p,
        nightIndex: i + 1,
      });
    }
  }
  for (const n of tripNotes(trip.id)) entries.push({ kind: "note", at: n.at || "", data: n });
  return entries.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** Nach Tagen gruppieren, Reihenfolge bleibt chronologisch. */
function groupByDay(entries) {
  const days = new Map();
  for (const e of entries) {
    const key = dayKey(e.at);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(e);
  }
  return [...days.entries()];
}

function matchesLogFilter(entry) {
  if (!logFilters.size) return false;
  if (logFilters.has("note") && entry.kind === "note") return true;
  if (logFilters.has("night") && (entry.kind === "place" || entry.kind === "night-continuation") && entry.data.catId === "uebernachtung") return true;
  if (logFilters.has("place") && entry.kind === "place" && entry.data.catId !== "uebernachtung") return true;
  return false;
}

function renderLogFilterButtons() {
  $$("#log-menue [data-log-filter]").forEach((sw) => {
    sw.setAttribute("aria-checked", String(logFilters.has(sw.dataset.logFilter)));
  });
  // Ein Punkt am "⋯"-Knopf zeigt, dass etwas ausgeblendet ist.
  $("#log-mehr-btn")?.classList.toggle("hat-filter", logFilters.size < 3);
}

/* ---------- Bausteine ---------- */

const SVG_NS = "http://www.w3.org/2000/svg";
const svgEl = (name, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

const QUELLE = { camper: "Camper", handy: "Handy", manuell: "von Hand" };
const kmText = (km) => km.toLocaleString("de-DE", { maximumFractionDigits: km < 100 ? 1 : 0 });

/** Eintrag zählt als eigene Station (nicht nur als Zeile im Verlauf), wenn man etwas dazugeschrieben hat. */
const istStation = (place) => Boolean(place.note) || placePhotos(place.id).length > 0 || place.stars > 0 || place.catId !== "stopp";

/** Fotos der Lightbox-Reihe hinzufügen (in Anzeigereihenfolge) und die Collage bauen. */
function fotoCollage(fotos, info) {
  if (!fotos.length) return null;
  for (const f of fotos) {
    photoSlideIndex.set(f.id, tripSlides.length);
    tripSlides.push({ url: bildUrl(f.id), info });
  }
  const zeigen = fotos.slice(0, 3);
  const bild = (f) => el("img", {
    src: bildUrl(f.id), loading: "lazy", alt: "",
    on: { click: (e) => { e.stopPropagation(); zeigeFoto(tripSlides, photoSlideIndex.get(f.id) ?? 0); } },
  });
  const mehr = fotos.length - zeigen.length;
  return el(`div.jt-fotos.jt-fotos-${zeigen.length}`, {}, [
    ...zeigen.map(bild),
    mehr > 0 ? el("span.jt-mehr", { text: `+${mehr}` }) : null,
  ]);
}

const KARTE_B = 340, KARTE_H = 150;

/** Mini-Karte des Tages: echte Kartenkacheln (Wasser, Wald, Straßen, Ortsnamen) mit der Route darüber. */
function kartenbild(tag) {
  const ansicht = kartenAnsicht(tag.punkte, KARTE_B, KARTE_H);
  if (!ansicht) return null;
  const vorlage = kachelUrl(gueltigerKartenstil(state.config.kartenstil), CARTO_KEY);
  const svg = svgEl("svg", { viewBox: `0 0 ${KARTE_B} ${KARTE_H}`, width: KARTE_B, height: KARTE_H, class: "jt-route", role: "img", "aria-label": "Route des Tages" });
  const d = routenPfad(tag.punkte, ansicht.projiziere);
  // Dunkler Rand unter der Linie, damit sie auf hellem wie dunklem Grund lesbar bleibt.
  svg.appendChild(svgEl("path", { d, fill: "none", stroke: "rgba(8,20,22,.55)", "stroke-width": 6, "stroke-linecap": "round", "stroke-linejoin": "round" }));
  svg.appendChild(svgEl("path", { d, fill: "none", stroke: "var(--accent)", "stroke-width": 3.2, "stroke-linecap": "round", "stroke-linejoin": "round" }));
  const punkt = (lon, lat, r, fuell) => {
    const q = ansicht.projiziere(lon, lat);
    svg.appendChild(svgEl("circle", { cx: q.x.toFixed(1), cy: q.y.toFixed(1), r, fill: fuell, stroke: "rgba(8,20,22,.7)", "stroke-width": 1.5 }));
  };
  for (const e of tag.eintraege) {
    if (e.kind === "place" && e.data.catId !== "uebernachtung" && Number.isFinite(e.data.lon)) punkt(e.data.lon, e.data.lat, 3.5, "#c9d6d2");
  }
  const erster = tag.punkte[0], letzter = tag.punkte[tag.punkte.length - 1];
  punkt(erster.lon, erster.lat, 5, "#fff");
  punkt(letzter.lon, letzter.lat, 5, "var(--accent)");

  const buehne = el("div.jt-buehne", { style: { width: `${KARTE_B}px`, height: `${KARTE_H}px` } }, [
    ...ansicht.kacheln.map((k) => el(`img.jt-kachel${gueltigerKartenstil(state.config.kartenstil) === "dezent" ? ".jt-kachel-dezent" : ""}`, {
      src: kachelAdresse(vorlage, k), alt: "", loading: "lazy", draggable: "false",
      style: { left: `${k.links.toFixed(1)}px`, top: `${k.oben.toFixed(1)}px` },
    })),
    svg,
  ]);
  const box = el("div.jt-kartenbild", {}, [buehne, el("span.jt-quelle", { text: "© OpenStreetMap · © CARTO" })]);
  // Die Bühne hat feste Maße (Kacheln sind Pixel); auf die tatsächliche Kartenbreite skalieren.
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => { buehne.style.transform = `scale(${box.clientWidth / KARTE_B})`; }).observe(box);
  }
  return box;
}

/** Verlauf des Tages: Start, Stopps, Übernachtung. Ohne Erzählung offen, sonst eine graue Zeile. */
function verlaufBlock(tag, offen, km = 0) {
  if (!tag.verlauf.length) return null;
  const stopps = tag.verlauf.filter((v) => v.art === "stopp").length;
  const kopf = [stopps ? `Unterwegs · ${stopps} ${stopps === 1 ? "Stopp" : "Stopps"}` : "Verlauf", km ? `${kmText(km)} km` : ""].filter(Boolean).join(" · ");
  const zeile = (v) => el("div.jt-vz", {}, [
    el("span.jt-zeit", { text: timeLabel(v.zeit) }),
    el(`span.jt-vi${v.art === "nacht" ? ".jt-nacht" : ""}`, {}, icon(v.art === "nacht" ? ICON.moon : v.art === "start" ? ICON.play : ICON.pin, 14)),
    el("span", { text: v.art === "start" ? (v.titel ? `Los in ${v.titel}` : "Losgefahren") : v.titel }),
  ]);
  return el("details.jt-verlauf", { open: offen }, [el("summary", { text: kopf }), el("div.jt-vliste", {}, tag.verlauf.map(zeile))]);
}

// Standardmäßig sind Strecke und Stellplatz-/Orts-Karten zu; aufgeklappte merkt sich das Gerät.
const KARTE_OFFEN_KEY = "vojago.logbuch.karteOffen";
const PLATZ_OFFEN_KEY = "vojago.logbuch.platzOffen";
const ladeOffen = (key = KARTE_OFFEN_KEY) => { try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); } catch { return new Set(); } };
const speichereOffen = (menge, key = KARTE_OFFEN_KEY) => { try { localStorage.setItem(key, JSON.stringify([...menge].slice(-600))); } catch { /* Speicher blockiert */ } };

/**
 * Strecke des Tages: Karte, Wetter, Kilometer und Verlauf. Bleibt auch bei einem
 * erzählten Tag stehen, lässt sich aber einklappen (der Zustand wird je Tag gemerkt).
 */
function gedankenstuetze(tag, hatErzaehlung, zeile, tripId) {
  const zeichnung = kartenbild(tag);
  const wetter = tag.wetter;
  const verlauf = verlaufBlock(tag, !hatErzaehlung);
  const info = Boolean(wetter || zeile);
  if (!zeichnung && !info && !verlauf) return null;
  const kurz = [wetter ? [wetter.symbol, wetter.temp].filter(Boolean).join(" ") : "", tag.km ? `${kmText(tag.km)} km` : ""].filter(Boolean).join(" · ");
  const schluessel = `${tripId}|${tag.key}`;
  const karte = el("details.jt-karte", { open: ladeOffen().has(schluessel) }, [
    el("summary.jt-karte-kopf", {}, [
      el("span", { text: zeichnung ? "Strecke" : "Verlauf" }),
      kurz ? el("span.jt-leise.jt-karte-kurz", { text: kurz }) : null,
    ]),
    zeichnung,
    info ? el("div.jt-wetter", {}, [
      wetter ? el("span", { text: [wetter.symbol, wetter.temp].filter(Boolean).join(" ") }) : null,
      wetter?.text ? el("span.jt-leise", { text: wetter.text }) : null,
      zeile ? el("span.jt-leise.jt-strecke", { text: zeile }) : null,
    ]) : null,
    verlauf,
  ]);
  karte.addEventListener("toggle", () => {
    const offen = ladeOffen();
    if (karte.open) offen.add(schluessel); else offen.delete(schluessel);
    speichereOffen(offen);
  });
  return karte;
}

function stars(n) { return n ? "★".repeat(n) + "☆".repeat(5 - n) : ""; }

/** Anmerkung zum Stellplatz: Text bzw. leise Einladung; ein Tipp öffnet nur ein kleines Textfeld. */
function anmerkung(place) {
  const wrap = el("div.jt-anm");
  const lesen = () => {
    if (place.note) {
      const text = el("p.jt-anm-text", { text: place.note });
      const lang = place.note.length > 140;
      if (lang) text.classList.add("jt-gekuerzt");
      render(wrap, [text, lang ? el("button.jt-mehrlink", { type: "button", text: "mehr", on: { click: (e) => { text.classList.remove("jt-gekuerzt"); e.currentTarget.remove(); } } }) : null]);
    } else if (!state.gast) {
      render(wrap, el("button.jt-anm-leer", { type: "button", text: "Anmerkung zum Stellplatz …", on: { click: schreiben } }));
    } else render(wrap, []);
  };
  const schreiben = () => {
    const feld = el("textarea.jt-anm-feld", { rows: 2, maxlength: 600, placeholder: "z. B. schöne Aussicht, schwierige Anfahrt, kostet zu viel", "aria-label": "Anmerkung zum Stellplatz" });
    feld.value = place.note || "";
    const speichern = async (e) => {
      const knopf = e.currentTarget;
      knopf.disabled = true;
      const ok = await speichereOrt({ ...place, note: feld.value.trim() });
      if (ok) toast("Anmerkung gespeichert"); else knopf.disabled = false;
    };
    render(wrap, [feld, el("div.jt-anm-knoepfe", {}, [
      el("button.jt-btn", { type: "button", text: "Speichern", on: { click: speichern } }),
      el("button.jt-btn.jt-btn-leise", { type: "button", text: "Abbrechen", on: { click: lesen } }),
    ])]);
    feld.focus();
  };
  lesen();
  return wrap;
}

function detailsBlock(place) {
  const kv = (k, v) => (v ? el("div.jt-kv", {}, [el("span", { text: k }), el("em", { text: v })]) : null);
  return el("details.jt-details", {}, [
    el("summary", { text: "Details" }),
    kv("Ankunft", timeLabel(place.at)),
    kv("Wetter", wetterZeile(place.weather)),
    kv("Bewertung", stars(place.stars)),
    kv("Kategorie", category(place.catId)?.name),
    kv("Erfasst", place.stopKey ? "automatisch erkannt" : QUELLE[place.source]),
    kv("Adresse", place.address),
    kv("Koordinaten", Number.isFinite(place.lat) ? `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}` : ""),
    state.gast ? null : el("button.jt-btn", { type: "button", text: "Bearbeiten", on: { click: () => openPlace(place) } }),
  ]);
}

/** Besuchsnummer desselben Ortes über alle Reisen ("2. Besuch hier"), sonst leer. */
function besuchsText(place) {
  if (!place.ortId) return "";
  const alle = state.places.filter((p) => p.ortId === place.ortId).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const i = alle.findIndex((p) => p.id === place.id);
  return alle.length > 1 && i >= 0 ? `${i + 1}. Besuch hier` : "";
}

/** Stellplatz-Karte (Übernachtung) bzw. Station (eigener Stopp/Ort mit Text, Foto oder Bewertung). */
function platzKarte(entry) {
  const place = entry.data;
  const nacht = place.catId === "uebernachtung";
  const folge = entry.kind === "night-continuation";
  if (folge) {
    return el("div.jt-folge", {}, [
      el("span", {}, icon(ICON.moon, 14)),
      el("span", { text: `${place.title} · Nacht ${entry.nightIndex} von ${place.nights}` }),
    ]);
  }
  const fotos = placePhotos(place.id);
  // Die Kopfzeile klappt die Karte ein und aus; Bearbeiten steckt unter "Details".
  const kopf = el("summary.jt-ph", {}, [
    el(`b${nacht ? ".jt-nacht-titel" : ""}`, {}, [
      el(`span.jt-ikon${nacht ? ".jt-nacht" : ""}`, {}, icon(nacht ? ICON.moon : ICON.pin, 16)),
      place.title,
    ]),
    el("span.jt-leise", { text: nacht ? (place.nights > 1 ? `${place.nights} Nächte` : "1 Nacht") : timeLabel(place.at) }),
  ]);
  const meta = [stars(place.stars), besuchsText(place)].filter(Boolean);
  const karte = el(`details.jt-platz${nacht ? ".jt-stellplatz" : ""}`, { open: ladeOffen(PLATZ_OFFEN_KEY).has(place.id) }, [
    kopf,
    meta.length ? el("div.jt-meta", {}, meta.map((m) => el("span", { text: m, style: m.startsWith("★") ? { color: "var(--accent)" } : {} }))) : null,
    anmerkung(place),
    fotoCollage(fotos, placeCaption(place)),
    detailsBlock(place),
  ]);
  karte.addEventListener("toggle", (e) => {
    // Nur das Ein-/Ausklappen der Karte selbst, nicht das der "Details" darin.
    if (e.target !== karte) return;
    const offen = ladeOffen(PLATZ_OFFEN_KEY);
    if (karte.open) offen.add(place.id); else offen.delete(place.id);
    speichereOffen(offen, PLATZ_OFFEN_KEY);
  });
  return karte;
}

/** Der Titel einer Notiz ist nur dann eine eigene Zeile, wenn er nicht bloß der Textanfang ist. */
function notizTitelEigen(note) {
  const titel = String(note.title || "").trim().replace(/…$/, "");
  const text = String(note.text || "").trim().replace(/\s+/g, " ");
  return Boolean(titel) && !text.startsWith(titel);
}

const NOTIZ_OFFEN_KEY = "vojago.logbuch.notizOffen";

/** Eine Notiz als einklappbares Zitat: zu nur der Anfang mit Uhrzeit, auf der ganze Text mit Fotos. */
function notizZitat(note) {
  const fotos = notePhotos(note.id);
  const ort = note.besuchId ? state.places.find((p) => p.id === note.besuchId) : null;
  const kurz = (notizTitelEigen(note) ? noteTitle(note) : String(note.text || "")).trim().replace(/\s+/g, " ");
  const karte = el("details.jt-notiz", { open: ladeOffen(NOTIZ_OFFEN_KEY).has(note.id) }, [
    el("summary.jt-ph", {}, [
      el("span.jt-n-kurz", { text: kurz || "Notiz" }),
      el("span.jt-leise", { text: timeLabel(note.at) }),
    ]),
    el("div.jt-n-inhalt", { on: { click: kartenKlick(() => openNote(note), fotos) } }, [
      notizTitelEigen(note) ? el("b", { text: noteTitle(note) }) : null,
      el("p", { text: note.text }),
      fotoCollage(fotos, noteCaption(note)),
      ort ? el("div.jt-meta", {}, [el("span", { text: `bei ${ort.title}` })]) : null,
    ]),
  ]);
  karte.addEventListener("toggle", () => {
    const offen = ladeOffen(NOTIZ_OFFEN_KEY);
    if (karte.open) offen.add(note.id); else offen.delete(note.id);
    speichereOffen(offen, NOTIZ_OFFEN_KEY);
  });
  return karte;
}

/** Lightbox-Beschriftung zu einem Tagebuch-Foto: Tag und Anfang des Textes. */
function tagebuchCaption(eintrag, tag) {
  const erster = eintrag.blocks.find((b) => b.t === "text" && b.text.trim());
  return el("div", {}, [
    el("div.j-head", {}, [el("b", { text: `Tag ${tag.nummer} · ${dayLabel(tag.key)}` })]),
    erster ? el("p", { text: erster.text.length > 160 ? `${erster.text.slice(0, 159).trim()}…` : erster.text }) : null,
  ]);
}

function titelbild(foto, info) {
  photoSlideIndex.set(foto.id, tripSlides.length);
  tripSlides.push({ url: bildUrl(foto.id), info });
  return el("figure.jt-titel", {}, [el("img", {
    src: bildUrl(foto.id), alt: "", loading: "lazy",
    on: { click: () => zeigeFoto(tripSlides, photoSlideIndex.get(foto.id) ?? 0) },
  })]);
}

/** Der erzählte Tag: Titelbild, dann Absätze und Fotos in der Reihenfolge des Textes, am Ende der Autor. */
function tagebuchBlock(eintrag, tag) {
  const fotos = new Map(tagebuchFotos(eintrag.id).map((f) => [f.id, f]));
  const info = tagebuchCaption(eintrag, tag);
  const coverId = titelbildId(eintrag.blocks.filter((b) => b.t !== "fotos" || b.ids.some((id) => fotos.has(id)))
    .map((b) => (b.t === "fotos" ? { ...b, ids: b.ids.filter((id) => fotos.has(id)) } : b)));
  const cover = coverId ? fotos.get(coverId) : null;
  const rest = ohneFoto(eintrag.blocks, cover?.id);
  const autor = eintrag.author || "";
  return el("div.jt-erzaehlt", {}, [
    cover ? titelbild(cover, info) : null,
    ...rest.map((b) => {
      if (b.t === "text") return el("p.jt-text", { text: b.text });
      return fotoCollage(b.ids.map((id) => fotos.get(id)).filter(Boolean), info);
    }),
    autor || !state.gast ? el("div.jt-autor", {}, [
      autor ? el("span.jt-av", { text: autor.slice(0, 1).toUpperCase(), "aria-hidden": "true" }) : null,
      autor ? el("span", { text: autor }) : null,
      state.gast ? null : el("button.jt-bearbeiten", { type: "button", text: "Bearbeiten", on: { click: () => openTag({ tripId: eintrag.tripId, dayKey: eintrag.dayKey }) } }),
    ]) : null,
  ]);
}

/** Einladung für einen Tag ohne Eintrag. */
function einladung(tag, t) {
  if (state.gast || isRangeTrip(t)) return null;
  const heute = localDayKey(new Date().toISOString());
  const gestern = localDayKey(new Date(Date.now() - 86400000).toISOString());
  const hinweis = tag.key === heute ? "Der heutige Tag wartet auf den Abend."
    : tag.key === gestern ? "Gestern fehlt noch ein Eintrag."
      : "Dazu gibt es noch keinen Eintrag.";
  return el("div.jt-einladung", {}, [
    el("b", { text: `Wie war Tag ${tag.nummer}?` }),
    el("div.jt-leise", { text: hinweis }),
    el("button.jt-btn", { type: "button", text: "Tag erzählen", on: { click: () => openTag({ tripId: t.id, dayKey: tag.key }) } }),
  ]);
}

function tagKapitel(tag, t, eintrag) {
  const sichtbar = tag.eintraege.filter(matchesLogFilter);
  const karten = sichtbar.filter((e) => e.kind === "night-continuation"
    || (e.kind === "place" && (e.data.catId === "uebernachtung" || istStation(e.data))));
  const notizen = sichtbar.filter((e) => e.kind === "note");
  const hatErzaehlung = Boolean(eintrag) || tag.notizen.length > 0;
  const folgeNur = tag.eintraege.some((e) => e.kind === "night-continuation") && !tag.km;
  const zeile = tag.km
    ? (tag.von && tag.nach ? `${kmText(tag.km)} km von ${tag.von} nach ${tag.nach}` : `${kmText(tag.km)} km`)
    : folgeNur ? "Ruhetag am Stellplatz" : "";
  const inhalt = [...karten, ...notizen].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return el("section.jt-tag", { dataset: { tag: tag.key } }, [
    el("header.jt-kopf", {}, [el("span.jt-num", { text: `Tag ${tag.nummer}` }), el("h3", { text: dayLabel(tag.key) })]),
    gedankenstuetze(tag, hatErzaehlung, zeile, t.id),
    ...inhalt.map((e) => (e.kind === "note" ? notizZitat(e.data) : platzKarte(e))),
    eintrag ? tagebuchBlock(eintrag, tag) : einladung(tag, t),
  ]);
}

export function renderJournal() {
  const container = $("#journal");
  const label = $("#journal-trip");
  const context = $("#logbook-trip");
  if (!container) return;

  const t = journalTrip();
  if (!t) {
    if (label) label.textContent = "";
    if (context) context.textContent = "—";
    render(container, el("div.callout", { text: "Keine Reise ausgewählt." }));
    return;
  }

  if (label) label.textContent = `· ${t.name}`;
  if (context) context.textContent = t.name;
  const allEntries = entriesOf(t);
  renderLogFilterButtons();
  // Die Spur (Route und Kilometer der Tage) kommt ohne Zutun nur mit der Karte
  // oder den Tagen in "Reisen" — hier bei Bedarf selbst holen. Danach zeichnet
  // das "tripPath"/"trips"-Ereignis das Logbuch neu.
  // Höchstens einmal pro Minute und Reise: liefert der Server eine leere Spur,
  // löst die Antwort selbst wieder ein Neuzeichnen aus — ohne Bremse eine Schleife.
  const jetzt = Date.now();
  if (!t.path?.length && !isRangeTrip(t) && jetzt - (spurAnfrage.get(t.id) || 0) > 60_000) {
    spurAnfrage.set(t.id, jetzt);
    ensureTripPath(t, { silent: true });
  }
  const fahrten = state.drives.filter((d) => d.tripId === t.id);
  const tagebuch = new Map(state.tagebuch.filter((e) => e.tripId === t.id).map((e) => [e.dayKey, e]));
  const tage = tageDerReise({ startIso: tripStartIso(t), eintraege: allEntries, fahrten, path: t.path || [], zusatzTage: [...tagebuch.keys()] });

  if (!tage.length) {
    render(container, el("div.callout", {
      text: "Für diese Reise gibt es noch keine Einträge. Orte und Notizen erscheinen hier automatisch, sobald du sie erfasst.",
    }));
    return;
  }

  // Foto-Reihe für die Lightbox neu aufbauen: füllt fotoCollage() beim Zeichnen,
  // chronologisch über alle sichtbaren Tage hinweg (respektiert den Filter).
  tripSlides = [];
  photoSlideIndex = new Map();

  const sprung = t.live && tage.length > 1
    ? el("button.jt-sprung", { type: "button", text: "Zum aktuellen Tag", on: { click: () => {
      // Nur im Logbuch-Bereich scrollen: scrollIntoView würde auch den
      // äußeren Bildschirm verschieben und die unten wartenden Blätter freilegen.
      const alle = container.querySelectorAll("section.jt-tag");
      const ziel = alle[alle.length - 1];
      const ansicht = container.closest(".view");
      if (!ziel || !ansicht) return;
      const oben = ansicht.scrollTop + ziel.getBoundingClientRect().top - ansicht.getBoundingClientRect().top - 8;
      ansicht.scrollTo({ top: Math.max(0, oben), behavior: "smooth" });
    } } })
    : null;
  render(container, [sprung, ...tage.map((tag) => tagKapitel(tag, t, tagebuch.get(tag.key)))]);
}
