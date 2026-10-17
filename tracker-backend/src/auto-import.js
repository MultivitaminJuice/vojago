// Serverseitige Übernachtungs-/Stopp-Erkennung — Portierung von
// src/dataload.js (autoImportCurrentStay()/autoImportStays(), bisher
// reiner Browser-Code) auf direkten Datenbankzugriff hier im
// ingest-Container. Läuft periodisch (siehe server.js) für ALLE
// Fahrzeuge, unabhängig davon, ob/wann irgendwer die App gerade öffnet —
// das war die eigentliche Schwäche der Browser-Variante (Nutzerwunsch,
// 6. September 2026): lief nur, wenn ein Gerät die App lud, und nur fürs
// dort gerade aktive Fahrzeug.
//
// Die Browser-Variante bleibt UNVERÄNDERT zusätzlich bestehen — als
// schnelles "sofort sichtbar, wenn die App gerade offen ist"-Add-on.
// Beide sind dank der stop_key-Eindeutigkeit (siehe schema.sql,
// UNIQUE-Index) gefahrlos gleichzeitig aktiv: wer zuerst schreibt,
// gewinnt, der andere Versuch scheitert harmlos am Unique-Index (siehe
// catch weiter unten) statt zu duplizieren.
//
// Bewusst OHNE die "wächst live" +1-Sonderregel der Browser-Variante
// (naechteAusLaufendemStand, für eine UI, die man gerade ansieht) — hier
// gibt es kein Live-UI, das mitzählen müsste: jeder Durchlauf berechnet
// die Nächte-Zahl NEU aus den bislang bekannten Daten und darf sie in
// beide Richtungen korrigieren (entspricht der final:true-Variante in
// aktualisiereAutomatischeUebernachtung() im Frontend, 6. September 2026).
//
// WICHTIG: Diese Erkennung rechnet über src/overnight-rules.js mit
// LOKALEN Uhrzeiten (22–6 Uhr "Nacht", Kalendertag-Grenzen) — im Browser
// automatisch die Zeitzone des Nutzers, hier die des Containers. Siehe
// Dockerfile: ENV TZ=Europe/Berlin, sonst liefe das in UTC und die
// Nachtfenster-Prüfung wäre um 1–2 Stunden verschoben.
import { randomUUID } from "node:crypto";
import { db } from "./store.js";
import { segmentStops, holeOrtsname, holeWetter } from "../../api/lib.js";
import { entscheideStandKategorie } from "../../src/overnight-rules.js";

const TAGE_RUECKBLICK = 30;
// Dieselben Schwellen wie im Frontend (src/dataload.js) — bewusst nicht
// neu erfunden, siehe DOPPELTER_STOPP_RADIUS_KM/ORT_WIEDERERKENNUNG_
// RADIUS_KM dort für die ausführliche Begründung.
const DOPPELTER_STOPP_RADIUS_KM = 0.3;
const ORT_WIEDERERKENNUNG_RADIUS_KM = 0.3;
// Wie AUTO_ORT_PLATZHALTER_TITEL in src/dataload.js — eigene, kleine Kopie
// hier, weil dataload.js selbst Browser-Abhängigkeiten hat (state.js,
// api.js) und sich nicht einfach mitimportieren lässt. Nur diese 3
// Zeichenketten, bei Änderung dort auch hier nachziehen.
const PLATZHALTER_TITEL = ["Aktuelle Übernachtung", "Übernachtung", "Stopp"];

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Kalendertage zwischen zwei Zeitpunkten, lokale Zeit — wie
 * kalenderTageDiff()/naechteAusZeitraum() in src/dataload.js. */
function naechteAusZeitraum(vonIso, bisIso) {
  const von = new Date(vonIso);
  const bis = new Date(bisIso);
  if (Number.isNaN(von.getTime()) || Number.isNaN(bis.getTime())) return 1;
  const vonTag = new Date(von.getFullYear(), von.getMonth(), von.getDate());
  const bisTag = new Date(bis.getFullYear(), bis.getMonth(), bis.getDate());
  return Math.max(1, Math.round((bisTag - vonTag) / 86400_000));
}

/** Welche Reise enthält diesen Zeitpunkt? Wie zugehoerigeReise() in
 * src/dataload.js — numerischer Vergleich via Date.parse(), bewusst keine
 * SQL-String-Vergleiche (unterschiedliche ISO-Genauigkeit vergliche sonst
 * falsch). */
