import test from "node:test";
import { webcrypto } from "node:crypto";
// In Cloudflare ist crypto global; Node stellt es erst ab Version 19 so bereit.
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import assert from "node:assert/strict";
import {
  corsHeaders, allowedOrigins, safeEqual,
  validateOrt, validateBesuch, validateTrip, validateRange, createRateLimiter, publicError,
  hashPassword, verifyPassword, newSessionToken, hashToken,
  sessionCookie, clearedSessionCookie, istHttps, readCookie, validateCredentials,
  validateNote, weatherText, weatherSymbol, pickHourIndex, validateCoords, benenneOrtAusGeocodeAntwort,
  isValidId, isHexColor, validateCategory, validateVehicle,
  isValidEmail, newResetToken, RESET_TOKEN_MINUTES, newVerifyToken, EMAIL_VERIFY_MINUTES,
  mapPositionRow, segmentDrives, segmentStops,
} from "../lib.js";
import { ladeFixture } from "./lade-fixture.js";

const req = (headers = {}) => new Request("https://api.example/api/places", { headers });

/* ---------------- Herkunft ---------------- */

test("Herkunft: erlaubte Liste wird zerlegt", () => {
  assert.deepEqual(allowedOrigins({ ALLOWED_ORIGINS: "https://a.example, https://b.example" }),
    ["https://a.example", "https://b.example"]);
  assert.deepEqual(allowedOrigins({}), []);
});

test("Herkunft: nur eingetragene Ursprünge bekommen Freigabe", () => {
  const env = { ALLOWED_ORIGINS: "https://app.example" };
  const erlaubt = corsHeaders(req({ origin: "https://app.example" }), env);
  assert.equal(erlaubt["access-control-allow-origin"], "https://app.example");

  const fremd = corsHeaders(req({ origin: "https://boese.example" }), env);
  assert.equal(fremd["access-control-allow-origin"], undefined);
});

test("Herkunft: ohne Konfiguration wird keine fremde Seite freigegeben", () => {
  const h = corsHeaders(req({ origin: "https://irgendwo.example" }), {});
  assert.equal(h["access-control-allow-origin"], undefined);
  assert.equal(h.vary, "origin");
});

/* ---------------- Zugang ---------------- */

test("Vergleich erkennt Gleichheit und Unterschiede", () => {
  assert.equal(safeEqual("geheim", "geheim"), true);
  assert.equal(safeEqual("geheim", "geheiM"), false);
  assert.equal(safeEqual("kurz", "viel-laenger"), false);
  assert.equal(safeEqual("", ""), true);
  assert.equal(safeEqual(undefined, ""), true);
});

/* ---------------- Eingaben ---------------- */

test("Ort: Koordinaten sind Pflicht und müssen im gültigen Bereich liegen", () => {
  assert.equal(validateOrt({ lat: 47.5, lon: 10.2 }).ok, true);
  assert.equal(validateOrt({ lat: 91, lon: 10 }).ok, false);
  assert.equal(validateOrt({ lat: 47, lon: 181 }).ok, false);
  assert.equal(validateOrt({ lat: "47", lon: 10 }).ok, false);
  assert.equal(validateOrt({}).ok, false);
});

test("Ort: Teiländerung erlaubt Weglassen, prüft aber Vorhandenes", () => {
  assert.equal(validateOrt({ title: "Neu" }, { partial: true }).ok, true);
  assert.equal(validateOrt({ lat: 999 }, { partial: true }).ok, false);
  assert.equal(validateOrt({ rating: 7 }, { partial: true }).ok, false);
  assert.equal(validateOrt({ rating: 4 }, { partial: true }).ok, true);
  assert.equal(validateOrt({ title: "x".repeat(201) }, { partial: true }).ok, false);
});

test("Ort: address ist optional, aber auch längenbegrenzt", () => {
  assert.equal(validateOrt({ address: "Musterviertel, Beispielstadt" }, { partial: true }).ok, true);
  assert.equal(validateOrt({ address: null }, { partial: true }).ok, true);
  assert.equal(validateOrt({ address: "x".repeat(201) }, { partial: true }).ok, false);
});

test("Besuch: ort_id ist Pflicht, source wird geprüft", () => {
  assert.equal(validateBesuch({ ort_id: "ort_1" }).ok, true);
  assert.equal(validateBesuch({}).ok, false);
  assert.equal(validateBesuch({ ort_id: "ort_1", source: "satellit" }).ok, false);
  assert.equal(validateBesuch({ ort_id: "ort_1" }, { partial: true }).ok, true);
});

test("Besuch: Anzahl Nächte und Stopp-Kennung werden geprüft", () => {
  assert.equal(validateBesuch({ ort_id: "ort_1", nights: 3 }).ok, true);
  assert.equal(validateBesuch({ ort_id: "ort_1", nights: 0 }).ok, false);
  assert.equal(validateBesuch({ ort_id: "ort_1", nights: 61 }).ok, false);
  assert.equal(validateBesuch({ ort_id: "ort_1", nights: 1.5 }).ok, false);
  assert.equal(validateBesuch({ ort_id: "ort_1", stop_key: "1|2026-08-01T00:00:00Z" }).ok, true);
  assert.equal(validateBesuch({ ort_id: "ort_1", stop_key: "x".repeat(201) }).ok, false);
});

