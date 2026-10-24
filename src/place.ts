// Placing a system's sites from FCC licenses (ArgusRF's database): which
// licensed base and repeater stations are each site's transmitters, where
// they are, and so which state, county and city it's in.
//
// A site's frequencies (control channels, voice channels granted) are matched
// against licensed transmitters (station class FB…: bases and repeaters, not
// mobiles or control stations):
//
//   by call sign:  the licenses the system has (heard on the air, in a
//                  config, looked up), on the site's frequencies;
//   by fingerprint: with none of those, every base station licensed on one of
//                  its control channels, scored by how many of its frequencies
//                  are licensed at the same spot. A spot needs two or more.
//
// A license's spots on the frequencies within CLUSTER_KM of the best one are
// the site's transmitters (a simulcast site has several). Two equally good
// spots far apart (a channel reused across a state) are ambiguous: the site
// isn't placed, and placements says why.

import { type Db, type Row, insertRows, marks } from "./db.ts";
import { cellOf, distanceKm, regionOf } from "./geo.ts";
import type { Observation } from "./observation.ts";
import type { Places } from "./places.ts";
import { callSignClaim, type ClaimKeys, systemClaim } from "./claims.ts";
import { claim, lookupClaims, reindex } from "./share.ts";
import { ChangeSet } from "./store.ts";

const HALF_CHANNEL = 3125;
const CLUSTER_KM = 60;
/** Placed again after this long (licenses change), or when its frequencies do. */
const REPLACE_MS = 30 * 24 * 3600_000;
const MAX_FREQS = 40;

export interface Transmitter {
  callSign: string;
  licensee: string;
  lat: number;
  lon: number;
  heightM: number | null;
  erpW: number | null;
  freqHz: number;
  stationClass: string;
  /** How many of the site's frequencies are licensed here. */
  score: number;
  /** Whether a control channel of the site's is. */
  control: boolean;
}

export interface FccRow {
  call_sign: string;
  licensee_name: string | null;
  freq_center_hz: number;
  lat: number;
  lon: number;
  structure_height_m: number | null;
  power_erp_w: number | null;
  class_station_code: string | null;
  location_state: string | null;
}

const COLS = "call_sign, licensee_name, freq_center_hz, lat, lon, structure_height_m, power_erp_w, class_station_code, location_state";
// (`+`: never by a status index; on D1, with no statistics, one read the whole table.)
const BASE = "class_station_code LIKE 'FB%' AND +license_status = 'A'";

/**
 * The licensed spots that are a site's transmitters: from these FCC rows, each
 * spot (a location; one tower can hold its channels under several call signs)
 * scored by how many of the site's frequencies are licensed there, plus a half
 * for a call sign the system has. A spot needs a control channel, and two of
 * its frequencies (or one, by a call sign of the system's).
 */
