// The map, built on MapLibre GL with OSM tiles (CARTO rendering).
// The route is drawn in two layers: a stable single-colour line below and the
// colour gradient on top, so the route stays visible when MapLibre splits the
// gradient at tile borders at some zoom levels.
// MapLibre is loaded as a separate library file (it brings its own web worker),
// so there is deliberately no bundle import here. UI texts stay German.
const gl = () => window.maplibregl;
import { state, mapTrip, tripPlaces, tripNotes, category, nightNumber, isRangeTrip, rangeTrips } from "./state.js";
import { colorFor, legendFor } from "./colors.js";
import { bounds, elevationRange, pathLengthKm, pointAtKm, kmMarkerStep, simplify, routeHits, sameSpot, metersPerPixel } from "./geo.js";
import { CARTO_KEY, tilePaint, tileUrl, validMapStyle, hillshadePaint, ELEVATION_TILES, ELEVATION_ATTRIBUTION } from "./map-style.js";
import { routeSignature } from "./map-signature.js";
import { findRepeatedStretches, lineWidth } from "./overlap.js";
import { findGaps, distanceToSegment, durationText } from "./gaps.js";
import { tipEntries, nearestHit } from "./route-tip.js";
import { el, clear, $ } from "./dom.js";
import { debugLog } from "./debug.js";
import { itemMatchesRouteFilter, visibleRouteSegments } from "./route-visibility.js";

// CARTO needs a (free) API key for its tile service — without it only "API KEY
// REQUIRED" watermarks appear (https://carto.com/basemaps/apikey/). The key is
// set at build time from CARTO_API_KEY (see scripts/build-site.mjs and README)
// and is then visible in the tile URL of the shipped app, as intended.
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
        "tiles-light": { type: "raster", tiles: [tileUrl(state.config.mapStyle, CARTO_KEY)], tileSize: 256, attribution: ATTRIBUTION },
        dem: { type: "raster-dem", tiles: [ELEVATION_TILES], tileSize: 256, encoding: "terrarium", maxzoom: 14, attribution: ELEVATION_ATTRIBUTION },
        "route-solid": {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
          tolerance: 0,
          buffer: 512,
          maxzoom: 24,
        },
        // Stretches driven more than once (out and back): nested over the route, see overlap.js
        "route-repeated": { type: "geojson", data: { type: "FeatureCollection", features: [] }, tolerance: 0, buffer: 512, maxzoom: 24 },
        // Recording gaps (the tracker delivered nothing in between): dashed over the joining line, see gaps.js
        "route-gaps": { type: "geojson", data: { type: "FeatureCollection", features: [] }, tolerance: 0, buffer: 512, maxzoom: 24 },
      },
      layers: [
        { id: "tiles-light", type: "raster", source: "tiles-light", paint: tilePaint(isDark(), state.config.mapStyle) },
        // Terrain shading: only visible when switched on in the layer menu
        // (only then are the elevation tiles loaded at all).
        { id: "hillshade", type: "hillshade", source: "dem",
          layout: { visibility: state.config.terrain ? "visible" : "none" }, paint: hillshadePaint(isDark()) },
        { id: "route-casing", type: "line", source: "route-solid",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": isDark() ? "#000" : "#0a1919", "line-opacity": 0.35, "line-width": 9 } },
        { id: "route-backfill", type: "line", source: "route-solid",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#e8802b", "line-opacity": 0.86, "line-width": 5 } },
        { id: "route-repeated", type: "line", source: "route-repeated",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": ["get", "c"], "line-width": ["get", "w"] } },
        { id: "route-gaps", type: "line", source: "route-gaps",
          layout: { "line-cap": "butt", "line-join": "round", visibility: state.config.markGaps ? "visible" : "none" },
          paint: { "line-color": "#ffffff", "line-opacity": 0.92, "line-width": 5, "line-dasharray": [1, 1.4] } },
        // No static gradient layer here — one is created per visible segment
        // (see drawGradientSegments() below). Reason: MapLibre's line-gradient
        // computes line-progress PER FEATURE (0..1 over the length of THAT
        // feature), not over the whole FeatureCollection. A single shared
        // gradient layer over several line segments (created as soon as a filter
        // or a gap — e.g. an overnight stay — splits the route) put colours in
        // the wrong place: the long first segment got the colour of the day
        // AFTER next at its own end, while a short late segment got the whole
        // gradient squeezed into its length (seen 1 September 2026, the first
        // multi-day trip with a real gap).
      ],
    },
    center: [10.4, 47.5],
    zoom: 8,
    attributionControl: { compact: true },
  });

  // resize() has been a no-op until now (ready was still false) — the container
  // may have changed size meanwhile (e.g. when jumping to the map right at start,
  // as in the guest view). So do it once before drawing, otherwise the canvas
  // keeps its original size.
  const markReady = () => { if (ready) return; ready = true; map.resize(); draw({ fit: true }); };
  map.on("load", markReady);
  map.once("idle", markReady);

  // Apply theme changes (system or switch) to the tiles
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  map.on("click", onMapClick);

  return map;
}

