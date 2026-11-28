// Which address counts as the caller for rate limiting (SEC-8).
//
// The app is reachable both through a proxy (Cloudflare Tunnel) and directly on its port.
// A client can send any `cf-connecting-ip` header it likes, so the header only counts when
// the connection itself comes from a proxy listed in TRUSTED_PROXY_IPS. Otherwise the
// address of the connection is the caller. An empty list trusts no proxy (SEC-14).

/**
 * @param {string | undefined} value comma- or space-separated addresses
 * @returns {Set<string>}
 */
export function parseTrustedProxies(value = "") {
  return new Set(
    String(value)
      .split(/[\s,]+/)
      .map((ip) => normalizeIp(ip))
      .filter(Boolean),
  );
}

/** "::ffff:172.18.0.5" (IPv4 mapped into IPv6) → "172.18.0.5". */
export function normalizeIp(ip) {
  const value = String(ip || "").trim();
  return value.startsWith("::ffff:") && value.includes(".") ? value.slice(7) : value;
}

/**
 * @param {{ peer?: string, forwarded?: string | string[] }} connection
 * @param {Set<string>} trustedProxies
 * @returns {string} the caller's address, or "" when it is not known
 */
export function clientAddress({ peer, forwarded }, trustedProxies) {
  const peerIp = normalizeIp(peer);
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (peerIp && trustedProxies.has(peerIp) && header && header.trim()) {
    return normalizeIp(header);
  }
  return peerIp;
}
