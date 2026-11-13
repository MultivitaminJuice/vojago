// Previous / next day or drive within a trip (Trips view and map).

/** Neighbouring entry in a list of summaries (days or drives); direction -1 = previous, +1 = next. */
export function neighbour(summaries, currentId, direction) {
  if (!Array.isArray(summaries)) return null;
  const i = summaries.findIndex((s) => s.id === currentId);
  if (i < 0) return null;
  return summaries[i + direction] || null;
}

/** What the navigation shows: whether there is a previous/next entry. */
export function dayNavigation(summaries, currentId) {
  if (!Array.isArray(summaries) || summaries.length < 2) return null;
  const i = summaries.findIndex((s) => s.id === currentId);
  if (i < 0) return null;
  return { hasPrevious: i > 0, hasNext: i < summaries.length - 1, position: i + 1, count: summaries.length };
}