/** Switch the map style (Settings → Appearance): other tiles, matching colour values. */
export function setMapStyle(style) {
  if (!map || !ready) return;
  map.getSource("tiles-light").setTiles([tileUrl(validMapStyle(style), CARTO_KEY)]);
  applyTheme();
}

/** Switch marking of recording gaps on or off (Settings → Appearance); off by default. */
export function setGaps(on) {
  if (!map) return;
  if (map.getLayer("route-gaps")) map.setLayoutProperty("route-gaps", "visibility", on ? "visible" : "none");
  if (!on) closeRouteTip();
}

/** Switch terrain shading on or off (layer menu). */
export function setTerrain(on) {
  if (!map || !map.getLayer("hillshade")) return;
  map.setLayoutProperty("hillshade", "visibility", on ? "visible" : "none");
}

function applyTheme() {
  if (!ready) return;
  const dark = isDark();
  for (const [k, v] of Object.entries(tilePaint(dark, state.config.mapStyle))) map.setPaintProperty("tiles-light", k, v);
  for (const [k, v] of Object.entries(hillshadePaint(dark))) map.setPaintProperty("hillshade", k, v);
  map.setPaintProperty("route-casing", "line-color", dark ? "#000" : "#0a1919");
}

/* ---------- Tapping the route: day, date, time, km ---------- */
let tipPath = [];     // full (not simplified) visible path of the drawn trip
let tipPopup = null;
let tipDot = null;
const TIP_TOLERANCE_PX = 22;
const TIP_MIN_M = 12;

function closeRouteTip() {
  tipPopup?.remove();
  tipDot?.remove();
  tipPopup = null;
  tipDot = null;
}

function onMapClick(e) {
  closeRouteTip();
  if (!tipPath.length) return;
  const { lng, lat } = e.lngLat;
  const tolerance = Math.max(TIP_MIN_M, TIP_TOLERANCE_PX * metersPerPixel(map.getZoom(), lat));
  // When the same road was driven more than once (out and back) there are several
  // passes at the spot — all are shown, not only the nearest. At a wide zoom only
  // those that really lie at the same spot (otherwise hits from kilometres around).
  const hits = sameSpot(routeHits(tipPath, lng, lat, tolerance));
  if (!hits.length) { showGapTip(lng, lat, tolerance); return; }
  const anchor = nearestHit(hits).point;
  const { entries, more } = tipEntries(hits);
  const content = el("div.rt-liste", {}, [
    ...entries.map((entry) => el("div.rt", {}, [
      ...(entry.title ? [el("small", { text: entry.title })] : []),
      el("b", { text: entry.heading }),
      el("div", { text: entry.values }),
    ])),
    ...(more ? [el("small.rt-mehr", { text: `+ ${more} weitere` })] : []),
  ]);
  tipDot = new (gl().Marker)({ element: el("div.route-dot") }).setLngLat([anchor.lon, anchor.lat]).addTo(map);
  tipPopup = new (gl().Popup)({ closeButton: false, closeOnClick: true, maxWidth: "260px", offset: 14, className: "route-tip" })
    .setLngLat([anchor.lon, anchor.lat])
    .setDOMContent(content)
    .addTo(map);
  tipPopup.on("close", () => { tipDot?.remove(); tipDot = null; });
  debugLog("map.route-tip", { passes: hits.length, distanceM: Math.round(nearestHit(hits).distanceM) });
}

