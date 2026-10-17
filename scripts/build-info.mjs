// Versions- und Build-Anzeige der App (Status-Tab "App"):
//   Version  — aus package.json (einzige Quelle): "1.0.0" wird als "1.0" gezeigt,
//              "1.2.3" bleibt "1.2.3"
//   Build    — fortlaufende Nummer + Commit, z. B. "142 · a1b2c3d"
//   Gebaut   — Datum des Builds
//
// Die Build-Nummer ist die Anzahl der Commits (steigt mit jedem Commit). Sie kommt
// aus BUILD_NUMBER / BUILD_COMMIT, wenn gesetzt (Docker-Build ohne .git, siehe
// app-backend/Dockerfile und local/deploy.sh), sonst aus git. Ohne beides
// (z. B. Portainer-Klon ohne .git) bleibt es beim Inhalts-Hash als Kennung.
import { execFileSync } from "node:child_process";

/** "1.0.0" -> "1.0", "1.2.3" -> "1.2.3" (ein abschließendes ".0" entfällt). */
export function versionAnzeige(paketVersion) {
  return String(paketVersion).replace(/\.0$/, "");
}

function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** Nummer und Commit des Builds. `env` und `gitAbfrage` sind austauschbar (Tests). */
export function ermittleBuild({ env = process.env, gitAbfrage = git } = {}) {
  const nummerRoh = env.BUILD_NUMBER || gitAbfrage("rev-list", "--count", "HEAD");
  const nummer = /^\d+$/.test(nummerRoh || "") ? Number(nummerRoh) : null;
  const commitRoh = env.BUILD_COMMIT || gitAbfrage("rev-parse", "--short", "HEAD");
  const commit = /^[0-9a-f]{4,40}$/i.test(commitRoh || "") ? commitRoh.toLowerCase().slice(0, 7) : null;
  return { nummer, commit };
}

/** Anzeigetext der Build-Zeile; ohne Nummer die Inhaltskennung (Hash). */
export function buildAnzeige({ nummer, commit }, hashKennung) {
  if (nummer == null) return hashKennung;
  return commit ? `${nummer} · ${commit}` : String(nummer);
}
