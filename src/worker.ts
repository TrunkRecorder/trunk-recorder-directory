// The Worker, on two routes of trunkrecorder.pro:
//   /directory*        the directory's API (/directory/api/v1, api.ts, on D1 and R2)
//                      and its website (the Vite build in dist/directory/; the
//                      app's own routes, /directory/systems/…, get the app)
//   /api/v1/fcc/*      the FCC license lookup TRP asks (fcc/api.ts, on ArgusRF's D1)

import { BASE, handle, isAdmin, json } from "./api.ts";
import { d1 } from "./db.ts";
import { FCC_BASE, handleFcc } from "./fcc/api.ts";
import { Places } from "./places.ts";
import { basemapStyle } from "./mapstyle.ts";
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

/** How long an API answer is kept at the edge: as long as the data it's from hasn't changed (see dataVersion). */
const API_TTL_S = 86_400;

/**
 * The directory's data version: its newest revision, share and placement (each
 * the last row of its table: three rows read). Every write moves one, so an
 * answer cached under the version it was made at is never stale.
 */
async function dataVersion(db: D1Database): Promise<string | null> {
  try {
    const r = await db
      .prepare("SELECT (SELECT seq FROM sqlite_sequence WHERE name = 'revisions') AS r, (SELECT MAX(rowid) FROM observations) AS o, (SELECT MAX(rowid) FROM placements) AS p")
      .first<{ r: number | null; o: number | null; p: number | null }>();
    return r ? `${r.r ?? 0}.${r.o ?? 0}.${r.p ?? 0}` : null;
  } catch {
    return null;
  }
}

/** A read of the API, from the edge cache when the data hasn't changed since it was answered. */
async function cachedRead(req: Request, env: Env, ctx: ExecutionContext | undefined, answer: () => Promise<Response>): Promise<Response> {
  const cache = typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : null;
  if (req.method !== "GET" || !cache) return answer();
  const v = await dataVersion(env.DB);
  if (!v) return answer();
  const u = new URL(req.url);
  u.searchParams.set("_v", v);
  const key = new Request(u.toString());
  const hit = await cache.match(key);
  if (hit) {
    const r = new Response(hit.body, hit);
    r.headers.set("cache-control", "public, max-age=60");
    r.headers.set("x-directory-cache", "hit");
    return r;
  }
  const res = await answer();
  // (Only what may be kept: not errors, nor moderation's no-store views.)
  if (res.status !== 200 || !/public/.test(res.headers.get("cache-control") ?? "")) return res;
  const kept = new Response(res.clone().body, { status: 200, headers: new Headers(res.headers) });
  kept.headers.set("cache-control", `public, max-age=${API_TTL_S}`);
  ctx?.waitUntil(cache.put(key, kept));
  return res;
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
        return await cachedRead(req, env, ctx, () => handle(
          {
            db: d1(env.DB),
            putObservation: async (key, body) => void (await env.OBSERVATIONS.put(key, body, { httpMetadata: { contentType: "application/json" } })),
            adminToken: env.ADMIN_TOKEN,
            fcc: d1(env.FCC_DB),
            places: placesOf(env.ASSETS),
          },
          req,
        ));
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }
    if (!url.pathname.startsWith("/directory/")) return new Response("Not found", { status: 404 });
    // The basemap's style, for other apps' maps (Trunk Recorder Pro's location picker): its tiles and fonts here.
    const st = /^\/directory\/map\/style-(light|dark)\.json$/.exec(url.pathname);
    if (st) return Response.json(basemapStyle(st[1] as "light" | "dark", url.origin), { headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=86400" } });
    const res = await env.ASSETS.fetch(req);
    // The map's fonts, for other apps' maps too.
    if (url.pathname.startsWith("/directory/fonts/") && res.ok) {
      const r = new Response(res.body, res);
      r.headers.set("access-control-allow-origin", "*");
      return r;
    }
    // A route of the app, not a file: the app. (As /directory/: assets redirect index.html to it.)
    if (res.status === 404 && !/\.[a-z0-9]+$/i.test(url.pathname)) return env.ASSETS.fetch(new Request(`${url.origin}/directory/`, req));
    return res;
  },
};
