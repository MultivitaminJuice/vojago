// Travel logbook: the trip as a sequence of days (chapters), scrolling
// continuously. Every day has a heading, a reminder (route, weather, timeline),
// place cards, its own stops and notes. Technical details sit one level deeper
// under "Details". UI texts and CSS classes (jt-*) stay German.
import { el, render, icon, toast, $, $$ } from "../dom.js";
import { ICON } from "../icons.js";
import {
  state,
  journalTrip,
  tripPlaces,
  tripNotes,
  placePhotos,
  notePhotos,
  category,
  isRangeTrip,
  diaryPhotos,
} from "../state.js";
import { localDayKey, shiftIsoByLocalDays, tripStartIso } from "../day-utils.js";
import { storePlace, weatherLine } from "../store.js";
import { ensureTripPath } from "../dataload.js";
import { tripDays } from "../journal-days.js";
import { mapView, tileUrl, routePath } from "../mini-map.js";
import { CARTO_KEY, tileUrl as tileTemplate, validMapStyle } from "../map-style.js";
import { withoutPhoto, coverPhotoId, withUnplacedPhotos } from "../diary.js";
import { photoUrl, sharePhotoUrl } from "../api.js";
import { showPhotos } from "../ui/photo-lightbox.js";

const SOURCE_LABEL = { camper: "🚐 Camper", handy: "🚶 Handy", manuell: "📍 manuell" };

/** Image URL, signed in or as a guest — the guest endpoint needs the sharing
 * token, the owner endpoint the normal session. */
const imageUrl = (id) => (state.guest ? sharePhotoUrl(state.guest.token, id) : photoUrl(id));

// One series per renderJournal() call: all visible photos of the trip (taking
// the current filter into account), in time order — so previous/next in the
// lightbox pages on past a note or place, not only within one card.
let tripSlides = [];
let photoSlideIndex = new Map();

const dateTimeLabel = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString("de-DE", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
};

/** Builds the same heading/text/badge structure as the real logbook card
 * (.j-head/.j-attrs/.j-cat/.j-foot/.mbadge) — the info card above the photo
 * should look like a piece of the logbook, not like a style of its own. */
const noteCaption = (note) => {
  const linkedPlace = note.besuchId ? state.places.find((p) => p.id === note.besuchId) : null;
  return el("div", {}, [
    el("div.j-head", {}, [
      el("b", { text: noteTitle(note) }),
      el("span.j-attrs", {}, [el("span.j-cat.j-cat-note", { text: "Notiz" })]),
    ]),
    note.text ? el("p", { text: note.text }) : null,
    el("div.j-foot", {}, [
      dateTimeLabel(note.at) ? el("span.mbadge", { text: dateTimeLabel(note.at) }) : null,
      weatherLine(note.weather) ? el("span.mbadge", { text: weatherLine(note.weather) }) : null,
      linkedPlace ? el("span.mbadge", { text: `bei: ${linkedPlace.title}` }) : null,
    ]),
  ]);
};
const placeCaption = (place) => {
  const catLabel =
    place.catId === "uebernachtung"
      ? `Übernachtung${place.nights > 1 ? ` (${place.nights} Nächte)` : ""}`
      : category(place.catId)?.name || "Ort";
  const starText = place.stars ? "★".repeat(place.stars) + "☆".repeat(5 - place.stars) : "";
  return el("div", {}, [
    el("div.j-head", {}, [
      el("b", { text: place.title }),
      el("span.j-attrs", {}, [el("span.j-cat", { text: catLabel })]),
    ]),
    place.note ? el("p", { text: place.note }) : null,
    el("div.j-foot", {}, [
      dateTimeLabel(place.at) ? el("span.mbadge", { text: dateTimeLabel(place.at) }) : null,
      starText ? el("span.mbadge", { text: starText, style: { color: "var(--accent)" } }) : null,
      weatherLine(place.weather) ? el("span.mbadge", { text: weatherLine(place.weather) }) : null,
      SOURCE_LABEL[place.source] ? el("span.mbadge", { text: SOURCE_LABEL[place.source] }) : null,
    ]),
  ]);
};

