// Reine Prüf-Logik gegen versehentlich veröffentlichte private Daten.
// Zwei Regelquellen:
//   1. eingebaute, allgemeine Muster (Schlüssel, Tokens) — gelten für alle
//   2. local/denylist.txt — NUR lokal, nicht im Repository: die eigenen
//      sensiblen Begriffe (Wohnort, Ortsnamen, Geräte-IDs, Domain, E-Mail …)
//      als reguläre Ausdrücke, einer je Zeile.

export const ALLGEMEINE_REGELN = [
  { name: "privater Schlüssel", muster: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "GitHub-Token", muster: /\b(?:ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_]{20,}/ },
  { name: "AWS-Schlüssel", muster: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "VAPID-/Geheimwert", muster: /\b(?:VAPID_PRIVATE_KEY|TUNNEL_TOKEN|RESEND_API_KEY|CARTO_API_KEY)\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,}/ },
];

/** Zeilen der Sperrliste in Regeln umwandeln ("#" = Kommentar, leer = ignoriert). */
export function regelnAusSperrliste(text) {
  const regeln = [];
  text.split("\n").forEach((zeile, i) => {
    const t = zeile.trim();
    if (!t || t.startsWith("#")) return;
    try {
      regeln.push({ name: `Sperrliste Zeile ${i + 1}`, muster: new RegExp(t, "i") });
    } catch {
      throw new Error(`Sperrliste Zeile ${i + 1}: ungültiger regulärer Ausdruck: ${t}`);
    }
  });
  return regeln;
}

/** Treffer in einem Text: [{ zeile, regel }]. */
export function findeTreffer(text, regeln) {
  const treffer = [];
  text.split("\n").forEach((zeile, i) => {
    for (const regel of regeln) if (regel.muster.test(zeile)) treffer.push({ zeile: i + 1, regel: regel.name, inhalt: zeile.trim().slice(0, 120) });
  });
  return treffer;
}

/** Hinzugefügte Zeilen aus einem unified diff (git diff -U0 / git log -p) mit Dateinamen. */
export function hinzugefuegteZeilen(diff) {
  const ergebnis = [];
  let datei = null;
  let zeile = 0;
  for (const roh of diff.split("\n")) {
    if (roh.startsWith("+++ ")) { datei = roh.slice(4).replace(/^b\//, ""); continue; }
    const kopf = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(roh);
    if (kopf) { zeile = Number(kopf[1]); continue; }
    if (roh.startsWith("+") && !roh.startsWith("+++")) { ergebnis.push({ datei, zeile, text: roh.slice(1) }); zeile++; }
    else if (roh.startsWith(" ")) zeile++; // Kontextzeile (bei -U0 nicht vorhanden)
  }
  return ergebnis;
}
