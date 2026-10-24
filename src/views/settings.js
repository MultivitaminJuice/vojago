// Ansicht „Einstellungen": Fahrzeuge, Kategorien, Backend-Verbindung.
import { el, render, icon, toast, $, $$ } from "../dom.js";
import { applyTheme, gueltigesTheme } from "../theme.js";
import { routenInfoZeilen } from "../route-info.js";
import { gueltigerKartenstil } from "../map-style.js";
import * as mapview from "../mapview.js";
import { ICON } from "../icons.js";
import { state, saveConfig, emit, saveLocalData, forgetLocalData, collectPreferences } from "../state.js";
import { wireInlineEdit } from "../ui/inline-edit.js";
import { health, isConfigured, logout, changePassword, setEmail,
  createCategory, updateCategory, deleteCategory,
  createVehicle, updateVehicle, deleteVehicle, storeSettings,
  createShare, listShares, revokeShare, devices as fetchDevices,
  ingestStatus, setIngestLearning,
  listUsers, createUser, updateUser, deleteUser } from "../api.js";
import { status as dataStatus, forgetSnapshot, routenAbruf } from "../dataload.js";
import { clearDebugLog, debugCount, debugEnabled, exportDebugLog, preciseDebugDataEnabled, setDebugEnabled, setPreciseDebugDataEnabled } from "../debug.js";

const CAT_COLORS = ["#e8802b", "#3b82c4", "#7a5cd6", "#3f9d5a", "#b5476b", "#caa23a", "#1f9e8f", "#d84a4a", "#4b47a8", "#c24b86"];
let newCatColor = CAT_COLORS[0];
let onCategoriesChanged = () => {};
let onSourceChanged = () => {};

// N10: bekannte Geräte fürs Zuordnen zu einem Fahrzeug — bei Traccar dessen
// Geräteliste, im Selbst-Hosting-Betrieb die Geräte, die schon einmal an
// die eigene positions-Tabelle gesendet haben.
// Einmal pro Aufruf der Fahrzeuge-Ansicht geladen, nicht bei jedem Tastendruck.
let bekannteGeraete = [];
let ingestInfo = null;
async function ladeBekannteGeraete() {
  if (!zentral()) { bekannteGeraete = []; return; }
  try { bekannteGeraete = (await fetchDevices()) || []; }
  catch { bekannteGeraete = []; } // z. B. noch kein Gerät je gesehen — kein Fehler wert
}

async function ladeIngestInfo() {
  if (!zentral() || !state.account?.isAdmin) { ingestInfo = null; return; }
  try { ingestInfo = await ingestStatus(); }
  catch { ingestInfo = null; }
}

/**
 * Im verbundenen Betrieb gehören Kategorien und Fahrzeuge in die Datenbank —
 * sonst sähe jedes Gerät etwas anderes. Nur mit Beispieldaten (oder wenn die
 * API gerade nicht erreichbar ist) wird lokal gesichert.
 */
const zentral = () => !state.config.demo && isConfigured();

async function sichern(aufgabe) {
  saveLocalData(); // immer auch lokal, damit offline nichts verloren geht
  if (!zentral()) return true;
  try {
    await aufgabe();
    await storeSettings(collectPreferences()).catch(() => {});
    return true;
  } catch (err) {
    toast(`Nicht gespeichert: ${err.message}`);
    return false;
  }
}

/**
 * Den Konto-Bereich neu zeichnen. Nötig, weil die Einstellungen beim Start
 * aufgebaut werden, die Anmeldeprüfung aber erst danach antwortet — sonst
 * stünde dort dauerhaft "Nicht angemeldet".
 */
export function refreshAccountState() {
  showConnection(null);
  applyConfigToForm();
  renderEmailStatus();
  renderSharesList();
  // Verwaltung (Fahrzeuge, Kategorien, Traccar-Verknüpfung, lokale Daten,
  // Nutzer) ist bewusst nur für Admins sichtbar — alle Konten sehen zwar
  // dieselben Reisen/Orte, aber nur Admins sollen an der gemeinsamen
  // Konfiguration schrauben können.
  const istAdmin = Boolean(state.account?.isAdmin);
  for (const id of ["vehicles-group", "categories-group", "traccar-link-group", "ingest-group", "local-data-group", "users-group"]) {
    const gruppe = $(`#${id}`);
    if (gruppe) gruppe.hidden = !istAdmin;
  }
  if (istAdmin) {
    renderUsersList();
    // Nicht blockierend — die Zeile zeigt sich schon, bekannte Geräte
    // tröpfeln als Vorschlagsliste nach, sobald sie da sind.
    ladeBekannteGeraete().then(renderVehicles);
    ladeIngestInfo().then(renderIngestControls);
  }
}