/** A tap on the whole card: owners get the editor; guests have nothing to edit
 * there (the tap used to do nothing) — for them it opens the first photo large,
 * if there is one. */
function cardClick(oeffneEditor, photoMap) {
  if (!state.guest) return oeffneEditor;
  if (!photoMap.length) return () => {};
  return () => showPhotos(tripSlides, photoSlideIndex.get(photoMap[0].id) ?? 0);
}

/** @type {(...args: any[]) => void} */
let openPlace = () => {};
/** @type {(...args: any[]) => void} */
let openNote = () => {};
/** @type {(...args: any[]) => void} */
let openDay = () => {};
const logFilters = new Set(["night", "place", "note"]);
const trackRequested = new Map();

export function initJournal({ onPlaceClick, onNoteClick, onTagClick }) {
  openPlace = onPlaceClick;
  openNote = onNoteClick;
  openDay = onTagClick || (() => {});

  $$("#log-menue [data-log-filter]").forEach((sw) => {
    sw.addEventListener("click", () => {
      const key = sw.dataset.logFilter || "";
      if (!key) return;
      if (logFilters.has(key)) logFilters.delete(key);
      else logFilters.add(key);
      renderJournal();
    });
  });

  // The "⋯" menu: adding and display switches on a second level.
  const button = $("#log-mehr-btn");
  const menu = $("#log-menue");
  const close = () => {
    menu?.classList.remove("open");
    button?.setAttribute("aria-expanded", "false");
  };
  button?.addEventListener("click", (e) => {
    e.stopPropagation();
    const openSet = !menu.classList.contains("open");
    menu.classList.toggle("open", openSet);
    button.setAttribute("aria-expanded", String(openSet));
  });
  menu?.querySelector("#log-add")?.addEventListener("click", close);
  document.addEventListener("click", (e) => {
    if (menu?.classList.contains("open") && !menu.contains(e.target) && !button.contains(e.target))
      close();
  });
}

const dayLabel = (key) => {
  const d = new Date(`${key}T12:00:00`);
  return Number.isNaN(d.getTime())
    ? "Ohne Datum"
    : d.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
};

const timeLabel = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
};

const noteTitle = (note) => {
  const title = String(note.title || "").trim();
  if (title) return title;
  const text = String(note.text || "")
    .trim()
    .replace(/\s+/g, " ");
  return text ? (text.length > 48 ? `${text.slice(0, 47).trim()}…` : text) : "Notiz";
};

/** All entries of a trip as a flat list in time order. */
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

