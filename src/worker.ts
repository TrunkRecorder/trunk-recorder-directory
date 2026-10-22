// The Worker, on two routes of trunkrecorder.pro:
//   /directory*        the directory's API (/directory/api/v1, api.ts, on D1 and R2)
//                      and its website (the Vite build in dist/directory/; the
//                      app's own routes, /directory/systems/…, get the app)
//   /api/v1/fcc/*      the FCC license lookup TRP asks (fcc/api.ts, on ArgusRF's D1)

import { BASE, handle, isAdmin, json } from "./api.ts";
import { d1 } from "./db.ts";
import { FCC_BASE, handleFcc } from "./fcc/api.ts";
import { Places } from "./places.ts";
import { tile, upload } from "./tiles.ts";

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
  /** The map's basemap (tiles/us.pmtiles; scripts/maps.ts uploads it). */
  MAPS?: R2Bucket;
}

/** The Census boundaries, from this Worker's own files (scripts/geo.ts), kept while it runs. */
let places: { assets: Fetcher; p: Places } | null = null;
const placesOf = (assets: Fetcher) => {
  if (!places || places.assets !== assets) {
    places = { assets, p: new Places(async (st) => {
      const r = await assets.fetch(`https://assets.local/directory/geo/states/${encodeURIComponent(st)}.json`);
      return r.ok ? r.text() : null;
    }) };
  }
  return places.p;
};

export default {
  async fetch(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const t = await tile(req, env.MAPS, ctx);
    if (t) return t;
    if (url.pathname.startsWith(`${BASE}/admin/maps/`)) {
      if (!isAdmin({ adminToken: env.ADMIN_TOKEN }, req)) return json({ error: "needs an admin's token" }, 401);
      if (!env.MAPS) return json({ error: "no maps bucket here" }, 400);
      return (await upload(req, url.pathname.slice(BASE.length), env.MAPS)) ?? json({ error: "not found" }, 404);
    }
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
            fcc: d1(env.FCC_DB),
            places: placesOf(env.ASSETS),
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
