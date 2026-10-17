// Web-Push-Versand für die Wache (siehe alarms.js) — eigenes Modul, damit
// alarms.js bei der Zonen-Erkennung bleibt und sich nicht mit Abo-Verwaltung/
// Versand vermischt. Bewusst Web Push statt eines Drittanbieter-Diensts
// (Firebase o. Ä.): kein externes Konto nötig, funktioniert direkt mit der
// bereits als PWA installierten App.
//
// Läuft hier im ingest-Container, nicht im app-Container: ingest sieht den
// Zonen-Wechsel als Erstes (siehe pruefeZonenwechsel() in alarms.js) — kein
// Umweg über den anderen Container nötig, um sofort zu benachrichtigen.
import webpush from "web-push";
import { db } from "./store.js";

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
const oeffentlicherSchluessel = process.env.VAPID_PUBLIC_KEY;
const privaterSchluessel = process.env.VAPID_PRIVATE_KEY;
const eingerichtet = Boolean(oeffentlicherSchluessel && privaterSchluessel);

if (eingerichtet) {
  webpush.setVapidDetails(VAPID_SUBJECT, oeffentlicherSchluessel, privaterSchluessel);
} else {
  // Kein Fehler, kein Absturz — Push ist eine optionale Zusatzfunktion,
  // die Zonen-Erkennung selbst funktioniert unabhängig davon weiter
  // (alarm_log wird so oder so beschrieben, siehe alarms.js).
  console.warn("[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY nicht gesetzt — Push-Benachrichtigungen sind deaktiviert.");
}

const holeAbos = db.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions");
const loescheAbo = db.prepare("DELETE FROM push_subscriptions WHERE id = ?");

/**
 * Verschickt eine Push-Benachrichtigung an alle angemeldeten Geräte.
 * Bewusst "fire and forget" (keine Aufrufstelle wartet darauf) — ein
 * einzelnes langsames oder fehlgeschlagenes Gerät soll die Zonen-Erkennung
 * nie verzögern oder blockieren; alarm_log ist zu diesem Zeitpunkt schon
 * geschrieben.
 */
export function sendePushAnAlle(titel, text) {
  if (!eingerichtet) return;
  for (const abo of holeAbos.all()) {
    const subscription = { endpoint: abo.endpoint, keys: { p256dh: abo.p256dh, auth: abo.auth } };
    webpush.sendNotification(subscription, JSON.stringify({ title: titel, body: text })).catch((err) => {
      // 404/410 = das Abo ist beim Push-Dienst nicht mehr gültig (Browser
      // abgemeldet, Gerät zurückgesetzt, App neu installiert, ...) —
      // aufräumen, statt bei jedem künftigen Alarm erneut erfolglos zu
      // versuchen.
      if (err.statusCode === 404 || err.statusCode === 410) loescheAbo.run(abo.id);
      else console.error(`[push] Senden an Abo ${abo.id} fehlgeschlagen:`, err.message);
    });
  }
}
