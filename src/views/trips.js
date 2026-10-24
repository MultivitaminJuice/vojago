// Ansicht „Reisen": laufende Reise, frühere Reisen, Alltagsfahrten.
import { el, render, icon, toast, $, $$ } from "../dom.js";
import { ICON } from "../icons.js";
import {
  state, trip, activeTrip, tripPlaces, tripNotes, rangeTrips, isRangeTrip,
  endTrip, resumeTrip, startTrip, deleteTrip, showTripOnMap, showAdhocOnMap, setRouteDriveFilter, emit,
  ROUTE_DRIVE_FILTERS,
} from "../state.js";
import { starterPath } from "../demo.js";
import { drivePath, ensureTripPath, loadDrives, reloadTrips } from "../dataload.js";
import { isConfigured, createTrip, updateTrip, deleteTrip as apiDeleteTrip, assignDrive, updateDriveKind } from "../api.js";
import { wetterZeile } from "../store.js";
import { wireInlineEdit } from "../ui/inline-edit.js";
import { miniRoute, elevationProfile, speedProfile } from "./charts.js";
import { routeSummaryToTrip, summarizeDrive, summarizeTrip, summarizeTripDays } from "../route-summary.js";
import { tagNachbar, tagNavigation } from "../day-nav.js";
import { localDayKey, tripDayNumberForIso, tripDayNumberFromKeys, tripStartIso } from "../day-utils.js";
import { filteredRouteDrives, itemMatchesRouteFilter, visibleRoutePath } from "../route-visibility.js";

const kmText = (n, digits = 0) => Number(n || 0).toLocaleString("de-DE", { maximumFractionDigits: digits });
const datum = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "—";
};
const tagKey = (iso) => {
  return localDayKey(iso);
};
const tagDatum = (key) => {
  const d = key ? new Date(`${key}T12:00:00`) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "2-digit" })
    : "Ohne Datum";
};
const dauer = (minuten) => {
  if (!Number.isFinite(minuten) || minuten <= 0) return "—";
  const h = Math.floor(minuten / 60);
  const m = Math.round(minuten % 60);
  return h ? `${h} Std ${m} min` : `${m} min`;
};
const zeitraumDauer = (start, ende) => {
  const a = Date.parse(start || "");
  const b = Date.parse(ende || new Date().toISOString());
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return "—";
  const stunden = Math.max(1, Math.round((b - a) / 3600000));
  if (stunden < 48) return `${stunden} Std`;
  const tage = Math.max(1, Math.round(stunden / 24));
  return `${tage} Tage`;
};
const reiseZeitraumDauer = (start, ende) => {
  const tage = tripDayNumberForIso(ende || new Date().toISOString(), start);
  if (Number.isFinite(tage) && tage > 1) return `${tage} Tage`;
  return zeitraumDauer(start, ende);
};
let openDetail = () => {};
let goMap = () => {};
let tripMode = "gesamt";
let routeFocus = null;
let rangeFocusTripId = null;
// Für den "Zurück"-Knopf auf der Karte (siehe main.js #map-focus-back):
// merkt sich, wie die Reisen-Ansicht aussah, bevor "Auf Karte zeigen" dorthin
// wechselte, damit "Zurück" wirklich zurückführt (Ansicht + Fahrten-Fokus),
// statt nur die Karte auf die ganze Reise zurückzusetzen.
let kartenRueckkehrKontext = null;
let routeSummaryCache = new Map();
let segmentTabsWired = false;
const driveDayOpen = new Map();
const tripPathLoads = new Set();
const drivePreviewPaths = new Map();
const drivePreviewLoads = new Set();

/** Im verbundenen Betrieb gehören Reisen in die Datenbank, nicht in den Speicher. */
const zentral = () => !state.config.demo && isConfigured();

export function initTrips({ onOpenDetail, onShowMap }) {
  openDetail = onOpenDetail;
  goMap = onShowMap;

  if (!segmentTabsWired) {
    document.addEventListener("click", (event) => {
      const btn = event.target.closest?.("#view-reise .segment-tabs button[data-trip-mode]");
      if (!btn) return;
      if (state.rangeTrip && btn.dataset.tripMode === "fahrten") rangeFocusTripId = null;
      tripMode = btn.dataset.tripMode;
      routeFocus = null;
      closeRouteFilterPicker();
      if (tripMode === "tage") ensurePathForSegments(selectedTrip());
      renderTrips();
    });
    document.addEventListener("click", (event) => {
      if (event.target.closest?.("#route-filter-close")) {
        closeRouteFilterPicker();
        return;
      }
      if (event.target.closest?.("#drive-kind-close")) {
        closeDriveKindPicker();
        return;
      }

      const filterButton = event.target.closest?.("#route-filter-btn");
      if (filterButton) {
        if (state.rangeTrip) toast("Darstellung folgt");
        else openRouteFilterPicker();
        return;
      }

      const filterChoice = event.target.closest?.("#route-filter-picker button[data-route-drive-filter]");
      if (filterChoice) {
        routeFocus = null;
        setRouteDriveFilter(filterChoice.dataset.routeDriveFilter);
        closeRouteFilterPicker();
        return;
      }

      const driveKindChoice = event.target.closest?.("#drive-kind-picker button[data-drive-kind-choice]");
      if (driveKindChoice) {
        setFocusedDriveKind(driveKindChoice.dataset.driveKindChoice, driveKindChoice);
        return;
      }

      if (event.target === $("#route-filter-picker")) closeRouteFilterPicker();
      if (event.target === $("#drive-kind-picker")) closeDriveKindPicker();
    });
    document.addEventListener("click", (event) => {
      const card = event.target.closest?.(".segment-card[data-summary-id]");
      if (!card) return;
      const summary = routeSummaryCache.get(card.dataset.summaryId);
      if (!summary) return;
      routeFocus = summary;
      renderTrips();
    });
    segmentTabsWired = true;
  }

  renderTrips();
}

const ROUTE_FILTER_LABEL = {
  etappe: "Etappen",
  abstecher: "Versorgung",
  alle: "Alle der Reise",
  nicht_zugeordnet: "Nicht zugeordnet",
};

function routeFilter() {
  return ROUTE_DRIVE_FILTERS.includes(state.routeDriveFilter) ? state.routeDriveFilter : "etappe";
}

/** Wie routeFilter(), aber für die Karten-/Tage-/Gesamt-Darstellung: "nicht
 * zugeordnet" ist ein reiner Fahrten-Reiter-Filter (siehe renderDriveSegments)
 * und hätte für Karte/Tage/Gesamt keine sinnvolle Bedeutung — dort zählt er
 * wie "alle". */
function kartenFilter() {
  const f = routeFilter();
  return f === "nicht_zugeordnet" ? "alle" : f;
}

function openRouteFilterPicker() {
  const btn = $("#route-filter-btn");
  const picker = $("#route-filter-picker");
  if (!picker) return;
  renderRouteFilterControls();
  picker.hidden = false;
  if (btn) btn.setAttribute("aria-expanded", "true");
}

function closeRouteFilterPicker() {
  const picker = $("#route-filter-picker");
  const btn = $("#route-filter-btn");
  if (picker) picker.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
}

function openDriveKindPicker() {
  const picker = $("#drive-kind-picker");
  if (!picker || routeFocus?.type !== "fahrt" || !routeFocus.drives?.length) return;
  renderDriveKindPickerControls();
  picker.hidden = false;
}

function closeDriveKindPicker() {
  const picker = $("#drive-kind-picker");
  if (picker) picker.hidden = true;
}

