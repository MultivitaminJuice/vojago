// Security headers for every response (SEC-9). The Content-Security-Policy comes from the
// build (public/csp.txt, written by scripts/build-site.mjs), because it contains the hashes
// of the page's inline scripts.

import { readFileSync } from "node:fs";

/**
 * Reads the policy written by the build. Returns "" when the file is missing, so the app
 * still starts; the caller logs that case as an error.
 * @param {string} path
 */
export function readCsp(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return ""; // missing build output: reported by the caller with console.error
  }
}

/**
 * @param {string} csp
 * @returns {Record<string, string>}
 */
export function securityHeaders(csp) {
  const headers = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "DENY",
    // Browsers ignore this header on plain HTTP (RFC 6797), so direct LAN access over
    // http://host:8081 is not affected; it only pins HTTPS once the app was opened via HTTPS.
    "strict-transport-security": "max-age=31536000",
  };
  if (csp) headers["content-security-policy"] = csp;
  return headers;
}
