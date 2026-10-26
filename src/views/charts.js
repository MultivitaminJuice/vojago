// Kleine SVG-Darstellungen: Routen-Vorschau, Höhenprofil, Geschwindigkeit.
import { bounds } from "../geo.js";

const NS = "http://www.w3.org/2000/svg";
const svgEl = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

/** Vorschau einer Route, eingepasst in w × h. */
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
  const Y = (lat) => oy + (b.maxLat - lat) * scale; // Norden oben

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
 * Gemeinsamer Aufbau für Höhenprofil/Geschwindigkeit: gefüllte Kurve +
 * Spannweiten-Beschriftung oben links (z. B. "412–798 m", wie die
 * Höhenmeter-Marke beim Vorbild-Konkurrenten) + Antippen/Ziehen zeigt den
 * genauen Wert an der berührten Stelle (Fadenkreuz-Linie, Punkt,
 * Wert-Chip) — dieselbe Idee wie die Klick-auf-die-Karte-Werte des
 * Vorbilds, nur auf die Kurve selbst bezogen statt auf die farbige Route.
 * `rangeMode: "zero"` (Geschwindigkeit) skaliert immer ab 0, nicht ab dem
 * Minimum — 0 km/h ist ein echter, aussagekräftiger Wert, anders als bei
 * der Höhe, wo der niedrigste gemessene Punkt keine besondere Bedeutung hat.
 */
const MAX_PUNKTE = 400;

/**
 * Skala für ein Balkendiagramm: der höchste Wert wird auf einen "runden" Schritt
 * (1, 2 oder 5 mal Zehnerpotenz) aufgerundet, damit die Achse z. B. 0 · 200 · 400 · 600
 * zeigt und der höchste Balken nicht an der Oberkante klebt.
 */
export function skala(max, ziele = 3) {
  if (!(max > 0) || !Number.isFinite(max)) return { max: 1, schritt: 1, ticks: [0, 1] };
  const roh = max / ziele;
  const potenz = 10 ** Math.floor(Math.log10(roh));
  const f = roh / potenz;
  const schritt = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * potenz;
  const oben = Math.ceil(max / schritt - 1e-9) * schritt;
  const ticks = [];
  for (let v = 0; v <= oben + schritt / 2; v += schritt) ticks.push(Math.round(v * 1e6) / 1e6);
  return { max: oben, schritt, ticks };
}

/** Auf höchstens `n` Punkte verkleinern: Mittelwert je gleich großem Abschnitt. */
export function zusammenfassen(werte, n) {
  if (werte.length <= n) return werte;
  const out = [];
  for (let i = 0; i < n; i++) {
    const von = Math.floor((i * werte.length) / n);
    const bis = Math.max(von + 1, Math.floor(((i + 1) * werte.length) / n));
    let summe = 0;
    for (let j = von; j < bis; j++) summe += werte[j];
    out.push(summe / (bis - von));
  }
  return out;
}

