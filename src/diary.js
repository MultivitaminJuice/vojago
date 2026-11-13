// Diary: blocks (text and photos), choosing the day and time phrases. Pure
// computation, no DOM — the editor (views/diary-editor.js) and the logbook
// (views/journal.js) draw from it.
//
// Blocks are stored as JSON in tagebuch.blocks: [{ t: "text", text } | { t: "fotos", ids }].
// The value "fotos" is part of the stored format and stays as it is.
import { localDayKey, tripDayKeys, tripDayNumberFromKeys, tripStartIso } from "./day-utils.js";

/** Turn blocks from the database (JSON text or already a list) into a clean list. */
export function parseBlocks(raw) {
  let v = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { v = []; } }
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const b of v) {
    if (b?.t === "text" && typeof b.text === "string") out.push({ t: "text", text: b.text });
    else if (b?.t === "fotos" && Array.isArray(b.ids)) out.push({ t: "fotos", ids: b.ids.filter((x) => typeof x === "string") });
  }
  return out;
}

/** For saving: drop empty paragraphs and photo groups, merge consecutive photo groups. */
export function cleanBlocks(blocks) {
  const out = [];
  for (const b of blocks || []) {
    if (b.t === "text") {
      const text = b.text.replace(/\s+$/, "").replace(/^\s*\n/, "");
      if (text.trim()) out.push({ t: "text", text });
    } else if (b.t === "fotos" && b.ids?.length) {
      const last = out[out.length - 1];
      if (last?.t === "fotos") last.ids = [...last.ids, ...b.ids];
      else out.push({ t: "fotos", ids: [...b.ids] });
    }
  }
  return out;
}

export const allPhotoIds = (blocks) => (blocks || []).flatMap((b) => (b.t === "fotos" ? b.ids : []));
export const hasContent = (blocks) => cleanBlocks(blocks).length > 0;

/**
 * The cover photo of the day: the one photo the entry starts with. If it starts
 * with several photos, they form a collage at the top together (no single cover);
 * a photo in the middle of the text stays there and is not pulled up.
 */
export function coverPhotoId(blocks) {
  const first = cleanBlocks(blocks)[0];
  return first?.t === "fotos" && first.ids.length === 1 ? first.ids[0] : null;
}

/** Blocks without a given photo (the one shown as cover); empty groups are dropped. */
export function withoutPhoto(blocks, id) {
  if (!id) return blocks;
  return cleanBlocks((blocks || []).map((b) => (b.t === "fotos" ? { ...b, ids: b.ids.filter((x) => x !== id) } : b)));
}

/**
 * Photos of an entry that are in no block (uploaded but not placed yet): as a
 * photo group at the start — a single one becomes the cover, several a collage,
 * until they are placed by hand.
 */
export function withUnplacedPhotos(blocks, photoIds) {
  const placed = new Set(allPhotoIds(blocks));
  const missing = (photoIds || []).filter((id) => !placed.has(id));
  return missing.length ? [{ t: "fotos", ids: missing }, ...blocks] : blocks;
}

/** Photos of an entry that are in no block: the editor's tray, in the order of `photoIds`. */
export function trayPhotos(blocks, photoIds) {
  const placed = new Set(allPhotoIds(blocks));
  return (photoIds || []).filter((id) => !placed.has(id));
}

const isEmptyText = (b) => b.t === "text" && !b.text.trim();

/** Join two pieces of text into one flow of paragraphs (blank line between); an empty one disappears. */
const join = (a, b) => {
  if (!a.trim()) return b;
  if (!b.trim()) return a;
  return `${a.replace(/\s+$/, "")}\n\n${b.replace(/^\s+/, "")}`;
};

/**
 * For the editor: bring the blocks into a fixed shape. Text only stands between
 * photo groups (neighbouring texts are joined), empty groups and empty texts
 * between two groups are dropped, groups merge — and there is always a text
 * field at the start and at the end to keep writing.
 */
export function normalizeBlocks(blocks) {
  const out = [];
  for (const b of blocks || []) {
    const top = out[out.length - 1];
    if (b.t === "fotos") {
      if (!b.ids.length) continue;
      if (top?.t === "fotos") { top.ids = [...top.ids, ...b.ids]; continue; }
      // Empty text between two groups: gone, the groups merge.
      if (top && isEmptyText(top) && out[out.length - 2]?.t === "fotos") {
        out.pop();
        out[out.length - 1].ids = [...out[out.length - 1].ids, ...b.ids];
        continue;
      }
      out.push({ t: "fotos", ids: [...b.ids] });
    } else if (top?.t === "text") {
      top.text = join(top.text, b.text);
    } else out.push({ t: "text", text: b.text });
  }
  if (out[0]?.t !== "text") out.unshift({ t: "text", text: "" });
  if (out[out.length - 1].t !== "text") out.push({ t: "text", text: "" });
  return out;
}

/** Take a photo out of all groups (it stays with the entry and so lands in the tray). */
export const removePhotoFromBlocks = (blocks, id) =>
  normalizeBlocks((blocks || []).map((b) => (b.t === "fotos" ? { ...b, ids: b.ids.filter((x) => x !== id) } : b)));

