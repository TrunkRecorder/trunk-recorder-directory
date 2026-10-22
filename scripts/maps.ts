// The map's data: its fonts, its places, its basemap.
//
//   node scripts/maps.ts fonts                     the label fonts (Protomaps' Noto Sans glyphs) → .cache/maps/fonts
//   node scripts/maps.ts places local|staging|production
//                                                  load the places table (scripts/geo.ts's places.sql) into D1
//   node scripts/maps.ts tiles staging|production [file]
//                                                  upload the basemap (default .cache/maps/us.pmtiles) to the maps
//                                                  bucket (one bucket, both read it) through that Worker
//   node scripts/maps.ts extract                   cut the basemap: Protomaps' latest daily build, the US, to zoom 12
//                                                  → .cache/maps/us.pmtiles (needs the pmtiles CLI; ~2 GB)
//
// The site's build copies .cache/geo/out/geo and .cache/maps/fonts into
// dist/directory/ (vite.config.ts); scripts/deploy.ts makes them first.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const MAPS = join(ROOT, ".cache", "maps");
const FONTS = ["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic"];
const FONT_URL = "https://raw.githubusercontent.com/protomaps/basemaps-assets/main/fonts";
/** 64 MB: under a Worker request's 100 MB, over R2's 5 MB part minimum. */
const PART = 64 << 20;

function deployEnv(): Record<string, string> {
  const f = join(ROOT, ".deploy.env");
  const out: Record<string, string> = {};
  if (existsSync(f)) for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return { ...out, ...(process.env as Record<string, string>) };
}

/** Every glyph range of each font (256 files a font; ranges a font has no glyphs in are left out). */
export async function fonts(): Promise<void> {
  let n = 0;
  for (const font of FONTS) {
    const dir = join(MAPS, "fonts", font);
    mkdirSync(dir, { recursive: true });
    const ranges = Array.from({ length: 256 }, (_, i) => `${i * 256}-${i * 256 + 255}`);
    for (let i = 0; i < ranges.length; i += 16) {
      await Promise.all(ranges.slice(i, i + 16).map(async (r) => {
        const f = join(dir, `${r}.pbf`);
        if (existsSync(f)) return;
        const res = await fetch(`${FONT_URL}/${encodeURIComponent(font)}/${r}.pbf`);
        if (res.status === 404) return;
        if (!res.ok) throw new Error(`${font} ${r}: HTTP ${res.status}`);
        writeFileSync(f, Buffer.from(await res.arrayBuffer()));
        n++;
      }));
    }
  }
  console.log(`fonts: ${n} new glyph files in ${join(MAPS, "fonts")}`);
}

function places(target: string): number {
  const sql = join(ROOT, ".cache", "geo", "out", "places.sql");
  if (!existsSync(sql)) {
    console.error("no places.sql: run node scripts/geo.ts first");
    return 1;
  }
  const db = target === "production" ? "directory" : "directory-staging";
  const args = ["wrangler", "d1", "execute", db, target === "local" ? "--local" : "--remote", "--file", sql, "-y", ...(target === "production" ? [] : ["--env", "staging"])];
  return spawnSync("npx", args, { cwd: ROOT, stdio: "inherit" }).status ?? 1;
}

async function tiles(target: string, file: string): Promise<number> {
  const env = deployEnv();
  const base = env[`${target.toUpperCase()}_URL`];
  const token = env[`${target.toUpperCase()}_ADMIN_TOKEN`];
  if (!base || !token) {
    console.error(`no ${target.toUpperCase()}_URL / _ADMIN_TOKEN in .deploy.env`);
    return 1;
  }
  const size = statSync(file).size;
  const api = `${base}/directory/api/v1/admin/maps/uploads`;
  const key = "tiles/us.pmtiles";
  const auth = { authorization: `Bearer ${token}` };
  const start = await fetch(`${api}?key=${key}`, { method: "POST", headers: auth });
  if (!start.ok) throw new Error(`start: HTTP ${start.status} ${await start.text()}`);
  const { uploadId } = (await start.json()) as { uploadId: string };
  const parts: { partNumber: number; etag: string }[] = [];
  const fd = openSync(file, "r");
  try {
    for (let n = 1, at = 0; at < size; n++, at += PART) {
      const buf = Buffer.alloc(Math.min(PART, size - at));
      readSync(fd, buf, 0, buf.length, at);
      for (let attempt = 1; ; attempt++) {
        const r = await fetch(`${api}/${encodeURIComponent(uploadId)}/${n}?key=${key}`, { method: "PUT", headers: auth, body: buf });
        if (r.ok) {
          parts.push((await r.json()) as { partNumber: number; etag: string });
          break;
        }
        if (attempt === 3) throw new Error(`part ${n}: HTTP ${r.status} ${await r.text()}`);
      }
      console.log(`part ${n}: ${Math.round(((at + buf.length) / size) * 100)}%`);
    }
  } catch (e) {
    await fetch(`${api}/${encodeURIComponent(uploadId)}?key=${key}`, { method: "DELETE", headers: auth });
    throw e;
  } finally {
    closeSync(fd);
  }
  const done = await fetch(`${api}/${encodeURIComponent(uploadId)}/complete?key=${key}`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ parts }) });
  if (!done.ok) throw new Error(`complete: HTTP ${done.status} ${await done.text()}`);
  console.log(`uploaded ${key}: ${await done.text()}`);
  return 0;
}

/** The US (with Alaska, Hawaii, Puerto Rico and the Virgin Islands) from Protomaps' latest build, to zoom 12. */
async function extract(): Promise<number> {
  mkdirSync(MAPS, { recursive: true });
  const builds = (await (await fetch("https://build-metadata.protomaps.dev/builds.json")).json()) as { key: string }[];
  const latest = builds.at(-1)!.key;
  const region = join(MAPS, "us.geojson");
  const box = (w: number, s: number, e: number, n: number) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
  writeFileSync(region, JSON.stringify({ type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: [box(-125, 24.3, -66.8, 49.5), box(-170, 51, -129.9, 71.5), box(-160.6, 18.8, -154.7, 22.3), box(-67.4, 17.6, -64.5, 18.6)] } }));
  console.log(`extracting ${latest}`);
  return spawnSync("pmtiles", ["extract", `https://build.protomaps.com/${latest}`, join(MAPS, "us.pmtiles"), `--region=${region}`, "--maxzoom=12"], { stdio: "inherit" }).status ?? 1;
}

const [cmd, a, b] = process.argv.slice(2);
if (import.meta.main) {
  const code =
    cmd === "fonts" ? (await fonts(), 0)
    : cmd === "places" && a && ["local", "staging", "production"].includes(a) ? places(a)
    : cmd === "tiles" && (a === "staging" || a === "production") ? await tiles(a, b ?? join(MAPS, "us.pmtiles"))
    : cmd === "extract" ? await extract()
    : (console.error("node scripts/maps.ts fonts | places local|staging|production | tiles staging|production [file] | extract"), 2);
  process.exit(code);
}
