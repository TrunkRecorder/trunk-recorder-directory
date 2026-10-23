// The map's "licensed, not shared yet" layer, as the site's files: every
// trunked system licensed in the US (src/explore.ts licensedSpots), by 1° cell,
// from an ArgusRF build. Made once per FCC refresh, so a visit reads no
// database at all.
//
//   node scripts/licensed.ts [../argusrf/build/spectrum.db]
//                       → .cache/geo/out/geo/licensed/<lat>_<lon>.json and index.json
//
// Each cell: { v: 2, spots: [[callSign, licensee, service, lat, lon, stationClass, frequencies, kind], …] }:
// kind is what it likely is by its licensed emissions (src/explore.ts licensedKind).

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { licensedCell, licensedSpots } from "../src/explore.ts";
import { first } from "../src/db.ts";
import { fccSqlite } from "../src/sqlite.ts";

const ROOT = join(import.meta.dirname, "..");
const src = process.argv[2] ?? process.env.FCC_DB_PATH ?? join(ROOT, "..", "argusrf", "build", "spectrum.db");
if (!existsSync(src)) {
  console.error(`no ArgusRF database at ${src}: node scripts/licensed.ts <its build/spectrum.db>`);
  process.exit(1);
}
const fcc = fccSqlite(src);
const spots = await licensedSpots(fcc);
const date = (await first<{ d: string }>(fcc, "SELECT MAX(COALESCE(fcc_published_at, downloaded_at)) AS d FROM source_file"))?.d ?? "";
const cells = new Map<string, unknown[][]>();
for (const s of spots) {
  const k = licensedCell(s.lat, s.lon);
  const c = cells.get(k) ?? [];
  c.push([s.callSign, s.licensee, s.serviceDesc, s.lat, s.lon, s.stationClass, s.frequencies, s.kind]);
  cells.set(k, c);
}
const out = join(ROOT, ".cache", "geo", "out", "geo", "licensed");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [k, c] of cells) writeFileSync(join(out, `${k}.json`), JSON.stringify({ v: 2, spots: c }));
const kinds: Record<string, number> = {};
for (const s of spots) kinds[s.kind || "unknown"] = (kinds[s.kind || "unknown"] ?? 0) + 1;
writeFileSync(join(out, "index.json"), JSON.stringify({ v: 2, fccData: date, kinds, cells: [...cells.keys()].sort() }));
console.log(`${spots.length} licensed spots in ${cells.size} cells (FCC data ${date}; ${JSON.stringify(kinds)}) → ${out}`);
