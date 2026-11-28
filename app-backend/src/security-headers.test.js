import assert from "node:assert/strict";
import test from "node:test";
import { readCsp, securityHeaders } from "./security-headers.js";

test("securityHeaders: basic hardening is always sent (SEC-9)", () => {
  const headers = securityHeaders("default-src 'self'");
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["x-frame-options"], "DENY");
  assert.ok(headers["referrer-policy"]);
  assert.match(headers["strict-transport-security"], /max-age=\d+/);
  assert.equal(headers["content-security-policy"], "default-src 'self'");
});

test("securityHeaders: without a policy no empty CSP header is sent", () => {
  assert.equal("content-security-policy" in securityHeaders(""), false);
});

test("readCsp: a missing file gives an empty policy instead of a crash", () => {
  assert.equal(readCsp("/nonexistent/csp.txt"), "");
});
