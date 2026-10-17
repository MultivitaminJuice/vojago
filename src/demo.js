// Beispieldaten mit echten Koordinaten. Sie füllen dieselben Strukturen,
// die später aus der eigenen API kommen.
import { state } from "./state.js";
import { buildPath, pathLengthKm, elevationRange } from "./geo.js";
import { DEMO_ROADS } from "./demo-roads.js";

const CATEGORIES = {
  uebernachtung: { name: "Übernachtung", color: "#4b47a8" },
  stellplatz: { name: "Stellplatz", color: "#e8802b" },
  wild: { name: "Wildcamping", color: "#3f9d5a" },
  versorgung: { name: "Ver-/Entsorgung", color: "#3b82c4" },
  aussicht: { name: "Aussicht", color: "#7a5cd6" },
  restaurant: { name: "Restaurant", color: "#b5476b" },
  sehenswuerdigkeit: { name: "Sehenswürdigkeit", color: "#caa23a" },
  werkstatt: { name: "Werkstatt", color: "#d84a4a" },
  einkauf: { name: "Einkauf", color: "#1f9e8f" },
};

// Stützpunkte: lon, lat, Höhe (m), Tempo (km/h); `night` beendet einen Reisetag.
export const ROUTES = {
  alpen: [
    { lon: 10.317, lat: 47.727, elev: 674, spd: 0 },   // Kempten – Start
    { lon: 10.556, lat: 47.648, elev: 780, spd: 62 },
    { lon: 10.700, lat: 47.571, elev: 808, spd: 44, night: true }, // Forggensee
    { lon: 10.717, lat: 47.489, elev: 854, spd: 58 },  // Reutte
    { lon: 10.833, lat: 47.360, elev: 1216, spd: 46 }, // Fernpass
    { lon: 10.905, lat: 47.230, elev: 1380, spd: 38, night: true }, // Ötztal
    { lon: 10.740, lat: 47.239, elev: 828, spd: 64 },  // Imst
    { lon: 10.567, lat: 47.139, elev: 816, spd: 70, night: true }, // Landeck
    { lon: 10.213, lat: 47.129, elev: 1304, spd: 48 }, // Arlberg
    { lon: 9.748, lat: 47.503, elev: 400, spd: 52 },   // Bodensee – aktuell
  ],
  nordkap: [
    { lon: 23.271, lat: 69.968, elev: 20, spd: 0 },    // Alta
    { lon: 24.150, lat: 70.180, elev: 180, spd: 78 },
    { lon: 24.990, lat: 70.500, elev: 90, spd: 72, night: true }, // Olderfjord
    { lon: 25.480, lat: 70.760, elev: 240, spd: 68 },
    { lon: 25.970, lat: 70.982, elev: 40, spd: 56, night: true }, // Honningsvåg
    { lon: 25.784, lat: 71.170, elev: 307, spd: 44 },  // Nordkapp
  ],
  toskana: [
    { lon: 11.255, lat: 43.770, elev: 50, spd: 0 },    // Florenz
    { lon: 11.330, lat: 43.480, elev: 320, spd: 64 },
    { lon: 11.331, lat: 43.318, elev: 322, spd: 58, night: true }, // Siena
    { lon: 11.620, lat: 43.060, elev: 400, spd: 52 },  // Val d'Orcia
    { lon: 11.113, lat: 42.760, elev: 10, spd: 70 },   // Grosseto
    { lon: 10.600, lat: 43.260, elev: 8, spd: 66, night: true },  // Bibbona
    { lon: 10.401, lat: 43.716, elev: 4, spd: 60 },    // Pisa
  ],
  ostsee: [
    { lon: 13.091, lat: 54.309, elev: 8, spd: 0 },     // Stralsund
    { lon: 13.420, lat: 54.360, elev: 14, spd: 62 },
    { lon: 13.612, lat: 54.401, elev: 22, spd: 48, night: true }, // Binz
    { lon: 13.432, lat: 54.679, elev: 42, spd: 54 },   // Kap Arkona
  ],
};

const TRIP_META = {
  alpen:   { name: "Alpen-Runde", dates: "seit 12. Jul · Tag 4 · unterwegs", live: true, hue: 35,
             bars: [64, 128, 0, 96, 158, 42, 128], barLabels: ["Do","Fr","Sa","So","Mo","Di","Mi"] },
  nordkap: { name: "Nordkap-Tour", dates: "3.–24. Jun 2026", live: false, hue: 205,
             bars: [210, 380, 290, 0, 410, 330, 180], barLabels: ["Mo","Di","Mi","Do","Fr","Sa","So"] },
  toskana: { name: "Toskana im Frühling", dates: "1.–14. Apr 2026", live: false, hue: 40,
             bars: [180, 240, 0, 210, 160, 300, 90], barLabels: ["Di","Mi","Do","Fr","Sa","So","Mo"] },
  ostsee:  { name: "Ostsee-Wochenende", dates: "7.–9. Mär 2026", live: false, hue: 150,
             bars: [270, 120, 150], barLabels: ["Fr","Sa","So"] },
};

