// Small SVG charts: route preview, elevation profile, speed.
import { bounds } from "../geo.js";

const NS = "http://www.w3.org/2000/svg";
const svgEl = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

/** Preview of a route, fitted into w × h. */
export function miniRoute(trip, w, h) {
  const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "xMidYMid meet" });
  svg.appendChild(svgEl("rect", { x: 0, y: 0, width: w, height: h, fill: "var(--map-terrain)" }));

  const path = trip.path;
  if (!path?.length) return svg;

  const b = bounds(path);
  const pad = 8;
  const spanLon = Math.max(b.maxLon - b.minLon, 1e-6);
  const spanLat = Math.max(b.maxLat - b.minLat, 1e-6);
  const scale = Math.min((w - 2 * pad) / spanLon, (h - 2 * pad) / spanLat);
  const ox = pad + ((w - 2 * pad) - spanLon * scale) / 2;
  const oy = pad + ((h - 2 * pad) - spanLat * scale) / 2;
  const X = (lon) => ox + (lon - b.minLon) * scale;
  const Y = (lat) => oy + (b.maxLat - lat) * scale; // north up

  const d = "M" + path.map((p) => `${X(p.lon).toFixed(1)},${Y(p.lat).toFixed(1)}`).join(" L");
  svg.appendChild(svgEl("path", {
    d, fill: "none", stroke: `hsl(${trip.hue},70%,52%)`,
    "stroke-width": w > 120 ? 3 : 2, "stroke-linecap": "round", "stroke-linejoin": "round",
  }));

  const first = path[0], last = path[path.length - 1];
  const r = w > 120 ? 4 : 2.6;
  svg.appendChild(svgEl("circle", { cx: X(first.lon), cy: Y(first.lat), r, fill: "var(--ink)" }));
  svg.appendChild(svgEl("circle", { cx: X(last.lon), cy: Y(last.lat), r, fill: trip.live ? "var(--accent)" : "var(--ink)" }));
  return svg;
}

/**
 * Shared layout for the elevation and speed profiles: a filled curve, the range
 * label at the top left (e.g. "412–798 m"), and tapping or dragging shows the
 * exact value at the touched spot (guide line, dot, value chip).
 * `rangeMode: "zero"` (speed) always scales from 0, not from the minimum —
 * 0 km/h is a real, telling value, unlike elevation, where the lowest measured
 * point has no special meaning.
 */
const MAX_POINTS = 400;

/**
 * Scale for a bar chart: the highest value is rounded up to a "round" step
 * (1, 2 or 5 times a power of ten), so the axis shows e.g. 0 · 200 · 400 · 600
 * and the highest bar does not stick to the top.
 */
export function niceScale(max, targetTicks = 3) {
  if (!(max > 0) || !Number.isFinite(max)) return { max: 1, step: 1, ticks: [0, 1] };
  const raw = max / targetTicks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const f = raw / power;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * power;
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { max: top, step, ticks };
}

/** Reduce to at most `n` points: the mean of each equally sized section. */
export function downsample(values, n) {
  if (values.length <= n) return values;
  const out = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * values.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / n));
    let sum = 0;
    for (let j = from; j < to; j++) sum += values[j];
    out.push(sum / (to - from));
  }
  return out;
}

