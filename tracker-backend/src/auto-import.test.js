// Eigene Test-Datenbank, wie bei alarms.test.js. TZ fest auf Europe/Berlin
// gesetzt (VOR jedem Date-Gebrauch) — die Übernachtungs-/Stopp-Entscheidung
// (src/overnight-rules.js) rechnet mit lokalen Uhrzeiten, ein Testlauf auf
// einer Maschine mit anderer Zeitzone müsste sonst unvorhersehbar
// scheitern oder bestehen (siehe Dockerfile-Kommentar zu TZ).
process.env.TZ = "Europe/Berlin";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

const TEST_DB = `/tmp/vojago-tracker-autoimport-test-${Date.now()}.db`;
process.env.TRACKER_DB_PATH = TEST_DB;

let db, fuehreAutoImportAus, naechsterSchwellenzeitpunkt;

before(async () => {
  ({ db } = await import("./store.js"));
  ({ fuehreAutoImportAus, naechsterSchwellenzeitpunkt } = await import("./auto-import.js"));
});

after(() => {
  db.close();
  rmSync(TEST_DB, { force: true });
  rmSync(`${TEST_DB}-wal`, { force: true });
  rmSync(`${TEST_DB}-shm`, { force: true });
});

const DEVICE = "d1";

beforeEach(() => {
  db.exec("DELETE FROM positions; DELETE FROM vehicles; DELETE FROM trips; DELETE FROM besuche; DELETE FROM orte; DELETE FROM ignored_stops; DELETE FROM auto_vorlaeufig;");
  db.prepare("INSERT INTO vehicles (id, name, traccar_device_id, active) VALUES ('v1', 'Camper', ?, 1)").run(DEVICE);
  // Eine durchgehend laufende Reise, die den gesamten Testzeitraum abdeckt
  // — findeReiseId() (auto-import.js) soll jeden Testzeitpunkt zuordnen.
  db.prepare("INSERT INTO trips (id, name, start_at, end_at) VALUES ('t1', 'Testreise', ?, NULL)")
    .run(new Date(Date.now() - 25 * 86400_000).toISOString());
});

// Kein Netzwerk in Tests — geocode()/wetter() sind austauschbar (siehe
// auto-import.js), Vorgabe hier: nichts liefern, aber auch nicht scheitern.
// offenerStand: false — die älteren Tests unten beschreiben abgeschlossene
// Aufenthalte mit festem Datenende; ohne das würde die anschließende Stille
// bis "jetzt" (Tage später) als weiterlaufender Stand gewertet.
const KEIN_NETZ = {
  geocode: async () => null, wetter: async () => { throw new Error("kein Netz in Tests"); },
  offenerStand: false,
};

/** ISO-Zeitpunkt "vor `tageZurueck` Tagen, lokale Uhrzeit `stunde`:`minute`"
 * — fest verdrahtete Uhrzeit, nicht nur "jetzt minus X Stunden", damit die
 * Nachtfenster-Prüfung (22–6 Uhr lokal) unabhängig von der Tageszeit des
 * Testlaufs verlässlich dieselbe Uhrzeit sieht. */
function zeitpunkt(tageZurueck, stunde, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() - tageZurueck);
  d.setHours(stunde, minute, 0, 0);
  return d;
}

function einfuegen(rows) {
  const stmt = db.prepare(
    `INSERT INTO positions (device_id, at, lat, lon, speed_kmh, protocol, created_at)
     VALUES (?, ?, ?, ?, ?, 'osmand', ?)`
  );
  for (const r of rows) stmt.run(DEVICE, r.at, r.lat, r.lon, r.speed ?? 0, Date.now());
}

function besucheMitKategorie(catId) {
  return db.prepare(
    "SELECT b.*, o.category_id, o.title, o.lat, o.lon FROM besuche b JOIN orte o ON o.id = b.ort_id WHERE o.category_id = ?"
  ).all(catId);
}