test("Reise: Datumsangaben und Reihenfolge werden geprüft", () => {
  assert.equal(validateTrip({ name: "Alpen", start_at: "2026-07-12T08:00:00Z" }).ok, true);
  assert.equal(validateTrip({ start_at: "gestern" }).ok, false);
  assert.equal(validateTrip({ start_at: "2026-07-12", end_at: "2026-07-01" }).ok, false);
  assert.equal(validateTrip({ name: "x".repeat(121) }).ok, false);
});

test("Zeitraum: from/to müssen gültig und in Reihenfolge sein", () => {
  assert.equal(validateRange("2026-07-01", "2026-07-05").ok, true);
  assert.equal(validateRange(null, "2026-07-05").ok, false);
  assert.equal(validateRange("2026-07-05", "2026-07-01").ok, false);
});

/* ---------------- Lastbegrenzung ---------------- */

test("Lastbegrenzung greift nach dem Limit und erholt sich im nächsten Fenster", () => {
  let jetzt = 0;
  const take = createRateLimiter({ limit: 3, windowMs: 1000, now: () => jetzt });

  assert.equal(take("a").ok, true);
  assert.equal(take("a").ok, true);
  assert.equal(take("a").ok, true);
  const blockiert = take("a");
  assert.equal(blockiert.ok, false);
  assert.ok(blockiert.retryAfter > 0);

  // anderer Aufrufer bleibt unberührt
  assert.equal(take("b").ok, true);

  jetzt += 1001;
  assert.equal(take("a").ok, true);
});

/* ---------------- Fehler nach außen ---------------- */

test("Fehlermeldungen verraten nach außen keine Interna", () => {
  const err = new Error("Traccar 500 bei http://10.8.0.1:8082/api/server");
  assert.deepEqual(publicError(err, {}), { error: "Verarbeitung fehlgeschlagen" });
  assert.equal(publicError(err, { DEBUG: "true" }).detail.includes("10.8.0.1"), true);
});

/* ---------------- Anmeldung ---------------- */

test("Passwort: derselbe Klartext prüft erfolgreich, ein anderer nicht", async () => {
  // Wenige Runden, damit der Test schnell bleibt.
  const gespeichert = await hashPassword("Geheim-Passwort", 1000);
  assert.match(gespeichert, /^pbkdf2\$1000\$/);
  assert.equal(await verifyPassword("Geheim-Passwort", gespeichert), true);
  assert.equal(await verifyPassword("Geheim-Passwor", gespeichert), false);
  assert.equal(await verifyPassword("", gespeichert), false);
});

test("Passwort: gleiches Passwort ergibt dank Salz verschiedene Werte", async () => {
  const a = await hashPassword("gleich", 1000);
  const b = await hashPassword("gleich", 1000);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("gleich", a), true);
  assert.equal(await verifyPassword("gleich", b), true);
});

test("Passwort: unbrauchbar gespeicherte Werte werden abgelehnt", async () => {
  for (const wert of ["", "kaputt", "pbkdf2$1$x$y", "md5$1000$a$b", null]) {
    assert.equal(await verifyPassword("egal", wert), false);
  }
});

test("Sitzung: Schlüssel ist zufällig, in der Ablage steht nur der Abdruck", async () => {
  const a = newSessionToken(), b = newSessionToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40);
  assert.match(a, /^[A-Za-z0-9_-]+$/); // sicher in einem Cookie
  const abdruck = await hashToken(a);
  assert.notEqual(abdruck, a);
  assert.equal(abdruck, await hashToken(a));
});

test("Cookie: gesetzt mit Schutzmerkmalen, gelöscht mit Ablauf null", () => {
  const gesetzt = sessionCookie("abc");
  for (const merkmal of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) {
    assert.ok(gesetzt.includes(merkmal), merkmal + " fehlt");
  }
  assert.ok(clearedSessionCookie().includes("Max-Age=0"));
});

test("Cookie: Secure fehlt ausdrücklich bei secure:false — sonst weigert sich der Browser über HTTP, es zu senden (RFC 6265)", () => {
  assert.ok(sessionCookie("abc", { secure: false }).includes("HttpOnly"));
  assert.ok(!sessionCookie("abc", { secure: false }).includes("Secure"));
  assert.ok(sessionCookie("abc").includes("Secure")); // Vorgabe bleibt sicher (Cloudflare-Betrieb)
  assert.ok(!clearedSessionCookie(false).includes("Secure"));
  assert.ok(clearedSessionCookie(true).includes("Secure"));
});

