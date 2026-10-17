// Ansicht „Wache": Scharf/unscharf, Überwachungsradius, Alarm-Protokoll.
//
// Bewusst KEINE vorher anzulegenden, benannten Zonen (frühere Fassung
// hatte eine Zonen-Liste mit CRUD): für den Diebstahlschutz-Anwendungsfall
// braucht es nur EINEN Ankerpunkt — die aktuelle Position beim
// Scharfschalten selbst. Das ersetzt Name/Liste/Verwaltung durch
// einen einzigen Radius-Wert..
//
// Bordspannung/Stromausfall bewusst nicht gebaut (RUTX50 meldet keine
// Bordspannung).
//
// Im Demo-Modus (nicht angemeldet) bleiben state.alarmTypes/alarmLog die
// Beispielwerte aus demo.js — rein lokal, keine API-Aufrufe. Im echten
// Betrieb lädt loadGuard() den tatsächlichen Scharf-Zustand, den zuletzt
// gemerkten Ankerpunkt (nur fürs Radius-Vorausfüllen) und das Protokoll;
// tracker-backend/src/alarms.js wertet den Ankerpunkt live aus.
import { el, render, toast, $ } from "../dom.js";
import { state, saveLocalData, emit } from "../state.js";
import {
  isConfigured, listGeofences, listAlarmSettings, updateAlarmSetting, listAlarmLog,
  pushPublicKey, subscribePush, unsubscribePush, geocode,
} from "../api.js";
import { distanceKm } from "../geo.js";
import { liveAlterText } from "../live-alter.js";

// Fester Datensatz-Kennung des Wache-Ankers (api/router.js, WACHE_ZONE_ID) —
// in der Tabelle liegen aus der früheren Zonen-Verwaltung noch ältere
// Einträge, die hier nichts zu suchen haben.
const WACHE_ZONE_ID = "wache-aktuell";
// Ab so alt gilt die letzte GPS-Meldung beim Scharfschalten als "nicht mehr
// dort, wo das Fahrzeug jetzt steht" und es wird nachgefragt.
const MAX_POSITIONSALTER_SCHARF_MS = 10 * 60_000;

const anzeigeZeit = (sqliteDatum) => {
  if (!sqliteDatum) return "";
  const d = new Date(sqliteDatum.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return sqliteDatum;
  return d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

function mapAlarmLogEntry(row) {
  const verlassen = /verlassen/.test(row.message || "");
  const symbol = row.severity === "crit" ? "🔴" : row.severity === "ok" ? "✓" : verlassen ? "↗" : "⚡";
  return { sev: row.severity, icon: symbol, title: row.message || row.type, info: "", time: anzeigeZeit(row.occurred_at) };
}

/** Zentraler Fehlschlag-Toast, wie sichern() in settings.js. */
async function sichern(aufgabe, nachher) {
  try {
    await aufgabe();
    await nachher?.();
    return true;
  } catch (err) {
    toast(`Nicht gespeichert: ${err.message}`);
    return false;
  }
}

function toggleSwitch(checked, onChange) {
  return el("button.switch.sm", {
    role: "switch", "aria-checked": String(checked),
    on: { click: (e) => {
      const next = e.currentTarget.getAttribute("aria-checked") !== "true";
      e.currentTarget.setAttribute("aria-checked", String(next));
      onChange?.(next);
    } },
  });
}

const istAdmin = () => Boolean(state.account?.isAdmin);

function renderAlarmLog() {
  render($("#alarm-log"), state.alarmLog.length
    ? state.alarmLog.map((entry) => el("div.alrow", {}, [
        el(`div.ai.sev-${entry.sev}`, { text: entry.icon }),
        el("div.ab", {}, [el("b", { text: entry.title }), el("div", { text: entry.info })]),
        el("div.at", { text: entry.time }),
      ]))
    : [el("div.sub", { text: "Noch keine Ereignisse." })]);
}

/* ---------- Push-Benachrichtigung: eine persönliche Geräte-Einstellung,
 * unabhängig davon, ob die Wache gerade scharf ist — wer sein Gerät einmal
 * anmeldet, bekommt jeden künftigen Zonen-Wechsel, egal wann er/sie das
 * nächste Mal scharf schaltet. Kein Admin-Erfordernis (anders als
 * scharf/unscharf): das betrifft nur das eigene Gerät, keine gemeinsame
 * Konfiguration. ---------- */
const PUSH_SUB_ID_KEY = "vojago.push.subscriptionId";

const pushUnterstuetzt = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function urlBase64ZuUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalisiert = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const roh = atob(normalisiert);
  return Uint8Array.from(roh, (c) => c.charCodeAt(0));
}

async function pushAktivieren() {
  if (Notification.permission === "denied") {
    toast("Benachrichtigungen sind für diese Seite blockiert — in den Browser-/System-Einstellungen erlauben.");
    return false;
  }
  const erlaubnis = await Notification.requestPermission();
  if (erlaubnis !== "granted") { toast("Ohne Erlaubnis keine Benachrichtigungen"); return false; }
  const { key } = await pushPublicKey();
  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ZuUint8Array(key) });
  const { id } = await subscribePush(subscription.toJSON());
  try { localStorage.setItem(PUSH_SUB_ID_KEY, id); } catch { /* Speicher voll/blockiert — Abo besteht serverseitig trotzdem */ }
  return true;
}