function renderRouteFilterControls() {
  const filter = routeFilter();
  const btn = $("#route-filter-btn");
  if (btn) {
    if (state.rangeTrip) {
      btn.title = "Darstellung";
      btn.setAttribute("aria-label", "Darstellung");
      btn.setAttribute("aria-pressed", "false");
      render(btn, [icon(ICON.layers, 18)]);
    } else {
      btn.title = `Fahrtenfilter: ${ROUTE_FILTER_LABEL[filter]}`;
      btn.setAttribute("aria-label", `Fahrtenfilter: ${ROUTE_FILTER_LABEL[filter]}`);
      btn.setAttribute("aria-pressed", String(filter !== "etappe"));
      render(btn, [icon(ICON.filter, 18)]);
    }
  }
  $$("#route-filter-picker button[data-route-drive-filter]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.routeDriveFilter === filter));
    const marker = button.querySelector("i");
    if (marker) marker.textContent = button.dataset.routeDriveFilter === filter ? "✓" : "";
  });
}

function renderTripModeTabs() {
  const range = Boolean(state.rangeTrip);
  const labels = range
    ? { gesamt: "Gesamt", fahrten: "Reisen", tage: "Tage" }
    : { gesamt: "Gesamt", tage: "Tage", fahrten: "Fahrten" };
  const order = range
    ? { gesamt: 1, fahrten: 2, tage: 3 }
    : { gesamt: 1, tage: 2, fahrten: 3 };
  $$("#view-reise .segment-tabs button[data-trip-mode]").forEach((button) => {
    const mode = button.dataset.tripMode;
    button.textContent = labels[mode] || mode;
    button.style.order = String(order[mode] || 0);
  });
}

function focusRangeTrip(id) {
  if (!state.rangeTrip) return;
  rangeFocusTripId = id && id !== "__range" ? id : null;
  tripMode = "fahrten";
  routeFocus = null;
  const reise = rangeFocusTripId ? trip(rangeFocusTripId) : null;
  if (reise && !reise.path?.length) ensurePathForSegments(reise);
  renderTrips();
}

function renderRangeTripRows() {
  if (!state.rangeTrip) return [];
  const trips = rangeTrips(state.rangeTrip.range);
  return [
    el("button.trip-picker-row", {
      "aria-pressed": String(!rangeFocusTripId),
      on: { click: () => focusRangeTrip("__range") },
    }, [
      el("i", { text: "Z" }),
      el("span", {}, [
        el("b", { text: "Gesamter Zeitraum" }),
        el("small", { text: `${datum(state.rangeTrip.range?.from)} – ${datum(state.rangeTrip.range?.to)}` }),
      ]),
      el("em", { text: `${kmText(state.rangeTrip.km)} km` }),
    ]),
    ...trips.map((reise) => el("button.trip-picker-row", {
      "aria-pressed": String(rangeFocusTripId === reise.id),
      on: { click: () => focusRangeTrip(reise.id) },
    }, [
      el("i", { style: { background: `hsl(${reise.hue},70%,52%)` } }),
      el("span", {}, [
        el("b", { text: reise.name }),
        el("small", { text: `${datum(reise.start || reise.range?.from)} – ${reise.end || reise.range?.to ? datum(reise.end || reise.range?.to) : "läuft"}` }),
      ]),
      el("em", { text: `${kmText(reise.km)} km` }),
    ])),
  ];
}

function renderDriveKindPickerControls() {
  const kind = routeFocus?.drives?.[0]?.kind === "abstecher" ? "abstecher" : "etappe";
  $$("#drive-kind-picker button[data-drive-kind-choice]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.driveKindChoice === kind));
    const marker = button.querySelector("i");
    if (marker) marker.textContent = button.dataset.driveKindChoice === kind ? "✓" : "";
  });
}

export function renderTrips() {
  if (!state.rangeTrip) rangeFocusTripId = null;
  else if (rangeFocusTripId && !rangeTrips(state.rangeTrip.range).some((t) => t.id === rangeFocusTripId)) rangeFocusTripId = null;
  $("#view-reise")?.classList.toggle("range-context", Boolean(state.rangeTrip));
  renderTripModeTabs();
  renderTripList();
  renderCurrent();
  renderSegments();
}

/** Nimmt dem Knopf für die Dauer der Aktion die Bedienbarkeit. */
async function mitKnopf(knopf, arbeit) {
  const html = knopf?.innerHTML;
  if (knopf) {
    knopf.disabled = true;
    knopf.classList.add("is-busy");
    knopf.setAttribute("aria-busy", "true");
    if (knopf.dataset.busyText) knopf.textContent = knopf.dataset.busyText;
  }
  try {
    await arbeit();
  } catch (err) {
    toast(err.message || "Das hat nicht geklappt");
  } finally {
    if (knopf) {
      knopf.disabled = false;
      knopf.classList.remove("is-busy");
      knopf.removeAttribute("aria-busy");
      if (html != null) knopf.innerHTML = html;
    }
  }
}

/* ---------- Reisen anlegen, beenden, fortsetzen, löschen ---------- */

async function neueReise(knopf) {
  if (!zentral()) {
    startTrip(starterPath());
    renderTrips(); goMap();
    toast("Neue Reise gestartet – gute Fahrt!");
    return;
  }
  await mitKnopf(knopf, async () => {
    const { id } = await createTrip({ name: "Neue Reise", start_at: new Date().toISOString() });
    await reloadTrips();
    showTripOnMap(id);
    renderTrips(); goMap();
    toast("Neue Reise gestartet – gute Fahrt!");
  });
}

async function reiseBeenden(knopf, danach) {
  if (!zentral()) {
    endTrip(); renderTrips(); danach?.();
    toast("Reise beendet und gespeichert");
    return;
  }
  const t = activeTrip();
  if (!t) return;
  await mitKnopf(knopf, async () => {
    await updateTrip(t.id, { end_at: new Date().toISOString() });
    await reloadTrips();
    renderTrips(); danach?.();
    toast("Reise beendet und gespeichert");
  });
}

async function reiseFortsetzen(knopf, id, danach) {
  if (!zentral()) {
    resumeTrip(id); renderTrips(); danach?.();
    return;
  }
  await mitKnopf(knopf, async () => {
    await updateTrip(id, { end_at: null });
    await reloadTrips();
    renderTrips(); danach?.();
  });
}

async function reiseLoeschen(knopf, id, danach) {
  if (!zentral()) {
    deleteTrip(id); renderTrips(); danach?.();
    toast("Reise gelöscht");
    return;
  }
  await mitKnopf(knopf, async () => {
    await apiDeleteTrip(id);
    await reloadTrips();
    renderTrips(); danach?.();
    toast("Reise gelöscht");
  });
}

export async function startNewTripFromContext(knopf) {
  await neueReise(knopf);
}

function selectedTrip() {
  if (state.rangeTrip && rangeFocusTripId) return trip(rangeFocusTripId) || state.rangeTrip;
  return state.rangeTrip || trip(state.mapTripId) || activeTrip() || state.trips[0] || null;
}

function tripSummary(t) {
  const routeTrip = tripForRouteFilter(t);
  return summarizeTrip(routeTrip, {
    drives: routeDrives(t),
    places: routePlaces(t),
    notes: routeNotes(t),
  });
}

function tripForRouteFilter(t) {
  if (!t) return t;
  if (isRangeTrip(t)) return t;
  // Wie die Karte: bei laufender Reise bleibt das Ende nach der letzten bekannten Fahrt sichtbar,
  // ein grober Zwischenspeicher-Pfad wird nicht nach Fahrten gefiltert.
  if (t.pathGrob) return t;
  return { ...t, path: visibleRoutePath(t.path || [], state.drives, t.id, kartenFilter(), { offenesEnde: Boolean(t.live) }) };
}

