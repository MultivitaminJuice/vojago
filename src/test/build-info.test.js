import test from "node:test";
import assert from "node:assert/strict";
import { versionAnzeige, ermittleBuild, buildAnzeige } from "../../scripts/build-info.mjs";

test("Version: ein abschließendes .0 entfällt, sonst bleibt sie", () => {
  assert.equal(versionAnzeige("1.0.0"), "1.0");
  assert.equal(versionAnzeige("1.1.0"), "1.1");
  assert.equal(versionAnzeige("1.2.3"), "1.2.3");
  assert.equal(versionAnzeige("2.0.0"), "2.0");
});

test("Build: BUILD_NUMBER/BUILD_COMMIT aus der Umgebung haben Vorrang vor git", () => {
  const git = () => { throw new Error("git darf nicht gefragt werden"); };
  const b = ermittleBuild({ env: { BUILD_NUMBER: "142", BUILD_COMMIT: "A1B2C3D4E5F6" }, gitAbfrage: git });
  assert.deepEqual(b, { nummer: 142, commit: "a1b2c3d" });
});

test("Build: ohne Umgebung kommt es aus git", () => {
  const antworten = { "rev-list": "57", "rev-parse": "9f8e7d6" };
  const b = ermittleBuild({ env: {}, gitAbfrage: (kommando) => antworten[kommando] });
  assert.deepEqual(b, { nummer: 57, commit: "9f8e7d6" });
});

test("Build: weder Umgebung noch git — keine Nummer, kein Commit (Rückfall auf den Hash)", () => {
  const b = ermittleBuild({ env: {}, gitAbfrage: () => "" });
  assert.deepEqual(b, { nummer: null, commit: null });
  assert.equal(buildAnzeige(b, "abc123def4"), "abc123def4");
});

test("Build: ungültige Werte werden ignoriert, nie in die Seite übernommen", () => {
  const b = ermittleBuild({ env: { BUILD_NUMBER: "<script>", BUILD_COMMIT: "../../etc" }, gitAbfrage: () => "" });
  assert.deepEqual(b, { nummer: null, commit: null });
});

test("Build-Anzeige: Nummer mit Commit, Nummer allein", () => {
  assert.equal(buildAnzeige({ nummer: 142, commit: "a1b2c3d" }, "hash"), "142 · a1b2c3d");
  assert.equal(buildAnzeige({ nummer: 142, commit: null }, "hash"), "142");
});
