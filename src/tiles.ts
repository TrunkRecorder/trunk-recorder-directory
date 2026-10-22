// The map's basemap: vector tiles (Protomaps' OpenStreetMap build, cut to the
// US to zoom 12; scripts/maps.ts) in one PMTiles file in R2, served as
// /directory/tiles/{z}/{x}/{y}.mvt and kept at the edge. MapLibre draws them,
// so the light and dark styles are the same tiles. Above zoom 12 it enlarges
// zoom 12's.
//
// Also: uploading that file (2 GB) in parts, for an admin (scripts/maps.ts),
// as R2 multipart uploads through the Worker (no S3 keys needed).

import { PMTiles, type RangeResponse, type Source } from "pmtiles";

export const TILES_KEY = "tiles/us.pmtiles";
export const TILES_BASE = "/directory/tiles";
/** The edge cache's key version: changed when what's served for a tile changes. */
const CACHE_VERSION = "2";

class R2Source implements Source {
  private bucket: R2Bucket;
  private key: string;
  constructor(bucket: R2Bucket, key: string) {
    this.bucket = bucket;
    this.key = key;
  }
  getKey() {
    return this.key;
  }
  async getBytes(offset: number, length: number, _signal?: AbortSignal, etag?: string): Promise<RangeResponse> {
    const o = await this.bucket.get(this.key, { range: { offset, length }, ...(etag ? { onlyIf: { etagMatches: etag } } : {}) });
    if (!o) throw new Error("no basemap");
    if (!("body" in o)) throw new Error("the basemap changed");
    return { data: await o.arrayBuffer(), etag: o.etag };
  }
}

let archive: { bucket: R2Bucket; p: PMTiles } | null = null;
const tilesOf = (bucket: R2Bucket) => {
  if (!archive || archive.bucket !== bucket) archive = { bucket, p: new PMTiles(new R2Source(bucket, TILES_KEY)) };
  return archive.p;
};

/** A tile, or the TileJSON (/directory/tiles/us.json). Null: not a tiles path. */
export async function tile(req: Request, bucket: R2Bucket | undefined, ctx?: ExecutionContext): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith(`${TILES_BASE}/`)) return null;
  if (!bucket) return new Response("no basemap here", { status: 404 });
  const cache = typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : null;
  const key = new Request(`${url.origin}${url.pathname}?cache=${CACHE_VERSION}`);
  const hit = await cache?.match(key);
  if (hit) return hit;
  const p = tilesOf(bucket);
  let res: Response;
  try {
    if (url.pathname === `${TILES_BASE}/us.json`) {
      const h = await p.getHeader();
      res = Response.json({
        tilejson: "3.0.0", tiles: [`${url.origin}${TILES_BASE}/{z}/{x}/{y}.mvt`], minzoom: h.minZoom, maxzoom: h.maxZoom,
        bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat], attribution: "© OpenStreetMap contributors, Protomaps",
      }, { headers: { "cache-control": "public, max-age=3600" } });
    } else {
      const m = /^\/directory\/tiles\/(\d+)\/(\d+)\/(\d+)\.mvt$/.exec(url.pathname);
      if (!m) return new Response("not found", { status: 404 });
      const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const h = await p.getHeader();
      if (z < h.minZoom || z > h.maxZoom) return new Response(null, { status: 404 });
      const t = await p.getZxy(z, x, y);
      // (An empty tile: nothing there, the sea.)
      if (!t) res = new Response(null, { status: 204, headers: { "cache-control": "public, max-age=86400", "access-control-allow-origin": "*" } });
      else {
        // (The library hands it over unzipped; Cloudflare compresses it for each client.)
        res = new Response(t.data, { headers: { "content-type": "application/vnd.mapbox-vector-tile", "cache-control": "public, max-age=86400", "access-control-allow-origin": "*" } });
      }
    }
  } catch (e) {
    return new Response(e instanceof Error ? e.message : String(e), { status: 404 });
  }
  if (cache && res.status < 300) ctx?.waitUntil(cache.put(key, res.clone()));
  return res;
}

/**
 * An admin's upload into the maps bucket, in parts:
 *   POST   …/admin/maps/uploads?key=K                 → { uploadId }
 *   PUT    …/admin/maps/uploads/{id}/{part}?key=K     (the part's bytes) → { partNumber, etag }
 *   POST   …/admin/maps/uploads/{id}/complete?key=K   { parts: [{ partNumber, etag }] } → { key, size }
 *   DELETE …/admin/maps/uploads/{id}?key=K            (gives it up)
 */
export async function upload(req: Request, path: string, bucket: R2Bucket): Promise<Response | null> {
  const url = new URL(req.url);
  const key = url.searchParams.get("key") ?? "";
  if (!/^(tiles|geo|fonts)\/[A-Za-z0-9 ._/-]+$/.test(key)) return Response.json({ error: "key must be under tiles/, geo/ or fonts/" }, { status: 400 });
  if (path === "/admin/maps/uploads" && req.method === "POST") {
    const u = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: "application/octet-stream" } });
    return Response.json({ uploadId: u.uploadId, key });
  }
  let m = /^\/admin\/maps\/uploads\/([^/]+)\/(\d+)$/.exec(path);
  if (m && req.method === "PUT") {
    if (!req.body) return Response.json({ error: "no body" }, { status: 400 });
    const p = await bucket.resumeMultipartUpload(key, decodeURIComponent(m[1])).uploadPart(Number(m[2]), req.body);
    return Response.json({ partNumber: p.partNumber, etag: p.etag });
  }
  m = /^\/admin\/maps\/uploads\/([^/]+)\/complete$/.exec(path);
  if (m && req.method === "POST") {
    const b = (await req.json()) as { parts?: R2UploadedPart[] };
    const o = await bucket.resumeMultipartUpload(key, decodeURIComponent(m[1])).complete(b.parts ?? []);
    archive = null;
    return Response.json({ key: o.key, size: o.size, etag: o.etag });
  }
  m = /^\/admin\/maps\/uploads\/([^/]+)$/.exec(path);
  if (m && req.method === "DELETE") {
    await bucket.resumeMultipartUpload(key, decodeURIComponent(m[1])).abort();
    return Response.json({ ok: true });
  }
  return null;
}
