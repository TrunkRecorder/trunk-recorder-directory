// The Worker: the API under /directory/api/v1 (api.ts, on D1 and R2), and the
// website (the Vite build in dist/directory/) for everything else under
// /directory. The app's own routes (/directory/systems/…) get its index.html.

import { BASE, handle, json } from "./api.ts";
import { d1 } from "./db.ts";

export interface Env {
  DB: D1Database;
  OBSERVATIONS: R2Bucket;
  ASSETS: Fetcher;
  SHARE_LIMIT?: RateLimit;
  ADMIN_TOKEN?: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
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
    // A route of the app, not a file: the app.
    if (res.status === 404 && !/\.[a-z0-9]+$/i.test(url.pathname)) return env.ASSETS.fetch(new Request(`${url.origin}/directory/index.html`, req));
    return res;
  },
};
