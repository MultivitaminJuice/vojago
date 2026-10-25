import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../router.js";
import { D1Memory } from "./helpers/d1-memory.js";

function makeEnv(extra = {}) {
  return { DB: new D1Memory(), ...extra };
}

function cookieFrom(response) {
  return response.headers.get("set-cookie")?.split(";")[0] || "";
}

async function api(env, method, path, { body, cookie, headers = {} } = {}) {
  const reqHeaders = new Headers(headers);
  if (body !== undefined) reqHeaders.set("content-type", "application/json");
  if (cookie) reqHeaders.set("cookie", cookie);
  const response = await handle(new Request(`https://vojago.test${path}`, {
    method,
    headers: reqHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { response, status: response.status, data, cookie: cookieFrom(response) };
}

async function setupAndLogin(env, username = "dirk", password = "langgenug1", headers = {}) {
  const setup = await api(env, "POST", "/api/auth/setup", { body: { username, password }, headers });
  assert.equal(setup.status, 201);
  assert.ok(setup.cookie.startsWith("vojago_session="));
  return setup.cookie;
}

test("API-Integration: Setup, Login, Sitzung und Schutz privater Routen", async (t) => {
  const env = makeEnv();
  t.after(() => env.DB.close());

  const vorSetup = await api(env, "GET", "/api/auth/me");
  assert.equal(vorSetup.status, 200);
  assert.deepEqual(vorSetup.data, { eingerichtet: false, angemeldet: false, username: null, email: null, emailVerified: false, isAdmin: false });

  const ohneSitzung = await api(env, "GET", "/api/trips");
  assert.equal(ohneSitzung.status, 401);

  const cookie = await setupAndLogin(env);
  const me = await api(env, "GET", "/api/auth/me", { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.data.eingerichtet, true);
  assert.equal(me.data.angemeldet, true);
  assert.equal(me.data.username, "dirk");

  const zweitesSetup = await api(env, "POST", "/api/auth/setup", { body: { username: "zweit", password: "langgenug2" } });
  assert.equal(zweitesSetup.status, 409);

  const falscherLogin = await api(env, "POST", "/api/auth/login", { body: { username: "dirk", password: "falsch" } });
  assert.equal(falscherLogin.status, 401);

  const login = await api(env, "POST", "/api/auth/login", { body: { username: "dirk", password: "langgenug1" } });
  assert.equal(login.status, 200);
  assert.ok(login.cookie.startsWith("vojago_session="));

  const trips = await api(env, "GET", "/api/trips", { cookie: login.cookie });
  assert.equal(trips.status, 200);
  assert.deepEqual(trips.data, []);

  const logout = await api(env, "POST", "/api/auth/logout", { cookie: login.cookie });
  assert.equal(logout.status, 200);
  assert.ok(logout.response.headers.get("set-cookie").includes("Max-Age=0"));
});

// Fängt ausgehende Mailversand-Aufrufe ab (kein echter Resend-Aufruf in Tests)
// und reicht die gesendeten Nachrichten an den Test zurück.
function mitMailAbfangen(t) {
  const gesendet = [];
  const echtesFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === "https://api.resend.com/emails") {
      gesendet.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "test-mail" }), { status: 200 });
    }
    return echtesFetch(url, init);
  };
  t.after(() => { globalThis.fetch = echtesFetch; });
  return gesendet;
}

test("API-Integration: E-Mail bestätigen + Passwort-Reset per E-Mail-Link (N11)", async (t) => {
  const env = makeEnv({ RESEND_API_KEY: "test-key" });
  t.after(() => env.DB.close());
  const gesendeteMails = mitMailAbfangen(t);
  const ip = { "cf-connecting-ip": "203.0.113.10" };

  const cookie = await setupAndLogin(env, "dirk", "altespw123");
  const alteSitzung = cookie;

  // Ohne hinterlegte E-Mail antwortet "forgot" trotzdem generisch — und
  // verschickt nichts.
  const forgotOhneEmail = await api(env, "POST", "/api/auth/forgot", { body: { username: "dirk" }, headers: ip });
  assert.equal(forgotOhneEmail.status, 200);
  assert.equal(gesendeteMails.length, 0);

  // Unbekannter Benutzername liefert dieselbe Antwort (kein Verrat).
  const forgotUnbekannt = await api(env, "POST", "/api/auth/forgot", { body: { username: "niemand" }, headers: ip });
  assert.equal(forgotUnbekannt.status, 200);
  assert.deepEqual(forgotUnbekannt.data, forgotOhneEmail.data);

  // E-Mail hinterlegen verlangt das aktuelle Passwort.
  const emailFalschesPw = await api(env, "POST", "/api/auth/email", { cookie, body: { password: "falsch", email: "dirk@example.com" } });
  assert.equal(emailFalschesPw.status, 401);

  const emailUngueltig = await api(env, "POST", "/api/auth/email", { cookie, body: { password: "altespw123", email: "keine-email" } });
  assert.equal(emailUngueltig.status, 400);

  // Speichern verschickt sofort eine Bestätigungsmail — die Adresse gilt
  // aber noch nicht.
  const emailSetzen = await api(env, "POST", "/api/auth/email", { cookie, body: { password: "altespw123", email: "dirk@example.com" } });
  assert.equal(emailSetzen.status, 200);
  assert.equal(emailSetzen.data.emailVerified, false);
  assert.equal(gesendeteMails.length, 1);
  assert.equal(gesendeteMails[0].to[0], "dirk@example.com");
  assert.match(gesendeteMails[0].subject, /bestätigen/i);

  const me = await api(env, "GET", "/api/auth/me", { cookie });
  assert.equal(me.data.email, "dirk@example.com");
  assert.equal(me.data.emailVerified, false);

  // Solange unbestätigt, verschickt "forgot" trotz hinterlegter Adresse nichts.
  const forgotUnbestaetigt = await api(env, "POST", "/api/auth/forgot", { body: { username: "dirk" }, headers: ip });
  assert.equal(forgotUnbestaetigt.status, 200);
  assert.equal(gesendeteMails.length, 1, "kein Reset-Versand ohne bestätigte E-Mail");

  // Erfundener Bestätigungslink wird abgelehnt.
  const falscherVerify = await api(env, "POST", "/api/auth/verify-email", { body: { token: "erfunden" } });
  assert.equal(falscherVerify.status, 401);

  // Richtiger Bestätigungslink bestätigt die E-Mail.
  const verifyLink = gesendeteMails[0].text.match(/https:\/\/\S+/)[0];
  const verifyToken = new URL(verifyLink).searchParams.get("verify");
  assert.ok(verifyToken && verifyToken.length > 10);
  const verify = await api(env, "POST", "/api/auth/verify-email", { body: { token: verifyToken } });
  assert.equal(verify.status, 200);
  assert.equal(verify.data.email, "dirk@example.com");

  const meBestaetigt = await api(env, "GET", "/api/auth/me", { cookie });
  assert.equal(meBestaetigt.data.emailVerified, true);

  // Derselbe Link gilt kein zweites Mal.
  const verifyNochmal = await api(env, "POST", "/api/auth/verify-email", { body: { token: verifyToken } });
  assert.equal(verifyNochmal.status, 401);

  // Jetzt verschickt "forgot" tatsächlich eine Mail mit Reset-Link.
  const forgot = await api(env, "POST", "/api/auth/forgot", { body: { username: "dirk" }, headers: ip });
  assert.equal(forgot.status, 200);
  assert.equal(gesendeteMails.length, 2);
  assert.equal(gesendeteMails[1].to[0], "dirk@example.com");
  const link = gesendeteMails[1].text.match(/https:\/\/\S+/)[0];
  const token = new URL(link).searchParams.get("reset");
  assert.ok(token && token.length > 10);

  // Falscher Link wird abgelehnt.
  const falscherToken = await api(env, "POST", "/api/auth/reset", { body: { token: "nicht-der-richtige", password: "neuespw456" } });
  assert.equal(falscherToken.status, 401);

  // Zu kurzes neues Passwort wird abgelehnt, ohne den Link zu verbrauchen.
  const zuKurz = await api(env, "POST", "/api/auth/reset", { body: { token, password: "kurz" } });
  assert.equal(zuKurz.status, 400);

  // Richtiger Link setzt das Passwort und meldet zugleich an.
  const reset = await api(env, "POST", "/api/auth/reset", { body: { token, password: "neuespw456" } });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.username, "dirk");
  assert.ok(reset.cookie.startsWith("vojago_session="), "reset meldet zugleich an");

  // Altes Passwort geht nicht mehr, neues schon.
  const altesPwWeg = await api(env, "POST", "/api/auth/login", { body: { username: "dirk", password: "altespw123" }, headers: ip });
  assert.equal(altesPwWeg.status, 401);
  const neuesPwGeht = await api(env, "POST", "/api/auth/login", { body: { username: "dirk", password: "neuespw456" }, headers: ip });
  assert.equal(neuesPwGeht.status, 200);

  // Die Sitzung von vor dem Zurücksetzen ist beendet.
  const alteSitzungTot = await api(env, "GET", "/api/trips", { cookie: alteSitzung });
  assert.equal(alteSitzungTot.status, 401);

  // Der Link ist verbraucht, gilt kein zweites Mal.
  const tokenNochmal = await api(env, "POST", "/api/auth/reset", { body: { token, password: "wiederneu789" } });
  assert.equal(tokenNochmal.status, 401);
});

