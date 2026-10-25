import { test } from "node:test";
import assert from "node:assert/strict";
import { mercatorPx, kartenAnsicht, kachelAdresse, routenPfad } from "../mini-karte.js";

test("mercatorPx: Nullmeridian/Äquator liegen in der Mitte, Norden ist oben (kleineres y)", () => {
  const m = mercatorPx(0, 0, 1);
  assert.ok(Math.abs(m.x - 256) < 1e-6 && Math.abs(m.y - 256) < 1e-6);
  assert.ok(mercatorPx(10, 60, 5).y < mercatorPx(10, 50, 5).y);
  assert.ok(mercatorPx(11, 50, 5).x > mercatorPx(10, 50, 5).x);
});

test("kartenAnsicht: braucht zwei Punkte, passt alles in den Rahmen und deckt ihn mit Kacheln ab", () => {
  assert.equal(kartenAnsicht([{ lon: 8, lat: 50 }], 340, 150), null);
  const pts = [{ lon: 8.0, lat: 50.0 }, { lon: 8.6, lat: 50.2 }, { lon: 9.1, lat: 50.4 }];
  const a = kartenAnsicht(pts, 340, 150);
  for (const p of pts) {
    const q = a.projiziere(p.lon, p.lat);
    assert.ok(q.x >= 17.9 && q.x <= 340 - 17.9, `x ${q.x}`);
    assert.ok(q.y >= 17.9 && q.y <= 150 - 17.9, `y ${q.y}`);
  }
  // Eine Stufe näher würde nicht mehr passen — die gewählte ist die größte.
  const naeher = kartenAnsicht(pts, 340, 150, { minZoom: a.zoom + 1, maxZoom: a.zoom + 1 });
  const q = naeher.projiziere(9.1, 50.4), r = naeher.projiziere(8.0, 50.0);
  assert.ok(Math.abs(q.x - r.x) > 340 - 36 || Math.abs(q.y - r.y) > 150 - 36);
  // Kacheln decken den Rahmen vollständig ab.
  const links = Math.min(...a.kacheln.map((k) => k.links)), oben = Math.min(...a.kacheln.map((k) => k.oben));
  const rechts = Math.max(...a.kacheln.map((k) => k.links + 256)), unten = Math.max(...a.kacheln.map((k) => k.oben + 256));
  assert.ok(links <= 0 && oben <= 0 && rechts >= 340 && unten >= 150);
  assert.ok(a.kacheln.length >= 1 && a.kacheln.length <= 6);
});

test("kartenAnsicht: sehr kurze Strecke wird nicht über maxZoom hinaus vergrößert", () => {
  const a = kartenAnsicht([{ lon: 8, lat: 50 }, { lon: 8.00001, lat: 50.00001 }], 340, 150, { maxZoom: 15 });
  assert.equal(a.zoom, 15);
});

test("kachelAdresse und routenPfad", () => {
  assert.equal(kachelAdresse("https://x/{z}/{x}/{y}.png", { z: 7, x: 68, y: 43 }), "https://x/7/68/43.png");
  const pts = Array.from({ length: 300 }, (_, i) => ({ lon: 8 + i * 0.001, lat: 50 }));
  const a = kartenAnsicht(pts, 340, 150);
  const d = routenPfad(pts, a.projiziere, 50);
  assert.ok(d.startsWith("M") && d.split("L").length <= 52);
  assert.equal(routenPfad([], a.projiziere), "");
});
