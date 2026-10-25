import { test } from "node:test";
import assert from "node:assert/strict";
import { tagesWetter, routenGeometrie, tagesVerlauf, tageDerReise, kurzeAdresse } from "../journal-days.js";

const ort = (id, catId, at, extra = {}) => ({ kind: "place", at, data: { id, title: id, catId, at, ...extra } });
const notiz = (id, at) => ({ kind: "note", at, data: { id, at } });

test("tagesWetter: Spanne der Temperaturen und häufigster Zustand, ohne Daten null", () => {
  assert.equal(tagesWetter([]), null);
  assert.equal(tagesWetter([null, { text: "klar" }]), null);
  const w = tagesWetter([{ temp: 14.2, text: "klar", symbol: "S" }, { temp: 19.4, text: "klar", symbol: "S" }, { temp: 16, text: "bedeckt", symbol: "B" }]);
  assert.deepEqual(w, { temp: "14 bis 19°", text: "klar", symbol: "S" });
  assert.equal(tagesWetter([{ temp: 17, text: "klar" }]).temp, "17°");
});

test("routenGeometrie: braucht zwei Punkte, bleibt im Rahmen und setzt Stopps in dieselbe Zeichnung", () => {
  assert.equal(routenGeometrie([{ lon: 10, lat: 50 }], 260, 70), null);
  const pts = Array.from({ length: 300 }, (_, i) => ({ lon: 10 + i * 0.001, lat: 50 + Math.sin(i / 20) * 0.01 }));
  const g = routenGeometrie(pts, 260, 70, 8, 60);
  assert.ok(g.d.startsWith("M"));
  assert.ok(g.d.split("L").length <= 62);
  for (const q of [g.start, g.ende]) { assert.ok(q.x >= 7.9 && q.x <= 252.1); assert.ok(q.y >= 7.9 && q.y <= 62.1); }
  assert.ok(g.ende.x > g.start.x);
  const mitte = g.projiziere(10.15, 50);
  assert.ok(mitte.x > g.start.x && mitte.x < g.ende.x);
});

test("tagesVerlauf: Start, Stopps und Nacht in zeitlicher Folge, Fortführungen zählen nicht", () => {
  const v = tagesVerlauf(
    [ort("nacht", "uebernachtung", "2026-10-19T18:20:00Z"), ort("cafe", "stopp", "2026-10-19T13:10:00Z"), { kind: "night-continuation", at: "2026-10-19T20:00:00Z", data: { id: "x" } }],
    [{ from: "2026-10-19T07:10:00Z", startAddress: "Hauptstraße 1, Imst, Tirol" }],
  );
  assert.deepEqual(v.map((x) => x.art), ["start", "stopp", "nacht"]);
  assert.equal(v[0].titel, "Hauptstraße 1, Imst");
  assert.equal(kurzeAdresse("A, B, C"), "A, B");
});

test("tageDerReise: Tage aus Einträgen, Fahrten und Spur, mit Nummer, Kilometern, Wetter und Verlauf", () => {
  const punkt = (day, time, cum) => ({ day, time, cum, lon: 10, lat: 50 });
  const tage = tageDerReise({
    startIso: "2026-10-19T08:00:00Z",
    eintraege: [
      ort("n1", "uebernachtung", "2026-10-19T18:00:00Z", { weather: { temp: 15, text: "klar", symbol: "S" } }),
      { kind: "night-continuation", at: "2026-10-20T18:00:00Z", data: { id: "n1" } },
      notiz("z1", "2026-10-21T09:00:00Z"),
    ],
    fahrten: [{ from: "2026-10-19T08:30:00Z", km: 120.04, startAddress: "Imst", endAddress: "Landeck" }],
    path: [punkt(1, "2026-10-19T08:30:00Z", 0), punkt(1, "2026-10-19T09:30:00Z", 118), punkt(3, "2026-10-21T09:00:00Z", 118), punkt(3, "2026-10-21T10:00:00Z", 160)],
  });
  assert.deepEqual(tage.map((t) => t.nummer), [1, 2, 3]);
  assert.equal(tage[0].km, 120);
  assert.equal(tage[0].von, "Imst");
  assert.equal(tage[0].nach, "Landeck");
  assert.equal(tage[0].wetter.temp, "15°");
  assert.deepEqual(tage[0].verlauf.map((v) => v.art), ["start", "nacht"]);
  assert.equal(tage[1].eintraege.length, 1);
  assert.equal(tage[1].km, 0);
  assert.equal(tage[2].km, 42);
  assert.equal(tage[2].notizen.length, 1);
});

test("tageDerReise: Tage ohne jeden Inhalt entfallen, nummeriert wird nach Reisestart", () => {
  const tage = tageDerReise({ startIso: "2026-10-19T08:00:00Z", eintraege: [ort("a", "stopp", "2026-10-22T10:00:00Z")], fahrten: [], path: [{ day: 5, time: "2026-10-23T10:00:00Z", cum: 0, lon: 1, lat: 1 }] });
  assert.deepEqual(tage.map((t) => t.key), ["2026-10-22"]);
  assert.equal(tage[0].nummer, 4);
});