/**
 * Places where a paragraph can be split to insert a photo: every line break
 * (with blank lines around it), not at the start or the end.
 * Returns [{ from, to }]: the text before ends at `from`, the text after starts at `to`.
 */
export function textSplitPoints(text) {
  const out = [];
  const re = /[ \t]*\n[ \t\n]*/g;
  let m;
  while ((m = re.exec(text || ""))) {
    const from = m.index;
    const to = m.index + m[0].length;
    if (from > 0 && to < text.length) out.push({ from, to });
  }
  return out;
}

/**
 * Move a photo to a new place (or insert it for the first time). Targets:
 *  - { kind: "group", block, index }: into photo group `block` at position `index`
 *  - { kind: "between", index }: as its own group before block `index` (merges with a neighbouring group)
 *  - { kind: "text", block, from, to }: split paragraph `block` there and put the photo in between
 * The indexes refer to `blocks` before the move.
 */
export function placePhoto(blocks, id, target) {
  const copy = (blocks || []).map((b) => (b.t === "fotos" ? { t: "fotos", ids: [...b.ids] } : { t: "text", text: b.text }));
  let index = target.index;
  // Empty the old place; empty groups stay for now so the target's indexes are right.
  copy.forEach((b, i) => {
    if (b.t !== "fotos") return;
    const k = b.ids.indexOf(id);
    if (k < 0) return;
    b.ids.splice(k, 1);
    if (target.kind === "group" && target.block === i && k < index) index -= 1;
  });
  if (target.kind === "group") {
    const g = copy[target.block];
    if (g?.t === "fotos") g.ids.splice(Math.max(0, Math.min(index, g.ids.length)), 0, id);
    else copy.push({ t: "fotos", ids: [id] });
  } else if (target.kind === "text" && copy[target.block]?.t === "text") {
    const text = copy[target.block].text;
    const before = text.slice(0, target.from).replace(/\s+$/, "");
    const after = text.slice(target.to ?? target.from).replace(/^\s+/, "");
    copy.splice(target.block, 1, { t: "text", text: before }, { t: "fotos", ids: [id] }, { t: "text", text: after });
  } else {
    copy.splice(Math.max(0, Math.min(target.index ?? copy.length, copy.length)), 0, { t: "fotos", ids: [id] });
  }
  return normalizeBlocks(copy);
}

/** SQLite returns "YYYY-MM-DD HH:MM:SS" in UTC without a time zone. */
const dbTime = (text) => {
  const s = String(text || "");
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? t : NaN;
};

/** When was the day written down, relative to the day itself? "am nächsten Morgen", "2 Tage später" … (UI text) */
export function writtenText(dayKey, writtenAt) {
  const t = dbTime(writtenAt);
  if (!Number.isFinite(t) || !dayKey) return "";
  const when = new Date(t);
  const diff = Math.round((Date.parse(`${localDayKey(when.toISOString())}T12:00:00`) - Date.parse(`${dayKey}T12:00:00`)) / 86400000);
  const hour = when.getHours();
  if (diff < 0) return "";
  if (diff === 0) return hour >= 17 ? "am selben Abend" : "am selben Tag";
  if (diff === 1) return hour < 12 ? "am nächsten Morgen" : "am nächsten Tag";
  return `${diff} Tage später`;
}

/** All days of the trip to choose from: [{ key, number }] from the start to the end of the trip or today. */
export function daysForEditor(trip, { now = new Date(), extraKeys = [] } = {}) {
  const startKey = localDayKey(tripStartIso(trip));
  return tripDayKeys(trip, { nowIso: now.toISOString(), extraKeys })
    .map((key, i) => ({ key, number: tripDayNumberFromKeys(key, startKey) || i + 1 }));
}

/**
 * Which day is the obvious one when "Tag erzählen" opens? In the evening today,
 * otherwise the last past day without an entry (usually yesterday); when every
 * day is written, the most recent one.
 */
export function defaultDay(days, taken, now = new Date()) {
  if (!days.length) return "";
  const today = localDayKey(now.toISOString());
  const open = days.filter((d) => d.key <= today && !taken.has(d.key));
  if (!open.length) return days[days.length - 1].key;
  if (open.some((d) => d.key === today) && now.getHours() >= 17) return today;
  const earlier = open.filter((d) => d.key < today);
  return (earlier[earlier.length - 1] || open[open.length - 1]).key;
}

/** Hint when photos (by their modification date) belong to another trip day than the chosen one. */
export function photoDayHint(files, chosenDay, days) {
  const number = new Map(days.map((d) => [d.key, d.number]));
  const others = new Map();
  for (const f of files) {
    const k = localDayKey(new Date(f.lastModified).toISOString());
    if (k && k !== chosenDay && number.has(k)) others.set(k, (others.get(k) || 0) + 1);
  }
  if (!others.size) return null;
  const [key, n] = [...others.entries()].sort((a, b) => b[1] - a[1])[0];
  return { key, number: number.get(key), count: n };
}