test("API-Integration: E-Mail schon bei der Kontoanlage — optional, unbestätigt, alter Link verfällt bei Änderung", async (t) => {
  const env = makeEnv({ RESEND_API_KEY: "test-key" });
  t.after(() => env.DB.close());
  const gesendeteMails = mitMailAbfangen(t);

  // Ungültige Adresse verhindert die Kontoanlage gleich mit.
  const ungueltig = await api(env, "POST", "/api/auth/setup", {
    body: { username: "dirk", password: "startpw1234", email: "keine-email" },
  });
  assert.equal(ungueltig.status, 400);

  // Ohne E-Mail funktioniert die Kontoanlage wie zuvor — kein Mailversand
  // nötig, um überhaupt ein erstes Konto anlegen zu können.
  const ohneEmail = await api(env, "POST", "/api/auth/setup", { body: { username: "dirk", password: "startpw1234" } });
  assert.equal(ohneEmail.status, 201);
  assert.equal(ohneEmail.data.emailPending, false);
  assert.equal(gesendeteMails.length, 0);
  const me = await api(env, "GET", "/api/auth/me", { cookie: ohneEmail.cookie });
  assert.equal(me.data.email, null);

  // Mit E-Mail: Konto steht sofort, Bestätigungsmail geht sofort raus.
  const env2 = makeEnv({ RESEND_API_KEY: "test-key" });
  t.after(() => env2.DB.close());
  const gesendeteMails2 = mitMailAbfangen(t);
  const mitEmail = await api(env2, "POST", "/api/auth/setup", {
    body: { username: "dirk", password: "startpw1234", email: "dirk@example.com" },
  });
  assert.equal(mitEmail.status, 201);
  assert.equal(mitEmail.data.emailPending, true);
  assert.equal(gesendeteMails2.length, 1);
  const me2 = await api(env2, "GET", "/api/auth/me", { cookie: mitEmail.cookie });
  assert.equal(me2.data.email, "dirk@example.com");
  assert.equal(me2.data.emailVerified, false);

  // Adresse vor dem Bestätigen nochmal ändern — der alte Link darf die neue
  // (andere) Adresse nicht versehentlich mitbestätigen.
  const alterLink = gesendeteMails2[0].text.match(/https:\/\/\S+/)[0];
  const alterToken = new URL(alterLink).searchParams.get("verify");
  const geaendert = await api(env2, "POST", "/api/auth/email", {
    cookie: mitEmail.cookie, body: { password: "startpw1234", email: "andere@example.com" },
  });
  assert.equal(geaendert.status, 200);
  assert.equal(gesendeteMails2.length, 2, "die Änderung verschickt selbst einen neuen Bestätigungslink");

  const alterTokenNochGueltig = await api(env2, "POST", "/api/auth/verify-email", { body: { token: alterToken } });
  assert.equal(alterTokenNochGueltig.status, 409, "der Link galt für die alte Adresse, nicht die neue");

  const neuerLink = gesendeteMails2[1].text.match(/https:\/\/\S+/)[0];
  const neuerToken = new URL(neuerLink).searchParams.get("verify");
  const neuerTokenOk = await api(env2, "POST", "/api/auth/verify-email", { body: { token: neuerToken } });
  assert.equal(neuerTokenOk.status, 200);
  assert.equal(neuerTokenOk.data.email, "andere@example.com");
});

// Live gefunden am 16. August 2026: app-backend (Selbst-Hosting)
// setzt bewusst kein RESEND_API_KEY — ohne diesen Fix
// bliebe eine angegebene E-Mail für immer "nicht verifiziert" hängen, weil
// der Bestätigungslink zwar angelegt, aber nie zugestellt wird.
test("API-Integration: ohne RESEND_API_KEY gilt die E-Mail sofort als bestätigt (kein Mailversand möglich)", async (t) => {
  const env = makeEnv(); // kein RESEND_API_KEY — wie app-backend
  t.after(() => env.DB.close());
  const ip = { "cf-connecting-ip": "203.0.113.70" };

  const setup = await api(env, "POST", "/api/auth/setup", {
    headers: ip, body: { username: "dirk", password: "startpw1234", email: "dirk@example.com" },
  });
  assert.equal(setup.status, 201);
  assert.equal(setup.data.emailPending, false, "kein Versand möglich, also auch kein Warten auf Bestätigung");

  const me = await api(env, "GET", "/api/auth/me", { cookie: setup.cookie, headers: ip });
  assert.equal(me.data.email, "dirk@example.com");
  assert.equal(me.data.emailVerified, true);

  // Gilt genauso beim nachträglichen Ändern der Adresse, nicht nur beim Setup.
  const geaendert = await api(env, "POST", "/api/auth/email", {
    cookie: setup.cookie, headers: ip, body: { password: "startpw1234", email: "andere@example.com" },
  });
  assert.equal(geaendert.status, 200);
  assert.equal(geaendert.data.emailVerified, true);
});

test("API-Integration: Reisen, Orte, Stopps und Notizen laufen gegen D1", async (t) => {
  const env = makeEnv();
  t.after(() => env.DB.close());
  const cookie = await setupAndLogin(env);

  const trip = await api(env, "POST", "/api/trips", {
    cookie,
    body: { id: "reise-1", name: "Testreise", start_at: "2026-08-09T08:00:00Z" },
  });
  assert.equal(trip.status, 201);
  assert.deepEqual(trip.data, { id: "reise-1" });

  const zweiteLaufende = await api(env, "POST", "/api/trips", {
    cookie,
    body: { id: "reise-2", name: "Zweite", start_at: "2026-08-10T08:00:00Z" },
  });
  assert.equal(zweiteLaufende.status, 409);

  const ungueltigerOrt = await api(env, "POST", "/api/besuche", {
    cookie,
    body: { title: "Atlantis", lat: 999, lon: 7.1 },
  });
  assert.equal(ungueltigerOrt.status, 400);

  const ort = await api(env, "POST", "/api/besuche", {
    cookie,
    body: {
      id: "besuch-1",
      title: "Stellplatz",
      note: "Ruhig",
      category_id: "uebernachtung",
      lat: 52.1,
      lon: 7.3,
      kind: "auto",
      occurred_at: "2026-08-10T08:41:00Z",
      nights: 1,
      stop_key: "device-1|2026-08-09T22:30:00Z",
    },
  });
  assert.equal(ort.status, 201);
  assert.ok(ort.data.ort_id, "POST /api/besuche legt automatisch einen Ort an");
  const ortId = ort.data.ort_id;

  const doppelterStopp = await api(env, "POST", "/api/besuche", {
    cookie,
    body: {
      title: "Duplikat",
      lat: 52.1,
      lon: 7.3,
      stop_key: "device-1|2026-08-09T22:30:00Z",
    },
  });
  assert.equal(doppelterStopp.status, 409);

  // Echter Fund (6. September 2026): der abgelehnte Versuch legte trotzdem
  // schon einen neuen Ort ("Duplikat") an, bevor der stop_key-Duplikat-
  // Check überhaupt lief — 353 genau solcher verwaisten Orte sammelten
  // sich so in Produktion an. Validierung/Duplikat-Check müssen komplett
  // durchlaufen sein, bevor irgendetwas geschrieben wird.
  const verwaisterOrt = await env.DB.prepare("SELECT id FROM orte WHERE title = 'Duplikat'").all();
  assert.equal(verwaisterOrt.results?.length ?? 0, 0, "ein abgelehnter Besuch darf keinen verwaisten Ort hinterlassen");

  // Ein zweiter Besuch am selben Ort (ort_id wiederverwendet, wie es die
  // Nähe-Erkennung im Frontend täte) — Grundlage für "wie oft war ich hier".
  const zweiterBesuch = await api(env, "POST", "/api/besuche", {
    cookie,
    body: { ort_id: ortId, occurred_at: "2026-08-11T08:00:00Z", nights: 2 },
  });
  assert.equal(zweiterBesuch.status, 201);
  assert.equal(zweiterBesuch.data.ort_id, ortId);

  const places = await api(env, "GET", "/api/besuche", { cookie });
  assert.equal(places.status, 200);
  assert.equal(places.data.length, 2);
  assert.ok(places.data.every((p) => p.ort_id === ortId && p.title === "Stellplatz"));

  const notizOhneTitel = await api(env, "POST", "/api/notes", {
    cookie,
    body: { text: "Ohne Titel" },
  });
  assert.equal(notizOhneTitel.status, 400);

  const note = await api(env, "POST", "/api/notes", {
    cookie,
    body: {
      id: "note-1",
      besuch_id: "besuch-1",
      title: "Kaffee",
      text: "Erstmal ankommen.",
      occurred_at: "2026-08-10T09:00:00Z",
      lat: 52.1,
      lon: 7.3,
    },
  });
  assert.equal(note.status, 201);

  const notes = await api(env, "GET", "/api/notes", { cookie });
  assert.equal(notes.status, 200);
  assert.equal(notes.data.length, 1);
  assert.equal(notes.data[0].title, "Kaffee");

  const patchNote = await api(env, "PATCH", "/api/notes/note-1", {
    cookie,
    body: { text: "Noch einen Kaffee." },
  });
  assert.equal(patchNote.status, 200);

  const deleteBesuch1 = await api(env, "DELETE", "/api/besuche/besuch-1", { cookie });
  assert.equal(deleteBesuch1.status, 200);
  const ignored = await api(env, "GET", "/api/ignored-stops", { cookie });
  assert.deepEqual(ignored.data, ["device-1|2026-08-09T22:30:00Z"]);

  // Der Ort selbst bleibt bestehen — der zweite Besuch hängt noch daran.
  const nachErstemLoeschen = await api(env, "GET", "/api/besuche", { cookie });
  assert.equal(nachErstemLoeschen.data.length, 1);
  assert.equal(nachErstemLoeschen.data[0].ort_id, ortId);

  // Letzten Besuch löschen -> der jetzt besuchslose Ort wird mit aufgeräumt.
  await api(env, "DELETE", `/api/besuche/${zweiterBesuch.data.id}`, { cookie });
  const amEnde = await api(env, "GET", "/api/besuche", { cookie });
  assert.equal(amEnde.data.length, 0);
});

