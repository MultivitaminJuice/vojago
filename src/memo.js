// Keeps one computed value per key until the data it depends on changes.
// `revision` is the data revision (state.js: aktuellerDatenStand) and `path`
// the route array the value was computed from; a new route is always a new
// array. Values of a running trip are also renewed after `maxAgeMs`, because
// their duration grows with the clock.
export function createMemo() {
  const entries = new Map();
  return function remember(key, { revision, path, running = false, maxAgeMs = 60_000, now = Date.now() }, compute) {
    const old = entries.get(key);
    if (old && old.revision === revision && old.path === path && (!running || now - old.time < maxAgeMs)) return old.value;
    const value = compute();
    entries.set(key, { revision, path, time: now, value });
    if (entries.size > 200) entries.delete(entries.keys().next().value);
    return value;
  };
}