/** Zeigt, ob eine E-Mail hinterlegt und bestätigt ist — beides zusammen ist
 * Voraussetzung für "Passwort vergessen". */
function renderEmailStatus() {
  const status = $("#cfg-email-status");
  const btn = $("#cfg-email-btn");
  if (!status || !btn) return;
  const email = state.account?.email;
  if (!email) {
    status.textContent = "Keine hinterlegt — nötig für „Passwort vergessen“.";
  } else if (state.account?.emailVerified) {
    status.textContent = `${email} ✓ bestätigt`;
  } else {
    status.textContent = `${email} — noch nicht bestätigt, Link geprüft?`;
  }
  btn.textContent = email ? "Ändern" : "Hinterlegen";
}

/** Liste bestehender Freigabe-Links — Name der Reise (oder "Alle Reisen"),
 * Umfang, Ablauf, letzter Zugriff, Widerrufen-Knopf. Nur sinnvoll im
 * verbundenen Betrieb (ohne echte Reisen gibt es nichts zu teilen). */
async function renderSharesList() {
  const box = $("#shares-list");
  if (!box) return;
  if (!zentral()) { render(box, [el("p.sub", { text: "Anmelden, um Reisen zu teilen." })]); return; }
  let shares = [];
  try { shares = await listShares(); } catch { render(box, [el("p.sub", { text: "Freigaben konnten nicht geladen werden." })]); return; }
  // Widerrufene Links bleiben in der Datenbank (Nachvollziehbarkeit), aber
  // nicht in dieser Liste — dort wären sie nur totes Gewicht.
  shares = shares.filter((s) => !s.revoked_at);
  if (!shares.length) { render(box, [el("p.sub", { text: "Noch keine Freigabe erstellt." })]); return; }
  render(box, shares.map((s) => {
    const ziel = s.trip_id ? (s.trip_name || "gelöschte Reise") : "Alle Reisen";
    const ablauf = s.expires_at ? `bis ${new Date(s.expires_at).toLocaleDateString("de-DE")}` : "kein Ablauf";
    const umfang = s.scope === "karte_logbuch" ? "Karte + Logbuch" : "Nur Karte";
    return el("div.set-row", {}, [
      el("div.si", {}, [
        el("b", { text: s.label ? `${s.label} · ${ziel}` : ziel }),
        el("div", { text: `${umfang} · ${ablauf} · ${s.view_count || 0}× geöffnet` }),
      ]),
      !s.token ? null : el("button.btn", {
        text: "Kopieren",
        title: "Link erneut in die Zwischenablage kopieren",
        on: { click: async (e) => {
          const link = `${location.origin}/share/${s.token}`;
          try { await navigator.clipboard.writeText(link); toast("Link kopiert"); }
          catch { toast(`Link: ${link}`); }
        } },
      }),
      el("button.btn", {
        text: "Widerrufen",
        on: { click: async (e) => {
          e.currentTarget.disabled = true;
          try { await revokeShare(s.id); toast("Link widerrufen"); renderSharesList(); }
          catch (err) { toast(err.message || "Konnte nicht widerrufen werden"); e.currentTarget.disabled = false; }
        } },
      }),
    ]);
  }));
}

function zeigeShareFormular(sichtbar) {
  const panel = $("#share-panel");
  if (!panel) return;
  panel.hidden = !sichtbar;
  if (!sichtbar) return;
  const auswahl = $("#share-trip");
  auswahl.innerHTML = '<option value="">Alle Reisen</option>';
  for (const t of state.trips) {
    auswahl.appendChild(el("option", { value: t.id, text: t.name }));
  }
  $("#share-label").value = "";
}

async function shareErstellen() {
  const btn = $("#share-create");
  btn.disabled = true;
  try {
    const tripId = $("#share-trip").value || undefined;
    const scope = $("#share-scope").value;
    const label = $("#share-label").value.trim() || undefined;
    const tageRoh = $("#share-expiry").value;
    const expiresInDays = tageRoh ? Number(tageRoh) : undefined;
    const { token } = await createShare({ tripId, scope, label, expiresInDays });
    const link = `${location.origin}/share/${token}`;
    try { await navigator.clipboard.writeText(link); toast("Link erstellt und kopiert"); }
    catch { toast(`Link erstellt: ${link}`); }
    zeigeShareFormular(false);
    renderSharesList();
  } catch (err) {
    toast(err.message || "Link konnte nicht erstellt werden");
  } finally {
    btn.disabled = false;
  }
}

