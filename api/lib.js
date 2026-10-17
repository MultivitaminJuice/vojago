// Prüfbare Bausteine der API — bewusst ohne Cloudflare-Abhängigkeiten,
// damit sie sich mit `node --test` prüfen lassen.

/* ---------------- Herkunft (CORS) ---------------- */

/**
 * Erlaubte Ursprünge aus der Konfiguration lesen.
 * Ohne Angabe ist keine fremde Herkunft erlaubt (die App selbst ruft
 * gleichnamig auf, Browser senden dann keinen Origin-Header).
 */
export const allowedOrigins = (env) =>
  String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const headers = {
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
  if (origin && allowedOrigins(env).includes(origin)) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

/* ---------------- Zugang ---------------- */

/** Vergleich ohne verräterische Laufzeitunterschiede. */
export function safeEqual(a, b) {
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  // Länge fließt bewusst erst am Ende ein, damit die Schleife konstant läuft.
  const len = Math.max(sa.length, sb.length);
  let diff = sa.length ^ sb.length;
  for (let i = 0; i < len; i++) {
    diff |= (sa.charCodeAt(i) || 0) ^ (sb.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/* ---------------- Eingaben prüfen ---------------- */

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
const isText = (v, max) => typeof v === "string" && v.length <= max;

/**
 * Ein client-vergebenes `id`-Feld wird ungeprüft in SQL-Parameter gebunden —
 * das ist gegen Injection sicher (parametrisierte Abfragen), aber nicht
 * gegen eine kaputte oder überlange Kennung, die später an vielen Stellen
 * (URLs, weitere Datensätze) wieder auftaucht. Bewusst großzügiges, aber
 * festes Muster: Buchstaben, Ziffern, `-`/`_`, wie bei UUIDs und den eigenen
 * generierten IDs (`newId()` im Frontend).
 */
export function isValidId(v, max = 100) {
  return typeof v === "string" && v.length > 0 && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);
}

/** Farbwert für Kategorien: `#rgb`, `#rgba`, `#rrggbb` oder `#rrggbbaa`. */
export function isHexColor(v) {
  return typeof v === "string" && /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{4}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/.test(v);
}

/** Prüft ein optionales, client-vergebenes `id`-Feld beim Anlegen. */
function validateOptionalId(body, errors, { max = 100 } = {}) {
  if (body && "id" in body && body.id != null && !isValidId(body.id, max)) {
    errors.push("id ist ungültig (nur Buchstaben, Ziffern, - und _, max. " + max + " Zeichen)");
  }
}

/**
 * Prüft einen neuen oder geänderten Ort (Katalogeintrag: Titel, Kategorie,
 * Koordinaten, dauerhafte Bewertung/Notiz — NICHT der einzelne Aufenthalt,
 * siehe validateBesuch). `partial` erlaubt Teilangaben (PATCH).
 */
export function validateOrt(body, { partial = false } = {}) {
  const errors = [];
  const has = (k) => body && Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has("lat")) {
    if (!isFiniteNumber(body?.lat) || body.lat < -90 || body.lat > 90) errors.push("lat muss zwischen -90 und 90 liegen");
  }
  if (!partial || has("lon")) {
    if (!isFiniteNumber(body?.lon) || body.lon < -180 || body.lon > 180) errors.push("lon muss zwischen -180 und 180 liegen");
  }
  if (has("title") && !isText(body.title, 200)) errors.push("title zu lang (max. 200)");
  if (has("address") && body.address != null && !isText(body.address, 200)) errors.push("address zu lang (max. 200)");
  if (has("note") && body.note != null && !isText(body.note, 4000)) errors.push("note zu lang (max. 4000)");
  if (has("rating") && body.rating != null && (!Number.isInteger(body.rating) || body.rating < 0 || body.rating > 5)) {
    errors.push("rating muss 0–5 sein");
  }
  if (!partial) validateOptionalId(body, errors);
  return { ok: errors.length === 0, errors };
}

/**
 * Prüft einen neuen oder geänderten Besuch (ein einzelner Aufenthalt an
 * einem Ort — occurred_at/nights/Wetter, KEINE eigene trip_id: die
 * Reise-Zugehörigkeit wird wie bei Fahrten live aus occurred_at berechnet).
 * `partial` erlaubt Teilangaben (PATCH).
 */
export function validateBesuch(body, { partial = false } = {}) {
  const errors = [];
  const has = (k) => body && Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has("ort_id")) {
    if (!isValidId(body?.ort_id)) errors.push("ort_id fehlt oder ist ungültig");
  }
  if (has("source") && !["camper", "handy", "manuell"].includes(body.source)) {
    errors.push("source muss camper, handy oder manuell sein");
  }
  if (has("nights") && body.nights != null && (!Number.isInteger(body.nights) || body.nights < 1 || body.nights > 60)) {
    errors.push("nights muss zwischen 1 und 60 liegen");
  }
  if (has("stop_key") && body.stop_key != null && !isText(body.stop_key, 200)) errors.push("stop_key zu lang (max. 200)");
  if (has("kind") && body.kind != null && !["auto", "manual"].includes(body.kind)) {
    errors.push("kind muss auto oder manual sein");
  }
  if (!partial) validateOptionalId(body, errors);
  return { ok: errors.length === 0, errors };
}

/** Prüft eine neue oder geänderte Notiz. */
export function validateNote(body, { partial = false } = {}) {
  const errors = [];
  const has = (k) => body && Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has("title")) {
    if (typeof body?.title !== "string" || !body.title.trim()) errors.push("title fehlt");
    else if (body.title.length > 160) errors.push("title zu lang (max. 160)");
  }
  if (!partial || has("text")) {
    if (typeof body?.text !== "string" || !body.text.trim()) errors.push("text fehlt");
    else if (body.text.length > 8000) errors.push("text zu lang (max. 8000)");
  }
  if (has("lat") && body.lat != null && (!isFiniteNumber(body.lat) || body.lat < -90 || body.lat > 90)) {
    errors.push("lat muss zwischen -90 und 90 liegen");
  }
  if (has("lon") && body.lon != null && (!isFiniteNumber(body.lon) || body.lon < -180 || body.lon > 180)) {
    errors.push("lon muss zwischen -180 und 180 liegen");
  }
  if (has("source") && !["camper", "handy", "manuell"].includes(body.source)) {
    errors.push("source muss camper, handy oder manuell sein");
  }
  if (has("weather") && body.weather != null && !isText(body.weather, 1000)) errors.push("weather zu lang");
  if (has("besuch_id") && body.besuch_id != null && !isValidId(body.besuch_id)) errors.push("besuch_id ist ungültig");
  if (!partial) validateOptionalId(body, errors);
  return { ok: errors.length === 0, errors };
}

