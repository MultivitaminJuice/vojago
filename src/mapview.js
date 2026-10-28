// Echte Karte auf Basis von MapLibre GL mit OSM-Kacheln (CARTO-Rendering).
// Die Route wird zweilagig gezeichnet: eine stabile einfarbige Linie darunter
// und der farbige Verlauf darüber. So bleibt die Strecke auch dann sichtbar,
// wenn MapLibre den Verlauf bei bestimmten Zoomstufen an Tile-Grenzen zerteilt.
// MapLibre wird als eigenständige Bibliotheksdatei geladen (bringt seinen
// Web-Worker selbst mit) — deshalb hier bewusst kein Bundle-Import.
const gl = () => window.maplibregl;
import { state, mapTrip, tripPlaces, tripNotes, category, nightNumber, isRangeTrip, rangeTrips } from "./state.js";
import { colorFor, legendFor } from "./colors.js";
import { bounds, elevationRange, pathLengthKm, pointAtKm, kmMarkerStep, vereinfache, routenTreffer, gleicheStelle, meterProPixel } from "./geo.js";
import { CARTO_KEY, kachelPaint, kachelUrl, gueltigerKartenstil, schummerungPaint, HOEHEN_KACHELN, HOEHEN_QUELLE } from "./map-style.js";
import { routenSignatur } from "./map-signature.js";
import { doppeltBefahren, linienBreite } from "./overlap.js";
import { tippEintraege, naechsterTreffer } from "./route-tip.js";
import { el, clear, $ } from "./dom.js";
import { debugLog } from "./debug.js";
import { itemMatchesRouteFilter, visibleRouteSegments } from "./route-visibility.js";

// CARTO verlangt einen (kostenlosen) API-Schlüssel für den Kachel-Dienst —
// ohne ihn kommen nur "API KEY REQUIRED"-Wasserzeichen statt echter
// Kartografie (https://carto.com/basemaps/apikey/). Der Schlüssel steht
// nicht im Repository, sondern wird beim Bauen aus der Umgebungsvariable
// CARTO_API_KEY eingesetzt (siehe scripts/build-site.mjs und README). Er ist
// danach in der Kachel-URL der ausgelieferten App sichtbar — dafür ist er gedacht.
const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a>';

let map = null;
let markers = [];
let onPlaceClick = () => {};
let onNoteClick = () => {};
let ready = false;

const isDark = () => {
  const forced = document.documentElement.dataset.theme;
  if (forced) return forced === "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
};

