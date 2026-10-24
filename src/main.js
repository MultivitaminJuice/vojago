// Einstieg: verdrahtet Navigation, Karte und Ansichten.
import "./styles.css";

import { $, $$, el, render, toast, icon } from "./dom.js";
import { ICON } from "./icons.js";
import { state, loadConfig, saveConfig, setMetric, showTripOnMap, showRangeOnMap, clearAdhoc, subscribe, category, trip, activeTrip, nightsOf, tripPlaces, isRangeTrip, mapTrip, rangeTrips } from "./state.js";
import { loadData, status as dataStatus, ensureTripPath, buildRangeTrip, loadDrives, loadLivePosition, restoreLivePosition, restoreSnapshot } from "./dataload.js";
import { authState, login as anmelden, setupAccount, setAngemeldet, forgotPassword, resetPassword, verifyEmail } from "./api.js";
import { starteGastAnsicht, zeigeGastReise, ladeGastLivePosition, ladeGastRoute } from "./guest.js";
import { wetterZeile } from "./store.js";
import { distanceKm } from "./geo.js";
import { duerfteWeg } from "./ui/dirty-guard.js";
import * as mapview from "./mapview.js";
import { createSheet, wireEscape } from "./ui/sheets.js";
import { teileOrt, teileReise } from "./ui/share.js";
import { initTrips, renderTrips, renderTripDetail, detailNeuZeichnen, startNewTripFromContext, stelleKartenRueckkehrWieder, resetReiseAnsicht, tagKartenNavigation, kartenTagWechseln } from "./views/trips.js";
import { initPlaces, renderPlaces, renderCategoryChips, buildFilterOptions, photoGradient, resetPlaceFilters } from "./views/places.js";
import { initPlaceEditor, openPlaceEditor, renderCategoryPicker, isDirty as editorDirty, save as saveEditor, clearEditor } from "./views/place-editor.js";
import { initJournal, renderJournal } from "./views/journal.js";
import { initNoteEditor, captureNote, openNoteEditor, isDirty as noteDirty, save as saveNote, clearEditor as clearNote } from "./views/note-editor.js";
import { initGuard, loadGuard, renderGuardInfo } from "./views/guard.js";
import { liveAlterText } from "./live-alter.js";
import { applyTheme } from "./theme.js";
import { initSettings, renderVehicles, renderCategories, syncPreferences, refreshAccountState, renderRouteInfo } from "./views/settings.js";
import { debugLog } from "./debug.js";

/* ---------- Start ---------- */
loadConfig();
applyTheme(state.config.theme);
restoreLivePosition();
restoreSnapshot();

/* ---------- Die Seite selbst zoomt nicht ----------
   Die Karte bringt ihr eigenes Zoomen mit; das Zoomen der ganzen Seite
   würde das Layout verschieben und fühlt sich nicht nach App an. */
for (const ereignis of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(ereignis, (e) => e.preventDefault(), { passive: false });
}
let letzteBeruehrung = 0;
document.addEventListener("touchend", (e) => {
  const jetzt = Date.now();
  // Doppeltipp zoomt sonst die Seite — auf der Karte übernimmt MapLibre.
  if (jetzt - letzteBeruehrung < 350 && !e.target.closest(".maparea")) e.preventDefault();
  letzteBeruehrung = jetzt;
}, { passive: false });
document.addEventListener("wheel", (e) => {
  // Strg/Cmd + Mausrad zoomt sonst die Seite.
  if (e.ctrlKey || e.metaKey) e.preventDefault();
}, { passive: false });

/* ---------- Sichtbare Höhe selbst messen ----------
   Im App-Betrieb auf iOS entspricht die eingebaute Einheit (100dvh) nicht
   immer der wirklich sichtbaren Fläche — unten blieb ein ungenutzter Streifen.
   `visualViewport` ist genau dafür da: Es meldet die tatsächlich sichtbare
   Höhe, auch wenn sich eine Tastatur öffnet — dann darf die Ansicht ruhig
   mitschrumpfen, das ist kein Fehler, sondern das erwartete Verhalten. */
function messeHoehe() {
  const vv = window.visualViewport?.height || 0;
  const inner = window.innerHeight || 0;
  const client = document.documentElement.clientHeight || 0;
  const screenH = window.screen?.height || 0;
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const tastaturOffen = vv && inner && vv < inner - 120;
  const basis = tastaturOffen ? vv : Math.max(vv, inner, client);
  // iOS-PWAs mit transparenter Statusleiste melden teils nur den Bereich unter
  // der Statusleiste als Viewport. Der Screenshot/Displaybereich ist dann um
  // die obere Safe-Area hoeher; `screen.height` liefert diese volle CSS-Hoehe.
  const hoehe = !tastaturOffen && standalone && screenH > basis && screenH - basis < 160
    ? screenH
    : basis;
  if (!hoehe) return;
  document.documentElement.style.setProperty("--app-h", `${Math.ceil(hoehe)}px`);
  debugLog("viewport.measured", { vv, inner, client, screenH, standalone, applied: Math.ceil(hoehe), keyboard: tastaturOffen });
  requestAnimationFrame(mapview.resize);
}
messeHoehe();
// Mehrfach und aus verschiedenen Anlässen messen: Auf iOS liefert der erste
// Aufruf beim Laden manchmal noch einen unfertigen Wert (beobachtet als
// wiederkehrender Streifen unten), ein zweiter kurz danach korrigiert das.
setTimeout(messeHoehe, 300);
window.addEventListener("resize", messeHoehe);
window.addEventListener("orientationchange", () => setTimeout(messeHoehe, 250));
window.addEventListener("pageshow", messeHoehe);
document.addEventListener("visibilitychange", () => { if (!document.hidden) messeHoehe(); });
window.visualViewport?.addEventListener("resize", messeHoehe);
window.visualViewport?.addEventListener("scroll", messeHoehe);

const tabs = $$(".tabbar button[data-view]");
const views = {
  map: $("#view-map"), reise: $("#view-reise"), logbuch: $("#view-logbuch"), mehr: $("#view-mehr"),
};
let mapSchonGeoeffnet = false;

function renderLogbookPlacesIfOpen() {
  const fold = $(".places-fold");
  if (!fold?.open) return;
  buildFilterOptions();
  renderCategoryChips();
  renderPlaces();
}

// Gast-Modus sperrt einzelne Tabs, statt sie aus der Leiste zu entfernen —
// die Tabbar bleibt für Eigentümer und Gast an derselben Stelle gleich
// aufgebaut, nur eben mit unterschiedlichen aktiven Einträgen.
const tabsGesperrt = new Set();

// Sofortiges Auffrischen beim Wechsel auf den Kartenreiter (siehe go()
// weiter unten) — Eigentümer- und Gast-Betrieb holen ihre Daten über
// unterschiedliche Funktionen (siehe die jeweiligen Intervalle weiter
// unten in dieser Datei), hier beide Fälle einmal zentral.
function aktualisiereKarteJetzt() {
  if (state.gast) {
    const t = state.trips.find((tr) => tr.id === state.mapTripId);
    if (t) { ladeGastLivePosition(t); ladeGastRoute(t); }
    return;
  }
  if (state.config.demo) return;
  loadLivePosition();
  const t = mapTrip();
  if (t) ensureTripPath(t, { force: true, silent: true });
  aktualisiereFahrtenWennAlt();
}