export function choose(rows: FccRow[], control: number[], all: number[], known: Set<string>): { transmitters: (Transmitter & { state: string })[]; note: string } {
  const which = (f: number, set: number[]) => set.find((x) => Math.abs(x - f) <= HALF_CHANNEL);
  const spots = new Map<string, Transmitter & { state: string; freqs: Set<number>; calls: Map<string, number> }>();
  for (const r of rows) {
    const f = which(r.freq_center_hz, all);
    if (f === undefined) continue;
    const key = `${r.lat.toFixed(4)}|${r.lon.toFixed(4)}`;
    let s = spots.get(key);
    if (!s) {
      s = { callSign: r.call_sign, licensee: r.licensee_name ?? "", lat: r.lat, lon: r.lon, heightM: null, erpW: null, freqHz: 0, stationClass: r.class_station_code ?? "", score: 0, control: false, state: r.location_state ?? "", freqs: new Set(), calls: new Map() };
      spots.set(key, s);
    }
    s.freqs.add(f);
    s.calls.set(r.call_sign, (s.calls.get(r.call_sign) ?? 0) + 1);
    if (which(r.freq_center_hz, control) !== undefined && !s.control) [s.control, s.freqHz, s.stationClass] = [true, r.freq_center_hz, r.class_station_code ?? s.stationClass];
    if (r.power_erp_w != null) s.erpW = Math.max(s.erpW ?? 0, r.power_erp_w);
    if (r.structure_height_m != null) s.heightM = Math.max(s.heightM ?? 0, r.structure_height_m);
  }
  const ok = [...spots.values()]
    .map((s) => {
      const mineToo = [...s.calls.keys()].some((c) => known.has(c));
      // Its call sign: the system's, else the one licensing the most of it here.
      const call = [...s.calls.entries()].sort((a, b) => Number(known.has(b[0])) - Number(known.has(a[0])) || b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
      const licensee = rows.find((r) => r.call_sign === call)?.licensee_name ?? s.licensee;
      return { ...s, callSign: call, licensee, score: s.freqs.size + (mineToo ? 0.5 : 0), mineToo };
    })
    .filter((s) => s.control && (s.freqs.size >= 2 || s.mineToo));
  if (!ok.length) return { transmitters: [], note: spots.size ? "no licensed spot has its control channel and enough of its frequencies" : "no license on its frequencies" };
  ok.sort((a, b) => b.score - a.score || a.callSign.localeCompare(b.callSign));
  const best = ok[0];
  const rival = ok.find((s) => s.score === best.score && distanceKm([s.lat, s.lon], [best.lat, best.lon]) > CLUSTER_KM);
  if (rival) return { transmitters: [], note: `ambiguous: ${best.callSign} and ${rival.callSign} license it ${Math.round(distanceKm([rival.lat, rival.lon], [best.lat, best.lon]))} km apart` };
  // Its transmitters: the spots near the best that license nearly as much of it.
  const mine = ok.filter((s) => s.score >= best.score - 1 && distanceKm([s.lat, s.lon], [best.lat, best.lon]) <= CLUSTER_KM);
  return { transmitters: mine.map(({ freqs: _f, calls: _c, mineToo: _m, ...t }) => t), note: "" };
}

/** The licensed transmitters of call signs `callSigns` (bases and repeaters): fetched once for a system's sites. */
export async function rowsOf(fcc: Db, callSigns: string[]): Promise<FccRow[]> {
  const some = [...new Set(callSigns)].slice(0, 50);
  return some.length ? fcc.all<FccRow>(`SELECT ${COLS} FROM transmitter WHERE call_sign IN (${marks(some.length)}) AND ${BASE}`, some) : [];
}

/**
 * A site's transmitters: the licensed spots on its frequencies (`control`
 * its control channels, `all` every frequency it uses), by the system's call
 * signs (`byCall`: their rows; `callSigns`) and every base station on its
 * frequencies. Placing a system, and finding the region a share is from, both
 * ask this.
 */
export async function locate(fcc: Db, control: number[], all: number[], byCall: FccRow[], callSigns: string[]): Promise<ReturnType<typeof choose>> {
  const rows = byCall.slice();
  for (const f of all.slice(0, MAX_FREQS)) rows.push(...(await fcc.all<FccRow>(`SELECT ${COLS} FROM transmitter WHERE freq_center_hz BETWEEN ? AND ? AND ${BASE}`, [f - HALF_CHANNEL, f + HALF_CHANNEL])));
  return choose(rows, control, all, new Set(callSigns));
}

/**
 * Where a share is from, by its towers, not its recorder: the region of the
 * licensed transmitters its sites' frequencies match (as placing them would),
 * and every call sign it has (its licenses, those heard on the air, its
 * towers'). Its weak identities (a default WACN, a SmartNet System ID) are
 * matched in that region, its call signs anywhere. Null region: no tower found.
 */
export async function shareTowers(fcc: Db, obs: Observation): Promise<{ region: string | null; callSigns: string[] }> {
  const raster = (hz: number) => Math.round(hz / 6250) * 6250;
  const own = [
    ...Object.values(obs.system.fcc ?? {}).map((l) => l.callSign),
    ...obs.system.sites.flatMap((x) => (x.heard?.callSigns ?? []).map((c) => c.callSign)),
  ].map((c) => c.toUpperCase());
  const byCall = await rowsOf(fcc, own);
  const at: [number, number][] = [];
  const found = new Set(own);
  for (const site of obs.system.sites) {
    const control = site.controlChannelsHz.map(raster);
    const all = [...new Set([...control, ...(site.voiceChannelsHz ?? []).map(raster), ...(site.heard?.voice ?? []).map((v) => raster(v.freqHz))])];
    if (!control.length) continue;
    const r = await locate(fcc, control, all, byCall, own);
    for (const t of r.transmitters) {
      at.push([t.lat, t.lon]);
      found.add(t.callSign);
    }
  }
  const region = at.length ? regionOf(cellOf(at.reduce((a, p) => a + p[0], 0) / at.length, at.reduce((a, p) => a + p[1], 0) / at.length)) : null;
  return { region, callSigns: [...found].filter(Boolean).sort() };
}

export interface PlaceResult {
  placed: string[];
  unplaced: { site: string; note: string }[];
}

/**
 * Place system `systemId`'s sites (those not placed since their frequencies
 * last changed, or long ago; `force`: all). Writes their transmitters, the
 * sites' (and the system's) location, and licenses it found.
 */
export async function placeSystem(db: Db, fcc: Db, places: Places, systemId: string, opts: { now?: number; force?: boolean } = {}): Promise<PlaceResult> {
  const now = opts.now ?? Date.now();
  const out: PlaceResult = { placed: [], unplaced: [] };
  const sites = await db.all<Row>("SELECT id, lat, lon FROM sites WHERE system_id = ? AND status IN ('heard', 'announced')", [systemId]);
  const type = ((await db.all<Row>("SELECT type FROM systems WHERE id = ?", [systemId]))[0]?.type as string) ?? "";
  if (!sites.length) return out;
  const ids = sites.map((s) => s.id as string);
  const freqRows = await db.all<{ site_id: string; freq_hz: number; use: string }>(`SELECT site_id, freq_hz, use FROM site_freqs WHERE site_id IN (${marks(ids.length)})`, ids);
  const was = new Map((await db.all<Row>(`SELECT * FROM placements WHERE site_id IN (${marks(ids.length)})`, ids)).map((p) => [p.site_id as string, p]));
  const licenses = await db.all<Row>("SELECT id, freq_hz, call_sign, name, source FROM fcc_licenses WHERE system_id = ?", [systemId]);
  const callSigns = [...new Set(licenses.map((l) => l.call_sign as string))].slice(0, 50);
  const byCall = await rowsOf(fcc, callSigns);

  const cs = new ChangeSet(db, { actorKind: "system", actorId: "fcc", kind: "edit", note: "placed from FCC licenses" }, now);
  const stmts: { sql: string; params: unknown[] }[] = [];
  const placed: { lat: number; lon: number }[] = [];
  for (const s of sites) {
    const id = s.id as string;
    const mine = freqRows.filter((f) => f.site_id === id);
    const control = mine.filter((f) => f.use === "control").map((f) => f.freq_hz);
    const all = [...new Set(mine.map((f) => f.freq_hz))].sort((a, b) => a - b).slice(0, MAX_FREQS);
    const key = `${all.join(",")}|${callSigns.join(",")}`;
    const p = was.get(id);
    if (!opts.force && p && p.freqs === key && now - (p.at as number) < REPLACE_MS) {
      if (s.lat != null) placed.push({ lat: s.lat as number, lon: s.lon as number });
      continue;
    }
    if (!control.length) continue;
    const r = await locate(fcc, control, all, byCall, callSigns);
    const method = r.transmitters.some((t) => callSigns.includes(t.callSign)) ? "call_sign" : "fingerprint";
    stmts.push({ sql: "DELETE FROM site_transmitters WHERE site_id = ?", params: [id] });
    stmts.push({ sql: "INSERT OR REPLACE INTO placements (site_id, at, method, note, freqs) VALUES (?, ?, ?, ?, ?)", params: [id, now, r.transmitters.length ? method : "none", r.note, key] });
    if (!r.transmitters.length) {
      out.unplaced.push({ site: id, note: r.note });
      continue;
    }
    const tx: unknown[][] = [];
    for (const t of r.transmitters) {
      const w = await places.at(t.state, t.lat, t.lon);
      tx.push([id, t.callSign, t.licensee, t.lat, t.lon, t.heightM, t.erpW, t.freqHz, t.stationClass, w.state, w.county, w.place, now]);
    }
    stmts.push(...insertRows("site_transmitters", ["site_id", "call_sign", "licensee", "lat", "lon", "height_m", "erp_w", "freq_hz", "station_class", "state", "county", "place", "at"], tx, "ON CONFLICT (site_id, call_sign, lat, lon) DO NOTHING"));
    // The site at its transmitters' centre.
    const lat = round(r.transmitters.reduce((a, t) => a + t.lat, 0) / r.transmitters.length);
    const lon = round(r.transmitters.reduce((a, t) => a + t.lon, 0) / r.transmitters.length);
    if (s.lat == null || distanceKm([s.lat as number, s.lon as number], [lat, lon]) > 0.1) {
      await cs.set("site", id, "lat", lat);
      await cs.set("site", id, "lon", lon);
      await cs.set("site", id, "loc_source", "fcc");
    }
    placed.push({ lat, lon });
    out.placed.push(id);
    // Its towers' call signs are the system's too: a share naming one finds it.
    for (const c of new Set(r.transmitters.map((t) => t.callSign))) {
      const k = callSignClaim(type, c);
      if (k) await claim(cs, [k], "system", systemId);
    }
    // The licenses it found: kept as the system's (a lookup's never replaces the air's or a person's).
    for (const t of r.transmitters.filter((x) => x.control)) {
      const f = Math.round(t.freqHz / 6250) * 6250;
      const have = licenses.find((l) => l.freq_hz === f);
      if (!have) {
        licenses.push(await cs.create("license", { system_id: systemId, freq_hz: f, call_sign: t.callSign, name: t.licensee, source: "lookup" }));
      } else if (have.call_sign === t.callSign && !have.name && t.licensee) {
        await cs.set("license", have.id as string, "name", t.licensee);
        have.name = t.licensee;
      }
    }
  }
  if (placed.length) {
    const sys = await cs.get("system", systemId);
    const lat = round(placed.reduce((a, p) => a + p.lat, 0) / placed.length);
    const lon = round(placed.reduce((a, p) => a + p.lon, 0) / placed.length);
    if (sys && (sys.lat == null || distanceKm([sys.lat as number, sys.lon as number], [lat, lon]) > 0.1)) {
      await cs.set("system", systemId, "lat", lat);
      await cs.set("system", systemId, "lon", lon);
    }
  }
  if (!cs.empty) cs.bump(systemId);
  await cs.commit();
  // Who holds its licenses (the most of its transmitters'): one value every list, search and export reads.
  if (stmts.length)
    stmts.push({
      sql: `UPDATE systems SET licensee = COALESCE((SELECT x.licensee FROM site_transmitters x JOIN sites s ON s.id = x.site_id
              WHERE s.system_id = systems.id AND x.licensee != '' GROUP BY x.licensee ORDER BY COUNT(*) DESC LIMIT 1), '') WHERE id = ?`,
      params: [systemId],
    });
  if (stmts.length) await db.batch(stmts);
  if (out.placed.length) await reindex(db, systemId);
  return out;
}

const round = (v: number) => Math.round(v * 1e5) / 1e5;

/**
 * Other systems of system `systemId`'s type whose transmitters are its own
 * (the same licensed tower, under the same call sign): the same system, found
 * twice (shared before either named the other). Merged after placing.
 */
export async function sameTowers(db: Db, systemId: string): Promise<string[]> {
  const rows = await db.all<{ id: string }>(
    `SELECT DISTINCT y2.id FROM site_transmitters a JOIN sites s1 ON s1.id = a.site_id JOIN systems y1 ON y1.id = s1.system_id
       JOIN site_transmitters b ON b.call_sign = a.call_sign AND ROUND(b.lat, 4) = ROUND(a.lat, 4) AND ROUND(b.lon, 4) = ROUND(a.lon, 4)
       JOIN sites s2 ON s2.id = b.site_id JOIN systems y2 ON y2.id = s2.system_id
      WHERE s1.system_id = ? AND y2.id != y1.id AND y2.type = y1.type AND y2.status = 'active'
        AND (y1.wacn IS NULL OR y2.wacn IS NULL OR y1.wacn = y2.wacn) AND (y1.sys_id IS NULL OR y2.sys_id IS NULL OR y1.sys_id = y2.sys_id)`,
    [systemId],
  );
  return rows.map((r) => r.id);
}

/**
 * Other systems with system `systemId`'s identity where its licensed towers
 * are: a weak identity (a default WACN, a SmartNet SysID) is claimed in each
 * region its towers are in, and another active system of its type holding it
 * in one of them or one around is the same system, shared from another part
 * of it (a statewide system whose recorders hear different ends of it).
 */
export async function sameIdentityNearby(db: Db, systemId: string, now: number): Promise<string[]> {
  const sys = (await db.all<Row>("SELECT type, wacn, sys_id FROM systems WHERE id = ?", [systemId]))[0];
  if (!sys) return [];
  const tx = await db.all<{ lat: number; lon: number }>("SELECT DISTINCT x.lat, x.lon FROM site_transmitters x JOIN sites s ON s.id = x.site_id WHERE s.system_id = ?", [systemId]);
  const id = { wacn: (sys.wacn as number | null) ?? undefined, sysId: (sys.sys_id as number | null) ?? undefined };
  const claims = [...new Set(tx.map((t) => regionOf(cellOf(t.lat, t.lon))))]
    .map((r) => systemClaim(sys.type as string, id, r))
    .filter((c): c is ClaimKeys => !!c && c.store[0].includes("@"));
  if (!claims.length) return [];
  const cs = new ChangeSet(db, { actorKind: "system", actorId: "fcc", kind: "edit", note: "its identity where its towers are" }, now);
  await claim(cs, claims, "system", systemId);
  const out: string[] = [];
  for (const h of await lookupClaims(cs, claims, "system")) {
    if (h.id === systemId || out.includes(h.id)) continue;
    const other = (await db.all<Row>("SELECT type, status FROM systems WHERE id = ?", [h.id]))[0];
    if (other?.status === "active" && other.type === sys.type) out.push(h.id);
  }
  await cs.commit();
  return out;
}
