// Warns before unsaved inline changes are lost — instead of silently dropping
// them when leaving (switching tabs, closing or reloading the page) OR saving
// them automatically without asking (both were tried and rightly rejected): it
// asks, like any normal app, with a "discard changes?" dialog.
const tracked = new Set();

/** wireInlineEdit registers here automatically — no work at the call site. `el`
 * is the input field: every redraw (render() rebuilds whole lists, e.g.
 * renderVehicles()) creates fresh fields with fresh checks WITHOUT the old ones
 * unregistering — without the isConnected check below, an old check replaced by
 * a new field would stay forever and report "unsaved" everywhere after the
 * first change, even right after saving (seen: the question still came after
 * saving). */
export function trackDirty(isDirtyFn, el) {
  tracked.add({ isDirty: isDirtyFn, el });
}

function anyDirty() {
  for (const entry of tracked) {
    if (!entry.el.isConnected) { tracked.delete(entry); continue; }
    try { if (entry.isDirty()) return true; } catch { tracked.delete(entry); }
  }
  return false;
}

/** Call before switching views inside the app (tab bar, More sub-tabs, closing
 * sheets, …). Returns true when it is fine to go on — nothing was open, or the
 * user explicitly confirmed discarding. */
export function mayLeave() {
  if (!anyDirty()) return true;
  return confirm("Es gibt eine ungespeicherte Änderung. Trotzdem verlassen und verwerfen?");
}

window.addEventListener("beforeunload", (e) => {
  if (anyDirty()) { e.preventDefault(); e.returnValue = ""; }
});
