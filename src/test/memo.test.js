import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemo } from "../memo.js";

test("createMemo: same data revision and route → computed once", () => {
  const merke = createMemo();
  const path = [1, 2];
  let n = 0;
  const rechne = () => ++n;
  assert.equal(merke("a", { stand: 1, path }, rechne), 1);
  assert.equal(merke("a", { stand: 1, path }, rechne), 1);
  assert.equal(n, 1);
});

test("createMemo: new revision, new route array or another key → computed again", () => {
  const merke = createMemo();
  let n = 0;
  const rechne = () => ++n;
  const path = [1];
  merke("a", { stand: 1, path }, rechne);
  assert.equal(merke("a", { stand: 2, path }, rechne), 2);
  assert.equal(merke("a", { stand: 2, path: [1] }, rechne), 3);
  assert.equal(merke("b", { stand: 2, path }, rechne), 4);
});

test("createMemo: a running trip is renewed after maxAlterMs", () => {
  const merke = createMemo();
  let n = 0;
  const rechne = () => ++n;
  const path = [];
  merke("a", { stand: 1, path, laufend: true, now: 0 }, rechne);
  assert.equal(merke("a", { stand: 1, path, laufend: true, now: 59_000 }, rechne), 1);
  assert.equal(merke("a", { stand: 1, path, laufend: true, now: 61_000 }, rechne), 2);
});
