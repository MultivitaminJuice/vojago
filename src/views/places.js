// Ansicht „Orte": Suche, Filter (Reise, Quelle, Umkreis), Liste, Erfassen.
import { el, render, icon, toast, $ } from "../dom.js";
import { ICON } from "../icons.js";
import { state, category, placeCounts, newId, trip } from "../state.js";
import { wetterZeile } from "../store.js";
import { teileOrt } from "../ui/share.js";
import { distanceKm } from "../geo.js";

const SOURCE_LABEL = { camper: "🚐 Camper", handy: "🚶 Handy", manuell: "📍 manuell" };

let openEditor = () => {};
let mapCenter = () => ({ lng: 10.4, lat: 47.5 });

export function initPlaces({ onEdit, getMapCenter }) {
  openEditor = onEdit;
  if (getMapCenter) mapCenter = getMapCenter;

  const search = $("#place-search");
  search.addEventListener("input", () => { state.filters.text = search.value.trim().toLowerCase(); renderPlaces(); });

  wireSelect("#f-trip", "trip");
  wireSelect("#f-source", "source");
  wireSelect("#f-ref", "ref", "none");
  wireSelect("#f-radius", "radius", 0, Number);

  $("#filter-reset").addEventListener("click", resetPlaceFilters);

  $("#add-here").addEventListener("click", () => addPlace("handy"));

  buildFilterOptions();
  renderCategoryChips();
  renderPlaces();
}

/** Auch von main.js genutzt: erneuter Klick auf den "Logbuch"-Tab, während
 * man schon dort ist, setzt die Orte-Filter auf die Standardansicht zurück
 * (wie der "Filter zurücksetzen"-Knopf) statt einfach nichts zu tun. */
export function resetPlaceFilters() {
  state.filters = { text: "", cats: {}, trip: "", source: "", ref: "none", radius: 0 };
  const search = $("#place-search");
  if (search) search.value = "";
  for (const [sel, val] of [["#f-trip", ""], ["#f-source", ""], ["#f-ref", "none"], ["#f-radius", "0"]]) {
    const node = $(sel);
    if (!node) continue;
    node.value = val;
    node.classList.remove("on");
  }
  renderCategoryChips();
  renderPlaces();
}

function wireSelect(sel, key, emptyValue = "", cast = String) {
  const node = $(sel);
  node.addEventListener("change", () => {
    state.filters[key] = cast(node.value);
    node.classList.toggle("on", node.value !== String(emptyValue));
    renderPlaces();
  });
}

export function buildFilterOptions() {
  const option = (value, label) => el("option", { value, text: label });

  render($("#f-trip"), [option("", "Alle Reisen"), ...state.trips.map((t) => option(t.id, t.name))]);
  render($("#f-source"), [option("", "Alle Quellen"), option("camper", "🚐 Camper"), option("handy", "🚶 Handy"), option("manuell", "📍 manuell")]);
  render($("#f-radius"), [option("0", "jede Entfernung"), option("25", "≤ 25 km"), option("100", "≤ 100 km"), option("300", "≤ 300 km")]);

  const refSelect = $("#f-ref");
  const previous = state.filters.ref;
  render(refSelect, [
    option("none", "Umkreis: aus"),
    option("center", "ab 📍 Kartenmitte"),
    option("camper", "ab 🚐 Camper"),
    ...state.places.map((p) => option("p:" + p.id, "ab: " + p.title)),
  ]);
  refSelect.value = Array.from(refSelect.options).some((o) => o.value === previous) ? previous : "none";
  if (refSelect.value === "none") state.filters.ref = "none";
}

/** Bezugspunkt für die Umkreissuche. */
function referencePoint() {
  const { ref } = state.filters;
  if (ref === "none") return null;
  if (ref === "center") { const c = mapCenter(); return { lon: c.lng, lat: c.lat, name: "Kartenmitte" }; }
  if (ref === "camper") {
    const t = state.trips.find((x) => x.live) || state.trips[0];
    const last = t?.path?.[t.path.length - 1];
    return last ? { lon: last.lon, lat: last.lat, name: "Camper" } : null;
  }
  const place = state.places.find((p) => p.id === ref.slice(2));
  return place ? { lon: place.lon, lat: place.lat, name: place.title } : null;
}

const filtersActive = () => {
  const f = state.filters;
  return Boolean(f.text || Object.keys(f.cats).length || f.trip || f.source || f.ref !== "none");
};

function matches(place, ref) {
  const f = state.filters;
  if (f.text && !`${place.title} ${place.note}`.toLowerCase().includes(f.text)) return false;
  if (Object.keys(f.cats).length && !f.cats[place.catId]) return false;
  if (f.trip && place.tripId !== f.trip) return false;
  if (f.source && place.source !== f.source) return false;
  if (ref && f.radius > 0 && distanceKm(ref.lon, ref.lat, place.lon, place.lat) > f.radius) return false;
  return true;
}