test("istHttps: erkennt https-URL und x-forwarded-proto, plain http nicht", () => {
  assert.equal(istHttps(new Request("https://vojago.test/api/auth/me")), true);
  assert.equal(istHttps(new Request("http://192.168.1.1:8081/api/auth/me")), false);
  assert.equal(
    istHttps(new Request("http://vojago.test/api/auth/me", { headers: { "x-forwarded-proto": "https" } })),
    true
  );
});

test("Cookie lesen: findet den eigenen Wert zwischen anderen", () => {
  const req = new Request("https://x.example", { headers: { cookie: "a=1; vojago_session=xyz; b=2" } });
  assert.equal(readCookie(req, "vojago_session"), "xyz");
  assert.equal(readCookie(req, "fehlt"), null);
  assert.equal(readCookie(new Request("https://x.example"), "vojago_session"), null);
});

test("Zugangsdaten: Benutzername und Mindestlänge werden geprüft", () => {
  assert.equal(validateCredentials({ username: "dirk", password: "x" }).ok, true);
  assert.equal(validateCredentials({ username: "ab", password: "x" }).ok, false);
  assert.equal(validateCredentials({ username: "dirk", password: "kurz" }, { neu: true }).ok, false);
  assert.equal(validateCredentials({ username: "dirk", password: "langgenug1" }, { neu: true }).ok, true);
  assert.equal(validateCredentials({ username: "x".repeat(61), password: "langgenug1" }, { neu: true }).ok, false);
});

test("Passwort: Verkettung mehrerer Blöcke bleibt nachvollziehbar", async () => {
  // Mehr als 100.000 Runden werden in Blöcke zerlegt — das Ergebnis muss
  // trotzdem eindeutig und prüfbar sein.
  const gespeichert = await hashPassword("Langes-Testpasswort", 150000);
  assert.match(gespeichert, /^pbkdf2\$150000\$/);
  assert.equal(await verifyPassword("Langes-Testpasswort", gespeichert), true);
  assert.equal(await verifyPassword("anderes", gespeichert), false);
  // Andere Rundenzahl ergibt einen anderen Wert
  const wenigerRunden = await hashPassword("Langes-Testpasswort", 1000);
  assert.notEqual(gespeichert.split("$")[3], wenigerRunden.split("$")[3]);
});

/* ---------------- Notizen ---------------- */

test("Notiz: Titel und Text sind Pflicht, Grenzen werden geprüft", () => {
  assert.equal(validateNote({ title: "Kaffee", text: "Schöner Platz" }).ok, true);
  assert.equal(validateNote({ title: "   ", text: "Schöner Platz" }).ok, false, "nur Leerzeichen ist kein Titel");
  assert.equal(validateNote({ title: "x".repeat(161), text: "Schöner Platz" }).ok, false);
  assert.equal(validateNote({ title: "Kaffee", text: "   " }).ok, false, "nur Leerzeichen ist kein Text");
  assert.equal(validateNote({}).ok, false);
  assert.equal(validateNote({ title: "Kaffee", text: "x".repeat(8001) }).ok, false);
  assert.equal(validateNote({ title: "Kaffee", text: "ok", lat: 91 }).ok, false);
  assert.equal(validateNote({ title: "Kaffee", text: "ok", lon: -181 }).ok, false);
  assert.equal(validateNote({ title: "Kaffee", text: "ok", lat: 52.1, lon: 7.3 }).ok, true);
  assert.equal(validateNote({ title: "Kaffee", text: "ok", source: "auto" }).ok, false);
  // Beim Ändern dürfen Titel und Text fehlen, andere Felder werden trotzdem geprüft.
  assert.equal(validateNote({ placeId: "p1" }, { partial: true }).ok, true);
  assert.equal(validateNote({ lat: 999 }, { partial: true }).ok, false);
});

/* ---------------- Passwort per E-Mail zurücksetzen (N11) ---------------- */

test("E-Mail-Prüfung: gültige und ungültige Formate", () => {
  assert.equal(isValidEmail("a@b.de"), true);
  assert.equal(isValidEmail("vorname.nachname@example.com"), true);
  assert.equal(isValidEmail("keine-email"), false);
  assert.equal(isValidEmail("@fehlt-vorne.de"), false);
  assert.equal(isValidEmail("fehlt-hinten@"), false);
  assert.equal(isValidEmail("mit leerzeichen@example.com"), false);
  assert.equal(isValidEmail(""), false);
  assert.equal(isValidEmail(null), false);
  assert.equal(isValidEmail(undefined), false);
  assert.equal(isValidEmail(`${"a".repeat(200)}@b.de`), false, "über 200 Zeichen ist zu lang");
});

test("Reset-Schlüssel: zufällig und ohne Wiederholung", () => {
  const a = newResetToken();
  const b = newResetToken();
  assert.equal(typeof a, "string");
  assert.ok(a.length >= 20, "Schlüssel sollte nicht zu kurz sein");
  assert.notEqual(a, b, "zwei Schlüssel hintereinander müssen verschieden sein");
});

test("Reset-Link läuft nach kurzer Zeit ab", () => {
  assert.equal(RESET_TOKEN_MINUTES, 30);
});