// tripId, Kategorie, Titel, Notiz, Sterne, Datum, lon, lat, Quelle, Farbton, Nachtnummer, ISO-Zeitpunkt
const PLACES = [
  ["alpen", "uebernachtung", "Forggensee", "Ruhige Nacht direkt am Wasser, morgens Nebel überm See.", 5, "12.–13. Jul", 10.700, 47.571, "camper", 200, 1, "2026-07-12T18:40:00"],
  ["alpen", "uebernachtung", "Ötztal-Eingang", "Höchster Punkt der Tour. Kühl, klarer Sternenhimmel.", 4, "13.–14. Jul", 10.905, 47.230, "camper", 220, 2, "2026-07-13T19:10:00"],
  ["alpen", "uebernachtung", "Landeck Waldrand", "Frei gestanden am Waldrand, abends Rehe auf der Wiese.", 4, "14.–15. Jul", 10.567, 47.139, "camper", 130, 3, "2026-07-14T18:05:00"],
  ["alpen", "aussicht", "Aussichtskanzel Fernpass", "Traumblick ins Tal, ruhig, kein Handynetz. Perfekt für den Sonnenaufgang.", 5, "13. Jul", 10.833, 47.360, "camper", 30, null, "2026-07-13T07:20:00"],
  ["alpen", "stellplatz", "Stellplatz Reutte", "8 Euro/Nacht, Strom und Wasser, super Bäcker nebenan.", 4, "13. Jul", 10.717, 47.489, "camper", 45, null, "2026-07-13T15:30:00"],
  ["alpen", "restaurant", "Trattoria da Marco", "Vom Stellplatz 10 Min zu Fuß. Beste Pasta, günstig.", 5, "13. Jul", 10.7215, 47.4915, "handy", 15, null, "2026-07-13T19:45:00"],
  ["alpen", "sehenswuerdigkeit", "Bergkapelle St. Anna", "Kurzer Fußweg vom Stellplatz, herrlicher Blick.", 4, "14. Jul", 10.9080, 47.2325, "handy", 210, null, "2026-07-14T10:15:00"],
  ["alpen", "versorgung", "Ver-/Entsorgung Imst", "Frisch- und Grauwasser, Toilette, kostenlos.", 3, "15. Jul", 10.740, 47.239, "camper", 205, null, "2026-07-15T09:05:00"],
  ["nordkap", "uebernachtung", "Olderfjord", "Weite Bucht, Mitternachtssonne bis 2 Uhr.", 5, "6.–7. Jun", 24.990, 70.500, "camper", 205, 1, "2026-06-06T20:00:00"],
  ["nordkap", "uebernachtung", "Honningsvåg", "Karg und windig, Rentiere direkt am Bus.", 4, "9.–10. Jun", 25.970, 70.982, "camper", 220, 2, "2026-06-09T21:00:00"],
  ["nordkap", "aussicht", "Fjordblick", "Serpentinen mit spektakulärem Ausblick.", 5, "8. Jun", 25.480, 70.760, "camper", 200, null, "2026-06-08T14:00:00"],
  ["toskana", "uebernachtung", "Siena Hügeldorf", "Blick über die Crete Senesi, Zypressen.", 5, "3.–4. Apr", 11.331, 43.318, "camper", 35, 1, "2026-04-03T18:30:00"],
  ["toskana", "uebernachtung", "Küste bei Bibbona", "Strandnah, Sonnenuntergang übers Meer.", 4, "5.–6. Apr", 10.600, 43.260, "camper", 200, 2, "2026-04-05T17:50:00"],
  ["toskana", "stellplatz", "Agriturismo", "Zwischen Weinbergen, Olivenöl ab Hof.", 5, "2. Apr", 11.330, 43.480, "camper", 40, null, "2026-04-02T16:00:00"],
  ["ostsee", "uebernachtung", "Binz Hafenplatz", "Fischbrötchen direkt am Kai.", 4, "7.–8. Mär", 13.612, 54.401, "camper", 150, 1, "2026-03-07T17:20:00"],
  ["ostsee", "aussicht", "Steilküste Kap Arkona", "Kreidefelsen, ordentlich Wind.", 4, "8. Mär", 13.432, 54.679, "camper", 200, null, "2026-03-08T11:30:00"],
  ["ostsee", "restaurant", "Hafenkneipe Störtebeker", "Zu Fuß vom Hafenplatz, deftig und gut.", 4, "8. Mär", 13.6155, 54.4025, "handy", 20, null, "2026-03-08T19:15:00"],
];