export function initMap({ onPlaceSelect, onNoteSelect } = {}) {
  onPlaceClick = onPlaceSelect || (() => {});
  onNoteClick = onNoteSelect || (() => {});

  map = new (gl().Map)({
    container: "map",
    style: {
      version: 8,
      sources: {
        "tiles-light": { type: "raster", tiles: [kachelUrl(state.config.kartenstil, CARTO_KEY)], tileSize: 256, attribution: ATTRIBUTION },
        dem: { type: "raster-dem", tiles: [HOEHEN_KACHELN], tileSize: 256, encoding: "terrarium", maxzoom: 14, attribution: HOEHEN_QUELLE },
        "route-solid": {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
          tolerance: 0,
          buffer: 512,
          maxzoom: 24,
        },
        // Doppelt befahrene Stücke (Hin- und Rückweg): verschachtelt über der Route, siehe overlap.js
        "route-doppelt": { type: "geojson", data: { type: "FeatureCollection", features: [] }, tolerance: 0, buffer: 512, maxzoom: 24 },
      },
      layers: [
        { id: "tiles-light", type: "raster", source: "tiles-light", paint: kachelPaint(isDark(), state.config.kartenstil) },
        // Geländeschummerung: nur sichtbar, wenn im Ebenen-Menü eingeschaltet
        // (dann erst werden die Höhenkacheln überhaupt geladen).
        { id: "schummerung", type: "hillshade", source: "dem",
          layout: { visibility: state.config.gelaende ? "visible" : "none" }, paint: schummerungPaint(isDark()) },
        { id: "route-casing", type: "line", source: "route-solid",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": isDark() ? "#000" : "#0a1919", "line-opacity": 0.35, "line-width": 9 } },
        { id: "route-backfill", type: "line", source: "route-solid",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#e8802b", "line-opacity": 0.86, "line-width": 5 } },
        { id: "route-doppelt", type: "line", source: "route-doppelt",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": ["get", "c"], "line-width": ["get", "w"] } },
        // Kein statischer "route"-Verlaufslayer mehr hier — der wird pro
        // sichtbarem Segment dynamisch angelegt (siehe zeichneVerlaufsSegmente()
        // weiter unten). Grund: MapLibres line-gradient berechnet
        // line-progress JE FEATURE (0..1 über die Länge GENAU DIESES
        // Features), nicht über die ganze FeatureCollection hinweg. Ein
        // einziger geteilter Verlaufslayer über mehrere Linien-Segmente
        // (die entstehen, sobald die Route durch einen Filter oder eine
        // Lücke — z. B. eine Übernachtung — in Stücke zerfällt) griff
        // deshalb an der falschen Stelle: das lange erste Segment bekam an
        // seinem eigenen Ende schon die Farbe des ÜBERNÄCHSTEN Tages
        // aufgedrückt (sein lokales Ende las der Ausdruck als "Ende der
        // ganzen Reise"), während ein kurzes, spät gelegenes Segment den
        // kompletten Verlauf über seine viel kürzere eigene Länge gequetscht
        // bekam. Echter Fund, 1. September 2026 (erste Mehrtages-Reise mit
        // echter Lücke dazwischen) — Nutzer-Screenshot zeigte den falschen
        // Streckenabschnitt in "Tag 2"-Farbe.
      ],
    },
    center: [10.4, 47.5],
    zoom: 8,
    attributionControl: { compact: true },
  });

  // resize() ist bis hierhin ein No-op (ready war noch falsch) — der
  // Container kann sich in der Zwischenzeit schon anders bemessen haben
  // (z. B. wenn direkt beim Start zur Karte gesprungen wird, wie in der
  // Gast-Ansicht). Deshalb hier einmal nachholen, bevor gezeichnet wird —
  // sonst bleibt die Leinwand auf ihrer ursprünglichen Größe hängen.
  const markReady = () => { if (ready) return; ready = true; map.resize(); draw({ fit: true }); };
  map.on("load", markReady);
  map.once("idle", markReady);

  // Themenwechsel (System oder Umschalter) auf die Kacheln übertragen
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  map.on("click", onMapClick);

  return map;
}

/** Kartenstil wechseln (Einstellungen → Darstellung): andere Kacheln, passende Farbwerte. */
export function setKartenstil(stil) {
  if (!map || !ready) return;
  map.getSource("tiles-light").setTiles([kachelUrl(gueltigerKartenstil(stil), CARTO_KEY)]);
  applyTheme();
}

/** Geländeschummerung ein-/ausschalten (Ebenen-Menü). */
export function setTerrain(on) {
  if (!map || !map.getLayer("schummerung")) return;
  map.setLayoutProperty("schummerung", "visibility", on ? "visible" : "none");
}

function applyTheme() {
  if (!ready) return;
  const dark = isDark();
  for (const [k, v] of Object.entries(kachelPaint(dark, state.config.kartenstil))) map.setPaintProperty("tiles-light", k, v);
  for (const [k, v] of Object.entries(schummerungPaint(dark))) map.setPaintProperty("schummerung", k, v);
  map.setPaintProperty("route-casing", "line-color", dark ? "#000" : "#0a1919");
}

/* ---------- Tippen auf die Route: Tag, Datum, Uhrzeit, km ---------- */
let tippPfad = [];     // voller (nicht vereinfachter) sichtbarer Pfad der gezeichneten Reise
let tippPopup = null;
let tippPunkt = null;
const TIPP_TOLERANZ_PX = 22;
const TIPP_MIN_M = 12;

function schliesseRoutenTipp() {
  tippPopup?.remove();
  tippPunkt?.remove();
  tippPopup = null;
  tippPunkt = null;
}

function onMapClick(e) {
  schliesseRoutenTipp();
  if (!tippPfad.length) return;
  const { lng, lat } = e.lngLat;
  const toleranz = Math.max(TIPP_MIN_M, TIPP_TOLERANZ_PX * meterProPixel(map.getZoom(), lat));
  // Wurde dieselbe Strecke mehrfach befahren (Hin- und Rückweg), gibt es mehrere
  // Durchfahrten an der Stelle — alle werden gezeigt, nicht nur die nächste.
  // Bei weitem Zoom nur die, die real an derselben Stelle liegen (sonst Treffer aus Kilometern Umkreis).
  const treffer = gleicheStelle(routenTreffer(tippPfad, lng, lat, toleranz));
  if (!treffer.length) return;
  const anker = naechsterTreffer(treffer).punkt;
  const { eintraege, weitere } = tippEintraege(treffer);
  const inhalt = el("div.rt-liste", {}, [
    ...eintraege.map((eintrag) => el("div.rt", {}, [
      ...(eintrag.titel ? [el("small", { text: eintrag.titel })] : []),
      el("b", { text: eintrag.kopf }),
      el("div", { text: eintrag.werte }),
    ])),
    ...(weitere ? [el("small.rt-mehr", { text: `+ ${weitere} weitere` })] : []),
  ]);
  tippPunkt = new (gl().Marker)({ element: el("div.route-dot") }).setLngLat([anker.lon, anker.lat]).addTo(map);
  tippPopup = new (gl().Popup)({ closeButton: false, closeOnClick: true, maxWidth: "260px", offset: 14, className: "route-tip" })
    .setLngLat([anker.lon, anker.lat])
    .setDOMContent(inhalt)
    .addTo(map);
  tippPopup.on("close", () => { tippPunkt?.remove(); tippPunkt = null; });
  debugLog("map.route-tip", { durchfahrten: treffer.length, abstandM: Math.round(naechsterTreffer(treffer).abstandM) });
}

let pendingDraw = false;

function visibleRouteForMap(t) {
  const realTrip = state.trips.some((reise) => reise.id === t?.id);
  // Ein aus dem Zwischenspeicher wiederhergestellter, ausgedünnter Pfad ("grob")
  // passt nicht zu den Zeitspannen der Fahrten (kurze Fahrten hätten gar keine
  // Punkte mehr) — bis ein echter Abruf gelang, ohne Fahrtenfilter zeigen.
  const segments = realTrip && !t.pathGrob
    ? visibleRouteSegments(t.path || [], state.drives, t.id, state.routeDriveFilter, { offenesEnde: Boolean(t.live) })
    : visibleRouteSegments(t.path || [], [], t?.id, "alle");
  return { segments, path: segments.flat() };
}

// Zeichnen mit vereinfachter Linie (siehe vereinfache() in geo.js): Zehntausende
// Punkte je Linie überfordern die Grafik von Handys. Statistik, Marker und
// Legende rechnen weiter mit dem vollen Pfad (`path`).
const ZEICHEN_TOLERANZ_M = 3;
const fursZeichnen = (segments) => segments.map((s) => vereinfache(s, ZEICHEN_TOLERANZ_M));

function routeDataFromSegments(segments) {
  return {
    type: "FeatureCollection",
    features: segments
      .filter((segment) => segment.length > 1)
      .map((segment) => ({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: segment.map((p) => [p.lon, p.lat]) },
      })),
  };
}

/**
 * Ein eigener MapLibre-Layer (+eigene Quelle) je sichtbarem Segment, JEDER
 * mit seinem eigenen, auf GENAU DIESES Segment bezogenen Verlaufs-Ausdruck
 * (gradientFor() rechnet line-progress lokal, 0..1 über die Länge des
 * jeweiligen Segments — siehe Kommentar bei initMap()). Vorherige Layer
 * werden vor jedem Zeichnen komplett abgebaut: die Anzahl sichtbarer
 * Segmente ändert sich mit Filter/Reise, ein Layer pro alter Segmentzahl
 * stehen zu lassen würde verwaiste Linien hinterlassen.
 */
let gradientLayerIds = [];
function clearGradientLayers() {
  for (const { source, layer } of gradientLayerIds) {
    if (map.getLayer(layer)) map.removeLayer(layer);
    if (map.getSource(source)) map.removeSource(source);
  }
  gradientLayerIds = [];
}
// Die farbigen Verlaufsebenen werden vorhandenen Ebenen angepasst statt gelöscht
// und neu angelegt: dazwischen wäre kurz nur die orange Grundlinie zu sehen
// (das Flackern über die ganze Strecke beim Öffnen der Karte).
function zeichneVerlaufsSegmente(segments, metric, ctx) {
  const linien = segments.filter((segment) => segment.length > 1);
  linien.forEach((segment, i) => {
    const sourceId = `route-grad-${i}`;
    const layerId = `route-grad-layer-${i}`;
    const data = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: segment.map((p) => [p.lon, p.lat]) } };
    const gradient = gradientFor(segment, metric, ctx);
    const quelle = map.getSource(sourceId);
    if (quelle && map.getLayer(layerId)) {
      quelle.setData(data);
      map.setPaintProperty(layerId, "line-gradient", gradient);
      return;
    }
    map.addSource(sourceId, { type: "geojson", data, lineMetrics: true, tolerance: 0, buffer: 512, maxzoom: 24 });
    map.addLayer({
      id: layerId, type: "line", source: sourceId,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-gradient": gradient, "line-width": 5 },
    });
    gradientLayerIds[i] = { source: sourceId, layer: layerId };
  });
  // Überzählige Ebenen (weniger Linienstücke als zuvor) entfernen.
  for (let i = linien.length; i < gradientLayerIds.length; i++) {
    const { source, layer } = gradientLayerIds[i];
    if (map.getLayer(layer)) map.removeLayer(layer);
    if (map.getSource(source)) map.removeSource(source);
  }
  gradientLayerIds.length = linien.length;
}

