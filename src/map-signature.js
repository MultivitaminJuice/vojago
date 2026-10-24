// Fingerabdruck dessen, was die Routen-Ebenen der Karte darstellen. Ändert er
// sich zwischen zwei Zeichenaufträgen nicht, muss die Linie nicht neu an die
// Grafik gegeben werden (jedes Neuaufbauen ließ sie kurz flackern).
export function routenSignatur(reiseId, segmente, metric, ctx = {}) {
  return JSON.stringify([
    reiseId,
    metric,
    [ctx.elevMin, ctx.elevMax, Math.round((ctx.totalKm || 0) * 1000), ctx.days, ctx.hue, ctx.rangeMode, ctx.hasUnassignedTripPoints,
      (ctx.trips || []).map((t) => t.id)],
    segmente.map((s) => {
      const erster = s[0];
      const letzter = s[s.length - 1];
      const mitte = s[s.length >> 1];
      return [s.length, erster?.time, letzter?.time, erster?.lon, letzter?.lon, mitte?.lat, Math.round((letzter?.cum || 0) * 1000)];
    }),
  ]);
}