test("Bestätigungs-Schlüssel: zufällig, Link länger gültig als der Reset-Link", () => {
  const a = newVerifyToken();
  const b = newVerifyToken();
  assert.equal(typeof a, "string");
  assert.ok(a.length >= 20, "Schlüssel sollte nicht zu kurz sein");
  assert.notEqual(a, b, "zwei Schlüssel hintereinander müssen verschieden sein");
  assert.ok(EMAIL_VERIFY_MINUTES > RESET_TOKEN_MINUTES, "Bestätigung darf länger warten als ein Reset");
});

/* ---------------- Wetter ---------------- */

test("Wetter: WMO-Codes werden in Worte und Zeichen übersetzt", () => {
  assert.equal(weatherText(0), "klar");
  assert.equal(weatherText(3), "bedeckt");
  assert.equal(weatherText(63), "Regen");
  assert.equal(weatherText(96), "Gewitter mit Hagel");
  assert.equal(weatherText(7777), "unbekannt");
  assert.equal(weatherSymbol(0), "☀️");
  assert.equal(weatherSymbol(95), "⛈️");
  assert.equal(weatherSymbol(7777), "🌡️");
});

test("Wetter: die passende Stunde wird gefunden", () => {
  const zeiten = ["2026-08-09T10:00", "2026-08-09T11:00", "2026-08-09T12:00"];
  assert.equal(pickHourIndex(zeiten, "2026-08-09T11:20:00Z"), 1);
  assert.equal(pickHourIndex(zeiten, "2026-08-09T09:40:00Z"), 0);
  assert.equal(pickHourIndex(zeiten, "2026-08-09T12:29:00Z"), 2);
  // Weit daneben liefert keine Aussage
  assert.equal(pickHourIndex(zeiten, "2026-08-11T12:00:00Z"), -1);
  assert.equal(pickHourIndex([], "2026-08-09T11:00:00Z"), -1);
  assert.equal(pickHourIndex(zeiten, "keine Zeit"), -1);
});

// Nutzer-Fund, 6. September 2026: automatisch erkannte Übernachtungen
// hießen mangels Adresse immer nur "Übernachtung"/"Aktuelle
// Übernachtung"/"Stopp" — ein Namensvorschlag per Reverse-Geocoding soll
// dort einen brauchbaren Vorschlag liefern (weiter änderbar im Editor).
test("Ortsname: ein echter POI-Name hat Vorrang vor der Adresse", () => {
  const antwort = { name: "Camping de Mars", address: { town: "Rees", suburb: "Millingen" } };
  assert.equal(benenneOrtAusGeocodeAntwort(antwort), "Camping de Mars, Rees");
});

test("Ortsname: ohne POI-Namen wird der kleinste sinnvolle Ortsteil verwendet", () => {
  // Realer Fund: ein unbenannter Parkplatz an der Parkallee, Musterviertel
  const antwort = {
    name: "",
    address: { suburb: "Musterviertel", town: "Beispielstadt", road: "Parkallee", house_number: "3" },
  };
  assert.equal(benenneOrtAusGeocodeAntwort(antwort), "Musterviertel, Beispielstadt");
});

test("Ortsname: ein echter Straßenname bekommt das Dorf angehängt, auch wenn es nur 'village' heißt", () => {
  // Realer Fund: ein Radweg "Feldweg" bei Beispieldorf — Beispieldorf führt in
  // Nominatim nur als "village"/"city_district", nie als "town"/"city",
  // blieb also ganz ohne Ortsangabe stehen.
  const antwort = {
    name: "Feldweg",
    address: { village: "Beispieldorf", city_district: "Beispieldorf", county: "Kreis Beispiel" },
  };
  assert.equal(benenneOrtAusGeocodeAntwort(antwort), "Feldweg, Beispieldorf");
});

test("Ortsname: Ortsteil und Stadt identisch — kein doppeltes Anhängen", () => {
  const antwort = { name: null, address: { city: "Duisburg" } };
  assert.equal(benenneOrtAusGeocodeAntwort(antwort), "Duisburg");
});

test("Ortsname: gar nichts Brauchbares liefert null statt einem leeren Titel", () => {
  assert.equal(benenneOrtAusGeocodeAntwort({ address: {} }), null);
  assert.equal(benenneOrtAusGeocodeAntwort(null), null);
  assert.equal(benenneOrtAusGeocodeAntwort({}), null);
});

/* ---------------- Kategorien, Fahrzeuge, IDs (W7) ---------------- */

test("ID: nur Buchstaben/Ziffern/-/_ in vernünftiger Länge", () => {
  assert.equal(isValidId("place_msmv4qhd0"), true);
  assert.equal(isValidId("aac93fbd-63a9-4dd8-8583-e84c5f3c5cef"), true);
  assert.equal(isValidId(""), false);
  assert.equal(isValidId("hat leerzeichen"), false);
  assert.equal(isValidId("<script>"), false);
  assert.equal(isValidId("a".repeat(101)), false);
  assert.equal(isValidId(42), false);
});