test("API-Integration: Reisen teilen — Umfang, Ablauf, Widerruf, alle Reisen", async (t) => {
  const env = makeEnv();
  t.after(() => env.DB.close());
  const cookie = await setupAndLogin(env);

  await api(env, "POST", "/api/trips", { cookie, body: { id: "reise-a", name: "Alpen", start_at: "2026-08-01T08:00:00Z", end_at: "2026-08-05T18:00:00Z" } });
  await api(env, "POST", "/api/trips", { cookie, body: { id: "reise-b", name: "Küste", start_at: "2026-08-10T08:00:00Z" } });
  // Reise-Zugehörigkeit gibt es nicht mehr als gespeichertes Feld — wie bei
  // Fahrten zählt der Zeitpunkt gegen den Reisezeitraum (2026-08-01 bis -05).
  await api(env, "POST", "/api/besuche", { cookie, body: { id: "besuch-a", title: "Alm", lat: 47.1, lon: 11.1, occurred_at: "2026-08-02T10:00:00Z" } });
  await api(env, "POST", "/api/notes", { cookie, body: { id: "notiz-a", title: "Aussicht", text: "Toll hier", occurred_at: "2026-08-02T11:00:00Z" } });

  // Ohne Anmeldung kein Erzeugen/Auflisten/Widerrufen.
  const ohneSitzung = await api(env, "POST", "/api/shares", { body: { tripId: "reise-a" } });
  assert.equal(ohneSitzung.status, 401);

  // Ungültiger Umfang bzw. nicht existierende Reise werden abgelehnt.
  const falscherUmfang = await api(env, "POST", "/api/shares", { cookie, body: { tripId: "reise-a", scope: "alles" } });
  assert.equal(falscherUmfang.status, 400);
  const unbekannteReise = await api(env, "POST", "/api/shares", { cookie, body: { tripId: "nicht-da", scope: "karte" } });
  assert.equal(unbekannteReise.status, 404);

  // Share für eine einzelne Reise, mit Logbuch.
  const share = await api(env, "POST", "/api/shares", {
    cookie, body: { tripId: "reise-a", scope: "karte_logbuch", label: "für Oma", expiresInDays: 30 },
  });
  assert.equal(share.status, 201);
  assert.ok(share.data.token && share.data.token.length > 20);

  const ip = { "cf-connecting-ip": "203.0.113.20" };
  const oeffentlich = await api(env, "GET", `/api/share/${share.data.token}`, { headers: ip });
  assert.equal(oeffentlich.status, 200);
  assert.equal(oeffentlich.data.scope, "karte_logbuch");
  assert.equal(oeffentlich.data.alleReisen, false);
  assert.equal(oeffentlich.data.trips.length, 1);
  assert.equal(oeffentlich.data.trips[0].id, "reise-a");
  assert.equal(oeffentlich.data.places.length, 1);
  assert.equal(oeffentlich.data.notes.length, 1);

  // Der Seitenaufruf zählt.
  const liste1 = await api(env, "GET", "/api/shares", { cookie });
  const gelistet = liste1.data.find((s) => s.id === share.data.id);
  assert.equal(gelistet.view_count, 1);
  // Der Klartext-Token bleibt abrufbar — anders als bei Sitzungen/Reset-
  // Links soll der Besitzer den Link jederzeit erneut herausgeben können.
  assert.equal(gelistet.token, share.data.token);

  // Umfang "karte" ohne Logbuch: kein Zugriff auf Orte/Notizen über den Link.
  const nurKarte = await api(env, "POST", "/api/shares", { cookie, body: { tripId: "reise-a", scope: "karte" } });
  const oeffentlichKarte = await api(env, "GET", `/api/share/${nurKarte.data.token}`, { headers: ip });
  assert.deepEqual(oeffentlichKarte.data.places, []);
  assert.deepEqual(oeffentlichKarte.data.notes, []);

  // "Alle Reisen" (kein tripId) liefert beide Reisen — auch künftige, ohne neuen Link.
  const alle = await api(env, "POST", "/api/shares", { cookie, body: { scope: "karte" } });
  const oeffentlichAlle = await api(env, "GET", `/api/share/${alle.data.token}`, { headers: ip });
  assert.equal(oeffentlichAlle.data.alleReisen, true);
  assert.equal(oeffentlichAlle.data.trips.length, 2);

  // Erfundener Token liefert 404, kein Verrat über den Grund.
  const erfunden = await api(env, "GET", "/api/share/erfunden-und-falsch", { headers: ip });
  assert.equal(erfunden.status, 404);

  // Ungültiger Ablauf wird abgelehnt.
  const schlechterAblauf = await api(env, "POST", "/api/shares", { cookie, body: { tripId: "reise-a", expiresInDays: 0 } });
  assert.equal(schlechterAblauf.status, 400);

  // Bereits abgelaufener Link greift nicht mehr.
  const abgelaufen = await api(env, "POST", "/api/shares", { cookie, body: { tripId: "reise-a", expiresInDays: 1 } });
  await env.DB.prepare("UPDATE trip_shares SET expires_at = ? WHERE id = ?").bind(Date.now() - 1000, abgelaufen.data.id).run();
  const oeffentlichAbgelaufen = await api(env, "GET", `/api/share/${abgelaufen.data.token}`, { headers: ip });
  assert.equal(oeffentlichAbgelaufen.status, 404);

  // Widerrufen sperrt den Link sofort, auch wenn er noch nicht abgelaufen wäre.
  const widerruf = await api(env, "DELETE", `/api/shares/${share.data.id}`, { cookie });
  assert.equal(widerruf.status, 200);
  const oeffentlichNachWiderruf = await api(env, "GET", `/api/share/${share.data.token}`, { headers: ip });
  assert.equal(oeffentlichNachWiderruf.status, 404);
});

test("API-Integration: Passwortwechsel hält aktuelle Sitzung und beendet andere", async (t) => {
  const env = makeEnv();
  t.after(() => env.DB.close());
  const cookie = await setupAndLogin(env, "dirk", "erstes-passwort");

  const zweiteSitzung = await api(env, "POST", "/api/auth/login", {
    body: { username: "dirk", password: "erstes-passwort" },
  });
  assert.equal(zweiteSitzung.status, 200);

  const falscherWechsel = await api(env, "POST", "/api/auth/password", {
    cookie,
    body: { alt: "falsch", neu: "zweites-passwort" },
  });
  assert.equal(falscherWechsel.status, 401);

  const wechsel = await api(env, "POST", "/api/auth/password", {
    cookie,
    body: { alt: "erstes-passwort", neu: "zweites-passwort" },
  });
  assert.equal(wechsel.status, 200);

  const aktuelleSitzung = await api(env, "GET", "/api/trips", { cookie });
  assert.equal(aktuelleSitzung.status, 200);

  const alteZweiteSitzung = await api(env, "GET", "/api/trips", { cookie: zweiteSitzung.cookie });
  assert.equal(alteZweiteSitzung.status, 401);

  const alterLogin = await api(env, "POST", "/api/auth/login", {
    body: { username: "dirk", password: "erstes-passwort" },
  });
  assert.equal(alterLogin.status, 401);

  const neuerLogin = await api(env, "POST", "/api/auth/login", {
    body: { username: "dirk", password: "zweites-passwort" },
  });
  assert.equal(neuerLogin.status, 200);
});