/** Prüft eine neue oder geänderte Reise. */
export function validateTrip(body, { partial = false } = {}) {
  const errors = [];
  const has = (k) => body && Object.prototype.hasOwnProperty.call(body, k);
  const isDate = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));

  if (!partial && has("name") && !isText(body.name, 120)) errors.push("name zu lang (max. 120)");
  if (has("name") && body.name != null && !isText(body.name, 120)) errors.push("name zu lang (max. 120)");
  if (has("start_at") && body.start_at != null && !isDate(body.start_at)) errors.push("start_at ist kein gültiges Datum");
  if (has("end_at") && body.end_at != null && !isDate(body.end_at)) errors.push("end_at ist kein gültiges Datum");
  if (has("start_at") && has("end_at") && body.start_at && body.end_at && Date.parse(body.end_at) < Date.parse(body.start_at)) {
    errors.push("end_at liegt vor start_at");
  }
  if (has("vehicle_id") && body.vehicle_id != null && !isValidId(body.vehicle_id, 100)) {
    errors.push("vehicle_id ist ungültig");
  }
  if (!partial) validateOptionalId(body, errors);
  return { ok: errors.length === 0, errors };
}

/** Prüft eine neue oder geänderte Kategorie. */
export function validateCategory(body, { partial = false } = {}) {
  const errors = [];
  const has = (k) => body && Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has("name")) {
    if (typeof body?.name !== "string" || !body.name.trim()) errors.push("name fehlt");
    else if (body.name.length > 60) errors.push("name zu lang (max. 60)");
  }
  if (has("color") && body.color != null && !isHexColor(body.color)) {
    errors.push("color muss eine Hex-Farbe sein (z. B. #e8802b)");
  }
  if (has("sort") && body.sort != null && (!Number.isInteger(body.sort) || body.sort < -1000 || body.sort > 1000)) {
    errors.push("sort muss eine ganze Zahl zwischen -1000 und 1000 sein");
  }
  if (!partial) validateOptionalId(body, errors, { max: 60 });
  return { ok: errors.length === 0, errors };
}

/** Prüft ein neues oder geändertes Fahrzeug. */
export function validateVehicle(body, { partial = false } = {}) {
  const errors = [];
  const has = (k) => body && Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has("name")) {
    if (typeof body?.name !== "string" || !body.name.trim()) errors.push("name fehlt");
    else if (body.name.length > 80) errors.push("name zu lang (max. 80)");
  }
  if (has("traccar_device_id") && body.traccar_device_id != null) {
    if (typeof body.traccar_device_id !== "string" && typeof body.traccar_device_id !== "number") {
      errors.push("traccar_device_id muss Text oder Zahl sein");
    } else if (String(body.traccar_device_id).length > 60) {
      errors.push("traccar_device_id zu lang (max. 60)");
    }
  }
  if (has("active") && body.active != null && typeof body.active !== "boolean") {
    errors.push("active muss true oder false sein");
  }
  if (!partial) validateOptionalId(body, errors);
  return { ok: errors.length === 0, errors };
}

/** Zeitraum-Parameter für Traccar-Berichte prüfen. */
export function validateRange(from, to) {
  const errors = [];
  if (!from || Number.isNaN(Date.parse(from))) errors.push("from fehlt oder ist ungültig");
  if (!to || Number.isNaN(Date.parse(to))) errors.push("to fehlt oder ist ungültig");
  if (!errors.length && Date.parse(to) < Date.parse(from)) errors.push("to liegt vor from");
  return { ok: errors.length === 0, errors };
}

/* ---------------- Eigene Positionsquelle (Phase 2) ----------------
 * Nur genutzt, wenn env.LOCAL_POSITIONS gesetzt ist (app-backend/src/server.js) —
 * sonst liefert der bisherige Traccar-Proxy in router.js dieselben Routen wie
 * immer, unverändert. Reine Funktionen: nehmen Zeilen aus der eigenen
 * `positions`-Tabelle (tracker-backend/schema.sql) entgegen, geben
 * Traccar-förmige Objekte zurück — dieselbe Form, die das Frontend
 * (src/dataload.js) heute schon von Traccar erwartet, damit dort nichts
 * geändert werden muss. */

