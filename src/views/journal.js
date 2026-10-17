// Reisetagebuch: die Reise als erzählte Abfolge — durchgehend zu scrollen,
// aber nach Tagen gruppiert. Übernachtungen, Orte und Notizen stehen
// chronologisch untereinander.
import { el, render, $, $$ } from "../dom.js";
import { state, journalTrip, tripPlaces, tripNotes, placePhotos, notePhotos, category } from "../state.js";
import { localDayKey, shiftIsoByLocalDays, tripDayNumberFromKeys, tripStartIso } from "../day-utils.js";
import { photoUrl, sharePhotoUrl } from "../api.js";
import { wetterZeile } from "../store.js";
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
// Welche Tage aufgeklappt sind — nach Tages-Schlüssel, nicht nach Position:
// beim Umschalten eines Filters soll der aufgeklappte Tag aufgeklappt
// bleiben (bzw. zugeklappte zu), auch wenn sich die Liste der Tage dadurch
// verschiebt. null = noch nie gerendert (Startzustand: nur der jüngste Tag).
let offeneTage = null;
let offeneTageTripId = null;

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
    : d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "2-digit" });
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
    const base = { note: "Notizen", place: "Orte", night: "Übernachtungen" }[key] || btn.textContent;
    btn.textContent = base;
  });
}

function placeKindLabel(place, entry) {
  if (place.catId === "uebernachtung") return `Übernachtung (${entry.nightIndex || 1})`;
  // Bisher stand hier immer pauschal "Ort" — seit es mit "Stopp" eine
  // zweite automatisch erkannte Kategorie gibt, ist das zu ungenau: man
  // sähe im "Orte"-Filter keinen Unterschied zwischen einem Stellplatz und
  // einem automatisch erkannten Kurzstopp. Der echte Kategoriename macht
  // das sichtbar (Nutzerfrage, 06.09.2026: "wo sehe ich die Stopps?").
  return category(place.catId)?.name || "Ort";
}

function placeEntry(entry) {
  const place = entry.data;
  // Nicht mehr auf Übernachtungen beschränkt (Nutzerwunsch, 6. September
  // 2026: konsistent für alle automatisch erkannten Einträge, auch
  // "Stopp" — das Editor-Fenster selbst zeigt dieses Symbol jetzt bewusst
  // NICHT mehr, damit es nicht doppelt vorkommt).
  const automatic = Boolean(place.stopKey);
  const source = place.source !== "camper" ? (place.source === "handy" ? "zu Fuß" : "manuell") : null;
  const fotos = placePhotos(place.id);
  return el("article.j-entry", { on: { click: kartenKlick(() => openPlace(place), fotos) } }, [
    el("div.j-time", { text: timeLabel(entry.at || place.at) }),
    el("div.j-card", {}, [
      el("div.j-body", {}, [
        el("div.j-head", {}, [
          el("b", { text: place.title }),
          el("span.j-attrs", {}, [
            source ? el("span.j-attr", { text: source }) : null,
            automatic ? el("span.j-attr.j-auto", { text: "↻", title: "automatisch erkannt" }) : null,
            el("span.j-cat", { text: placeKindLabel(place, entry) }),
          ]),
        ]),
        place.note ? el("p", { text: place.note }) : null,
        fotoStreifen(fotos),
      ]),
    ]),
  ]);
}

function nightContinuationEntry(entry) {
  const place = entry.data;
  return el("article.j-entry.j-system", {}, [
    el("div.j-time.j-time-empty", { text: "" }),
    el("div.j-card.j-card-system", {}, [
      el("div.j-body", {}, [
        el("div.j-head", {}, [
          el("b", { text: place.title }),
          el("span.j-attrs", {}, [
            el("span.j-attr.j-auto", { text: "↻", title: "automatisch fortgeführt" }),
            el("span.j-cat", { text: placeKindLabel(place, entry) }),
          ]),
        ]),
      ]),
    ]),
  ]);
}