function routeDrives(t) {
  if (isRangeTrip(t)) {
    const from = Date.parse(t.range?.from || "");
    const to = Date.parse(t.range?.to || new Date().toISOString());
    return state.drives.filter((d) => {
      const start = Date.parse(d.from || "");
      const end = Date.parse(d.to || d.from || "");
      return Number.isFinite(start) && Number.isFinite(from) && end >= from && start <= to;
    });
  }
  return filteredRouteDrives(state.drives, t?.id, kartenFilter());
}

function routePlaces(t) {
  if (isRangeTrip(t)) return tripPlaces(t.id);
  return tripPlaces(t?.id).filter((p) => itemMatchesRouteFilter(p, state.drives, t?.id, kartenFilter()));
}

function routeNotes(t) {
  if (isRangeTrip(t)) return tripNotes(t.id);
  return tripNotes(t?.id).filter((n) => itemMatchesRouteFilter(n, state.drives, t?.id, kartenFilter()));
}

function ensurePathForSegments(t) {
  // Kein t.path?.length-Vorabcheck mehr hier — ensureTripPath() selbst weiß,
  // ob die vorhandene Spur noch zum aktuell aktiven Gerät passt (siehe dort);
  // ein zusätzlicher Check hier würde nach einem Fahrzeugwechsel eine
  // veraltete, aber nicht-leere Spur fälschlich für aktuell halten.
  if (!t || tripPathLoads.has(t.id)) return;
  if (!Array.isArray(t.path)) t.path = [];
  tripPathLoads.add(t.id);
  ensureTripPath(t, { silent: true })
    .catch(() => {})
    .finally(() => tripPathLoads.delete(t.id));
}

function renderCurrent() {
  const wrap = $("#current-trip");
  if (wrap) render(wrap, []);
}

function renderTripList() {
  const wrap = $("#trip-list");
  if (!wrap) return;
  const t = state.rangeTrip;
  if (!isRangeTrip(t)) { render(wrap, []); return; }
  const trips = rangeTrips(t.range);
  render(wrap, [
    el("section.trip-list-period", {}, [
      el("h3", { text: "Reisen in diesem Zeitraum" }),
      trips.length
        ? el("div", {}, trips.map((reise) => el("button.trip-list-item", {
            "aria-pressed": String(rangeFocusTripId === reise.id),
            on: { click: () => {
              focusRangeTrip(reise.id);
            } },
          }, [
            el("i", { style: { background: `hsl(${reise.hue},70%,52%)` } }),
            el("span", {}, [
              el("b", { text: reise.name }),
              el("small", { text: `${datum(reise.start || reise.range?.from)} – ${reise.end || reise.range?.to ? datum(reise.end || reise.range?.to) : "läuft"}` }),
            ]),
            el("em", { text: `${kmText(reise.km)} km` }),
          ])))
        : el("p.sub", { text: "Keine gespeicherte Reise überschneidet diesen Zeitraum." }),
    ]),
  ]);
}

function renderRangeFocusBack() {
  if (!state.rangeTrip || !rangeFocusTripId) return null;
  return el("button.detail-back", {
    on: { click: () => {
      rangeFocusTripId = null;
      routeFocus = null;
      tripMode = "fahrten";
      renderTrips();
    } },
  }, [icon(ICON.chevronLeft, 17), "Zurück zu Reisen"]);
}