test("Farbe: nur gültige Hex-Werte werden angenommen", () => {
  assert.equal(isHexColor("#e8802b"), true);
  assert.equal(isHexColor("#fff"), true);
  assert.equal(isHexColor("#ffffffff"), true);
  assert.equal(isHexColor("red"), false);
  assert.equal(isHexColor("#ggg"), false);
  assert.equal(isHexColor("javascript:alert(1)"), false);
  assert.equal(isHexColor(""), false);
});

test("Kategorie: Name ist Pflicht, Farbe und Sortierung werden geprüft", () => {
  assert.equal(validateCategory({ name: "Stellplatz" }).ok, true);
  assert.equal(validateCategory({ name: "  " }).ok, false, "nur Leerzeichen ist kein Name");
  assert.equal(validateCategory({}).ok, false);
  assert.equal(validateCategory({ name: "x".repeat(61) }).ok, false);
  assert.equal(validateCategory({ name: "Ok", color: "#e8802b" }).ok, true);
  assert.equal(validateCategory({ name: "Ok", color: "nicht-hex" }).ok, false);
  assert.equal(validateCategory({ name: "Ok", sort: 5 }).ok, true);
  assert.equal(validateCategory({ name: "Ok", sort: 1.5 }).ok, false);
  assert.equal(validateCategory({ name: "Ok", sort: 5000 }).ok, false);
  assert.equal(validateCategory({ name: "Ok", id: "eigene-kategorie" }).ok, true);
  assert.equal(validateCategory({ name: "Ok", id: "../../../etc" }).ok, false);
  // Teiländerung erlaubt Weglassen von name
  assert.equal(validateCategory({ color: "#000000" }, { partial: true }).ok, true);
  assert.equal(validateCategory({ color: "keinehex" }, { partial: true }).ok, false);
});

test("Fahrzeug: Name ist Pflicht, Geräte-ID und Aktiv-Status werden geprüft", () => {
  assert.equal(validateVehicle({ name: "Testmobil" }).ok, true);
  assert.equal(validateVehicle({ name: "" }).ok, false);
  assert.equal(validateVehicle({ name: "x".repeat(81) }).ok, false);
  assert.equal(validateVehicle({ name: "Testmobil", traccar_device_id: "12" }).ok, true);
  assert.equal(validateVehicle({ name: "Testmobil", traccar_device_id: 12 }).ok, true);
  assert.equal(validateVehicle({ name: "Testmobil", traccar_device_id: "x".repeat(61) }).ok, false);
  assert.equal(validateVehicle({ name: "Testmobil", active: true }).ok, true);
  assert.equal(validateVehicle({ name: "Testmobil", active: "ja" }).ok, false);
  assert.equal(validateVehicle({ name: "Testmobil", id: "fahrzeug_1" }).ok, true);
  assert.equal(validateVehicle({ name: "Testmobil", id: "bad id!" }).ok, false);
  assert.equal(validateVehicle({ traccar_device_id: "9" }, { partial: true }).ok, true);
});

test("Besuch: kind wird auf auto/manual begrenzt, id wird beim Anlegen geprüft", () => {
  assert.equal(validateBesuch({ ort_id: "ort_1", kind: "auto" }).ok, true);
  assert.equal(validateBesuch({ ort_id: "ort_1", kind: "manual" }).ok, true);
  assert.equal(validateBesuch({ ort_id: "ort_1", kind: "loeschen; DROP TABLE besuche" }).ok, false);
  assert.equal(validateBesuch({ ort_id: "ort_1", id: "besuch_msmv4qhd0" }).ok, true);
  assert.equal(validateBesuch({ ort_id: "ort_1", id: "../../etc/passwd" }).ok, false);
  // Beim Ändern wird eine mitgeschickte id nicht erneut geprüft (sie steht schon in der URL)
  assert.equal(validateBesuch({ id: "egal was hier steht" }, { partial: true }).ok, true);
});

test("Reise: vehicle_id und id werden auf gültige Kennungen begrenzt", () => {
  assert.equal(validateTrip({ name: "Alpen", vehicle_id: "fahrzeug_1" }).ok, true);
  assert.equal(validateTrip({ name: "Alpen", vehicle_id: "bad id!" }).ok, false);
  assert.equal(validateTrip({ name: "Alpen", id: "reise_1" }).ok, true);
  assert.equal(validateTrip({ name: "Alpen", id: "bad id!" }).ok, false);
});

test("Wetter: Koordinaten werden geprüft", () => {
  assert.equal(validateCoords("52.1", "7.3").ok, true);
  assert.equal(validateCoords("52.1", "7.3").lat, 52.1);
  assert.equal(validateCoords(null, "7.3").ok, false);
  assert.equal(validateCoords("91", "7.3").ok, false);
  assert.equal(validateCoords("52.1", "181").ok, false);
});

/* ---------------- Eigene Positionsquelle (Phase 2) ---------------- */