// Welche Zeile gerade ihr Passwort-Feld offen hat — höchstens eine
// gleichzeitig, wie bei den anderen Formularen in dieser Ansicht.
let offenePasswortZeile = null;

async function renderUsersList() {
  const box = $("#users-list");
  if (!box) return;
  let users = [];
  try { users = await listUsers(); }
  catch { render(box, [el("p.sub", { text: "Nutzer konnten nicht geladen werden." })]); return; }
  const eigeneId = users.find((u) => u.username === state.account?.username)?.id;

  render(box, users.map((u) => {
    const input = el("input.inline-name", { value: u.username });
    const save = el("button.name-save", { text: "✓" });
    const pwOffen = offenePasswortZeile === u.id;
    const zeile = el("div.set-row", {}, [
      el("div.si", {}, [input, el("div", { text: u.isAdmin ? "Admin" : "Nutzer" })]),
      save,
      el("button.switch.sm", {
        role: "switch", "aria-checked": String(u.isAdmin), title: "Admin",
        on: { click: async () => {
          try { await updateUser(u.id, { isAdmin: !u.isAdmin }); renderUsersList(); }
          catch (err) { toast(err.message || "Konnte nicht geändert werden"); }
        } },
      }),
      el("button.iconbtn", {
        title: "Passwort setzen",
        on: { click: () => { offenePasswortZeile = pwOffen ? null : u.id; renderUsersList(); } },
      }, icon(ICON.edit, 15)),
      u.id === eigeneId ? null : el("button.iconbtn", {
        title: "Löschen",
        on: { click: async () => {
          try { await deleteUser(u.id); toast("Nutzer gelöscht"); renderUsersList(); }
          catch (err) { toast(err.message || "Konnte nicht gelöscht werden"); }
        } },
      }, icon(ICON.trash, 15)),
    ]);
    wireInlineEdit(input, save, () => u.username, async (value) => {
      try { await updateUser(u.id, { username: value }); renderUsersList(); }
      catch (err) { toast(err.message || "Konnte nicht umbenannt werden"); renderUsersList(); }
    });
    if (!pwOffen) return zeile;
    const pwInput = el("input", { type: "password", placeholder: "Neues Passwort (mind. 10 Zeichen)", autocomplete: "new-password" });
    const pwSetzen = el("button.btn.primary", {
      text: "Setzen",
      on: { click: async () => {
        try {
          await updateUser(u.id, { password: pwInput.value });
          offenePasswortZeile = null;
          toast("Passwort gesetzt — die Sitzungen dieses Kontos wurden beendet");
          renderUsersList();
        } catch (err) { toast(err.message || "Passwort konnte nicht gesetzt werden"); }
      } },
    });
    return el("div", {}, [zeile, el("div.set-row", {}, [el("div.si", {}, pwInput), pwSetzen])]);
  }));
}

function zeigeUserFormular(sichtbar) {
  const panel = $("#user-panel");
  if (!panel) return;
  panel.hidden = !sichtbar;
  if (!sichtbar) return;
  $("#user-new-name").value = "";
  $("#user-new-pw").value = "";
  $("#user-new-admin").setAttribute("aria-checked", "false");
}

async function userErstellen() {
  const btn = $("#user-create");
  btn.disabled = true;
  try {
    const username = $("#user-new-name").value.trim();
    const password = $("#user-new-pw").value;
    const isAdmin = $("#user-new-admin").getAttribute("aria-checked") === "true";
    await createUser({ username, password, isAdmin });
    toast("Nutzer angelegt");
    zeigeUserFormular(false);
    renderUsersList();
  } catch (err) {
    toast(err.message || "Nutzer konnte nicht angelegt werden");
  } finally {
    btn.disabled = false;
  }
}

/** Vorlieben ohne eigenen Datensatz (Anzeige, Ebenen) zentral ablegen. */
export function syncPreferences() {
  saveLocalData();
  if (zentral()) storeSettings(collectPreferences()).catch(() => {});
}

