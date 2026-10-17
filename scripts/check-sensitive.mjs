#!/usr/bin/env node
// Prüft, ob etwas Privates committet oder gepusht würde (siehe docs/local-setup.md).
//   node scripts/check-sensitive.mjs --staged            vor dem Commit (Index)
//   node scripts/check-sensitive.mjs --message <datei>   Commit-Nachricht
//   node scripts/check-sensitive.mjs --push              vor dem Push (liest die Ref-Zeilen von stdin)
//   node scripts/check-sensitive.mjs --tree              alle versionierten Dateien
// Beendet sich mit 1, wenn eine Regel trifft. Umgehen nur bewusst: git commit/push --no-verify.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  ALLGEMEINE_REGELN, regelnAusSperrliste, findeTreffer, hinzugefuegteZeilen,
} from "./sensitive-lib.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const wurzel = git("rev-parse", "--show-toplevel").trim();
const sperrliste = `${wurzel}/local/denylist.txt`;

let regeln = [...ALLGEMEINE_REGELN];
if (existsSync(sperrliste)) regeln = regeln.concat(regelnAusSperrliste(readFileSync(sperrliste, "utf8")));
else console.warn("Hinweis: local/denylist.txt fehlt — nur allgemeine Muster werden geprüft (siehe docs/local-setup.md).");

const AUSNAHMEN = [/^package-lock\.json$/, /^docs\/screenshots\//, /\.(jpg|png|woff2?)$/];
const ausgenommen = (datei) => !datei || AUSNAHMEN.some((r) => r.test(datei));

const gefunden = [];
function pruefeDiff(diff, praefix = "") {
  for (const z of hinzugefuegteZeilen(diff)) {
    if (ausgenommen(z.datei)) continue;
    for (const t of findeTreffer(z.text, regeln)) gefunden.push(`${praefix}${z.datei}:${z.zeile}  [${t.regel}]  ${t.inhalt}`);
  }
}
function pruefeText(text, ort) {
  for (const t of findeTreffer(text, regeln)) gefunden.push(`${ort}:${t.zeile}  [${t.regel}]  ${t.inhalt}`);
}

const modus = process.argv[2] || "--staged";
if (modus === "--staged") {
  pruefeDiff(git("diff", "--cached", "-U0", "--no-color", "--no-ext-diff"));
  for (const datei of git("diff", "--cached", "--name-only").split("\n").filter(Boolean)) pruefeText(datei, `Dateiname ${datei}`);
} else if (modus === "--message") {
  pruefeText(readFileSync(process.argv[3], "utf8"), "Commit-Nachricht");
} else if (modus === "--tree") {
  for (const datei of git("ls-files").split("\n").filter(Boolean)) {
    if (ausgenommen(datei)) continue;
    try { pruefeText(readFileSync(`${wurzel}/${datei}`, "utf8"), datei); } catch { /* binär/fehlt */ }
  }
} else if (modus === "--push") {
  const eingabe = readFileSync(0, "utf8").split("\n").filter(Boolean);
  for (const zeile of eingabe) {
    const [, lokal, , entfernt] = zeile.split(" ");
    if (/^0+$/.test(lokal)) continue; // Branch wird gelöscht
    const bereich = /^0+$/.test(entfernt) ? [lokal, "--not", "--remotes"] : [`${entfernt}..${lokal}`];
    pruefeDiff(git("log", "-p", "-U0", "--no-color", "--no-ext-diff", "--format=", ...bereich), "Push: ");
    for (const nachricht of git("log", "--format=%H%n%B%x00", ...bereich).split("\0").filter((n) => n.trim())) {
      pruefeText(nachricht, `Push: Commit-Nachricht ${nachricht.trim().slice(0, 7)}`);
    }
  }
} else {
  console.error(`unbekannter Modus: ${modus}`);
  process.exit(2);
}

if (gefunden.length) {
  console.error("\nAbgebrochen — mögliche private/sensible Daten:\n");
  for (const g of gefunden.slice(0, 40)) console.error(`  ${g}`);
  if (gefunden.length > 40) console.error(`  … und ${gefunden.length - 40} weitere`);
  console.error("\nBitte neutralisieren (siehe docs/local-setup.md). Nur wenn es ein Fehlalarm ist: mit --no-verify umgehen.\n");
  process.exit(1);
}
