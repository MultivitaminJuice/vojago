// Fingerprint of what the route layers of the map show. If it does not change
// between two draw requests, the line need not be handed to the graphics again
// (every rebuild made it flicker briefly).
export function routeSignature(tripId, segments, metric, ctx = {}) {
  return JSON.stringify([
    tripId,
    metric,
    [ctx.elevMin, ctx.elevMax, Math.round((ctx.totalKm || 0) * 1000), ctx.days, ctx.hue, ctx.rangeMode, ctx.hasUnassignedTripPoints,
      (ctx.trips || []).map((t) => t.id)],
    segments.map((s) => {
      const first = s[0];
      const last = s[s.length - 1];
      const middle = s[s.length >> 1];
      return [s.length, first?.time, last?.time, first?.lon, last?.lon, middle?.lat, Math.round((last?.cum || 0) * 1000)];
    }),
  ]);
}