function go(name) {
  if (tabsGesperrt.has(name)) return;
  const aktuell = tabs.find((t) => t.getAttribute("aria-selected") === "true")?.dataset.view;
  if (aktuell !== name && !duerfteWeg()) return;
  // Erneuter Klick auf den bereits aktiven Tab setzt ihn auf seine
  // Standardansicht zurück, statt einfach nichts zu tun (Nutzerwunsch,
  // 18. August 2026) — z. B. um von einer einzelnen Fahrt auf der Karte
  // oder einem gesetzten Logbuch-Filter wieder "ganz nach oben" zu kommen.
  const erneutGeklickt = aktuell === name;
  // Verlässt man die Karte auf einem ANDEREN Weg als dem eigenen
  // Zurück-Knopf (z. B. direkt auf "Reisen" tippen), ist der Rücksprung
  // in den Orte-Editor nicht mehr gemeint — sonst würde ein späteres
  // "Auf Karte zeigen" eines anderen Orts plötzlich hierher zurückführen.
  if (name !== "map") placeRueckkehrKontext = null;
  tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.view === name)));
  for (const [key, node] of Object.entries(views)) node.classList.toggle("active", key === name);
  // Jede .view scrollt unabhängig (position:absolute + eigenes overflow-y)
  // und merkt sich ihre Scroll-Position, solange sie nur ausgeblendet statt
  // neu aufgebaut wird — ohne das hier würde man z. B. unten bei den
  // Höhenprofil-/Geschwindigkeits-Karten in Reisen landen, nur weil man
  // beim letzten Besuch dort runtergescrollt hatte (Nutzerrückmeldung,
  // 18. August 2026). Bei jedem Tab-Wechsel (neu ODER erneut) wieder ganz
  // nach oben, kein Sonderfall je Tab nötig.
  if (views[name]) views[name].scrollTop = 0;
  if (name === "map") {
    if (erneutGeklickt) { clearAdhoc(); mapview.resetLiveCentering(); }
    requestAnimationFrame(() => {
      mapview.resize();
      if (!mapSchonGeoeffnet || erneutGeklickt) {
        mapview.fitTrip();
        mapSchonGeoeffnet = true;
      }
    });
    // Sofort auffrischen statt auf den nächsten Timer-Tick zu warten — die
    // Karte wirkte sonst öfter veraltet, wenn man erst beim Reintippen in
    // den Kartenreiter bemerkt, dass Position/Route ein paar Minuten alt
    // sind (Nutzerwunsch, 05.09.2026).
    aktualisiereKarteJetzt();
  }
  if (name === "logbuch") {
    if (erneutGeklickt) {
      resetPlaceFilters();
      const fold = $(".places-fold");
      if (fold) fold.open = false;
    }
    renderJournal();
    renderLogbookPlacesIfOpen();
  }
  if (name === "reise") {
    if (erneutGeklickt) resetReiseAnsicht();
    renderTrips();
  }
  if (name === "mehr") showMorePanel("wache");
}
tabs.forEach((t) => t.addEventListener("click", () => go(t.dataset.view)));

/** Sperrt einen Tab für die Gast-Ansicht: bleibt an seinem Platz, wirkt aber
 * inaktiv (kein Klick, gedimmt); `ohneBeschriftung` entfernt zusätzlich den
 * Text, das Icon bleibt stehen — für "Mehr", das für Gäste nichts anbietet. */
function sperreTab(name, { ohneBeschriftung = false } = {}) {
  tabsGesperrt.add(name);
  const btn = tabs.find((t) => t.dataset.view === name);
  if (!btn) return;
  btn.classList.add("tab-gesperrt");
  btn.setAttribute("aria-disabled", "true");
  btn.tabIndex = -1;
  if (ohneBeschriftung) {
    for (const node of [...btn.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) node.remove();
    }
  }
}

/* ---------- Detail-Ansichten ---------- */
let tripDetailEdit = null;
let currentTripId = null;

// "Auf Karte zeigen" aus dem Orte-Editor heraus, mit "Zurück"-Funktion wie
// bei Fahrten/Reisen (siehe kartenRueckkehrKontext in trips.js) — hier
// eigens für einen einzelnen Ort, da der Rücksprung wieder in den
// Orte-Editor führt, nicht in die Reisen-Ansicht (Nutzerwunsch,
// 6. September 2026).
let placeRueckkehrKontext = null;

const tripSheet = createSheet({
  id: "trip-sheet", confirmId: "trip-confirm",
  isDirty: () => Boolean(tripDetailEdit?.isDirty()),
  onSave: () => tripDetailEdit?.commit(),
  onClose: () => { tripDetailEdit = null; },
});

const editSheet = createSheet({
  id: "edit-sheet", confirmId: "edit-confirm",
  isDirty: editorDirty,
  onSave: saveEditor,
  onClose: clearEditor,
});

const noteSheet = createSheet({
  id: "note-sheet", confirmId: "note-confirm",
  isDirty: noteDirty,
  onSave: saveNote,
  onClose: clearNote,
});

const alleSheets = [tripSheet, editSheet, noteSheet];

/**
 * Nur eine Detailansicht ist je sichtbar. Ohne das blieb z. B. ein Ort-Editor
 * offen, wenn man aus dem Tagebuch anschließend eine Notiz antippte — beide
 * lagen dann übereinander (sichtbar wurde nur, was zuletzt im HTML steht).
 * Offene Änderungen fragen dabei ganz normal nach, statt sie zu verwerfen.
 */
function schliesseAndere(ziel) {
  for (const s of alleSheets) {
    if (s === ziel || !s.isOpen()) continue;
    if (s.isDirty()) { s.requestClose(); return false; }
    s.close();
  }
  return true;
}

wireEscape(alleSheets);

$("#sheet-back").addEventListener("click", tripSheet.requestClose);
$("#edit-back").addEventListener("click", editSheet.requestClose);
$("#note-back").addEventListener("click", noteSheet.requestClose);
$$("[data-share]").forEach((b) => b.addEventListener("click", () => {
  const t = currentTripId ? trip(currentTripId) : null;
  if (!t) return;
  teileReise(t, { naechte: nightsOf(t.id).length, orte: tripPlaces(t.id).length });
}));

function openTripDetail(id) {
  // Gast-Ansicht: keine bearbeitbare Detail-Ansicht, nur auf der Karte
  // zeigen — das ist bei "alle Reisen" der einzige Weg, zwischen Reisen zu
  // wechseln (siehe Tabbar-Aufbau weiter unten).
  if (state.gast) { zeigeGastReise(id); go("map"); return; }
  if (!schliesseAndere(tripSheet)) return;
  currentTripId = id;
  tripDetailEdit = renderTripDetail(id, {
    // Bewusst nicht über openEditor(): Aus der Reise-Detailansicht heraus
    // bleibt diese im Hintergrund offen, damit „Zurück" wieder dorthin führt
    // (siehe initPlaceEditor.onChange unten) — kein Fall der Geschwister-Regel.
    onStopClick: (place) => { editSheet.open(); openPlaceEditor(place); },
    onClose: tripSheet.close,
    onEdit: (edit) => { tripDetailEdit = edit; },
  });
  tripSheet.open();
  const t = trip(id);
  // Kein t.path?.length-Vorabcheck — ensureTripPath() weiß selbst, ob die
  // vorhandene Spur noch zum aktiven Gerät passt (siehe dort).
  if (t) ensureTripPath(t, { silent: true });
}

/** Direkter Aufruf (Karte, Ortsliste, Tagebuch) — hier darf nichts anderes offen bleiben. */
function openEditor(place) {
  // Gast-Ansicht: nur lesen, kein Editor. Der Server würde ein Speichern
  // ohnehin ablehnen (keine Sitzung) — hier geht es nur darum, gar nicht
  // erst einen toten Knopf anzubieten.
  if (state.gast) return;
  if (!schliesseAndere(editSheet)) return;
  editSheet.open();
  openPlaceEditor(place);
}

/* ---------- Ansichten aufbauen ---------- */
initTrips({ onOpenDetail: openTripDetail, onShowMap: () => go("map") });

initPlaces({ onEdit: openEditor, getMapCenter: () => mapview.center() });
$(".places-fold")?.addEventListener("toggle", (event) => {
  if (event.currentTarget.open) renderLogbookPlacesIfOpen();
});

