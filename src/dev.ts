// Local development: the API on SQLite (directory.db) and the built website.
//
//   npm run dev     # http://localhost:8790/directory/  (rebuilds the site as it changes)
//
// ADMIN_TOKEN (environment) for the steward/admin endpoints; shares are kept
// in observations/ as they came.

import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { BASE, handle } from "./api.ts";
import { sqlite } from "./sqlite.ts";

const PORT = Number(process.env.PORT ?? 8790);
const ROOT = join(import.meta.dirname, "..");
const db = sqlite(process.env.DB_PATH ?? join(ROOT, "directory.db"));
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname.startsWith(BASE)) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const request = new Request(url, { method: req.method, headers: req.headers as Record<string, string>, body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : Buffer.concat(chunks) });
    try {
      const r = await handle(
        {
          db,
          adminToken: process.env.ADMIN_TOKEN,
          putObservation: async (key, body) => {
            const p = join(ROOT, "observations", key);
            mkdirSync(dirname(p), { recursive: true });
            writeFileSync(p, body);
          },
        },
        request,
      );
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      console.error(e);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  // The website: a file, else the app.
  let file = join(ROOT, "dist", url.pathname);
  if (!url.pathname.startsWith("/directory/") || !existsSync(file) || url.pathname.endsWith("/")) file = join(ROOT, "dist", "directory", "index.html");
  if (!existsSync(file)) {
    res.writeHead(404).end("Build the site first: npm run build");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(PORT, () => console.log(`directory: http://localhost:${PORT}/directory/`));
