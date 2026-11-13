// Colour scales for colouring the route.

const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgb = (a) => `rgb(${a[0]},${a[1]},${a[2]})`;

function ramp(stops, t) {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    if (x <= stops[i + 1][0]) {
      const local = (x - stops[i][0]) / (stops[i + 1][0] - stops[i][0] || 1);
      return rgb(mix(stops[i][1], stops[i + 1][1], local));
    }
  }
  return rgb(stops[stops.length - 1][1]);
}

const SPEED = [[0, hex("#3b82c4")], [0.4, hex("#4fb477")], [0.7, hex("#e8c34a")], [1, hex("#e0503a")]];
const ELEV  = [[0, hex("#2e7d57")], [0.45, hex("#b9a55c")], [0.75, hex("#9c6b3f")], [1, hex("#ece2d6")]];
const DIST  = [[0, hex("#5b57c9")], [0.5, hex("#c24b86")], [1, hex("#e8802b")]];
const DAY   = [[0, hex("#e8802b")], [0.5, hex("#d6487e")], [1, hex("#5b57c9")]];

export const SPEED_MAX = 90;

function dayProgress(point, ctx) {
  const days = Math.max(1, Number(ctx.days) || 1);
  if (days <= 1) return 0;
  return ((Number(point.day) || 1) - 1) / (days - 1);
}

/** Colour of a route point for the chosen metric. "none" = a single-colour
 * route in the trip's own colour (ctx.hue), not coloured by value — the
 * original plain look as a deliberate option. */
export function colorFor(point, metric, ctx) {
  switch (metric) {
    case "none": return `hsl(${ctx.hue ?? 28},70%,52%)`;
    case "trip": return Number.isFinite(point.tripHue)
      ? `hsl(${point.tripHue},70%,52%)`
      : ctx.rangeMode ? "#8a9a95" : `hsl(${ctx.hue ?? 28},70%,52%)`;
    case "elev": return ramp(ELEV, (point.elev - ctx.elevMin) / (ctx.elevMax - ctx.elevMin));
    case "dist": return ramp(DIST, ctx.totalKm ? point.cum / ctx.totalKm : 0);
    case "day":  return ramp(DAY, dayProgress(point, ctx));
    default:     return ramp(SPEED, point.spd / SPEED_MAX);
  }
}

/** Description for the legend: a gradient with a scale, categories, or `null`
 * (no legend — "none" has no scale to explain). Labels are UI and stay German. */
export function legendFor(metric, ctx) {
  switch (metric) {
    case "none": return null;
    case "trip":
      return ctx.trips?.length
        ? {
            title: "Reisen",
            items: [
              ...ctx.trips.map((trip) => ({ label: trip.name, color: `hsl(${trip.hue},70%,52%)` })),
              ...(ctx.hasUnassignedTripPoints ? [{ label: "Ohne Reise", color: "#8a9a95" }] : []),
            ],
          }
        : null;
    case "elev":
      return { title: "Höhe · m", gradient: "linear-gradient(90deg,#2e7d57,#b9a55c,#9c6b3f,#ece2d6)",
               scale: [Math.round(ctx.elevMin), Math.round((ctx.elevMin + ctx.elevMax) / 2), Math.round(ctx.elevMax)] };
    case "dist":
      return { title: "km ab Start", gradient: "linear-gradient(90deg,#5b57c9,#c24b86,#e8802b)",
               scale: [0, Math.round(ctx.totalKm / 2), Math.round(ctx.totalKm)] };
    case "day":
      // With exactly 2 days the middle showed the same value as the start
      // (Math.ceil(2/2) = 1) — "1 / 1 / 2". Two labels are enough for two days.
      return { title: "Reisetag", gradient: "linear-gradient(90deg,#e8802b,#d6487e,#5b57c9)",
               scale: ctx.days > 2 ? [1, Math.ceil(ctx.days / 2), ctx.days] : ctx.days === 2 ? [1, 2] : [1] };
    default:
      return { title: "Tempo · km/h", gradient: "linear-gradient(90deg,#3b82c4,#4fb477,#e8c34a,#e0503a)",
               scale: [0, SPEED_MAX / 2, SPEED_MAX] };
  }
}
