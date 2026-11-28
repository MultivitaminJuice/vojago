import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildCsp, inlineScriptHashes } from "../../scripts/csp.mjs";

const sha = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

test("inlineScriptHashes: hashes inline scripts, skips scripts with src", () => {
  const html =
    '<script type="module">\nimport x from "/a.js";\n</script>' +
    '<script type="module" src="/app.js?v=1"></script>' +
    "<script>console.log(1)</script>";
  assert.deepEqual(inlineScriptHashes(html), [
    sha('\nimport x from "/a.js";\n'),
    sha("console.log(1)"),
  ]);
});

test("buildCsp: no inline scripts without a hash, no framing, map tiles allowed", () => {
  const csp = buildCsp("<script>run()</script>");
  assert.match(csp, /script-src 'self' 'sha256-[^']+'(;|$)/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /img-src[^;]*https:\/\/a\.basemaps\.cartocdn\.com/);
});