function findeReise(occurredAtIso) {
  const t = Date.parse(occurredAtIso);
  if (!Number.isFinite(t)) return null;
  const reisen = db.prepare("SELECT id, start_at, end_at FROM trips").all();
  for (const r of reisen) {
    const von = Date.parse(r.start_at || "");
    const bis = r.end_at ? Date.parse(r.end_at) : Date.now();
    if (Number.isFinite(von) && t >= von && t <= bis) return r;
  }
  return null;
}

function findeReiseId(occurredAtIso) {
  return findeReise(occurredAtIso)?.id ?? null;
}

/** Einstufung eines Stands — EINE Stelle für Neuanlage und Aufräumen.
 *
 * Ein Aufenthalt zählt nur, soweit er in die Reise fällt: endet die Reise,
 * während das Fahrzeug noch steht, wird am Reiseende abgeschnitten (echter
 * Fund, 16. Oktober 2026: die Ankunft zuhause lag 28 Minuten vor dem
 * Reiseende, wurde als Übernachtung der Reise gewertet und wuchs mit dem
 * Stand zuhause auf 12 Nächte). Und ohne Reise (Alltag) gibt es keine
 * automatische Übernachtung — wer zuhause schläft, hat keine. Stopps
 * außerhalb von Reisen bleiben wie bisher.
 * Gibt { reise, endeIso, kategorie } zurück; kategorie null = nichts anlegen. */
function bewerteStopp(stopp) {
  const reise = findeReise(stopp.startTime);
  let endeIso = stopp.endTime;
  if (reise?.end_at) {
    const reiseEnde = Date.parse(reise.end_at);
    if (Number.isFinite(reiseEnde) && Date.parse(endeIso) > reiseEnde) endeIso = new Date(reiseEnde).toISOString();
  }
  const entscheidung = entscheideStandKategorie(stopp.startTime, endeIso);
  const kategorie = entscheidung && !(!reise && entscheidung.catId === "uebernachtung") ? entscheidung.catId : null;
  return { reise, endeIso, kategorie };
}

// Bei Übernachtungen darf die Fortsetzung beliebig lange zurückliegen
// (GPS-Aussetzer über Nacht dürfen die Kette nicht trennen, siehe
// Original in src/dataload.js) — bei einem kurzen Stopp dagegen NICHT:
// ein neuer Besuch am selben Markt Tage später soll ein eigener Eintrag
// bleiben, keine Fortsetzung. Ohne diese Grenze würde "kurzer Stopp"
// niemals von "echter neuer Besuch" unterschieden.
const STOPP_FORTSETZUNG_MAX_STUNDEN = 3;

/** Gehört ein neu erkannter Besuch noch zum selben, zusammenhängenden
 * Aufenthalt wie der zuletzt für diese Reise UND Kategorie erfasste?
 * Wie findeAehnlicheUebernachtung() in src/dataload.js, hier zusätzlich
 * für "stopp" nutzbar — echter Fund, 6. September 2026: ein einzelner
 * Aufenthalt (ein Besuch) wurde in zwei Besuche zerrissen, weil ein
 * kurzer GPS-Ausrutscher zwei Minuten lang fälschlich als "bewegt"
 * galt (siehe klassifiziereKanten() in api/lib.js) — segmentStops() lieferte
 * dadurch zwei eigenständige, sehr kurz aufeinanderfolgende Stopps statt
 * eines durchgehenden. */
function findeAehnlicheUebernachtung(lat, lon, tripId, kategorie, startIso) {
  const rows = db.prepare(
    `SELECT b.id, b.occurred_at, b.nights, o.id AS ort_id, o.category_id, o.lat, o.lon
     FROM besuche b JOIN orte o ON o.id = b.ort_id
     WHERE o.category_id = ?
     ORDER BY b.occurred_at DESC`
  ).all(kategorie);
  const startMs = Date.parse(startIso);
  for (const row of rows) {
    if (findeReiseId(row.occurred_at) !== tripId) continue;
    if (kategorie !== "uebernachtung") {
      const rowMs = Date.parse(row.occurred_at);
      const abstandStunden = Number.isFinite(startMs) && Number.isFinite(rowMs)
        ? Math.abs(startMs - rowMs) / 3600_000 : Infinity;
      if (abstandStunden > STOPP_FORTSETZUNG_MAX_STUNDEN) return null;
    }
    // Nur der JÜNGSTE Besuch dieser Reise/Kategorie zählt — sobald der
    // gefunden ist, ist die Antwort entschieden (auch wenn "zu weit weg"
    // oder "zu lange her"): keinen älteren probieren, siehe Original in
    // src/dataload.js.
    return haversineKm({ lat, lon }, row) <= DOPPELTER_STOPP_RADIUS_KM ? row : null;
  }
  return null;
}

