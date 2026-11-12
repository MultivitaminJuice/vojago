// Keeps one computed value per key until the data it depends on changes.
// `stand` is the data revision (state.js: aktuellerDatenStand) and `path`
// the route array the value was computed from; a new route is always a new
// array. Values of a running trip are also renewed after `maxAlterMs`,
// because their duration grows with the clock.
export function createMemo() {
  const eintraege = new Map();
  return function merke(schluessel, { stand, path, laufend = false, maxAlterMs = 60_000, now = Date.now() }, rechne) {
    const alt = eintraege.get(schluessel);
    if (alt && alt.stand === stand && alt.path === path && (!laufend || now - alt.zeit < maxAlterMs)) return alt.wert;
    const wert = rechne();
    eintraege.set(schluessel, { stand, path, zeit: now, wert });
    if (eintraege.size > 200) eintraege.delete(eintraege.keys().next().value);
    return wert;
  };
}