function noteEntry(note) {
  const fotos = notePhotos(note.id);
  return el("article.j-entry.j-note", { on: { click: kartenKlick(() => openNote(note), fotos) } }, [
    el("div.j-time", { text: timeLabel(note.at) }),
    el("div.j-card.j-card-note", {}, [
      el("div.j-body", {}, [
        el("div.j-head", {}, [
          el("b", { text: noteTitle(note) }),
          el("span.j-attrs", {}, [
            el("span.j-cat.j-cat-note", { text: "Notiz" }),
          ]),
        ]),
        el("p", { text: note.text }),
        fotoStreifen(fotos),
        note.besuchId ? el("div.j-foot", {}, [
          note.besuchId ? el("span.mbadge", {
            text: "bei: " + (state.places.find((p) => p.id === note.besuchId)?.title || "—"),
          }) : null,
        ]) : null,
      ]),
    ]),
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
    offeneTage = null;
    offeneTageTripId = null;
    return;
  }

  if (label) label.textContent = `· ${t.name}`;
  if (context) context.textContent = t.name;
  const allEntries = entriesOf(t);
  renderLogFilterButtons();
  const entries = allEntries.filter(matchesLogFilter);
  const grouped = new Map(groupByDay(entries));
  const startKey = dayKey(tripStartIso(t));
  // Tage, an denen nichts weiter passiert ist als eine automatisch
  // fortgeführte Übernachtung (kein neuer Ort, keine Notiz), verdienen
  // keinen eigenen aufklappbaren Tag — sonst besteht das Logbuch nur aus
  // "↻"-Wiederholungen ohne echten Inhalt.
  const dayKeys = [...grouped.keys()].filter((key) =>
    grouped.get(key).some((e) => e.kind !== "night-continuation"));

  if (!dayKeys.length) {
    render(container, el("div.callout", {
      text: !logFilters.size
        ? "Keine Kategorie ausgewählt."
        : allEntries.length
        ? "Für diesen Filter gibt es keine Einträge."
        : "Für diese Reise gibt es noch keine Einträge. Orte und Notizen erscheinen hier automatisch, sobald du sie erfasst.",
    }));
    return;
  }

  // Andere Reise als beim letzten Rendern? Dann von vorn: nur der jüngste
  // Tag ist zunächst offen, wie beim allerersten Aufruf.
  if (offeneTageTripId !== t.id) {
    offeneTage = null;
    offeneTageTripId = t.id;
  }
  if (offeneTage === null) offeneTage = new Set([dayKeys[dayKeys.length - 1]]);

  // Foto-Reihe für die Lightbox neu aufbauen — chronologisch über alle
  // sichtbaren Tage/Einträge hinweg (respektiert den aktuellen Filter).
  tripSlides = [];
  photoSlideIndex = new Map();
  for (const key of dayKeys) {
    for (const e of grouped.get(key) || []) {
      if (e.kind === "night-continuation") continue;
      const isNote = e.kind === "note";
      const fotos = isNote ? notePhotos(e.data.id) : placePhotos(e.data.id);
      if (!fotos.length) continue;
      // Dieselbe Infokarte für alle Fotos desselben Eintrags — beim
      // Wechsel wird der Knoten einfach neu eingehängt (render() räumt vorher auf).
      const info = isNote ? noteCaption(e.data) : placeCaption(e.data);
      for (const f of fotos) {
        photoSlideIndex.set(f.id, tripSlides.length);
        tripSlides.push({ url: bildUrl(f.id), info });
      }
    }
  }

  render(container, dayKeys.map((key, index) => {
    const dayEntries = grouped.get(key) || [];
    const details = el("details.j-day", { open: offeneTage.has(key) }, [
      el("summary.j-day-head", {}, [
        el("span.j-day-num", { text: `Tag ${tripDayNumberFromKeys(key, startKey) || index + 1}` }),
        el("h3", { text: dayLabel(key) }),
        el("span.j-day-count", { text: dayEntries.length ? `${dayEntries.length} ${dayEntries.length === 1 ? "Eintrag" : "Einträge"}` : "kein Eintrag" }),
      ]),
      dayEntries.length
        ? el("div.j-list", {}, dayEntries.map((e) => {
          if (e.kind === "place") return placeEntry(e);
          if (e.kind === "night-continuation") return nightContinuationEntry(e);
          return noteEntry(e.data);
        }))
        : el("div.callout", { text: "Keine Logbucheinträge an diesem Tag." }),
    ]);
    // Von Hand auf-/zugeklappt — beim nächsten Rendern (z. B. Filterwechsel)
    // soll genau das erhalten bleiben, nicht wieder nur der letzte Tag.
    details.addEventListener("toggle", () => {
      if (details.open) offeneTage.add(key);
      else offeneTage.delete(key);
    });
    return details;
  }));
}