test("eine echte Übernachtung (22 bis 7 Uhr) wird als Übernachtung angelegt", async () => {
  const start = zeitpunkt(3, 22, 0);
  const ende = zeitpunkt(2, 7, 0); // 9 Stunden später
  einfuegen([
    { at: start.getTime(), lat: 51.9, lon: 6.0, speed: 1 },
    { at: ende.getTime(), lat: 51.9001, lon: 6.0001, speed: 1 },
  ]);

  const ergebnis = await fuehreAutoImportAus(KEIN_NETZ);
  assert.equal(ergebnis.erstellt, 1);

  const besuche = besucheMitKategorie("uebernachtung");
  assert.equal(besuche.length, 1);
  assert.equal(besuche[0].nights, 1);
  assert.equal(besuche[0].source, "camper");
  assert.equal(besuche[0].kind, "auto");
});

test("ein kurzer Tagesstopp (30 Minuten, mittags) wird als Stopp angelegt, nicht als Übernachtung", async () => {
  const basis = zeitpunkt(2, 14, 0).getTime();
  const punkte = [];
  for (let m = 0; m <= 30; m += 5) punkte.push({ at: basis + m * 60_000, lat: 51.95, lon: 6.05, speed: 0 });
  einfuegen(punkte);

  const ergebnis = await fuehreAutoImportAus(KEIN_NETZ);
  assert.equal(ergebnis.erstellt, 1);

  const stopps = besucheMitKategorie("stopp");
  assert.equal(stopps.length, 1);
  const uebernachtungen = besucheMitKategorie("uebernachtung");
  assert.equal(uebernachtungen.length, 0);
});

// Echter Fund: ein einziger, langer
// Aufenthalt zerfiel in zwei Stopps, weil ein kurzer GPS-Ausrutscher
// (Sekunden lang fälschlich "bewegt") zwischen zwei ansonsten
// zusammenhängenden Standzeiten lag.
test("ein kurzer GPS-Ausrutscher zwischen zwei Standzeiten am selben Fleck erzeugt nur EINEN Stopp", async () => {
  const basis = zeitpunkt(2, 14, 0).getTime();
  const punkte = [];
  for (let m = 0; m <= 25; m += 5) punkte.push({ at: basis + m * 60_000, lat: 51.95, lon: 6.05, speed: 0 });
  // Kurzer Ausrutscher: ~65 m weg, hohe Geschwindigkeit, nur Sekunden lang.
  punkte.push({ at: basis + 25.5 * 60_000, lat: 51.9506, lon: 6.05, speed: 20 });
  punkte.push({ at: basis + 25.65 * 60_000, lat: 51.95, lon: 6.05, speed: 20 });
  for (let m = 26; m <= 51; m += 5) punkte.push({ at: basis + m * 60_000, lat: 51.95, lon: 6.05, speed: 0 });
  einfuegen(punkte);

  const ergebnis = await fuehreAutoImportAus(KEIN_NETZ);
  assert.equal(ergebnis.erstellt, 1, "nur ein Stopp darf neu angelegt werden");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM besuche").get().n, 1);
});

