// The "Wache" (guard) view: armed/disarmed, watched radius, alarm log.
//
// Deliberately NO named zones to create beforehand (an earlier version had a
// zone list with CRUD): for theft protection ONE anchor is enough — the position
// when arming. That replaces name, list and management with a single radius.
//
// On-board voltage and power loss are deliberately not built (the RUTX50 does
// not report on-board voltage).
//
// In demo mode (not signed in) state.alarmTypes/alarmLog keep the example values
// from demo.js — local only, no API calls. In real use loadGuard() loads the
// actual armed state, the last anchor (only to prefill the radius) and the log;
// tracker-backend/src/alarms.js evaluates the anchor live. UI texts stay German.
import { el, render, toast, $ } from "../dom.js";
import { state, saveLocalData, emit } from "../state.js";
import {
  isConfigured, listGeofences, listAlarmSettings, updateAlarmSetting, listAlarmLog,
  pushPublicKey, subscribePush, unsubscribePush, geocode,
} from "../api.js";
import { distanceKm } from "../geo.js";
import { liveAgeText } from "../live-age.js";

// Fixed record id of the guard anchor (api/router.js) — the table still holds
// older entries from the earlier zone management that do not belong here.
const GUARD_ZONE_ID = "wache-aktuell";
// From this age on, the last GPS report counts as "maybe no longer where the
// vehicle is now" when arming, and the user is asked.
const MAX_POSITION_AGE_ARMING_MS = 10 * 60_000;

