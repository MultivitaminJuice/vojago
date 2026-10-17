#!/usr/bin/env node
// Einmal pro Klon: Git-Hooks aktivieren und den lokalen Ordner anlegen.
//   npm run setup-local
// (Details: docs/local-setup.md)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";

execFileSync("git", ["config", "core.hooksPath", ".githooks"]);
console.log("✓ Git-Hooks aktiv (core.hooksPath = .githooks): Prüfung vor Commit, Commit-Nachricht und Push");

for (const ordner of ["local/fixtures", "local/docs", "local/data"]) mkdirSync(ordner, { recursive: true });
for (const [von, nach] of [["local.example/denylist.example.txt", "local/denylist.txt"], ["local.example/README.md", "local/README.md"]]) {
  if (!existsSync(nach)) { cpSync(von, nach); console.log(`✓ ${nach} angelegt (aus ${von})`); }
  else console.log(`· ${nach} existiert schon — unverändert gelassen`);
}
console.log("\nNächster Schritt: local/denylist.txt mit deinen eigenen sensiblen Begriffen füllen.");