initPlaceEditor({
  onUndoOffer: (msg, restore) => offerUndo(msg, restore),
  onChange: ({ closed }) => {
    editSheet.close();
    renderLogbookPlacesIfOpen();
    renderTrips();
    mapview.draw();
    if (tripSheet.isOpen() && currentTripId) openTripDetail(currentTripId);
  },
  onShowOnMap: (place) => {
    // Bei offenen Änderungen erst fragen (wie der normale Zurück-Knopf),
    // statt sie stillschweigend zu verwerfen.
    if (editSheet.isDirty()) { editSheet.requestClose(); return; }
    editSheet.close();
    // Ausgangszustand merken, damit "Zurück" ihn wiederherstellt (Nutzerfund,
    // 6. September 2026: blieb bisher auf der Karte stehen, statt wie bei
    // Fahrten/Tagen zur vorherigen Ansicht UND zum vorherigen Reiter
    // zurückzukehren — man kam ja z. B. vom Logbuch, nicht von der Karte).
    const vorherigerTab = tabs.find((t) => t.getAttribute("aria-selected") === "true")?.dataset.view;
    placeRueckkehrKontext = { place, vorherigeMapTripId: state.mapTripId, vorherigerTab };
    if (place.tripId && place.tripId !== state.mapTripId) showTripOnMap(place.tripId);
    go("map");
    mapview.resetLiveCentering();
    requestAnimationFrame(() => mapview.focusOn(place.lat, place.lon));
    renderMapFocusBar();
  },
});

function openNote(note) {
  if (state.gast) return; // nur lesen, kein Editor — wie bei openEditor()
  if (!schliesseAndere(noteSheet)) return;
  openNoteEditor(note);
}

initNoteEditor({
  onOpen: () => noteSheet.open(),
  onUndoOffer: (msg, restore) => offerUndo(msg, restore),
  onChange: () => { noteSheet.close(); renderJournal(); mapview.draw(); },
});

initJournal({
  onPlaceClick: (place) => openEditor(place),
  onNoteClick: (note) => openNote(note),
});

// Notizen entstehen im Tagebuch — dort gehören sie hin.
const logCreatePicker = $("#log-create-picker");
const closeLogCreatePicker = () => { if (logCreatePicker) logCreatePicker.hidden = true; };
$("#log-add")?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (logCreatePicker) logCreatePicker.hidden = false;
});
$("#log-create-close")?.addEventListener("click", closeLogCreatePicker);
logCreatePicker?.addEventListener("click", (e) => { if (e.target === logCreatePicker) closeLogCreatePicker(); });

$("#add-note").addEventListener("click", () => {
  closeLogCreatePicker();
  if (!schliesseAndere(noteSheet)) return;
  captureNote({ fallbackCenter: () => mapview.center() });
});
$("#add-here")?.addEventListener("click", closeLogCreatePicker);

initGuard({
  onShowOnMap: (lat, lon) => {
    go("map");
    mapview.resetLiveCentering();
    requestAnimationFrame(() => mapview.focusOn(lat, lon, { zoom: 17 }));
  },
});

initSettings({
  onCategoriesChange: () => { renderCategoryPicker(); renderLogbookPlacesIfOpen(); mapview.draw(); },
  onSourceChange: async () => {
    renderStatusBar();
    await loadData();
    renderTrips(); renderLogbookPlacesIfOpen(); renderCategoryPicker();
    renderVehicles(); renderCategories(); renderVehicleLine();
    renderStatusPill(); renderStatusBar();
    mapview.resetLiveCentering();
    mapview.draw({ fit: true });
    loadLivePosition();
    loadGuard();
  },
});
const moreTabs = $$("#more-tabs [data-more-panel]");
const morePanels = $$("#view-mehr .more-panel");
function showMorePanel(name) {
  const aktuell = moreTabs.find((b) => b.getAttribute("aria-pressed") === "true")?.dataset.morePanel;
  if (aktuell && aktuell !== name && !duerfteWeg()) return;
  moreTabs.forEach((btn) => btn.setAttribute("aria-pressed", String(btn.dataset.morePanel === name)));
  morePanels.forEach((panel) => { panel.hidden = panel.dataset.morePanel !== name; });
  // Zonen/Protokoll frisch laden, sobald die Wache geöffnet wird — sonst
  // sähe man neue Zonen-Ereignisse erst nach einem vollen Neuladen der App.
  if (name === "wache") loadGuard();
}
moreTabs.forEach((btn) => btn.addEventListener("click", () => showMorePanel(btn.dataset.morePanel)));
showMorePanel("wache");
const oeffneEinstellungen = () => { go("mehr"); showMorePanel("settings"); };

const contextButtons = ["trip-context-map", "trip-context-reise", "trip-context-logbuch"].map((id) => $("#" + id)).filter(Boolean);
const tripPicker = $("#trip-picker");
const tripPickerList = $("#trip-picker-list");
const rangePicker = $("#range-picker");
const datumKurz = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "—";
};
const kmKurz = (n) => `${Number(n || 0).toLocaleString("de-DE", { maximumFractionDigits: 0 })} km`;
const pad2 = (n) => String(n).padStart(2, "0");
const inputDatum = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function rangePreset(preset) {
  const now = new Date();
  if (preset === "today") return { from: startOfDay(now), to: now, label: "Heute" };
  if (preset === "yesterday") {
    const d = new Date(now.getTime() - 86400000);
    return { from: startOfDay(d), to: endOfDay(d), label: "Gestern" };
  }
  if (preset === "last7") return { from: new Date(now.getTime() - 7 * 86400000), to: now, label: "letzte 7 Tage" };
  if (preset === "month") return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now, label: "dieser Monat" };
  const starts = state.trips.map((t) => Date.parse(t.range?.from || t.start || "")).filter(Number.isFinite);
  const ends = state.trips.map((t) => Date.parse(t.range?.to || t.end || new Date().toISOString())).filter(Number.isFinite);
  return {
    from: new Date(starts.length ? Math.min(...starts) : now.getTime() - 30 * 86400000),
    to: new Date(ends.length ? Math.max(...ends) : now),
    label: "Alles",
  };
}

function setRangeInputs({ from, to }) {
  const von = $("#range-from");
  const bis = $("#range-to");
  if (von) von.value = inputDatum(from);
  if (bis) bis.value = inputDatum(to);
}

async function switchTripContext(value, control) {
  if (!value) return;
  if (value === "__new") {
    if (state.gast) return; // Gäste legen keine Reisen an
    closeTripPicker();
    await startNewTripFromContext(control);
    renderTripContexts();
    return;
  }
  if (value === "__range") {
    closeTripPicker();
    openRangePicker();
    return;
  }
  closeTripPicker();
  showTripOnMap(value);
  const t = trip(value);
  // Kein t.path?.length-Vorabcheck — ensureTripPath() weiß selbst, ob die
  // vorhandene Spur noch zum aktiven Gerät passt (siehe dort).
  if (t) ensureTripPath(t, { silent: true });
  renderTripContexts();
}

function tripPeriodLabel(t) {
  if (!t) return "Keine Reise ausgewählt";
  const start = datumKurz(t.start || t.range?.from);
  const end = t.end || t.range?.to ? datumKurz(t.end || t.range?.to) : t.live ? "läuft" : "";
  return [start, end].filter(Boolean).join(" – ");
}

/** Scharf, aber außerhalb des beim Scharfschalten gemerkten Radius —
 * dann Dauerlicht statt Blinken (siehe renderTripContextButton), auf einen
 * Blick als "Zone gerade verlassen" erkennbar. Andere Meldungswege (Push/
 * Mail/…) folgen separat, das hier ist bewusst nur der erste, sofort
 * sichtbare Schritt. */
