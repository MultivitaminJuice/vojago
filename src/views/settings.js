// The "Einstellungen" (settings) view: vehicles, categories, connection, accounts,
// sharing links. UI texts stay German.
import { el, render, icon, toast, $, $$ } from "../dom.js";
import { applyTheme, validTheme } from "../theme.js";
import { routeInfoRows } from "../route-info.js";
import { validMapStyle } from "../map-style.js";
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
import { status as dataStatus, forgetSnapshot, routeLoadLog } from "../dataload.js";
import { clearRoutes } from "../route-store.js";
import { clearDebugLog, debugCount, debugEnabled, exportDebugLog, preciseDebugDataEnabled, setDebugEnabled, setPreciseDebugDataEnabled } from "../debug.js";

const CAT_COLORS = ["#e8802b", "#3b82c4", "#7a5cd6", "#3f9d5a", "#b5476b", "#caa23a", "#1f9e8f", "#d84a4a", "#4b47a8", "#c24b86"];
let newCatColor = CAT_COLORS[0];
let onCategoriesChanged = () => {};
let onSourceChanged = () => {};

// Known devices for assigning one to a vehicle: the devices that have sent to
// the positions table at least once. Loaded once per opening of the vehicles
// view, not on every key press.
let knownDevices = [];
let ingestInfo = null;
async function loadKnownDevices() {
  if (!isCentral()) { knownDevices = []; return; }
  try { knownDevices = (await fetchDevices()) || []; }
  catch { knownDevices = []; } // e.g. no device seen yet — not worth an error
}

async function loadIngestInfo() {
  if (!isCentral() || !state.account?.isAdmin) { ingestInfo = null; return; }
  try { ingestInfo = await ingestStatus(); }
  catch { ingestInfo = null; }
}

/**
 * When connected, categories and vehicles belong in the database — otherwise
 * every device would see something else. Only with demo data (or while the API
 * is unreachable) are they kept locally.
 */
const isCentral = () => !state.config.demo && isConfigured();

async function persist(task) {
  saveLocalData(); // always locally too, so nothing is lost offline
  if (!isCentral()) return true;
  try {
    await task();
    await storeSettings(collectPreferences()).catch(() => {});
    return true;
  } catch (err) {
    toast(`Nicht gespeichert: ${err.message}`);
    return false;
  }
}

/**
 * Redraw the account area. Needed because the settings are built on start but
 * the sign-in check answers only afterwards — otherwise it would show "Nicht
 * angemeldet" for good.
 */
export function refreshAccountState() {
  showConnection(null);
  applyConfigToForm();
  renderEmailStatus();
  renderSharesList();
  // Management (vehicles, categories, connection, local data, users) is only
  // visible to admins on purpose — all accounts see the same trips and places,
  // but only admins should change the shared configuration.
  const isAdmin = Boolean(state.account?.isAdmin);
  for (const id of ["vehicles-group", "categories-group", "connection-group", "ingest-group", "backup-group", "local-data-group", "users-group"]) {
    const group = $(`#${id}`);
    if (group) group.hidden = !isAdmin;
  }
  if (isAdmin) {
    renderUsersList();
    // Not blocking — the row is already shown, known devices trickle in as
    // suggestions once they arrive.
    loadKnownDevices().then(renderVehicles);
    loadIngestInfo().then(renderIngestControls);
  }
}

/** Shows whether an e-mail address is stored and confirmed — both are needed
 * for "Passwort vergessen". */
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

/** List of existing sharing links — trip name (or "Alle Reisen"), scope, expiry,
 * last access, revoke button. Only useful when connected. */
