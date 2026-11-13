import { test } from "node:test";
import assert from "node:assert/strict";
import { mercatorPx, mapView, tileUrl, routePath } from "../mini-map.js";

test("mercatorPx: prime meridian and equator are in the middle, north is up (smaller y)", () => {
  const m = mercatorPx(0, 0, 1);
  assert.ok(Math.abs(m.x - 256) < 1e-6 && Math.abs(m.y - 256) < 1e-6);
  assert.ok(mercatorPx(10, 60, 5).y < mercatorPx(10, 50, 5).y);
  assert.ok(mercatorPx(11, 50, 5).x > mercatorPx(10, 50, 5).x);
});

test("mapView: needs two points, fits everything into the frame and covers it with tiles", () => {
  assert.equal(mapView([{ lon: 8, lat: 50 }], 340, 150), null);
  const pts = [{ lon: 8.0, lat: 50.0 }, { lon: 8.6, lat: 50.2 }, { lon: 9.1, lat: 50.4 }];
  const a = mapView(pts, 340, 150);
  for (const p of pts) {
    const q = a.project(p.lon, p.lat);
    assert.ok(q.x >= 17.9 && q.x <= 340 - 17.9, `x ${q.x}`);
    assert.ok(q.y >= 17.9 && q.y <= 150 - 17.9, `y ${q.y}`);
  }
  // One level closer would not fit any more — the chosen one is the largest.
  const closer = mapView(pts, 340, 150, { minZoom: a.zoom + 1, maxZoom: a.zoom + 1 });
  const q = closer.project(9.1, 50.4), r = closer.project(8.0, 50.0);
  assert.ok(Math.abs(q.x - r.x) > 340 - 36 || Math.abs(q.y - r.y) > 150 - 36);
  // The tiles cover the frame completely.
  const left = Math.min(...a.tiles.map((k) => k.left)), top = Math.min(...a.tiles.map((k) => k.top));
  const right = Math.max(...a.tiles.map((k) => k.left + 256)), bottom = Math.max(...a.tiles.map((k) => k.top + 256));
  assert.ok(left <= 0 && top <= 0 && right >= 340 && bottom >= 150);
  assert.ok(a.tiles.length >= 1 && a.tiles.length <= 6);
});

test("mapView: a very short route is not enlarged beyond maxZoom", () => {
  const a = mapView([{ lon: 8, lat: 50 }, { lon: 8.00001, lat: 50.00001 }], 340, 150, { maxZoom: 15 });
  assert.equal(a.zoom, 15);
});

test("tileUrl and routePath", () => {
  assert.equal(tileUrl("https://x/{z}/{x}/{y}.png", { z: 7, x: 68, y: 43 }), "https://x/7/68/43.png");
  const pts = Array.from({ length: 300 }, (_, i) => ({ lon: 8 + i * 0.001, lat: 50 }));
  const a = mapView(pts, 340, 150);
  const d = routePath(pts, a.project, 50);
  assert.ok(d.startsWith("M") && d.split("L").length <= 52);
  assert.equal(routePath([], a.project), "");
});