function wacheVerlassen() {
  if (!state.guardArmed || !state.guardAnchor || !state.livePosition) return false;
  const kmWeg = distanceKm(state.guardAnchor.lon, state.guardAnchor.lat, state.livePosition.lon, state.livePosition.lat);
  return kmWeg * 1000 > state.guardRadius;
}

function renderTripContextButton(button, selected, { pulse = false } = {}) {
  // Scharf schalten setzt immer einen Ankerpunkt (siehe guard.js) — "scharf"
  // und "es gibt einen überwachten Bereich" sind im neuen, zonenlosen
  // Modell also dasselbe, kein zusätzlicher Zonen-Check nötig.
  const istZeitraum = isRangeTrip(selected);
  const bewacht = selected?.live && state.guardArmed;
  render(button, [
    el("span.trip-live-dot" + (selected?.live ? ".live" : "") + (istZeitraum ? ".range" : "") + (pulse ? ".pulse" : "") + (bewacht ? ".guarded" : "") + (bewacht && wacheVerlassen() ? ".outside" : "")),
    el("span.trip-context-copy", {}, [
      el("b", { text: selected?.name || "Keine Reise" }),
      el("small", { text: selected ? tripPeriodLabel(selected) : "Antippen zum Auswählen" }),
    ]),
    selected ? el("span.trip-context-km", { text: kmKurz(selected.km) }) : null,
    el("span.trip-context-chev", { text: "▾" }),
  ]);
}

function openTripPicker() {
  // Bei Freigabe auf nur eine Reise gibt es nichts zum Wechseln — der
  // Picker soll dann gar nicht erst aufgehen (sonst wirkt es, als gäbe es
  // eine Wahl, die es nicht gibt).
  if (state.gast && !state.gast.alleReisen) return;
  renderTripPicker();
  tripPicker.hidden = false;
}

function closeTripPicker() {
  if (tripPicker) tripPicker.hidden = true;
}

function openRangePicker() {
  if (state.gast) return;
  const preset = state.rangeTrip?.range
    ? { from: new Date(state.rangeTrip.range.from), to: new Date(state.rangeTrip.range.to || new Date()) }
    : rangePreset("last7");
  setRangeInputs(preset);
  if (rangePicker) rangePicker.hidden = false;
}

function closeRangePicker() {
  if (rangePicker) rangePicker.hidden = true;
}

async function applyRangeContext(label = null) {
  const fromValue = $("#range-from")?.value;
  const toValue = $("#range-to")?.value;
  const fromDate = fromValue ? new Date(fromValue) : null;
  const toDate = toValue ? new Date(toValue) : null;
  if (!fromDate || !toDate || Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || toDate < fromDate) {
    toast("Bitte einen gültigen Zeitraum wählen");
    return;
  }
  const from = fromDate.toISOString();
  const to = toDate.toISOString();
  closeRangePicker();
  try {
    const rangeTrip = await buildRangeTrip({ from, to, label: label || "Zeitraum" });
    if (!rangeTrip) { toast("Für diesen Zeitraum fehlen Gerätedaten"); return; }
    showRangeOnMap(rangeTrip);
    await loadDrives({ from, to });
    renderTripContexts();
    renderTrips();
  } catch (err) {
    toast(err.message || "Zeitraum konnte nicht geladen werden");
  }
}

function renderTripPicker() {
  if (!tripPickerList) return;
  const selected = state.rangeTrip || trip(state.mapTripId) || activeTrip() || state.trips[0] || null;
  render(tripPickerList, [
    state.gast ? null : el("button.trip-picker-row", {
      "aria-pressed": String(isRangeTrip(selected)),
      on: { click: () => switchTripContext("__range") },
    }, [
      el("i", { text: "Z" }),
      el("span", {}, [
        el("b", { text: "Zeitraum wählen" }),
        el("small", { text: state.rangeTrip ? tripPeriodLabel(state.rangeTrip) : "Reisen und Statistik über mehrere Reisen" }),
      ]),
      state.rangeTrip ? el("em", { text: kmKurz(state.rangeTrip.km) }) : null,
    ]),
    ...state.trips.map((t) => el("button.trip-picker-row", {
      "aria-pressed": String(selected?.id === t.id),
      on: { click: () => switchTripContext(t.id) },
    }, [
      el("i", { style: { background: `hsl(${t.hue},70%,52%)` } }),
      el("span", {}, [
        el("b", { text: t.name }),
        el("small", { text: tripPeriodLabel(t) }),
      ]),
      el("em", { text: kmKurz(t.km) }),
    ])),
    state.gast ? null : el("button.trip-picker-row.trip-picker-new", {
      on: { click: (e) => switchTripContext("__new", e.currentTarget) },
    }, [
      el("i", { text: "+" }),
      el("span", {}, [
        el("b", { text: "Neue Reise starten" }),
      ]),
    ]),
  ]);
}

function renderTripContexts({ pulse = false } = {}) {
  const selected = state.rangeTrip || trip(state.mapTripId) || activeTrip() || state.trips[0] || null;
  for (const button of contextButtons) renderTripContextButton(button, selected, { pulse });
}

function renderMapFocusBar() {
  const bar = $("#map-focusbar");
  if (!bar) return;
  // placeRueckkehrKontext (Rücksprung in den Orte-Editor) hat Vorrang vor
  // dem Reise-Fokus — beide können nicht gleichzeitig sinnvoll gemeint
  // sein, und "Auf Karte zeigen" aus dem Editor ist die zuletzt gewollte
  // Aktion.
  const focused = placeRueckkehrKontext || state.adhocTrip;
  bar.hidden = !focused;
  if (!focused) return;
  // Zeigt die Karte einen Tag einer Reise, genügt "Tag 3" (der Reisename steht
  // darüber) — Platz für Vorheriger/Nächster.
  const tagNav = placeRueckkehrKontext ? null : tagKartenNavigation();
  const label = $("#map-focus-label");
  if (label) label.textContent = placeRueckkehrKontext ? (placeRueckkehrKontext.place.title || "Ort") : (tagNav?.titel || focused.name || "Kartenausschnitt");
  for (const [id, hat] of [["#map-focus-prev", tagNav?.hatVorher], ["#map-focus-next", tagNav?.hatNaechster]]) {
    const knopf = $(id);
    if (!knopf) continue;
    knopf.hidden = !tagNav;
    knopf.disabled = !hat;
  }
}

$("#map-focus-prev")?.addEventListener("click", () => kartenTagWechseln(-1));
$("#map-focus-next")?.addEventListener("click", () => kartenTagWechseln(1));

$("#map-focus-back")?.addEventListener("click", () => {
  // Kam der Fokus aus "Auf Karte zeigen" im Orte-Editor, führt "Zurück"
  // wieder dorthin (Nutzerwunsch, 6. September 2026) — Vorrang vor dem
  // Reise-Rücksprung unten, siehe renderMapFocusBar().
  if (placeRueckkehrKontext) {
    const { place, vorherigeMapTripId, vorherigerTab } = placeRueckkehrKontext;
    placeRueckkehrKontext = null;
    // Kartenzustand von vor dem Klick auf "Auf Karte zeigen" zurück —
    // andere Reise wieder anzeigen, oder bei gleicher Reise nur die
    // Zoomstufe zurücksetzen (die hat focusOn() ja verändert) — bevor der
    // Reiter wechselt, damit die Karte im Hintergrund schon stimmt, falls
    // man später ohne erneuten Klick dorthin zurückkommt.
    if (vorherigeMapTripId !== state.mapTripId) showTripOnMap(vorherigeMapTripId);
    else mapview.fitTrip();
    // Zurück zum Reiter, von dem aus der Ort geöffnet wurde (z. B.
    // Logbuch) — vorher blieb man auf "Karte" stehen, mit dem Editor nur
    // darüber geöffnet.
    if (vorherigerTab) go(vorherigerTab);
    openEditor(place);
    return;
  }
  // Kam die Einzel-Fahrt/der Tag von "Reisen > Fahrten" (bzw. "Tage"), führt
  // "Zurück" wirklich dorthin zurück, statt nur die Karte auf die ganze
  // Reise zurückzusetzen — erwartetes Zurück-Verhalten (17./18. August
  // 2026, Nutzerrückmeldung): Ansicht UND Fokus wiederherstellen.
  if (stelleKartenRueckkehrWieder()) { clearAdhoc(); go("reise"); return; }
  const ziel = state.mapTripId || activeTrip()?.id || state.trips[0]?.id;
  if (ziel) showTripOnMap(ziel);
});