/** Eine positions-Zeile wie eine Traccar-Position formen (Knoten statt
 * km/h — src/dataload.js multipliziert selbst mit 1.852, wie bei Traccar). */
export function mapPositionRow(row) {
  return {
    deviceId: row.device_id,
    latitude: row.lat,
    longitude: row.lon,
    altitude: row.altitude ?? 0,
    speed: Number.isFinite(row.speed_kmh) ? row.speed_kmh / 1.852 : 0,
    course: row.course ?? 0,
    fixTime: new Date(row.at).toISOString(),
    deviceTime: new Date(row.at).toISOString(),
  };
}

const MAX_LUECKE_MINUTEN = 120; // wie src/route-summary.js: MAX_BEWEGUNGSLUECKE_MINUTEN

function haversineMeter(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// Fenster (Zeit) und Mindest-Ortsveränderung darin, ab der eine Kante als
// "bewegt" gilt — siehe fensterBewegt() unten für die ausführliche Begründung.
const BEWEGUNG_FENSTER_MS = 90_000;
const BEWEGUNG_FENSTER_MIN_M = 40;

/**
 * War ursprünglich eine reine Sofort-Geschwindigkeits-Schwelle je Kante
 * (Math.max(a.speed, b.speed) >= 5 km/h). Drei live beobachtete Fehlbilder
 * (17. August 2026) zeigten nacheinander: das reicht nicht, und auch die
 * naheliegenden Reparaturen greifen zu kurz.
 *
 * 1. Ein erster Ansatz glättete zu kurze Läufe nachträglich durch
 *    Zusammenlegen mit dem Nachbarlauf — behob zwar die Zerstückelung
 *    einer ~10-minütigen Gassirunde in mehrere Sekunden-"Fahrten",
 *    verschluckte aber bei einem zweiten, längeren Spaziergang
 *    (~22 Minuten) die GESAMTE Bewegung: viele kurze, abwechselnde
 *    bewegt/steht-Läufe (jeder für sich unter der Kurzlauf-Schwelle)
 *    wurden alle nacheinander demselben ursprünglichen "steht"-Lauf
 *    zugeschlagen, ohne je zu berücksichtigen, dass sich daraus über die
 *    Zeit doch echte, zusammenhängende Strecke ergibt.
 * 2. Ein zweiter Ansatz summierte stattdessen die zurückgelegte Strecke in
 *    einem 90-Sekunden-Fenster um jede Kante auf — behob Fall 1, erzeugte
 *    aber neue Geister-"Fahrten" von teils über einer Stunde Dauer bei nur
 *    ein paar hundert Metern Gesamtstrecke: GPS-Rauschen im Stand (z. B.
 *    in Gebäudenähe) hüpft gelegentlich einige Meter hin und her,
 *    summiert über 90 Sekunden reichte das immer wieder knapp über die
 *    Schwelle — obwohl das Gerät die ganze Zeit am selben Fleck stand.
 *
 * Der eigentliche Unterschied zwischen echter Bewegung und Rauschen ist
 * nicht die aufsummierte Strecke, sondern die NETTO-ORTSVERÄNDERUNG: Beim
 * Gehen/Fahren entfernt man sich innerhalb des Fensters spürbar vom
 * Startpunkt (Netto ≈ Summe, weil der Weg überwiegend in eine Richtung
 * führt) — beim Herumzappeln auf der Stelle hebt sich die Bewegung
 * größtenteils wieder auf (Netto bleibt klein, auch wenn die Summe der
 * einzelnen Sprünge das nicht tut).
 *
 * 3. Auch die Netto-Ortsveränderung allein reichte noch nicht: In echten
 *    Daten gab es einen ~76-minütigen Abschnitt mit durchgehend
 *    gemeldeter Geschwindigkeit 0 (Gerät lag erkennbar still), in dem
 *    trotzdem ein einzelner GPS-Ausreißer (ein kurzzeitig weit
 *    abweichender Fix, danach wieder normal) das 90-Sekunden-Fenster
 *    mehrerer benachbarter Kanten über die 40-m-Schwelle hob — eine
 *    stundenlange Geister-"Fahrt" ganz ohne echte Bewegung. Deshalb
 *    zusätzlich: Die Netto-Ortsveränderung zählt nur, wenn im selben
 *    Fenster auch mindestens ein Punkt eine nennenswerte eigene
 *    Geschwindigkeit meldet (das GPS-Modul selbst schätzt Geschwindigkeit
 *    typischerweise über die Doppler-Verschiebung, nicht über die
 *    Positions-Differenz — robuster gegen genau solche einzelnen
 *    Fix-Ausreißer als die Position allein).
 *
 * Luftlinie zwischen dem ersten und letzten Punkt im 90-Sekunden-Fenster
 * um die Kante UND mindestens ein Punkt darin mit spürbarer eigener
 * Geschwindigkeit — nicht die Sofort-Geschwindigkeit zweier Punkte allein,
 * nicht die aufsummierte Strecke allein. Gegen alle drei echten
 * Datensätze verifiziert (siehe
 * api/test/fixtures/echte-spaziergaenge-17-08-2026.json).
 */
const BEWEGUNG_FENSTER_MIN_KMH = 2; // s. Punkt 3 oben — deutlich unter Gehtempo, schließt nur "durchgehend 0" aus

function fensterBewegt(rows, i) {
  const mitteMs = (rows[i - 1].at + rows[i].at) / 2;
  const startMs = mitteMs - BEWEGUNG_FENSTER_MS / 2;
  const endeMs = mitteMs + BEWEGUNG_FENSTER_MS / 2;
  // Läuft in beide Richtungen nur innerhalb des Zeitfensters UND nur
  // solange keine Datenlücke dazwischenliegt — eine Lücke ist eine harte
  // Grenze, auch fürs Fenster (wir wissen nicht, was dazwischen passiert ist).
  let links = i - 1;
  while (
    links > 0 && rows[links - 1].at >= startMs
    && (rows[links].at - rows[links - 1].at) / 60000 <= MAX_LUECKE_MINUTEN
  ) links--;
  let rechts = i;
  while (
    rechts < rows.length - 1 && rows[rechts + 1].at <= endeMs
    && (rows[rechts + 1].at - rows[rechts].at) / 60000 <= MAX_LUECKE_MINUTEN
  ) rechts++;
  if (haversineMeter(rows[links], rows[rechts]) < BEWEGUNG_FENSTER_MIN_M) return false;
  for (let j = links; j <= rechts; j++) {
    if ((rows[j].speed_kmh || 0) >= BEWEGUNG_FENSTER_MIN_KMH) return true;
  }
  return false;
}

// Auch über eine lange Datenlücke hinweg gilt: steht das Gerät auf BEIDEN
// Seiten (Geschwindigkeit ~0) fast am selben Fleck, war es mit großer
// Wahrscheinlichkeit die ganze Zeit dort geparkt — nur die Funkverbindung
// ist ausgefallen, nicht die Fahrt. Echter Fund (1. September 2026): eine
// gut 10-stündige Übernachtung fiel komplett unter "unbekannt" (Lücke ab
// 18:30 Uhr, Fahrzeug meldet sich erst um 5:16 Uhr wieder), obwohl davor
// UND danach Geschwindigkeit 0 an praktisch derselben Stelle stand — die
// Übernachtung wurde dadurch nie automatisch erkannt. Bewusst dieselben
// Schwellen wie anderswo (DOPPELTER_STOPP_RADIUS_KM in src/dataload.js,
// BEWEGUNG_FENSTER_MIN_KMH oben) statt neuer, unabgestimmter Werte.
// Gegenprobe bewusst nicht gemacht (kann man auch nicht): eine Lücke ist
// eine Lücke, es bleibt eine Vermutung anhand der Ränder — aber eine
// deutlich bessere als "wissen wir nicht", wenn beide Ränder übereinstimmen.
//
// Schwelle von 2 auf 5 km/h angehoben — echter Fund (27. September 2026):
// gleich zwei Übernachtungen in Folge fielen komplett unter "unbekannt", weil das GPS-Modul beim
// ersten Fix nach der Funkstille (Kaltstart) auf beiden Seiten der Lücke
// 3 km/h Rest-Geschwindigkeit meldete statt 0 — bei tatsächlich nur ~20 m
// Ortsveränderung über 9,5 bzw. 14,5 Stunden. Die 300-m-Distanzschwelle
// bleibt der eigentliche Schutz gegen eine fälschlich als Stand gewertete
// echte Fahrt während der Lücke; die Geschwindigkeit filtert nur noch die
// eindeutigen Fälle (durchgehend deutlich über Schrittgeschwindigkeit).
const LUECKE_STEHT_MAX_KMH = 5;
const LUECKE_STEHT_MAX_M = 300;
// Liegen beide Ränder einer langen Lücke praktisch am selben Fleck, ist die
// Randgeschwindigkeit egal: echter Fund (28. September 2026) — die erste
// Meldung nach einer 14-stündigen Übernachtung kam mit 15 km/h (das Fahrzeug
// fuhr schon los), lag aber nur 23 m vom letzten Punkt vor der Stille. Dasselbe
// gilt für den künstlichen Endpunkt "jetzt" beim noch offenen Stand (siehe
// tracker-backend/src/auto-import.js), der per Konstruktion 0 m entfernt ist.
const LUECKE_STEHT_NAH_M = 50;

/** Ordnet je zwei aufeinanderfolgende Positionen einem Zustand zu:
 * "bewegt", "steht", oder "luecke" (zu viel Zeit dazwischen und auf beiden
 * Seiten keine Anzeichen von durchgehendem Stand — weder als Fahrt noch
 * als Stopp zu werten, da wir schlicht nicht wissen, was dazwischen
 * passiert ist). */
function klassifiziereKanten(rows) {
  const kanten = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    const lueckeMinuten = (b.at - a.at) / 60000;
    if (!(lueckeMinuten > 0)) continue; // gleicher/rückwärtiger Zeitstempel — überspringen
    if (lueckeMinuten > MAX_LUECKE_MINUTEN) {
      // <= statt < an der Schwelle selbst: LUECKE_STEHT_MAX_KMH ist der
      // Wert, der noch als "steht" gelten soll — bei genau diesem Wert
      // (2 km/h) fiel eine echte, gut zweistündige Standzeit bisher knapp
      // durchs Raster (echter Fund: ein Stopp auf einer Landstraße,
      // Lücke exakt 120,3 Minuten mit
      // Randgeschwindigkeit genau 2 km/h auf einer Seite).
      const abstandM = haversineMeter(a, b);
      const vermutlichStand = abstandM < LUECKE_STEHT_NAH_M
        || ((a.speed_kmh || 0) <= LUECKE_STEHT_MAX_KMH
          && (b.speed_kmh || 0) <= LUECKE_STEHT_MAX_KMH
          && abstandM < LUECKE_STEHT_MAX_M);
      kanten.push({ a, b, zustand: vermutlichStand ? "steht" : "luecke", distanzM: 0 });
      continue;
    }
    const zustand = fensterBewegt(rows, i) ? "bewegt" : "steht";
    kanten.push({ a, b, zustand, distanzM: haversineMeter(a, b) });
  }
  return kanten;
}

