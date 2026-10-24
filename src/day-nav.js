// Vorheriger / nächster Tag innerhalb einer Reise (Reisen → Tage und Karte).

/** Tages-Zusammenfassungen tragen die ID "<reiseId>:day:<n>" (siehe route-summary.js). */
export function tagIdInfo(id) {
  const m = /^(.+):day:(\d+)$/.exec(String(id || ""));
  return m ? { reiseId: m[1], tag: Number(m[2]) } : null;
}

/** Nachbartag in der Liste der Tages-Zusammenfassungen; richtung -1 = vorher, +1 = nächster. */
export function tagNachbar(summaries, aktuelleId, richtung) {
  if (!Array.isArray(summaries)) return null;
  const i = summaries.findIndex((s) => s.id === aktuelleId);
  if (i < 0) return null;
  return summaries[i + richtung] || null;
}

/** Was die Navigation anzeigen soll: ob es einen Vorgänger/Nachfolger gibt. */
export function tagNavigation(summaries, aktuelleId) {
  if (!Array.isArray(summaries) || summaries.length < 2) return null;
  const i = summaries.findIndex((s) => s.id === aktuelleId);
  if (i < 0) return null;
  return { hatVorher: i > 0, hatNaechster: i < summaries.length - 1, position: i + 1, anzahl: summaries.length };
}