contextButtons.forEach((button) => button.addEventListener("click", openTripPicker));
$("#trip-picker-close")?.addEventListener("click", closeTripPicker);
tripPicker?.addEventListener("click", (e) => { if (e.target === tripPicker) closeTripPicker(); });
$("#range-picker-close")?.addEventListener("click", closeRangePicker);
rangePicker?.addEventListener("click", (e) => { if (e.target === rangePicker) closeRangePicker(); });
$$("#range-picker [data-range-preset]").forEach((button) => {
  button.addEventListener("click", () => {
    const preset = rangePreset(button.dataset.rangePreset);
    setRangeInputs(preset);
    applyRangeContext(preset.label);
  });
});
$("#range-apply")?.addEventListener("click", () => applyRangeContext());

const screen = $(".screen");
const navToggle = $("#nav-toggle");
const navCollapsedKey = "vojago.navCollapsed";
const mapContextBar = $(".map-context-bar");
const mapContextToggle = $("#map-context-toggle");
const mapContextCollapsedKey = "vojago.mapContextCollapsed";

function setNavCollapsed(collapsed) {
  screen?.classList.toggle("nav-collapsed", collapsed);
  navToggle?.setAttribute("aria-label", collapsed ? "Menü ausklappen" : "Menü einklappen");
  navToggle?.setAttribute("title", collapsed ? "Menü ausklappen" : "Menü einklappen");
  try { localStorage.setItem(navCollapsedKey, collapsed ? "1" : "0"); } catch { /* egal */ }
}

setNavCollapsed(localStorage.getItem(navCollapsedKey) === "1");
navToggle?.addEventListener("click", () => setNavCollapsed(!screen?.classList.contains("nav-collapsed")));

function setMapContextCollapsed(collapsed) {
  mapContextBar?.classList.toggle("is-collapsed", collapsed);
  if (mapContextToggle) {
    mapContextToggle.setAttribute("aria-label", collapsed ? "Obere Auswahl ausklappen" : "Obere Auswahl einklappen");
    mapContextToggle.setAttribute("title", collapsed ? "Obere Auswahl ausklappen" : "Obere Auswahl einklappen");
    render(mapContextToggle, [icon(collapsed ? ICON.chevronDown : ICON.chevronUp, 18)]);
  }
  try { localStorage.setItem(mapContextCollapsedKey, collapsed ? "1" : "0"); } catch { /* egal */ }
  setTimeout(() => mapview.resize(), 80);
}

setMapContextCollapsed(localStorage.getItem(mapContextCollapsedKey) === "1");
mapContextToggle?.addEventListener("click", () => setMapContextCollapsed(!mapContextBar?.classList.contains("is-collapsed")));

/* ---------- Karte ---------- */
mapview.initMap({ onPlaceSelect: showPopover, onNoteSelect: showNotePopover });

const metricBtn = $("#metric-btn");
const metricMenu = $("#metric-menu");
const metricLabel = $("#metric-label");
const metricName = (metric) => ({ none: "Einfarbig", trip: "Reisen", day: "Tag", speed: "Tempo", elev: "Höhe", dist: "Strecke" }[metric] || "Tag");
const closeMetricMenu = () => {
  metricMenu?.classList.remove("open");
  metricBtn?.setAttribute("aria-expanded", "false");
};
const closeLayersMenu = () => {
  layersMenu?.classList.remove("open");
  layersBtn?.setAttribute("aria-expanded", "false");
};

metricBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = !metricMenu.classList.contains("open");
  closeLayersMenu();
  metricMenu.classList.toggle("open", open);
  metricBtn.setAttribute("aria-expanded", String(open));
});

$$("#metric-menu [data-metric]").forEach((btn) => {
  btn.addEventListener("click", () => {
    setMetric(btn.dataset.metric);
    closeMetricMenu();
    syncPreferences();
  });
});
function renderMetricButtons() {
  const tripMetricAvailable = isRangeTrip(mapTrip()) && rangeTrips(mapTrip().range).length > 1;
  if (state.metric === "trip" && !tripMetricAvailable) {
    setMetric("day");
    return;
  }
  if (metricLabel) metricLabel.textContent = metricName(state.metric);
  $$("#metric-menu [data-metric]").forEach((b) => {
    b.hidden = b.dataset.metric === "trip" && !tripMetricAvailable;
    b.setAttribute("aria-pressed", String(b.dataset.metric === state.metric));
  });
}

$("#zoom-in").addEventListener("click", mapview.zoomIn);
$("#zoom-out").addEventListener("click", mapview.zoomOut);
$("#recenter").addEventListener("click", mapview.fitTrip);

const layersBtn = $("#layers-btn");
const layersMenu = $("#layers-menu");
layersBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = !layersMenu.classList.contains("open");
  closeMetricMenu();
  layersMenu.classList.toggle("open", open);
  layersBtn.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (e) => {
  if (metricMenu?.classList.contains("open") && !metricMenu.contains(e.target) && !metricBtn.contains(e.target)) {
    closeMetricMenu();
  }
  if (layersMenu.classList.contains("open") && !layersMenu.contains(e.target) && !layersBtn.contains(e.target)) {
    closeLayersMenu();
  }
});

for (const [id, key] of [["lc-overnight", "nights"], ["lc-places", "places"], ["lc-notes", "notes"], ["lc-km", "km"]]) {
  const sw = $("#" + id);
  sw.addEventListener("click", () => {
    const on = sw.getAttribute("aria-checked") !== "true";
    sw.setAttribute("aria-checked", String(on));
    state.layers[key] = on;
    mapview.draw();
    syncPreferences();
  });
}
// Gelände-Schummerung gehört zur Karte dieses Geräts (nicht zur Reise) — daher
// in der Gerätekonfiguration statt in state.layers.
const terrainSwitch = $("#lc-terrain");
terrainSwitch.setAttribute("aria-checked", String(Boolean(state.config.gelaende)));
terrainSwitch.addEventListener("click", () => {
  const on = terrainSwitch.getAttribute("aria-checked") !== "true";
  terrainSwitch.setAttribute("aria-checked", String(on));
  state.config.gelaende = on;
  saveConfig();
  mapview.setTerrain(on);
});
function renderLayerSwitches() {
  for (const [id, key] of [["lc-overnight", "nights"], ["lc-places", "places"], ["lc-notes", "notes"], ["lc-km", "km"]]) {
    const sw = $("#" + id);
    if (sw) sw.setAttribute("aria-checked", String(Boolean(state.layers[key])));
  }
}

/* ---------- Info-Karte zu einem Ort oder einer Notiz ----------
   Ein Marker antippen zeigt erst diese kurze Karte — „Bearbeiten" öffnet
   danach den vollen Editor. Notizen liefen bisher direkt in den vollen
   Editor, ohne diesen Zwischenschritt; jetzt einheitlich wie bei Orten. */
let popoverPlace = null;
let popoverNote = null;
const popover = $("#popover");