function gruppiereNachZustand(kanten, gesuchterZustand) {
  const gruppen = [];
  let lauf = [];
  for (const kante of kanten) {
    if (kante.zustand === gesuchterZustand) lauf.push(kante);
    else { if (lauf.length) gruppen.push(lauf); lauf = []; }
  }
  if (lauf.length) gruppen.push(lauf);
  return gruppen;
}

function baueFahrt(kanten) {
  const start = kanten[0].a;
  const ende = kanten[kanten.length - 1].b;
  const distanzM = kanten.reduce((summe, k) => summe + k.distanzM, 0);
  const dauerMs = ende.at - start.at;
  const geschwindigkeiten = kanten.flatMap((k) => [k.a.speed_kmh, k.b.speed_kmh]).filter(Number.isFinite);
  const maxKmh = geschwindigkeiten.length ? Math.max(...geschwindigkeiten) : 0;
  const avgKmh = dauerMs > 0 ? (distanzM / 1000) / (dauerMs / 3600000) : 0;
  return {
    startTime: new Date(start.at).toISOString(),
    endTime: new Date(ende.at).toISOString(),
    distance: Math.round(distanzM), // Meter, wie Traccar
    duration: dauerMs, // Millisekunden, wie Traccar
    averageSpeed: avgKmh / 1.852, // Knoten, wie Traccar
    maxSpeed: maxKmh / 1.852,
    startLat: start.lat,
    startLon: start.lon,
    startAddress: "",
    endAddress: "",
    // Die TATSÄCHLICHE Geräte-ID der Positionsdaten, nicht die aktuell im
    // Fahrzeug konfigurierte — damit eine spätere Umbenennung der Geräte-ID
    // in den Einstellungen bestehende Fahrt-Zuordnungen (drive_key) nicht
    // unauffindbar macht. Siehe driveKey() in src/dataload.js.
    deviceId: start.device_id ?? null,
  };
}

