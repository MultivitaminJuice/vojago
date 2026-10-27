// Kalenderlogik für die Datumsauswahl (Zeitraum wählen, Reise bearbeiten). Rein
// rechnend, ohne DOM — der Kalender (ui/kalender.js) zeichnet daraus. Tage sind
// lokale Kalendertage als "JJJJ-MM-TT"; die Woche beginnt am Montag.
const pad = (n) => String(n).padStart(2, "0");

export const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
export const WOCHENTAGE = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

export const tagKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** "2026-10-27" → lokales Datum 0:00 Uhr, oder null. */
export function parseTag(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) || tagKey(d) !== key ? null : d;
}

/** "2026-10-27" → "27.10.2026". */
export function datumText(key) {
  const d = parseTag(key);
  return d ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}` : "";
}

/** Monat zum Anzeigen: das Jahr und der Monat (0–11) eines Tages. */
export function monatVon(key, jetzt = new Date()) {
  const d = parseTag(key) || jetzt;
  return { jahr: d.getFullYear(), monat: d.getMonth() };
}

export function verschiebeMonat({ jahr, monat }, delta) {
  const d = new Date(jahr, monat + delta, 1);
  return { jahr: d.getFullYear(), monat: d.getMonth() };
}

/** Sechs Wochen à sieben Tage für einen Monat (stabile Höhe), Tage außerhalb des Monats sind markiert. */
export function monatsRaster({ jahr, monat }, jetzt = new Date()) {
  const erster = new Date(jahr, monat, 1);
  const versatz = (erster.getDay() + 6) % 7;
  const heute = tagKey(jetzt);
  const wochen = [];
  for (let w = 0; w < 6; w++) {
    const woche = [];
    for (let t = 0; t < 7; t++) {
      const d = new Date(jahr, monat, 1 - versatz + w * 7 + t);
      const key = tagKey(d);
      woche.push({ key, tag: d.getDate(), imMonat: d.getMonth() === monat, heute: key === heute });
    }
    wochen.push(woche);
  }
  return { titel: `${MONATE[monat]} ${jahr}`, wochen };
}

/**
 * Antippen eines Tages beim Wählen eines Zeitraums: das erste Tippen setzt den
 * Anfang, das zweite das Ende (ein früherer Tag vertauscht beides, derselbe Tag
 * ergibt einen einzelnen Tag), ein weiteres Tippen beginnt neu.
 */
export function waehleTag({ von = null, bis = null } = {}, key) {
  if (!von || bis) return { von: key, bis: null };
  if (key < von) return { von: key, bis: von };
  return { von, bis: key };
}

/** Rolle eines Tages im gewählten Zeitraum: "einzel" | "von" | "bis" | "mitte" | null. */
export function rolleImBereich({ von = null, bis = null } = {}, key) {
  if (!von) return null;
  const ende = bis || von;
  if (key === von && key === ende) return "einzel";
  if (key === von) return "von";
  if (key === ende) return "bis";
  return key > von && key < ende ? "mitte" : null;
}

const zeitTeile = (zeit, vorgabe) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(zeit || ""));
  return m ? [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))] : vorgabe;
};

/**
 * Gewählte Tage (und Uhrzeiten, standardmäßig der ganze Tag) als ISO-Zeiten.
 * Das Ende reicht nie in die Zukunft. Liefert null bei fehlendem Start oder wenn das Ende vor dem Start liegt.
 */
export function bereichZuIso({ von, bis }, { vonZeit = "00:00", bisZeit = "23:59", jetzt = new Date() } = {}) {
  const start = parseTag(von);
  const ende = parseTag(bis || von);
  if (!start || !ende) return null;
  const [vh, vm] = zeitTeile(vonZeit, [0, 0]);
  const [bh, bm] = zeitTeile(bisZeit, [23, 59]);
  const from = new Date(start.getFullYear(), start.getMonth(), start.getDate(), vh, vm, 0, 0);
  let to = new Date(ende.getFullYear(), ende.getMonth(), ende.getDate(), bh, bm, 59, 999);
  if (to.getTime() > jetzt.getTime()) to = new Date(jetzt);
  if (to.getTime() < from.getTime()) return null;
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Zeiten (Date) → Auswahl mit Tagen und Uhrzeiten. */
export function bereichAusDaten(from, to) {
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return { von: tagKey(from), bis: tagKey(to), vonZeit: hm(from), bisZeit: hm(to) };
}

/** Voreinstellungen als ganze Tage. "all" braucht die Grenzen der Reisen. */
export function bereichVoreinstellung(name, jetzt = new Date(), alles = null) {
  const heute = new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate());
  const tage = (n) => new Date(heute.getFullYear(), heute.getMonth(), heute.getDate() + n);
  if (name === "today") return { von: tagKey(heute), bis: tagKey(heute) };
  if (name === "yesterday") return { von: tagKey(tage(-1)), bis: tagKey(tage(-1)) };
  if (name === "last7") return { von: tagKey(tage(-6)), bis: tagKey(heute) };
  if (name === "month") return { von: tagKey(new Date(heute.getFullYear(), heute.getMonth(), 1)), bis: tagKey(heute) };
  const von = alles?.von ? new Date(alles.von) : tage(-30);
  const bis = alles?.bis ? new Date(alles.bis) : heute;
  return { von: tagKey(von), bis: tagKey(bis) };
}