/**
 * Doppelt befahrene Stücke verschachtelt über die Route legen: die früheste Fahrt breit,
 * jede spätere schmaler darauf — so ist an jeder Zoomstufe jede Tagesfarbe zu sehen, statt
 * dass die letzte Fahrt die anderen zudeckt. Nur wo die Farbe die Fahrt kennzeichnet
 * (Reisetag, Reise); bei Tempo/Höhe/Strecke wäre die Verschachtelung nur ein dickerer Strich.
 */
function zeichneDoppelt(segments, metric, ctx) {
  const quelle = map.getSource("route-doppelt");
  if (!quelle) return;
  const daten = { type: "FeatureCollection", features: [] };
  if (metric === "day" || metric === "trip") {
    daten.features = doppeltBefahren(segments).map((lauf) => ({
      type: "Feature",
      properties: { c: colorFor(lauf.punkt, metric, ctx), w: linienBreite(lauf.rang, lauf.anzahl) },
      geometry: { type: "LineString", coordinates: lauf.coords },
    }));
  }
  quelle.setData(daten);
  // Über den Verlaufsebenen, die bei Bedarf neu angelegt werden.
  if (map.getLayer("route-doppelt")) map.moveLayer("route-doppelt");
}

/* ---------- Wache: überwachter Bereich als Kreis ---------- */
let guardZone = null; // { lat, lon, radiusM } oder null
const GUARD_SOURCE = "guard-zone";

