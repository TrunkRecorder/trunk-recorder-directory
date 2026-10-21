// The Worker, on two routes of trunkrecorder.pro:
//   /directory*        the directory's API (/directory/api/v1, api.ts, on D1 and R2)
//                      and its website (the Vite build in dist/directory/; the
//                      app's own routes, /directory/systems/…, get the app)
//   /api/v1/fcc/*      the FCC license lookup TRP asks (fcc/api.ts, on ArgusRF's D1)

import { BASE, handle, json } from "./api.ts";
import { d1 } from "./db.ts";
import { FCC_BASE, handleFcc } from "./fcc/api.ts";

export interface Env {
  DB: D1Database;
  OBSERVATIONS: R2Bucket;
  ASSETS: Fetcher;
  SHARE_LIMIT?: RateLimit;
  ADMIN_TOKEN?: string;
  /** ArgusRF's FCC ULS database (D1 `argus`), read only. */
  FCC_DB: D1Database;
  /** FCC lookups per client IP. */
  FCC_LIMIT?: RateLimit;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith(`${FCC_BASE}/`)) {
      if (req.method === "POST" && env.FCC_LIMIT) {
        const ip = req.headers.get("cf-connecting-ip") ?? "";
        if (!(await env.FCC_LIMIT.limit({ key: ip })).success) return json({ error: "too many lookups for now: try again in a minute" }, 429);
      }
      try {
        return (await handleFcc(d1(env.FCC_DB), req)) ?? json({ error: "not found" }, 404);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }
    if (url.pathname === "/directory") return Response.redirect(`${url.origin}/directory/`, 301);
    if (url.pathname.startsWith(`${BASE}/`) || url.pathname === BASE) {
      if (req.method === "POST" && url.pathname === `${BASE}/observations` && env.SHARE_LIMIT) {
        const ip = req.headers.get("cf-connecting-ip") ?? "";
        if (!(await env.SHARE_LIMIT.limit({ key: `ip:${ip}` })).success) return json({ error: "too many shares for now: try again in a minute" }, 429);
      }
      try {
        return await handle(
          {
            db: d1(env.DB),
            putObservation: async (key, body) => void (await env.OBSERVATIONS.put(key, body, { httpMetadata: { contentType: "application/json" } })),
            adminToken: env.ADMIN_TOKEN,
          },
          req,
        );
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }
    if (!url.pathname.startsWith("/directory/")) return new Response("Not found", { status: 404 });
    const res = await env.ASSETS.fetch(req);
    // A route of the app, not a file: the app. (As /directory/: assets redirect index.html to it.)
    if (res.status === 404 && !/\.[a-z0-9]+$/i.test(url.pathname)) return env.ASSETS.fetch(new Request(`${url.origin}/directory/`, req));
    return res;
  },
};