/** Wie findeVorhandenenOrt() in src/dataload.js: gibt es über ALLE Reisen
 * hinweg schon einen Ort in der Nähe derselben Kategorie? */
function findeVorhandenenOrt(lat, lon, catId) {
  const rows = db.prepare("SELECT id, lat, lon FROM orte WHERE category_id = ?").all(catId);
  let bester = null, besteEntfernung = Infinity;
  for (const r of rows) {
    const d = haversineKm({ lat, lon }, r);
    if (d <= ORT_WIEDERERKENNUNG_RADIUS_KM && d < besteEntfernung) { bester = r; besteEntfernung = d; }
  }
  return bester?.id || null;
}

function holeFahrzeuge() {
  return db.prepare(
    "SELECT id, name, traccar_device_id, active FROM vehicles WHERE traccar_device_id IS NOT NULL AND traccar_device_id != ''"
  ).all();
}

// ── Offener Stand ────────────────────────────────────────────────────────
// Steht das Fahrzeug, meldet der Router NICHTS mehr (Stunden-Lücken über
// Nacht, siehe Funklücken-Regel in api/lib.js) — ein "Stand" endet deshalb
// nie mit einem Datenpunkt, sondern erst mit der nächsten Fahrt. Ohne
// Gegenmaßnahme würde eine laufende Übernachtung erst erkannt, wenn morgens
// wieder Daten kommen (Nutzerwunsch, 28. September 2026). Deshalb: nach der
// letzten bekannten Position wird ein künstlicher Endpunkt "jetzt" am selben
// Ort angehängt (siehe fuehreAutoImportAus) — schweigt das Fahrzeug, gilt es
// als stehend, egal wie schnell die letzte Meldung war (auch wer zügig auf
// einen Stellplatz fährt, meldet den letzten Punkt noch mit Tempo).
// Einzig echter Fehlerfall: Router ohne Strom/aus, während das Fahrzeug
// fährt — dann entsteht vorübergehend ein falscher Eintrag, der von
// bereinigeVorlaeufige() wieder entfernt wird, sobald Daten das widerlegen.
// Ohne Obergrenze würde ein seit Wochen stilles Gerät (Alt-Fahrzeug,
// Router abgebaut) einen Dauerstand von Wochen ergeben.
const MAX_OFFENER_STAND_TAGE = 7;

/** Wann ändert sich die Einstufung eines noch laufenden Stands das nächste
 * Mal (nichts → Stopp → Übernachtung, danach: die nächste Mitternacht, weil
 * dann die Nächte-Zahl steigt)? Sucht das anhand derselben Regeln wie die
 * Entscheidung selbst (entscheideStandKategorie), statt deren Schwellen hier
 * ein zweites Mal nachzubauen. null = ändert sich in den nächsten 48 Stunden
 * nicht mehr. */
export function naechsterSchwellenzeitpunkt(startIso, jetztMs) {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return null;
  const kategorie = (ms) => entscheideStandKategorie(startIso, new Date(ms).toISOString())?.catId ?? null;
  const aktuell = kategorie(jetztMs);
  if (aktuell === "uebernachtung") {
    const mitternacht = new Date(jetztMs);
    mitternacht.setHours(24, 0, 0, 0);
    return mitternacht.getTime();
  }
  const SCHRITT_MS = 5 * 60_000;
  const limit = start + 48 * 3600_000;
  for (let t = jetztMs + SCHRITT_MS; t <= limit; t += SCHRITT_MS) {
    if (kategorie(t) !== aktuell) return t;
  }
  return null;
}

const fristTimerJeGeraet = new Map();
const PUFFER_NACH_FRIST_MS = 5_000;

