// Reisetagebuch: die Reise als Folge von Tagen (Kapiteln), durchgehend zu
// scrollen. Jeder Tag hat einen Kopf, eine Gedankenstütze (Route, Wetter,
// Verlauf), Stellplatz-Karten, eigene Stationen und Notizen. Technische
// Angaben stehen eine Ebene tiefer unter "Details".
import { el, render, icon, toast, $, $$ } from "../dom.js";
import { ICON } from "../icons.js";
import { state, journalTrip, tripPlaces, tripNotes, placePhotos, notePhotos, category, isRangeTrip } from "../state.js";
import { localDayKey, shiftIsoByLocalDays, tripStartIso } from "../day-utils.js";
import { speichereOrt, wetterZeile } from "../store.js";
import { ensureTripPath } from "../dataload.js";
import { tageDerReise, routenGeometrie } from "../journal-days.js";
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
let logFilters = new Set(["night", "place", "note"]);
const spurAnfrage = new Map();

export function initJournal({ onPlaceClick, onNoteClick }) {
  openPlace = onPlaceClick;
  openNote = onNoteClick;

  $$("#log-filter button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.logFilter || "";
      if (!key) return;
      if (logFilters.has(key)) logFilters.delete(key);
      else logFilters.add(key);
      renderJournal();
    });
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
  $$("#log-filter button").forEach((btn) => {
    const key = btn.dataset.logFilter || "";
    btn.setAttribute("aria-pressed", String(logFilters.has(key)));
    btn.textContent = { note: "Notizen", place: "Orte", night: "Stellplätze" }[key] || btn.textContent;
  });
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

function routenZeichnung(tag) {
  const B = 260, H = 64;
  const geo = routenGeometrie(tag.punkte, B, H, 8, 80);
  if (!geo) return null;
  const svg = svgEl("svg", { viewBox: `0 0 ${B} ${H}`, class: "jt-route", role: "img", "aria-label": "Route des Tages" });
  svg.appendChild(svgEl("path", { d: geo.d, fill: "none", stroke: "var(--accent)", "stroke-width": 3, "stroke-linecap": "round", "stroke-linejoin": "round" }));
  for (const e of tag.eintraege) {
    if (e.kind !== "place" || e.data.catId === "uebernachtung" || !Number.isFinite(e.data.lon)) continue;
    const q = geo.projiziere(e.data.lon, e.data.lat);
    svg.appendChild(svgEl("circle", { cx: q.x.toFixed(1), cy: q.y.toFixed(1), r: 3, fill: "var(--ink-soft)" }));
  }
  svg.appendChild(svgEl("circle", { cx: geo.start.x.toFixed(1), cy: geo.start.y.toFixed(1), r: 4, fill: "var(--ink)" }));
  svg.appendChild(svgEl("circle", { cx: geo.ende.x.toFixed(1), cy: geo.ende.y.toFixed(1), r: 4, fill: "var(--accent)" }));
  return svg;
}

/** Verlauf des Tages: Start, Stopps, Übernachtung. Ohne Erzählung offen, sonst eine graue Zeile. */
function verlaufBlock(tag, offen) {
  if (!tag.verlauf.length) return null;
  const stopps = tag.verlauf.filter((v) => v.art === "stopp").length;
  const kopf = stopps ? `Unterwegs · ${stopps} ${stopps === 1 ? "Stopp" : "Stopps"}` : "Verlauf";
  const zeile = (v) => el("div.jt-vz", {}, [
    el("span.jt-zeit", { text: timeLabel(v.zeit) }),
    el(`span.jt-vi${v.art === "nacht" ? ".jt-nacht" : ""}`, {}, icon(v.art === "nacht" ? ICON.moon : v.art === "start" ? ICON.play : ICON.pin, 14)),
    el("span", { text: v.art === "start" ? (v.titel ? `Los in ${v.titel}` : "Losgefahren") : v.titel }),
  ]);
  return el("details.jt-verlauf", { open: offen }, [el("summary", { text: kopf }), el("div.jt-vliste", {}, tag.verlauf.map(zeile))]);
}

