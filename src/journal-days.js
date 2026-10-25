// Logbuch: die Reise als Folge von Tagen (Kapiteln). Rein rechnend, ohne DOM —
// journal.js zeichnet daraus Kopf, Gedankenstütze, Stellplatz-Karten und Notizen.
import { localDayKey, tripDayNumberFromKeys } from "./day-utils.js";
import { bounds } from "./geo.js";

export const kurzeAdresse = (text) => (text || "").split(",").slice(0, 2).join(",").trim();

/** Wetter eines Tages aus den Wettern seiner Besuche: Spanne und häufigster Zustand. */
export function tagesWetter(wetterListe) {
  const w = (wetterListe || []).filter((x) => x && Number.isFinite(Number(x.temp)));
  if (!w.length) return null;
  const temps = w.map((x) => Number(x.temp));
  const min = Math.round(Math.min(...temps));
  const max = Math.round(Math.max(...temps));
  const zaehler = new Map();
  for (const x of w) {
    if (!x.text) continue;
    const e = zaehler.get(x.text) || { n: 0, symbol: x.symbol || "" };
    e.n += 1;
    zaehler.set(x.text, e);
  }
  const [text, e] = [...zaehler.entries()].sort((a, b) => b[1].n - a[1].n)[0] || ["", { symbol: "" }];
  return { temp: min === max ? `${min}°` : `${min} bis ${max}°`, text, symbol: e.symbol };
}

/** Routenzeichnung eines Tages, eingepasst in w × h; `projiziere` setzt Stopps in dieselbe Zeichnung. */
export function routenGeometrie(points, w, h, pad = 8, maxPunkte = 80) {
  const gueltig = (points || []).filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat));
  if (gueltig.length < 2) return null;
  const schritt = Math.max(1, Math.ceil(gueltig.length / maxPunkte));
  const pts = gueltig.filter((_, i) => i % schritt === 0);
  if (pts[pts.length - 1] !== gueltig[gueltig.length - 1]) pts.push(gueltig[gueltig.length - 1]);

  const b = bounds(gueltig);
  const mitteLat = (b.minLat + b.maxLat) / 2;
  const breiteFaktor = Math.cos((mitteLat * Math.PI) / 180);
  const spanX = Math.max((b.maxLon - b.minLon) * breiteFaktor, 1e-6);
  const spanY = Math.max(b.maxLat - b.minLat, 1e-6);
  const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
  const ox = pad + ((w - 2 * pad) - spanX * scale) / 2;
  const oy = pad + ((h - 2 * pad) - spanY * scale) / 2;
  const projiziere = (lon, lat) => ({ x: ox + (lon - b.minLon) * breiteFaktor * scale, y: oy + (b.maxLat - lat) * scale });
  const punkt = (p) => { const q = projiziere(p.lon, p.lat); return `${q.x.toFixed(1)},${q.y.toFixed(1)}`; };
  return { d: "M" + pts.map(punkt).join(" L"), projiziere, start: projiziere(gueltig[0].lon, gueltig[0].lat), ende: projiziere(gueltig.at(-1).lon, gueltig.at(-1).lat) };
}

/** Die Ereignisse eines Tages in zeitlicher Folge: Start, Stopps, Übernachtung. */
export function tagesVerlauf(eintraege, fahrten) {
  const verlauf = [];
  const erste = [...fahrten].sort((a, b) => String(a.from).localeCompare(String(b.from)))[0];
  if (erste?.from) verlauf.push({ zeit: erste.from, art: "start", titel: kurzeAdresse(erste.startAddress) });
  for (const e of eintraege) {
    if (e.kind !== "place") continue;
    verlauf.push({
      zeit: e.at || e.data.at || "",
      art: e.data.catId === "uebernachtung" ? "nacht" : "stopp",
      titel: e.data.title || "",
      ortId: e.data.id,
    });
  }
  return verlauf.sort((a, b) => String(a.zeit).localeCompare(String(b.zeit)));
}

/**
 * Tage der Reise mit allem, was dazugehört. `eintraege`: flache Liste aus
 * journal.js ({ kind: "place" | "night-continuation" | "note", at, data }),
 * `fahrten`: Fahrten der Reise, `path`: Spur mit `day`-Nummer je Punkt.
 * `zusatzTage`: Tage, die auch ohne Besuch/Fahrt/Spur ein Kapitel bekommen
 * (z. B. weil dort ein Tagebucheintrag steht).
 * Tage ohne jeden Inhalt (keine Einträge, keine Fahrt, keine Spur) entfallen.
 */
export function tageDerReise({ startIso, eintraege, fahrten, path, zusatzTage = [] }) {
  const tage = new Map();
  const tag = (key) => {
    if (!tage.has(key)) tage.set(key, { key, eintraege: [], fahrten: [], punkte: [] });
    return tage.get(key);
  };
  for (const e of eintraege) { const k = localDayKey(e.at); if (k) tag(k).eintraege.push(e); }
  for (const f of fahrten) { const k = localDayKey(f.from); if (k) tag(k).fahrten.push(f); }
  const extra = new Set(zusatzTage);
  for (const k of extra) tag(k);

  // Spur: Punkte tragen ihre Tagesnummer; der Schlüssel kommt vom ersten Punkt des Tages.
  const nachNummer = new Map();
  for (const p of path || []) {
    if (!nachNummer.has(p.day)) nachNummer.set(p.day, []);
    nachNummer.get(p.day).push(p);
  }
  for (const punkte of nachNummer.values()) {
    const k = localDayKey(punkte[0]?.time);
    if (k && punkte.length >= 2) tag(k).punkte = punkte;
  }

  const startKey = localDayKey(startIso);
  return [...tage.values()]
    .filter((t) => t.eintraege.length || t.fahrten.length || t.punkte.length >= 2 || extra.has(t.key))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((t, i) => {
      const orte = t.eintraege.filter((e) => e.kind === "place");
      const notizen = t.eintraege.filter((e) => e.kind === "note");
      const kmFahrten = t.fahrten.reduce((s, f) => s + (Number(f.km) || 0), 0);
      const kmSpur = t.punkte.length >= 2 ? t.punkte.at(-1).cum - t.punkte[0].cum : 0;
      const sortiert = [...t.fahrten].sort((a, b) => String(a.from).localeCompare(String(b.from)));
      return {
        key: t.key,
        nummer: tripDayNumberFromKeys(t.key, startKey) || i + 1,
        eintraege: t.eintraege,
        notizen,
        punkte: t.punkte,
        km: Math.round((t.fahrten.length ? kmFahrten : kmSpur) * 10) / 10,
        von: kurzeAdresse(sortiert[0]?.startAddress),
        nach: kurzeAdresse(sortiert.at(-1)?.endAddress),
        wetter: tagesWetter([...orte.map((e) => e.data.weather), ...notizen.map((e) => e.data.weather)]),
        verlauf: tagesVerlauf(t.eintraege, t.fahrten),
      };
    });
}
