import assert from "node:assert/strict";
import test from "node:test";
import { clientAddress, normalizeIp, parseTrustedProxies } from "./client-ip.js";

test("normalizeIp strips the IPv4-mapped IPv6 prefix", () => {
  assert.equal(normalizeIp("::ffff:172.18.0.5"), "172.18.0.5");
  assert.equal(normalizeIp("2001:db8::1"), "2001:db8::1");
  assert.equal(normalizeIp(undefined), "");
});

test("parseTrustedProxies: empty trusts nobody", () => {
  assert.equal(parseTrustedProxies("").size, 0);
  assert.deepEqual(
    [...parseTrustedProxies("172.18.0.5, ::ffff:10.0.0.2")],
    ["172.18.0.5", "10.0.0.2"],
  );
});

test("clientAddress: the proxy header only counts from a trusted proxy (SEC-8)", () => {
  const trusted = parseTrustedProxies("172.18.0.5");

  // Through the trusted proxy: the forwarded address is the caller.
  assert.equal(
    clientAddress({ peer: "::ffff:172.18.0.5", forwarded: "198.51.100.7" }, trusted),
    "198.51.100.7",
  );
  // Directly on the port: a forged header is ignored.
  assert.equal(
    clientAddress({ peer: "192.168.1.20", forwarded: "198.51.100.7" }, trusted),
    "192.168.1.20",
  );
  // No trusted proxies configured: the header never counts.
  assert.equal(
    clientAddress({ peer: "172.18.0.5", forwarded: "198.51.100.7" }, new Set()),
    "172.18.0.5",
  );
  // Trusted proxy without the header: the proxy itself is the caller.
  assert.equal(clientAddress({ peer: "172.18.0.5" }, trusted), "172.18.0.5");
});