async function pushDeaktivieren() {
  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.getSubscription();
  if (subscription) await subscription.unsubscribe().catch(() => {});
  let id;
  try { id = localStorage.getItem(PUSH_SUB_ID_KEY); } catch { /* egal */ }
  if (id) {
    await unsubscribePush(id).catch(() => {});
    try { localStorage.removeItem(PUSH_SUB_ID_KEY); } catch { /* egal */ }
  }
}

async function renderPushStatus() {
  const schalter = $("#push-switch"), statusText = $("#push-status"), statusSub = $("#push-status-sub");
  if (!schalter) return;
  if (state.config.demo) {
    schalter.disabled = true;
    schalter.title = "Erst nach Anmeldung verfügbar";
    statusText.textContent = "Aus";
    statusSub.textContent = "Erst nach Anmeldung verfügbar";
    return;
  }
  if (!pushUnterstuetzt()) {
    schalter.disabled = true;
    schalter.title = "Dieser Browser unterstützt keine Push-Benachrichtigungen";
    statusText.textContent = "Nicht verfügbar";
    statusSub.textContent = "Dieser Browser/dieses Gerät unterstützt das nicht";
    return;
  }
  schalter.disabled = false;
  schalter.title = "";
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  const subscription = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  const aktiv = Boolean(subscription);
  schalter.setAttribute("aria-checked", String(aktiv));
  statusText.textContent = aktiv ? "An" : "Aus";
  statusSub.textContent = aktiv ? "Aktiv auf diesem Gerät" : "Auf diesem Gerät nicht aktiviert";
}

/** Alarm-Typen zeigten in der Attrappe fünf Schalter, obwohl nur die
 * Geofence-Prüfung wirklich existiert (Bewegung/Unterspannung/Strom-
 * unterbrechung/Übergeschwindigkeit sind nicht gebaut, siehe U7). Push gibt
 * es jetzt (siehe Push-Benachrichtigung-Karte oben) — hier deshalb nur noch
 * ein Hinweis, dass ausschließlich Geofence wirklich auslöst, statt fünf
 * Schaltern vorzutäuschen, es gäbe eine Wahl (Regel 1). Demo-Modus zeigt
 * weiterhin die alte Attrappe, als Vorschau für einen noch nicht
 * angemeldeten Besuch. */