function matchesLogFilter(entry) {
  if (!logFilters.size) return false;
  if (logFilters.has("note") && entry.kind === "note") return true;
  if (
    logFilters.has("night") &&
    (entry.kind === "place" || entry.kind === "night-continuation") &&
    entry.data.catId === "uebernachtung"
  )
    return true;
  if (logFilters.has("place") && entry.kind === "place" && entry.data.catId !== "uebernachtung")
    return true;
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

const ATTRIBUTION = { camper: "Camper", handy: "Handy", manuell: "von Hand" };
const kmText = (km) => km.toLocaleString("de-DE", { maximumFractionDigits: km < 100 ? 1 : 0 });

/** An entry counts as its own stop (not only a line in the timeline) when something was written about it. */
const isStation = (place) =>
  Boolean(place.note) ||
  placePhotos(place.id).length > 0 ||
  place.stars > 0 ||
  place.catId !== "stopp";

/** Add photos to the lightbox series (in display order) and build the collage. */
function photoCollage(photoMap, info) {
  if (!photoMap.length) return null;
  for (const f of photoMap) {
    photoSlideIndex.set(f.id, tripSlides.length);
    tripSlides.push({ url: imageUrl(f.id), info });
  }
  const show = photoMap.slice(0, 3);
  const image = (f) =>
    el("img", {
      src: imageUrl(f.id),
      loading: "lazy",
      alt: "",
      on: {
        click: (e) => {
          e.stopPropagation();
          showPhotos(tripSlides, photoSlideIndex.get(f.id) ?? 0);
        },
      },
    });
  const moreButton = photoMap.length - show.length;
  return el(`div.jt-fotos.jt-fotos-${show.length}`, {}, [
    ...show.map(image),
    moreButton > 0 ? el("span.jt-mehr", { text: `+${moreButton}` }) : null,
  ]);
}

const MAP_W = 340,
  MAP_H = 150;

/** The day's mini map: real map tiles (water, woods, roads, place names) with the route on top. */
function mapImage(day) {
  const view = mapView(day.points, MAP_W, MAP_H);
  if (!view) return null;
  const template = tileTemplate(validMapStyle(state.config.mapStyle), CARTO_KEY);
  const svg = svgEl("svg", {
    viewBox: `0 0 ${MAP_W} ${MAP_H}`,
    width: MAP_W,
    height: MAP_H,
    class: "jt-route",
    role: "img",
    "aria-label": "Route des Tages",
  });
  const d = routePath(day.points, view.project);
  // A dark edge under the line, so it stays readable on light and dark ground.
  svg.appendChild(
    svgEl("path", {
      d,
      fill: "none",
      stroke: "rgba(8,20,22,.55)",
      "stroke-width": 6,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
  svg.appendChild(
    svgEl("path", {
      d,
      fill: "none",
      stroke: "var(--accent)",
      "stroke-width": 3.2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
  const dot = (lon, lat, r, fill) => {
    const q = view.project(lon, lat);
    svg.appendChild(
      svgEl("circle", {
        cx: q.x.toFixed(1),
        cy: q.y.toFixed(1),
        r,
        fill: fill,
        stroke: "rgba(8,20,22,.7)",
        "stroke-width": 1.5,
      }),
    );
  };
  for (const e of day.entries) {
    if (e.kind === "place" && e.data.catId !== "uebernachtung" && Number.isFinite(e.data.lon))
      dot(e.data.lon, e.data.lat, 3.5, "#c9d6d2");
  }
  const first = day.points[0],
    letzter = day.points[day.points.length - 1];
  dot(first.lon, first.lat, 5, "#fff");
  dot(letzter.lon, letzter.lat, 5, "var(--accent)");

  const stage = el("div.jt-buehne", { style: { width: `${MAP_W}px`, height: `${MAP_H}px` } }, [
    ...view.tiles.map((k) =>
      el(
        `img.jt-kachel${validMapStyle(state.config.mapStyle) === "dezent" ? ".jt-kachel-dezent" : ""}`,
        {
          src: tileUrl(template, k),
          alt: "",
          loading: "lazy",
          draggable: "false",
          style: { left: `${k.left.toFixed(1)}px`, top: `${k.top.toFixed(1)}px` },
        },
      ),
    ),
    svg,
  ]);
  const box = el("div.jt-kartenbild", {}, [
    stage,
    el("span.jt-quelle", { text: "© OpenStreetMap · © CARTO" }),
  ]);
  // The stage has fixed dimensions (tiles are pixels); scaled to the actual map width.
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      stage.style.transform = `scale(${box.clientWidth / MAP_W})`;
    }).observe(box);
  }
  return box;
}

/** The day's timeline: start, stops, overnight stay. Open without a story, otherwise a grey line. */
function timelineBlock(day, openSet, km = 0) {
  if (!day.timeline.length) return null;
  const stopCount = day.timeline.filter((v) => v.kind === "stop").length;
  const heading = [
    stopCount ? `Unterwegs · ${stopCount} ${stopCount === 1 ? "Stopp" : "Stopps"}` : "Verlauf",
    km ? `${kmText(km)} km` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const line = (v) =>
    el("div.jt-vz", {}, [
      el("span.jt-zeit", { text: timeLabel(v.time) }),
      el(
        `span.jt-vi${v.kind === "night" ? ".jt-nacht" : ""}`,
        {},
        icon(v.kind === "night" ? ICON.moon : v.kind === "start" ? ICON.play : ICON.pin, 14),
      ),
      el("span", {
        text: v.kind === "start" ? (v.title ? `Los in ${v.title}` : "Losgefahren") : v.title,
      }),
    ]);
  return el("details.jt-verlauf", { open: openSet }, [
    el("summary", { text: heading }),
    el("div.jt-vliste", {}, day.timeline.map(line)),
  ]);
}

// By default the route (except on days without an entry) and the place cards are closed; what you change is remembered on the device.
const ROUTE_OPEN_KEY = "vojago.logbuch.karteOffen";
const ROUTE_CLOSED_KEY = "vojago.logbuch.karteGeschlossen";
const PLACE_OPEN_KEY = "vojago.logbuch.platzOffen";
const loadOpenSet = (key = ROUTE_OPEN_KEY) => {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || "[]"));
  } catch {
    return new Set();
  }
};
const saveOpenSet = (ids, key = ROUTE_OPEN_KEY) => {
  try {
    localStorage.setItem(key, JSON.stringify([...ids].slice(-600)));
  } catch {
    /* Speicher blockiert */
  }
};

/**
 * The day's route: map, weather, kilometres and timeline. It stays on a told
 * day too but can be collapsed (the state is remembered per day).
 */
function routeCard(day, hasStory, line, tripId, withoutEntry) {
  const drawing = mapImage(day);
  const weather = day.weather;
  const timeline = timelineBlock(day, !hasStory);
  const info = Boolean(weather || line);
  if (!drawing && !info && !timeline) return null;
  const summary = [
    weather ? [weather.symbol, weather.temp].filter(Boolean).join(" ") : "",
    day.km ? `${kmText(day.km)} km` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const storageKey = `${tripId}|${day.key}`;
  const card = /** @type {HTMLDetailsElement} */ (
    el(
      "details.jt-karte",
      {
        open:
          loadOpenSet().has(storageKey) ||
          (withoutEntry && !loadOpenSet(ROUTE_CLOSED_KEY).has(storageKey)),
      },
      [
        el("summary.jt-karte-kopf", {}, [
          el("span", { text: drawing ? "Strecke" : "Verlauf" }),
          summary ? el("span.jt-leise.jt-karte-kurz", { text: summary }) : null,
        ]),
        drawing,
        info
          ? el("div.jt-wetter", {}, [
              weather
                ? el("span", { text: [weather.symbol, weather.temp].filter(Boolean).join(" ") })
                : null,
              weather?.text ? el("span.jt-leise", { text: weather.text }) : null,
              line ? el("span.jt-leise.jt-strecke", { text: line }) : null,
            ])
          : null,
        timeline,
      ],
    )
  );
  card.addEventListener("toggle", () => {
    // Without an entry the route is open by itself — then we remember what was closed.
    const openSet = loadOpenSet();
    const closedSet = loadOpenSet(ROUTE_CLOSED_KEY);
    if (card.open) {
      openSet.add(storageKey);
      closedSet.delete(storageKey);
    } else {
      openSet.delete(storageKey);
      closedSet.add(storageKey);
    }
    saveOpenSet(openSet);
    saveOpenSet(closedSet, ROUTE_CLOSED_KEY);
  });
  return card;
}

function stars(n) {
  return n ? "★".repeat(n) + "☆".repeat(5 - n) : "";
}

/** Remark on a place: the text or a quiet invitation; a tap opens only a small text field. */
function remark(place) {
  const wrap = el("div.jt-anm");
  const showReading = () => {
    if (place.note) {
      const text = el("p.jt-anm-text", { text: place.note });
      const isLong = place.note.length > 140;
      if (isLong) text.classList.add("jt-gekuerzt");
      render(wrap, [
        text,
        isLong
          ? el("button.jt-mehrlink", {
              type: "button",
              text: "mehr",
              on: {
                click: (e) => {
                  text.classList.remove("jt-gekuerzt");
                  e.currentTarget.remove();
                },
              },
            })
          : null,
      ]);
    } else if (!state.guest) {
      render(
        wrap,
        el("button.jt-anm-leer", {
          type: "button",
          text: "Anmerkung zum Stellplatz …",
          on: { click: writeButton },
        }),
      );
    } else render(wrap, []);
  };
  const writeButton = () => {
    const field = /** @type {HTMLTextAreaElement} */ (
      el("textarea.jt-anm-feld", {
        rows: 2,
        maxlength: 600,
        placeholder: "z. B. schöne Aussicht, schwierige Anfahrt, kostet zu viel",
        "aria-label": "Anmerkung zum Stellplatz",
      })
    );
    field.value = place.note || "";
    const saveRemark = async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      const ok = await storePlace({ ...place, note: field.value.trim() });
      if (ok) toast("Anmerkung gespeichert");
      else button.disabled = false;
    };
    render(wrap, [
      field,
      el("div.jt-anm-knoepfe", {}, [
        el("button.jt-btn", { type: "button", text: "Speichern", on: { click: saveRemark } }),
        el("button.jt-btn.jt-btn-leise", {
          type: "button",
          text: "Abbrechen",
          on: { click: showReading },
        }),
      ]),
    ]);
    field.focus();
  };
  showReading();
  return wrap;
}

function detailsBlock(place) {
  const kv = (k, v) =>
    v ? el("div.jt-kv", {}, [el("span", { text: k }), el("em", { text: v })]) : null;
  return el("details.jt-details", {}, [
    el("summary", { text: "Details" }),
    kv("Ankunft", timeLabel(place.at)),
    kv("Wetter", weatherLine(place.weather)),
    kv("Bewertung", stars(place.stars)),
    kv("Kategorie", category(place.catId)?.name),
    kv("Erfasst", place.stopKey ? "automatisch erkannt" : ATTRIBUTION[place.source]),
    kv("Adresse", place.address),
    kv(
      "Koordinaten",
      Number.isFinite(place.lat) ? `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}` : "",
    ),
    state.guest
      ? null
      : el("button.jt-btn", {
          type: "button",
          text: "Bearbeiten",
          on: { click: () => openPlace(place) },
        }),
  ]);
}

/** Visit number of the same place across all trips ("2. Besuch hier"), otherwise empty. */
function visitText(place) {
  if (!place.ortId) return "";
  const all = state.places
    .filter((p) => p.ortId === place.ortId)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const i = all.findIndex((p) => p.id === place.id);
  return all.length > 1 && i >= 0 ? `${i + 1}. Besuch hier` : "";
}

/** Place card (overnight stay) or stop (own stop or place with text, photo or rating). */
function placeCard(entry) {
  const place = entry.data;
  const night = place.catId === "uebernachtung";
  const sequence = entry.kind === "night-continuation";
  if (sequence) {
    return el("div.jt-folge", {}, [
      el("span", {}, icon(ICON.moon, 14)),
      el("span", { text: `${place.title} · Nacht ${entry.nightIndex} von ${place.nights}` }),
    ]);
  }
  const photoMap = placePhotos(place.id);
  // The heading collapses and expands the card; editing sits under "Details".
  const heading = el("summary.jt-ph", {}, [
    el(`b${night ? ".jt-nacht-titel" : ""}`, {}, [
      el(`span.jt-ikon${night ? ".jt-nacht" : ""}`, {}, icon(night ? ICON.moon : ICON.pin, 16)),
      place.title,
    ]),
    el("span.jt-leise", {
      text: night ? (place.nights > 1 ? `${place.nights} Nächte` : "1 Nacht") : timeLabel(place.at),
    }),
  ]);
  const meta = [stars(place.stars), visitText(place)].filter(Boolean);
  const card = /** @type {HTMLDetailsElement} */ (
    el(
      `details.jt-platz${night ? ".jt-stellplatz" : ""}`,
      { open: loadOpenSet(PLACE_OPEN_KEY).has(place.id) },
      [
        heading,
        meta.length
          ? el(
              "div.jt-meta",
              {},
              meta.map((m) =>
                el("span", { text: m, style: m.startsWith("★") ? { color: "var(--accent)" } : {} }),
              ),
            )
          : null,
        remark(place),
        photoCollage(photoMap, placeCaption(place)),
        detailsBlock(place),
      ],
    )
  );
  card.addEventListener("toggle", (e) => {
    // Only the card's own collapsing, not that of the "Details" inside it.
    if (e.target !== card) return;
    const openSet = loadOpenSet(PLACE_OPEN_KEY);
    if (card.open) openSet.add(place.id);
    else openSet.delete(place.id);
    saveOpenSet(openSet, PLACE_OPEN_KEY);
  });
  return card;
}

/** A note's title is only a line of its own when it is not just the start of the text. */
function noteHasOwnTitle(note) {
  const title = String(note.title || "")
    .trim()
    .replace(/…$/, "");
  const text = String(note.text || "")
    .trim()
    .replace(/\s+/g, " ");
  return Boolean(title) && !text.startsWith(title);
}

const NOTE_OPEN_KEY = "vojago.logbuch.notizOffen";

/** A note as a collapsible quote: closed only the start with the time, open the whole text with photos. */
function noteQuote(note) {
  const photoMap = notePhotos(note.id);
  const linkedPlace = note.besuchId ? state.places.find((p) => p.id === note.besuchId) : null;
  const summary = (noteHasOwnTitle(note) ? noteTitle(note) : String(note.text || ""))
    .trim()
    .replace(/\s+/g, " ");
  const card = /** @type {HTMLDetailsElement} */ (
    el("details.jt-notiz", { open: loadOpenSet(NOTE_OPEN_KEY).has(note.id) }, [
      el("summary.jt-ph", {}, [
        el("span.jt-n-kurz", { text: summary || "Notiz" }),
        el("span.jt-leise", { text: timeLabel(note.at) }),
      ]),
      el("div.jt-n-inhalt", { on: { click: cardClick(() => openNote(note), photoMap) } }, [
        noteHasOwnTitle(note) ? el("b", { text: noteTitle(note) }) : null,
        el("p", { text: note.text }),
        photoCollage(photoMap, noteCaption(note)),
        linkedPlace
          ? el("div.jt-meta", {}, [el("span", { text: `bei ${linkedPlace.title}` })])
          : null,
      ]),
    ])
  );
  card.addEventListener("toggle", () => {
    const openSet = loadOpenSet(NOTE_OPEN_KEY);
    if (card.open) openSet.add(note.id);
    else openSet.delete(note.id);
    saveOpenSet(openSet, NOTE_OPEN_KEY);
  });
  return card;
}

/** Lightbox caption for a diary photo: the day and the start of the text. */
function diaryCaption(diaryEntry, day) {
  const first = diaryEntry.blocks.find((b) => b.t === "text" && b.text.trim());
  return el("div", {}, [
    el("div.j-head", {}, [el("b", { text: `Tag ${day.number} · ${dayLabel(day.key)}` })]),
    first
      ? el("p", {
          text: first.text.length > 160 ? `${first.text.slice(0, 159).trim()}…` : first.text,
        })
      : null,
  ]);
}

function coverImage(foto, info) {
  photoSlideIndex.set(foto.id, tripSlides.length);
  tripSlides.push({ url: imageUrl(foto.id), info });
  return el("figure.jt-titel", {}, [
    el("img", {
      src: imageUrl(foto.id),
      alt: "",
      loading: "lazy",
      on: { click: () => showPhotos(tripSlides, photoSlideIndex.get(foto.id) ?? 0) },
    }),
  ]);
}

/** The told day: cover photo, then paragraphs and photos in the order of the text, the author at the end. */
function diaryBlock(diaryEntry, day) {
  const photoMap = new Map(diaryPhotos(diaryEntry.id).map((f) => [f.id, f]));
  const info = diaryCaption(diaryEntry, day);
  // Photos still in the editor's tray appear at the start of the day (one as cover, several as a collage) until they are placed — nothing gets lost.
  const blockList = withUnplacedPhotos(diaryEntry.blocks, [...photoMap.keys()]);
  const coverId = coverPhotoId(
    blockList
      .filter((b) => b.t !== "fotos" || b.ids.some((id) => photoMap.has(id)))
      .map((b) => (b.t === "fotos" ? { ...b, ids: b.ids.filter((id) => photoMap.has(id)) } : b)),
  );
  const cover = coverId ? photoMap.get(coverId) : null;
  const rest = withoutPhoto(blockList, cover?.id);
  const authorName = diaryEntry.author || "";
  return el("div.jt-erzaehlt", {}, [
    cover ? coverImage(cover, info) : null,
    ...rest.map((b) => {
      if (b.t === "text") return el("p.jt-text", { text: b.text });
      return photoCollage(b.ids.map((id) => photoMap.get(id)).filter(Boolean), info);
    }),
    authorName || !state.guest
      ? el("div.jt-autor", {}, [
          authorName
            ? el("span.jt-av", {
                text: authorName.slice(0, 1).toUpperCase(),
                "aria-hidden": "true",
              })
            : null,
          authorName ? el("span", { text: authorName }) : null,
          state.guest
            ? null
            : el("button.jt-bearbeiten", {
                type: "button",
                text: "Bearbeiten",
                on: {
                  click: () => openDay({ tripId: diaryEntry.tripId, dayKey: diaryEntry.dayKey }),
                },
              }),
        ])
      : null,
  ]);
}

/** Invitation for a day without an entry. */
function invitation(day, t) {
  if (state.guest || isRangeTrip(t)) return null;
  const today = localDayKey(new Date().toISOString());
  const yesterday = localDayKey(new Date(Date.now() - 86400000).toISOString());
  const hint =
    day.key === today
      ? "Der heutige Tag wartet auf den Abend."
      : day.key === yesterday
        ? "Gestern fehlt noch ein Eintrag."
        : "Dazu gibt es noch keinen Eintrag.";
  return el("div.jt-einladung", {}, [
    el("b", { text: `Wie war Tag ${day.number}?` }),
    el("div.jt-leise", { text: hint }),
    el("button.jt-btn", {
      type: "button",
      text: "Tag erzählen",
      on: { click: () => openDay({ tripId: t.id, dayKey: day.key }) },
    }),
  ]);
}

function dayChapter(day, t, diaryEntry) {
  const visible = day.entries.filter(matchesLogFilter);
  const cards = visible.filter(
    (e) =>
      e.kind === "night-continuation" ||
      (e.kind === "place" && (e.data.catId === "uebernachtung" || isStation(e.data))),
  );
  const notes = visible.filter((e) => e.kind === "note");
  const hasStory = Boolean(diaryEntry) || day.notes.length > 0;
  const onlyContinuation = day.entries.some((e) => e.kind === "night-continuation") && !day.km;
  const line = day.km
    ? day.from && day.to
      ? `${kmText(day.km)} km von ${day.from} nach ${day.to}`
      : `${kmText(day.km)} km`
    : onlyContinuation
      ? "Ruhetag am Stellplatz"
      : "";
  const content = [...cards, ...notes].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  // The technical side of the day (route, overnight places, places, notes) serves as a reminder while
  // nothing is told yet and stands before the invitation; once the day is told, it moves to the end.
  const facts = [
    routeCard(day, hasStory, line, t.id, !diaryEntry),
    ...content.map((e) => (e.kind === "note" ? noteQuote(e.data) : placeCard(e))),
  ];
  return el("section.jt-tag", { dataset: { day: day.key } }, [
    el("header.jt-kopf", {}, [
      el("span.jt-num", { text: `Tag ${day.number}` }),
      el("h3", { text: dayLabel(day.key) }),
    ]),
    ...(diaryEntry ? [diaryBlock(diaryEntry, day), ...facts] : [...facts, invitation(day, t)]),
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
  // The track (route and kilometres of the days) only comes by itself with the map
  // or the days in "Reisen" — so load it here when needed. Afterwards the
  // "tripPath"/"trips" event redraws the logbook.
  // At most once a minute per trip: if the server returns an empty track, the
  // answer itself triggers a redraw again — without a brake, a loop.
  const now = Date.now();
  if (!t.path?.length && !isRangeTrip(t) && now - (trackRequested.get(t.id) || 0) > 60_000) {
    trackRequested.set(t.id, now);
    ensureTripPath(t, { silent: true });
  }
  const drives = state.drives.filter((d) => d.tripId === t.id);
  const diaryByDay = new Map(
    state.diary.filter((e) => e.tripId === t.id).map((e) => [e.dayKey, e]),
  );
  const chapters = tripDays({
    startIso: tripStartIso(t),
    entries: allEntries,
    drives,
    path: t.path || [],
    extraDays: [...diaryByDay.keys()],
  });

  if (!chapters.length) {
    render(
      container,
      el("div.callout", {
        text: "Für diese Reise gibt es noch keine Einträge. Orte und Notizen erscheinen hier automatisch, sobald du sie erfasst.",
      }),
    );
    return;
  }

  // Rebuild the lightbox photo series: photoCollage() fills it while drawing,
  // in time order across all visible days (respecting the filter).
  tripSlides = [];
  photoSlideIndex = new Map();

  const jumpButton =
    t.live && chapters.length > 1
      ? el("button.jt-sprung", {
          type: "button",
          text: "Zum aktuellen Tag",
          on: {
            click: () => {
              // Scroll only within the logbook area: scrollIntoView would also move the
              // outer screen and reveal the sheets waiting below.
              const target = dayNodes[dayNodes.length - 1];
              const view = container.closest(".view");
              if (!target || !view) return;
              const top =
                view.scrollTop +
                target.getBoundingClientRect().top -
                view.getBoundingClientRect().top -
                8;
              view.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
            },
          },
        })
      : null;
  dayNodes = chapters.map((day) => dayChapter(day, t, diaryByDay.get(day.key)));
  render(container, [jumpButton]);
  columnCount = 0;
  layOutDays(container);
  watchColumns(container);
}

/* ---------- Days in columns (wide windows) ----------
   Our own column containers instead of CSS columns: in CSS columns the position of
   the map tiles (shifted, scaled) is wrong from the second column on. The days are
   dealt out in order (day 1 left, day 2 next to it, day 3 left again …); within a
   column they stay in time order. */
let dayNodes = []; // the drawn days, in order
let columnCount = 0;
let columnObserver = null;
const COLUMN_MIN = 400;
const COLUMN_GAP = 18;
const columnsFor = (width) =>
  Math.max(1, Math.min(3, Math.floor((width + COLUMN_GAP) / (COLUMN_MIN + COLUMN_GAP))));

function layOutDays(container) {
  const n = columnsFor(container.clientWidth);
  if (n === columnCount) return;
  columnCount = n;
  container.querySelector(":scope > .jt-spalten")?.remove();
  for (const day of dayNodes) day.remove();
  if (n === 1) {
    container.append(...dayNodes);
    return;
  }
  const columns = Array.from({ length: n }, () => el("div.jt-spalte"));
  dayNodes.forEach((day, i) => {
    columns[i % n].append(day);
  });
  container.append(el("div.jt-spalten", {}, columns));
}

function watchColumns(container) {
  if (columnObserver || typeof ResizeObserver === "undefined") return;
  columnObserver = new ResizeObserver(() => {
    if (dayNodes.length) layOutDays(container);
  });
  columnObserver.observe(container);
}