test("API-Integration: Fahrt-Zuordnung speichert Etappen und Abstecher", async (t) => {
  const env = makeEnv();
  t.after(() => env.DB.close());
  const cookie = await setupAndLogin(env);

  await api(env, "POST", "/api/trips", {
    cookie,
    body: { id: "reise-1", name: "Testreise", start_at: "2026-08-09T08:00:00Z" },
  });

  const abstecher = await api(env, "PUT", "/api/drive-assignments", {
    cookie,
    body: {
      drive_key: "device-1|2026-08-10T09:00:00Z",
      trip_id: "reise-1",
      kind: "abstecher",
    },
  });
  assert.equal(abstecher.status, 200);

  const ungueltig = await api(env, "PATCH", "/api/drive-assignments", {
    cookie,
    body: {
      drive_key: "device-1|2026-08-10T09:00:00Z",
      kind: "pause",
    },
  });
  assert.equal(ungueltig.status, 400);

  const rows = await api(env, "GET", "/api/drive-assignments", { cookie });
  assert.equal(rows.status, 200);
  assert.equal(rows.data[0].trip_id, "reise-1");
  assert.equal(rows.data[0].assignment, "manual");
  assert.equal(rows.data[0].kind, "abstecher");
});

test("API-Integration: Einstellungen, Kategorien und aktives Fahrzeug bleiben konsistent", async (t) => {
  const env = makeEnv();
  t.after(() => env.DB.close());
  const cookie = await setupAndLogin(env);

  const settingsLeer = await api(env, "GET", "/api/settings", { cookie });
  assert.deepEqual(settingsLeer.data, {});

  const settingsPut = await api(env, "PUT", "/api/settings", {
    cookie,
    body: { demo: false, map: { metric: "day" } },
  });
  assert.equal(settingsPut.status, 200);
  const settings = await api(env, "GET", "/api/settings", { cookie });
  assert.deepEqual(settings.data, { demo: false, map: { metric: "day" } });

  const fahrzeugA = await api(env, "POST", "/api/vehicles", {
    cookie,
    body: { id: "van-a", name: "Van A", traccar_device_id: "101", active: true },
  });
  assert.equal(fahrzeugA.status, 201);
  const fahrzeugB = await api(env, "POST", "/api/vehicles", {
    cookie,
    body: { id: "van-b", name: "Van B", traccar_device_id: "102", active: true },
  });
  assert.equal(fahrzeugB.status, 201);

  const vehicles = await api(env, "GET", "/api/vehicles", { cookie });
  assert.equal(vehicles.data.find((v) => v.id === "van-a").active, 0);
  assert.equal(vehicles.data.find((v) => v.id === "van-b").active, 1);

  const category = await api(env, "POST", "/api/categories", {
    cookie,
    body: { id: "kaffee", name: "Kaffee", color: "#b87333", sort: 12 },
  });
  assert.equal(category.status, 201);
  await api(env, "POST", "/api/besuche", {
    cookie,
    body: { id: "cafe-1", title: "Cafe", category_id: "kaffee", lat: 52.2, lon: 7.2 },
  });
  const deleteUsedCategory = await api(env, "DELETE", "/api/categories/kaffee", { cookie });
  assert.equal(deleteUsedCategory.status, 409);
});

test("API-Integration: Kategorien und Fahrzeuge weisen unbrauchbare Eingaben zurück (W7)", async (t) => {
  const env = makeEnv();
  t.after(() => env.DB.close());
  const cookie = await setupAndLogin(env);

  const ohneName = await api(env, "POST", "/api/categories", { cookie, body: { color: "#e8802b" } });
  assert.equal(ohneName.status, 400);

  const schlechteFarbe = await api(env, "POST", "/api/categories", {
    cookie, body: { name: "Test", color: "javascript:alert(1)" },
  });
  assert.equal(schlechteFarbe.status, 400);

  const schlechteId = await api(env, "POST", "/api/categories", {
    cookie, body: { id: "../../etc", name: "Test" },
  });
  assert.equal(schlechteId.status, 400);

  const gueltig = await api(env, "POST", "/api/categories", {
    cookie, body: { id: "campingplatz", name: "Campingplatz", color: "#3b82c4", sort: 15 },
  });
  assert.equal(gueltig.status, 201);
  const schlechtePatch = await api(env, "PATCH", "/api/categories/campingplatz", {
    cookie, body: { color: "keine-farbe" },
  });
  assert.equal(schlechtePatch.status, 400);
  const gueltigerPatch = await api(env, "PATCH", "/api/categories/campingplatz", {
    cookie, body: { color: "#123456" },
  });
  assert.equal(gueltigerPatch.status, 200);

  const fahrzeugOhneName = await api(env, "POST", "/api/vehicles", { cookie, body: { traccar_device_id: "5" } });
  assert.equal(fahrzeugOhneName.status, 400);

  const fahrzeugSchlechtesFlag = await api(env, "POST", "/api/vehicles", {
    cookie, body: { name: "Testwagen", active: "ja" },
  });
  assert.equal(fahrzeugSchlechtesFlag.status, 400);

  const fahrzeugGueltig = await api(env, "POST", "/api/vehicles", {
    cookie, body: { id: "testwagen", name: "Testwagen", traccar_device_id: 7 },
  });
  assert.equal(fahrzeugGueltig.status, 201);
});

test("API-Integration: Geofences sind nur lesbar (W3) — geschrieben wird ausschließlich beim Scharfschalten", async (t) => {
  const env = makeEnv();
  t.after(() => env.DB.close());
  const ip = { "cf-connecting-ip": "203.0.113.71" };
  const cookie = await setupAndLogin(env, "dirk", "langgenug1", ip);

  const leer = await api(env, "GET", "/api/geofences", { cookie, headers: ip });
  assert.equal(leer.status, 200);
  assert.deepEqual(leer.data, []);

  // Kein Zonen-CRUD (mehr) — die früheren Schreib-Endpunkte existieren nicht.
  const post = await api(env, "POST", "/api/geofences", { cookie, headers: ip, body: { name: "x", lat: 47.5, lon: 10.7, radius_m: 200 } });
  assert.equal(post.status, 404);
});

test("API-Integration: Wache scharf/unscharf — merkt sich beim Scharfschalten die aktuelle Position als einzigen Ankerpunkt", async (t) => {
  const env = makeEnv();
  t.after(() => env.DB.close());
  const ip = { "cf-connecting-ip": "203.0.113.72" };
  const adminCookie = await setupAndLogin(env, "dirk", "erstes-passwort", ip);
  await api(env, "POST", "/api/users", { cookie: adminCookie, body: { username: "beifahrer", password: "zweitespasswort" }, headers: ip });
  const login = await api(env, "POST", "/api/auth/login", { body: { username: "beifahrer", password: "zweitespasswort" }, headers: ip });
  const nutzerCookie = login.cookie;

  const settingsNutzer = await api(env, "GET", "/api/alarms", { cookie: nutzerCookie, headers: ip });
  assert.equal(settingsNutzer.status, 200);
  const geofenceSetting = settingsNutzer.data.find((s) => s.key === "geofence");
  assert.equal(geofenceSetting.enabled, 1); // Startwert aus db/schema.sql

  // Ändern nur für Admins.
  const aendernNutzer = await api(env, "PATCH", "/api/alarms/geofence", { cookie: nutzerCookie, headers: ip, body: { enabled: false } });
  assert.equal(aendernNutzer.status, 403);

  // Scharfschalten ohne Position wird abgewiesen — es gäbe nichts zu bewachen.
  const ohnePosition = await api(env, "PATCH", "/api/alarms/geofence", { cookie: adminCookie, headers: ip, body: { enabled: true } });
  assert.equal(ohnePosition.status, 400);

  // Scharfschalten mit Position legt den Ankerpunkt an (radius_m optional, Default 50).
  const scharf = await api(env, "PATCH", "/api/alarms/geofence", {
    cookie: adminCookie, headers: ip, body: { enabled: true, lat: 47.5, lon: 10.7, radius_m: 80 },
  });
  assert.equal(scharf.status, 200);
  const zonenNachScharf = await api(env, "GET", "/api/geofences", { cookie: adminCookie, headers: ip });
  assert.equal(zonenNachScharf.data.length, 1);
  assert.equal(zonenNachScharf.data[0].radius_m, 80);
  assert.equal(zonenNachScharf.data[0].lat, 47.5);

  // Erneutes Scharfschalten an anderer Position ERSETZT den Ankerpunkt statt eine zweite Zone anzulegen.
  const scharfAnderswo = await api(env, "PATCH", "/api/alarms/geofence", {
    cookie: adminCookie, headers: ip, body: { enabled: true, lat: 48.0, lon: 11.0, radius_m: 50 },
  });
  assert.equal(scharfAnderswo.status, 200);
  const zonenNachher = await api(env, "GET", "/api/geofences", { cookie: adminCookie, headers: ip });
  assert.equal(zonenNachher.data.length, 1);
  assert.equal(zonenNachher.data[0].lat, 48.0);

  // Ungültiger Radius wird abgewiesen.
  const schlechterRadius = await api(env, "PATCH", "/api/alarms/geofence", {
    cookie: adminCookie, headers: ip, body: { enabled: true, lat: 47.5, lon: 10.7, radius_m: 5 },
  });
  assert.equal(schlechterRadius.status, 400);

  // Unscharfschalten braucht keine Position.
  const unscharf = await api(env, "PATCH", "/api/alarms/geofence", { cookie: adminCookie, headers: ip, body: { enabled: false } });
  assert.equal(unscharf.status, 200);
  // Scharf- und Unscharfschalten stehen im Protokoll (Grundlage für "scharf seit").
  const protokoll = await api(env, "GET", "/api/alarms/log", { cookie: adminCookie, headers: ip });
  const meldungen = protokoll.data.map((e) => e.message);
  assert.ok(meldungen.some((m) => /^Wache scharf geschaltet \(Radius 50 m\)$/.test(m)), "Scharfschalten fehlt im Protokoll");
  assert.ok(meldungen.includes("Wache unscharf geschaltet"), "Unscharfschalten fehlt im Protokoll");
  const nachUnscharf = await api(env, "GET", "/api/alarms", { cookie: adminCookie, headers: ip });
  assert.equal(nachUnscharf.data.find((s) => s.key === "geofence").enabled, 0);

  const unbekannterTyp = await api(env, "PATCH", "/api/alarms/nicht-vorhanden", { cookie: adminCookie, headers: ip, body: { enabled: true } });
  assert.equal(unbekannterTyp.status, 404);

  const schlechterWert = await api(env, "PATCH", "/api/alarms/geofence", { cookie: adminCookie, headers: ip, body: { enabled: "ja" } });
  assert.equal(schlechterWert.status, 400);
});