/** Tap on a recording gap (the dashed joining line): says that nothing was measured there. */
function showGapTip(lng, lat, tolerance) {
  if (!state.config.markGaps) return;
  let near = null;
  for (const g of tipGaps) {
    const d = distanceToSegment(lng, lat, g.from, g.to);
    if (d <= tolerance && (!near || d < near.d)) near = { d, g };
  }
  if (!near) return;
  const { g } = near;
  const clock = (iso) => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const day = new Date(g.from.time).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
  const middle = { lon: (g.from.lon + g.to.lon) / 2, lat: (g.from.lat + g.to.lat) / 2 };
  const content = el("div.rt-liste", {}, [el("div.rt", {}, [
    el("small", { text: "Datenlücke" }),
    el("b", { text: `${day} · ${clock(g.from.time)}–${clock(g.to.time)}` }),
    el("div", { text: `${durationText(g.seconds)} ohne Messung · ${g.meters.toLocaleString("de-DE")} m Luftlinie` }),
    el("small.rt-mehr", { text: "Die Linie verbindet hier nur die Punkte davor und danach." }),
  ])]);
  tipDot = new (gl().Marker)({ element: el("div.route-dot") }).setLngLat([middle.lon, middle.lat]).addTo(map);
  tipPopup = new (gl().Popup)({ closeButton: false, closeOnClick: true, maxWidth: "260px", offset: 14, className: "route-tip" })
    .setLngLat([middle.lon, middle.lat])
    .setDOMContent(content)
    .addTo(map);
  tipPopup.on("close", () => { tipDot?.remove(); tipDot = null; });
}

let pendingDraw = false;

function visibleRouteForMap(t) {
  const realTrip = state.trips.some((trip) => trip.id === t?.id);
  // A thinned path restored from the snapshot ("coarse") does not fit the time
  // spans of the drives (short drives would have no points left) — show it
  // without the drive filter until a real download succeeded.
  const segments = realTrip && !t.pathCoarse
    ? visibleRouteSegments(t.path || [], state.drives, t.id, state.routeDriveFilter, { openEnd: Boolean(t.live) })
    : visibleRouteSegments(t.path || [], [], t?.id, "alle");
  return { segments, path: segments.flat() };
}

// Draw a simplified line (see simplify() in geo.js): tens of thousands of points
// per line overwhelm phone graphics. Statistics, markers and legend keep using
// the full path (`path`).
const DRAW_TOLERANCE_M = 3;
const forDrawing = (segments) => segments.map((s) => simplify(s, DRAW_TOLERANCE_M));

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
 * One MapLibre layer (and source) per visible segment, EACH with its own gradient
 * expression for exactly THIS segment (gradientFor() computes line-progress
 * locally, 0..1 over the length of the segment — see the comment in initMap()).
 * Layers left over from a previous draw with more segments are removed.
 */