export function initSettings({ onCategoriesChange, onSourceChange }) {
  onCategoriesChanged = onCategoriesChange;
  onSourceChanged = onSourceChange || (() => {});

  $("#veh-add").addEventListener("click", () => {
    const id = `veh_${Date.now().toString(36)}`;
    state.vehicles.push({ id, name: "Neues Fahrzeug", device: "neu" });
    renderVehicles();
    sichern(() => createVehicle({ id, name: "Neues Fahrzeug" }))
      .then((ok) => ok && toast("Fahrzeug hinzugefügt – Name direkt antippen"));
  });

  const showSwitch = $("#veh-show");
  showSwitch.addEventListener("click", () => {
    state.showVehicleName = showSwitch.getAttribute("aria-checked") !== "true";
    showSwitch.setAttribute("aria-checked", String(state.showVehicleName));
    syncPreferences();
    emit("vehicles");
  });

  $("#cat-add").addEventListener("click", () => {
    const input = $("#cat-new-name");
    const name = input.value.trim();
    if (!name) { toast("Bitte Namen eingeben"); return; }
    const id = `cat_${Date.now().toString(36)}`;
    state.categories[id] = { name, color: newCatColor };
    input.value = "";
    renderCategories();
    onCategoriesChanged();
    sichern(() => createCategory({ id, name, color: newCatColor }))
      .then((ok) => ok && toast("Kategorie hinzugefügt"));
  });

  $("#cfg-logout").addEventListener("click", async () => {
    try { await logout(); } catch { /* auch bei Fehler abmelden */ }
    location.reload();
  });

  $("#cfg-password").addEventListener("click", () => zeigePasswortFormular(true));
  $("#pw-cancel").addEventListener("click", () => zeigePasswortFormular(false));
  $("#pw-save").addEventListener("click", passwortSpeichern);

  $("#cfg-email-btn").addEventListener("click", () => zeigeEmailFormular(true));
  $("#email-cancel").addEventListener("click", () => zeigeEmailFormular(false));
  $("#email-save").addEventListener("click", emailSpeichern);

  $("#share-add").addEventListener("click", () => zeigeShareFormular(true));
  $("#share-cancel").addEventListener("click", () => zeigeShareFormular(false));
  $("#share-create").addEventListener("click", shareErstellen);

  $("#user-add")?.addEventListener("click", () => zeigeUserFormular(true));
  $("#user-cancel")?.addEventListener("click", () => zeigeUserFormular(false));
  $("#user-create")?.addEventListener("click", userErstellen);
  $("#user-new-admin")?.addEventListener("click", () => {
    const btn = $("#user-new-admin");
    btn.setAttribute("aria-checked", String(btn.getAttribute("aria-checked") !== "true"));
  });

  $("#cfg-test").addEventListener("click", testConnection);
  $("#ingest-learn")?.addEventListener("click", async () => {
    const aktiv = Boolean(ingestInfo?.learningActive);
    try {
      ingestInfo = await setIngestLearning({ enabled: !aktiv, minutes: 10 });
      await ladeBekannteGeraete();
      await ladeIngestInfo();
      renderVehicles();
      renderIngestControls();
      toast(aktiv ? "Lernmodus beendet" : "Lernmodus für 10 Minuten aktiv");
    } catch (err) {
      toast(err.message || "Lernmodus konnte nicht geändert werden");
    }
  });
  $("#debug-toggle").addEventListener("click", () => {
    setDebugEnabled($("#debug-toggle").getAttribute("aria-checked") !== "true");
    renderDebugControls();
  });
  $("#debug-precise").addEventListener("click", () => {
    setPreciseDebugDataEnabled($("#debug-precise").getAttribute("aria-checked") !== "true");
    renderDebugControls();
  });
  $("#debug-export").addEventListener("click", () => {
    const precise = preciseDebugDataEnabled();
    exportDebugLog(state, dataStatus);
    renderDebugControls();
    toast(precise ? "Debug-Export mit GPS-Daten erstellt" : "Debug-Export ohne GPS-Daten erstellt");
  });
  $("#debug-clear").addEventListener("click", () => {
    clearDebugLog();
    renderDebugControls();
    toast("Debug-Log geleert");
  });

  const zeigeTheme = () => {
    const aktuell = gueltigesTheme(state.config.theme);
    $$("#theme-tabs [data-theme-wahl]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeWahl === aktuell)));
  };
  $$("#theme-tabs [data-theme-wahl]").forEach((b) => b.addEventListener("click", () => {
    state.config.theme = gueltigesTheme(b.dataset.themeWahl);
    applyTheme(state.config.theme);
    saveConfig();
    zeigeTheme();
  }));
  zeigeTheme();

  const zeigeKartenstil = () => {
    const aktuell = gueltigerKartenstil(state.config.kartenstil);
    $$("#mapstyle-tabs [data-kartenstil-wahl]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.kartenstilWahl === aktuell)));
  };
  $$("#mapstyle-tabs [data-kartenstil-wahl]").forEach((b) => b.addEventListener("click", () => {
    state.config.kartenstil = gueltigerKartenstil(b.dataset.kartenstilWahl);
    saveConfig();
    mapview.setKartenstil(state.config.kartenstil);
    zeigeKartenstil();
  }));
  zeigeKartenstil();

  const demoSwitch = $("#cfg-demo");
  demoSwitch.addEventListener("click", () => {
    state.config.demo = demoSwitch.getAttribute("aria-checked") !== "true";
    demoSwitch.setAttribute("aria-checked", String(state.config.demo));
    saveConfig();
    updateDemoHint();
    onSourceChanged();
  });

  const resetBtn = $("#cat-reset");
  if (resetBtn) resetBtn.addEventListener("click", () => {
    forgetLocalData();
    toast("Zurückgesetzt — die App lädt neu");
    setTimeout(() => location.reload(), 800);
  });

  $("#local-data-clear")?.addEventListener("click", () => {
    forgetSnapshot();
    forgetLocalData();
    clearDebugLog();
    toast("Lokale Daten gelöscht — die App lädt neu");
    setTimeout(() => location.reload(), 800);
  });

  renderVehicles();
  renderCategories();
  renderIngestControls();
  renderDebugControls();
  renderRouteInfo();
  applyConfigToForm();
}

function zeigePasswortFormular(sichtbar) {
  const panel = $("#password-panel");
  panel.hidden = !sichtbar;
  if (!sichtbar) {
    $("#pw-old").value = "";
    $("#pw-new").value = "";
    $("#pw-repeat").value = "";
    return;
  }
  $("#pw-old").focus();
}

async function passwortSpeichern() {
  const alt = $("#pw-old").value;
  const neu = $("#pw-new").value;
  const repeat = $("#pw-repeat").value;
  if (!alt) { toast("Bitte bisheriges Passwort eingeben"); return; }
  if (neu.length < 10) { toast("Neues Passwort braucht mindestens 10 Zeichen"); return; }
  if (neu !== repeat) { toast("Die neuen Passwörter stimmen nicht überein"); return; }

  const btn = $("#pw-save");
  btn.disabled = true;
  btn.textContent = "Speichert …";
  try {
    await changePassword(alt, neu);
    zeigePasswortFormular(false);
    toast("Passwort geändert — andere Geräte wurden abgemeldet");
  } catch (err) {
    toast(err.message || "Passwort konnte nicht geändert werden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Speichern";
  }
}

function zeigeEmailFormular(sichtbar) {
  const panel = $("#email-panel");
  panel.hidden = !sichtbar;
  if (!sichtbar) { $("#email-new").value = ""; $("#email-pw-confirm").value = ""; return; }
  $("#email-new").value = state.account?.email || "";
  $("#email-new").focus();
}

async function emailSpeichern() {
  const email = $("#email-new").value.trim();
  const passwort = $("#email-pw-confirm").value;
  if (!email.includes("@")) { toast("Das sieht nicht nach einer E-Mail-Adresse aus"); return; }
  if (!passwort) { toast("Bitte Passwort eingeben"); return; }

  const btn = $("#email-save");
  btn.disabled = true;
  try {
    await setEmail(passwort, email);
    // Jede neu gespeicherte Adresse gilt erst nach Bestätigung — der Link
    // ist unterwegs.
    state.account = { ...state.account, email, emailVerified: false };
    zeigeEmailFormular(false);
    renderEmailStatus();
    toast("E-Mail gespeichert — Bestätigungslink verschickt");
  } catch (err) {
    toast(err.message || "E-Mail konnte nicht gespeichert werden");
  } finally {
    btn.disabled = false;
  }
}

/** Mehr → Status → Route: wann und wie die Route zuletzt aktualisiert wurde. */
export function renderRouteInfo() {
  const box = $("#route-info");
  if (!box) return;
  render(box, routenInfoZeilen(routenAbruf).map(([k, v]) => el("div", {}, [el("span", { text: k }), el("b", { text: v })])));
}

function renderDebugControls() {
  const on = debugEnabled();
  const precise = preciseDebugDataEnabled();
  $("#debug-toggle").setAttribute("aria-checked", String(on));
  $("#debug-precise").setAttribute("aria-checked", String(precise));
  $("#debug-count").textContent = `${debugCount()} Einträge`;
  $("#debug-note").textContent = precise
    ? "Achtung: Der nächste Export enthält exakte GPS-Pfade, Koordinaten, Ortsnamen, Notizen und Adressen. Danach wird dieser Schalter wieder ausgeschaltet."
    : "Standardmäßig entfernt der Export GPS-Pfade, Koordinaten, Ortsnamen, Notizen und Adressen.";
}

/** Speichert eine Fahrzeug-Änderung — legt das Fahrzeug bei Bedarf
 * serverseitig erst an. Das anfängliche Standardfahrzeug (siehe state.js)
 * hat noch keine `id` — ohne diese Weiche würde seine erste Änderung (z. B.
 * eine Geräte-ID eintragen) nur lokal landen und nie serverseitig sichtbar
 * werden, selbst im verbundenen Betrieb.
 * @param {object} lokal Feldnamen wie im Client-Zustand (name, device, active)
 */
function sicherFahrzeug(vehicle, lokal) {
  Object.assign(vehicle, lokal);
  // Serverseitig heißt das Feld traccar_device_id, lokal nur device — hier
  // an der einen Stelle übersetzt, statt an jeder Aufrufstelle einzeln.
  const serverPatch = {};
  if ("name" in lokal) serverPatch.name = lokal.name;
  if ("device" in lokal) serverPatch.traccar_device_id = lokal.device || null;
  if ("active" in lokal) serverPatch.active = lokal.active;

  if (vehicle.id) {
    sichern(() => updateVehicle(vehicle.id, serverPatch));
    return;
  }
  if (!zentral()) { saveLocalData(); return; }
  vehicle.id = `veh_${Date.now().toString(36)}`;
  // vehicle.active gibt es im Client-Zustand sonst nicht (aktiv ist immer
  // state.activeVehicle als Index) — hier fürs Anlegen aus dem Index ableiten,
  // damit ein bereits aktives Standardfahrzeug nicht als inaktiv gilt.
  const istAktiv = "active" in lokal ? lokal.active : state.vehicles.indexOf(vehicle) === state.activeVehicle;
  sichern(() => createVehicle({ id: vehicle.id, name: vehicle.name, traccar_device_id: vehicle.device || null, active: istAktiv }));
}

function renderIngestControls() {
  const title = $("#ingest-title");
  const sub = $("#ingest-sub");
  const btn = $("#ingest-learn");
  const list = $("#ingest-devices");
  if (!title || !sub || !btn || !list) return;
  if (!ingestInfo) {
    title.textContent = "Lernmodus unbekannt";
    sub.textContent = "Status konnte noch nicht geladen werden.";
    btn.textContent = "10 min lernen";
    render(list, []);
    return;
  }
  const until = new Date(ingestInfo.learningUntil || 0);
  title.textContent = ingestInfo.learningActive ? "Lernmodus aktiv" : "Lernmodus aus";
  sub.textContent = ingestInfo.learningActive && !Number.isNaN(until.getTime())
    ? `bis ${until.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`
    : "Unbekannte Geräte werden abgewiesen.";
  btn.textContent = ingestInfo.learningActive ? "Beenden" : "10 min lernen";
  const devices = Array.isArray(ingestInfo.devices) ? ingestInfo.devices.slice(0, 6) : [];
  render(list, devices.length ? devices.map((d) => el("div.set-row", {}, [
    el("div.si", {}, [
      el("b", { text: d.id }),
      el("div", { text: `${d.accepted ? "zugeordnet/erlaubt" : "gesehen, noch nicht zugeordnet"}${d.lastSeen ? ` · ${new Date(d.lastSeen).toLocaleString("de-DE")}` : ""}` }),
    ]),
  ])) : [el("p.sub", { text: "Noch kein unbekanntes Gerät gesehen." })]);
}

export function renderVehicles() {
  // Eine gemeinsame Vorschlagsliste für alle Fahrzeuge — welche Geräte-IDs
  // tatsächlich schon einmal gesendet haben (N10).
  // Ersetzt Tippen nach Gefühl durch Auswahl aus echten Daten, erlaubt aber
  // weiterhin freie Eingabe (z. B. ein Gerät, das noch nie gesendet hat).
  const datalist = el("datalist#geraete-vorschlaege", {}, bekannteGeraete.map((g) =>
    el("option", { value: g.id, text: `${g.accepted ? "erlaubt" : "neu"}${g.lastUpdate ? ` · zuletzt ${new Date(g.lastUpdate).toLocaleString("de-DE")}` : ""}` })
  ));

  const rows = state.vehicles.map((vehicle, index) => {
    const input = el("input.inline-name", { value: vehicle.name });
    const save = el("button.name-save", { text: "✓" });
    const deviceInput = el("input.inline-name", {
      value: vehicle.device || "",
      placeholder: "Geräte-ID (z. B. IMEI)",
      list: "geraete-vorschlaege",
    });
    const deviceSave = el("button.name-save", { text: "✓" });
    const row = el("div.set-row", {}, [
      el("button.iconbtn" + (index === state.activeVehicle ? ".active" : ""), {
        title: "Aktiv setzen",
        on: { click: () => {
          state.activeVehicle = index;
          // N10: das aktive Fahrzeug bestimmt jetzt direkt, welches Gerät
          // die App abfragt — vorher war das ein eigenes, unabhängiges Feld
          // ("Geräteverknüpfung"), das man zusätzlich pflegen musste.
          state.config.device = vehicle.device || "";
          saveConfig();
          renderVehicles(); emit("vehicles");
          sicherFahrzeug(vehicle, { active: true }); // synct state.config.device über collectPreferences() mit
          onSourceChanged(); // neues Gerät -> Positionen/Fahrten neu laden, wie vorher beim alten "Speichern"
        } },
      }, icon(ICON.check, 15)),
      el("div.si", {}, [
        // Beide Felder gleich aufgebaut (Label + Eingabe + eigener
        // Speichern-Knopf in einer Reihe) — vorher hatte nur die Geräte-ID
        // ein Label, der Name sah dadurch nicht wie ein Eingabefeld aus.
        el("div.field", {}, [
          el("label", { text: "Name" }),
          el("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, [input, save]),
        ]),
        el("div.field", { style: { margin: "8px 0 0" } }, [
          el("label", { text: "Geräte-ID" }),
          el("div", { style: { display: "flex", gap: "6px", alignItems: "center" } }, [deviceInput, deviceSave]),
        ]),
        index === state.activeVehicle ? el("div.sub", { text: "aktiv", style: { fontSize: "11px" } }) : null,
      ]),
      state.vehicles.length > 1
        ? el("button.iconbtn", { title: "Löschen", on: { click: () => {
            const entfernt = state.vehicles[index];
            state.vehicles.splice(index, 1);
            if (state.activeVehicle >= state.vehicles.length) state.activeVehicle = 0;
            renderVehicles(); emit("vehicles");
            if (entfernt.id) sichern(() => deleteVehicle(entfernt.id)); else saveLocalData();
          } } }, icon(ICON.trash, 15))
        : null,
    ]);
    wireInlineEdit(input, save, () => vehicle.name, (value) => {
      // sicherFahrzeug() ZUERST — es schreibt vehicle.name synchron (bevor
      // es asynchron zum Server geht). In der falschen Reihenfolge zeichnet
      // renderVehicles() sich selbst noch mit dem alten Namen neu (echter
      // Fund: nach dem Speichern stand weiter der alte Wert im Feld).
      sicherFahrzeug(vehicle, { name: value });
      renderVehicles(); emit("vehicles");
    });
    // Eigener wireInlineEdit-Aufruf für die Geräte-ID — eigenständiges Feld,
    // eigener Speicherstand, unabhängig vom Namen.
    wireInlineEdit(deviceInput, deviceSave, () => vehicle.device || "", (value) => {
      // Ist das gerade das aktive Fahrzeug, zieht state.config.device (was
      // die App tatsächlich abfragt) sofort mit — sonst würde man die
      // Geräte-ID am aktiven Fahrzeug ändern, ohne dass sich live etwas tut.
      if (index === state.activeVehicle) { state.config.device = value; saveConfig(); }
      sicherFahrzeug(vehicle, { device: value }); // vor renderVehicles(), siehe Kommentar oben
      renderVehicles(); emit("vehicles");
      if (index === state.activeVehicle) onSourceChanged(); // neues Gerät -> Positionen/Fahrten neu laden
    });
    return row;
  });
  render($("#veh-list"), [datalist, ...rows]);
}

export function renderCategories() {
  render($("#cat-list"), Object.entries(state.categories).map(([id, cat]) => {
    const input = el("input.inline-name", { value: cat.name });
    const save = el("button.name-save", { text: "✓" });
    const row = el("div.set-row", {}, [
      el("span.dot-col", { style: { background: cat.color } }),
      el("div.si", {}, input),
      save,
      el("button.iconbtn", { title: "Löschen", on: { click: () => {
        const used = state.places.filter((p) => p.catId === id).length;
        if (used) { toast(`Wird von ${used} Ort(en) genutzt`); return; }
        const gesichert = { ...cat };
        delete state.categories[id];
        renderCategories();
        onCategoriesChanged();
        sichern(() => deleteCategory(id)).then((ok) => {
          if (!ok) { state.categories[id] = gesichert; renderCategories(); onCategoriesChanged(); }
        });
      } } }, icon(ICON.trash, 15)),
    ]);
    wireInlineEdit(input, save, () => cat.name, (value) => {
      cat.name = value;
      renderCategories();
      onCategoriesChanged();
      sichern(() => updateCategory(id, { name: value }));
    });
    return row;
  }));

  const swatches = $("#cat-swatches");
  if (!swatches.childElementCount) {
    render(swatches, CAT_COLORS.map((color) => {
      const btn = el("button", { style: { background: color }, "aria-pressed": String(color === newCatColor) });
      btn.addEventListener("click", () => {
        newCatColor = color;
        Array.from(swatches.children).forEach((c) => c.setAttribute("aria-pressed", "false"));
        btn.setAttribute("aria-pressed", "true");
      });
      return btn;
    }));
  }
}

function applyConfigToForm() {
  $("#cfg-demo").setAttribute("aria-checked", String(state.config.demo));
  updateDemoHint();
  showConnection(null);
}

function updateDemoHint() {
  const sub = $("#conn-sub");
  if (!sub || sub.dataset.locked === "1") return;
  sub.textContent = state.config.demo
    ? "Beispieldaten aktiv — die App zeigt die eingebaute Demo-Reise."
    : isConfigured()
      ? `Angemeldet als ${state.account?.username || "—"}`
      : "Nicht angemeldet — bitte neu laden und anmelden.";
}

function showConnection(status) {
  // Achtung: #conn-state ist der Behälter — beschriftet wird #conn-title,
  // sonst würden Statuspunkt und Untertext überschrieben.
  const dot = $("#conn-dot");
  const label = $("#conn-title");
  const sub = $("#conn-sub");
  if (!dot || !label || !sub) return;

  if (!status) {
    dot.style.background = isConfigured() ? "var(--good)" : "var(--ink-faint)";
    label.textContent = isConfigured() ? "Angemeldet" : "Nicht angemeldet";
    sub.dataset.locked = "0";
    updateDemoHint();
    return;
  }
  dot.style.background = status.ok ? "var(--good)" : "var(--crit)";
  label.textContent = status.ok ? "verbunden" : "Fehler";
  sub.dataset.locked = "1";
  sub.textContent = status.message;
}

async function testConnection() {
  showConnection({ ok: true, message: "Verbindung wird geprüft …" });
  try {
    const result = await health();
    // Die Gesundheitsprüfung antwortet auch ohne gültiges Token mit 200 —
    // erst dieses Feld sagt, ob das Token akzeptiert wurde.
    if (result && result.authenticated === false) {
      showConnection({ ok: false, message: "API erreichbar, aber das Token wird nicht akzeptiert. Bitte prüfen." });
      return;
    }
    const parts = [];
    if (result?.positionsQuelle === "lokal") {
      // Selbst-Hosting: eigene positions-Tabelle
      // statt Traccar-Proxy — andere Kennzahlen als beim Cloudflare-Betrieb.
      parts.push(`Eigene Positionsquelle: ${result.geraete ?? 0} Gerät(e), ${result.positionen ?? 0} Positionen`);
      parts.push(result.letztePosition
        ? `letzte: ${new Date(result.letztePosition).toLocaleString("de-DE")}`
        : "noch keine Position empfangen");
    } else {
      if (result?.traccar) parts.push(`Traccar: ${result.traccar}`);
      parts.push(`Access-Dienst-Token: ${result?.traccarAccessAuth ? "gesetzt" : "nicht gesetzt"}`);
    }
    if (result?.db) parts.push(`Datenbank: ${result.db}`);
    showConnection({ ok: true, message: parts.join(" · ") || "API erreichbar." });
  } catch (err) {
    showConnection({ ok: false, message: String(err.message || err) });
  }
}