function gedankenstuetze(tag, hatErzaehlung) {
  const zeichnung = routenZeichnung(tag);
  const wetter = tag.wetter;
  const verlauf = verlaufBlock(tag, !hatErzaehlung);
  if (!zeichnung && !wetter && !verlauf) return null;
  return el("div.jt-karte", {}, [
    zeichnung,
    wetter ? el("div.jt-wetter", {}, [
      el("span", { text: [wetter.symbol, wetter.temp].filter(Boolean).join(" ") }),
      wetter.text ? el("span.jt-leise", { text: wetter.text }) : null,
    ]) : null,
    verlauf,
  ]);
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
  const kopf = el("div.jt-ph", {
    on: { click: kartenKlick(() => openPlace(place), fotos) },
    ...(state.gast ? {} : { role: "button", tabindex: "0" }),
  }, [
    el(`b${nacht ? ".jt-nacht-titel" : ""}`, {}, [
      el(`span.jt-ikon${nacht ? ".jt-nacht" : ""}`, {}, icon(nacht ? ICON.moon : ICON.pin, 16)),
      place.title,
    ]),
    el("span.jt-leise", { text: nacht ? (place.nights > 1 ? `${place.nights} Nächte` : "1 Nacht") : timeLabel(place.at) }),
  ]);
  const meta = [stars(place.stars), besuchsText(place), nacht ? "" : "", ].filter(Boolean);
  return el(`article.jt-platz${nacht ? ".jt-stellplatz" : ""}`, {}, [
    kopf,
    meta.length ? el("div.jt-meta", {}, meta.map((m) => el("span", { text: m, style: m.startsWith("★") ? { color: "var(--accent)" } : {} }))) : null,
    anmerkung(place),
    fotoCollage(fotos, placeCaption(place)),
    detailsBlock(place),
  ]);
}

/** Der Titel einer Notiz ist nur dann eine eigene Zeile, wenn er nicht bloß der Textanfang ist. */
function notizTitelEigen(note) {
  const titel = String(note.title || "").trim().replace(/…$/, "");
  const text = String(note.text || "").trim().replace(/\s+/g, " ");
  return Boolean(titel) && !text.startsWith(titel);
}

function notizZitat(note) {
  const fotos = notePhotos(note.id);
  const ort = note.besuchId ? state.places.find((p) => p.id === note.besuchId) : null;
  return el("article.jt-notiz", { on: { click: kartenKlick(() => openNote(note), fotos) } }, [
    notizTitelEigen(note) ? el("b", { text: noteTitle(note) }) : null,
    el("p", { text: note.text }),
    fotoCollage(fotos, noteCaption(note)),
    el("div.jt-meta", {}, [
      el("span", { text: timeLabel(note.at) }),
      ort ? el("span", { text: `bei ${ort.title}` }) : null,
    ]),
  ]);
}

function tagKapitel(tag) {
  const sichtbar = tag.eintraege.filter(matchesLogFilter);
  const karten = sichtbar.filter((e) => e.kind === "night-continuation"
    || (e.kind === "place" && (e.data.catId === "uebernachtung" || istStation(e.data))));
  const notizen = sichtbar.filter((e) => e.kind === "note");
  const hatErzaehlung = tag.notizen.length > 0;
  const folgeNur = tag.eintraege.some((e) => e.kind === "night-continuation") && !tag.km;
  const zeile = tag.km
    ? (tag.von && tag.nach ? `${kmText(tag.km)} km von ${tag.von} nach ${tag.nach}` : `${kmText(tag.km)} km`)
    : folgeNur ? "Ruhetag am Stellplatz" : "";
  const inhalt = [...karten, ...notizen].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return el("section.jt-tag", { dataset: { tag: tag.key } }, [
    el("header.jt-kopf", {}, [
      el("div", {}, [el("span.jt-num", { text: `Tag ${tag.nummer}` }), el("h3", { text: dayLabel(tag.key) })]),
      zeile ? el("div.jt-zeile", { text: zeile }) : null,
    ]),
    gedankenstuetze(tag, hatErzaehlung),
    ...inhalt.map((e) => (e.kind === "note" ? notizZitat(e.data) : platzKarte(e))),
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
  const tage = tageDerReise({ startIso: tripStartIso(t), eintraege: allEntries, fahrten, path: t.path || [] });

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
  render(container, [sprung, ...tage.map(tagKapitel)]);
}