function kreisPolygon(lat, lon, radiusM, schritte = 64) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  const ring = [];
  for (let i = 0; i <= schritte; i++) {
    const w = (i / schritte) * 2 * Math.PI;
    ring.push([lon + dLon * Math.cos(w), lat + dLat * Math.sin(w)]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
}

function applyGuardZone() {
  if (!map || !map.isStyleLoaded()) return;
  const data = guardZone
    ? kreisPolygon(guardZone.lat, guardZone.lon, guardZone.radiusM)
    : { type: "FeatureCollection", features: [] };
  const source = map.getSource(GUARD_SOURCE);
  if (source) { source.setData(data); return; }
  map.addSource(GUARD_SOURCE, { type: "geojson", data });
  map.addLayer({ id: "guard-zone-fill", type: "fill", source: GUARD_SOURCE, paint: { "fill-color": "#d84a4a", "fill-opacity": 0.12 } });
  map.addLayer({ id: "guard-zone-line", type: "line", source: GUARD_SOURCE, paint: { "line-color": "#d84a4a", "line-width": 2, "line-dasharray": [2, 2] } });
}

/** Überwachten Bereich der Wache zeichnen (oder mit null entfernen). Ist die
 * Karte noch nicht bereit, holt draw() es beim nächsten Zeichnen nach. */
export function setGuardZone(zone) {
  guardZone = zone;
  applyGuardZone();
}

// Beim Start treffen Zwischenspeicher, Reise, Fahrten und Route der Reihe nach
// ein und lösen jeweils ein Zeichnen aus. Aufträge kurz hintereinander werden
// zu einem zusammengefasst (fit gewinnt, sobald einer es verlangt).
const ZEICHNEN_ENTPRELLEN_MS = 80;
let zeichnenTimer = null;
let zeichnenOptionen = {};
let letzteSignatur = null;

/** Zeichnet Route, Marker und Legende der aktuell gewählten Reise. */
export function draw(options = {}) {
  zeichnenOptionen = { ...zeichnenOptionen, ...options, fit: Boolean(zeichnenOptionen.fit || options.fit) };
  if (zeichnenTimer) return;
  zeichnenTimer = setTimeout(() => {
    zeichnenTimer = null;
    const o = zeichnenOptionen;
    zeichnenOptionen = {};
    zeichneJetzt(o);
  }, ZEICHNEN_ENTPRELLEN_MS);
}

function zeichneJetzt(options = {}) {
  const { fit = false } = options;
  if (!map) return;
  // Noch nicht zeichenbereit? Einmalig nachholen, sobald die Karte ruht.
  if (!map.isStyleLoaded()) {
    debugLog("map.draw.bail", { reason: "not-style-loaded", pendingDraw });
    if (!pendingDraw) {
      pendingDraw = true;
      map.once("idle", () => { pendingDraw = false; draw(options); });
      // Sicherheitsnetz: "idle" bleibt in seltenen Fällen aus (z. B. wenn
      // Kartenkacheln dauerhaft blockiert sind, nie fehlschlagen und nie
      // ankommen) — dann käme sonst nie wieder ein Zeichenversuch. Nach
      // wenigen Sekunden notfalls einfach nochmal versuchen.
      setTimeout(() => { if (pendingDraw) { pendingDraw = false; draw(options); } }, 4000);
    }
    return;
  }
  applyGuardZone();
  const t = mapTrip();
  // Keine Reise (oder noch keine Route dazu)? Dann zeigt die Karte einfach,
  // wo das Fahrzeug gerade steht — das ist ohne Reise die nützlichste Ansicht.
  if (!t || !t.path?.length) { drawLiveOnly({ fit }); return; }

  const { segments, path } = visibleRouteForMap(t);
  if (!path.length) { drawLiveOnly({ fit }); return; }
  tippPfad = path;
  if (fit) schliesseRoutenTipp();

  const { min: elevMin, max: elevMax } = elevationRange(path);
  const totalKm = pathLengthKm(path);
  const tripsInRange = isRangeTrip(t) ? rangeTrips(t.range) : [];
  const ctx = {
    elevMin,
    elevMax,
    totalKm,
    days: Math.max(...path.map((p) => p.day)),
    hue: t.hue,
    rangeMode: isRangeTrip(t),
    trips: tripsInRange,
    hasUnassignedTripPoints: isRangeTrip(t) && path.some((p) => !p.tripId),
  };

  const zeichenSegmente = fursZeichnen(segments);
  const signatur = routenSignatur(t.id, zeichenSegmente, state.metric, ctx);
  const linienAnzahl = zeichenSegmente.filter((s) => s.length > 1).length;
  const neuGezeichnet = !(signatur === letzteSignatur && gradientLayerIds.length === linienAnzahl);
  if (neuGezeichnet) {
    map.getSource("route-solid").setData(routeDataFromSegments(zeichenSegmente));
    zeichneVerlaufsSegmente(zeichenSegmente, state.metric, ctx);
    zeichneDoppelt(zeichenSegmente, state.metric, ctx);
    letzteSignatur = signatur;
  }
  debugLog("map.draw", {
    neuGezeichnet,
    tripId: t.id, pathPoints: path.length, gezeichnetePunkte: zeichenSegmente.reduce((n, s) => n + s.length, 0), hiddenDetours: Math.max(0, t.path.length - path.length),
    sichtbareSegmente: gradientLayerIds.length, totalKm, zoom: ready ? map.getZoom() : null, fit,
  });

  drawMarkers(t, totalKm, path);
  drawLegend(legendFor(state.metric, ctx));
  if (fit) fitTrip();
}

/** Ansicht ohne Reise: nur die aktuelle Fahrzeugposition. */
let liveCentered = false;
function drawLiveOnly({ fit = false } = {}) {
  letzteSignatur = null;
  tippPfad = [];
  schliesseRoutenTipp();
  clearGradientLayers();
  map.getSource("route-solid").setData({ type: "FeatureCollection", features: [] });
  map.getSource("route-doppelt")?.setData({ type: "FeatureCollection", features: [] });
  markers.forEach((m) => m.remove());
  markers = [];

  const box = $("#legend");
  const pos = state.livePosition;
  if (!pos) { if (box) box.style.display = "none"; return; }

  marker(el("div.marker.marker-live", { text: "🚐", title: "Aktuelle Position" }), pos.lon, pos.lat);

  if (box) {
    box.style.display = "";
    clear(box);
    box.appendChild(el("h4", { text: "Aktuelle Position" }));
    const when = pos.at ? new Date(pos.at) : null;
    box.appendChild(el("div.scale", {}, [
      el("span", { text: when && !Number.isNaN(when.getTime())
        ? when.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
        : "—" }),
      el("span", { text: `${pos.speed.toFixed(0)} km/h` }),
    ]));
  }

  // Nur beim ersten Mal (oder auf ausdrücklichen Wunsch) hinbewegen —
  // sonst würde die Karte bei jeder Aktualisierung wegspringen.
  if (!liveCentered || fit) {
    // Bewusst ohne Animation: das Ziel kann weit entfernt liegen, und ein
    // Sprung ist verlässlicher als ein Flug quer über die Karte.
    map.jumpTo({ center: [pos.lon, pos.lat], zoom: liveCentered ? Math.max(map.getZoom(), 13) : 13 });
    liveCentered = true;
  }
}

/**
 * `path` ist hier immer schon EIN einzelnes, sichtbares Segment (siehe
 * zeichneVerlaufsSegmente()), nie die ganze Reise. MapLibres line-progress
 * ist je Feature 0..1 über die Länge GENAU DIESES Features — die
 * Fortschritts-Position jedes Farb-Stopps muss deshalb LOKAL auf die
 * Spanne dieses Segments bezogen sein (Start=0, Ende=1), nicht auf die
 * ganze Reise. Die Farbe selbst kommt weiterhin aus colorFor() mit dem
 * GLOBALEN ctx (Tag/Tempo/Höhe/Strecke bleiben über die ganze Reise
 * hinweg korrekt eingeordnet — nur WO auf der Linie dieser Wert sitzt,
 * ist jetzt richtig lokal statt global gerechnet).
 */
function gradientFor(path, metric, ctx) {
  const expr = ["interpolate", ["linear"], ["line-progress"]];
  const maxStops = 150;
  const step = Math.max(1, Math.ceil(path.length / maxStops));
  const segStart = path[0]?.cum ?? 0;
  const segSpan = Math.max((path[path.length - 1]?.cum ?? 0) - segStart, 1e-6);
  let lastProgress = -1;
  const add = (p, index, forcedProgress = null) => {
    const raw = forcedProgress ?? (p.cum - segStart) / segSpan;
    const progress = Math.min(1, Math.max(0, raw));
    if (progress <= lastProgress && progress < 1) return;
    expr.push(progress, colorFor(p, metric, ctx));
    lastProgress = progress;
  };

  add(path[0], 0, 0);
  for (let i = step; i < path.length - 1; i += step) add(path[i], i);
  add(path[path.length - 1], path.length - 1, 1);
  return expr.length >= 7 ? expr : ["interpolate", ["linear"], ["line-progress"], 0, "#e8802b", 1, "#e8802b"];
}

function marker(node, lon, lat) {
  const m = new (gl().Marker)({ element: node }).setLngLat([lon, lat]).addTo(map);
  markers.push(m);
  return m;
}

function drawMarkers(t, totalKm, visiblePath = t.path) {
  markers.forEach((m) => m.remove());
  markers = [];
  const realTrip = state.trips.some((reise) => reise.id === t?.id);
  const routeFilter = realTrip ? state.routeDriveFilter : "alle";

  // Start
  marker(el("div.marker.marker-endpoint", { text: "▲", title: "Start" }), visiblePath[0].lon, visiblePath[0].lat);

  // Orte und Übernachtungen
  for (const p of tripPlaces(t.id).filter((place) => itemMatchesRouteFilter(place, state.drives, t.id, routeFilter))) {
    const isNight = p.catId === "uebernachtung";
    if (isNight && !state.layers.nights) continue;
    if (!isNight && !state.layers.places) continue;

    const node = isNight
      ? el("div.marker.marker-night", { text: String(nightNumber(p) ?? "•"), title: p.nights > 1 ? `${p.title} · ${p.nights} Nächte` : p.title })
      : el("div.marker.marker-place", {
          title: p.title,
          class: p.source === "handy" || p.source === "manuell" ? "foot" : "",
          text: p.source === "handy" || p.source === "manuell" ? "🚶" : "",
          style: { borderColor: category(p.catId).color },
        });
    node.addEventListener("click", (ev) => { ev.stopPropagation(); onPlaceClick(p); });
    marker(node, p.lon, p.lat);
  }

  // Notizen — eigene Ebene, unabhängig von Orten schaltbar
  if (state.layers.notes) {
    for (const n of tripNotes(t.id).filter((note) => itemMatchesRouteFilter(note, state.drives, t.id, routeFilter))) {
      const node = el("div.marker.marker-note", { text: "✎", title: (n.title || n.text || "Notiz").slice(0, 60) });
      node.addEventListener("click", (ev) => { ev.stopPropagation(); onNoteClick(n); });
      marker(node, n.lon, n.lat);
    }
  }

  // Kilometermarken
  if (state.layers.km && totalKm > 20) {
    const step = kmMarkerStep(totalKm);
    for (let km = step; km < totalKm; km += step) {
      const pt = pointAtKm(visiblePath, km);
      marker(el("div.marker.marker-km", { text: String(Math.round(km)) }), pt.lon, pt.lat);
    }
  }

  // Ende: Live-Fahrzeug oder Zielflagge.
  // Echter Fund (17. August 2026): Bei einer laufenden Reise stand das
  // 🚐-Symbol bisher am ENDE der (gefilterten!) Route statt an der
  // tatsächlich aktuellen Position — state.livePosition wird alle 30 Sek.
  // frisch abgerufen, die Route dagegen nur alle 2 Minuten (siehe
  // main.js), UND visiblePath ist zusätzlich noch durch den Etappen-/
  // Abstecher-Filter beschnitten. Fiel der jüngste Streckenabschnitt unter
  // "Abstecher" (Filter zeigt aber nur "Etappen"), blieb das Fahrzeug auf
  // der Karte an einer alten Position hängen statt an der echten. Jetzt:
  // bei einer laufenden Reise wird bevorzugt state.livePosition genommen,
  // der Routen-Endpunkt bleibt nur der Rückfallwert, solange noch keine
  // Live-Position bekannt ist.
  const live = t.live && state.livePosition;
  const last = live ? state.livePosition : visiblePath[visiblePath.length - 1];
  marker(
    t.live
      ? el("div.marker.marker-live", { text: "🚐", title: "Aktuelle Position" })
      : el("div.marker.marker-endpoint", { text: "🏁", title: "Ziel" }),
    last.lon, last.lat
  );
}

function drawLegend(legend) {
  const box = $("#legend");
  if (!box) return;
  // "none" (einfarbige Route) hat keine Skala zu erklären.
  if (!legend) { box.style.display = "none"; return; }
  box.style.display = "";
  clear(box);
  box.appendChild(el("h4", { text: legend.title }));
  if (legend.items) {
    box.appendChild(el("div.cats", {}, legend.items.map((it) =>
      el("div.cat", {}, [el("i", { style: { background: it.color } }), it.label]))));
  } else {
    box.appendChild(el("div.bar", { style: { background: legend.gradient } }));
    box.appendChild(el("div.scale", {}, legend.scale.map((v) => el("span", { text: String(v) }))));
  }
}

export function fitTrip() {
  const t = mapTrip();
  if (!ready) return;
  if (!t || !t.path?.length) { drawLiveOnly({ fit: true }); return; }
  const realTrip = state.trips.some((reise) => reise.id === t.id);
  const visible = visibleRouteForMap(t).path;
  const b = bounds(visible.length ? visible : t.path);
  // maxZoom war fest auf 13 — passend für eine mehrtägige Reise, aber für
  // eine räumlich kleine Reise (kurzer Ausflug, wenige hundert Meter/km)
  // verhinderte das ein richtiges Heranzoomen: die Reise blieb winzig in
  // einer sonst leeren Karte statt sie zu füllen. 16 lässt auch kleine
  // Reisen richtig nah heranzoomen, bleibt aber unterhalb dessen, wo die
  // Kartenkacheln (OSM/CARTO, kein eigener maxzoom gesetzt) sichtbar
  // unscharf/leer würden.
  map.fitBounds([[b.minLon, b.minLat], [b.maxLon, b.maxLat]], { padding: { top: 120, right: 48, bottom: 64, left: 48 }, duration: 600, maxZoom: 16 });
}

export const resetLiveCentering = () => { liveCentered = false; };

export const zoomIn = () => ready && map.zoomIn();
export const zoomOut = () => ready && map.zoomOut();
export const resize = () => ready && map.resize();

/** Aktuelle Kartenmitte — dient als Bezugspunkt beim manuellen Erfassen. */
export const center = () => (ready ? map.getCenter() : { lng: 10.4, lat: 47.5 });

/** Auf einen einzelnen Punkt zentrieren, z. B. "Auf Karte zeigen" aus dem
 * Orte-Editor heraus — anders als fitTrip() (ganze Reise/Route) geht es
 * hier um genau eine Stelle, ohne Bounds-Berechnung. */
export function focusOn(lat, lon, { zoom } = {}) {
  if (!ready || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  map.flyTo({ center: [lon, lat], zoom: zoom ?? Math.max(map.getZoom(), 15), duration: 600 });
}