function showPopover(place) {
  popoverNote = null;
  popoverPlace = place;
  popover.classList.remove("is-note");
  const cat = category(place.catId);
  $("#pop-photo").style.background = photoGradient(place.hue);
  $("#pop-swatch").style.background = cat.color;
  $("#pop-title").textContent = place.title;
  $("#pop-cat").textContent = `${cat.name} · ${"★".repeat(place.stars)}${"☆".repeat(5 - place.stars)}`;
  $("#pop-note").textContent = place.note;
  $("#pop-coords").textContent = `◎ ${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}`;
  $("#pop-date").textContent = `${place.date} · ${{ camper: "🚐 Camper", handy: "🚶 Handy", manuell: "📍 manuell" }[place.source] || ""}`;
  popover.classList.add("show");
}

const notizZeitpunkt = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

function showNotePopover(note) {
  popoverPlace = null;
  popoverNote = note;
  popover.classList.add("is-note");
  $("#pop-swatch").style.background = "var(--ink-faint)";
  $("#pop-title").textContent = note.title || "Notiz";
  $("#pop-cat").textContent = note.weather ? wetterZeile(note.weather) : "";
  $("#pop-note").textContent = note.text;
  $("#pop-coords").textContent = note.lat != null && note.lon != null
    ? `◎ ${Number(note.lat).toFixed(4)}, ${Number(note.lon).toFixed(4)}` : "";
  $("#pop-date").textContent = notizZeitpunkt(note.at);
  popover.classList.add("show");
}

$("#pop-close").addEventListener("click", () => popover.classList.remove("show"));
$("#pop-share").addEventListener("click", () => { if (popoverPlace) teileOrt(popoverPlace); });
$("#pop-edit").addEventListener("click", () => {
  popover.classList.remove("show");
  if (popoverNote) openNote(popoverNote);
  else if (popoverPlace) openEditor(popoverPlace);
});

/* ---------- Kopfzeile ---------- */
function renderVehicleLine() {
  const line = $("#vehline");
  const vehicle = state.vehicles[state.activeVehicle];
  line.textContent = vehicle ? vehicle.name + (state.vehicles.length > 1 ? " ▾" : "") : "";
  line.classList.toggle("hidden", !state.showVehicleName || !vehicle);
}
$("#vehline").addEventListener("click", (e) => { e.stopPropagation(); if (!state.gast) oeffneEinstellungen(); });

// N3 — Marke ist die Startseite: aktuelle Reise auf der Karte, ganz eingepasst
$("#home-btn").addEventListener("click", () => {
  const ziel = state.activeTripId || (state.trips[0] && state.trips[0].id);
  if (ziel && ziel !== state.mapTripId) showTripOnMap(ziel);
  else mapview.fitTrip();
  go("reise");
});

function liveZeitpunktText(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "keine GPS-Meldung";
}

function renderStatusPill() {
  const pill = $("#statuspill");
  if (!pill) return;
  const liveText = state.config.demo ? "Demo" : `Live · ${liveAlterText(state.livePosition?.at)}`;
  render(pill, [el("span.dot"), liveText]);
  const gpsAlter = Date.now() - Date.parse(state.livePosition?.at || "");
  const frisch = Number.isFinite(gpsAlter) && gpsAlter <= 5 * 60 * 1000;
  pill.querySelector(".dot").style.background = state.config.demo ? "var(--warn)" : frisch ? "var(--good)" : "var(--warn)";
  pill.title = state.config.demo
    ? (state.account ? `Angemeldet als ${state.account.username} — es werden aber Beispieldaten gezeigt` : "Beispieldaten — in den Einstellungen umschaltbar")
    : `Letzte GPS-Meldung: ${liveZeitpunktText(state.livePosition?.at)}`;
}

/* ---------- Statusband: Laden, Fehler, leere Ansicht ---------- */
function renderStatusBar() {
  const bar = $("#app-status");
  const icon = $("#as-icon");
  const text = $("#as-text");
  const action = $("#as-action");

  bar.classList.toggle("error", Boolean(dataStatus.error));
  render(icon, []);
  action.hidden = true;

  if (dataStatus.loading) {
    bar.hidden = false;
    icon.appendChild(el("span.spinner"));
    text.textContent = "Daten werden geladen …";
    return;
  }
  if (dataStatus.error) {
    bar.hidden = false;
    icon.textContent = "⚠";
    text.textContent = dataStatus.error;
    action.hidden = false;
    action.textContent = "Erneut versuchen";
    return;
  }
  bar.hidden = true;
}

$("#as-action").addEventListener("click", () => loadData());

/* ---------- Löschen rückgängig machen ---------- */
const undoBar = el("div.undo-bar#undo-bar");
$(".screen").appendChild(undoBar);
let undoTimer = null;

export function offerUndo(message, restore) {
  clearTimeout(undoTimer);
  render(undoBar, [
    el("span", { text: message }),
    el("button", { text: "Rückgängig", on: { click: () => { clearTimeout(undoTimer); undoBar.classList.remove("show"); restore(); } } }),
  ]);
  undoBar.classList.add("show");
  undoTimer = setTimeout(() => undoBar.classList.remove("show"), 6000);
}

/* ---------- Auf Zustandsänderungen reagieren ---------- */
subscribe((topic) => {
  if (topic === "status") renderStatusBar();
  if (topic === "routeInfo") renderRouteInfo();
  // Beim Wechsel der gezeigten Reise gehört eine offene Ortskarte nicht mehr dazu
  if (topic === "mapTrip" || topic === "trips") popover.classList.remove("show");
  if (topic === "mapTrip") { renderTripContexts(); renderMapFocusBar(); renderTrips(); renderJournal(); renderLogbookPlacesIfOpen(); }
  if (topic === "metric") renderMetricButtons();
  if (topic === "metric" || topic === "mapTrip") mapview.draw({ fit: topic === "mapTrip" });
  if (topic === "trips") { renderTripContexts(); renderMetricButtons(); renderLayerSwitches(); mapview.draw({ fit: true }); buildFilterOptions(); }
  // Die Spur der laufenden Reise wächst im Hintergrund nach (siehe Intervall
  // unten) — anders als bei "trips" hier ohne Neueinpassen, sonst würde die
  // Karte alle paar Minuten unter der Hand wegspringen.
  if (topic === "tripPath") { renderTripContexts({ pulse: true }); renderMapFocusBar(); mapview.draw(); renderTrips(); detailNeuZeichnen(); }
  if (topic === "places") { renderLogbookPlacesIfOpen(); renderTrips(); }
  if (topic === "places" || topic === "notes") { mapview.draw(); renderJournal(); }
  // renderTripContexts() auch hier: die Live-LED prüft bei jedem neuen
  // Positionsabruf erneut, ob die Wache-Zone gerade verlassen wurde.
  if (topic === "livePosition") { renderStatusPill(); mapview.draw(); renderTripContexts(); renderGuardInfo(); }
  if (topic === "drives") { renderTrips(); mapview.draw(); }
  if (topic === "routeDriveFilter") { renderTrips(); renderTripContexts(); mapview.draw({ fit: true }); }
  if (topic === "vehicles") renderVehicleLine();
  if (topic === "config") renderStatusPill();
  // Wache scharf + mindestens eine aktive Zone: die grüne Live-LED der
  // Reise blinkt zusätzlich rot (siehe renderTripContextButton), damit auf
  // einen Blick erkennbar ist, dass das Fahrzeug gerade überwacht wird.
  if (topic === "guard") {
    renderTripContexts();
    // Der überwachte Bereich als Kreis auf der Karte — nur solange scharf.
    mapview.setGuardZone(state.guardArmed && state.guardAnchor && state.guardZoneRadius
      ? { lat: state.guardAnchor.lat, lon: state.guardAnchor.lon, radiusM: state.guardZoneRadius }
      : null);
  }
});

renderVehicleLine();
renderStatusPill();
renderMetricButtons();
renderLayerSwitches();
renderTripContexts();
go("reise");

/* ---------- Anmeldung ---------- */
const gate = $("#gate");
// "login" | "setup" | "forgot" — steuert, welche Felder das Gate zeigt.
let gateModus = "login";