test("zwei Stopps am selben Ort, mit einer echten Zwischenfahrt Stunden auseinander, bleiben getrennt", async () => {
  const ersterBasis = zeitpunkt(3, 10, 0).getTime();
  const punkte = [];
  for (let m = 0; m <= 25; m += 5) punkte.push({ at: ersterBasis + m * 60_000, lat: 51.95, lon: 6.05, speed: 0 });
  einfuegen(punkte);
  await fuehreAutoImportAus(KEIN_NETZ);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM besuche").get().n, 1);

  // Eine ECHTE Zwischenfahrt (nicht nur eine Funklücke) — ohne die würde
  // segmentStops() die Stille dazwischen selbst als durchgehenden Stand
  // werten (dieselbe Funklücken-Heuristik wie bei echten Übernachtungen,
  // api/lib.js) und es bliebe zu Recht bei einem einzigen Besuch.
  const fahrtStart = ersterBasis + 30 * 60_000;
  einfuegen([
    { at: fahrtStart, lat: 51.955, lon: 6.06, speed: 40 },
    { at: fahrtStart + 5 * 60_000, lat: 51.97, lon: 6.10, speed: 45 },
  ]);

  // Derselbe Ort, aber erst 6 Stunden nach dem ersten Stopp — ein echter,
  // eigenständiger zweiter Besuch, keine Fortsetzung.
  const zweiterBasis = ersterBasis + 6 * 3600_000;
  const punkte2 = [];
  for (let m = 0; m <= 25; m += 5) punkte2.push({ at: zweiterBasis + m * 60_000, lat: 51.95, lon: 6.05, speed: 0 });
  einfuegen(punkte2);
  const ergebnis = await fuehreAutoImportAus(KEIN_NETZ);
  assert.equal(ergebnis.erstellt, 1, "der zweite, spaete Besuch muss neu angelegt werden");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM besuche").get().n, 2);
});