test("mapPositionRow: positions-Zeile wird traccar-förmig, km/h wird zu Knoten", () => {
  const row = { device_id: "abc", at: Date.UTC(2026, 7, 16, 10, 0, 0), lat: 52.1, lon: 7.3, altitude: 42, speed_kmh: 18.52, course: 90 };
  const p = mapPositionRow(row);
  assert.equal(p.deviceId, "abc");
  assert.equal(p.latitude, 52.1);
  assert.equal(p.longitude, 7.3);
  assert.equal(p.altitude, 42);
  assert.ok(Math.abs(p.speed - 10) < 1e-9); // 18.52 km/h == 10 kn
  assert.equal(p.course, 90);
  assert.equal(p.fixTime, new Date(row.at).toISOString());
  assert.equal(p.deviceTime, p.fixTime);
});

test("mapPositionRow: fehlende Höhe/Kurs/Geschwindigkeit werden zu sinnvollen Vorgaben", () => {
  const p = mapPositionRow({ device_id: "abc", at: Date.now(), lat: 1, lon: 2 });
  assert.equal(p.altitude, 0);
  assert.equal(p.course, 0);
  assert.equal(p.speed, 0);
});

// Gemeinsame Testspur: steht (2 Punkte) -> bewegt (3 Punkte) -> steht (2
// Punkte) -> große Lücke (>120 Min, zählt für keins von beidem).
function testSpur() {
  const t0 = Date.UTC(2026, 7, 16, 10, 0, 0);
  const min = 60_000;
  return [
    { device_id: "d1", at: t0, lat: 52.000, lon: 7.000, speed_kmh: 0 },
    { device_id: "d1", at: t0 + 5 * min, lat: 52.0001, lon: 7.0001, speed_kmh: 0 },
    { device_id: "d1", at: t0 + 10 * min, lat: 52.001, lon: 7.001, speed_kmh: 40 },
    { device_id: "d1", at: t0 + 15 * min, lat: 52.010, lon: 7.010, speed_kmh: 45 },
    { device_id: "d1", at: t0 + 20 * min, lat: 52.020, lon: 7.020, speed_kmh: 0 },
    { device_id: "d1", at: t0 + 25 * min, lat: 52.0201, lon: 7.0201, speed_kmh: 0 },
    { device_id: "d1", at: t0 + 400 * min, lat: 53.000, lon: 8.000, speed_kmh: 50 },
  ];
}

test("segmentDrives: erkennt genau eine durchgehende Fahrt, Lücke zählt nicht mit", () => {
  const drives = segmentDrives(testSpur());
  assert.equal(drives.length, 1);
  const d = drives[0];
  assert.equal(d.startTime, new Date(Date.UTC(2026, 7, 16, 10, 5, 0)).toISOString());
  assert.equal(d.endTime, new Date(Date.UTC(2026, 7, 16, 10, 20, 0)).toISOString());
  assert.equal(d.duration, 15 * 60_000);
  assert.ok(d.distance > 0);
  assert.ok(d.averageSpeed > 0);
  assert.ok(d.maxSpeed > 0);
  assert.equal(d.startLat, 52.0001);
  assert.equal(d.startLon, 7.0001);
});

test("segmentStops: erkennt zwei getrennte Stopps, keinen über die Lücke hinweg", () => {
  const stops = segmentStops(testSpur());
  assert.equal(stops.length, 2);
  assert.equal(stops[0].startTime, new Date(Date.UTC(2026, 7, 16, 10, 0, 0)).toISOString());
  assert.equal(stops[0].endTime, new Date(Date.UTC(2026, 7, 16, 10, 5, 0)).toISOString());
  assert.equal(stops[0].duration, 5 * 60_000);
  assert.ok(Math.abs(stops[0].lat - 52.00005) < 1e-3);
  assert.equal(stops[1].startTime, new Date(Date.UTC(2026, 7, 16, 10, 20, 0)).toISOString());
  assert.equal(stops[1].endTime, new Date(Date.UTC(2026, 7, 16, 10, 25, 0)).toISOString());
});

test("segmentDrives/segmentStops: weniger als zwei Punkte ergibt keine Segmente", () => {
  assert.deepEqual(segmentDrives([]), []);
  assert.deepEqual(segmentDrives([{ device_id: "d1", at: Date.now(), lat: 1, lon: 1, speed_kmh: 20 }]), []);
  assert.deepEqual(segmentStops([{ device_id: "d1", at: Date.now(), lat: 1, lon: 1, speed_kmh: 0 }]), []);
});

// Echte Positionsdaten (RUTX50/Handy, Koordinaten verschoben):
// zwei Spaziergänge (Gehtempo knapp um die 5-km/h-Schwelle) und zwei echte
// Autofahrten, dazwischen lange, ruhende Standzeiten mit dem üblichen
// GPS-Rauschen. Direkt von der laufenden Produktivdatenbank gezogen —
// kein nachgebauter, sondern der Datensatz,
// an dem klassifiziereKanten()/fensterBewegt() tatsächlich dreimal
// nachgebessert werden musste (Zerstückelung, dann komplettes Verschwinden
// eines Spaziergangs, dann stundenlange Geister-"Fahrten" durch einzelne
// GPS-Ausreißer im Stand — siehe Kopfkommentar von fensterBewegt()).
function echteSpaziergaengeUndFahrten() {
  const rows = ladeFixture("echte-spaziergaenge-17-08-2026");
  return rows.map((r) => ({ ...r, device_id: "d1" }));
}