let gradientLayerIds = [];
function clearGradientLayers() {
  for (const { source, layer } of gradientLayerIds) {
    if (map.getLayer(layer)) map.removeLayer(layer);
    if (map.getSource(source)) map.removeSource(source);
  }
  gradientLayerIds = [];
}
// Existing gradient layers are updated instead of removed and created again:
// in between only the orange base line would be visible (the flicker across the
// whole route when opening the map).
function drawGradientSegments(segments, metric, ctx) {
  const lines = segments.filter((segment) => segment.length > 1);
  lines.forEach((segment, i) => {
    const sourceId = `route-grad-${i}`;
    const layerId = `route-grad-layer-${i}`;
    const data = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: segment.map((p) => [p.lon, p.lat]) } };
    const gradient = gradientFor(segment, metric, ctx);
    const source = map.getSource(sourceId);
    if (source && map.getLayer(layerId)) {
      source.setData(data);
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
  // Remove surplus layers (fewer line pieces than before).
  for (let i = lines.length; i < gradientLayerIds.length; i++) {
    const { source, layer } = gradientLayerIds[i];
    if (map.getLayer(layer)) map.removeLayer(layer);
    if (map.getSource(source)) map.removeSource(source);
  }
  gradientLayerIds.length = lines.length;
}

/**
 * Lay stretches driven more than once nested over the route: the earliest drive
 * wide, every later one narrower on top — so every day's colour is visible at any
 * zoom instead of the last drive hiding the others. Only where the colour marks
 * the drive (trip day, trip); for speed/elevation/distance nesting would only be
 * a thicker line.
 */
function drawRepeated(segments, metric, ctx) {
  const source = map.getSource("route-repeated");
  if (!source) return;
  const data = { type: "FeatureCollection", features: [] };
  if (metric === "day" || metric === "trip") {
    data.features = findRepeatedStretches(segments).map((run) => ({
      type: "Feature",
      properties: { c: colorFor(run.point, metric, ctx), w: lineWidth(run.rank, run.count) },
      geometry: { type: "LineString", coordinates: run.coords },
    }));
  }
  source.setData(data);
  // Above the gradient layers, which may have been created anew.
  if (map.getLayer("route-repeated")) map.moveLayer("route-repeated");
}

/**
 * Lay recording gaps (more than 40 s without a point and more than 500 m apart)
 * dashed over the joining line: that stretch was not driven but only joined in a
 * straight line. Uses the full points (not the simplified drawing), because only
 * they know the times.
 */
let tipGaps = [];
function drawGaps(segments) {
  const source = map.getSource("route-gaps");
  if (!source) return;
  tipGaps = findGaps(segments);
  source.setData({
    type: "FeatureCollection",
    features: tipGaps.map((g) => ({
      type: "Feature", properties: {},
      geometry: { type: "LineString", coordinates: [[g.from.lon, g.from.lat], [g.to.lon, g.to.lat]] },
    })),
  });
  if (map.getLayer("route-gaps")) map.moveLayer("route-gaps");
}

/* ---------- Guard: the watched area as a circle ---------- */
let guardZone = null; // { lat, lon, radiusM } or null
const GUARD_SOURCE = "guard-zone";

function circlePolygon(lat, lon, radiusM, steps = 64) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const w = (i / steps) * 2 * Math.PI;
    ring.push([lon + dLon * Math.cos(w), lat + dLat * Math.sin(w)]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
}

function applyGuardZone() {
  if (!map || !map.isStyleLoaded()) return;
  const data = guardZone
    ? circlePolygon(guardZone.lat, guardZone.lon, guardZone.radiusM)
    : { type: "FeatureCollection", features: [] };
  const source = map.getSource(GUARD_SOURCE);
  if (source) { source.setData(data); return; }
  map.addSource(GUARD_SOURCE, { type: "geojson", data });
  map.addLayer({ id: "guard-zone-fill", type: "fill", source: GUARD_SOURCE, paint: { "fill-color": "#d84a4a", "fill-opacity": 0.12 } });
  map.addLayer({ id: "guard-zone-line", type: "line", source: GUARD_SOURCE, paint: { "line-color": "#d84a4a", "line-width": 2, "line-dasharray": [2, 2] } });
}

/** Draw the guard's watched area (or remove it with null). If the map is not
 * ready yet, draw() catches up on the next draw. */
export function setGuardZone(zone) {
  guardZone = zone;
  applyGuardZone();
}

// On start, snapshot, trips, drives and route arrive one after the other and each
// triggers a draw. Requests close together are merged into one (fit wins as soon
// as one asks for it).
const DRAW_DEBOUNCE_MS = 80;
let drawTimer = null;
let drawOptions = {};
let lastSignature = null;

/** Draws route, markers and legend of the currently chosen trip. */
export function draw(options = {}) {
  drawOptions = { ...drawOptions, ...options, fit: Boolean(drawOptions.fit || options.fit) };
  if (drawTimer) return;
  drawTimer = setTimeout(() => {
    drawTimer = null;
    const o = drawOptions;
    drawOptions = {};
    drawNow(o);
  }, DRAW_DEBOUNCE_MS);
}

function drawNow(options = {}) {
  const { fit = false } = options;
  if (!map) return;
  // Not ready to draw yet? Catch up once as soon as the map is idle.
  if (!map.isStyleLoaded()) {
    debugLog("map.draw.bail", { reason: "not-style-loaded", pendingDraw });
    if (!pendingDraw) {
      pendingDraw = true;
      map.once("idle", () => { pendingDraw = false; draw(options); });
      // Safety net: "idle" rarely never comes (e.g. when tiles are blocked for
      // good, never failing and never arriving) — then there would never be
      // another attempt. Try again after a few seconds.
      setTimeout(() => { if (pendingDraw) { pendingDraw = false; draw(options); } }, 4000);
    }
    return;
  }
  applyGuardZone();
  const t = mapTrip();
  // No trip (or no route for it yet)? Then the map simply shows where the vehicle
  // is — the most useful view without a trip.
  if (!t || !t.path?.length) { drawLiveOnly({ fit }); return; }

  const { segments, path } = visibleRouteForMap(t);
  if (!path.length) { drawLiveOnly({ fit }); return; }
  tipPath = path;
  if (fit) closeRouteTip();

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

  const drawSegments = forDrawing(segments);
  const signature = routeSignature(t.id, drawSegments, state.metric, ctx);
  const lineCount = drawSegments.filter((s) => s.length > 1).length;
  const redrawn = !(signature === lastSignature && gradientLayerIds.length === lineCount);
  if (redrawn) {
    map.getSource("route-solid").setData(routeDataFromSegments(drawSegments));
    drawGradientSegments(drawSegments, state.metric, ctx);
    drawRepeated(drawSegments, state.metric, ctx);
    drawGaps(segments);
    lastSignature = signature;
  }
  debugLog("map.draw", {
    redrawn,
    tripId: t.id, pathPoints: path.length, drawnPoints: drawSegments.reduce((n, s) => n + s.length, 0), hiddenDetours: Math.max(0, t.path.length - path.length),
    visibleSegments: gradientLayerIds.length, totalKm, zoom: ready ? map.getZoom() : null, fit,
  });

  drawMarkers(t, totalKm, path);
  drawLegend(legendFor(state.metric, ctx));
  if (fit) fitTrip();
}

/** View without a trip: only the vehicle's current position. */
let liveCentered = false;
function drawLiveOnly({ fit = false } = {}) {
  lastSignature = null;
  tipPath = [];
  closeRouteTip();
  clearGradientLayers();
  map.getSource("route-solid").setData({ type: "FeatureCollection", features: [] });
  map.getSource("route-repeated")?.setData({ type: "FeatureCollection", features: [] });
  map.getSource("route-gaps")?.setData({ type: "FeatureCollection", features: [] });
  tipGaps = [];
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

  // Only move there the first time (or when asked) — otherwise the map would
  // jump away on every refresh.
  if (!liveCentered || fit) {
    // Deliberately without animation: the target may be far away, and a jump
    // is more reliable than a flight across the map.
    map.jumpTo({ center: [pos.lon, pos.lat], zoom: liveCentered ? Math.max(map.getZoom(), 13) : 13 });
    liveCentered = true;
  }
}

/**
 * `path` is always ONE visible segment here (see drawGradientSegments()), never
 * the whole trip. MapLibre's line-progress is 0..1 per feature over the length of
 * THAT feature — so the position of every colour stop must be LOCAL to this
 * segment (start = 0, end = 1), not to the whole trip. The colour itself still
 * comes from colorFor() with the GLOBAL ctx (day, speed, elevation, distance stay
 * placed correctly across the whole trip — only WHERE on the line the value sits
 * is computed locally).
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
  const realTrip = state.trips.some((trip) => trip.id === t?.id);
  const routeFilter = realTrip ? state.routeDriveFilter : "alle";

  // Start
  marker(el("div.marker.marker-endpoint", { text: "▲", title: "Start" }), visiblePath[0].lon, visiblePath[0].lat);

  // Places and overnight stays
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

  // Notes — their own layer, switchable independently of places
  if (state.layers.notes) {
    for (const n of tripNotes(t.id).filter((note) => itemMatchesRouteFilter(note, state.drives, t.id, routeFilter))) {
      const node = el("div.marker.marker-note", { text: "✎", title: (n.title || n.text || "Notiz").slice(0, 60) });
      node.addEventListener("click", (ev) => { ev.stopPropagation(); onNoteClick(n); });
      marker(node, n.lon, n.lat);
    }
  }

  // Kilometre markers
  if (state.layers.km && totalKm > 20) {
    const step = kmMarkerStep(totalKm);
    for (let km = step; km < totalKm; km += step) {
      const pt = pointAtKm(visiblePath, km);
      marker(el("div.marker.marker-km", { text: String(Math.round(km)) }), pt.lon, pt.lat);
    }
  }

  // End: the live vehicle or the finish flag.
  // Seen 17 August 2026: for a running trip the 🚐 sat at the END of the
  // (filtered!) route instead of the actual position — state.livePosition is
  // refreshed every 30 s, the route only every 2 minutes (see main.js), AND
  // visiblePath is cut by the stage/detour filter. If the latest stretch was a
  // detour (and the filter showed only stages), the vehicle stuck at an old
  // position. Now a running trip uses state.livePosition; the route's end is
  // only the fallback while no live position is known.
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
  // "none" (single-colour route) has no scale to explain.
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
  const visible = visibleRouteForMap(t).path;
  const b = bounds(visible.length ? visible : t.path);
  // maxZoom used to be 13 — fine for a multi-day trip, but a small trip (a short
  // outing of a few hundred metres or kilometres) stayed tiny in an otherwise
  // empty map. 16 zooms small trips in properly and stays below the level where
  // the tiles (OSM/CARTO) get blurry or empty.
  map.fitBounds([[b.minLon, b.minLat], [b.maxLon, b.maxLat]], { padding: { top: 120, right: 48, bottom: 64, left: 48 }, duration: 600, maxZoom: 16 });
}

export const resetLiveCentering = () => { liveCentered = false; };

export const zoomIn = () => ready && map.zoomIn();
export const zoomOut = () => ready && map.zoomOut();
export const resize = () => ready && map.resize();

/** Current map centre — the reference point for entering a place by hand. */
export const center = () => (ready ? map.getCenter() : { lng: 10.4, lat: 47.5 });

/** Centre on a single point, e.g. "Auf Karte zeigen" from the place editor —
 * unlike fitTrip() (whole trip/route) this is exactly one spot, no bounds. */
export function focusOn(lat, lon, { zoom } = {}) {
  if (!ready || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  map.flyTo({ center: [lon, lat], zoom: zoom ?? Math.max(map.getZoom(), 15), duration: 600 });
}
