// Einfache, abhängigkeitsfreie Übersicht der zuletzt empfangenen Positionen
// — kein Kartenframework, keine externen Kacheln, nur eine Tabelle mit
// Links zu Google Maps je Punkt. Bewusst schlank, für die Auswertung
// während der Evaluierung (Phase 1) gedacht, kein Ersatz für die
// eigentliche VOJAĜO-Kartenansicht.
import { listRecentPositions } from "./store.js";

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const formatZeit = (ms) => (ms ? new Date(ms).toLocaleString("de-DE") : "—");

function zeile(p) {
  const kartenLink = `https://www.google.com/maps?q=${p.lat},${p.lon}`;
  return `<tr>
    <td>${formatZeit(p.at)}</td>
    <td>${escapeHtml(p.device_id)}</td>
    <td><a href="${kartenLink}" target="_blank" rel="noopener">${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</a></td>
    <td>${p.speed_kmh != null ? p.speed_kmh.toFixed(1) + " km/h" : "—"}</td>
    <td>${p.altitude != null ? p.altitude.toFixed(0) + " m" : "—"}</td>
    <td>${escapeHtml(p.protocol)}</td>
    <td>${formatZeit(p.created_at)}</td>
  </tr>`;
}

export function renderPositionsPage() {
  const positionen = listRecentPositions(200);
  const zeilen = positionen.map(zeile).join("\n");
  const html = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>VOJAĜO Tracker-Backend — Positionen</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #0c1a1c; color: #e8e8e8; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { color: #9ab; margin: 0 0 16px; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #234; white-space: nowrap; }
  th { color: #9ab; font-weight: 600; }
  a { color: #e8802b; }
  tr:hover { background: #142428; }
</style>
</head>
<body>
<h1>VOJAĜO Tracker-Backend — Positionen</h1>
<p class="sub">${positionen.length} von zuletzt empfangenen Positionen (neueste zuerst) — lädt alle 30s neu. Schattenbetrieb, keine Verbindung zu Cloudflare/D1.</p>
<table>
<thead><tr><th>Fix-Zeit</th><th>Gerät</th><th>Position</th><th>Geschw.</th><th>Höhe</th><th>Protokoll</th><th>Empfangen</th></tr></thead>
<tbody>
${zeilen || '<tr><td colspan="7">Noch keine Positionen empfangen.</td></tr>'}
</tbody>
</table>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