/** Einen einzigen Timer je Gerät auf den nächsten Schwellenzeitpunkt des
 * offenen Stands setzen (ersetzt einen vorherigen). Ohne offenen Stand: nur
 * den alten Timer verwerfen. Kein festes Intervall — der Timer feuert genau
 * dann, wenn sich etwas ändern würde. */
function planeFrist(deviceId, offenerStartIso, jetztMs) {
  clearTimeout(fristTimerJeGeraet.get(deviceId));
  fristTimerJeGeraet.delete(deviceId);
  if (!offenerStartIso) return;
  const faellig = naechsterSchwellenzeitpunkt(offenerStartIso, jetztMs);
  if (!faellig) return;
  const wartezeit = Math.max(1_000, faellig - Date.now()) + PUFFER_NACH_FRIST_MS;
  const timer = setTimeout(() => {
    fristTimerJeGeraet.delete(deviceId);
    fuehreAutoImportAus({ deviceId, planen: true }).catch((err) =>
      console.error(`[auto-import] Fristlauf für ${deviceId} fehlgeschlagen:`, err)
    );
  }, wartezeit);
  timer.unref?.();
  fristTimerJeGeraet.set(deviceId, timer);
}

/** Auto-Besuch samt (nur dafür angelegtem) Ort entfernen — aber nur, wenn
 * nie ein Mensch daran etwas getan hat: Titel noch automatisch, keine
 * Notiz/Bewertung/Fotos/Tagebuchnotizen, Kategorie unverändert. Im Zweifel
 * bleibt der Eintrag. */
function entferneAutoBesuchWennUnberuehrt(besuch) {
  const b = db.prepare("SELECT kind FROM besuche WHERE id = ?").get(besuch.id);
  const ort = db.prepare("SELECT title, address, note, rating, category_id FROM orte WHERE id = ?").get(besuch.ort_id);
  if (!b || b.kind !== "auto" || !ort) return false;
  if (!["uebernachtung", "stopp"].includes(ort.category_id)) return false;
  const titelAutomatisch = PLATZHALTER_TITEL.includes(ort.title) || (ort.address && ort.title === ort.address);
  if (!titelAutomatisch || (ort.note && ort.note.trim()) || ort.rating != null) return false;
  for (const tabelle of ["notes", "photos"]) {
    try {
      if (db.prepare(`SELECT 1 FROM ${tabelle} WHERE besuch_id = ? LIMIT 1`).get(besuch.id)) return false;
    } catch (err) {
      // Tabelle gibt es nur, wenn der app-Container sie schon angelegt hat.
      // Jeder andere Fehler: lieber behalten als womöglich Fotos mitlöschen.
      if (!/no such table/i.test(String(err?.message))) return false;
    }
  }
  db.prepare("DELETE FROM besuche WHERE id = ?").run(besuch.id);
  if (db.prepare("SELECT COUNT(*) n FROM besuche WHERE ort_id = ?").get(besuch.ort_id).n === 0) {
    db.prepare("DELETE FROM orte WHERE id = ?").run(besuch.ort_id);
  }
  return true;
}

/** Vorläufige Besuche (entstanden aus einem noch offenen Stand) prüfen,
 * sobald der Stand nicht mehr offen ist: bestätigt (bleibt) oder widerlegt
 * (z. B. das Fahrzeug ist während der Stille tatsächlich weggefahren — die
 * echten Daten zeigen dann keinen Stand mehr an dieser Stelle). Gibt die
 * Anzahl entfernter Einträge zurück. Ein widerlegter Übernachtungs-
 * Eintrag, an dessen Stelle jetzt ein kürzerer Stopp gehört, wird entfernt;
 * die normale Erkennung legt den Stopp danach im selben Durchlauf neu an. */