test("API-Integration: Fotos — Validierung und Verhalten ohne eingerichteten Speicher", async (t) => {
  const env = makeEnv(); // bewusst ohne env.PHOTOS — wie vor der R2-Einrichtung
  t.after(() => env.DB.close());
  const cookie = await setupAndLogin(env);

  await api(env, "POST", "/api/trips", { cookie, body: { id: "reise-1", name: "Testreise", start_at: "2026-08-09T08:00:00Z" } });
  await api(env, "POST", "/api/besuche", { cookie, body: { id: "besuch-1", title: "Rasthof", lat: 52.1, lon: 7.3 } });

  const bild = new File([new Uint8Array([1, 2, 3, 4])], "foto.jpg", { type: "image/jpeg" });

  // Ohne Besuch/Notiz-Bezug wird abgelehnt.
  const ohneBezug = new FormData();
  ohneBezug.set("file", bild);
  const antwortOhneBezug = await apiFormData(env, "POST", "/api/photos", { cookie, body: ohneBezug });
  assert.equal(antwortOhneBezug.status, 400);

  // Unbekannter Besuch wird abgelehnt.
  const unbekannterOrt = new FormData();
  unbekannterOrt.set("file", bild);
  unbekannterOrt.set("besuch_id", "nicht-da");
  const antwortUnbekannt = await apiFormData(env, "POST", "/api/photos", { cookie, body: unbekannterOrt });
  assert.equal(antwortUnbekannt.status, 404);

  // Kein Bild wird abgelehnt.
  const keinBild = new FormData();
  keinBild.set("file", new File([new Uint8Array([1])], "text.txt", { type: "text/plain" }));
  keinBild.set("besuch_id", "besuch-1");
  const antwortKeinBild = await apiFormData(env, "POST", "/api/photos", { cookie, body: keinBild });
  assert.equal(antwortKeinBild.status, 400);

  // Gültige Anfrage, aber R2 ist (noch) nicht eingerichtet — ehrliche 503,
  // kein stiller Erfolg und kein Absturz.
  const gueltig = new FormData();
  gueltig.set("file", bild);
  gueltig.set("besuch_id", "besuch-1");
  const antwortGueltig = await apiFormData(env, "POST", "/api/photos", { cookie, body: gueltig });
  assert.equal(antwortGueltig.status, 503);

  // Auflisten funktioniert auch ohne R2 (reine Metadaten) — hier: leer.
  const liste = await api(env, "GET", "/api/photos", { cookie });
  assert.equal(liste.status, 200);
  assert.deepEqual(liste.data, []);

  // Ohne Anmeldung nichts davon.
  const ohneSitzung = await api(env, "GET", "/api/photos");
  assert.equal(ohneSitzung.status, 401);
});

test("API-Integration: Benutzerverwaltung — erstes Konto wird Admin, Rechte, letzter Admin/Konto geschützt", async (t) => {
  const env = makeEnv();
  t.after(() => env.DB.close());
  // Eigene IP für den GANZEN Test (nicht nur den Login) — sonst teilt er
  // sich mit allen anderen Tests im selben Prozess den "unbekannt"-Zähler
  // der allgemeinen Lastbegrenzung (120 Anfragen/Minute, siehe takeToken in
  // api/router.js) und kann darüber fälschlich 429 statt der erwarteten
  // Statuscodes bekommen — der ganze Testlauf dauert unter einer Sekunde,
  // alle "unbekannt"-Anfragen der gesamten Datei konkurrieren also um
  // dasselbe 60-Sekunden-Fenster.
  const ip = { "cf-connecting-ip": "203.0.113.30" };
  const adminCookie = await setupAndLogin(env, "dirk", "erstes-passwort", ip);

  // Erstes (einziges) Konto wird beim ersten Zugriff automatisch Admin.
  const meAdmin = await api(env, "GET", "/api/auth/me", { cookie: adminCookie, headers: ip });
  assert.equal(meAdmin.data.isAdmin, true);

  const liste = await api(env, "GET", "/api/users", { cookie: adminCookie, headers: ip });
  assert.equal(liste.status, 200);
  assert.equal(liste.data.length, 1);
  assert.equal(liste.data[0].username, "dirk");
  assert.equal(liste.data[0].isAdmin, true);

  // Admin legt ein zweites, normales Konto an.
  const anlegen = await api(env, "POST", "/api/users", {
    cookie: adminCookie, headers: ip, body: { username: "beifahrer", password: "zweitespasswort" },
  });
  assert.equal(anlegen.status, 201);
  const zweiteId = anlegen.data.id;

  // Doppelter Benutzername wird abgewiesen.
  const doppelt = await api(env, "POST", "/api/users", {
    cookie: adminCookie, headers: ip, body: { username: "beifahrer", password: "irgendwas12" },
  });
  assert.equal(doppelt.status, 409);

  // Das neue Konto meldet sich an, sieht dieselben Daten, ist aber kein Admin.
  const zweiteLogin = await api(env, "POST", "/api/auth/login", { body: { username: "beifahrer", password: "zweitespasswort" }, headers: ip });
  assert.equal(zweiteLogin.status, 200);
  const meZweite = await api(env, "GET", "/api/auth/me", { cookie: zweiteLogin.cookie, headers: ip });
  assert.equal(meZweite.data.isAdmin, false);
  const verboten = await api(env, "GET", "/api/users", { cookie: zweiteLogin.cookie, headers: ip });
  assert.equal(verboten.status, 403);

  // Admin setzt das Passwort des zweiten Kontos neu — dessen Sitzung endet dabei.
  const pwReset = await api(env, "PATCH", `/api/users/${zweiteId}`, { cookie: adminCookie, headers: ip, body: { password: "drittespasswort" } });
  assert.equal(pwReset.status, 200);
  const alteSitzungTot = await api(env, "GET", "/api/trips", { cookie: zweiteLogin.cookie, headers: ip });
  assert.equal(alteSitzungTot.status, 401);
  const neuerLogin = await api(env, "POST", "/api/auth/login", { body: { username: "beifahrer", password: "drittespasswort" }, headers: ip });
  assert.equal(neuerLogin.status, 200);

  // Das eigene Konto lässt sich hier nicht löschen …
  const meIds = await api(env, "GET", "/api/users", { cookie: adminCookie, headers: ip });
  const eigeneId = meIds.data.find((u) => u.username === "dirk").id;
  const selbstLoeschen = await api(env, "DELETE", `/api/users/${eigeneId}`, { cookie: adminCookie, headers: ip });
  assert.equal(selbstLoeschen.status, 409);

  // … der letzte Admin auch nicht entmachtbar, solange er der einzige ist.
  const entmachten = await api(env, "PATCH", `/api/users/${eigeneId}`, { cookie: adminCookie, headers: ip, body: { isAdmin: false } });
  assert.equal(entmachten.status, 409);

  // Zweites Konto zum Admin befördern — jetzt sind es zwei, das erste darf entmachtet werden.
  const befoerdern = await api(env, "PATCH", `/api/users/${zweiteId}`, { cookie: adminCookie, headers: ip, body: { isAdmin: true } });
  assert.equal(befoerdern.status, 200);
  const entmachtenJetzt = await api(env, "PATCH", `/api/users/${eigeneId}`, { cookie: adminCookie, headers: ip, body: { isAdmin: false } });
  assert.equal(entmachtenJetzt.status, 200);

  // dirk hat jetzt keine Admin-Rechte mehr — sofort wirksam, ohne Neuanmeldung.
  const dirkOhneRechte = await api(env, "GET", "/api/users", { cookie: adminCookie, headers: ip });
  assert.equal(dirkOhneRechte.status, 403);

  // beifahrer (jetzt einziger Admin) darf dirk löschen (nicht sich selbst, dirk ist kein Admin, 2 Konten vorhanden).
  const loeschenOk = await api(env, "DELETE", `/api/users/${eigeneId}`, { cookie: neuerLogin.cookie, headers: ip });
  assert.equal(loeschenOk.status, 200);
  const nachher = await api(env, "GET", "/api/users", { cookie: neuerLogin.cookie, headers: ip });
  assert.equal(nachher.data.length, 1);

  // Jetzt ist beifahrer das letzte verbliebene Konto — auch der greift zuerst der Selbst-Schutz.
  const letztesKontoSelbst = await api(env, "DELETE", `/api/users/${zweiteId}`, { cookie: neuerLogin.cookie, headers: ip });
  assert.equal(letztesKontoSelbst.status, 409);
});