export function renderCategoryChips() {
  const counts = placeCounts();
  render($("#catchips"), Object.entries(state.categories).map(([id, cat]) => {
    const chip = el("button.chip" + (state.filters.cats[id] ? ".active" : ""), {
      dataset: { cat: id },
      on: { click: () => {
        if (state.filters.cats[id]) delete state.filters.cats[id];
        else state.filters.cats[id] = true;
        chip.classList.toggle("active");
        renderPlaces();
      } },
    }, [el("i", { style: { background: cat.color } }), cat.name, " ", el("b", { text: String(counts[id] || 0) })]);
    return chip;
  }));
}

export function renderPlaces() {
  const ref = referencePoint();
  const list = state.places.filter((p) => matches(p, ref));
  if (ref) list.sort((a, b) => distanceKm(ref.lon, ref.lat, a.lon, a.lat) - distanceKm(ref.lon, ref.lat, b.lon, b.lat));

  $("#result-count").textContent = `· ${list.length}${list.length === state.places.length ? "" : ` von ${state.places.length}`}`;
  $("#filter-reset").hidden = !filtersActive();

  const container = $("#place-list");
  if (!list.length) {
    render(container, el("div.callout", { text: "Keine Orte gefunden – Filter anpassen oder zurücksetzen." }));
    return;
  }

  render(container, list.map((p) => {
    const cat = category(p.catId);
    const tripName = p.tripId && trip(p.tripId) ? trip(p.tripId).name : "Alltag";
    const dist = ref ? distanceKm(ref.lon, ref.lat, p.lon, p.lat) : null;

    return el("div.place", { style: { borderLeftColor: cat.color } }, [
      el("div.photo", { style: { background: photoGradient(p.hue) } }),
      el("div.body", {}, [
        el("div.row1", {}, [el("b", { text: p.title || "(ohne Titel)" }), el("span.tag", { text: cat.name })]),
        el("div.meta2", {}, [
          el("span.mbadge", { text: SOURCE_LABEL[p.source] || SOURCE_LABEL.camper }),
          el("span.mbadge", { text: tripName }),
          p.weather ? el("span.mbadge", { text: wetterZeile(p.weather) }) : null,
          dist != null ? el("span.mbadge.dist", { text: `${dist < 10 ? dist.toFixed(1) : Math.round(dist)} km` }) : null,
        ]),
        el("p", { text: p.note }),
        el("div.foot", {}, [
          el("span.stars", {}, ["★".repeat(p.stars), el("span", { text: "★".repeat(5 - p.stars), style: { color: "var(--ink-faint)" } })]),
          el("span.coords", { text: p.date || "" }),
          el("span.mini-acts", {}, [
            el("button", { title: "Bearbeiten", on: { click: () => openEditor(p) } }, icon(ICON.edit, 14)),
            el("button", { title: "Teilen", on: { click: () => teileOrt(p) } }, icon(ICON.share, 14)),
          ]),
        ]),
      ]),
    ]);
  }));
}

export const photoGradient = (hue) =>
  `radial-gradient(circle at 74% 30%, rgba(255,244,214,.95), rgba(255,244,214,0) 20%),` +
  `linear-gradient(180deg, hsl(${hue},68%,68%) 0%, hsl(${hue + 18},55%,82%) 52%, hsl(120,34%,52%) 52%, hsl(122,38%,38%) 100%)`;

/** Neuen Ort erfassen — per Gerätestandort oder über die Kartenmitte. */
function addPlace(source) {
  const finish = (lon, lat, note) => {
    openEditor({
      id: newId("place"), tripId: state.mapTripId || state.activeTripId, catId: source === "handy" ? "restaurant" : "sehenswuerdigkeit",
      title: "", note: "", stars: 4, date: "heute", at: new Date().toISOString(), lon, lat, source,
      hue: source === "handy" ? 15 : 210, isNew: true,
    });
    if (note) toast(note);
  };

  if (source === "handy" && navigator.geolocation) {
    toast("Standort wird ermittelt …");
    navigator.geolocation.getCurrentPosition(
      (pos) => finish(pos.coords.longitude, pos.coords.latitude, "Koordinaten vom Gerät übernommen"),
      () => { const c = mapCenter(); finish(c.lng, c.lat, "Kein Gerätestandort – Kartenmitte übernommen"); },
      { enableHighAccuracy: true, timeout: 8000 }
    );
    return;
  }

  const c = mapCenter();
  finish(c.lng, c.lat, "Kartenmitte übernommen – Karte vorher passend schieben");
}
