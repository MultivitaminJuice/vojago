// Eigene Test-Datenbank, wie bei osmand.test.js. Nutzt handleOsmand als
// realistischen Eintrittspunkt (statt insertPosition+pruefeZonenwechsel
// direkt aufzurufen) — prüft damit auch die tatsächliche Verdrahtung in
// osmand.js, nicht nur die Logik in alarms.js isoliert.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

const TEST_DB = `/tmp/vojago-tracker-alarms-test-${Date.now()}.db`;
process.env.TRACKER_DB_PATH = TEST_DB;
process.env.TRACKER_ALLOWED_DEVICE_IDS = "d1";

let handleOsmand, db, pruefeZonenzustandNachRuhe;

before(async () => {
  ({ handleOsmand } = await import("./protocols/osmand.js"));
  ({ db } = await import("./store.js"));
  ({ pruefeZonenzustandNachRuhe } = await import("./alarms.js"));
});

after(() => {
  db.close();
  rmSync(TEST_DB, { force: true });
  rmSync(`${TEST_DB}-wal`, { force: true });
  rmSync(`${TEST_DB}-shm`, { force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM positions; DELETE FROM alarm_log; DELETE FROM geofences;");
  db.prepare("UPDATE alarm_settings SET enabled = 1 WHERE key = 'geofence'").run();
});

const anfrage = (deviceId, lat, lon, timestamp) =>
  handleOsmand(new Request(`http://localhost/?id=${deviceId}&lat=${lat}&lon=${lon}&timestamp=${timestamp}`));

// Simuliert, was api/router.js beim Scharfschalten schreibt (siehe dort,
// PATCH /api/alarms/geofence): genau ein Ankerpunkt, fester Datensatz.
const setzeAnker = (lat, lon, radiusM, aktiv = 1) =>
  db.prepare("INSERT OR REPLACE INTO geofences (id, name, lat, lon, radius_m, active) VALUES ('wache-aktuell','Wache',?,?,?,?)")
    .run(lat, lon, radiusM, aktiv);

// Ein Wechsel zählt erst, wenn der neue Zustand bei ZWEI aufeinanderfolgenden
// Positionen gilt (Entprellung, siehe alarms.js) — deshalb hier je drei Punkte.
test("Verlassen des überwachten Bereichs wird erkannt und protokolliert", async () => {
  setzeAnker(52.000, 7.000, 200); // ~200 m Radius
  await anfrage("d1", 52.000, 7.000, 1700000000); // innerhalb
  await anfrage("d1", 52.010, 7.000, 1700000060); // ~1,1 km entfernt -> draußen
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alarm_log").get().n, 0, "ein einzelner Punkt draußen löst noch nichts aus");
  await anfrage("d1", 52.011, 7.000, 1700000120); // weiterhin draußen -> bestätigt

  const eintraege = db.prepare("SELECT * FROM alarm_log").all();
  assert.equal(eintraege.length, 1);
  assert.equal(eintraege[0].type, "geofence");
  assert.equal(eintraege[0].severity, "warn");
  assert.match(eintraege[0].message, /verlassen/);
});

test("Rückkehr in den überwachten Bereich wird als informativer Eintrag protokolliert (severity ok)", async () => {
  setzeAnker(52.000, 7.000, 200);
  await anfrage("d1", 52.000, 7.000, 1700000000); // drin
  await anfrage("d1", 52.010, 7.000, 1700000060); // raus
  await anfrage("d1", 52.011, 7.000, 1700000120); // bleibt draußen -> "verlassen"
  await anfrage("d1", 52.000, 7.000, 1700000180); // rein
  await anfrage("d1", 52.0001, 7.000, 1700000240); // bleibt drin -> "wieder betreten"

  const eintraege = db.prepare("SELECT * FROM alarm_log ORDER BY id").all();
  assert.equal(eintraege.length, 2);
  assert.match(eintraege[0].message, /verlassen/);
  assert.equal(eintraege[1].severity, "ok");
  assert.match(eintraege[1].message, /betreten/);
});

test("Rückkehr ohne vorher gemeldetes Verlassen (z. B. nach neuem Scharfschalten) wird nicht gemeldet", async () => {
  setzeAnker(52.000, 7.000, 200);
  await anfrage("d1", 52.010, 7.000, 1700000000); // draußen
  await anfrage("d1", 52.000, 7.000, 1700000060); // rein
  await anfrage("d1", 52.0001, 7.000, 1700000120); // bleibt drin

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alarm_log").get().n, 0);
});

test("ein einzelner GPS-Ausreißer nach draußen (rein-raus-rein) löst keinen Alarm aus", async () => {
  setzeAnker(52.000, 7.000, 50);
  await anfrage("d1", 52.000, 7.000, 1700000000);
  await anfrage("d1", 52.010, 7.000, 1700000005); // Ausreißer
  await anfrage("d1", 52.000, 7.000, 1700000010);
  await anfrage("d1", 52.000, 7.000, 1700000015);

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alarm_log").get().n, 0);
});

// Echter Fund (28. September 2026): geprüft wurde bisher irgendeine aktive
// Zone (die älteste, "Zuhause"), nicht der beim Scharfschalten gesetzte Anker.
test("geprüft wird der Wache-Anker, nicht eine ältere, ebenfalls aktive Zone", async () => {
  // Alte Zone zuerst angelegt (kleinere rowid) — 5 km vom Wache-Anker entfernt.
  db.prepare("INSERT INTO geofences (id, name, lat, lon, radius_m, active) VALUES ('alt','Zuhause',52.05,7.0,50,1)").run();
  setzeAnker(52.000, 7.000, 200);
  // Bewegung relativ zum Wache-Anker: rein -> raus -> raus. Die alte Zone
  // "Zuhause" sieht dabei nie einen Wechsel (alle Punkte liegen außerhalb).
  await anfrage("d1", 52.000, 7.000, 1700000000);
  await anfrage("d1", 52.010, 7.000, 1700000060);
  await anfrage("d1", 52.011, 7.000, 1700000120);

  const eintraege = db.prepare("SELECT * FROM alarm_log").all();
  assert.equal(eintraege.length, 1);
  assert.match(eintraege[0].message, /verlassen/);
});

test("eine ältere aktive Zone allein löst keinen Alarm aus, wenn der Wache-Anker fehlt", async () => {
  db.prepare("INSERT INTO geofences (id, name, lat, lon, radius_m, active) VALUES ('alt','Zuhause',52.0,7.0,200,1)").run();
  await anfrage("d1", 52.000, 7.000, 1700000000);
  await anfrage("d1", 52.010, 7.000, 1700000060);
  await anfrage("d1", 52.011, 7.000, 1700000120);

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alarm_log").get().n, 0);
});

test("Bleiben innerhalb oder außerhalb erzeugt keinen Eintrag", async () => {
  setzeAnker(52.000, 7.000, 200);
  await anfrage("d1", 52.000, 7.000, 1700000000);
  await anfrage("d1", 52.0001, 7.0001, 1700000060); // minimale Bewegung, bleibt drinnen

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alarm_log").get().n, 0);
});

test("Erste Position eines Geräts erzeugt keinen Alarm (kein Vergleichspunkt)", async () => {
  setzeAnker(52.000, 7.000, 200);
  await anfrage("d1", 52.500, 7.500, 1700000000); // weit weg, aber erster Punkt überhaupt

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alarm_log").get().n, 0);
});

test("Deaktivierte geofence-Einstellung (Wache unscharf) unterdrückt jede Prüfung", async () => {
  setzeAnker(52.000, 7.000, 200);
  db.prepare("UPDATE alarm_settings SET enabled = 0 WHERE key = 'geofence'").run();
  await anfrage("d1", 52.000, 7.000, 1700000000);
  await anfrage("d1", 52.010, 7.000, 1700000060); // würde sonst als "verlassen" zählen
  await anfrage("d1", 52.011, 7.000, 1700000120);

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alarm_log").get().n, 0);
});

test("Kein Ankerpunkt (active=0) wird nicht geprüft", async () => {
  setzeAnker(52.000, 7.000, 200, 0);
  await anfrage("d1", 52.000, 7.000, 1700000000);
  await anfrage("d1", 52.010, 7.000, 1700000060);
  await anfrage("d1", 52.011, 7.000, 1700000120);

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alarm_log").get().n, 0);
});

test("occurred_at ist im datetime('now')-kompatiblen Format (Leerzeichen, kein T/Z)", async () => {
  setzeAnker(52.000, 7.000, 200);
  await anfrage("d1", 52.000, 7.000, 1700000000);
  await anfrage("d1", 52.010, 7.000, 1700000060);
  await anfrage("d1", 52.011, 7.000, 1700000120);

  const eintrag = db.prepare("SELECT occurred_at FROM alarm_log").get();
  assert.match(eintrag.occurred_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

// Echter Fund (11. Oktober 2026): der Router sendet bei verpasster Bestätigung
// ein Paket erneut — das Duplikat zählte als zweite Position draußen und
// bestätigte so ein Verlassen/Betreten, das es nicht gab.
test("dieselbe Position (Gerät + Fix-Zeit) wird nur einmal gespeichert und nicht als Bestätigung gewertet", async () => {
  setzeAnker(52.000, 7.000, 50);
  await anfrage("d1", 52.000, 7.000, 1700000000);
  await anfrage("d1", 52.000, 7.000, 1700000060);
  await anfrage("d1", 52.002, 7.000, 1700000120); // ~220 m draußen
  await anfrage("d1", 52.002, 7.000, 1700000120); // erneut gesendetes Duplikat

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM positions").get().n, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alarm_log").get().n, 0, "ein Duplikat ist keine zweite Position draußen");
  await anfrage("d1", 52.0021, 7.000, 1700000180); // echte zweite Position draußen
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alarm_log").get().n, 1);
});

test("Nachbarpositionen werden nach Fix-Zeit bestimmt, nicht nach Eintreffen", async () => {
  setzeAnker(52.000, 7.000, 50);
  await anfrage("d1", 52.000, 7.000, 1700000000); // drin
  await anfrage("d1", 52.002, 7.000, 1700000120); // draußen (t2) — vor t1 eingetroffen
  await anfrage("d1", 52.000, 7.000, 1700000060); // drin (t1), verspätet
  await anfrage("d1", 52.0021, 7.000, 1700000180); // draußen (t3)

  const eintraege = db.prepare("SELECT message FROM alarm_log").all();
  assert.equal(eintraege.length, 1);
  assert.match(eintraege[0].message, /verlassen/);
});

const protokolliere = (message) =>
  db.prepare("INSERT INTO alarm_log (type, severity, message) VALUES ('geofence','warn',?)").run(message);

// Echter Fund (10. Oktober 2026): Heimkehr, erste Position im Radius, danach
// Stille — die zweite zur Bestätigung kam nie, das Protokoll blieb auf "verlassen".
test("nach Stille gilt der Zustand der letzten Meldung: Rückkehr wird auch mit nur einer Position drinnen gemeldet", async () => {
  setzeAnker(52.000, 7.000, 50);
  protokolliere("Fahrzeug hat den überwachten Bereich verlassen");
  await anfrage("d1", 52.002, 7.000, 1700000000); // draußen
  await anfrage("d1", 52.000, 7.000, 1700000060); // erste Position drinnen — dann Stille

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alarm_log").get().n, 1, "ohne Stille noch nicht bestätigt");
  pruefeZonenzustandNachRuhe("d1");
  const eintraege = db.prepare("SELECT message FROM alarm_log ORDER BY id").all();
  assert.equal(eintraege.length, 2);
  assert.match(eintraege[1].message, /wieder betreten/);

  pruefeZonenzustandNachRuhe("d1"); // idempotent
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alarm_log").get().n, 2);
});

test("nach Stille wird 'verlassen' nur bei klar draußen liegender Position gemeldet (mehr als 1,5 × Radius)", async () => {
  setzeAnker(52.000, 7.000, 200);
  await anfrage("d1", 52.000, 7.000, 1700000000);
  await anfrage("d1", 52.0023, 7.000, 1700000060); // ~255 m: draußen, aber nicht klar (< 300 m)
  pruefeZonenzustandNachRuhe("d1");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alarm_log").get().n, 0);

  await anfrage("d1", 52.0035, 7.000, 1700000120); // ~390 m: klar draußen
  pruefeZonenzustandNachRuhe("d1");
  const eintraege = db.prepare("SELECT message FROM alarm_log").all();
  assert.equal(eintraege.length, 1);
  assert.match(eintraege[0].message, /verlassen/);
});

test("Stille-Prüfung bei unscharfer Wache oder ohne Position tut nichts", async () => {
  setzeAnker(52.000, 7.000, 50);
  pruefeZonenzustandNachRuhe("d1"); // keine Position
  db.prepare("UPDATE alarm_settings SET enabled = 0 WHERE key = 'geofence'").run();
  await anfrage("d1", 52.0035, 7.000, 1700000000);
  pruefeZonenzustandNachRuhe("d1");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alarm_log").get().n, 0);
});
