const MS_PRO_STUNDE = 3600000;

export const AUTOMATISCHE_UEBERNACHTUNG_MIN_STAND_STUNDEN = 5;
export const AUTOMATISCHE_UEBERNACHTUNG_NACHT_START = 22;
export const AUTOMATISCHE_UEBERNACHTUNG_NACHT_ENDE = 6;
export const AUTOMATISCHE_UEBERNACHTUNG_MIN_NACHT_STUNDEN = 2;

function datumAusIso(iso) {
  const ms = Date.parse(iso || "");
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function startDesLokalenTages(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function plusTage(date, tage) {
  const kopie = new Date(date);
  kopie.setDate(kopie.getDate() + tage);
  return kopie;
}

export function standdauerStunden(vonIso, bisIso = new Date().toISOString()) {
  const von = Date.parse(vonIso || "");
  const bis = Date.parse(bisIso || "");
  if (!Number.isFinite(von) || !Number.isFinite(bis) || bis <= von) return 0;
  return (bis - von) / MS_PRO_STUNDE;
}

export function nachtfensterStunden(vonIso, bisIso = new Date().toISOString()) {
  const vonDate = datumAusIso(vonIso);
  const bisDate = datumAusIso(bisIso);
  if (!vonDate || !bisDate || bisDate <= vonDate) return 0;

  let tag = plusTage(startDesLokalenTages(vonDate), -1);
  const letzterTag = plusTage(startDesLokalenTages(bisDate), 1);
  let summe = 0;
  while (tag <= letzterTag) {
    const start = new Date(tag);
    start.setHours(AUTOMATISCHE_UEBERNACHTUNG_NACHT_START, 0, 0, 0);
    const ende = plusTage(start, AUTOMATISCHE_UEBERNACHTUNG_NACHT_START > AUTOMATISCHE_UEBERNACHTUNG_NACHT_ENDE ? 1 : 0);
    ende.setHours(AUTOMATISCHE_UEBERNACHTUNG_NACHT_ENDE, 0, 0, 0);

    const overlap = Math.min(bisDate.getTime(), ende.getTime()) - Math.max(vonDate.getTime(), start.getTime());
    if (overlap > 0) summe += overlap / MS_PRO_STUNDE;
    tag = plusTage(tag, 1);
  }
  return summe;
}

export function pruefeAutomatischeUebernachtung(vonIso, bisIso = new Date().toISOString()) {
  const standStunden = standdauerStunden(vonIso, bisIso);
  const nachtStunden = nachtfensterStunden(vonIso, bisIso);
  const qualifiziert =
    standStunden >= AUTOMATISCHE_UEBERNACHTUNG_MIN_STAND_STUNDEN &&
    nachtStunden >= AUTOMATISCHE_UEBERNACHTUNG_MIN_NACHT_STUNDEN;
  return {
    qualifiziert,
    standStunden,
    nachtStunden,
    minStandStunden: AUTOMATISCHE_UEBERNACHTUNG_MIN_STAND_STUNDEN,
    minNachtStunden: AUTOMATISCHE_UEBERNACHTUNG_MIN_NACHT_STUNDEN,
    nachtStart: AUTOMATISCHE_UEBERNACHTUNG_NACHT_START,
    nachtEnde: AUTOMATISCHE_UEBERNACHTUNG_NACHT_ENDE,
  };
}

// Auch spürbar kürzere Stopps (ein Einkauf, ein Restaurantbesuch, ein
// Museum) sollen erfasst werden, nicht nur Übernachtungen — bisher fiel
// z. B. ein Einkaufsbesuch tagsüber komplett durchs Raster, weil er weder
// die Standdauer- noch die Nachtfenster-Schwelle der Übernachtung
// erreichte. Ob/wie solche Stopps später in der Oberfläche auftauchen,
// ist eine eigene Frage — ohne Erfassung gäbe es dafür aber gar keine
// Grundlage. 20 Minuten: lang genug, um kein bloßer Ampelstopp oder
// GPS-Ausrutscher zu sein, kurz genug, um einen kurzen Besuch wirklich zu
// erfassen (Nutzerwunsch, 05.09.2026).
export const KURZER_STOPP_MIN_STUNDEN = 20 / 60;

/** Entscheidet, OB und ALS WAS ein Stand automatisch erfasst werden soll:
 * als Übernachtung (übliche Regeln), sonst als bloßer kurzer Stopp (nur
 * eine Mindestdauer, kein Nachtfenster nötig), oder gar nicht (zu kurz für
 * beides). `standStunden` wird nur einmal berechnet und wiederverwendet,
 * statt pruefeAutomatischeUebernachtung() ein zweites Mal aufzurufen. */
export function entscheideStandKategorie(vonIso, bisIso = new Date().toISOString()) {
  const uebernachtung = pruefeAutomatischeUebernachtung(vonIso, bisIso);
  if (uebernachtung.qualifiziert) return { catId: "uebernachtung", pruefung: uebernachtung };
  if (uebernachtung.standStunden >= KURZER_STOPP_MIN_STUNDEN) return { catId: "stopp", pruefung: uebernachtung };
  return null;
}
