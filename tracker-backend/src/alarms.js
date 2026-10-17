// Geofence-Wache — bewusst hier im ingest-Container, nicht im app-Container:
// das Verlassen des überwachten Bereichs muss UNMITTELBAR erkannt werden
// (Diebstahlschutz, Zeitnähe zählt), nicht erst beim nächsten periodischen
// Durchlauf. ingest sieht jede neue Position als Erstes, deshalb hier.
//
// Bewusst KEIN Zonen-Konzept (vorher anzulegende, benannte Zonen): Für den
// Diebstahlschutz reicht ein einziger Ankerpunkt — die Position beim
// Scharfschalten ("Camper abstellen, Wache scharf schalten"). api/router.js schreibt bei jedem Schaft-
// schalten genau eine Zeile in geofences (fester Datensatz "wache-aktuell",
// siehe dort) — hier wird nur noch dieser eine, aktive Ankerpunkt gelesen.
//
// Spannungs-/Stromausfall-Alarme (undervoltage/powercut) bewusst NICHT
// gebaut — die nötigen Rohdaten (Teltonika-IO 66/67) werden aktuell gar
// nicht erfasst (siehe protocols/teltonika-codec.js). Nur geofence.
import { db } from "./store.js";
import { sendePushAnAlle } from "./push.js";

/** SQLite-`datetime('now')`-kompatibles Format (Leerzeichen, kein "T"/"Z",
 * keine Millisekunden) — alarm_log.occurred_at ist TEXT, gemischte Formate
 * würden beim Sortieren (ORDER BY occurred_at) durcheinandergeraten. */