// tripId, Text, ISO-Zeitpunkt, lon, lat, optional zugeordneter Ort
const NOTES = [
  ["alpen", "Losgefahren bei Nieselregen. Der Motor läuft rund, Kühlschrank auf Gas umgestellt.", "2026-07-12T09:15:00", 10.317, 47.727, null],
  ["alpen", "Erste Pause am See. Wasser eiskalt, trotzdem reingesprungen.", "2026-07-12T15:30:00", 10.700, 47.571, "place_0"],
  ["alpen", "Nachts Sternenhimmel wie selten. Kein Kunstlicht weit und breit.", "2026-07-13T23:10:00", 10.905, 47.230, null],
  ["alpen", "Serpentinen über den Pass — im zweiten Gang, aber ohne Mühe.", "2026-07-14T11:40:00", 10.833, 47.360, null],
  ["alpen", "Frischwasser aufgefüllt, Gasflasche getauscht. Alles bereit für die Rückfahrt.", "2026-07-15T09:20:00", 10.740, 47.239, "place_7"],
  ["ostsee", "Wind von vorn, Fähre schaukelt. Fischbrötchen entschädigt.", "2026-03-08T12:45:00", 13.432, 54.679, null],
];

export function loadDemoData() {
  state.categories = { ...CATEGORIES };

  state.trips = Object.keys(ROUTES).map((id) => {
    // Mit echtem Straßenverlauf (src/demo-roads.js), sonst weiche Kurve durch die Stützpunkte.
    const strasse = DEMO_ROADS[id];
    const path = strasse
      ? buildPath(strasse.map(([lon, lat, elev, spd, night]) => ({ lon, lat, elev, spd, night: night === 1 })), 1)
      : buildPath(ROUTES[id]);
    const meta = TRIP_META[id];
    return {
      id, ...meta, path,
      km: Math.round(pathLengthKm(path)),
      peak: Math.round(elevationRange(path).max),
      nights: PLACES.filter((p) => p[0] === id && p[1] === "uebernachtung").length,
    };
  });

  state.places = PLACES.map(([tripId, catId, title, note, stars, date, lon, lat, source, hue, night, at], i) => ({
    id: `place_${i}`, tripId, catId, title, note, stars, date, lon, lat, source, hue, night, at,
  }));

  state.notes = NOTES.map(([tripId, text, at, lon, lat, besuchId], i) => ({
    id: `note_${i}`, tripId, text, at, lon, lat, besuchId: besuchId || null, source: "handy",
  }));

  state.activeTripId = "alpen";
  state.mapTripId = "alpen";

  state.vehicles = [{ name: "Van", device: "RUTX50" }];

  state.guardRadius = 150;

  state.alarmTypes = [
    { name: "Bewegung außerhalb Parkmodus", info: "Fahrzeug bewegt sich, obwohl geparkt", on: true },
    { name: "Geofence verlassen", info: "Fahrzeug verlässt den überwachten Radius", on: true },
    { name: "Unterspannung", info: "Bordspannung fällt unter 12,0 V", on: true },
    { name: "Stromunterbrechung", info: "Versorgung des Trackers getrennt", on: true },
    { name: "Übergeschwindigkeit", info: "schneller als 120 km/h", on: false },
  ];

  state.alarmLog = [
    { sev: "warn", icon: "⚡", title: "Unterspannung behoben", info: "Bordspannung wieder über 12,5 V", time: "heute 06:12" },
    { sev: "crit", icon: "↗", title: "Geofence verlassen", info: "Stellplatz Reutte · Fehlalarm (Rangieren)", time: "gestern 18:44" },
    { sev: "ok", icon: "✓", title: "Wache scharf gestellt", info: "automatisch beim Parken", time: "gestern 17:30" },
  ];

  state.dailyDrives = [
    { title: "Wocheneinkauf", info: "28. Jun · Zuhause → Supermarkt", km: 12 },
    { title: "Pendeln ins Büro", info: "26. Jun · Zuhause → Arbeit", km: 34 },
    { title: "Baumarkt", info: "24. Jun · Zuhause", km: 9 },
  ];
}

/** Startroute für eine frisch begonnene Reise (kurzes Stück ab Kempten). */
export const starterPath = () =>
  buildPath([
    { lon: 10.317, lat: 47.727, elev: 674, spd: 0 },
    { lon: 10.360, lat: 47.700, elev: 690, spd: 48 },
    { lon: 10.402, lat: 47.681, elev: 712, spd: 44 },
  ]);