function bereinigeVorlaeufige(deviceId, segmente, endeVirtuell) {
  let entfernt = 0;
  const zeilen = db.prepare("SELECT stop_key FROM auto_vorlaeufig WHERE stop_key LIKE ?").all(`${deviceId}|%`);
  for (const { stop_key: stopKey } of zeilen) {
    const startIso = stopKey.slice(deviceId.length + 1);
    const seg = segmente.find((s) => s.startTime === startIso);
    const offen = Boolean(seg && endeVirtuell && seg.endTime === endeVirtuell);
    const besuch = holeBesuchMitStopKey(stopKey);
    const kategorie = seg ? bewerteStopp(seg).kategorie : null;
    const bestaetigt = besuch && kategorie
      && (kategorie === besuch.category_id || kategorie === "uebernachtung");
    // Noch offen UND weiterhin gültig: bleibt vorläufig. Noch offen, aber nicht
    // mehr gültig (z. B. die Reise wurde beendet, bevor der Stand zur Nacht
    // wurde): weiter zum Entfernen.
    if (offen && (bestaetigt || !besuch)) continue;
    if (besuch && !bestaetigt && entferneAutoBesuchWennUnberuehrt(besuch)) entfernt++;
    db.prepare("DELETE FROM auto_vorlaeufig WHERE stop_key = ?").run(stopKey);
  }
  return entfernt;
}

function holeVerworfeneStopKeys() {
  return new Set(db.prepare("SELECT stop_key FROM ignored_stops").all().map((r) => r.stop_key));
}

function holeBesuchMitStopKey(stopKey) {
  return db.prepare(
    `SELECT b.id, b.nights, o.id AS ort_id, o.category_id, o.lat, o.lon
     FROM besuche b JOIN orte o ON o.id = b.ort_id WHERE b.stop_key = ?`
  ).get(stopKey) || null;
}

/** Adresse (Reverse-Geocoding) + Wetter nachträglich ergänzen — wie
 * ergaenzeOrtsname()/ergaenzeWetter() in src/store.js: blockiert das
 * Anlegen selbst nicht, ein Fehlschlag lässt einfach den Platzhaltertitel
 * stehen. Bewusst NACHEINANDER (await), nicht parallel über mehrere neue
 * Orte hinweg — Nominatims Nutzungsrichtlinie verlangt niedrige
 * Aufruffrequenz, ein Durchlauf legt normalerweise ohnehin nur sehr
 * wenige neue Orte an.
 *
 * `geocode`/`wetter` austauschbar (Vorgabe: die echten, netzwerkbasierten
 * Funktionen) — Tests setzen hier eigene Ersatzfunktionen ein, damit sie
 * ohne Internetzugriff und ohne Nominatim/Open-Meteo zu belasten laufen. */