function renderAlarmTypes() {
  const box = $("#alarm-types");
  if (state.config.demo) {
    render(box, state.alarmTypes.map((alarm) => el("div.toggle-row", {}, [
      el("div.tl", {}, [el("b", { text: alarm.name }), el("div", { text: alarm.info })]),
      toggleSwitch(alarm.on, (next) => { alarm.on = next; saveLocalData(); }),
    ])));
    return;
  }
  render(box, [el("div.sub", { text:
    "Bisher löst nur Geofence (Zone verlassen/betreten) wirklich aus — Bewegung, Unterspannung, Stromunterbrechung und Übergeschwindigkeit sind noch nicht angebunden." })]);
}

function renderGuardHero() {
  const hero = $("#guard-hero");
  const guardSwitch = $("#guard-switch");
  const admin = istAdmin();
  const echtesSetting = !state.config.demo;
  const kannÄndern = echtesSetting ? admin : true;
  guardSwitch.setAttribute("aria-checked", String(state.guardArmed));
  guardSwitch.disabled = !kannÄndern;
  guardSwitch.title = echtesSetting && !admin ? "Nur Admins können die Wache scharf/unscharf schalten" : "";
  hero.classList.toggle("armed", state.guardArmed);
  $("#guard-title").textContent = state.guardArmed ? "Wache scharf" : "Wache aus";
  $("#guard-sub").textContent = state.guardArmed
    ? (echtesSetting ? `Radius ${state.guardZoneRadius ?? state.guardRadius} m um die Position beim Scharfschalten` : "Fahrzeug gesichert · Stellplatz Reutte")
    : "Überwachung pausiert";
  hero.querySelector(".shield").style.color = state.guardArmed ? "var(--good)" : "var(--ink-faint)";

  const radiusInput = $("#guard-radius");
  if (radiusInput) {
    radiusInput.value = state.guardRadius;
    radiusInput.disabled = !kannÄndern;
  }
}

