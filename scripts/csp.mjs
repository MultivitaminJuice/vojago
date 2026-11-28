// Content-Security-Policy for the built PWA (SEC-9). The build writes it to public/csp.txt;
// app-backend sends it with every response (app-backend/src/security-headers.js).

import { createHash } from "node:crypto";

/** Hosts the map loads tiles from (src/map-style.js). */
const MAP_TILE_HOSTS = [
  "https://a.basemaps.cartocdn.com",
  "https://elevation-tiles-prod.s3.amazonaws.com",
];

/** sha256 sources for every inline <script> (without src) in the page. */
export function inlineScriptHashes(html) {
  const hashes = [];
  for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    const digest = createHash("sha256").update(match[1], "utf8").digest("base64");
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

/** The policy for the page `html`. */
export function buildCsp(html) {
  return [
    "default-src 'self'",
    `script-src 'self' ${inlineScriptHashes(html).join(" ")}`.trim(),
    // Exception SEC-9 / UI-4: inline styles remain until Phase 3 moves them into the
    // stylesheet; then 'unsafe-inline' is removed here.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${MAP_TILE_HOSTS.join(" ")}`,
    `connect-src 'self' ${MAP_TILE_HOSTS.join(" ")}`,
    "worker-src 'self' blob:",
    "font-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