function alsSqliteDatum(unixMs) {
  return new Date(unixMs).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function haversineMeter(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// Die zwei Positionen zeitlich unmittelbar vor der aktuellen (jüngste zuerst)
// — für die Entprellung in pruefeZonenwechsel(). Nach Fix-Zeit, nicht nach
// Einfügereihenfolge: nachgelieferte Pakete treffen nicht in zeitlicher
// Reihenfolge ein (echter Fund, 11. Oktober 2026).
const holeVorherigePositionen = db.prepare(
  "SELECT lat, lon FROM positions WHERE device_id = ? AND at < ? ORDER BY at DESC LIMIT 2"
);
const holeLetztePosition = db.prepare(
  "SELECT at, lat, lon FROM positions WHERE device_id = ? ORDER BY at DESC LIMIT 1"
);
// Gezielt der Wache-Anker, NICHT "irgendeine aktive Zone": In der Tabelle
// liegen aus der früheren Zonen-Verwaltung noch alte Einträge (z. B.
// "Zuhause"). Ein ungezieltes "LIMIT 1" lieferte die älteste Zeile — die
// Wache wurde deshalb nie gegen den beim Scharfschalten gesetzten Anker
// geprüft, sondern gegen "Zuhause" (echter Fund, 28. September 2026:
// "Bereich wieder betreten" bei der Heimkehr, obwohl die Wache woanders stand).
const WACHE_ZONE_ID = "wache-aktuell";
const holeAktivenAnker = db.prepare("SELECT * FROM geofences WHERE id = ? AND active = 1");
// Letzter gemeldeter Zustand: entweder eine Zonen-Meldung oder das (Neu-)
// Scharfschalten, das den Zustand auf "drinnen" zurücksetzt.
const holeLetztenZustand = db.prepare(
  `SELECT message FROM alarm_log
   WHERE type = 'geofence' AND (message LIKE 'Fahrzeug hat den überwachten Bereich%' OR message LIKE 'Wache scharf%')
   ORDER BY id DESC LIMIT 1`
);
const holeGeofenceEinstellung = db.prepare("SELECT enabled FROM alarm_settings WHERE key = 'geofence'");
const schreibeAlarm = db.prepare(
  "INSERT INTO alarm_log (type, severity, message, occurred_at) VALUES (?,?,?,?)"
);

/**
 * Prüft eine gerade gespeicherte Position gegen den beim Scharfschalten
 * gemerkten Ankerpunkt, verglichen mit der unmittelbar vorherigen Position
 * desselben Geräts. Schreibt bei einem Wechsel sofort in alarm_log — kein
 * Nachlauf, kein Batch, keine separate Zustands-Tabelle (bei der geringen
 * Positionsrate hier reicht der direkte Vergleich zweier aufeinander-
 * folgender Punkte).
 *
 * Der Ankerpunkt ist bewusst global (keine Gerätezuordnung im Schema) —
 * gilt für jedes eingehende Gerät gleich, wie geofences aktuell modelliert
 * ist.
 *
 * @param {{id: number, deviceId: string, at: number, lat: number, lon: number}} position
 */
export function pruefeZonenwechsel(position) {
  const einstellung = holeGeofenceEinstellung.get();
  if (!einstellung?.enabled) return; // "Wache unscharf" — nichts zu tun
  planeRuhePruefung(position.deviceId); // bei JEDER Meldung neu — gilt, wenn danach Stille herrscht

  const [vorherige, vorvorherige] = holeVorherigePositionen.all(position.deviceId, position.at);
  if (!vorherige || !vorvorherige) return; // die ersten beiden Positionen eines Geräts — kein Vergleich möglich

  const anker = holeAktivenAnker.get(WACHE_ZONE_ID);
  if (!anker) return; // scharf, aber (noch) kein Ankerpunkt bekannt — kann bei korrektem Scharfschalten (siehe api/router.js) eigentlich nicht vorkommen

  const drinnen = (p) => haversineMeter(p, anker) <= anker.radius_m;
  const drinnenJetzt = drinnen(position);
  const drinnenVorher = drinnen(vorherige);
  const drinnenDavor = drinnen(vorvorherige);
  // Entprellt: ein Wechsel zählt erst, wenn der neue Zustand bei zwei
  // aufeinanderfolgenden Positionen gilt. Ein einzelner GPS-Ausreißer am
  // Rand des Radius (rein-raus-rein binnen Sekunden, so im Protokoll vom
  // 21. September 2026) löst dadurch keinen Alarm aus.
  const verlassen = drinnenDavor && !drinnenVorher && !drinnenJetzt;
  // "Wieder betreten" nur nach einem gemeldeten "verlassen" — sonst würde der
  // Ausreißer selbst (raus-rein-rein) als Verlassen gelten und die
  // Rückkehr fälschlich gemeldet.
  const betreten = !drinnenDavor && drinnenVorher && drinnenJetzt
    && /verlassen/.test(holeLetztenZustand.get()?.message || "");
  if (!verlassen && !betreten) return;

  meldeWechsel(verlassen ? "verlassen" : "betreten", position.at, true);
}

function meldeWechsel(art, atMs, mitPush) {
  const zeitpunkt = alsSqliteDatum(atMs);
  if (art === "verlassen") {
    const nachricht = "Fahrzeug hat den überwachten Bereich verlassen";
    schreibeAlarm.run("geofence", "warn", nachricht, zeitpunkt);
    if (mitPush) sendePushAnAlle("Wache", nachricht); // Diebstahlschutz — hier zählt Zeitnähe, deshalb sofort
  } else {
    const nachricht = "Fahrzeug hat den überwachten Bereich wieder betreten";
    schreibeAlarm.run("geofence", "ok", nachricht, zeitpunkt);
    if (mitPush) sendePushAnAlle("Wache", nachricht);
  }
}

// ── Stille nach der letzten Meldung ──────────────────────────────────────
// Die Entprellung braucht zwei Positionen in Folge im neuen Zustand. Parkt das
// Fahrzeug nach der ersten Position im Radius und der Router verstummt (echter
// Fund, 10. Oktober 2026: Heimkehr, danach Stille), käme die zweite nie — das
// Protokoll bliebe auf "verlassen", obwohl das Fahrzeug längst zuhause steht.
// Deshalb gilt der Zustand der LETZTEN Meldung als bestätigt, sobald eine
// Weile nichts mehr nachkommt.
const RUHE_BIS_BESTAETIGUNG_MS = 3 * 60_000;
// Für "verlassen" nach Stille nur ein klar draußen liegender Punkt: ein
// einzelner GPS-Ausreißer am Rand eines parkenden Fahrzeugs soll keinen
// Alarm auslösen, ein abgezogener Router bei echtem Wegfahren aber schon.
const KLAR_DRAUSSEN_FAKTOR = 1.5;
// Eine nachgeholte Meldung ist kein "jetzt": Push nur, wenn sie frisch ist.
const MAX_PUSH_ALTER_MS = 30 * 60_000;
const ruheTimerJeGeraet = new Map();

function planeRuhePruefung(deviceId) {
  clearTimeout(ruheTimerJeGeraet.get(deviceId));
  const timer = setTimeout(() => {
    ruheTimerJeGeraet.delete(deviceId);
    try { pruefeZonenzustandNachRuhe(deviceId); } catch (err) { console.error("[alarms] Ruheprüfung fehlgeschlagen:", err); }
  }, RUHE_BIS_BESTAETIGUNG_MS);
  timer.unref?.();
  ruheTimerJeGeraet.set(deviceId, timer);
}

/** Bestätigt den Zustand der letzten bekannten Position eines Geräts, auch
 * ohne zweiten Punkt. Idempotent: stimmt der zuletzt protokollierte Zustand
 * schon, passiert nichts. Wird nach Stille (planeRuhePruefung) und einmal
 * beim Serverstart aufgerufen (holt nach, was vor einem Neustart offen blieb). */
export function pruefeZonenzustandNachRuhe(deviceId, jetzt = Date.now()) {
  if (!holeGeofenceEinstellung.get()?.enabled) return;
  const anker = holeAktivenAnker.get(WACHE_ZONE_ID);
  const letzte = holeLetztePosition.get(deviceId);
  if (!anker || !letzte) return;

  const protokollDraussen = /verlassen/.test(holeLetztenZustand.get()?.message || "");
  const abstand = haversineMeter(letzte, anker);
  const frisch = jetzt - letzte.at <= MAX_PUSH_ALTER_MS;
  if (protokollDraussen && abstand <= anker.radius_m) {
    meldeWechsel("betreten", letzte.at, frisch);
  } else if (!protokollDraussen && abstand > anker.radius_m * KLAR_DRAUSSEN_FAKTOR) {
    meldeWechsel("verlassen", letzte.at, frisch);
  }
}

/** Beim Serverstart: für jedes Gerät mit Positionen den Zustand nachprüfen. */
export function pruefeAlleZonenzustaende() {
  const geraete = db.prepare("SELECT DISTINCT traccar_device_id AS id FROM vehicles WHERE traccar_device_id IS NOT NULL AND traccar_device_id != ''").all();
  for (const { id } of geraete) pruefeZonenzustandNachRuhe(id);
}