const meterText = (m) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1).replace(".", ",")} km`);

function infoZeile(bezeichnung, wert, farbe) {
  return el("div.set-row", {}, [el("div.si", {}, [
    el("b", { text: bezeichnung }),
    el("div", { text: wert, style: farbe ? { color: farbe } : {} }),
  ])]);
}

/** Zeigt, WOMIT die Wache gerade überwacht: Mittelpunkt, Radius, seit wann,
 * wo das Fahrzeug im Verhältnis dazu steht und wie aktuell diese Angabe ist.
 * Wird auch bei jeder neuen Positionsmeldung neu gezeichnet (main.js). */
export function renderGuardInfo() {
  const body = $("#guard-info-body");
  const kartenKnopf = $("#guard-show-map");
  if (!body) return;
  const pos = state.livePosition;
  const anker = state.guardAnchor;

  if (state.config.demo) {
    // Beispielwerte, passend zur Demo-Reise (Stellplatz Reutte) — keine echte Überwachung.
    render(body, [
      infoZeile("Status", "Innerhalb — 42 m vom Mittelpunkt", "var(--good)"),
      infoZeile("Mittelpunkt", "Stellplatz Reutte"),
      infoZeile("Radius", `${state.guardRadius} m`),
      infoZeile("Scharf seit", "gestern, 17:30"),
      infoZeile("Letzte GPS-Meldung", "gerade eben"),
    ]);
    if (kartenKnopf) kartenKnopf.style.display = "none";
    return;
  }
  if (!state.guardArmed || !anker) {
    render(body, [
      el("div.sub", { text: state.guardArmed
        ? "Kein Ankerpunkt bekannt."
        : "Die Wache ist aus. Beim Scharfschalten wird die letzte gemeldete Position des Fahrzeugs zum Mittelpunkt des überwachten Bereichs." }),
      pos ? el("div.sub", { text: `Letzte GPS-Meldung: ${liveAlterText(pos.at)}` }) : null,
    ]);
    if (kartenKnopf) kartenKnopf.style.display = "none";
    return;
  }

  const radius = state.guardZoneRadius;
  const abstandM = pos ? Math.round(distanceKm(anker.lon, anker.lat, pos.lon, pos.lat) * 1000) : null;
  const draussen = abstandM != null && radius != null && abstandM > radius;
  const alterMs = pos ? Date.now() - Date.parse(pos.at || "") : NaN;
  const veraltet = !Number.isFinite(alterMs) || alterMs > 30 * 60_000;

  let statusText, statusFarbe;
  if (abstandM == null) { statusText = "Keine Position bekannt"; statusFarbe = "var(--warn)"; }
  else if (draussen) { statusText = `Außerhalb — ${meterText(abstandM)} vom Mittelpunkt`; statusFarbe = "var(--bad, #d84a4a)"; }
  else { statusText = `Innerhalb — ${meterText(abstandM)} vom Mittelpunkt`; statusFarbe = "var(--good)"; }
  if (veraltet && pos) statusText += ` (Stand ${liveAlterText(pos.at)})`;

  render(body, [
    infoZeile("Status", statusText, statusFarbe),
    infoZeile("Mittelpunkt", state.guardAnchorName || `${anker.lat.toFixed(5)}, ${anker.lon.toFixed(5)}`),
    infoZeile("Radius", radius != null ? `${radius} m` : "unbekannt"),
    infoZeile("Scharf seit", state.guardSince ? anzeigeZeit(state.guardSince) : "unbekannt (vor Einführung des Protokolls)"),
    infoZeile("Letzte GPS-Meldung", pos ? liveAlterText(pos.at) : "keine",
      veraltet ? "var(--warn)" : undefined),
  ]);
  if (kartenKnopf) kartenKnopf.style.display = "";
}

let ankerNameFuer = null;
/** Adresse des Ankerpunkts nachladen (nur zur Anzeige, ein Fehlschlag lässt
 * einfach die Koordinaten stehen). */
async function ladeAnkerName() {
  const a = state.guardAnchor;
  if (!a) return;
  const schluessel = `${a.lat},${a.lon}`;
  if (ankerNameFuer === schluessel) return;
  ankerNameFuer = schluessel;
  state.guardAnchorName = null;
  try {
    const { name } = await geocode(a.lat, a.lon);
    if (ankerNameFuer === schluessel && name) { state.guardAnchorName = name; renderGuardInfo(); }
  } catch { /* Koordinaten genügen */ }
}

function renderGuard() {
  renderGuardHero();
  renderGuardInfo();
  renderAlarmTypes();
  renderAlarmLog();
  renderPushStatus();
  // main.js lässt darüber die grüne Live-LED der Reise zusätzlich rot
  // blinken, solange scharf (siehe dort).
  emit("guard");
}

/** Lädt den echten Scharf-Zustand/Protokoll, sobald angemeldet — im Demo-
 * Modus bleiben die von demo.js gesetzten Beispielwerte unangetastet.
 * Aufgerufen beim Start und jedes Mal, wenn die "Wache"-Unteransicht
 * geöffnet wird (main.js), damit neue Ereignisse sichtbar werden. */
export async function loadGuard() {
  if (state.config.demo || !isConfigured()) { renderGuard(); return; }
  try {
    const [zonen, settings, log] = await Promise.all([listGeofences(), listAlarmSettings(), listAlarmLog()]);
    state.alarmLog = (log || []).map(mapAlarmLogEntry);
    const geofence = (settings || []).find((s) => s.key === "geofence");
    state.guardArmed = geofence ? Boolean(geofence.enabled) : state.guardArmed;
    // Radius/Position des zuletzt gemerkten Ankerpunkts übernehmen — es
    // gibt höchstens noch einen, vom letzten Scharfschalten. Der Radius
    // füllt das Eingabefeld vor, die Position braucht main.js für die
    // Dauerlicht-Prüfung der Live-LED (Zone verlassen?).
    const zone = (zonen || []).find((z) => z.id === WACHE_ZONE_ID);
    if (zone) {
      // Das Eingabefeld füllt sich mit dem letzten Radius — aber nicht mit
      // einem unbrauchbar kleinen (GPS-Rauschen reicht dann für Fehlalarme).
      state.guardRadius = zone.radius_m >= 25 ? zone.radius_m : 50;
      state.guardZoneRadius = zone.radius_m;
      state.guardAnchor = { lat: zone.lat, lon: zone.lon };
    }
    // Das Protokoll kommt neueste zuerst — der erste Scharf-Eintrag ist der aktuelle.
    state.guardSince = (log || []).find((e) => /^Wache scharf geschaltet/.test(e.message || ""))?.occurred_at || null;
    ladeAnkerName();
  } catch {
    /* stiller Fehlschlag, wie loadLivePosition() — Ansicht bleibt beim letzten Stand */
  }
  renderGuard();
}

export function initGuard({ onShowOnMap } = {}) {
  $("#guard-show-map")?.addEventListener("click", () => {
    if (state.guardAnchor) onShowOnMap?.(state.guardAnchor.lat, state.guardAnchor.lon);
  });

  const radiusInput = $("#guard-radius");
  radiusInput?.addEventListener("change", () => {
    const r = Number(radiusInput.value);
    if (Number.isFinite(r) && r >= 10 && r <= 50000) { state.guardRadius = Math.round(r); saveLocalData(); }
    else radiusInput.value = state.guardRadius;
  });

  const guardSwitch = $("#guard-switch");
  guardSwitch.addEventListener("click", () => {
    if (!state.config.demo && !istAdmin()) return; // Schalter ist für Nicht-Admins deaktiviert (renderGuardHero)
    const armed = guardSwitch.getAttribute("aria-checked") !== "true";
    if (state.config.demo) {
      state.guardArmed = armed;
      saveLocalData();
      renderGuardHero();
      return;
    }
    if (armed && !state.livePosition) {
      toast("Keine aktuelle Position bekannt — Wache kann nicht scharf geschaltet werden");
      return; // aria-checked bleibt unverändert (noch "false") — nichts wurde umgeschaltet
    }
    // Die Wache wird auf der LETZTEN GEMELDETEN Position scharf — ist die alt,
    // steht das Fahrzeug womöglich längst woanders (Nutzerfund, 28. September
    // 2026: Anker auf einer über 10 Stunden alten Position, ohne Warnung).
    if (armed) {
      const alterMs = Date.now() - Date.parse(state.livePosition.at || "");
      if (!(alterMs <= MAX_POSITIONSALTER_SCHARF_MS)
        && !window.confirm(`Die letzte GPS-Meldung ist ${liveAlterText(state.livePosition.at)}. Die Wache würde auf DIESER Position scharf geschaltet, nicht unbedingt dort, wo das Fahrzeug jetzt steht.\n\nTrotzdem scharf schalten?`)) {
        return;
      }
    }
    guardSwitch.setAttribute("aria-checked", String(armed)); // optimistisch, renderGuardHero() korrigiert bei Fehlschlag
    const patch = armed
      ? { enabled: true, lat: state.livePosition.lat, lon: state.livePosition.lon, radius_m: state.guardRadius }
      : { enabled: false };
    sichern(() => updateAlarmSetting("geofence", patch), async () => {
      state.guardArmed = armed;
      await loadGuard(); // neuen Anker, Radius und "scharf seit" vom Server holen
    })
      .then(() => renderGuardHero());
  });

  const pushSwitch = $("#push-switch");
  pushSwitch?.addEventListener("click", async () => {
    if (pushSwitch.disabled) return;
    const warAktiv = pushSwitch.getAttribute("aria-checked") === "true";
    pushSwitch.disabled = true;
    try {
      if (warAktiv) await pushDeaktivieren();
      else if (!(await pushAktivieren())) return;
      toast(warAktiv ? "Benachrichtigungen deaktiviert" : "Benachrichtigungen aktiviert");
    } catch (err) {
      toast(err.message || "Das hat nicht geklappt");
    } finally {
      renderPushStatus();
    }
  });

  renderGuard();
}
