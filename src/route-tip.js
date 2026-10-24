// Text der Info-Karte, die beim Tippen auf die Route erscheint: Tag, Datum,
// Uhrzeit, Kilometer ab Start, Tempo und Höhe des nächsten Routenpunkts.
const WOCHENTAG = new Intl.DateTimeFormat("de-DE", { weekday: "short" });
const DATUM = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit" });
const UHR = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });

const ohnePunkt = (text) => text.replace(/\.$/, "");

export function routenTipp(p) {
  const zeit = p.time ? new Date(p.time) : null;
  const gueltig = zeit && !Number.isNaN(zeit.getTime());
  const kopf = [];
  if (Number.isFinite(p.day)) kopf.push(`Tag ${p.day}`);
  if (gueltig) kopf.push(`${ohnePunkt(WOCHENTAG.format(zeit))} ${ohnePunkt(DATUM.format(zeit))}.`, UHR.format(zeit));

  const zahl = (n, stellen) => n.toLocaleString("de-DE", { maximumFractionDigits: stellen });
  const werte = [];
  if (Number.isFinite(p.cum)) werte.push(`km ${zahl(p.cum, p.cum < 100 ? 1 : 0)}`);
  if (Number.isFinite(p.spd)) werte.push(p.spd < 1 ? "steht" : `${zahl(Math.round(p.spd), 0)} km/h`);
  if (Number.isFinite(p.elev)) werte.push(`${zahl(Math.round(p.elev), 0)} m`);
  return { kopf: kopf.join(" · "), werte: werte.join(" · ") };
}
