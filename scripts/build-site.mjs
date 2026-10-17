// Baut die installierbare VOJAĜO-Web-App nach public/:
//   index.html            – App-Shell (aus prototype/index.html)
//   manifest.webmanifest  – PWA-Manifest
//   sw.js                 – Service Worker (Offline-Fähigkeit)
//   icon-192.png/512.png  – App-Icons
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { build as esbuild } from "esbuild";
import { deflateSync } from "node:zlib";

const out = new URL("../public/", import.meta.url);
mkdirSync(out, { recursive: true });

const APP_NAME = "VOJAĜO";
const APP_DESC = "Explore & Track — dein Camper-Begleiter";
const THEME = "#e8802b";
const BG = "#0c1a1c";
const VERSION = "0.1.0";

/* ---------- Icon: schlichtes PNG (Akzentfläche mit Vogel-Schwinge) ---------- */
function png(size) {
  const [br, bg, bb] = [0x0c, 0x1a, 0x1c];
  const [ar, ag, ab] = [0xe8, 0x80, 0x2b];
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let p = 0;
  const cx = size / 2, cy = size / 2, r = size * 0.42;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // Filter: none
    for (let x = 0; x < size; x++) {
      const inCircle = (x - cx) ** 2 + (y - cy) ** 2 < r * r;
      // stilisierte Schwinge: zwei Bögen
      const t = (x - cx) / r;
      const wing = cy + Math.sin(t * 2.2) * r * 0.22 - r * 0.05;
      const onWing = inCircle && Math.abs(y - wing) < size * 0.055 && Math.abs(t) < 0.82;
      const on2 = inCircle && Math.abs(y - (wing + r * 0.30)) < size * 0.045 && t > -0.85 && t < 0.15;
      const isInk = onWing || on2;
      raw[p++] = inCircle ? (isInk ? br : ar) : br;
      raw[p++] = inCircle ? (isInk ? bg : ag) : bg;
      raw[p++] = inCircle ? (isInk ? bb : ab) : bb;
    }
  }
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })();
  const crc = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, cc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
writeFileSync(new URL("icon-192.png", out), png(192));
writeFileSync(new URL("icon-512.png", out), png(512));

/* ---------- Manifest ---------- */
writeFileSync(new URL("manifest.webmanifest", out), JSON.stringify({
  name: APP_NAME + " — Explore & Track",
  short_name: APP_NAME,
  description: APP_DESC,
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  background_color: BG,
  theme_color: THEME,
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
}, null, 2));

/* ---------- Kartenbibliothek mitliefern ----------
   MapLibre wird als eigenständige Datei ausgeliefert statt mitgebündelt:
   die Distribution bringt ihren Web-Worker selbst mit, was beim Bündeln
   verloren ginge. So bleibt alles von der eigenen Domain ladbar. */
const mlDist = new URL("../node_modules/maplibre-gl/dist/", import.meta.url);
// MapLibre 6 liefert nur noch ES-Module: die Bibliothek und ihre Worker-Datei
// müssen nebeneinander liegen (die Bibliothek findet den Worker relativ zu sich).
copyFileSync(new URL("maplibre-gl.mjs", mlDist), new URL("maplibre-gl.mjs", out));
copyFileSync(new URL("maplibre-gl-worker.mjs", mlDist), new URL("maplibre-gl-worker.mjs", out));
copyFileSync(new URL("maplibre-gl.css", mlDist), new URL("maplibre-gl.css", out));

/* ---------- App bündeln (JS + CSS) ---------- */
await esbuild({
  entryPoints: [new URL("../src/main.js", import.meta.url).pathname],
  bundle: true,
  minify: true,
  format: "esm",
  target: ["es2020"],
  loader: { ".png": "dataurl", ".svg": "dataurl" },
  // Kartenschlüssel (CARTO) kommt aus der Umgebung, nicht aus dem Quelltext.
  define: { __CARTO_API_KEY__: JSON.stringify(process.env.CARTO_API_KEY || "") },
  outfile: new URL("app.js", out).pathname,
});

/* ---------- Versionskennung aus dem Inhalt ----------
   Damit lädt der Browser nach jedem Deploy wirklich die neue Fassung und
   nicht die alte aus seinem Zwischenspeicher. */
const kurzHash = (datei) =>
  createHash("sha256").update(readFileSync(new URL(datei, out))).digest("hex").slice(0, 10);
const BUILD = kurzHash("app.js") + kurzHash("app.css");

/* ---------- index.html ---------- */
const shell = readFileSync(new URL("../src/shell.html", import.meta.url), "utf8")
  .replaceAll("__APP_VERSION__", VERSION)
  .replaceAll("__BUILD_VERSION__", BUILD);
const html = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>${APP_NAME} — Explore & Track</title>
<meta name="description" content="${APP_DESC}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="${THEME}">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon-192.png" type="image/png">
<link rel="apple-touch-icon" href="/icon-192.png">
<link rel="stylesheet" href="/maplibre-gl.css">
<link rel="stylesheet" href="/app.css?v=${BUILD}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${APP_NAME}">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<style>html,body{margin:0;padding:0;overscroll-behavior-y:none}</style>
</head>
<body>
${shell}
<script type="module">
import * as maplibregl from "/maplibre-gl.mjs";
window.maplibregl = maplibregl;
</script>
<script type="module" src="/app.js?v=${BUILD}"></script>
<script>
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      // War die App zwischendurch offline (z. B. während der Fahrt), kann eine
      // neue Fassung erst nach Rückkehr der Verbindung ankommen — deshalb aktiv
      // danach fragen, statt auf den nächsten normalen Seitenaufruf zu warten.
      window.addEventListener("online", () => reg.update().catch(() => {}));
      setInterval(() => reg.update().catch(() => {}), 15 * 60 * 1000);
    }).catch(() => {});
  });
}
</script>
</body>
</html>
`;
writeFileSync(new URL("index.html", out), html);

/* ---------- Service Worker ---------- */
writeFileSync(new URL("sw.js", out), `// VOJAĜO Service Worker
const CACHE = "vojago-${BUILD}";
const ASSETS = ["/", "/index.html", "/app.js?v=${BUILD}", "/app.css?v=${BUILD}", "/maplibre-gl.mjs", "/maplibre-gl-worker.mjs", "/maplibre-gl.css", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) =>
    Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // API-Antworten gehören nie in den Zwischenspeicher — sonst bekommt die App
  // einen veralteten Anmeldezustand oder alte Daten serviert.
  if (url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return r; })
      .catch(() => caches.match(e.request).then((m) => m || caches.match("/index.html")))
  );
});

// Wache: Push-Benachrichtigung beim Verlassen/Betreten des überwachten
// Bereichs (siehe tracker-backend/src/push.js, das sie verschickt). Ohne
// Payload-Text ("data") kommt es trotzdem an — dann ein ehrlicher
// Sammel-Hinweis statt eines leeren Titels.
self.addEventListener("push", (e) => {
  let payload = { title: "VOJAĜO", body: "Es gibt ein neues Ereignis." };
  try { if (e.data) payload = e.data.json(); } catch { /* kein/kein gültiges JSON — Vorgabe bleibt */ }
  e.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: "vojago-wache",
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) if ("focus" in c) return c.focus();
      if (self.clients.openWindow) return self.clients.openWindow("/");
    })
  );
});
`);


console.log(`public/ gebaut — index.html (${html.length} Z.), app.js, app.css, manifest, sw.js, icons`);