const GATE_TEXTE = {
  login: { titel: "Anmelden", sub: "Melde dich an, um deine Reisen und Orte zu sehen.", knopf: "Anmelden" },
  setup: { titel: "Konto anlegen", sub: "Noch kein Konto vorhanden. Lege eines an — es gilt dann auf allen Geräten.", knopf: "Konto anlegen" },
  forgot: { titel: "Passwort vergessen", sub: "Gib deinen Benutzernamen ein — falls eine E-Mail hinterlegt ist, bekommst du einen Link.", knopf: "Link senden" },
};

function anwendenGateModus() {
  const t = GATE_TEXTE[gateModus];
  $("#gate-title").textContent = t.titel;
  $("#gate-sub").textContent = t.sub;
  $("#gate-submit").textContent = t.knopf;
  $("#gate-password-wrap").hidden = gateModus === "forgot";
  $("#gate-repeat-wrap").hidden = gateModus !== "setup";
  $("#gate-email-wrap").hidden = gateModus !== "setup";
  $("#gate-password").setAttribute("autocomplete", gateModus === "login" ? "current-password" : "new-password");
  // Vor Kontoanlage ergibt "Passwort vergessen" keinen Sinn — es gibt ja noch keins.
  $("#gate-forgot").hidden = gateModus === "setup";
  $("#gate-forgot").textContent = gateModus === "forgot" ? "Zurück zur Anmeldung" : "Passwort vergessen?";
}

function zeigeGate(einrichtung) {
  gateModus = einrichtung ? "setup" : "login";
  anwendenGateModus();
  gate.hidden = false;
  setTimeout(() => $("#gate-user").focus(), 100);
}

const gateFehler = (text) => {
  const box = $("#gate-error");
  box.textContent = text;
  box.hidden = !text;
};
const gateInfo = (text) => {
  const box = $("#gate-info");
  box.textContent = text;
  box.hidden = !text;
};

$("#gate-forgot").addEventListener("click", () => {
  gateModus = gateModus === "forgot" ? "login" : "forgot";
  gateFehler(""); gateInfo("");
  anwendenGateModus();
});

async function gateAbsenden() {
  const benutzer = $("#gate-user").value.trim();
  const passwort = $("#gate-password").value;
  gateFehler(""); gateInfo("");

  if (gateModus === "setup" && passwort !== $("#gate-repeat").value) {
    gateFehler("Die beiden Passwörter stimmen nicht überein.");
    return;
  }
  const knopf = $("#gate-submit");
  knopf.disabled = true;
  try {
    if (gateModus === "forgot") {
      const antwort = await forgotPassword(benutzer);
      gateInfo(antwort.message || "Falls das Konto existiert, wurde ein Link verschickt.");
      return;
    }
    let angelegtMitEmail = false;
    if (gateModus === "setup") {
      const email = $("#gate-email").value.trim();
      const antwort = await setupAccount(benutzer, passwort, email || undefined);
      angelegtMitEmail = Boolean(antwort?.emailPending);
    } else {
      await anmelden(benutzer, passwort);
    }
    setAngemeldet(true);
    // Nicht nur den eingegebenen Namen übernehmen, sondern den vollen
    // Kontostand nachladen — sonst geht eine schon hinterlegte E-Mail in
    // der Anzeige verloren (state.account würde sie sonst überschreiben).
    const zustand = await authState();
    state.account = { username: zustand.username, email: zustand.email, emailVerified: zustand.emailVerified, isAdmin: Boolean(zustand.isAdmin) };
    state.config.demo = false;
    saveConfig();
    gate.hidden = true;
    refreshAccountState();
    await starteDaten();
    if (angelegtMitEmail) toast("Konto angelegt — Bestätigungslink an deine E-Mail verschickt");
  } catch (err) {
    gateFehler(err.message || "Das hat nicht geklappt");
  } finally {
    knopf.disabled = false;
  }
}

// Tippfehler im Passwort sieht man sonst nicht — besonders ärgerlich beim
// Anlegen, wo ein Vertipper das Konto unbrauchbar macht.
$("#gate-eye").addEventListener("click", () => {
  const felder = [$("#gate-password"), $("#gate-repeat")];
  const zeigen = felder[0].type === "password";
  felder.forEach((f) => { f.type = zeigen ? "text" : "password"; });
  $("#gate-eye").textContent = zeigen ? "verbergen" : "anzeigen";
});

$("#gate-submit").addEventListener("click", gateAbsenden);
for (const feld of ["gate-user", "gate-password", "gate-repeat", "gate-email"]) {
  $("#" + feld).addEventListener("keydown", (e) => { if (e.key === "Enter") gateAbsenden(); });
}
$("#gate-demo").addEventListener("click", () => {
  state.config.demo = true;
  saveConfig();
  gate.hidden = true;
  starteDaten();
});

/* ---------- Neues Passwort per Mail-Link setzen ---------- */
const resetGate = $("#reset-gate");
const resetToken = new URLSearchParams(location.search).get("reset");

if (resetToken) {
  // Der Link steht nur einmal in der Adresszeile — danach raus damit, sonst
  // bliebe er im Verlauf/Lesezeichen liegen.
  history.replaceState({}, "", location.pathname);
  resetGate.hidden = false;

  $("#reset-eye").addEventListener("click", () => {
    const felder = [$("#reset-password"), $("#reset-repeat")];
    const zeigen = felder[0].type === "password";
    felder.forEach((f) => { f.type = zeigen ? "text" : "password"; });
    $("#reset-eye").textContent = zeigen ? "verbergen" : "anzeigen";
  });

  const resetFehler = (text) => {
    const box = $("#reset-error");
    box.textContent = text;
    box.hidden = !text;
  };

  async function resetAbsenden() {
    const passwort = $("#reset-password").value;
    resetFehler("");
    if (passwort.length < 10) { resetFehler("Das Passwort braucht mindestens 10 Zeichen."); return; }
    if (passwort !== $("#reset-repeat").value) { resetFehler("Die beiden Passwörter stimmen nicht überein."); return; }

    const knopf = $("#reset-submit");
    knopf.disabled = true;
    try {
      await resetPassword(resetToken, passwort);
      setAngemeldet(true);
      // Wie beim Login: den vollen Kontostand nachladen, sonst verschwindet
      // eine schon hinterlegte E-Mail aus der Anzeige.
      const zustand = await authState();
      state.account = { username: zustand.username, email: zustand.email, emailVerified: zustand.emailVerified, isAdmin: Boolean(zustand.isAdmin) };
      state.config.demo = false;
      saveConfig();
      resetGate.hidden = true;
      refreshAccountState();
      toast("Neues Passwort gesetzt — du bist angemeldet");
      await starteDaten();
    } catch (err) {
      resetFehler(err.message || "Das hat nicht geklappt");
    } finally {
      knopf.disabled = false;
    }
  }
  $("#reset-submit").addEventListener("click", resetAbsenden);
  for (const feld of ["reset-password", "reset-repeat"]) {
    $("#" + feld).addEventListener("keydown", (e) => { if (e.key === "Enter") resetAbsenden(); });
  }
}

/* ---------- E-Mail über Link aus der Bestätigungsmail bestätigen ----------
   Braucht anders als der Reset-Link keine Eingabe — der Besitz des Links
   reicht. Deshalb kein eigener Bildschirm, nur eine stille Bestätigung
   plus Rückmeldung per Toast. */
const verifyToken = resetToken ? null : new URLSearchParams(location.search).get("verify");
if (verifyToken) {
  history.replaceState({}, "", location.pathname);
  verifyEmail(verifyToken)
    .then(() => {
      // Falls schon angemeldet, sofort in der Anzeige nachziehen.
      if (state.account) { state.account = { ...state.account, emailVerified: true }; refreshAccountState(); }
      toast("E-Mail bestätigt");
    })
    .catch((err) => toast(err.message || "Bestätigungslink ungültig oder abgelaufen"));
}