function profileChart(path, w, h, { valueOf, rangeMode = "minmax", color, format }) {
  // The curve is stretched to the card width (preserveAspectRatio "none"), so
  // everything with text or a round shape lies on top as plain HTML — inside the
  // stretched SVG, label, dot and value chip were distorted (seen 15 October 2026).
  const wrap = document.createElement("div");
  wrap.className = "profile-wrap";
  const svg = svgEl("svg", { class: "profile", viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none" });
  wrap.appendChild(svg);
  if (!path?.length) return wrap;
  const pad = 4;
  // Room at the top for the range label, so the curve never reaches into it.
  const topSpace = 18;

  // Scale and label come from the REAL values (highest and lowest stay true);
  // a downsampled series is drawn.
  const values = path.map(valueOf);
  let min, max;
  if (rangeMode === "zero") {
    min = 0;
    max = 1;
    for (const v of values) if (v > max) max = v; // a loop instead of Math.max(...values): on very long trips the spread exceeds the argument limit
  } else {
    min = Infinity; max = -Infinity;
    for (const v of values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (max - min < 1) max = min + 1;
  }

  // A trip has tens of thousands of points, the card only a few hundred pixels —
  // every swing was drawn as its own stroke and the curve looked like a restless
  // block (15 October 2026). The mean per section is calm and true to the course;
  // short peaks are smoothed, and the chip shows the mean at the touched spot.
  const series = downsample(values, MAX_POINTS);

  const pts = series.map((v, i) => ({
    x: pad + (i / Math.max(1, series.length - 1)) * (w - 2 * pad),
    y: h - pad - ((v - min) / (max - min)) * (h - pad - topSpace),
    v,
  }));

  const d = "M" + pts.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" L");
  svg.appendChild(svgEl("path", { d: `${d} L${w - pad},${h - pad} L${pad},${h - pad} Z`, fill: color, opacity: ".14" }));
  // non-scaling-stroke: an evenly thin line, whatever the stretch.
  svg.appendChild(svgEl("path", {
    d, fill: "none", stroke: color, "stroke-width": 1.5, "stroke-linejoin": "round",
    "vector-effect": "non-scaling-stroke",
  }));

  const range = document.createElement("div");
  range.className = "profile-range";
  range.style.color = color;
  range.textContent = rangeMode === "zero" ? format(max) : `${format(min)}–${format(max)}`;
  wrap.appendChild(range);

  // Tap or drag: find the point nearest to the touched spot, show the marker and
  // the value chip. pointerdown/-move covers mouse AND touch; it stays after
  // releasing until a tap elsewhere — on touch, "disappears on release" would be
  // useless.
  const guide = svgEl("line", {
    y1: topSpace, y2: h - pad, stroke: color, "stroke-width": 1, "stroke-dasharray": "2,2", opacity: 0,
    "vector-effect": "non-scaling-stroke",
  });
  const dot = document.createElement("div");
  dot.className = "profile-dot";
  dot.style.background = color;
  const chip = document.createElement("div");
  chip.className = "profile-chip";
  chip.style.background = color;
  const overlay = svgEl("rect", { x: 0, y: 0, width: w, height: h, fill: "transparent", style: "cursor:crosshair;touch-action:none" });
  svg.append(guide, overlay);
  wrap.append(dot, chip);

  const show = (clientX) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const relX = ((clientX - rect.left) / rect.width) * w;
    let nearest = pts[0], best = Infinity;
    for (const pt of pts) {
      const dist = Math.abs(pt.x - relX);
      if (dist < best) { best = dist; nearest = pt; }
    }
    guide.setAttribute("x1", nearest.x); guide.setAttribute("x2", nearest.x); guide.setAttribute("opacity", "1");

    const px = (nearest.x / w) * rect.width;
    const py = (nearest.y / h) * rect.height;
    dot.style.left = `${px}px`; dot.style.top = `${py}px`; dot.style.opacity = "1";

    chip.textContent = format(nearest.v);
    chip.style.opacity = "1";
    // The width can only be measured after setting the text; clamp at the edges.
    const chipW = chip.offsetWidth;
    chip.style.left = `${Math.min(Math.max(px - chipW / 2, 0), Math.max(0, rect.width - chipW))}px`;
    chip.style.top = `${Math.max(py - 26, 0)}px`;
  };
  const hide = () => {
    guide.setAttribute("opacity", "0"); dot.style.opacity = "0"; chip.style.opacity = "0";
  };

  overlay.addEventListener("pointerdown", (e) => show(e.clientX));
  overlay.addEventListener("pointermove", (e) => { if (e.buttons === 1) show(e.clientX); });
  overlay.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });

  return wrap;
}

const formatElevation = (v) => `${Math.round(v)} m`;
const formatSpeed = (v) => `${Math.round(v)} km/h`;

/** Elevation profile of a route. */
export function elevationProfile(path, w = 320, h = 84) {
  return profileChart(path, w, h, { valueOf: (p) => p.elev, rangeMode: "minmax", color: "var(--accent)", format: formatElevation });
}

/** Speed profile of a route (km/h along the positions). Its own accent colour
 * (--indigo), so both curves are easy to tell apart in the same card stack. */
export function speedProfile(path, w = 320, h = 84) {
  return profileChart(path, w, h, { valueOf: (p) => p.spd || 0, rangeMode: "zero", color: "var(--indigo)", format: formatSpeed });
}