function baueStopp(kanten) {
  const start = kanten[0].a;
  const ende = kanten[kanten.length - 1].b;
  const alle = [start, ...kanten.map((k) => k.b)];
  const lat = alle.reduce((s, p) => s + p.lat, 0) / alle.length;
  const lon = alle.reduce((s, p) => s + p.lon, 0) / alle.length;
  return {
    startTime: new Date(start.at).toISOString(),
    endTime: new Date(ende.at).toISOString(),
    duration: ende.at - start.at,
    lat, lon,
    address: "",
    // Siehe deviceId-Kommentar in baueFahrt() oben — dieselbe Begründung.
    deviceId: start.device_id ?? null,
  };
}

/**
 * Fahrten aus einer nach Zeit aufsteigend sortierten Liste von
 * positions-Zeilen ableiten (Traccar-Trip-Report-Form). Bewusst eigen
 * gebaut, kein Nachbau von Traccars Algorithmus — Grundidee wie die
 * bestehende Bewegungserkennung in src/route-summary.js (bewegungsMinuten):
 * je zwei aufeinanderfolgende Punkte bilden eine Kante, aufeinanderfolgende
 * "bewegt"-Kanten bilden eine Fahrt.
 */
// Restrauschen nach der Fenster-Klassifizierung: sehr kurze "Fahrten"
// (wenige Sekunden, wenige Meter) an den Rändern eines Bewegungsfensters,
// wo genau ein Punkt zufällig sowohl die Netto- als auch die
// Geschwindigkeitsschwelle knapp erfüllt. Einzeln zu selten/klein, um
// eine eigene Fahrt zu rechtfertigen — herausgefiltert statt eine weitere
// Zusammenlege-Heuristik zu riskieren (siehe die Historie im
// Kopfkommentar von fensterBewegt()).
const MIN_FAHRT_METER = 25;

export function segmentDrives(rows) {
  return gruppiereNachZustand(klassifiziereKanten(rows), "bewegt")
    .map(baueFahrt)
    .filter((f) => f.distance >= MIN_FAHRT_METER);
}

/**
 * Stopps aus derselben Positionsliste ableiten (Traccar-Stop-Report-Form).
 * Ob ein Stopp lang/nachts genug für eine automatische Übernachtung ist,
 * entscheidet weiterhin src/overnight-rules.js — hier wird nur segmentiert,
 * nicht bewertet.
 */
export function segmentStops(rows) {
  return gruppiereNachZustand(klassifiziereKanten(rows), "steht").map(baueStopp);
}

/* ---------------- Wetter ---------------- */

/**
 * WMO-Wettercodes in Worte. Open-Meteo liefert diese Codes; sie sind der
 * gemeinsame Nenner aller Wetterdienste.
 */
const WETTER_TEXTE = new Map([
  [[0], "klar"],
  [[1], "überwiegend klar"],
  [[2], "wechselnd bewölkt"],
  [[3], "bedeckt"],
  [[45, 48], "Nebel"],
  [[51, 53, 55], "Nieselregen"],
  [[56, 57], "gefrierender Niesel"],
  [[61, 63, 65], "Regen"],
  [[66, 67], "gefrierender Regen"],
  [[71, 73, 75], "Schneefall"],
  [[77], "Schneegriesel"],
  [[80, 81, 82], "Regenschauer"],
  [[85, 86], "Schneeschauer"],
  [[95], "Gewitter"],
  [[96, 99], "Gewitter mit Hagel"],
]);