async function reichereOrtAn(ortId, besuchId, lat, lon, occurredAt, { geocode, wetter }) {
  try {
    const name = await geocode(lat, lon);
    if (name) {
      const aktuell = db.prepare("SELECT title FROM orte WHERE id = ?").get(ortId);
      db.prepare("UPDATE orte SET address = ?, updated_at = datetime('now') WHERE id = ?").run(name, ortId);
      if (aktuell && PLATZHALTER_TITEL.includes(aktuell.title)) {
        db.prepare("UPDATE orte SET title = ? WHERE id = ?").run(name, ortId);
      }
    }
  } catch (err) {
    console.warn("[auto-import] Ortsname nicht ermittelbar:", err.message || err);
  }
  try {
    const werte = await wetter(lat, lon, occurredAt);
    db.prepare("UPDATE besuche SET weather = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(werte), besuchId);
  } catch (err) {
    console.warn("[auto-import] Wetter nicht ermittelbar:", err.message || err);
  }
}

function legeBesuchAn({ lat, lon, kategorie, occurredAt, nights, stopKey }) {
  let ortId = findeVorhandenenOrt(lat, lon, kategorie);
  if (!ortId) {
    ortId = randomUUID();
    const titel = kategorie === "uebernachtung" ? "Aktuelle Übernachtung" : "Stopp";
    db.prepare(
      "INSERT INTO orte (id, title, category_id, rating, lat, lon) VALUES (?,?,?,?,?,?)"
    ).run(ortId, titel, kategorie, null, lat, lon);
  }
  const besuchId = randomUUID();
  // "camper"/"auto" wie die Browser-Variante — source unterscheidet nicht
  // zwischen "App hat's erkannt" und "Server hat's erkannt", das wäre für
  // niemanden ein sichtbar nützlicher Unterschied.
  db.prepare(
    `INSERT INTO besuche (id, ort_id, source, kind, occurred_at, nights, stop_key)
     VALUES (?,?,?,?,?,?,?)`
  ).run(besuchId, ortId, "camper", "auto", occurredAt, nights, stopKey);
  return { ortId, besuchId };
}

/**
 * Ein Durchlauf über Fahrzeuge — ohne `deviceId` alle (z. B. der einmalige
 * Durchlauf bei Serverstart, siehe server.js), mit `deviceId` nur das eine
 * Fahrzeug, dessen Geräte-ID gerade eine neue Position gemeldet hat (siehe
 * pruefeStoppsFuerGeraet() unten — der eigentliche, ereignisgesteuerte
 * Regelfall). Gibt {erstellt, aktualisiert} zurück, vor allem fürs
 * Logging. `geocode`/`wetter` austauschbar für Tests (siehe reichereOrtAn()).
 */
export async function fuehreAutoImportAus({
  geocode = holeOrtsname, wetter = holeWetter, deviceId = null,
  jetzt = Date.now(), offenerStand = true, planen = false,
} = {}) {
  const von = jetzt - TAGE_RUECKBLICK * 86400_000;
  const bis = jetzt;
  const verworfen = holeVerworfeneStopKeys();
  let erstellt = 0, aktualisiert = 0, entfernt = 0;

  const fahrzeuge = deviceId
    ? holeFahrzeuge().filter((f) => f.traccar_device_id === deviceId)
    : holeFahrzeuge();
  for (const fahrzeug of fahrzeuge) {
    const positionen = db.prepare(
      "SELECT * FROM positions WHERE device_id = ? AND at BETWEEN ? AND ? ORDER BY at"
    ).all(fahrzeug.traccar_device_id, von, bis);
    if (positionen.length < 2) continue;

    // Offener Stand (siehe Kommentar bei MAX_OFFENER_STAND_TAGE): künstlicher
    // Endpunkt "jetzt" am Ort der letzten Meldung — nur für aktive Fahrzeuge
    // und nur, solange die letzte Meldung nicht zu lange her ist.
    let endeVirtuell = null;
    const letzte = positionen[positionen.length - 1];
    if (offenerStand && fahrzeug.active && jetzt > letzte.at && jetzt - letzte.at <= MAX_OFFENER_STAND_TAGE * 86400_000) {
      positionen.push({ device_id: letzte.device_id, at: jetzt, lat: letzte.lat, lon: letzte.lon, speed_kmh: 0 });
      endeVirtuell = new Date(jetzt).toISOString();
    }
    const segmente = segmentStops(positionen);
    entfernt += bereinigeVorlaeufige(fahrzeug.traccar_device_id, segmente, endeVirtuell);
    if (planen) {
      planeFrist(fahrzeug.traccar_device_id, segmente.find((s) => s.endTime === endeVirtuell)?.startTime ?? null, jetzt);
    }

    for (const stopp of segmente) {
      const { reise, endeIso, kategorie } = bewerteStopp(stopp);
      if (!kategorie) continue;
      const istUebernachtung = kategorie === "uebernachtung";

      const lat = stopp.lat, lon = stopp.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const deviceId = stopp.deviceId || fahrzeug.traccar_device_id;
      const stopKey = `${deviceId}|${stopp.startTime}`;
      if (verworfen.has(stopKey)) continue;

      const bestehend = holeBesuchMitStopKey(stopKey);
      const tripId = reise?.id ?? null;
      // Fortsetzungssuche jetzt für beide Kategorien (siehe Kommentar bei
      // findeAehnlicheUebernachtung oben) — bei "stopp" zeitlich eng
      // begrenzt, bei "uebernachtung" wie gehabt unbegrenzt.
      const aehnlich = bestehend || findeAehnlicheUebernachtung(lat, lon, tripId, kategorie, stopp.startTime);
      const nights = istUebernachtung ? naechteAusZeitraum(aehnlich?.occurred_at || stopp.startTime, endeIso) : 1;

      if (aehnlich) {
        const felder = [];
        const werte = [];
        if (nights !== aehnlich.nights) { felder.push("nights = ?"); werte.push(nights); }
        if (kategorie === "uebernachtung" && aehnlich.category_id !== "uebernachtung") {
          db.prepare("UPDATE orte SET category_id = 'uebernachtung', updated_at = datetime('now') WHERE id = ?").run(aehnlich.ort_id);
        }
        if (felder.length) {
          db.prepare(`UPDATE besuche SET ${felder.join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(...werte, aehnlich.id);
          aktualisiert++;
        }
        continue;
      }

      let angelegt;
      try {
        angelegt = legeBesuchAn({ lat, lon, kategorie, occurredAt: stopp.startTime, nights, stopKey });
      } catch (err) {
        // Unique-Index auf stop_key: die Browser-Variante war schneller —
        // kein Fehler, sondern genau die vorgesehene Absicherung gegen
        // doppeltes Anlegen (siehe Kopfkommentar).
        if (!/UNIQUE constraint/i.test(String(err?.message))) {
          console.warn("[auto-import] Anlegen fehlgeschlagen:", err.message || err, { stopKey });
        }
        continue;
      }
      erstellt++;
      if (stopp.endTime === endeVirtuell) {
        db.prepare("INSERT OR IGNORE INTO auto_vorlaeufig (stop_key) VALUES (?)").run(stopKey);
      }
      await reichereOrtAn(angelegt.ortId, angelegt.besuchId, lat, lon, stopp.startTime, { geocode, wetter });
    }
  }

  if (erstellt || aktualisiert || entfernt) {
    console.log(`[auto-import] ${erstellt} neu angelegt, ${aktualisiert} aktualisiert, ${entfernt} widerlegt entfernt`);
  }
  return { erstellt, aktualisiert, entfernt };
}

// Ereignisgesteuert statt eines festen Zeitintervalls (Nutzerwunsch,
// 6. September 2026: ein Timer erkennt einen neuen Stopp erst mit bis zu
// dessen Intervall Verzögerung, ganz gleich ob gerade neue Daten
// ankamen oder nicht — sinnvoller ist, direkt zu reagieren, WENN eine
// neue Position für ein Gerät eintrifft). teltonika.js/osmand.js rufen
// das nach jedem gespeicherten Paket auf (fire-and-forget, blockiert die
// Protokoll-Antwort nicht).
//
// Trotzdem gedrosselt: Teltonika liefert nach einer Standzeit oft viele
// nachgelieferte Datensätze in einem einzigen Paket, und ein Gerät kann
// im Sekundentakt senden — ohne Drosselung liefe hier bei jedem einzelnen
// Datensatz ein voller 30-Tage-Segmentierungsdurchlauf. Ein Durchlauf pro
// Gerät alle 30 Sekunden reicht: eine neue oder länger werdende Standzeit
// wird so binnen höchstens 30 Sekunden erkannt/aktualisiert, nicht erst
// nach bis zu 10 Minuten wie beim vorherigen festen Intervall.
const MIN_ABSTAND_MS = 30_000;
const letzterLaufJeGeraet = new Map();

// Zusätzlich ein "Ruhe"-Timer je Gerät: Der Stand beginnt mit dem LETZTEN
// Paket vor der Stille — dafür kommt aber kein weiteres Ereignis mehr, und die
// Drosselung oben schluckt die letzten Pakete einer Serie. Deshalb wird bei
// jedem Paket ein Lauf für kurz nach dem (dann vermutlich) letzten Paket
// vorgemerkt; kommt vorher ein weiteres, wird er verschoben. 3 Minuten,
// weil die Bewegungserkennung (api/lib.js, fensterBewegt) erst gut anderthalb
// Minuten nach der letzten Meldung "steht" statt "bewegt" sagt.
const RUHE_NACH_LETZTEM_PAKET_MS = 3 * 60_000;
const ruheTimerJeGeraet = new Map();

export function pruefeStoppsFuerGeraet(deviceId) {
  if (!deviceId) return;

  clearTimeout(ruheTimerJeGeraet.get(deviceId));
  const ruheTimer = setTimeout(() => {
    ruheTimerJeGeraet.delete(deviceId);
    fuehreAutoImportAus({ deviceId, planen: true }).catch((err) =>
      console.error(`[auto-import] Ruhelauf für ${deviceId} fehlgeschlagen:`, err)
    );
  }, RUHE_NACH_LETZTEM_PAKET_MS);
  ruheTimer.unref?.();
  ruheTimerJeGeraet.set(deviceId, ruheTimer);

  const zuletzt = letzterLaufJeGeraet.get(deviceId) || 0;
  if (Date.now() - zuletzt < MIN_ABSTAND_MS) return;
  letzterLaufJeGeraet.set(deviceId, Date.now());
  fuehreAutoImportAus({ deviceId, planen: true }).catch((err) =>
    console.error(`[auto-import] Durchlauf für ${deviceId} fehlgeschlagen:`, err)
  );
}