function renderSegments() {
  $$("#view-reise .segment-tabs button[data-trip-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tripMode === tripMode)));
  renderRouteFilterControls();
  const wrap = $("#trip-segment");
  const summaryWrap = $("#route-summary-panel");
  const t = selectedTrip();
  $$("#view-reise .route-filter").forEach((filter) => { filter.hidden = false; });
  if (!wrap || !t) {
    $$("#view-reise .trip-mode-toolbar").forEach((tabs) => { tabs.hidden = false; });
    // Ohne Reise gibt es nichts, unter dem die "Nicht zugeordnet"-Liste
    // sonst hängt (die lebt normalerweise unter der Fahrten-Ansicht einer
    // Reise) — bleibt trotzdem über denselben Filter erreichbar, sonst
    // verschwinden Fahrten spurlos, sobald keine einzige Reise mehr
    // existiert (z. B. direkt nach dem Löschen aller Reisen). Nur im
    // Fahrten-Reiter UND nur bei aktivem Filter, wie überall sonst auch.
    if (wrap) {
      render(wrap, (tripMode === "fahrten" && routeFilter() === "nicht_zugeordnet")
        ? renderUnassignedDriveSegments() : []);
    }
    if (summaryWrap) render(summaryWrap, []);
    return;
  }
  routeSummaryCache = new Map();

  const detailOffen = routeFocus?.parentId === t.id &&
    ((tripMode === "tage" && routeFocus.type === "tag") || (tripMode === "fahrten" && routeFocus.type === "fahrt"));
  $$("#view-reise .trip-mode-toolbar").forEach((tabs) => { tabs.hidden = detailOffen; });

  if (tripMode === "tage") {
    if (detailOffen) {
      render(summaryWrap, [renderRangeFocusBack(), renderRouteDetail(t, "tage")]);
      render(wrap, []);
    } else {
      render(summaryWrap, [renderRangeFocusBack()]);
      render(wrap, renderDaySegments(t));
    }
    return;
  }
  if (tripMode === "fahrten") {
    if (state.rangeTrip && !rangeFocusTripId) {
      render(summaryWrap, []);
      render(wrap, renderRangeTripRows());
      return;
    }
    ensurePathForSegments(t);
    if (state.rangeTrip && rangeFocusTripId && !detailOffen) {
      const summary = tripSummary(t);
      render(summaryWrap, [renderRangeFocusBack(), renderSummaryFacts(summary, t), renderMapAction(summary, t)]);
      render(wrap, [renderGesamtActions(t), ...renderGesamtCharts(t)]);
    } else if (detailOffen) {
      render(summaryWrap, [renderRangeFocusBack(), renderRouteDetail(t, "fahrten")]);
      render(wrap, []);
    } else {
      render(summaryWrap, []);
      render(wrap, renderDriveSegments(t));
    }
    return;
  }

  routeFocus = null;
  $$("#view-reise .trip-mode-toolbar").forEach((tabs) => { tabs.hidden = false; });
  render(summaryWrap, [renderRangeFocusBack(), renderSummaryFacts(tripSummary(t), t)]);
  render(wrap, [renderGesamtActions(t), ...renderGesamtCharts(t)]);
}

/** Kopf der Tages-/Fahrtansicht: dieselbe Pille wie auf der Karte ("Zurück · Tag 3 · ‹ ›"). */
function detailKopfLeiste(summaries) {
  const zurueck = () => { routeFocus = null; renderTrips(); };
  const nav = tagNavigation(summaries, routeFocus.id);
  const schritt = (richtung) => {
    const ziel = tagNachbar(summaries, routeFocus.id, richtung);
    return el("button.map-focus-step", {
      type: "button",
      disabled: !ziel,
      "aria-label": richtung < 0 ? "Vorheriger Tag" : "Nächster Tag",
      on: { click: () => { if (ziel) { routeFocus = ziel; renderTrips(); } } },
    }, [icon(richtung < 0 ? ICON.chevronLeft : ICON.chevronRight, 16)]);
  };
  return el("div.map-focusbar", {}, [
    el("button", { type: "button", text: "Zurück", on: { click: zurueck } }),
    el("b", { text: routeFocus.title }),
    ...(nav ? [schritt(-1), schritt(1)] : []),
  ]);
}

function renderRouteDetail(t, listMode) {
  const hatSpur = Boolean(routeFocus?.path?.length);
  const kopfListe = listMode === "tage" && routeFocus?.type === "tag" ? tageSummariesFor(t)
    : listMode === "fahrten" && routeFocus?.type === "fahrt" ? fahrtenEintraege(t)
      : null;
  return el("div.route-detail", {}, [
    el("div.detail-nav", {}, [
      kopfListe
        ? detailKopfLeiste(kopfListe)
        : el("button.detail-back", {
          on: { click: () => { routeFocus = null; renderTrips(); } },
        }, [icon(ICON.chevronLeft, 17), listMode === "tage" ? "Zurück zu Tagen" : "Zurück zu Fahrten"]),
    ]),
    renderSummaryFacts(routeFocus, t),
    renderMapAction(routeFocus, t),
    // Dieselben Kartenwerkzeuge wie unter Gesamt, hier für nur diesen Tag/
    // diese Fahrt — beide Funktionen nehmen einfach eine Positions-Spur,
    // ganz gleich ob Reise, Tag oder Fahrt (siehe renderGesamtCharts()).
    ...(hatSpur ? [
      el("div.gcard", {}, [el("h3", { text: "Höhenprofil" }), elevationProfile(routeFocus.path)]),
      el("div.gcard", {}, [el("h3", { text: "Geschwindigkeit" }), speedProfile(routeFocus.path)]),
    ] : []),
  ]);
}

/** Fahrt aus der Reise nehmen: wird zur Alltagsfahrt (bleibt im Logbuch, unter
 * Fahrten → Filter "Nicht zugeordnet" jederzeit wieder einer Reise zuordenbar). */
async function entferneFahrtAusReise() {
  const drive = routeFocus?.drives?.[0];
  if (!drive?.key) return;
  closeDriveKindPicker();
  if (!zentral()) { toast("Nur mit verbundenem Konto möglich"); return; }
  try {
    await assignDrive(drive.key, null);
    await loadDrives();
    routeFocus = null;
    renderTrips();
    detailNeuZeichnen();
    toast("Fahrt aus der Reise entfernt — als Alltagsfahrt gemerkt");
  } catch (err) {
    toast(err.message || "Fahrt konnte nicht entfernt werden");
  }
}

async function setFocusedDriveKind(kind, knopf) {
  if (routeFocus?.type !== "fahrt" || !routeFocus.drives?.length) return;
  if (kind === "entfernen") { entferneFahrtAusReise(); return; }
  const drive = routeFocus.drives[0];
  const ziel = kind === "abstecher" ? "abstecher" : "etappe";
  if (drive.kind === ziel) {
    closeDriveKindPicker();
    return;
  }
  closeDriveKindPicker();
  const vorher = drive.kind === "abstecher" ? "abstecher" : "etappe";
  applyDriveKind(drive.key, ziel);
  routeFocus = { ...routeFocus, drives: [{ ...drive, kind: ziel }] };
  emit("drives");
  toast(ziel === "abstecher" ? "Als Abstecher markiert" : "Als Etappe markiert");
  updateDriveKind(drive.key, ziel).catch((err) => {
    applyDriveKind(drive.key, vorher);
    routeFocus = { ...routeFocus, drives: [{ ...drive, kind: vorher }] };
    emit("drives");
    toast(err.message || "Fahrtart konnte nicht gespeichert werden");
  });
}

function applyDriveKind(key, kind) {
  if (!key) return;
  if (kind === "abstecher") state.driveKinds[key] = "abstecher";
  else delete state.driveKinds[key];
  for (const drive of state.drives) {
    if (drive.key === key) drive.kind = kind === "abstecher" ? "abstecher" : "etappe";
  }
}

function renderMapAction(summary, t) {
  if (!summary) return null;
  if (summary.type === "reise" && isRangeTrip(t)) return null;
  const kannZeigen = summary.type === "reise" || Boolean(summary.path?.length);
  if (!kannZeigen) return null;
  return el("div.trip-actions.route-map-actions", {}, [
    el("button.btn.grow", {
      on: { click: () => zeigeSummaryAufKarte(summary, t) },
    }, [icon(ICON.map, 15), "Auf Karte zeigen"]),
  ]);
}

function zeigeSummaryAufKarte(summary, t) {
  if (summary.type === "reise") {
    if (state.rangeTrip && rangeFocusTripId) {
      kartenRueckkehrKontext = { tripMode, routeFocus, rangeFocusTripId };
      showAdhocOnMap(t);
    } else if (isRangeTrip(t)) showAdhocOnMap(t);
    else showTripOnMap(t.id);
  } else if (summary.path?.length) {
    kartenRueckkehrKontext = { tripMode, routeFocus, rangeFocusTripId };
    const adhoc = routeSummaryToTrip(summary, `${t.name} · ${summary.title}`);
    if (summary.type === "tag" || summary.type === "fahrt") { adhoc.navArt = summary.type; adhoc.navReiseId = t.id; }
    showAdhocOnMap(adhoc);
  }
  goMap();
}

/** Liste, in der die Karte blättert: Tage bzw. Fahrten der Reise, aus der der Ausschnitt stammt. */
function kartenListe(adhoc) {
  const t = adhoc?.navReiseId ? trip(adhoc.navReiseId) : null;
  if (!t?.path?.length) return { t: null, summaries: null };
  if (adhoc.navArt === "tag") return { t, summaries: tageSummariesFor(t) };
  if (adhoc.navArt === "fahrt") return { t, summaries: fahrtenEintraege(t) };
  return { t: null, summaries: null };
}

/** Für die Kartenleiste: zeigt die Karte gerade einen Tag bzw. eine Fahrt einer Reise,
 * kommt hier seine Kurzbezeichnung ("Tag 3", "Fahrt 14:32") und ob es einen
 * vorherigen/nächsten gibt. */
export function kartenNavigation() {
  const adhoc = state.adhocTrip;
  const { summaries } = kartenListe(adhoc);
  const nav = tagNavigation(summaries, adhoc?.id);
  if (!nav) return null;
  return { titel: summaries.find((x) => x.id === adhoc.id)?.title || adhoc.name, ...nav };
}

/** Karte: zum vorherigen (-1) / nächsten (+1) Tag bzw. zur Fahrt wechseln. */
export function kartenSchritt(richtung) {
  const adhoc = state.adhocTrip;
  const { t, summaries } = kartenListe(adhoc);
  if (!t) return;
  const ziel = tagNachbar(summaries, adhoc.id, richtung);
  if (!ziel?.path?.length) return;
  // "Zurück" führt zu dem Eintrag, den man zuletzt auf der Karte gesehen hat.
  if (kartenRueckkehrKontext?.routeFocus) kartenRueckkehrKontext = { ...kartenRueckkehrKontext, routeFocus: ziel };
  showAdhocOnMap({ ...routeSummaryToTrip(ziel, `${t.name} · ${ziel.title}`), navArt: adhoc.navArt, navReiseId: adhoc.navReiseId });
}

/** Für main.js: erneuter Klick auf den "Reisen"-Tab, während man schon
 * dort ist, setzt auf die Standardansicht zurück (Gesamt, kein Fahrten-/
 * Tage-Fokus) statt einfach nichts zu tun. */
export function resetReiseAnsicht() {
  tripMode = "gesamt";
  routeFocus = null;
  rangeFocusTripId = null;
  kartenRueckkehrKontext = null;
}

/** Für main.js: gibt es einen Rücksprung-Kontext (siehe oben), stellt ihn
 * wieder her (Fahrten-Tab + genau die vorher betrachtete Fahrt/der Tag) und
 * meldet true — sonst unverändert false, main.js fällt dann auf die
 * bisherige "ganze Reise zeigen"-Reaktion zurück. */
export function stelleKartenRueckkehrWieder() {
  if (!kartenRueckkehrKontext) return false;
  ({ tripMode, routeFocus } = kartenRueckkehrKontext);
  rangeFocusTripId = kartenRueckkehrKontext.rangeFocusTripId || null;
  kartenRueckkehrKontext = null;
  renderTrips();
  return true;
}

function renderSummaryFacts(summary, t) {
  const s = summary.stats;
  const label = summary.type === "reise" ? (isRangeTrip(t) ? "Gesamter Zeitraum" : "Gesamte Reise") : summary.title;
  const when = summary.type === "reise" ? datum : zeitpunkt;
  const contextFacts = [];
  if (summary.type === "reise") {
    contextFacts.push([ICON.moon, "Übernachtungsplätze", String(s.overnightPlaces)]);
  } else if (summary.type === "tag") {
    contextFacts.push([ICON.pin, "Stopps", String(s.places)]);
  }
  const fact = (pfad, label, value, { onClick = null } = {}) => {
    const content = [
      el("span.fi", {}, icon(pfad, 17)),
      el("span.fl", { text: label }),
      el("span.fv", { text: value }),
      onClick ? el("span.fc", {}, icon(ICON.chevronRight, 16)) : null,
    ];
    return onClick
      ? el("button.trip-fact", { on: { click: onClick } }, content)
      : el("div.trip-fact", {}, content);
  };
  const driveKindFact = summary.type === "fahrt" && summary.drives?.length
    ? fact(ICON.list, "Fahrtart", summary.drives[0].kind === "abstecher" ? "Abstecher" : "Etappe", { onClick: openDriveKindPicker })
    : null;
  return el("section.route-summary", {}, [
    // Tag und Fahrt tragen ihren Namen schon in der Kopfleiste darüber.
    summary.type === "reise" ? el("div.summary-title", {}, [el("b", { text: label })]) : null,
    el("div.trip-facts", {}, [
      driveKindFact,
      fact(ICON.calendar, "von", when(summary.from)),
      fact(ICON.calendar, "bis", summary.to ? when(summary.to) : summary.live ? "läuft" : "—"),
      fact(ICON.clock, "Zeitraum", summary.type === "reise" ? reiseZeitraumDauer(summary.from, summary.to) : zeitraumDauer(summary.from, summary.to)),
      ...contextFacts.map(([pfad, label, value]) => fact(pfad, label, value)),
      fact(ICON.route, summary.type === "reise" ? "Fahrstrecke" : "Strecke", `${kmText(s.distanceKm)} km`),
      fact(ICON.clock, "Fahrzeit", dauer(s.driveMinutes)),
      fact(ICON.gauge, "Durchschnittsgeschw.", s.averageKmh ? `${kmText(s.averageKmh, 1)} km/h` : "—"),
      fact(ICON.gauge, "Höchstgeschw.", s.maxKmh ? `${kmText(s.maxKmh, 0)} km/h` : "—"),
      fact(ICON.mountain, "Höchster Punkt", s.peakM ? `${kmText(s.peakM)} m` : "—"),
    ]),
  ]);
}

/** Kilometer-pro-Tag- und Höhenprofil-Karten — waren bisher (verwirrend)
 * Teil des "Reise bearbeiten"-Sheets, obwohl sie nichts Bearbeitbares
 * zeigen. Gehören als reine Auswertung zum Gesamt-Reiter, wo sie auch ohne
 * Sheet-Umweg sichtbar sind. */
function renderGesamtCharts(t) {
  const maxBar = Math.max(...t.bars, 1);
  return [
    el("div.gcard", {}, [
      el("h3", { text: "Kilometer pro Tag" }),
      el("div.bars", {}, t.bars.map((v, i) =>
        el("div.b" + (t.live && i === t.bars.length - 1 ? ".hl" : ""), {}, [
          el("div.col", { style: { height: `${(v / maxBar) * 100}%` } }),
          el("small", { text: t.barLabels[i] }),
        ]))),
    ]),
    el("div.gcard", {}, [el("h3", { text: "Höhenprofil" }), elevationProfile(t.path)]),
    el("div.gcard", {}, [el("h3", { text: "Geschwindigkeit" }), speedProfile(t.path)]),
  ];
}

function renderGesamtActions(t) {
  if (t.id === state.activeTripId) {
    // Bearbeiten (u. a. Umbenennen) stand hier bisher nur für schon beendete
    // Reisen zur Verfügung — für eine laufende Reise musste man sie erst
    // beenden, nur um sie umbenennen zu können. Jetzt neben "Beenden".
    return el("div.trip-actions", {}, [
      el("button.btn.grow", { text: "Bearbeiten", on: { click: () => openDetail(t.id) } }),
      el("button.btn.grow", { text: "Reise beenden", dataset: { busyText: "Wird beendet …" }, on: { click: (e) => reiseBeenden(e.currentTarget) } }),
    ]);
  }
  return el("div.trip-actions", {}, [
    el("button.btn.grow", { text: "Bearbeiten", on: { click: () => openDetail(t.id) } }),
    el("button.btn.grow", { dataset: { busyText: "Wird fortgesetzt …" }, on: { click: (e) => reiseFortsetzen(e.currentTarget, t.id) } }, [icon(ICON.play, 15), "Fortsetzen"]),
  ]);
}

function rememberSummary(summary) {
  if (!summary) return "";
  routeSummaryCache.set(summary.id, summary);
  return summary.id;
}

function segmentCard({ title, subtitle, summary, variant = "" }) {
  const fake = {
    id: title,
    name: title,
    hue: summary?.hue || 28,
    live: false,
    path: summary?.path || [],
  };
  const stats = summary?.stats || {};
  const istFahrt = variant === "drive-card" || summary?.type === "fahrt";
  return el("button.segment-card", {
    "aria-pressed": String(routeFocus?.id === summary?.id),
    class: variant,
    dataset: { summaryId: rememberSummary(summary) },
  }, [
    el("div.thumb", {}, miniRoute(fake, 82, 82)),
    el("div.segment-body", {}, [
      variant === "day-card"
        ? el("div.day-title", {}, [
          el("b", { text: title }),
          subtitle ? el("span", { text: `– ${subtitle}` }) : null,
        ])
        : istFahrt
          ? el("span.drive-card-title", {}, [
            el("b", { text: title }),
            summary?.drives?.[0]
              ? el("span.kind-badge" + (summary.drives[0].kind === "abstecher" ? ".abstecher" : ""), {
                text: summary.drives[0].kind === "abstecher" ? "Abstecher" : "Etappe",
              })
              : null,
          ])
          : el("b", { text: title }),
      variant === "day-card" ? null : el("div", { text: subtitle || "" }),
      variant === "day-card"
        ? el("div.segment-stats.day-stats", {}, [
          el("span", { text: `${Number(stats.distanceKm || 0).toLocaleString("de-DE", { maximumFractionDigits: 0 })} km` }),
          el("span", { text: stats.driveMinutes ? dauer(stats.driveMinutes) : "—" }),
        ])
        : istFahrt
          ? el("div.segment-stats", {}, [
            el("span", { text: `${Number(stats.distanceKm || 0).toLocaleString("de-DE", { maximumFractionDigits: 1 })} km` }),
            el("span", { text: stats.driveMinutes ? dauer(stats.driveMinutes) : "—" }),
          ])
        : el("div.segment-stats", {}, [
          el("span", { text: `${Number(stats.distanceKm || 0).toLocaleString("de-DE", { maximumFractionDigits: 1 })} km` }),
          stats.driveMinutes ? el("span", { text: dauer(stats.driveMinutes) }) : null,
          stats.maxKmh ? el("span", { text: `${Math.round(stats.maxKmh)} km/h` }) : null,
          stats.peakM ? el("span", { text: `${Math.round(stats.peakM)} m` }) : null,
        ]),
    ]),
    el("span.chev", {}, icon(ICON.chevronRight, 18)),
  ]);
}

/** Tages-Zusammenfassungen einer Reise samt Vorschau-Spur (für Liste und Vor/Zurück). */
function tageSummariesFor(t) {
  const routeTrip = tripForRouteFilter(t);
  const fahrten = routeDrives(t);
  ensureDrivePreviewPaths(t, fahrten);
  const summaries = summarizeTripDays(routeTrip, {
    drives: fahrten,
    places: routePlaces(t),
    notes: routeNotes(t),
  });
  return summaries.map((summary) => {
    const preview = summary.path?.length ? summary.path : dayPreviewPath(summary.drives || [], t);
    return preview.length ? { ...summary, path: preview } : summary;
  });
}

function renderDaySegments(t) {
  if (!t.path?.length) ensurePathForSegments(t);
  const summaries = tageSummariesFor(t);
  if (!summaries.length) return el("div.callout", { text: "Für diese Reise gibt es noch keine Tagesdaten." });
  return summaries.map((visibleSummary) => segmentCard({
    title: visibleSummary.title,
    subtitle: tagSubtitle(visibleSummary.path, visibleSummary.from),
    summary: visibleSummary,
    variant: "day-card",
  }));
}

function tagSubtitle(path, fallbackIso = null) {
  const d = path[0]?.time ? new Date(path[0].time) : (fallbackIso ? new Date(fallbackIso) : null);
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "2-digit" })
    : "";
}

