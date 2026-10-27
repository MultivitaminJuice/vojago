import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tagKey, parseTag, datumText, monatVon, verschiebeMonat, monatsRaster, waehleTag, rolleImBereich,
  bereichZuIso, bereichAusDaten, bereichVoreinstellung,
} from "../kalender.js";

test("tagKey, parseTag, datumText: lokale Kalendertage hin und zurück, Unsinn wird abgelehnt", () => {
  assert.equal(tagKey(new Date(2026, 9, 7, 23, 59)), "2026-10-07");
  assert.equal(tagKey(parseTag("2026-10-27")), "2026-10-27");
  assert.equal(parseTag("2026-02-30"), null);
  assert.equal(parseTag("kaputt"), null);
  assert.equal(datumText("2026-10-07"), "07.10.2026");
  assert.equal(datumText(""), "");
});

test("verschiebeMonat: über Jahresgrenzen", () => {
  assert.deepEqual(verschiebeMonat({ jahr: 2026, monat: 11 }, 1), { jahr: 2027, monat: 0 });
  assert.deepEqual(verschiebeMonat({ jahr: 2026, monat: 0 }, -1), { jahr: 2025, monat: 11 });
  assert.deepEqual(monatVon("2026-10-27"), { jahr: 2026, monat: 9 });
});

test("monatsRaster: Oktober 2026 beginnt an einem Donnerstag, sechs Wochen, Montag zuerst", () => {
  const r = monatsRaster({ jahr: 2026, monat: 9 }, new Date(2026, 9, 27));
  assert.equal(r.titel, "Oktober 2026");
  assert.equal(r.wochen.length, 6);
  assert.ok(r.wochen.every((w) => w.length === 7));
  // 1. Oktober 2026 ist ein Donnerstag: davor Mo 28.9. bis Mi 30.9.
  assert.deepEqual(r.wochen[0].map((t) => t.tag), [28, 29, 30, 1, 2, 3, 4]);
  assert.deepEqual(r.wochen[0].map((t) => t.imMonat), [false, false, false, true, true, true, true]);
  assert.equal(r.wochen.flat().filter((t) => t.heute).map((t) => t.key).join(), "2026-10-27");
  assert.equal(r.wochen.flat().filter((t) => t.imMonat).length, 31);
});

test("monatsRaster: Monat, der an einem Montag beginnt, hat keinen Vormonat in der ersten Zeile", () => {
  const r = monatsRaster({ jahr: 2026, monat: 5 }, new Date(2026, 0, 1)); // 1. Juni 2026 = Montag
  assert.equal(r.wochen[0][0].key, "2026-06-01");
  assert.ok(r.wochen[0][0].imMonat);
});

test("waehleTag: erst Anfang, dann Ende; früherer Tag vertauscht; derselbe Tag ist ein Tag; dann neu", () => {
  let a = waehleTag({}, "2026-10-10");
  assert.deepEqual(a, { von: "2026-10-10", bis: null });
  a = waehleTag(a, "2026-10-14");
  assert.deepEqual(a, { von: "2026-10-10", bis: "2026-10-14" });
  assert.deepEqual(waehleTag(a, "2026-10-20"), { von: "2026-10-20", bis: null });
  assert.deepEqual(waehleTag({ von: "2026-10-10", bis: null }, "2026-10-03"), { von: "2026-10-03", bis: "2026-10-10" });
  assert.deepEqual(waehleTag({ von: "2026-10-10", bis: null }, "2026-10-10"), { von: "2026-10-10", bis: "2026-10-10" });
});

test("rolleImBereich", () => {
  const b = { von: "2026-10-10", bis: "2026-10-12" };
  assert.deepEqual(["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"].map((k) => rolleImBereich(b, k)), [null, "von", "mitte", "bis", null]);
  assert.equal(rolleImBereich({ von: "2026-10-10", bis: null }, "2026-10-10"), "einzel");
  assert.equal(rolleImBereich({}, "2026-10-10"), null);
});

test("bereichZuIso: ganze Tage von 0:00 bis 23:59:59, das Ende nie in der Zukunft", () => {
  const jetzt = new Date(2026, 9, 27, 15, 30);
  const r = bereichZuIso({ von: "2026-10-18", bis: "2026-10-20" }, { jetzt });
  assert.equal(new Date(r.from).getTime(), new Date(2026, 9, 18, 0, 0, 0, 0).getTime());
  assert.equal(new Date(r.to).getTime(), new Date(2026, 9, 20, 23, 59, 59, 999).getTime());
  // Bis heute: Ende ist jetzt, nicht 23:59.
  const heute = bereichZuIso({ von: "2026-10-27", bis: "2026-10-27" }, { jetzt });
  assert.equal(heute.to, jetzt.toISOString());
  // Nur ein Tag gewählt: ein Tag.
  const eintag = bereichZuIso({ von: "2026-10-20", bis: null }, { jetzt });
  assert.equal(new Date(eintag.to).getTime(), new Date(2026, 9, 20, 23, 59, 59, 999).getTime());
});

test("bereichZuIso: eigene Uhrzeiten, ungültige Reihenfolge und fehlender Start", () => {
  const jetzt = new Date(2026, 9, 27, 15, 30);
  const r = bereichZuIso({ von: "2026-10-20", bis: "2026-10-20" }, { vonZeit: "08:15", bisZeit: "12:00", jetzt });
  assert.equal(new Date(r.from).getTime(), new Date(2026, 9, 20, 8, 15, 0, 0).getTime());
  assert.equal(new Date(r.to).getTime(), new Date(2026, 9, 20, 12, 0, 59, 999).getTime());
  assert.equal(bereichZuIso({ von: "2026-10-20", bis: "2026-10-20" }, { vonZeit: "14:00", bisZeit: "09:00", jetzt }), null);
  assert.equal(bereichZuIso({ von: null, bis: null }, { jetzt }), null);
});

test("bereichAusDaten und Voreinstellungen", () => {
  assert.deepEqual(bereichAusDaten(new Date(2026, 9, 18, 6, 5), new Date(2026, 9, 20, 22, 0)), { von: "2026-10-18", bis: "2026-10-20", vonZeit: "06:05", bisZeit: "22:00" });
  const jetzt = new Date(2026, 9, 27, 15, 30);
  assert.deepEqual(bereichVoreinstellung("today", jetzt), { von: "2026-10-27", bis: "2026-10-27" });
  assert.deepEqual(bereichVoreinstellung("yesterday", jetzt), { von: "2026-10-26", bis: "2026-10-26" });
  assert.deepEqual(bereichVoreinstellung("last7", jetzt), { von: "2026-10-21", bis: "2026-10-27" });
  assert.deepEqual(bereichVoreinstellung("month", jetzt), { von: "2026-10-01", bis: "2026-10-27" });
  assert.deepEqual(bereichVoreinstellung("all", jetzt, { von: new Date(2026, 5, 2), bis: new Date(2026, 6, 9) }), { von: "2026-06-02", bis: "2026-07-09" });
});