async function starteDaten() {
  await loadData();
  if (!state.config.demo) await loadLivePosition();
  renderTrips();
  renderLogbookPlacesIfOpen();
  renderCategoryPicker();
  renderVehicles();      // Einstellungen kennen die Daten erst jetzt
  renderCategories();
  renderVehicleLine();
  renderStatusBar();
  renderJournal();
  refreshAccountState();
  renderTripContexts();
  renderMapFocusBar();
  mapview.draw({ fit: true });
  loadGuard(); // erst hier bekannt: state.account (Admin?) und state.config.demo endgültig gesetzt
}

/* ---------- Gast-Ansicht über einen Freigabe-Link (/share/<token>) ----------
   Bewusst ein eigener, schmaler Startpfad statt Wiederverwendung von
   starteDaten(): loadData()/loadLivePosition() usw. sind eng an das
   angemeldete Konto gebunden (Automatik-Import, Geräte-Einstellungen,
   Sitzung). Die Render-Funktionen selbst (renderTrips, renderJournal, die
   Karte) sind unverändert dieselben wie im Eigentümer-Betrieb — siehe
   guest.js für die Datenseite. */
const gastMatch = location.pathname.match(/^\/share\/([^/?#]+)/);
const gastToken = gastMatch ? decodeURIComponent(gastMatch[1]) : null;

async function starteGastDaten() {
  renderTrips();
  renderLogbookPlacesIfOpen();
  renderStatusBar();
  renderJournal();
  renderTripContexts();
  renderMapFocusBar();
  mapview.draw({ fit: true });
}

if (gastToken) {
  if ($("#log-add")) $("#log-add").hidden = true;
  // Kein Bearbeiten irgendwo — die ganze Verwaltung (Suche, Filter,
  // Kategorien, Bearbeiten-Knöpfe pro Ort) ist reine Eigentümer-Funktion.
  if ($(".places-fold")) $(".places-fold").hidden = true;
  const vehline = $("#vehline");
  vehline.textContent = "Gast-Ansicht";
  vehline.classList.remove("hidden");
  starteGastAnsicht(gastToken)
    .then((antwort) => {
      // "Mehr" bietet Gästen nichts (keine Einstellungen, kein Bearbeiten) —
      // Platz in der Leiste bleibt, wirkt aber inaktiv, ohne Beschriftung.
      sperreTab("mehr", { ohneBeschriftung: true });
      // "Reisen" nur bei Freigabe auf alle Reisen — bei einer einzelnen
      // geteilten Reise zeigt die Karte sie direkt, ein Wechsel ergäbe
      // keinen Sinn.
      if (!antwort.alleReisen) sperreTab("reise");
      if (antwort.label) vehline.textContent = `Gast-Ansicht · ${antwort.label}`;
      go("map");
      return starteGastDaten();
    })
    .catch((err) => {
      sperreTab("reise");
      sperreTab("logbuch");
      sperreTab("mehr", { ohneBeschriftung: true });
      vehline.textContent = "Link ungültig";
      toast(err.message || "Dieser Link ist ungültig, abgelaufen oder wurde widerrufen.");
    });

  // Wie im Eigentümer-Betrieb: Position häufig, volle Route seltener.
  setInterval(() => {
    if (document.hidden) return;
    const t = state.trips.find((tr) => tr.id === state.mapTripId);
    if (t) ladeGastLivePosition(t);
  }, 30000);
  setInterval(() => {
    if (document.hidden) return;
    const t = state.trips.find((tr) => tr.id === state.mapTripId);
    if (t) ladeGastRoute(t);
  }, 5 * 60 * 1000);
} else {
  /* Beim Start klären: Konto vorhanden? Angemeldet? */
  authState()
    .then((zustand) => {
      setAngemeldet(Boolean(zustand.angemeldet));
      if (zustand.angemeldet) {
        state.account = { username: zustand.username, email: zustand.email, emailVerified: zustand.emailVerified, isAdmin: Boolean(zustand.isAdmin) };
        return starteDaten();
      }
      // Nicht angemeldet: Beispieldaten zeigen, Anmeldung davor legen —
      // außer gerade läuft schon eine Passwort-Vergessen-Rücksetzung.
      state.config.demo = true;
      if (!resetToken) zeigeGate(!zustand.eingerichtet);
      return starteDaten();
    })
    .catch(() => {
      // API nicht erreichbar — die App läuft trotzdem mit Beispieldaten.
      state.config.demo = true;
      starteDaten();
    });

  // Im Live-Betrieb die Fahrzeugposition regelmäßig auffrischen — aber nur,
  // solange das Fenster sichtbar ist, damit im Hintergrund nichts läuft.
  setInterval(() => {
    if (document.hidden || state.config.demo) return;
    loadLivePosition();
  }, 30000);
}

// Die eingezeichnete Strecke wuchs bisher nur beim ersten Öffnen — während
// der Fahrt blieb sie stehen. Regelmäßig die Spur der laufenden Reise neu
// holen, damit sie mitwächst; ohne Neueinpassen, siehe "tripPath" oben.
//
// Echter Fund (17. August 2026): Mit `if (document.hidden) return;` allein
// lief der Intervall zwar alle 2 Minuten an, übersprang den Abruf aber
// jedes Mal, wenn der Bildschirm gerade aus/die App im Hintergrund war —
// der Timer selbst lief unbeirrt weiter, nur eben ohne Wirkung. War der
// Bildschirm z. B. 12 Minuten aus, blieb die Strecke bis zum nächsten
// sichtbaren Tick entsprechend länger als die nominalen 2 (vorher 5)
// Minuten zurück. Der zusätzliche "visibilitychange"-Aufruf unten holt das
// sofort nach, sobald die App wieder sichtbar wird, statt bis zum nächsten
// Tick zu warten — ohne dafür im Hintergrund häufiger pollen zu müssen.
function aktualisiereLaufendeSpur() {
  if (document.hidden || state.config.demo || gastToken) return;
  const t = activeTrip();
  if (t) ensureTripPath(t, { force: true, silent: true });
  aktualisiereFahrtenWennAlt();
}

// Die Fahrtenliste bestimmt, welche Teile der Spur als Etappe gezeichnet werden.
// Sie wurde bisher nur beim Start geladen, die Spur aber alle 2 Minuten — das
// jüngste Stück der Strecke fehlte dann auf der Karte (Nutzerfund, 24. Oktober 2026).
// Deshalb bei laufender Reise leise alle 10 Minuten (und beim Zurückkehren in die
// App) mit auffrischen; scheitert das, bleibt die bisherige Liste stehen.
const FAHRTEN_MAX_ALTER_MS = 10 * 60 * 1000;
let fahrtenGeladenUm = Date.now();
function aktualisiereFahrtenWennAlt() {
  if (state.config.demo || gastToken || !activeTrip()) return;
  if (Date.now() - fahrtenGeladenUm < FAHRTEN_MAX_ALTER_MS) return;
  fahrtenGeladenUm = Date.now();
  loadDrives({ silent: true });
}
setInterval(aktualisiereLaufendeSpur, 2 * 60 * 1000);
// Zusätzlich zur laufenden Reise (oben) beim Zurückkommen aus dem
// Hintergrund auch Position/Route der gerade gezeigten Kartenreise
// auffrischen (Eigentümer wie Gast, siehe aktualisiereKarteJetzt oben) —
// so ist die Karte sofort aktuell, sobald man wieder hinschaut, ganz ohne
// im Hintergrund selbst pollen zu müssen (das würde der Browser bei einer
// gesperrten/weggewechselten Seite ohnehin meist unterbinden).
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  aktualisiereLaufendeSpur();
  aktualisiereKarteJetzt();
});