/** Fahrten ohne jede Reise — eigener Filter "Nicht zugeordnet", nur im
 * Fahrten-Reiter wählbar/wirksam (siehe kartenFilter(): für Karte/Tage/
 * Gesamt zählt er wie "alle"). Ersetzt die normale Tages-Gruppierung
 * komplett, statt sie nur zu ergänzen — die beiden Listen (dieser Reise
 * zugeordnete Fahrten vs. gar keiner) gehören nicht in dieselbe Ansicht. */
function renderUnassignedDriveSegments() {
  const alltag = state.drives.filter((d) => !d.tripId);
  if (!alltag.length) {
    return [el("div.callout", { text: "Aktuell sind alle Fahrten einer Reise zugeordnet." })];
  }
  return [
    el("div.callout", { text: "Diese Fahrten liegen außerhalb jeder Reise oder wurden manuell als Alltag markiert." }),
    ...alltag.map((d) => driveRow(d)),
  ];
}

function renderDriveSegments(t) {
  if (routeFilter() === "nicht_zugeordnet") return renderUnassignedDriveSegments();

  if (!t.path?.length) ensurePathForSegments(t);
  const routeTrip = tripForRouteFilter(t);
  const alleFahrten = state.drives
    .filter((d) => d.tripId === t.id)
    .sort((a, b) => String(a.from || "").localeCompare(String(b.from || "")));
  const fahrten = routeDrives(t).sort((a, b) => String(a.from || "").localeCompare(String(b.from || "")));
  const groups = groupDriveActivitiesByDay(routeTrip, fahrten);
  const nodes = [];

  if (!state.config.demo && !state.drives.length && !groups.length) {
    nodes.push(el("div.callout", {
      text: state.config.device
        ? "Für die letzten 30 Tage meldet der Tracker keine Fahrten."
        : "Keine Geräte-ID hinterlegt — trag sie unter Mehr in den Einstellungen ein.",
    }));
  } else if (!groups.length) {
    nodes.push(el("div.callout", { text: routeFilter() === "abstecher"
      ? "Für diese Reise sind keine Versorgungsfahrten markiert."
      : "Für diese Reise sind noch keine Fahrten erkannt oder zugeordnet." }));
  } else {
    nodes.push(...groups.map(([key, group], index, entries) => driveDayGroup(t, key, group, index, entries.length)));
    ensureDrivePreviewPaths(t, alleFahrten);
  }
  return nodes;
}

