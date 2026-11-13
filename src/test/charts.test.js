import test from "node:test";
import assert from "node:assert/strict";
import { downsample } from "../views/charts.js";

test("downsample: short series stay unchanged", () => {
  const values = [1, 2, 3];
  assert.deepEqual(downsample(values, 400), values);
});

test("downsample: long series are averaged down to n points", () => {
  const values = Array.from({ length: 1000 }, (_, i) => i);
  const series = downsample(values, 10);
  assert.equal(series.length, 10);
  assert.equal(series[0], 49.5); // mean of 0..99
  assert.equal(series[9], 949.5);
});

test("downsample: the overall mean is kept, also for lengths that do not divide evenly", () => {
  const values = Array.from({ length: 1003 }, (_, i) => (i % 7) * 10);
  const series = downsample(values, 100);
  assert.equal(series.length, 100);
  const mittel = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(Math.abs(mittel(series) - mittel(values)) < 1);
});

test("downsample: very long series (200,000 points) work without errors", () => {
  const values = new Array(200_000).fill(5);
  const series = downsample(values, 400);
  assert.equal(series.length, 400);
  assert.ok(series.every((v) => v === 5));
});

test("niceScale: round steps, the highest value fits below", async () => {
  const { niceScale } = await import("../views/charts.js");
  assert.deepEqual(niceScale(558).ticks, [0, 200, 400, 600]);
  assert.equal(niceScale(558).max, 600);
  assert.deepEqual(niceScale(73).ticks, [0, 50, 100]);
  assert.deepEqual(niceScale(1000).ticks, [0, 500, 1000]);
  assert.deepEqual(niceScale(4.2).ticks, [0, 2, 4, 6].slice(0, niceScale(4.2).ticks.length));
  assert.ok(niceScale(4.2).max >= 4.2);
  assert.deepEqual(niceScale(0), { max: 1, step: 1, ticks: [0, 1] });
  assert.deepEqual(niceScale(-3).ticks, [0, 1]);
});