test("ein sehr kurzer Stand (5 Minuten) wird gar nicht erfasst", async () => {
  const basis = zeitpunkt(2, 14, 0).getTime();
  einfuegen([
    { at: basis, lat: 51.95, lon: 6.05, speed: 0 },
    { at: basis + 5 * 60_000, lat: 51.95, lon: 6.05, speed: 0 },
  ]);

  const ergebnis = await fuehreAutoImportAus(KEIN_NETZ);
  assert.equal(ergebnis.erstellt, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM besuche").get().n, 0);
});

test("zweimaliger Durchlauf über dieselben Daten legt nichts doppelt an", async () => {
  const start = zeitpunkt(3, 22, 0);
  const ende = zeitpunkt(2, 7, 0);
  einfuegen([
    { at: start.getTime(), lat: 51.9, lon: 6.0, speed: 1 },
    { at: ende.getTime(), lat: 51.9001, lon: 6.0001, speed: 1 },
  ]);

  await fuehreAutoImportAus(KEIN_NETZ);
  const nachErstem = db.prepare("SELECT COUNT(*) n FROM besuche").get().n;
  assert.equal(nachErstem, 1);

  const zweiterDurchlauf = await fuehreAutoImportAus(KEIN_NETZ);
  assert.equal(zweiterDurchlauf.erstellt, 0, "beim zweiten Durchlauf darf nichts neu angelegt werden");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM besuche").get().n, nachErstem, "keine Dopplung");
});

test("ein verworfener Stopp (ignored_stops) wird nicht erneut vorgeschlagen", async () => {
  const start = zeitpunkt(3, 22, 0);
  const ende = zeitpunkt(2, 7, 0);
  einfuegen([
    { at: start.getTime(), lat: 51.9, lon: 6.0, speed: 1 },
    { at: ende.getTime(), lat: 51.9001, lon: 6.0001, speed: 1 },
  ]);
  db.prepare("INSERT INTO ignored_stops (stop_key) VALUES (?)").run(`${DEVICE}|${start.toISOString()}`);

  const ergebnis = await fuehreAutoImportAus(KEIN_NETZ);
  assert.equal(ergebnis.erstellt, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM besuche").get().n, 0);
});

test("eine länger werdende Übernachtung (zweiter Durchlauf, spätere Abreise) korrigiert die Nächte-Zahl statt zu duplizieren", async () => {
  const start = zeitpunkt(4, 22, 0);
  const erstesEnde = zeitpunkt(3, 7, 0); // eine Nacht
  einfuegen([
    { at: start.getTime(), lat: 51.9, lon: 6.0, speed: 1 },
    { at: erstesEnde.getTime(), lat: 51.9001, lon: 6.0001, speed: 1 },
  ]);
  await fuehreAutoImportAus(KEIN_NETZ);
  let besuch = besucheMitKategorie("uebernachtung")[0];
  assert.equal(besuch.nights, 1);

  // Tatsächlich noch eine weitere Nacht geblieben — derselbe stop_key
  // (gleicher Start), aber ein späteres, tatsächlich beobachtetes Ende.
  const zweitesEnde = zeitpunkt(2, 7, 0); // zwei Nächte
  einfuegen([{ at: zweitesEnde.getTime(), lat: 51.9002, lon: 6.0, speed: 1 }]);
  await fuehreAutoImportAus(KEIN_NETZ);

  const alle = besucheMitKategorie("uebernachtung");
  assert.equal(alle.length, 1, "keine zweite, eigenständige Übernachtung — derselbe Aufenthalt");
  assert.equal(alle[0].nights, 2);
});

/* ---------------- Offener Stand (28. September 2026) ---------------- */

const OFFEN = { geocode: KEIN_NETZ.geocode, wetter: KEIN_NETZ.wetter };

/** Zügige Anfahrt, dann Stille — die letzte Meldung kommt noch mit Tempo. */
function anfahrtUndStille(tageZurueck, stunde, minute) {
  const t = zeitpunkt(tageZurueck, stunde, minute).getTime();
  einfuegen([
    { at: t - 7 * 60_000, lat: 51.9, lon: 6.0, speed: 50 },
    { at: t, lat: 51.9005, lon: 6.0, speed: 40 },
  ]);
  return t;
}

test("Stille nach zügiger Anfahrt wird über Nacht als Übernachtung erkannt, ohne dass neue Daten kommen", async () => {
  anfahrtUndStille(2, 19, 47);
  const jetzt = zeitpunkt(1, 8, 0).getTime();

  const ergebnis = await fuehreAutoImportAus({ ...OFFEN, jetzt });
  assert.equal(ergebnis.erstellt, 1);
  const besuche = besucheMitKategorie("uebernachtung");
  assert.equal(besuche.length, 1);
  assert.equal(besuche[0].nights, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM auto_vorlaeufig").get().n, 1, "als vorläufig vermerkt");
});

test("Stille von nur 10 Minuten nach der letzten Meldung erzeugt noch nichts, nach 30 Minuten einen Stopp", async () => {
  const t = anfahrtUndStille(2, 14, 0);
  assert.equal((await fuehreAutoImportAus({ ...OFFEN, jetzt: t + 10 * 60_000 })).erstellt, 0);
  assert.equal((await fuehreAutoImportAus({ ...OFFEN, jetzt: t + 30 * 60_000 })).erstellt, 1);
  assert.equal(besucheMitKategorie("stopp").length, 1);
});

test("ein inaktives Fahrzeug bekommt keinen offenen Stand", async () => {
  db.prepare("UPDATE vehicles SET active = 0").run();
  anfahrtUndStille(2, 19, 47);
  const ergebnis = await fuehreAutoImportAus({ ...OFFEN, jetzt: zeitpunkt(1, 8, 0).getTime() });
  assert.equal(ergebnis.erstellt, 0);
});

test("nach mehr als 7 Tagen Stille wird nicht mehr von einem Dauerstand ausgegangen", async () => {
  const t = anfahrtUndStille(2, 19, 47);
  const ergebnis = await fuehreAutoImportAus({ ...OFFEN, jetzt: t + 8 * 86400_000 });
  assert.equal(ergebnis.erstellt, 0);
});

test("kommen später Daten, die den Stand bestätigen (Abfahrt am selben Fleck), bleibt der Eintrag und gilt nicht mehr als vorläufig", async () => {
  anfahrtUndStille(2, 19, 47);
  await fuehreAutoImportAus({ ...OFFEN, jetzt: zeitpunkt(1, 8, 0).getTime() });
  assert.equal(besucheMitKategorie("uebernachtung").length, 1);

  einfuegen([
    { at: zeitpunkt(1, 9, 0).getTime(), lat: 51.9007, lon: 6.0, speed: 15 }, // ~22 m entfernt, fährt los
    { at: zeitpunkt(1, 9, 2).getTime(), lat: 51.95, lon: 6.05, speed: 60 },
  ]);
  const ergebnis = await fuehreAutoImportAus({ ...OFFEN, jetzt: zeitpunkt(1, 9, 4).getTime() });
  assert.equal(ergebnis.entfernt, 0);
  assert.equal(besucheMitKategorie("uebernachtung").length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM auto_vorlaeufig").get().n, 0);
});

test("zeigen später eintreffende Daten, dass das Fahrzeug während der Stille weggefahren ist, wird der vorläufige Auto-Eintrag entfernt", async () => {
  anfahrtUndStille(2, 19, 47);
  await fuehreAutoImportAus({ ...OFFEN, jetzt: zeitpunkt(1, 8, 0).getTime() });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM besuche").get().n, 1);

  // Router war zwischendurch aus — die nachgelieferten Daten liegen kilometerweit weg.
  einfuegen([
    { at: zeitpunkt(1, 7, 0).getTime(), lat: 51.95, lon: 6.05, speed: 60 },
    { at: zeitpunkt(1, 7, 2).getTime(), lat: 51.96, lon: 6.06, speed: 60 },
  ]);
  const ergebnis = await fuehreAutoImportAus({ ...OFFEN, jetzt: zeitpunkt(1, 7, 4).getTime() });
  assert.equal(ergebnis.entfernt, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM besuche").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM orte").get().n, 0, "auch der nur dafür angelegte Ort");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM auto_vorlaeufig").get().n, 0);
});

test("ein vom Nutzer bearbeiteter vorläufiger Eintrag bleibt auch dann, wenn er widerlegt wird", async () => {
  anfahrtUndStille(2, 19, 47);
  await fuehreAutoImportAus({ ...OFFEN, jetzt: zeitpunkt(1, 8, 0).getTime() });
  db.prepare("UPDATE orte SET title = 'Mein Lieblingsplatz'").run();

  einfuegen([
    { at: zeitpunkt(1, 7, 0).getTime(), lat: 51.95, lon: 6.05, speed: 60 },
    { at: zeitpunkt(1, 7, 2).getTime(), lat: 51.96, lon: 6.06, speed: 60 },
  ]);
  const ergebnis = await fuehreAutoImportAus({ ...OFFEN, jetzt: zeitpunkt(1, 7, 4).getTime() });
  assert.equal(ergebnis.entfernt, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM besuche").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM auto_vorlaeufig").get().n, 0);
});

test("naechsterSchwellenzeitpunkt: nach 15 Uhr Stand ab 14 Uhr kommt die Übernachtung um Mitternacht", () => {
  const start = zeitpunkt(2, 14, 0);
  const t = new Date(naechsterSchwellenzeitpunkt(start.toISOString(), zeitpunkt(2, 15, 0).getTime()));
  assert.equal(t.getHours(), 0);
  assert.ok(t.getMinutes() <= 5);
});

test("naechsterSchwellenzeitpunkt: vor Ablauf von 20 Minuten ist der Stopp die nächste Schwelle", () => {
  const start = zeitpunkt(2, 14, 0);
  const t = naechsterSchwellenzeitpunkt(start.toISOString(), start.getTime() + 5 * 60_000);
  assert.ok(t >= start.getTime() + 20 * 60_000 && t <= start.getTime() + 25 * 60_000);
});

test("naechsterSchwellenzeitpunkt: bei laufender Übernachtung ist die nächste Mitternacht dran (Nächte-Zahl)", () => {
  const start = zeitpunkt(2, 22, 0);
  const jetzt = zeitpunkt(1, 8, 0).getTime();
  const t = new Date(naechsterSchwellenzeitpunkt(start.toISOString(), jetzt));
  assert.equal(t.getHours(), 0);
  assert.equal(t.getMinutes(), 0);
  assert.ok(t.getTime() > jetzt);
});

/* ---------------- Reiseende und Alltag (16. Oktober 2026) ---------------- */

/** Ankunft (zügig, dann Stand) um 18:45 vor `tage` Tagen und bis zum nächsten
 * Morgen 7 Uhr stehend — eine echte Nacht, falls nichts abschneidet. */
function ankunftUndNacht(tage = 3) {
  const an = zeitpunkt(tage, 18, 45).getTime();
  einfuegen([
    { at: an - 7 * 60_000, lat: -52.0, lon: 26.9, speed: 50 },
    { at: an, lat: -52.0005, lon: 26.9, speed: 1 },
    { at: zeitpunkt(tage - 1, 7, 0).getTime(), lat: -52.0005, lon: 26.9001, speed: 1 },
  ]);
  return an;
}

// Echter Fund: Ankunft zuhause 28 Minuten vor Reiseende wurde Übernachtung der
// Reise und wuchs auf 12 Nächte.
test("endet die Reise kurz nach der Ankunft, zählt nur der Teil in der Reise: Stopp statt Übernachtung", async () => {
  const an = ankunftUndNacht();
  db.prepare("UPDATE trips SET end_at = ? WHERE id = 't1'").run(new Date(an + 28 * 60_000).toISOString());

  const ergebnis = await fuehreAutoImportAus(KEIN_NETZ);
  assert.equal(ergebnis.erstellt, 1);
  assert.equal(besucheMitKategorie("uebernachtung").length, 0);
  const stopps = besucheMitKategorie("stopp");
  assert.equal(stopps.length, 1);
  assert.equal(stopps[0].nights, 1);
});

test("dieselbe Nacht innerhalb einer laufenden Reise bleibt eine Übernachtung", async () => {
  ankunftUndNacht();
  await fuehreAutoImportAus(KEIN_NETZ);
  assert.equal(besucheMitKategorie("uebernachtung").length, 1);
});

test("ohne Reise (Alltag) entsteht keine automatische Übernachtung", async () => {
  db.exec("DELETE FROM trips");
  ankunftUndNacht();

  const ergebnis = await fuehreAutoImportAus(KEIN_NETZ);
  assert.equal(ergebnis.erstellt, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM besuche").get().n, 0);
});

test("ein kurzer Stopp ohne Reise wird weiterhin angelegt", async () => {
  db.exec("DELETE FROM trips");
  const basis = zeitpunkt(2, 14, 0).getTime();
  const punkte = [];
  for (let m = 0; m <= 30; m += 5) punkte.push({ at: basis + m * 60_000, lat: 51.95, lon: 6.05, speed: 0 });
  einfuegen(punkte);

  const ergebnis = await fuehreAutoImportAus(KEIN_NETZ);
  assert.equal(ergebnis.erstellt, 1);
  assert.equal(besucheMitKategorie("stopp").length, 1);
});

test("ein offener Stand, der durch das Reiseende zum Alltag wird, verliert seinen vorläufigen Eintrag", async () => {
  const t = anfahrtUndStille(2, 19, 47);
  await fuehreAutoImportAus({ ...OFFEN, jetzt: zeitpunkt(1, 8, 0).getTime() });
  assert.equal(besucheMitKategorie("uebernachtung").length, 1);

  // Die Reise wird beendet, bevor der Stand zur Nacht wurde.
  db.prepare("UPDATE trips SET end_at = ? WHERE id = 't1'").run(new Date(t + 30 * 60_000).toISOString());
  const ergebnis = await fuehreAutoImportAus({ ...OFFEN, jetzt: zeitpunkt(1, 8, 5).getTime() });
  assert.equal(ergebnis.entfernt, 1);
  assert.equal(besucheMitKategorie("uebernachtung").length, 0);
  assert.equal(besucheMitKategorie("stopp").length, 1, "stattdessen der Stopp am Reiseende");
});
