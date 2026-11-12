import { test } from "node:test";
import assert from "node:assert/strict";
import { thinPositions, compactRoute } from "../lib.js";

// 0.0001° of longitude at 52° north is about 6.85 m.
const row = (sec, lon, { lat = 52, kmh = 90, altitude = 100 } = {}) => ({ at: sec * 1000, lat, lon, speed_kmh: kmh, altitude });

test("thinPositions: a straight run at steady speed keeps its ends and one point every 30 s", () => {
  const rows = Array.from({ length: 121 }, (_, i) => row(i, 8 + i * 0.0003));
  const out = thinPositions(rows);
  assert.equal(out[0], rows[0]);
  assert.equal(out.at(-1), rows.at(-1));
  assert.ok(out.length <= 9, `kept ${out.length}`);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].at - out[i - 1].at <= 30_000);
});

test("thinPositions: a bend, a speed change and a climb are kept", () => {
  const gerade = Array.from({ length: 21 }, (_, i) => row(i, 8 + i * 0.0003));
  const kurve = gerade.map((r, i) => (i === 10 ? { ...r, lat: 52.0001 } : r));       // 11 m off the line
  const bremsen = gerade.map((r, i) => (i === 10 ? { ...r, speed_kmh: 60 } : r));
  const kuppe = gerade.map((r, i) => (i === 10 ? { ...r, altitude: 110 } : r));
  assert.equal(thinPositions(gerade).length, 2);
  for (const rows of [kurve, bremsen, kuppe]) assert.ok(thinPositions(rows).includes(rows[10]));
});

test("thinPositions: no kept line strays more than the tolerance from a dropped point", () => {
  // A wavy road: every dropped point must lie within 2 m of the kept line.
  const rows = Array.from({ length: 400 }, (_, i) => row(i, 8 + i * 0.0003, { lat: 52 + 0.0004 * Math.sin(i / 15) }));
  const out = thinPositions(rows);
  assert.ok(out.length < rows.length / 2);
  const mx = (r) => r.lon * 111_320 * Math.cos((52 * Math.PI) / 180);
  const my = (r) => r.lat * 111_320;
  let k = 0;
  for (const r of rows) {
    while (out[k + 1].at < r.at) k++;
    const a = out[k], b = out[k + 1];
    const dx = mx(b) - mx(a), dy = my(b) - my(a);
    const t = Math.max(0, Math.min(1, ((mx(r) - mx(a)) * dx + (my(r) - my(a)) * dy) / (dx * dx + dy * dy)));
    assert.ok(Math.hypot(mx(r) - mx(a) - t * dx, my(r) - my(a) - t * dy) <= 2.0001);
  }
});

test("thinPositions: both ends of a recording gap stay", () => {
  const rows = [...Array.from({ length: 10 }, (_, i) => row(i, 8 + i * 0.0003)), ...Array.from({ length: 10 }, (_, i) => row(100 + i, 8.03 + i * 0.0003))];
  const out = thinPositions(rows);
  assert.ok(out.includes(rows[9]));
  assert.ok(out.includes(rows[10]));
});

test("thinPositions: short and empty lists", () => {
  assert.deepEqual(thinPositions([]), []);
  assert.deepEqual(thinPositions(null), []);
  const zwei = [row(0, 8), row(1, 8.0003)];
  assert.deepEqual(thinPositions(zwei), zwei);
});

test("compactRoute: arrays with rounded values and the original count", () => {
  const out = compactRoute([{ at: 1000, lat: 52.12345678, lon: 8.98765432, altitude: 101.26, speed_kmh: 88.84 }], 7);
  assert.deepEqual(out, { v: 1, total: 7, fields: ["at", "lat", "lon", "altitude", "kmh"], points: [[1000, 52.123457, 8.987654, 101.3, 88.8]] });
});