test("API-Integration: Kategorien/Fahrzeuge — Lesen für alle, Ändern nur für Admins", async (t) => {
  const env = makeEnv();
  t.after(() => env.DB.close());
  // Eigene IP für den ganzen Test (nicht nur den Login) — sonst teilt er sich
  // mit allen anderen Tests im selben Prozess den "unbekannt"-Zähler der
  // allgemeinen Lastbegrenzung (120 Anfragen/Minute) und kann darüber
  // fälschlich 429 statt der erwarteten Statuscodes bekommen.
  const ip = { "cf-connecting-ip": "203.0.113.40" };
  const adminCookie = await setupAndLogin(env, "dirk", "erstes-passwort", ip);
  await api(env, "POST", "/api/users", { cookie: adminCookie, body: { username: "beifahrer", password: "zweitespasswort" }, headers: ip });
  const login = await api(env, "POST", "/api/auth/login", { body: { username: "beifahrer", password: "zweitespasswort" }, headers: ip });
  const nutzerCookie = login.cookie;

  // Lesen funktioniert für beide.
  const kategorienAdmin = await api(env, "GET", "/api/categories", { cookie: adminCookie, headers: ip });
  assert.equal(kategorienAdmin.status, 200);
  const kategorienNutzer = await api(env, "GET", "/api/categories", { cookie: nutzerCookie, headers: ip });
  assert.equal(kategorienNutzer.status, 200);
  const fahrzeugeNutzer = await api(env, "GET", "/api/vehicles", { cookie: nutzerCookie, headers: ip });
  assert.equal(fahrzeugeNutzer.status, 200);

  // Ändern nur für Admins — der normale Nutzer bekommt 403.
  const kategorieAnlegenNutzer = await api(env, "POST", "/api/categories", { cookie: nutzerCookie, headers: ip, body: { name: "Test", color: "#123456", sort: 0 } });
  assert.equal(kategorieAnlegenNutzer.status, 403);
  const fahrzeugAnlegenNutzer = await api(env, "POST", "/api/vehicles", { cookie: nutzerCookie, headers: ip, body: { name: "Zweitwagen" } });
  assert.equal(fahrzeugAnlegenNutzer.status, 403);

  // Admin darf weiterhin.
  const kategorieAnlegenAdmin = await api(env, "POST", "/api/categories", { cookie: adminCookie, headers: ip, body: { name: "Test", color: "#123456", sort: 0 } });
  assert.equal(kategorieAnlegenAdmin.status, 201);
});

async function apiFormData(env, method, path, { body, cookie, headers = {} } = {}) {
  const reqHeaders = new Headers(headers);
  if (cookie) reqHeaders.set("cookie", cookie);
  const response = await handle(new Request(`https://vojago.test${path}`, { method, headers: reqHeaders, body }), env);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { response, status: response.status, data };
}