test("segmentDrives: echte Daten ergeben plausible Fahrten, keine Zerstückelung und keine stundenlangen Geister-Fahrten", () => {
  const drives = segmentDrives(echteSpaziergaengeUndFahrten());
  // Von vorher zwei fehlerhaften Zwischenständen klar abgegrenzt: nicht
  // die 6 Mini-Fragmente eines rohen Ausreißer-Schwellwerts, nicht 0 (der
  // zweite Spaziergang verschwand mit der ersten Glättungs-Fassung
  // komplett), nicht 14-20 (Geister-Fahrten durch einzelne GPS-Ausreißer
  // im Stand, siehe fensterBewegt()).
  assert.equal(drives.length, 12);
  // Keine Fahrt darf eine Stunde+ bei nur ein paar hundert Metern dauern
  // (genau das Symptom der Geister-Fahrten durch GPS-Ausreißer im Stand).
  for (const d of drives) {
    const kmh = (d.distance / 1000) / (d.duration / 3600_000);
    assert.ok(d.duration < 3_000_000 || kmh > 2, `Fahrt ${d.startTime}–${d.endTime}: ${d.distance} m in ${Math.round(d.duration / 60000)} min sieht nach Stillstand mit GPS-Rauschen aus, nicht nach einer Fahrt`);
  }
  // Die zweite, tatsächlich abgefragte echte Autofahrt (bis 101,9 km/h,
  // über eine Stunde durchgehend, ~7,5 km) muss klar erkennbar sein.
  const langeFahrt = drives.find((d) => d.distance > 5000);
  assert.ok(langeFahrt, "die lange echte Autofahrt (~7,5 km) fehlt");
  assert.ok(langeFahrt.maxSpeed * 1.852 > 90, "hohe Geschwindigkeit der echten Autofahrt muss erhalten bleiben");
});

test("segmentStops: echte Daten — keine stundenlange Standzeit wird fälschlich als Fahrt gezählt", () => {
  const stops = segmentStops(echteSpaziergaengeUndFahrten());
  // Die zwei langen, echten Standzeiten (vormittags ~80 Minuten, danach
  // ~44 Minuten) müssen als Stopp erscheinen, nicht als Geister-Fahrt.
  const langeStopps = stops.filter((s) => s.duration > 40 * 60_000);
  assert.ok(langeStopps.length >= 2, "die beiden langen echten Standzeiten fehlen als Stopp");
});

// Echter Fund (1. September 2026): eine ~11-stündige Übernachtung wurde nie
// als Übernachtung erkannt — dazwischen liegt eine gut 10-stündige
// Funklücke (18:29–5:16 Uhr), Geschwindigkeit 0 auf beiden Seiten,
// praktisch derselbe Fleck. Zum Vergleich in derselben Aufzeichnung: eine
// gut 3-stündige Tageslücke (14:10–17:16 Uhr), bei der sich das Fahrzeug
// zwischen den Rändern tatsächlich ~370 m fortbewegt hat — die MUSS
// weiterhin "unbekannt" bleiben, nicht automatisch als Stand durchgehen.
function echteUebernachtungMitFunkluecke() {
  const rows = ladeFixture("echte-uebernachtung-mit-funkluecke-31-08-2026");
  return rows.map((r) => ({ ...r, device_id: "d1" }));
}

test("segmentStops: eine lange Funklücke mit Geschwindigkeit 0 auf beiden Seiten zählt als Übernachtung", () => {
  const stops = segmentStops(echteUebernachtungMitFunkluecke());
  const uebernachtung = stops.find((s) => s.duration > 9 * 3600_000);
  assert.ok(uebernachtung, "die ~11-stündige Übernachtung über die Funklücke hinweg fehlt");
  assert.equal(uebernachtung.startTime, "2026-08-31T18:29:06.000Z");
  assert.equal(uebernachtung.endTime, "2026-09-01T05:16:47.000Z");
});