function profileChart(path, w, h, { valueOf, rangeMode = "minmax", color, format }) {
  // Die Kurve wird auf die Kartenbreite gedehnt (preserveAspectRatio "none"),
  // alles mit Schrift oder runder Form liegt deshalb als normales HTML DARÜBER
  // — im gedehnten SVG wurden Beschriftung, Punkt und Wert-Chip mitverzerrt
  // (Nutzerfund, 15. Oktober 2026).
  const wrap = document.createElement("div");
  wrap.className = "profile-wrap";
  const svg = svgEl("svg", { class: "profile", viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none" });
  wrap.appendChild(svg);
  if (!path?.length) return wrap;
  const pad = 4;
  // Oben Platz für die Spannen-Beschriftung, damit die Kurve nie hineinragt.
  const obenFrei = 18;

  // Skala und Beschriftung kommen aus den ECHTEN Werten (Höchst-/Tiefstwert
  // bleiben wahr), gezeichnet wird eine zusammengefasste Reihe.
  const werte = path.map(valueOf);
  let min, max;
  if (rangeMode === "zero") {
    min = 0;
    max = 1;
    for (const v of werte) if (v > max) max = v; // Schleife statt Math.max(...werte): bei sehr langen Reisen sprengt das Spread das Argument-Limit
  } else {
    min = Infinity; max = -Infinity;
    for (const v of werte) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (max - min < 1) max = min + 1;
  }

  // Eine Fahrt hat zigtausend Messpunkte (echte Reise: ~60 000), die Karte nur
  // einige hundert Pixel Breite — jeder Ausschlag wurde als eigener Strich
  // gezeichnet, die Kurve wirkte wie ein unruhiger Block (Nutzerwunsch,
  // 15. Oktober 2026). Mittelwert je Abschnitt: ruhig, wahrheitsgetreu im
  // Verlauf; kurze Spitzen werden geglättet, der Chip beim Antippen zeigt
  // entsprechend den Mittelwert der berührten Stelle.
  const reihe = zusammenfassen(werte, MAX_PUNKTE);

  const pts = reihe.map((v, i) => ({
    x: pad + (i / Math.max(1, reihe.length - 1)) * (w - 2 * pad),
    y: h - pad - ((v - min) / (max - min)) * (h - pad - obenFrei),
    v,
  }));

  const d = "M" + pts.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" L");
  svg.appendChild(svgEl("path", { d: `${d} L${w - pad},${h - pad} L${pad},${h - pad} Z`, fill: color, opacity: ".14" }));
  // non-scaling-stroke: gleichmäßig dünne Linie, unabhängig von der Dehnung.
  svg.appendChild(svgEl("path", {
    d, fill: "none", stroke: color, "stroke-width": 1.5, "stroke-linejoin": "round",
    "vector-effect": "non-scaling-stroke",
  }));

  const spanne = document.createElement("div");
  spanne.className = "profile-range";
  spanne.style.color = color;
  spanne.textContent = rangeMode === "zero" ? format(max) : `${format(min)}–${format(max)}`;
  wrap.appendChild(spanne);

  // Antippen/Ziehen: nächsten Punkt zur berührten Stelle finden, Marker
  // + Wert-Chip zeigen. pointerdown/-move deckt Maus UND Touch gleich mit
  // ab (Touch löst dieselben Pointer-Events aus); bleibt nach Loslassen
  // stehen, bis anderswo getippt wird — bei Touch wäre "verschwindet
  // sofort beim Loslassen" nutzlos, das ist ja schon fast dasselbe wie der
  // Tipp selbst.
  const guide = svgEl("line", {
    y1: obenFrei, y2: h - pad, stroke: color, "stroke-width": 1, "stroke-dasharray": "2,2", opacity: 0,
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

  const zeige = (clientX) => {
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
    // Breite erst nach dem Setzen des Textes messbar; am Rand einklemmen.
    const chipW = chip.offsetWidth;
    chip.style.left = `${Math.min(Math.max(px - chipW / 2, 0), Math.max(0, rect.width - chipW))}px`;
    chip.style.top = `${Math.max(py - 26, 0)}px`;
  };
  const verbergen = () => {
    guide.setAttribute("opacity", "0"); dot.style.opacity = "0"; chip.style.opacity = "0";
  };

  overlay.addEventListener("pointerdown", (e) => zeige(e.clientX));
  overlay.addEventListener("pointermove", (e) => { if (e.buttons === 1) zeige(e.clientX); });
  overlay.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") verbergen(); });

  return wrap;
}

const formatHoehe = (v) => `${Math.round(v)} m`;
const formatTempo = (v) => `${Math.round(v)} km/h`;

/** Höhenprofil einer Route. */
export function elevationProfile(path, w = 320, h = 84) {
  return profileChart(path, w, h, { valueOf: (p) => p.elev, rangeMode: "minmax", color: "var(--accent)", format: formatHoehe });
}

/** Geschwindigkeitsverlauf einer Route (km/h über die Positionen hinweg).
 * Eigene Akzentfarbe (--indigo), damit beide Kurven im selben Kartenstapel
 * klar auseinanderzuhalten sind. */
export function speedProfile(path, w = 320, h = 84) {
  return profileChart(path, w, h, { valueOf: (p) => p.spd || 0, rangeMode: "zero", color: "var(--indigo)", format: formatTempo });
}