/* ---------------- Eigene Positionsquelle (Phase 2, LOCAL_POSITIONS) ---------------- */
// D1Memory lädt bewusst nur api/schema.sql (das echte Cloudflare-D1-Schema,
// ohne positions-Tabelle) — genau das bildet ab, dass env.LOCAL_POSITIONS auf
// Cloudflare nie gesetzt ist. Für diesen Test legen wir die Tabelle hier
// selbst an, wie es sonst db/schema.sql für den Selbst-Hosting-Betrieb tut.
async function seedPositions(env, deviceId, punkte) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, at INTEGER NOT NULL,
      lat REAL NOT NULL, lon REAL NOT NULL, speed_kmh REAL, course REAL, altitude REAL,
      sats INTEGER, ignition INTEGER, motion INTEGER, protocol TEXT NOT NULL, created_at INTEGER NOT NULL
    )`
  ).run();
  for (const p of punkte) {
    await env.DB.prepare(
      "INSERT INTO positions (device_id, at, lat, lon, speed_kmh, protocol, created_at) VALUES (?,?,?,?,?,?,?)"
    ).bind(deviceId, p.at, p.lat, p.lon, p.speedKmh ?? 0, "test", p.at).run();
  }
}

test("LOCAL_POSITIONS: /api/positions, /api/route, /api/drives, /api/stops kommen aus der eigenen Tabelle", async (t) => {
  const env = makeEnv({ LOCAL_POSITIONS: "1" });
  t.after(() => env.DB.close());
  // Eigene IP auch fürs Setup selbst (nicht über setupAndLogin, das läuft
  // ohne IP-Header über den geteilten "unbekannt"-Zähler, der von den vielen
  // anderen Tests im selben Lauf schon ausgeschöpft sein kann).
  const ip = { "cf-connecting-ip": "203.0.113.50" };
  const setup = await api(env, "POST", "/api/auth/setup", { headers: ip, body: { username: "dirk", password: "langgenug1" } });
  assert.equal(setup.status, 201);
  const cookie = setup.cookie;

  const t0 = Date.UTC(2026, 7, 16, 10, 0, 0);
  const min = 60_000;
  await seedPositions(env, "geraet1", [
    { at: t0, lat: 52.0, lon: 7.0, speedKmh: 0 },
    { at: t0 + 5 * min, lat: 52.0001, lon: 7.0001, speedKmh: 0 },
    { at: t0 + 10 * min, lat: 52.01, lon: 7.01, speedKmh: 40 },
    { at: t0 + 15 * min, lat: 52.02, lon: 7.02, speedKmh: 0 },
  ]);

  const positions = await api(env, "GET", "/api/positions?deviceId=geraet1", { cookie, headers: ip });
  assert.equal(positions.status, 200);
  assert.equal(positions.data.length, 1);
  assert.equal(positions.data[0].latitude, 52.02);
  assert.equal(positions.data[0].longitude, 7.02);

  const von = new Date(t0 - min).toISOString();
  const bis = new Date(t0 + 20 * min).toISOString();

  const route = await api(env, "GET", `/api/route?deviceId=geraet1&from=${von}&to=${bis}`, { cookie, headers: ip });
  assert.equal(route.status, 200);
  assert.equal(route.data.length, 4);
  assert.equal(route.data[0].latitude, 52.0);

  const drives = await api(env, "GET", `/api/drives?deviceId=geraet1&from=${von}&to=${bis}`, { cookie, headers: ip });
  assert.equal(drives.status, 200);
  assert.equal(drives.data.length, 1);
  assert.ok(drives.data[0].distance > 0);

  const stops = await api(env, "GET", `/api/stops?deviceId=geraet1&from=${von}&to=${bis}`, { cookie, headers: ip });
  assert.equal(stops.status, 200);
  assert.equal(stops.data.length, 1); // nur der Stopp VOR der Fahrt liegt vollständig im Zeitraum
  assert.equal(stops.data[0].startTime, new Date(t0).toISOString());

  const devices = await api(env, "GET", "/api/devices", { cookie, headers: ip });
  assert.equal(devices.status, 200);
  assert.equal(devices.data.length, 1);
  assert.equal(devices.data[0].id, "geraet1");
});

test("LOCAL_POSITIONS: unbekanntes Gerät liefert leere Listen statt Fehler", async (t) => {
  const env = makeEnv({ LOCAL_POSITIONS: "1" });
  t.after(() => env.DB.close());
  const ip = { "cf-connecting-ip": "203.0.113.51" };
  const setup = await api(env, "POST", "/api/auth/setup", { headers: ip, body: { username: "dirk", password: "langgenug1" } });
  assert.equal(setup.status, 201);
  const cookie = setup.cookie;
  await seedPositions(env, "irrelevant", []);

  const positions = await api(env, "GET", "/api/positions?deviceId=unbekannt", { cookie, headers: ip });
  assert.equal(positions.status, 200);
  assert.deepEqual(positions.data, []);

  const route = await api(env, "GET", "/api/route?deviceId=unbekannt&from=2026-01-01&to=2026-01-02", { cookie, headers: ip });
  assert.equal(route.status, 200);
  assert.deepEqual(route.data, []);
});

/* ---------------- Sitzungscookie über reines HTTP (Selbst-Hosting) ---------------- */
// Live gefunden am 16. August 2026: app-backend läuft (noch) über reines
// HTTP, nicht HTTPS. Ein Cookie mit "Secure" wird vom Browser über HTTP nie
// gesendet (RFC 6265) — Login/Setup lief scheinbar durch (die Sitzung wurde
// angelegt), aber jede folgende Anfrage kam ohne Cookie an: 401 überall.
test("Sitzungscookie über HTTP: kein 'Secure', Anmeldung bleibt über weitere Anfragen gültig", async (t) => {
  const env = makeEnv();
  t.after(() => env.DB.close());
  const ip = { "cf-connecting-ip": "203.0.113.60" };

  // Eigene, minimale Anfrage statt der geteilten api()-Hilfsfunktion — die
  // baut ihre Anfragen bewusst immer mit https:// (repräsentiert den
  // Cloudflare-Regelfall). Hier geht es genau um den http://-Fall.
  const setupReq = new Request("http://192.168.1.50:8081/api/auth/setup", {
    method: "POST",
    headers: new Headers({ ...ip, "content-type": "application/json" }),
    body: JSON.stringify({ username: "dirk", password: "langgenug1" }),
  });
  const setupRes = await handle(setupReq, env);
  assert.equal(setupRes.status, 201);
  const setCookie = setupRes.headers.get("set-cookie");
  assert.ok(setCookie.includes("HttpOnly"));
  assert.ok(!setCookie.includes("Secure"), "Secure darf über HTTP nicht gesetzt sein, sonst verwirft der Browser das Cookie");
  const cookie = setCookie.split(";")[0];

  // Genau der Fehler, der live beobachtet wurde: eine Folgeanfrage mit
  // genau diesem Cookie muss jetzt tatsächlich als angemeldet durchgehen.
  const tripsReq = new Request("http://192.168.1.50:8081/api/trips", {
    headers: new Headers({ ...ip, cookie }),
  });
  const tripsRes = await handle(tripsReq, env);
  assert.equal(tripsRes.status, 200);
});

test("Sitzungscookie über HTTPS bleibt unverändert 'Secure' (Cloudflare-Regelfall)", async (t) => {
  const env = makeEnv();
  t.after(() => env.DB.close());
  const ip = { "cf-connecting-ip": "203.0.113.61" };
  const setupReq = new Request("https://vojago.test/api/auth/setup", {
    method: "POST",
    headers: new Headers({ ...ip, "content-type": "application/json" }),
    body: JSON.stringify({ username: "dirk", password: "langgenug1" }),
  });
  const setupRes = await handle(setupReq, env);
  assert.ok(setupRes.headers.get("set-cookie").includes("Secure"));
});

/* ---------------- /api/health mit LOCAL_POSITIONS ---------------- */
// Live gefunden am 16. August 2026: /api/health prüfte immer Traccar,
// TRACCAR_URL ist im Selbst-Hosting-Betrieb aber bewusst nicht gesetzt —
// zeigte fälschlich "Traccar: nicht erreichbar" an, obwohl gar nicht mehr
// über Traccar gearbeitet wird.
test("/api/health: mit LOCAL_POSITIONS wird die eigene positions-Tabelle berichtet, nicht Traccar", async (t) => {
  const env = makeEnv({ LOCAL_POSITIONS: "1" });
  t.after(() => env.DB.close());
  const ip = { "cf-connecting-ip": "203.0.113.62" };
  const setup = await api(env, "POST", "/api/auth/setup", { headers: ip, body: { username: "dirk", password: "langgenug1" } });
  await seedPositions(env, "geraet1", [{ at: Date.now(), lat: 52, lon: 7 }]);

  const health = await api(env, "GET", "/api/health", { cookie: setup.cookie, headers: ip });
  assert.equal(health.status, 200);
  assert.equal(health.data.positionsQuelle, "lokal");
  assert.equal(health.data.geraete, 1);
  assert.equal(health.data.positionen, 1);
  assert.equal(health.data.traccar, undefined); // kein irreführender Traccar-Status mehr
});

test("/api/health: ohne LOCAL_POSITIONS bleibt der bisherige Traccar-Status unverändert", async (t) => {
  const env = makeEnv();
  t.after(() => env.DB.close());
  const ip = { "cf-connecting-ip": "203.0.113.63" };
  const setup = await api(env, "POST", "/api/auth/setup", { headers: ip, body: { username: "dirk", password: "langgenug1" } });

  const health = await api(env, "GET", "/api/health", { cookie: setup.cookie, headers: ip });
  assert.equal(health.status, 200);
  assert.equal(health.data.traccar, "nicht erreichbar"); // TRACCAR_URL fehlt in diesem Test bewusst
  assert.equal(health.data.positionsQuelle, undefined);
});

test("API-Integration: Push-Benachrichtigung — öffentlicher Schlüssel und Abo-Verwaltung", async (t) => {
  const ip = { "cf-connecting-ip": "203.0.113.64" };

  // Ohne konfigurierten VAPID-Schlüssel ehrlich "nicht eingerichtet", nicht
  // stillschweigend ein leerer/falscher Wert.
  const envOhne = makeEnv();
  t.after(() => envOhne.DB.close());
  const cookieOhne = await setupAndLogin(envOhne, "dirk", "langgenug1", ip);
  const ohneSchluessel = await api(envOhne, "GET", "/api/push-public-key", { cookie: cookieOhne, headers: ip });
  assert.equal(ohneSchluessel.status, 503);

  const env = makeEnv({ VAPID_PUBLIC_KEY: "test-oeffentlicher-schluessel" });
  t.after(() => env.DB.close());
  const ip2 = { "cf-connecting-ip": "203.0.113.65" };
  const cookie = await setupAndLogin(env, "dirk", "langgenug1", ip2);

  const schluessel = await api(env, "GET", "/api/push-public-key", { cookie, headers: ip2 });
  assert.equal(schluessel.status, 200);
  assert.equal(schluessel.data.key, "test-oeffentlicher-schluessel");

  const ohneFelder = await api(env, "POST", "/api/push-subscriptions", { cookie, headers: ip2, body: { endpoint: "https://push.example/x" } });
  assert.equal(ohneFelder.status, 400);

  const angemeldet = await api(env, "POST", "/api/push-subscriptions", {
    cookie, headers: ip2,
    body: { endpoint: "https://push.example/abc", keys: { p256dh: "p256dh-wert", auth: "auth-wert" } },
  });
  assert.equal(angemeldet.status, 201);
  assert.ok(angemeldet.data.id);

  // Erneutes Abo mit demselben endpoint ersetzt statt einen Duplikat-Fehler zu werfen.
  const erneut = await api(env, "POST", "/api/push-subscriptions", {
    cookie, headers: ip2,
    body: { endpoint: "https://push.example/abc", keys: { p256dh: "neuer-wert", auth: "auth-wert" } },
  });
  assert.equal(erneut.status, 201);

  const geloescht = await api(env, "DELETE", `/api/push-subscriptions/${angemeldet.data.id}`, { cookie, headers: ip2 });
  assert.equal(geloescht.status, 200);

  // Ohne Anmeldung geht gar nichts — wie der Rest der API.
  const ohneAnmeldung = await api(env, "POST", "/api/push-subscriptions", {
    headers: ip2, body: { endpoint: "https://push.example/xyz", keys: { p256dh: "p", auth: "a" } },
  });
  assert.equal(ohneAnmeldung.status, 401);
});

/* ---------------- Tagebuch ---------------- */
const apiBasis = api;
const formBasis = apiFormData;

function fotoSpeicher() {
  const objekte = new Map();
  return {
    objekte,
    put: async (key, daten) => { objekte.set(key, daten); },
    delete: async (key) => { objekte.delete(key); },
    get: async (key) => (objekte.has(key) ? { body: objekte.get(key), httpMetadata: { contentType: "image/jpeg" } } : null),
  };
}

test("API-Integration: Tagebuch — anlegen, überschreiben, Fotos anhängen, löschen", async (t) => {
  const speicher = fotoSpeicher();
  const env = makeEnv({ PHOTOS: speicher });
  t.after(() => env.DB.close());
  // Eigene IP: die allgemeine Lastbegrenzung zählt je Adresse, und alle Tests dieser Datei teilen sich sonst "unbekannt".
  const ip = { "cf-connecting-ip": "203.0.113.41" };
  const cookie = await setupAndLogin(env, "dirk", "langgenug1", ip);
  const api = (e, m, p, o = {}) => apiBasis(e, m, p, { ...o, headers: { ...ip, ...(o.headers || {}) } });
  const apiFormData = (e, m, p, o = {}) => formBasis(e, m, p, { ...o, headers: ip });
  await api(env, "POST", "/api/trips", { cookie, body: { id: "reise-t", name: "Tagebuchreise", start_at: "2026-07-12T06:00:00Z" } });

  const ohneSitzung = await api(env, "GET", "/api/tagebuch");
  assert.equal(ohneSitzung.status, 401);

  const leer = await api(env, "GET", "/api/tagebuch", { cookie });
  assert.deepEqual(leer.data, []);

  const schlecht = await api(env, "PUT", "/api/tagebuch", { cookie, body: { trip_id: "reise-t", day_key: "gestern", blocks: [] } });
  assert.equal(schlecht.status, 400);
  const unbekannteReise = await api(env, "PUT", "/api/tagebuch", { cookie, body: { trip_id: "nicht-da", day_key: "2026-07-14", blocks: [] } });
  assert.equal(unbekannteReise.status, 404);

  const erster = await api(env, "PUT", "/api/tagebuch", { cookie, body: { trip_id: "reise-t", day_key: "2026-07-14", blocks: [{ t: "text", text: "Früh los." }] } });
  assert.equal(erster.status, 201);
  assert.equal(erster.data.neu, true);
  const id = erster.data.id;

  // Dasselbe (Reise, Tag) noch einmal: überschreibt den Eintrag, legt keinen zweiten an.
  const zweiter = await api(env, "PUT", "/api/tagebuch", { cookie, body: { trip_id: "reise-t", day_key: "2026-07-14", blocks: [{ t: "text", text: "Früh los und Kaffee." }] } });
  assert.equal(zweiter.status, 200);
  assert.equal(zweiter.data.neu, false);
  assert.equal(zweiter.data.id, id);

  const liste = await api(env, "GET", "/api/tagebuch", { cookie });
  assert.equal(liste.data.length, 1);
  assert.equal(liste.data[0].author, "dirk");
  assert.deepEqual(JSON.parse(liste.data[0].blocks), [{ t: "text", text: "Früh los und Kaffee." }]);

  // Foto an den Eintrag hängen.
  const bild = new File([new Uint8Array([1, 2, 3, 4])], "foto.jpg", { type: "image/jpeg" });
  const form = new FormData();
  form.set("file", bild);
  form.set("tagebuch_id", id);
  const hoch = await apiFormData(env, "POST", "/api/photos", { cookie, body: form });
  assert.equal(hoch.status, 201);
  const unbekannt = new FormData();
  unbekannt.set("file", bild);
  unbekannt.set("tagebuch_id", "nicht-da");
  assert.equal((await apiFormData(env, "POST", "/api/photos", { cookie, body: unbekannt })).status, 404);

  const fotos = await api(env, "GET", "/api/photos", { cookie });
  assert.equal(fotos.data.length, 1);
  assert.equal(fotos.data[0].tagebuch_id, id);
  assert.equal(speicher.objekte.size, 1);

  // Eintrag löschen nimmt seine Fotos samt Bilddatei mit.
  const weg = await api(env, "DELETE", `/api/tagebuch/${id}`, { cookie });
  assert.equal(weg.status, 200);
  assert.deepEqual((await api(env, "GET", "/api/tagebuch", { cookie })).data, []);
  assert.deepEqual((await api(env, "GET", "/api/photos", { cookie })).data, []);
  assert.equal(speicher.objekte.size, 0);
});

test("API-Integration: Tagebuch über den Freigabe-Link — nur mit Logbuch, nur zur freigegebenen Reise", async (t) => {
  const env = makeEnv({ PHOTOS: fotoSpeicher() });
  t.after(() => env.DB.close());
  const verwalter = { "cf-connecting-ip": "203.0.113.42" };
  const cookie = await setupAndLogin(env, "dirk", "langgenug1", verwalter);
  const api = (e, m, p, o = {}) => apiBasis(e, m, p, { ...o, headers: { ...verwalter, ...(o.headers || {}) } });
  const apiFormData = (e, m, p, o = {}) => formBasis(e, m, p, { ...o, headers: verwalter });
  await api(env, "POST", "/api/trips", { cookie, body: { id: "reise-x", name: "Freigegeben", start_at: "2026-07-12T06:00:00Z", end_at: "2026-07-20T06:00:00Z" } });
  await api(env, "POST", "/api/trips", { cookie, body: { id: "reise-y", name: "Andere", start_at: "2026-08-01T06:00:00Z", end_at: "2026-08-05T06:00:00Z" } });
  const eintragX = await api(env, "PUT", "/api/tagebuch", { cookie, body: { trip_id: "reise-x", day_key: "2026-07-13", blocks: [{ t: "text", text: "Bei Oma." }] } });
  const eintragY = await api(env, "PUT", "/api/tagebuch", { cookie, body: { trip_id: "reise-y", day_key: "2026-08-02", blocks: [{ t: "text", text: "Geheim." }] } });
  const form = new FormData();
  form.set("file", new File([new Uint8Array([9, 9])], "f.jpg", { type: "image/jpeg" }));
  form.set("tagebuch_id", eintragX.data.id);
  // Aufnahmezeit weit außerhalb der Reise: das Foto gehört trotzdem über seinen Eintrag dazu.
  form.set("taken_at", "2020-01-01T10:00:00Z");
  const foto = await apiFormData(env, "POST", "/api/photos", { cookie, body: form });
  assert.equal(foto.status, 201);

  const nurKarte = await api(env, "POST", "/api/shares", { cookie, body: { tripId: "reise-x", scope: "karte" } });
  const mitLogbuch = await api(env, "POST", "/api/shares", { cookie, body: { tripId: "reise-x", scope: "karte_logbuch" } });
  const ip = { "cf-connecting-ip": "203.0.113.77" };

  const karte = await api(env, "GET", `/api/share/${nurKarte.data.token}`, { headers: ip });
  assert.deepEqual(karte.data.tagebuch, [], "ohne Logbuch-Umfang kein Tagebuch");

  const logbuch = await api(env, "GET", `/api/share/${mitLogbuch.data.token}`, { headers: ip });
  assert.equal(logbuch.data.tagebuch.length, 1);
  assert.equal(logbuch.data.tagebuch[0].id, eintragX.data.id);
  assert.equal(logbuch.data.photos.length, 1);
  assert.equal(logbuch.data.photos[0].tagebuch_id, eintragX.data.id);
  assert.ok(!logbuch.data.tagebuch.some((e) => e.id === eintragY.data.id), "Eintrag einer anderen Reise bleibt privat");

  const ausgeliefert = await handle(new Request(`https://vojago.test/api/share/${mitLogbuch.data.token}/photos/${foto.data.id}`, { headers: ip }), env);
  assert.equal(ausgeliefert.status, 200);
  const nurKarteFoto = await handle(new Request(`https://vojago.test/api/share/${nurKarte.data.token}/photos/${foto.data.id}`, { headers: ip }), env);
  assert.equal(nurKarteFoto.status, 403);
});