const WETTER_ZEICHEN = new Map([
  [[0, 1], "☀️"], [[2], "🌤️"], [[3], "☁️"], [[45, 48], "🌫️"],
  [[51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82], "🌧️"],
  [[71, 73, 75, 77, 85, 86], "🌨️"], [[95, 96, 99], "⛈️"],
]);

const ausTabelle = (tabelle, code, vorgabe) => {
  for (const [codes, wert] of tabelle) if (codes.includes(code)) return wert;
  return vorgabe;
};

export const weatherText = (code) => ausTabelle(WETTER_TEXTE, Number(code), "unbekannt");
export const weatherSymbol = (code) => ausTabelle(WETTER_ZEICHEN, Number(code), "🌡️");

/**
 * Sucht in einer Stundenreihe den Eintrag, der einem Zeitpunkt am nächsten
 * liegt. Open-Meteo liefert die Zeiten ohne Zeitzone (UTC angefordert).
 */
export function pickHourIndex(times, at) {
  if (!Array.isArray(times) || !times.length) return -1;
  const ziel = Date.parse(at);
  if (!Number.isFinite(ziel)) return -1;
  let beste = -1;
  let abstand = Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = Date.parse(times[i].length <= 16 ? `${times[i]}:00Z` : times[i]);
    if (!Number.isFinite(t)) continue;
    const d = Math.abs(t - ziel);
    if (d < abstand) { abstand = d; beste = i; }
  }
  // Mehr als 12 Stunden daneben ist keine Aussage über diesen Zeitpunkt mehr.
  return abstand <= 12 * 3600 * 1000 ? beste : -1;
}

/**
 * Baut aus einer Nominatim-Reverse-Geocoding-Antwort einen prägnanten
 * Namensvorschlag für einen automatisch angelegten Ort — reine
 * Parsing-Logik, getrennt vom fetch() in router.js (wie pickHourIndex()
 * oben fürs Wetter), damit sie ohne Netzwerk testbar ist.
 *
 * Ein echter POI-Name (Campingplatz, Sehenswürdigkeit, benannter Parkplatz
 * ...) ist am prägnantesten und hat Vorrang. Ohne einen solchen Namen (der
 * häufigste Fall — die meisten Stellplätze/Parkbuchten sind in OSM
 * namenlos) der kleinste sinnvolle Orts-/Ortsteilname als brauchbare
 * Näherung ("Musterviertel" statt einer vollen Adresse mit Hausnummer), ergänzt
 * um die nächstgrößere Stadt, falls unterscheidbar ("Musterviertel, Beispielstadt").
 */
export function benenneOrtAusGeocodeAntwort(daten) {
  if (!daten || typeof daten !== "object") return null;
  const adresse = daten.address && typeof daten.address === "object" ? daten.address : {};
  const name = (typeof daten.name === "string" && daten.name.trim()) || null;
  const naeherung = adresse.tourism || adresse.leisure || adresse.natural
    || adresse.village || adresse.suburb || adresse.town || adresse.city_district || adresse.city || null;
  const haupt = name || naeherung;
  if (!haupt) return null;
  // Nominatim führt kleinere Ortschaften als "village", nicht "town"/"city"
  // — fehlte das hier, blieb z. B. ein Straßenname wie "Feldweg" ganz
  // ohne Ortsangabe stehen, weil der Ort nur als "village" geführt wird
  // (echter Fund).
  const ort = adresse.town || adresse.city || adresse.municipality || adresse.village || null;
  return ort && ort !== haupt ? `${haupt}, ${ort}` : haupt;
}

/**
 * Namensvorschlag zu Koordinaten von Nominatim (OpenStreetMap) — ohne
 * Schlüssel, aber mit eigenem User-Agent (von Nominatims Nutzungsrichtlinie
 * verlangt) und bewusst niedriger Aufruffrequenz: das passiert nur einmal
 * je automatisch erkanntem Aufenthalt, nicht bei jedem Laden. Reiner
 * Vorschlag — der Titel bleibt jederzeit von Hand änderbar, ein
 * fehlgeschlagener Abruf verhindert das Anlegen des Ortes nicht.
 *
 * Hier statt in router.js, damit sowohl der Cloudflare/Selbst-Hosting-
 * Worker als auch der ingest-Container (tracker-backend/src/auto-import.js,
 * serverseitige Übernachtungs-/Stopp-Erkennung, 6. September 2026) sie
 * ohne Duplizierung nutzen können — api/lib.js ist bewusst abhängigkeits-
 * frei gehalten (siehe Kopfkommentar).
 */
export async function holeOrtsname(lat, lon) {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("lat", lat.toFixed(6));
  url.searchParams.set("lon", lon.toFixed(6));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("zoom", "17");
  url.searchParams.set("addressdetails", "1");
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "VOJAGO/1.0 (privater, selbst gehosteter Camper-Tracker; kein Massenabruf)",
    },
  });
  if (!res.ok) throw new Error(`Ortsdienst antwortete mit ${res.status}`);
  return benenneOrtAusGeocodeAntwort(await res.json());
}

/**
 * Wetter zu Ort und Zeit von Open-Meteo — ohne Schlüssel und ohne Anmeldung.
 * Für den aktuellen Zeitpunkt die Messung, für vergangene die Stundenreihe
 * (Open-Meteo hält rund 90 Tage vor). Das Ergebnis wird beim Eintrag
 * gespeichert, damit es später nicht erneut geholt werden muss. Wie
 * holeOrtsname() oben: hier statt in router.js, damit der ingest-Container
 * sie mitnutzen kann.
 */