test("segmentStops: eine Datenlücke mit echter Ortsveränderung an den Rändern bleibt unbekannt, nicht Stand", () => {
  const stops = segmentStops(echteUebernachtungMitFunkluecke());
  const drives = segmentDrives(echteUebernachtungMitFunkluecke());
  // Weder als Stopp noch als Fahrt darf die 3-stündige Tageslücke
  // (14:10:45–17:16:32 Uhr) durchgehend auftauchen — sie bleibt "luecke".
  const alsStoppDurchgerutscht = stops.some((s) => Date.parse(s.startTime) <= Date.parse("2026-08-31T14:10:45.000Z")
    && Date.parse(s.endTime) >= Date.parse("2026-08-31T17:16:32.000Z"));
  assert.ok(!alsStoppDurchgerutscht, "die Tageslücke mit echter Ortsveränderung wurde fälschlich als durchgehender Stand gewertet");
  const alsFahrtDurchgerutscht = drives.some((d) => Date.parse(d.startTime) <= Date.parse("2026-08-31T14:10:45.000Z")
    && Date.parse(d.endTime) >= Date.parse("2026-08-31T17:16:32.000Z"));
  assert.ok(!alsFahrtDurchgerutscht, "die Tageslücke wurde fälschlich als durchgehende Fahrt gewertet");
});

// Echter Fund (6. September 2026): ein rund zweistündiger Stopp auf einer Landstraße fehlte komplett — die Lücke war 120,33
// Minuten (knapp über MAX_LUECKE_MINUTEN=120) und die Randgeschwindigkeit
// auf einer Seite lag exakt bei 2 km/h, dem Schwellenwert selbst. Ein
// striktes "<" schließt die Schwelle aus, sollte sie aber einschließen.
test("segmentStops: eine Funklücke mit Randgeschwindigkeit GENAU an der Schwelle zählt noch als Stand", () => {
  const start = Date.parse("2026-09-06T07:34:08.000Z");
  const ende = Date.parse("2026-09-06T09:34:28.000Z"); // 120,33 Minuten Lücke
  const rows = [
    { device_id: "d1", at: start, lat: -51.83811, lon: 26.69669, speed_kmh: 2 },
    { device_id: "d1", at: ende, lat: -51.83809, lon: 26.69663, speed_kmh: 1 },
  ];
  const stops = segmentStops(rows);
  assert.equal(stops.length, 1, "die Lücke mit Randgeschwindigkeit genau an der Schwelle muss als Stand zählen");
  assert.equal(stops[0].startTime, new Date(start).toISOString());
  assert.equal(stops[0].endTime, new Date(ende).toISOString());
});

// Echter Fund (27. September 2026): zwei aufeinanderfolgende Übernachtungen
// fehlten komplett — die Funklücke lag bei 9,5 bzw. 14,5 Stunden,
// die Randgeschwindigkeit auf beiden Seiten aber bei 3 km/h (GPS-Rauschen
// beim ersten Fix nach der Stille), obwohl sich das Fahrzeug nur ~20 m
// bewegt hatte. 2 km/h Schwelle schloss das noch aus, 5 km/h schließt es ein.
test("segmentStops: eine Funklücke mit 3 km/h Randgeschwindigkeit und minimaler Ortsveränderung zählt als Stand", () => {
  const start = Date.parse("2026-09-26T10:13:59.000Z");
  const ende = Date.parse("2026-09-26T19:42:59.000Z"); // 569 Minuten Lücke
  const rows = [
    { device_id: "d1", at: start, lat: -47.444141, lon: 30.2435142, speed_kmh: 3 },
    { device_id: "d1", at: ende, lat: -47.4443001, lon: 30.243626900000002, speed_kmh: 3 },
  ];
  const stops = segmentStops(rows);
  assert.equal(stops.length, 1, "die Lücke mit 3 km/h Randgeschwindigkeit muss als Stand zählen");
  assert.equal(stops[0].startTime, new Date(start).toISOString());
  assert.equal(stops[0].endTime, new Date(ende).toISOString());
});

// Echter Fund (28. September 2026): Samstag auf Sonntag stand das Fahrzeug
// 14,5 Stunden, die erste Meldung danach kam schon mit 15 km/h (Losfahren),
// nur 23 m vom letzten Punkt vor der Stille entfernt.
test("segmentStops: eine lange Lücke, deren Endpunkt nur wenige Meter entfernt liegt, zählt trotz hoher Randgeschwindigkeit als Stand", () => {
  const start = Date.parse("2026-09-26T19:42:59.000Z");
  const ende = Date.parse("2026-09-27T10:17:17.000Z");
  const rows = [
    { device_id: "d1", at: start, lat: -47.4443001, lon: 30.243626900000002, speed_kmh: 3 },
    { device_id: "d1", at: ende, lat: -47.4441183, lon: 30.243479999999998, speed_kmh: 15 },
  ];
  const stops = segmentStops(rows);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].startTime, new Date(start).toISOString());
  assert.equal(stops[0].endTime, new Date(ende).toISOString());
});

test("segmentStops: eine lange Lücke mit hoher Randgeschwindigkeit UND deutlichem Abstand bleibt unbekannt", () => {
  const rows = [
    { device_id: "d1", at: Date.parse("2026-09-26T19:42:59.000Z"), lat: -47.4443, lon: 30.2436, speed_kmh: 3 },
    { device_id: "d1", at: Date.parse("2026-09-27T10:17:17.000Z"), lat: -47.446, lon: 30.2436, speed_kmh: 15 }, // ~190 m
  ];
  assert.equal(segmentStops(rows).length, 0);
});