function groupDriveActivitiesByDay(t, drives) {
  const groups = new Map();
  const ensure = (key) => {
    if (!groups.has(key)) groups.set(key, { drives: [], tracks: [] });
    return groups.get(key);
  };
  for (const drive of drives) {
    const key = tagKey(drive.from);
    ensure(key).drives.push(drive);
  }

  const daySummaries = summarizeTripDays(t, {
    drives,
    places: routePlaces(t),
    notes: routeNotes(t),
  });
  for (const summary of daySummaries) {
    if (summary.drives.length) continue;
    const key = tagKey(summary.from || summary.path?.[0]?.time);
    if (!key) continue;
    ensure(key).tracks.push(summary);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** Kurzname einer Fahrt für Kopfleiste und Karte: "Tag 2 · 14:32". */
const fahrtTitel = (iso, t) => {
  const tag = tripDayNumberForIso(iso, t);
  return [Number.isFinite(tag) ? `Tag ${tag}` : null, uhrzeit(iso)].filter(Boolean).join(" · ") || "Fahrt";
};

/** Zusammenfassungen für Fahrten (Detailansicht und Vor/Zurück). */
const fahrtZusammenfassung = (drive, t) => ({ ...summarizeDrive(drive, { path: drivePreviewPath(drive, t) }), title: fahrtTitel(drive.from, t) });
const spurZusammenfassung = (summary, t) => ({ ...summary, title: fahrtTitel(summary.from, t) });

/** Alle Fahrten einer Reise, die ein Detail öffnen, in zeitlicher Reihenfolge (über Tagesgrenzen). */
function fahrtenEintraege(t) {
  const routeTrip = tripForRouteFilter(t);
  const fahrten = routeDrives(t).sort((a, b) => String(a.from || "").localeCompare(String(b.from || "")));
  const eintraege = [];
  for (const [, group] of groupDriveActivitiesByDay(routeTrip, fahrten)) {
    eintraege.push(...group.drives.map((d) => fahrtZusammenfassung(d, t)));
    eintraege.push(...group.tracks.map((x) => spurZusammenfassung(x, t)));
  }
  return eintraege
    .filter((e) => e.type === "fahrt")
    .sort((a, b) => String(a.from || "").localeCompare(String(b.from || "")));
}

function driveDayGroup(t, key, group, index, count) {
  const day = tripDayNumberFromKeys(key, tagKey(tripStartIso(t))) || index + 1;
  const entries = group.drives.length + group.tracks.length;
  const openKey = `${t.id}:${routeFilter()}:${key}`;
  const istOffen = driveDayOpen.has(openKey) ? driveDayOpen.get(openKey) : index === count - 1;
  return el("details.drive-day", {
    open: istOffen,
    on: { toggle: (event) => driveDayOpen.set(openKey, event.currentTarget.open) },
  }, [
    el("summary.drive-day-head", {}, [
      el("span.drive-day-num", { text: `Tag ${day}` }),
      el("h3", { text: tagDatum(key) }),
      el("span.drive-day-count", {
        text: `${entries} ${entries === 1 ? "Fahrt" : "Fahrten"}`,
      }),
    ]),
    el("div.drive-day-list", {}, [
      ...group.drives.map((d) => segmentCard({
        title: `Fahrt ${kurzDatumZeit(d.from)}`,
        subtitle: [kurzeAdresse(d.startAddress), kurzeAdresse(d.endAddress)].filter(Boolean).join(" → "),
        summary: fahrtZusammenfassung(d, t),
        variant: "drive-card",
      })),
      ...group.tracks.map((summary) => segmentCard({
        title: `Fahrt ${kurzDatumZeit(summary.from)}`,
        subtitle: "aus Live-Spur, noch nicht im Fahrtbericht",
        summary: spurZusammenfassung(summary, t),
        variant: "drive-card",
      })),
    ]),
  ]);
}

function drivePreviewPath(drive, t) {
  const cached = drivePreviewPaths.get(drive.key);
  if (cached?.length) return cached;
  const tripPath = t?.path || [];
  if (!tripPath.length) return [];
  const from = Date.parse(drive.from || "");
  const to = Date.parse(drive.to || "");
  if (!Number.isFinite(from)) return [];
  const start = from - 2 * 60000;
  const end = (Number.isFinite(to) ? to : from) + 2 * 60000;
  return tripPath.filter((p) => {
    const time = Date.parse(p.time || "");
    return Number.isFinite(time) && time >= start && time <= end;
  });
}

function dayPreviewPath(drives, t) {
  return drives.flatMap((drive) => drivePreviewPath(drive, t));
}

function ensureDrivePreviewPaths(t, drives) {
  if (state.config.demo || !state.config.device) return;
  if (t?.id && tripPathLoads.has(t.id)) return;
  for (const drive of drives) {
    if (drivePreviewPaths.has(drive.key) || drivePreviewLoads.has(drive.key)) continue;
    if (drivePreviewPath(drive, t).length) continue;
    drivePreviewLoads.add(drive.key);
    drivePath(drive)
      .then((path) => {
        drivePreviewPaths.set(drive.key, path || []);
        if (tripMode === "fahrten" || tripMode === "tage") renderTrips();
      })
      .catch(() => {})
      .finally(() => drivePreviewLoads.delete(drive.key));
  }
}

const zeitpunkt = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

const uhrzeit = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
};

const kurzDatumZeit = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

const kurzeAdresse = (text) => (text || "").split(",").slice(0, 2).join(",").trim();

/**
 * Auswahl, zu welcher Reise eine Fahrt gehört. Ohne Auswahl entscheidet der
 * Zeitraum; eine Auswahl bleibt zentral gespeichert und sticht die Automatik.
 */
/**
 * Ordnet man eine Fahrt von Hand einer Reise zu, kann sie außerhalb des
 * bisherigen Zeitraums liegen — die automatische Zuordnung (zugehoerige-
 * ReiseFahrt) hätte sie deshalb nie erfasst, das manuelle Zuordnen ist ja
 * gerade der Weg, das zu übersteuern. Bleibt der Zeitraum dann unverändert,
 * tappt man in genau die Falle, die zur Tage-Nummerierung "Tag 1 zweimal"
 * führte (Nutzerfund, 1. September 2026): eine Fahrt vor dem Reise-Start
 * wird auf Tag 1 zusammengestaucht, der echte Tag 1 rechnet sich ebenfalls
 * als Tag 1. Deshalb hier automatisch erweitern statt nur zuzuordnen.
 * Nur bei zentraler Ablage (ohne die gibt es auch keinen Zeitraum-Editor,
 * siehe renderTripDetail) und nur in die Richtung, die wirklich fehlt: ein
 * bereits gesetztes Ende wird nur nach hinten erweitert, ein offenes Ende
 * (laufende Reise) deckt "in die Zukunft" ohnehin schon ab.
 */
async function erweitereReiseFallsNoetig(zielTrip, drive) {
  if (!zielTrip || !zentral()) return;
  const patch = {};
  const startNeu = Date.parse(drive.from);
  const startAlt = Date.parse(zielTrip.start || zielTrip.range?.from || "");
  if (Number.isFinite(startNeu) && (!Number.isFinite(startAlt) || startNeu < startAlt)) {
    patch.start_at = drive.from;
  }
  if (zielTrip.end) {
    const endeNeu = Date.parse(drive.to || drive.from);
    const endeAlt = Date.parse(zielTrip.end);
    if (Number.isFinite(endeNeu) && Number.isFinite(endeAlt) && endeNeu > endeAlt) {
      patch.end_at = drive.to || drive.from;
    }
  }
  if (!Object.keys(patch).length) return;
  try {
    await updateTrip(zielTrip.id, patch);
    await reloadTrips();
    toast(`Zeitraum von „${zielTrip.name}“ automatisch erweitert`);
  } catch (err) {
    toast(err.message || "Zeitraum konnte nicht automatisch erweitert werden");
  }
}

function zuordnungsWahl(drive) {
  const select = el("select.assign-sel", { title: "Fahrt einer Reise zuordnen" }, [
    el("option", { value: "", disabled: true, selected: !drive.tripId && !drive.manuell, text: "→ Reise …" }),
    ...state.trips.map((t) => el("option", { value: t.id, selected: t.id === drive.tripId, text: t.name })),
    el("option", { value: "__alltag", selected: drive.manuell && !drive.tripId, text: "Alltagsfahrt" }),
    ...(drive.manuell ? [el("option", { value: "__auto", text: "automatisch (Zeitraum)" })] : []),
  ]);

  select.addEventListener("change", async () => {
    const wahl = select.value;
    const ziel = wahl === "__alltag" ? null : wahl === "__auto" ? "auto" : wahl;
    select.disabled = true;
    try {
      await assignDrive(drive.key, ziel);
      if (ziel && ziel !== "auto") await erweitereReiseFallsNoetig(trip(ziel), drive);
      await loadDrives();          // löst „drives“ aus → Listen zeichnen neu
      detailNeuZeichnen();
      toast(ziel === null ? "Als Alltagsfahrt gemerkt"
        : ziel === "auto" ? "Wieder automatisch zugeordnet"
        : `Fahrt der Reise „${trip(ziel)?.name || "…"}“ zugeordnet`);
    } catch (err) {
      toast(err.message || "Zuordnung fehlgeschlagen");
      select.disabled = false;
    }
  });
  return select;
}

function fahrtArtWahl(drive) {
  const select = el("select.assign-sel.drive-kind", { title: "Fahrtart wählen" }, [
    el("option", { value: "etappe", selected: drive.kind !== "abstecher", text: "Etappe" }),
    el("option", { value: "abstecher", selected: drive.kind === "abstecher", text: "Abstecher" }),
  ]);
  select.addEventListener("change", async () => {
    const kind = select.value === "abstecher" ? "abstecher" : "etappe";
    const vorher = drive.kind === "abstecher" ? "abstecher" : "etappe";
    applyDriveKind(drive.key, kind);
    emit("drives");
    detailNeuZeichnen();
    toast(kind === "abstecher" ? "Als Abstecher markiert" : "Als Etappe markiert");
    updateDriveKind(drive.key, kind).catch((err) => {
      applyDriveKind(drive.key, vorher);
      emit("drives");
      detailNeuZeichnen();
      toast(err.message || "Fahrtart konnte nicht gespeichert werden");
    });
  });
  return select;
}

/** Fahrt-Spur auf der Karte zeigen — Klick auf die Zeile oder den Knopf tut dasselbe. */
async function zeigeFahrtAufKarte(drive, knopf) {
  if (knopf) knopf.disabled = true;
  toast("Fahrt wird geladen …");
  try {
    const path = await drivePath(drive);
    if (!path.length) { toast("Für diese Fahrt liegen keine Positionen vor"); return; }
    const summary = summarizeDrive(drive, { path });
    showAdhocOnMap(routeSummaryToTrip(summary, `Fahrt ${zeitpunkt(drive.from)}`));
    goMap();
  } catch (err) {
    toast(err.message);
  } finally {
    if (knopf) knopf.disabled = false;
  }
}

/** Eine Fahrt als Zeile — Antippen (wie bei Stopps & Orte) zeigt die Spur auf der Karte. */
function driveRow(drive) {
  const strecke = [kurzeAdresse(drive.startAddress), kurzeAdresse(drive.endAddress)].filter(Boolean).join(" → ");
  return el("div.daily", {
    role: "button", tabindex: "0", title: "Fahrt auf der Karte zeigen", style: { cursor: "pointer" },
    on: {
      click: () => zeigeFahrtAufKarte(drive),
      keydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); zeigeFahrtAufKarte(drive); } },
    },
  }, [
    el("div.di", {}, [
      el("b", { text: `${zeitpunkt(drive.from)} · ${drive.minutes} min` }),
      el("div", { text: strecke || "Fahrt" }),
    ]),
    el("span.dkm", { text: `${drive.km.toFixed(1)} km` }),
    drive.weather ? el("span.dweather", { text: wetterZeile(drive.weather) }) : null,
    // Eigene Bedienelemente dürfen den Zeilen-Klick nicht auslösen.
    el("div.dacts", { on: {
      click: (e) => e.stopPropagation(),
      keydown: (e) => e.stopPropagation(),
    } }, [
      el("button.tc-map", { on: { click: (e) => zeigeFahrtAufKarte(drive, e.currentTarget) } }, [icon(ICON.map, 13), "Auf Karte"]),
      fahrtArtWahl(drive),
      zuordnungsWahl(drive),
    ]),
  ]);
}