test("API-Integration: Tagebuch — bestehende Datenbank ohne photos.tagebuch_id wird einmalig nachgerüstet", async (t) => {
  const env = makeEnv({ PHOTOS: fotoSpeicher() });
  t.after(() => env.DB.close());
  const ip = { "cf-connecting-ip": "203.0.113.43" };
  const cookie = await setupAndLogin(env, "dirk", "langgenug1", ip);
  const a = (m, p, o = {}) => apiBasis(env, m, p, { ...o, headers: ip });
  await a("POST", "/api/trips", { cookie, body: { id: "reise-alt", name: "Alt", start_at: "2026-07-12T06:00:00Z" } });
  await a("POST", "/api/besuche", { cookie, body: { id: "besuch-alt", title: "Platz", lat: 50, lon: 8 } });

  // Zustand vor dem Update nachbauen: photos ohne tagebuch_id, keine Tagebuch-Tabelle, ein vorhandenes Foto.
  env.DB.db.exec("PRAGMA foreign_keys = OFF");
  env.DB.db.exec("DROP TABLE photos; DROP TABLE tagebuch;");
  env.DB.db.exec(`CREATE TABLE photos (
    id TEXT PRIMARY KEY, besuch_id TEXT REFERENCES besuche(id) ON DELETE CASCADE,
    note_id TEXT REFERENCES notes(id) ON DELETE CASCADE, r2_key TEXT NOT NULL, taken_at TEXT,
    lat REAL, lon REAL, width INTEGER, height INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  env.DB.db.exec("INSERT INTO photos (id, besuch_id, r2_key) VALUES ('altes-foto', 'besuch-alt', 'fotos/altes-foto.jpg')");
  env.DB.db.exec("PRAGMA foreign_keys = ON");

  // Der erste Zugriff auf das Tagebuch rüstet nach — das alte Foto bleibt erhalten.
  const liste = await a("GET", "/api/tagebuch", { cookie });
  assert.equal(liste.status, 200);
  assert.deepEqual(liste.data, []);
  const fotos = await a("GET", "/api/photos", { cookie });
  assert.equal(fotos.data.length, 1);
  assert.equal(fotos.data[0].id, "altes-foto");
  assert.equal(fotos.data[0].tagebuch_id, null);

  const eintrag = await a("PUT", "/api/tagebuch", { cookie, body: { trip_id: "reise-alt", day_key: "2026-07-13", blocks: [] } });
  assert.equal(eintrag.status, 201);
  // Zweiter Aufruf der Nachrüstung ist harmlos (idempotent).
  assert.equal((await a("GET", "/api/tagebuch", { cookie })).data.length, 1);
});