export async function holeWetter(lat, lon, at) {
  const zeit = Date.parse(at);
  const jetzt = Date.now();
  const aktuell = !Number.isFinite(zeit) || Math.abs(jetzt - zeit) < 2 * 3600 * 1000;
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat.toFixed(4));
  url.searchParams.set("longitude", lon.toFixed(4));
  url.searchParams.set("timezone", "UTC");

  if (aktuell) {
    url.searchParams.set("current", "temperature_2m,weather_code,wind_speed_10m,precipitation");
  } else {
    const tag = new Date(zeit).toISOString().slice(0, 10);
    url.searchParams.set("hourly", "temperature_2m,weather_code,wind_speed_10m,precipitation");
    url.searchParams.set("start_date", tag);
    url.searchParams.set("end_date", tag);
  }

  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Wetterdienst antwortete mit ${res.status}`);
  const daten = await res.json();

  let werte = null;
  if (aktuell && daten.current) {
    werte = {
      temp: daten.current.temperature_2m,
      code: daten.current.weather_code,
      wind: daten.current.wind_speed_10m,
      regen: daten.current.precipitation,
      at: daten.current.time ? `${daten.current.time}Z` : new Date().toISOString(),
    };
  } else if (daten.hourly?.time) {
    const i = pickHourIndex(daten.hourly.time, at);
    if (i >= 0) {
      werte = {
        temp: daten.hourly.temperature_2m?.[i],
        code: daten.hourly.weather_code?.[i],
        wind: daten.hourly.wind_speed_10m?.[i],
        regen: daten.hourly.precipitation?.[i],
        at: `${daten.hourly.time[i]}Z`,
      };
    }
  }
  if (!werte || werte.temp == null) throw new Error("Für diesen Zeitpunkt liegt kein Wetter vor");

  return {
    ...werte,
    temp: Math.round(werte.temp * 10) / 10,
    text: weatherText(werte.code),
    symbol: weatherSymbol(werte.code),
    quelle: "Open-Meteo",
  };
}

/**
 * Prüft Koordinaten eines Wetterabrufs. Wichtig: `Number(null)` und
 * `Number("")` ergeben 0 — eine fehlende Angabe würde sonst als Position
 * 0°/0° durchgehen und ein Wetter vom Atlantik liefern.
 */
export function validateCoords(lat, lon) {
  const errors = [];
  const zahl = (v) => (v === null || v === undefined || String(v).trim() === "" ? NaN : Number(v));
  const la = zahl(lat), lo = zahl(lon);
  if (!Number.isFinite(la) || la < -90 || la > 90) errors.push("lat fehlt oder ist ungültig");
  if (!Number.isFinite(lo) || lo < -180 || lo > 180) errors.push("lon fehlt oder ist ungültig");
  return { ok: errors.length === 0, errors, lat: la, lon: lo };
}

/* ---------------- Lastbegrenzung ---------------- */

/**
 * Einfache Begrenzung pro Aufrufer. Sie wirkt je Worker-Instanz und ist
 * damit eine Bremse gegen Ausreißer, kein harter globaler Schutz — für
 * strikte Grenzen wäre ein Durable Object oder KV nötig.
 */
export function createRateLimiter({ limit = 120, windowMs = 60_000, now = () => Date.now() } = {}) {
  const hits = new Map();
  return function take(key) {
    const t = now();
    const entry = hits.get(key);
    if (!entry || t >= entry.reset) {
      hits.set(key, { count: 1, reset: t + windowMs });
      if (hits.size > 5000) for (const [k, v] of hits) if (t >= v.reset) hits.delete(k);
      return { ok: true, remaining: limit - 1, retryAfter: 0 };
    }
    entry.count++;
    if (entry.count > limit) {
      return { ok: false, remaining: 0, retryAfter: Math.ceil((entry.reset - t) / 1000) };
    }
    return { ok: true, remaining: limit - entry.count, retryAfter: 0 };
  };
}

/* ---------------- Fehler nach außen ---------------- */

/**
 * Nach außen nur eine knappe, unverfängliche Meldung; Einzelheiten
 * bleiben im Log (bzw. erscheinen nur bei ausdrücklichem DEBUG=true).
 */
export function publicError(err, env) {
  const detail = String(err?.message || err);
  return String(env?.DEBUG) === "true"
    ? { error: "Verarbeitung fehlgeschlagen", detail }
    : { error: "Verarbeitung fehlgeschlagen" };
}

/* ---------------- Anmeldung: Passwörter und Sitzungen ---------------- */

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Gesamtzahl der Runden. Der Wert steht im gespeicherten Hash — eine spätere
 * Anhebung lässt bestehende Passwörter also gültig.
 */
export const PBKDF2_ROUNDS = 300000;

/** Cloudflare lehnt mehr als 100.000 Runden je Aufruf ab (harte Grenze). */
const MAX_RUNDEN_JE_AUFRUF = 100000;

/**
 * Leitet den Schlüssel ab. Weil je Aufruf nur 100.000 Runden erlaubt sind,
 * werden mehrere Blöcke verkettet: Das Ergebnis eines Blocks ist das
 * Ausgangsmaterial des nächsten. Der Aufwand summiert sich damit wie bei
 * einem einzelnen Lauf über die Gesamtzahl.
 */
async function derive(password, salt, rounds) {
  let material = enc.encode(password);
  let rest = rounds;
  let bits = null;
  while (rest > 0) {
    const jetzt = Math.min(MAX_RUNDEN_JE_AUFRUF, rest);
    const key = await crypto.subtle.importKey("raw", material, "PBKDF2", false, ["deriveBits"]);
    bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: jetzt }, key, 256);
    material = new Uint8Array(bits);
    rest -= jetzt;
  }
  return bits;
}

/** Erzeugt den zu speichernden Wert — enthält Verfahren, Runden und Salz. */
export async function hashPassword(password, rounds = PBKDF2_ROUNDS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, rounds);
  return `pbkdf2$${rounds}$${b64(salt)}$${b64(bits)}`;
}

/** Prüft ein Passwort gegen den gespeicherten Wert. */
export async function verifyPassword(password, stored) {
  const teile = String(stored || "").split("$");
  if (teile.length !== 4 || teile[0] !== "pbkdf2") return false;
  const rounds = Number(teile[1]);
  if (!Number.isInteger(rounds) || rounds < 1000) return false;
  const bits = await derive(password, unb64(teile[2]), rounds);
  return safeEqual(b64(bits), teile[3]);
}

/** Zufälliger Sitzungsschlüssel für das Cookie. */
export const newSessionToken = () => b64(crypto.getRandomValues(new Uint8Array(32)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

/** In der Datenbank liegt nur der Abdruck — nie der Schlüssel selbst. */
export async function hashToken(token) {
  return b64(await crypto.subtle.digest("SHA-256", enc.encode(String(token))));
}

/* ---------------- Passwort per E-Mail zurücksetzen (N11) ---------------- */

/** Einfache, aber nicht zu lockere Prüfung — Format genügt, Zustellbarkeit prüft der Mailversand selbst. */
export function isValidEmail(v) {
  return typeof v === "string" && v.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/** Zufälliger Reset-Schlüssel für den Link — dasselbe Verfahren wie bei Sitzungen. */
export const newResetToken = newSessionToken;

/** Ablaufzeit eines Reset-Links (ms) — kurz, weil er per Mail unterwegs ist. */
export const RESET_TOKEN_MINUTES = 30;

/** Derselbe Mechanismus wie beim Reset-Link, nur für die Bestätigungsmail. */
export const newVerifyToken = newSessionToken;

/** Bestätigungslinks dürfen länger liegen bleiben als Reset-Links — man
 * checkt sein Postfach nach der Kontoanlage nicht immer sofort. */
export const EMAIL_VERIFY_MINUTES = 60 * 24;

/* ---------------- Reisen teilen ---------------- */

/** Derselbe Mechanismus wie bei Sitzungen — lang genug, um nicht erratbar zu sein. */
export const newShareToken = newSessionToken;

export const SHARE_SCOPES = ["karte", "karte_logbuch"];
export function isValidShareScope(v) {
  return SHARE_SCOPES.includes(v);
}

export const SESSION_COOKIE = "vojago_session";
export const SESSION_DAYS = 60;

/** War die Anfrage per HTTPS unterwegs? Auf Cloudflare Pages immer wahr
 * (dort ist request.url schon die öffentliche https-Adresse) — beim
 * Selbst-Hosting (app-backend) läuft der Server
 * bislang über reines HTTP, ohne eigene TLS-Terminierung. x-forwarded-proto
 * zusätzlich geprüft, für einen späteren TLS-terminierenden Reverse-Proxy
 * davor, der intern per HTTP weiterreicht. */
export function istHttps(request) {
  if (request.headers.get("x-forwarded-proto") === "https") return true;
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Ohne `Secure` weigert sich der Browser, das Cookie über eine
 * HTTPS-Verbindung zu senden — mit `Secure` weigert er sich andersherum
 * über reines HTTP (RFC 6265). Beim Selbst-Hosting über reines HTTP war das
 * ein echter Fehler: Login/Setup lief scheinbar durch (Sitzung wurde
 * angelegt), aber jede folgende Anfrage kam ohne Cookie an und lieferte
 * 401 — gefunden am 16. August 2026 über echte Browser-Konsolenausgabe.
 * `secure` deshalb jetzt ausdrücklich von der tatsächlichen Anfrage
 * abhängig, nicht mehr fest verdrahtet.
 */
export function sessionCookie(token, { maxAgeSeconds = SESSION_DAYS * 86400, secure = true } = {}) {
  return `${SESSION_COOKIE}=${token}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}
export const clearedSessionCookie = (secure = true) =>
  `${SESSION_COOKIE}=; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Path=/; Max-Age=0`;

export function readCookie(request, name) {
  const roh = request.headers.get("cookie") || "";
  for (const teil of roh.split(";")) {
    const [k, ...rest] = teil.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

/**
 * Prüft Anmeldedaten. Bewusst ein freier Benutzername statt einer E-Mail:
 * Es gibt keinen Mailversand, also brächte eine Adresse keinen Nutzen —
 * weder für Bestätigung noch für ein vergessenes Passwort.
 */
export function validateCredentials({ username, password }, { neu = false } = {}) {
  const errors = [];
  if (typeof username !== "string" || username.trim().length < 3 || username.length > 60) {
    errors.push("Benutzername muss 3 bis 60 Zeichen haben");
  }
  if (typeof password !== "string" || password.length < (neu ? 10 : 1) || password.length > 200) {
    errors.push(neu ? "Passwort muss mindestens 10 Zeichen haben" : "Passwort fehlt");
  }
  return { ok: errors.length === 0, errors };
}