async function renderSharesList() {
  const box = $("#shares-list");
  if (!box) return;
  if (!isCentral()) { render(box, [el("p.sub", { text: "Anmelden, um Reisen zu teilen." })]); return; }
  let shares = [];
  try { shares = await listShares(); } catch { render(box, [el("p.sub", { text: "Freigaben konnten nicht geladen werden." })]); return; }
  // Revoked links stay in the database (traceability) but not in this list —
  // there they would only be dead weight.
  shares = shares.filter((s) => !s.revoked_at);
  if (!shares.length) { render(box, [el("p.sub", { text: "Noch keine Freigabe erstellt." })]); return; }
  render(box, shares.map((s) => {
    const target = s.trip_id ? (s.trip_name || "gelöschte Reise") : "Alle Reisen";
    const expiry = s.expires_at ? `bis ${new Date(s.expires_at).toLocaleDateString("de-DE")}` : "kein Ablauf";
    const scopeLabel = s.scope === "karte_logbuch" ? "Karte + Logbuch" : "Nur Karte";
    return el("div.set-row", {}, [
      el("div.si", {}, [
        el("b", { text: s.label ? `${s.label} · ${target}` : target }),
        el("div", { text: `${scopeLabel} · ${expiry} · ${s.view_count || 0}× geöffnet` }),
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

function showShareForm(visible) {
  const panel = $("#share-panel");
  if (!panel) return;
  panel.hidden = !visible;
  if (!visible) return;
  const select = $("#share-trip");
  select.innerHTML = '<option value="">Alle Reisen</option>';
  for (const t of state.trips) {
    select.appendChild(el("option", { value: t.id, text: t.name }));
  }
  $("#share-label").value = "";
}

async function createShareLink() {
  const btn = $("#share-create");
  btn.disabled = true;
  try {
    const tripId = $("#share-trip").value || undefined;
    const scope = $("#share-scope").value;
    const label = $("#share-label").value.trim() || undefined;
    const daysRaw = $("#share-expiry").value;
    const expiresInDays = daysRaw ? Number(daysRaw) : undefined;
    const { token } = await createShare({ tripId, scope, label, expiresInDays });
    const link = `${location.origin}/share/${token}`;
    try { await navigator.clipboard.writeText(link); toast("Link erstellt und kopiert"); }
    catch { toast(`Link erstellt: ${link}`); }
    showShareForm(false);
    renderSharesList();
  } catch (err) {
    toast(err.message || "Link konnte nicht erstellt werden");
  } finally {
    btn.disabled = false;
  }
}

// Which row has its password field open — at most one at a time, like the other
// forms in this view.
let openPasswordRow = null;

async function renderUsersList() {
  const box = $("#users-list");
  if (!box) return;
  let users = [];
  try { users = await listUsers(); }
  catch { render(box, [el("p.sub", { text: "Nutzer konnten nicht geladen werden." })]); return; }
  const ownId = users.find((u) => u.username === state.account?.username)?.id;

  render(box, users.map((u) => {
    const input = el("input.inline-name", { value: u.username });
    const save = el("button.name-save", { text: "✓" });
    const passwordOpen = openPasswordRow === u.id;
    const userRow = el("div.set-row", {}, [
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
        on: { click: () => { openPasswordRow = passwordOpen ? null : u.id; renderUsersList(); } },
      }, icon(ICON.edit, 15)),
      u.id === ownId ? null : el("button.iconbtn", {
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
    if (!passwordOpen) return userRow;
    const pwInput = el("input", { type: "password", placeholder: "Neues Passwort (mind. 10 Zeichen)", autocomplete: "new-password" });
    const setPassword = el("button.btn.primary", {
      text: "Setzen",
      on: { click: async () => {
        try {
          await updateUser(u.id, { password: pwInput.value });
          openPasswordRow = null;
          toast("Passwort gesetzt — die Sitzungen dieses Kontos wurden beendet");
          renderUsersList();
        } catch (err) { toast(err.message || "Passwort konnte nicht gesetzt werden"); }
      } },
    });
    return el("div", {}, [userRow, el("div.set-row", {}, [el("div.si", {}, pwInput), setPassword])]);
  }));
}

function showUserForm(visible) {
  const panel = $("#user-panel");
  if (!panel) return;
  panel.hidden = !visible;
  if (!visible) return;
  $("#user-new-name").value = "";
  $("#user-new-pw").value = "";
  $("#user-new-admin").setAttribute("aria-checked", "false");
}

async function createUserAccount() {
  const btn = $("#user-create");
  btn.disabled = true;
  try {
    const username = $("#user-new-name").value.trim();
    const password = $("#user-new-pw").value;
    const isAdmin = $("#user-new-admin").getAttribute("aria-checked") === "true";
    await createUser({ username, password, isAdmin });
    toast("Nutzer angelegt");
    showUserForm(false);
    renderUsersList();
  } catch (err) {
    toast(err.message || "Nutzer konnte nicht angelegt werden");
  } finally {
    btn.disabled = false;
  }
}

/** Store the preferences without their own record (display, layers) centrally. */
export function syncPreferences() {
  saveLocalData();
  if (isCentral()) storeSettings(collectPreferences()).catch(() => {});
}

export function initSettings({ onCategoriesChange, onSourceChange }) {
  onCategoriesChanged = onCategoriesChange;
  onSourceChanged = onSourceChange || (() => {});

  $("#veh-add").addEventListener("click", () => {
    const id = `veh_${Date.now().toString(36)}`;
    state.vehicles.push({ id, name: "Neues Fahrzeug", device: "neu" });
    renderVehicles();
    persist(() => createVehicle({ id, name: "Neues Fahrzeug" }))
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
    persist(() => createCategory({ id, name, color: newCatColor }))
      .then((ok) => ok && toast("Kategorie hinzugefügt"));
  });

  $("#cfg-logout").addEventListener("click", async () => {
    try { await logout(); } catch { /* auch bei Fehler abmelden */ }
    await clearRoutes();
    location.reload();
  });

  $("#cfg-password").addEventListener("click", () => showPasswordForm(true));
  $("#pw-cancel").addEventListener("click", () => showPasswordForm(false));
  $("#pw-save").addEventListener("click", savePassword);

  $("#cfg-email-btn").addEventListener("click", () => showEmailForm(true));
  $("#email-cancel").addEventListener("click", () => showEmailForm(false));
  $("#email-save").addEventListener("click", saveEmail);

  $("#share-add").addEventListener("click", () => showShareForm(true));
  $("#share-cancel").addEventListener("click", () => showShareForm(false));
  $("#share-create").addEventListener("click", createShareLink);

  $("#user-add")?.addEventListener("click", () => showUserForm(true));
  $("#user-cancel")?.addEventListener("click", () => showUserForm(false));
  $("#user-create")?.addEventListener("click", createUserAccount);
  $("#user-new-admin")?.addEventListener("click", () => {
    const btn = $("#user-new-admin");
    btn.setAttribute("aria-checked", String(btn.getAttribute("aria-checked") !== "true"));
  });

  $("#cfg-test").addEventListener("click", testConnection);
  $("#ingest-learn")?.addEventListener("click", async () => {
    const learningActive = Boolean(ingestInfo?.learningActive);
    try {
      ingestInfo = await setIngestLearning({ enabled: !learningActive, minutes: 10 });
      await loadKnownDevices();
      await loadIngestInfo();
      renderVehicles();
      renderIngestControls();
      toast(learningActive ? "Lernmodus beendet" : "Lernmodus für 10 Minuten aktiv");
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

  const showTheme = () => {
    const current = validTheme(state.config.theme);
    $$("#theme-tabs [data-theme-wahl]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeWahl === current)));
  };
  $$("#theme-tabs [data-theme-wahl]").forEach((b) => b.addEventListener("click", () => {
    state.config.theme = validTheme(b.dataset.themeWahl);
    applyTheme(state.config.theme);
    saveConfig();
    showTheme();
  }));
  showTheme();

  const showMapStyle = () => {
    const current = validMapStyle(state.config.mapStyle);
    $$("#mapstyle-tabs [data-kartenstil-wahl]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.kartenstilWahl === current)));
  };
  $$("#mapstyle-tabs [data-kartenstil-wahl]").forEach((b) => b.addEventListener("click", () => {
    state.config.mapStyle = validMapStyle(b.dataset.kartenstilWahl);
    saveConfig();
    mapview.setMapStyle(state.config.mapStyle);
    showMapStyle();
  }));
  showMapStyle();

  const gapsSwitch = $("#cfg-luecken");
  if (gapsSwitch) {
    gapsSwitch.setAttribute("aria-checked", String(Boolean(state.config.markGaps)));
    gapsSwitch.addEventListener("click", () => {
      const enabled = gapsSwitch.getAttribute("aria-checked") !== "true";
      gapsSwitch.setAttribute("aria-checked", String(enabled));
      state.config.markGaps = enabled;
      saveConfig();
      mapview.setGaps(enabled);
    });
  }

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

function showPasswordForm(visible) {
  const panel = $("#password-panel");
  panel.hidden = !visible;
  if (!visible) {
    $("#pw-old").value = "";
    $("#pw-new").value = "";
    $("#pw-repeat").value = "";
    return;
  }
  $("#pw-old").focus();
}

async function savePassword() {
  const oldPassword = $("#pw-old").value;
  const newPassword = $("#pw-new").value;
  const repeat = $("#pw-repeat").value;
  if (!oldPassword) { toast("Bitte bisheriges Passwort eingeben"); return; }
  if (newPassword.length < 10) { toast("Neues Passwort braucht mindestens 10 Zeichen"); return; }
  if (newPassword !== repeat) { toast("Die neuen Passwörter stimmen nicht überein"); return; }

  const btn = $("#pw-save");
  btn.disabled = true;
  btn.textContent = "Speichert …";
  try {
    await changePassword(oldPassword, newPassword);
    showPasswordForm(false);
    toast("Passwort geändert — andere Geräte wurden abgemeldet");
  } catch (err) {
    toast(err.message || "Passwort konnte nicht geändert werden");
  } finally {
    btn.disabled = false;
    btn.textContent = "Speichern";
  }
}

function showEmailForm(visible) {
  const panel = $("#email-panel");
  panel.hidden = !visible;
  if (!visible) { $("#email-new").value = ""; $("#email-pw-confirm").value = ""; return; }
  $("#email-new").value = state.account?.email || "";
  $("#email-new").focus();
}

async function saveEmail() {
  const email = $("#email-new").value.trim();
  const confirmPassword = $("#email-pw-confirm").value;
  if (!email.includes("@")) { toast("Das sieht nicht nach einer E-Mail-Adresse aus"); return; }
  if (!confirmPassword) { toast("Bitte Passwort eingeben"); return; }

  const btn = $("#email-save");
  btn.disabled = true;
  try {
    await setEmail(confirmPassword, email);
    // Every newly saved address counts only after confirmation — the link is
    // on its way.
    state.account = { ...state.account, email, emailVerified: false };
    showEmailForm(false);
    renderEmailStatus();
    toast("E-Mail gespeichert — Bestätigungslink verschickt");
  } catch (err) {
    toast(err.message || "E-Mail konnte nicht gespeichert werden");
  } finally {
    btn.disabled = false;
  }
}

/** More → Status → Route: when and how the route was last updated. */
export function renderRouteInfo() {
  const box = $("#route-info");
  if (!box) return;
  render(box, routeInfoRows(routeLoadLog).map(([k, v]) => el("div", {}, [el("span", { text: k }), el("b", { text: v })])));
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

/** Saves a vehicle change — creating the vehicle on the server first if needed.
 * The initial default vehicle (see state.js) has no `id` yet — without this
 * branch its first change (e.g. entering a device id) would only land locally
 * and never show up on the server, even when connected.
 * @param {object} local field names as in the client state (name, device, active)
 */
function saveVehicle(vehicle, local) {
  Object.assign(vehicle, local);
  // On the server the field is called traccar_device_id, locally just device —
  // translated here in one place instead of at every call site.
  const serverPatch = {};
  if ("name" in local) serverPatch.name = local.name;
  if ("device" in local) serverPatch.traccar_device_id = local.device || null;
  if ("active" in local) serverPatch.active = local.active;

  if (vehicle.id) {
    persist(() => updateVehicle(vehicle.id, serverPatch));
    return;
  }
  if (!isCentral()) { saveLocalData(); return; }
  vehicle.id = `veh_${Date.now().toString(36)}`;
  // vehicle.active does not exist in the client state otherwise (active is always
  // state.activeVehicle as an index) — derived from the index when creating, so
  // an already active default vehicle does not count as inactive.
  const isActive = "active" in local ? local.active : state.vehicles.indexOf(vehicle) === state.activeVehicle;
  persist(() => createVehicle({ id: vehicle.id, name: vehicle.name, traccar_device_id: vehicle.device || null, active: isActive }));
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
  // One shared suggestion list for all vehicles — the device ids that actually
  // sent before. Replaces typing by feel with a choice from real data, but still
  // allows free input (e.g. a device that never sent).
  const datalist = el("datalist#geraete-vorschlaege", {}, knownDevices.map((g) =>
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
          // The active vehicle decides directly which device the app queries.
          state.config.device = vehicle.device || "";
          saveConfig();
          renderVehicles(); emit("vehicles");
          saveVehicle(vehicle, { active: true }); // syncs state.config.device through collectPreferences()
          onSourceChanged(); // new device -> reload positions and drives
        } },
      }, icon(ICON.check, 15)),
      el("div.si", {}, [
        // Both fields are built alike (label, input and their own save button in
        // one row) — earlier only the device id had a label, so the name did not
        // look like an input field.
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
            const removed = state.vehicles[index];
            state.vehicles.splice(index, 1);
            if (state.activeVehicle >= state.vehicles.length) state.activeVehicle = 0;
            renderVehicles(); emit("vehicles");
            if (removed.id) persist(() => deleteVehicle(removed.id)); else saveLocalData();
          } } }, icon(ICON.trash, 15))
        : null,
    ]);
    wireInlineEdit(input, save, () => vehicle.name, (value) => {
      // saveVehicle() FIRST — it writes vehicle.name synchronously (before going to
      // the server). In the wrong order renderVehicles() redraws itself with the
      // old name (seen: after saving, the old value was still in the field).
      saveVehicle(vehicle, { name: value });
      renderVehicles(); emit("vehicles");
    });
    // A separate wireInlineEdit call for the device id — its own field and saved
    // state, independent of the name.
    wireInlineEdit(deviceInput, deviceSave, () => vehicle.device || "", (value) => {
      // If this is the active vehicle, state.config.device (what the app actually
      // queries) follows at once — otherwise changing the active vehicle's device
      // id would do nothing live.
      if (index === state.activeVehicle) { state.config.device = value; saveConfig(); }
      saveVehicle(vehicle, { device: value }); // before renderVehicles(), see the comment above
      renderVehicles(); emit("vehicles");
      if (index === state.activeVehicle) onSourceChanged(); // new device -> reload positions and drives
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
        const previous = { ...cat };
        delete state.categories[id];
        renderCategories();
        onCategoriesChanged();
        persist(() => deleteCategory(id)).then((ok) => {
          if (!ok) { state.categories[id] = previous; renderCategories(); onCategoriesChanged(); }
        });
      } } }, icon(ICON.trash, 15)),
    ]);
    wireInlineEdit(input, save, () => cat.name, (value) => {
      cat.name = value;
      renderCategories();
      onCategoriesChanged();
      persist(() => updateCategory(id, { name: value }));
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
  // Careful: #conn-state is the container — the label is #conn-title, otherwise
  // the status dot and subtitle would be overwritten.
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
    // The health check answers 200 even without a valid session — only this
    // field says whether the session was accepted.
    if (result && result.authenticated === false) {
      showConnection({ ok: false, message: "API erreichbar, aber das Token wird nicht akzeptiert. Bitte prüfen." });
      return;
    }
    const parts = [];
    parts.push(`Eigene Positionsquelle: ${result?.geraete ?? 0} Gerät(e), ${result?.positionen ?? 0} Positionen`);
    parts.push(result?.letztePosition
      ? `letzte: ${new Date(result.letztePosition).toLocaleString("de-DE")}`
      : "noch keine Position empfangen");
    if (result?.db) parts.push(`Datenbank: ${result.db}`);
    showConnection({ ok: true, message: parts.join(" · ") || "API erreichbar." });
  } catch (err) {
    showConnection({ ok: false, message: String(err.message || err) });
  }
}
