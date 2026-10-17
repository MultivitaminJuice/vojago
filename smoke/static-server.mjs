import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { createServer } from "node:http";

const root = resolve(process.argv[2] || "public");
const port = Number(process.argv[3] || 4173);

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  // MapLibre 6 wird als ES-Modul geladen — Browser lehnen Modulskripte mit
  // falschem Dateityp (z. B. application/octet-stream) ab.
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

createServer((req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  const requested = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = resolve(join(root, requested === "/" ? "index.html" : requested));
  if (!file.startsWith(root) || !existsSync(file)) file = resolve(join(root, "index.html"));
  res.setHeader("content-type", types[extname(file)] || "application/octet-stream");
  createReadStream(file)
    .on("error", () => {
      res.writeHead(404);
      res.end("not found");
    })
    .pipe(res);
}).listen(port, "127.0.0.1");
