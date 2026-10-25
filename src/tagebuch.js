// Tagebuch: Blöcke (Text und Fotos), Tagesauswahl und Zeitangaben. Rein rechnend,
// ohne DOM — der Editor (views/tag-editor.js) und das Logbuch (views/journal.js)
// zeichnen daraus.
import { localDayKey, tripDayKeys, tripDayNumberFromKeys, tripStartIso } from "./day-utils.js";

/** Blöcke aus der Datenbank (JSON-Text oder schon eine Liste) in eine saubere Liste verwandeln. */
export function parseBlocks(roh) {
  let v = roh;
  if (typeof roh === "string") { try { v = JSON.parse(roh); } catch { v = []; } }
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const b of v) {
    if (b?.t === "text" && typeof b.text === "string") out.push({ t: "text", text: b.text });
    else if (b?.t === "fotos" && Array.isArray(b.ids)) out.push({ t: "fotos", ids: b.ids.filter((x) => typeof x === "string") });
  }
  return out;
}

/** Zum Speichern: leere Absätze und Foto-Gruppen entfernen, aufeinanderfolgende Foto-Gruppen verschmelzen. */
export function bereinigeBlocks(blocks) {
  const out = [];
  for (const b of blocks || []) {
    if (b.t === "text") {
      const text = b.text.replace(/\s+$/, "").replace(/^\s*\n/, "");
      if (text.trim()) out.push({ t: "text", text });
    } else if (b.t === "fotos" && b.ids?.length) {
      const letzter = out[out.length - 1];
      if (letzter?.t === "fotos") letzter.ids = [...letzter.ids, ...b.ids];
      else out.push({ t: "fotos", ids: [...b.ids] });
    }
  }
  return out;
}

export const alleFotoIds = (blocks) => (blocks || []).flatMap((b) => (b.t === "fotos" ? b.ids : []));
export const hatInhalt = (blocks) => bereinigeBlocks(blocks).length > 0;

/** Das Titelbild des Tages: das erste Foto des Eintrags. */
export const titelbildId = (blocks) => alleFotoIds(blocks)[0] || null;

/** Blöcke ohne ein bestimmtes Foto (das als Titelbild gezeigt wird); leere Gruppen entfallen. */
export function ohneFoto(blocks, id) {
  if (!id) return blocks;
  return bereinigeBlocks((blocks || []).map((b) => (b.t === "fotos" ? { ...b, ids: b.ids.filter((x) => x !== id) } : b)));
}

/** Fotos eines Eintrags, die in keinem Block stehen (z. B. hochgeladen, dann nicht gespeichert) — als Foto-Gruppe ans Ende. */
export function mitVerwaistenFotos(blocks, fotoIds) {
  const drin = new Set(alleFotoIds(blocks));
  const fehlend = (fotoIds || []).filter((id) => !drin.has(id));
  return fehlend.length ? [...blocks, { t: "fotos", ids: fehlend }] : blocks;
}

/** SQLite liefert "JJJJ-MM-TT HH:MM:SS" in UTC ohne Zeitzone. */
const dbZeit = (text) => {
  const s = String(text || "");
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? t : NaN;
};

/** Wann wurde der Tag aufgeschrieben, bezogen auf den Tag selbst? "am nächsten Morgen", "2 Tage später" … */
export function geschriebenText(tagKey, geschriebenAm) {
  const t = dbZeit(geschriebenAm);
  if (!Number.isFinite(t) || !tagKey) return "";
  const wann = new Date(t);
  const diff = Math.round((Date.parse(`${localDayKey(wann.toISOString())}T12:00:00`) - Date.parse(`${tagKey}T12:00:00`)) / 86400000);
  const stunde = wann.getHours();
  if (diff < 0) return "";
  if (diff === 0) return stunde >= 17 ? "am selben Abend" : "am selben Tag";
  if (diff === 1) return stunde < 12 ? "am nächsten Morgen" : "am nächsten Tag";
  return `${diff} Tage später`;
}

/** Alle Tage der Reise zum Auswählen: [{ key, nummer }] von Reisebeginn bis Reiseende bzw. heute. */
export function tageFuerEditor(trip, { jetzt = new Date(), extraKeys = [] } = {}) {
  const startKey = localDayKey(tripStartIso(trip));
  return tripDayKeys(trip, { nowIso: jetzt.toISOString(), extraKeys })
    .map((key, i) => ({ key, nummer: tripDayNumberFromKeys(key, startKey) || i + 1 }));
}

/**
 * Welcher Tag ist der naheliegende, wenn man "Tag erzählen" öffnet? Abends der
 * heutige, sonst der letzte vergangene Tag ohne Eintrag (also meist gestern);
 * sind alle Tage erzählt, der jüngste.
 */
export function standardTag(tage, belegt, jetzt = new Date()) {
  if (!tage.length) return "";
  const heute = localDayKey(jetzt.toISOString());
  const offen = tage.filter((t) => t.key <= heute && !belegt.has(t.key));
  if (!offen.length) return tage[tage.length - 1].key;
  if (offen.some((t) => t.key === heute) && jetzt.getHours() >= 17) return heute;
  const vortage = offen.filter((t) => t.key < heute);
  return (vortage[vortage.length - 1] || offen[offen.length - 1]).key;
}

/** Hinweis, wenn Fotos (nach ihrem Änderungsdatum) zu einem anderen Reisetag gehören als dem gewählten. */
export function fotoTagHinweis(dateien, gewaehlterTag, tage) {
  const nummer = new Map(tage.map((t) => [t.key, t.nummer]));
  const andere = new Map();
  for (const f of dateien) {
    const k = localDayKey(new Date(f.lastModified).toISOString());
    if (k && k !== gewaehlterTag && nummer.has(k)) andere.set(k, (andere.get(k) || 0) + 1);
  }
  if (!andere.size) return null;
  const [key, n] = [...andere.entries()].sort((a, b) => b[1] - a[1])[0];
  return { key, nummer: nummer.get(key), anzahl: n };
}
