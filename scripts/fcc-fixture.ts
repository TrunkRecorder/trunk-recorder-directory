// Rebuild test/fixtures/fcc.sql: ArgusRF's schema (src/fcc/schema.sql) with
// real rows from an ArgusRF build (its build/spectrum.db), so the tests and
// offline runs read the same licenses staging and production do.
//
//   node scripts/fcc-fixture.ts ../argusrf/build/spectrum.db
//
// Rows: every transmitter of the licenses the tests name (DC Fire and EMS,
// Arlington County, WMATA), and the trunked base stations in central
// Washington (the "licensed, not shared yet" layer's); and the State Licenses
// (no sites listed) of DC, Maryland, Virginia and Missouri (MOSWIN's, WPTZ785).

import Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lit } from "../src/db.ts";

const ROOT = join(import.meta.dirname, "..");
const src = process.argv[2];
if (!src) {
  console.error("usage: node scripts/fcc-fixture.ts <ArgusRF's build/spectrum.db>");
  process.exit(2);
}
const CALL_SIGNS = ["WPXT459", "KNJA391", "KNJE616", "KNJU834", "KNIQ704", "WPVX365", "WPVX388", "WSKT665"];
/** Central Washington: the trunked base stations there. */
const BOX = { lat: [38.8, 39.0], lon: [-77.15, -76.9] };

const db = new Database(src, { readonly: true });
const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

function inserts(table: string, rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const c = cols(table);
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += 200) {
    const vals = rows.slice(i, i + 200).map((r) => `(${c.map((k) => lit(r[k])).join(", ")})`);
    out.push(`INSERT INTO ${table} (${c.join(", ")}) VALUES\n${vals.join(",\n")};`);
  }
  return out.join("\n");
}

const tx = db
  .prepare(
    `SELECT t.* FROM transmitter t LEFT JOIN radio_service rs ON rs.code = t.radio_service_code
      WHERE t.call_sign IN (${CALL_SIGNS.map(() => "?").join(", ")})
         OR ((rs.description LIKE '%Trunked%' OR t.class_station_code LIKE 'FB8%') AND t.class_station_code LIKE 'FB%'
             AND t.lat BETWEEN ? AND ? AND t.lon BETWEEN ? AND ?)
      ORDER BY t.id`,
  )
  .all(...CALL_SIGNS, ...BOX.lat, ...BOX.lon) as Record<string, unknown>[];
const unsited = db.prepare("SELECT * FROM unsited_license WHERE radio_service_code = 'SL' AND licensee_state IN ('DC', 'MD', 'VA', 'MO') ORDER BY call_sign").all() as Record<string, unknown>[];
const services = db.prepare("SELECT * FROM radio_service ORDER BY code").all() as Record<string, unknown>[];
const files = db.prepare("SELECT * FROM source_file ORDER BY id").all() as Record<string, unknown>[];
const date = String(db.prepare("SELECT MAX(COALESCE(fcc_published_at, downloaded_at)) AS d FROM source_file").pluck().get() ?? "");

const header = `-- A small FCC database for tests and offline runs: ArgusRF's schema (src/fcc/schema.sql)
-- with real rows from an ArgusRF build (FCC data of ${date}), made by scripts/fcc-fixture.ts:
-- DC Fire and EMS, Arlington County and WMATA licenses, the trunked base
-- stations in central Washington, and DC's, Maryland's, Virginia's and
-- Missouri's State Licenses (no sites listed). Real rows, so the same end-to-end assertions
-- hold offline, on staging and on production.
`;
const sql = [header, readFileSync(join(ROOT, "src/fcc/schema.sql"), "utf8"), inserts("source_file", files), inserts("radio_service", services), inserts("transmitter", tx), inserts("unsited_license", unsited), ""].join("\n");
writeFileSync(join(ROOT, "test/fixtures/fcc.sql"), sql);
console.log(`test/fixtures/fcc.sql: ${tx.length} transmitters (${new Set(tx.map((t) => t.call_sign)).size} licenses), ${unsited.length} unsited licenses, ${(sql.length / 1024).toFixed(0)} KB`);