/* ---------- Detailansicht einer Reise ---------- */

// Damit sich die offene Detailansicht nach einer Änderung selbst auffrischt
// (z. B. wenn im Hintergrund die Spur der laufenden Reise weiterwächst).
let letzteDetailArgs = null;
export function detailNeuZeichnen() {
  if (!letzteDetailArgs) return;
  const sheet = document.getElementById("trip-sheet");
  if (!sheet?.classList.contains("show")) return;
  renderTripDetail(letzteDetailArgs.id, letzteDetailArgs.handlers);
}

export function renderTripDetail(id, handlers) {
  const { onClose } = handlers;
  const t = trip(id);
  if (!t) return null;
  letzteDetailArgs = { id, handlers };

  const body = $("#sheet-body");
  $("#sheet-title").textContent = t.name;

  const nameInput = el("input#trip-name", { type: "text", value: t.name, style: { flex: "1" } });
  const nameSave = el("button.name-save#trip-name-save", { text: "✓ Speichern" });

  // Zeitraum bearbeiten (N13) — nur wo eine Datenbank die Reise führt.
  const startInput = el("input#trip-start", { type: "date", value: t.start ? t.start.slice(0, 10) : "" });
  const endInput = el("input#trip-end", { type: "date", value: t.end ? t.end.slice(0, 10) : "" });
  const rangeSave = el("button.name-save#trip-range-save", { text: "✓ Speichern" });

  const isActive = id === state.activeTripId;

  // Auswertung (Fakten, Charts, Fahrten, Stopps & Orte) lebt bewusst NICHT
  // mehr hier — das ist alles bereits über Gesamt/Fahrten/Tage/Logbuch
  // erreichbar, ohne diesen Sheet-Umweg, und gehörte konzeptionell nicht
  // unter "Bearbeiten" (auf Nutzerrückmeldung: "das lässt sich ja nicht
  // bearbeiten"). Hier bleibt nur, was sich wirklich ändern/löschen lässt.
  render(body, [
    el("div.gcard.trip-edit", {}, [
      el("h3", { text: "Reise bearbeiten" }),
      el("div.field", { style: { marginBottom: "12px" } }, [
        el("label", { text: "Reisename" }),
        el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, [nameInput, nameSave]),
      ]),
      ...(zentral() ? [el("div.field", { style: { marginBottom: "12px" } }, [
        el("label", { text: "Zeitraum" }),
        el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, [
          startInput, el("span", { text: "–", style: { color: "var(--ink-faint)" } }), endInput, rangeSave,
        ]),
        el("p.sub", { text: "Leeres Ende = Reise läuft weiter. Fahrten ordnen sich dem neuen Zeitraum automatisch zu." }),
      ])] : []),
      isActive
        ? el("button.btn", { text: "Reise beenden", dataset: { busyText: "Wird beendet …" }, style: { width: "100%" },
            on: { click: (e) => reiseBeenden(e.currentTarget, () => renderTripDetail(id, handlers)) } })
        : el("button.btn", { dataset: { busyText: "Wird fortgesetzt …" }, style: { width: "100%" },
            on: { click: (e) => reiseFortsetzen(e.currentTarget, id, () => renderTripDetail(id, handlers)) } },
            [icon(ICON.play, 15), "Fortsetzen"]),
      el("button.btn", {
        text: "Reise löschen", style: { width: "100%", marginTop: "8px", color: "var(--crit)", borderColor: "color-mix(in srgb, var(--crit) 40%, var(--line))" },
        on: { click: (e) => reiseLoeschen(e.currentTarget, id, onClose) },
      }),
    ]),
  ]);

  const nameEdit = wireInlineEdit(nameInput, nameSave, () => t.name, async (value) => {
    const vorher = t.name;
    t.name = value;
    $("#sheet-title").textContent = value;
    renderTrips();
    emit("trips");
    if (!zentral()) return;
    try {
      await updateTrip(id, { name: value });
    } catch (err) {
      t.name = vorher;             // Der Server hat das letzte Wort.
      $("#sheet-title").textContent = vorher;
      renderTrips();
      toast(err.message || "Name konnte nicht gespeichert werden");
    }
  });

  const zeitraumEdit = zentral() ? wireZeitraumEdit({ t, id, handlers, startInput, endInput, rangeSave }) : null;

  // Beide Felder zusammen — die Sheet-Leiste kennt nur ein Edit-Objekt.
  const edit = {
    isDirty: () => nameEdit.isDirty() || Boolean(zeitraumEdit?.isDirty()),
    commit: () => { nameEdit.commit(); zeitraumEdit?.commit(); },
  };

  // Zeichnet sich die Ansicht neu, gilt der neue Eingabestand — sonst hinge
  // die Nachfrage nach ungespeicherten Änderungen an einem toten Feld.
  handlers.onEdit?.(edit);
  return edit;
}

