// Erzeugt src/demo-roads.js: den echten Straßenverlauf der Demo-Reisen.
//
// Die Demo-Reisen (src/demo.js, ROUTES) kennen nur wenige Stützpunkte, die
// als weiche Kurve gezeichnet würden und keiner Straße folgen. Dieses Skript
// lässt einen Routing-Dienst (OSRM, öffentlicher Demo-Server) den Fahrweg durch
// genau diese Stützpunkte berechnen und legt das Ergebnis als kompakte Datei
// ab. Einmalig ausführen (braucht Internet), die erzeugte Datei wird eingecheckt:
//
//   node scripts/gen-demo-roads.mjs
//
// Straßengeometrie: © OpenStreetMap-Mitwirkende (ODbL), über OSRM.
import { writeFileSync } from "node:fs";
import { ROUTES } from "../src/demo.js";

const OSRM = "https://router.project-osrm.org/route/v1/driving";
const TOLERANZ_M = 60; // Douglas-Peucker: Linie vereinfachen, Straßenform bleibt erkennbar

const meterProGrad = 111320;
function abstandPunktLinieM(p, a, b) {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const x = (v) => v[0] * k * meterProGrad, y = (v) => v[1] * meterProGrad;
  const dx = x(b) - x(a), dy = y(b) - y(a);
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((x(p) - x(a)) * dx + (y(p) - y(a)) * dy) / len2)) : 0;
  return Math.hypot(x(p) - (x(a) + t * dx), y(p) - (y(a) + t * dy));
}
function vereinfache(punkte, toleranzM) {
  const behalten = new Array(punkte.length).fill(false);
  behalten[0] = behalten[punkte.length - 1] = true;
  const stapel = [[0, punkte.length - 1]];
  while (stapel.length) {
    const [von, bis] = stapel.pop();
    let max = 0, idx = -1;
    for (let i = von + 1; i < bis; i++) {
      const d = abstandPunktLinieM(punkte[i], punkte[von], punkte[bis]);
      if (d > max) { max = d; idx = i; }
    }
    if (max > toleranzM && idx > 0) { behalten[idx] = true; stapel.push([von, idx], [idx, bis]); }
  }
  return punkte.map((p, i) => [p, i]).filter(([, i]) => behalten[i]);
}

const ausgabe = {};
for (const [id, stuetz] of Object.entries(ROUTES)) {
  const koordinaten = stuetz.map((w) => `${w.lon},${w.lat}`).join(";");
  const antwort = await fetch(`${OSRM}/${koordinaten}?overview=full&geometries=geojson`);
  const daten = await antwort.json();
  if (daten.code !== "Ok") { console.warn(`${id}: keine Route (${daten.code}) — bleibt bei der Kurve`); continue; }
  const linie = daten.routes[0].geometry.coordinates;

  // Je Stützpunkt der nächstgelegene Punkt auf der Straße, in Fahrtrichtung.
  const bruchstellen = [];
  let ab = 0;
  for (const w of stuetz) {
    let besterIdx = ab, besterAbstand = Infinity;
    for (let i = ab; i < linie.length; i++) {
      const d = abstandPunktLinieM([w.lon, w.lat], linie[i], linie[i]);
      if (d < besterAbstand) { besterAbstand = d; besterIdx = i; }
    }
    bruchstellen.push(besterIdx);
    ab = besterIdx;
  }
  bruchstellen[0] = 0;
  bruchstellen[bruchstellen.length - 1] = linie.length - 1;

  // Vereinfachen, aber die Stützpunkte (Übernachtungen!) auf jeden Fall behalten.
  const pflicht = new Set(bruchstellen);
  const teile = [];
  const grenzen = [...pflicht].sort((a, b) => a - b);
  for (let g = 0; g < grenzen.length - 1; g++) {
    const stueck = linie.slice(grenzen[g], grenzen[g + 1] + 1);
    const einfach = vereinfache(stueck, TOLERANZ_M).map(([p]) => p);
    teile.push(...(g ? einfach.slice(1) : einfach));
  }

  // Höhe und Tempo je Punkt zwischen den Stützpunkten interpolieren, mit etwas
  // natürlicher Schwankung; "night" auf dem Punkt der Übernachtung.
  const punkte = teile;
  const indexVonStuetz = stuetz.map((w) => {
    let best = 0, bd = Infinity;
    punkte.forEach((p, i) => { const d = abstandPunktLinieM([w.lon, w.lat], p, p); if (d < bd) { bd = d; best = i; } });
    return best;
  });
  indexVonStuetz[0] = 0;
  indexVonStuetz[indexVonStuetz.length - 1] = punkte.length - 1;
  const zeilen = punkte.map((p, i) => {
    let s = 0;
    while (s < stuetz.length - 2 && i > indexVonStuetz[s + 1]) s++;
    const von = indexVonStuetz[s], bis = indexVonStuetz[s + 1];
    const t = bis > von ? (i - von) / (bis - von) : 0;
    const a = stuetz[s], b = stuetz[s + 1];
    const hoehe = a.elev + (b.elev - a.elev) * t + 18 * Math.sin(i / 5.3);
    const tempo = Math.max(0, a.spd + (b.spd - a.spd) * t + 9 * Math.sin(i / 3.1));
    const nacht = stuetz.some((w, k) => w.night && indexVonStuetz[k] === i);
    return [Number(p[0].toFixed(5)), Number(p[1].toFixed(5)), Math.round(hoehe), Math.round(tempo), nacht ? 1 : 0];
  });
  zeilen[0][3] = 0;
  ausgabe[id] = zeilen;
  console.log(`${id}: ${linie.length} Punkte -> ${zeilen.length} vereinfacht`);
}

const text = `// Erzeugt von scripts/gen-demo-roads.mjs — nicht von Hand bearbeiten.
// Straßengeometrie: © OpenStreetMap-Mitwirkende (ODbL), berechnet über OSRM.
// Je Punkt: [lon, lat, Höhe (m), Tempo (km/h), Übernachtung (1) oder 0].
export const DEMO_ROADS = ${JSON.stringify(ausgabe)};
`;
writeFileSync(new URL("../src/demo-roads.js", import.meta.url), text);
console.log("src/demo-roads.js geschrieben");
