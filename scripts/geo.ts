// Build the directory's geography from the Census Bureau's cartographic
// boundary files (public domain): which state, county and city (Census place)
// a site is in, and what the map shades.
//
//   node scripts/geo.ts            → .cache/geo/out/
//
// Out:
//   geo/states/<ST>.json   each state's counties and places (GeoJSON, simplified
//                          a little), for placing a site (src/places.ts)
//   geo/counties.json      every county, simplified a lot, for the map's shading
//   places.sql             the `places` table: every state, county and place, its
//                          name and a point inside it (the drill-down's names)
//
// scripts/maps.ts uploads them (R2, D1).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lit } from "../src/db.ts";

const ROOT = join(import.meta.dirname, "..");
const WORK = join(ROOT, ".cache", "geo");
const OUT = join(WORK, "out");
const YEAR = 2024;
const FILES = { county: `cb_${YEAR}_us_county_500k`, place: `cb_${YEAR}_us_place_500k`, county20m: `cb_${YEAR}_us_county_20m` };

const mapshaper = (...args: string[]) => execFileSync(join(ROOT, "node_modules", ".bin", "mapshaper"), ["-quiet", ...args], { stdio: ["ignore", "inherit", "inherit"] });

async function download(name: string): Promise<string> {
  const f = join(WORK, `${name}.zip`);
  if (existsSync(f)) return f;
  const url = `https://www2.census.gov/geo/tiger/GENZ${YEAR}/shp/${name}.zip`;
  console.log(`downloading ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  return f;
}

interface Feature {
  type: "Feature";
  properties: Record<string, string | number>;
  geometry: unknown;
}
const read = (f: string): Feature[] => JSON.parse(readFileSync(f, "utf8")).features;

mkdirSync(WORK, { recursive: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "geo", "states"), { recursive: true });
const tmp = join(WORK, "tmp");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp);

const county = await download(FILES.county);
const place = await download(FILES.place);
const county20m = await download(FILES.county20m);

// Each state's counties and places, a little simplified (a site near a line can
// land either side of it: fine for listing it).
for (const [kind, zip] of [["county", county], ["place", place]] as const) {
  mkdirSync(join(tmp, kind));
  mapshaper("-i", zip, "-filter-fields", "GEOID,NAME,NAMELSAD,STUSPS", "-simplify", "25%", "keep-shapes", "-split", "STUSPS", "-o", join(tmp, kind) + "/", "format=geojson", "precision=0.00001");
  // A point inside each, for the drill-down's names.
  mapshaper("-i", zip, "-filter-fields", "GEOID,NAME,NAMELSAD,STUSPS,STATE_NAME", "-points", "inner", "-each", "lon=this.x, lat=this.y", "-o", join(tmp, `${kind}-points.json`), "format=json");
}
const states = new Map<string, string>();
const rows: unknown[][] = [];
for (const kind of ["county", "place"] as const) {
  for (const p of JSON.parse(readFileSync(join(tmp, `${kind}-points.json`), "utf8")) as Record<string, string | number>[]) {
    states.set(String(p.STUSPS), String(p.STATE_NAME));
    rows.push([String(p.GEOID), kind, String(p.STUSPS), String(p.NAME), String(p.NAMELSAD), Math.round(Number(p.lat) * 1e5) / 1e5, Math.round(Number(p.lon) * 1e5) / 1e5]);
  }
}
let n = 0;
for (const st of states.keys()) {
  const features: Feature[] = [];
  for (const kind of ["county", "place"] as const) {
    const dir = join(tmp, kind);
    const f = readdirSync(dir).find((x) => x.replace(/\.json$/, "").endsWith(st));
    if (!f) continue;
    for (const x of read(join(dir, f))) features.push({ type: "Feature", properties: { kind, geoid: String(x.properties.GEOID), name: String(x.properties.NAME), state: st }, geometry: x.geometry });
  }
  writeFileSync(join(OUT, "geo", "states", `${st}.json`), JSON.stringify({ type: "FeatureCollection", features }));
  n += features.length;
}
for (const [st, name] of states) rows.push([st, "state", st, name, name, null, null]);

// Every county for the map: the 20m file, simplified more (it's shaded, not read).
mapshaper("-i", county20m, "-filter-fields", "GEOID,NAME,STUSPS", "-rename-fields", "geoid=GEOID,name=NAME,state=STUSPS", "-simplify", "40%", "keep-shapes", "-o", join(OUT, "geo", "counties.json"), "format=geojson", "precision=0.0001");

// The places table.
const sql = ["DELETE FROM places;"];
for (let i = 0; i < rows.length; i += 400) {
  sql.push(`INSERT INTO places (geoid, kind, state, name, full_name, lat, lon) VALUES\n${rows.slice(i, i + 400).map((r) => `(${r.map(lit).join(", ")})`).join(",\n")};`);
}
writeFileSync(join(OUT, "places.sql"), sql.join("\n") + "\n");
rmSync(tmp, { recursive: true, force: true });
console.log(`${states.size} states, ${n} counties and places → ${OUT}`);