/** Ein Datum aus einem `<input type="date">` mit der bisherigen Uhrzeit verbinden. */
function mitUhrzeitVon(vorherigeISO, neuesDatum) {
  if (!neuesDatum) return null;
  const alt = vorherigeISO ? new Date(vorherigeISO) : null;
  const gueltig = alt && !Number.isNaN(alt.getTime());
  const [jahr, monat, tag] = neuesDatum.split("-").map(Number);
  return new Date(Date.UTC(jahr, monat - 1, tag, gueltig ? alt.getUTCHours() : 12, gueltig ? alt.getUTCMinutes() : 0)).toISOString();
}

/** Start-/Enddatum einer Reise bearbeiten (N13) — explizites Speichern wie überall sonst. */
function wireZeitraumEdit({ t, id, handlers, startInput, endInput, rangeSave }) {
  const startWert = () => (t.start ? t.start.slice(0, 10) : "");
  const endWert = () => (t.end ? t.end.slice(0, 10) : "");
  const dirty = () => startInput.value !== startWert() || endInput.value !== endWert();
  const refresh = () => rangeSave.classList.toggle("show", dirty());

  const commit = async () => {
    if (!dirty()) return;
    if (!startInput.value) {
      toast("Ein Start-Datum wird gebraucht");
      startInput.value = startWert();
      refresh();
      return;
    }
    const neuerStart = mitUhrzeitVon(t.start, startInput.value);
    const neuesEnde = endInput.value ? mitUhrzeitVon(t.end, endInput.value) : null;
    if (neuesEnde && Date.parse(neuesEnde) < Date.parse(neuerStart)) {
      toast("Das Ende liegt vor dem Start");
      return;
    }
    rangeSave.disabled = true;
    try {
      await updateTrip(id, { start_at: neuerStart, end_at: neuesEnde });
      await reloadTrips();
      renderTrips();
      renderTripDetail(id, handlers);
      toast("Zeitraum gespeichert");
    } catch (err) {
      toast(err.message || "Zeitraum konnte nicht gespeichert werden");
      rangeSave.disabled = false;
    }
  };

  startInput.addEventListener("input", refresh);
  endInput.addEventListener("input", refresh);
  rangeSave.addEventListener("click", commit);
  return { isDirty: dirty, commit };
}