const displayTime = (sqliteDate) => {
  if (!sqliteDate) return "";
  const d = new Date(sqliteDate.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return sqliteDate;
  return d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

function mapAlarmLogEntry(row) {
  const left = /verlassen/.test(row.message || "");
  const symbol = row.severity === "crit" ? "🔴" : row.severity === "ok" ? "✓" : left ? "↗" : "⚡";
  return { sev: row.severity, icon: symbol, title: row.message || row.type, info: "", time: displayTime(row.occurred_at) };
}

/** Central failure toast, like save() in settings.js. */
async function save(task, after) {
  try {
    await task();
    await after?.();
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

const isAdmin = () => Boolean(state.account?.isAdmin);

function renderAlarmLog() {
  render($("#alarm-log"), state.alarmLog.length
    ? state.alarmLog.map((entry) => el("div.alrow", {}, [
        el(`div.ai.sev-${entry.sev}`, { text: entry.icon }),
        el("div.ab", {}, [el("b", { text: entry.title }), el("div", { text: entry.info })]),
        el("div.at", { text: entry.time }),
      ]))
    : [el("div.sub", { text: "Noch keine Ereignisse." })]);
}

/* ---------- Push notifications: a personal device setting, independent of
 * whether the guard is armed — whoever registers a device once gets every future
 * zone change, whenever they arm next. No admin needed (unlike arming): it only
 * concerns the own device, no shared configuration. ---------- */
const PUSH_SUB_ID_KEY = "vojago.push.subscriptionId";

const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalised);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function enablePush() {
  if (Notification.permission === "denied") {
    toast("Benachrichtigungen sind für diese Seite blockiert — in den Browser-/System-Einstellungen erlauben.");
    return false;
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") { toast("Ohne Erlaubnis keine Benachrichtigungen"); return false; }
  const { key } = await pushPublicKey();
  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
  const { id } = await subscribePush(subscription.toJSON());
  try { localStorage.setItem(PUSH_SUB_ID_KEY, id); } catch { /* storage full or blocked — the subscription exists on the server anyway */ }
  return true;
}

async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.getSubscription();
  if (subscription) await subscription.unsubscribe().catch(() => {});
  let id;
  try { id = localStorage.getItem(PUSH_SUB_ID_KEY); } catch { /* ignore */ }
  if (id) {
    await unsubscribePush(id).catch(() => {});
    try { localStorage.removeItem(PUSH_SUB_ID_KEY); } catch { /* ignore */ }
  }
}

async function renderPushStatus() {
  const toggle = $("#push-switch"), statusText = $("#push-status"), statusSub = $("#push-status-sub");
  if (!toggle) return;
  if (state.config.demo) {
    toggle.disabled = true;
    toggle.title = "Erst nach Anmeldung verfügbar";
    statusText.textContent = "Aus";
    statusSub.textContent = "Erst nach Anmeldung verfügbar";
    return;
  }
  if (!pushSupported()) {
    toggle.disabled = true;
    toggle.title = "Dieser Browser unterstützt keine Push-Benachrichtigungen";
    statusText.textContent = "Nicht verfügbar";
    statusSub.textContent = "Dieser Browser/dieses Gerät unterstützt das nicht";
    return;
  }
  toggle.disabled = false;
  toggle.title = "";
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  const subscription = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  const active = Boolean(subscription);
  toggle.setAttribute("aria-checked", String(active));
  statusText.textContent = active ? "An" : "Aus";
  statusSub.textContent = active ? "Aktiv auf diesem Gerät" : "Auf diesem Gerät nicht aktiviert";
}

/** The alarm types used to show five switches although only the geofence check
 * exists (movement, low voltage, power loss and speeding are not built). So
 * only a note that only the geofence really triggers, instead of pretending a
 * choice. Demo mode still shows the old switches as a preview for a visitor
 * who is not signed in. */
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
  const admin = isAdmin();
  const realSetting = !state.config.demo;
  const canChange = realSetting ? admin : true;
  guardSwitch.setAttribute("aria-checked", String(state.guardArmed));
  guardSwitch.disabled = !canChange;
  guardSwitch.title = realSetting && !admin ? "Nur Admins können die Wache scharf/unscharf schalten" : "";
  hero.classList.toggle("armed", state.guardArmed);
  $("#guard-title").textContent = state.guardArmed ? "Wache scharf" : "Wache aus";
  $("#guard-sub").textContent = state.guardArmed
    ? (realSetting ? `Radius ${state.guardZoneRadius ?? state.guardRadius} m um die Position beim Scharfschalten` : "Fahrzeug gesichert · Stellplatz Reutte")
    : "Überwachung pausiert";
  hero.querySelector(".shield").style.color = state.guardArmed ? "var(--good)" : "var(--ink-faint)";

  const radiusInput = $("#guard-radius");
  if (radiusInput) {
    radiusInput.value = state.guardRadius;
    radiusInput.disabled = !canChange;
  }
}

const meterText = (m) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1).replace(".", ",")} km`);

function infoRow(label, value, colour) {
  return el("div.set-row", {}, [el("div.si", {}, [
    el("b", { text: label }),
    el("div", { text: value, style: colour ? { color: colour } : {} }),
  ])]);
}

/** Shows WHAT the guard is watching: centre, radius, since when, where the
 * vehicle stands relative to it and how current that is. Redrawn on every new
 * position report too (main.js). */
export function renderGuardInfo() {
  const body = $("#guard-info-body");
  const mapButton = $("#guard-show-map");
  if (!body) return;
  const pos = state.livePosition;
  const anchor = state.guardAnchor;

  if (state.config.demo) {
    // Example values matching the demo trip — no real watching.
    render(body, [
      infoRow("Status", "Innerhalb — 42 m vom Mittelpunkt", "var(--good)"),
      infoRow("Mittelpunkt", "Stellplatz Reutte"),
      infoRow("Radius", `${state.guardRadius} m`),
      infoRow("Scharf seit", "gestern, 17:30"),
      infoRow("Letzte GPS-Meldung", "gerade eben"),
    ]);
    if (mapButton) mapButton.style.display = "none";
    return;
  }
  if (!state.guardArmed || !anchor) {
    render(body, [
      el("div.sub", { text: state.guardArmed
        ? "Kein Ankerpunkt bekannt."
        : "Die Wache ist aus. Beim Scharfschalten wird die letzte gemeldete Position des Fahrzeugs zum Mittelpunkt des überwachten Bereichs." }),
      pos ? el("div.sub", { text: `Letzte GPS-Meldung: ${liveAgeText(pos.at)}` }) : null,
    ]);
    if (mapButton) mapButton.style.display = "none";
    return;
  }

  const radius = state.guardZoneRadius;
  const distanceM = pos ? Math.round(distanceKm(anchor.lon, anchor.lat, pos.lon, pos.lat) * 1000) : null;
  const outside = distanceM != null && radius != null && distanceM > radius;
  const ageMs = pos ? Date.now() - Date.parse(pos.at || "") : NaN;
  const stale = !Number.isFinite(ageMs) || ageMs > 30 * 60_000;

  let statusText, statusColour;
  if (distanceM == null) { statusText = "Keine Position bekannt"; statusColour = "var(--warn)"; }
  else if (outside) { statusText = `Außerhalb — ${meterText(distanceM)} vom Mittelpunkt`; statusColour = "var(--bad, #d84a4a)"; }
  else { statusText = `Innerhalb — ${meterText(distanceM)} vom Mittelpunkt`; statusColour = "var(--good)"; }
  if (stale && pos) statusText += ` (Stand ${liveAgeText(pos.at)})`;

  render(body, [
    infoRow("Status", statusText, statusColour),
    infoRow("Mittelpunkt", state.guardAnchorName || `${anchor.lat.toFixed(5)}, ${anchor.lon.toFixed(5)}`),
    infoRow("Radius", radius != null ? `${radius} m` : "unbekannt"),
    infoRow("Scharf seit", state.guardSince ? displayTime(state.guardSince) : "unbekannt (vor Einführung des Protokolls)"),
    infoRow("Letzte GPS-Meldung", pos ? liveAgeText(pos.at) : "keine",
      stale ? "var(--warn)" : undefined),
  ]);
  if (mapButton) mapButton.style.display = "";
}

let anchorNameFor = null;
/** Load the anchor's address (display only; a failure simply leaves the coordinates). */
async function loadAnchorName() {
  const a = state.guardAnchor;
  if (!a) return;
  const key = `${a.lat},${a.lon}`;
  if (anchorNameFor === key) return;
  anchorNameFor = key;
  state.guardAnchorName = null;
  try {
    const { name } = await geocode(a.lat, a.lon);
    if (anchorNameFor === key && name) { state.guardAnchorName = name; renderGuardInfo(); }
  } catch { /* the coordinates are enough */ }
}

function renderGuard() {
  renderGuardHero();
  renderGuardInfo();
  renderAlarmTypes();
  renderAlarmLog();
  renderPushStatus();
  // Through this, main.js makes the trip's green live LED also blink red while armed.
  emit("guard");
}

/** Loads the real armed state and log once signed in — in demo mode the example
 * values from demo.js stay untouched. Called on start and every time the "Wache"
 * sub-view opens (main.js), so new events show up. */
export async function loadGuard() {
  if (state.config.demo || !isConfigured()) { renderGuard(); return; }
  try {
    const [zones, settings, log] = await Promise.all([listGeofences(), listAlarmSettings(), listAlarmLog()]);
    state.alarmLog = (log || []).map(mapAlarmLogEntry);
    const geofence = (settings || []).find((s) => s.key === "geofence");
    state.guardArmed = geofence ? Boolean(geofence.enabled) : state.guardArmed;
    // Take radius and position of the last anchor — there is at most one, from
    // the last arming. The radius prefills the input, main.js needs the position
    // for the steady-light check of the live LED (zone left?).
    const zone = (zones || []).find((z) => z.id === GUARD_ZONE_ID);
    if (zone) {
      // The input gets the last radius — but not a uselessly small one (GPS
      // noise alone would then cause false alarms).
      state.guardRadius = zone.radius_m >= 25 ? zone.radius_m : 50;
      state.guardZoneRadius = zone.radius_m;
      state.guardAnchor = { lat: zone.lat, lon: zone.lon };
    }
    // The log comes newest first — the first arming entry is the current one.
    state.guardSince = (log || []).find((e) => /^Wache scharf geschaltet/.test(e.message || ""))?.occurred_at || null;
    loadAnchorName();
  } catch {
    /* silent failure, like loadLivePosition() — the view keeps its last state */
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
    if (!state.config.demo && !isAdmin()) return; // the switch is disabled for non-admins (renderGuardHero)
    const armed = guardSwitch.getAttribute("aria-checked") !== "true";
    if (state.config.demo) {
      state.guardArmed = armed;
      saveLocalData();
      renderGuardHero();
      return;
    }
    if (armed && !state.livePosition) {
      toast("Keine aktuelle Position bekannt — Wache kann nicht scharf geschaltet werden");
      return; // aria-checked stays unchanged (still "false") — nothing was switched
    }
    // The guard arms on the LAST REPORTED position — if that is old, the vehicle
    // may stand somewhere else by now (seen 28 September 2026: an anchor on a
    // position more than 10 hours old, without a warning).
    if (armed) {
      const ageMs = Date.now() - Date.parse(state.livePosition.at || "");
      if (!(ageMs <= MAX_POSITION_AGE_ARMING_MS)
        && !window.confirm(`Die letzte GPS-Meldung ist ${liveAgeText(state.livePosition.at)}. Die Wache würde auf DIESER Position scharf geschaltet, nicht unbedingt dort, wo das Fahrzeug jetzt steht.\n\nTrotzdem scharf schalten?`)) {
        return;
      }
    }
    guardSwitch.setAttribute("aria-checked", String(armed)); // optimistic, renderGuardHero() corrects on failure
    const patch = armed
      ? { enabled: true, lat: state.livePosition.lat, lon: state.livePosition.lon, radius_m: state.guardRadius }
      : { enabled: false };
    save(() => updateAlarmSetting("geofence", patch), async () => {
      state.guardArmed = armed;
      await loadGuard(); // load the new anchor, radius and "armed since" from the server
    })
      .then(() => renderGuardHero());
  });

  const pushSwitch = $("#push-switch");
  pushSwitch?.addEventListener("click", async () => {
    if (pushSwitch.disabled) return;
    const wasActive = pushSwitch.getAttribute("aria-checked") === "true";
    pushSwitch.disabled = true;
    try {
      if (wasActive) await disablePush();
      else if (!(await enablePush())) return;
      toast(wasActive ? "Benachrichtigungen deaktiviert" : "Benachrichtigungen aktiviert");
    } catch (err) {
      toast(err.message || "Das hat nicht geklappt");
    } finally {
      renderPushStatus();
    }
  });

  renderGuard();
}
