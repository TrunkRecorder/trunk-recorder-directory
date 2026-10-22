// Exploring the directory: by place (state → county → city), on a map, near a
// point, and the licensed trunked systems no one has shared yet. Sites are
// where their FCC-licensed transmitters are (place.ts): a system is in every
// county and city one of its transmitters is in.

import { type Db, type Row, first, marks } from "./db.ts";
import { distanceKm } from "./geo.ts";
import { resolve } from "./share.ts";

export const TYPES = ["p25", "smartnet", "dmr", "nxdn", "edacs"] as const;
/** A system with transmitters in this many counties of a state is listed as regional there, not under each county. */
export const REGIONAL_COUNTIES = 4;
/** A system not heard for this long is stale. */
export const STALE_MS = 30 * 24 * 3600_000;

/** `types=p25,smartnet` → those (unknown ones dropped); none: every type. */
export function parseTypes(v: string | null): string[] {
  const t = (v ?? "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => (TYPES as readonly string[]).includes(x));
  return t.length ? [...new Set(t)] : [...TYPES];
}
const typeSql = (types: string[]) => ({ sql: `y.type IN (${marks(types.length)})`, params: types });

export interface SystemSummary {
  id: string;
  name: string;
  type: string;
  /** Who holds its licenses (the most of its transmitters'). */
  licensee: string;
  sites: number;
  /** Counties its transmitters are in (in the place asked about, when there is one). */
  counties: number;
  talkgroupCount: number;
  lastHeard: number | null;
  stale: boolean;
}

async function summaries(db: Db, ids: string[], now: number, countiesIn?: string): Promise<SystemSummary[]> {
  const out: SystemSummary[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const some = ids.slice(i, i + 90);
    const rows = await db.all<Row>(
      `SELECT y.id, y.name, y.type,
              (SELECT COUNT(*) FROM sites s WHERE s.system_id = y.id AND s.status IN ('heard', 'announced')) AS sites,
              (SELECT MAX(s.last_heard) FROM sites s WHERE s.system_id = y.id) AS last_heard,
              (SELECT COUNT(*) FROM talkgroups t WHERE t.system_id = y.id AND t.status IN ('active', 'heard')) AS tgs,
              (SELECT COUNT(DISTINCT x.county) FROM site_transmitters x JOIN sites s ON s.id = x.site_id WHERE s.system_id = y.id AND x.county != '' ${countiesIn ? "AND x.state = ?" : ""}) AS counties,
              (SELECT x.licensee FROM site_transmitters x JOIN sites s ON s.id = x.site_id WHERE s.system_id = y.id AND x.licensee != '' GROUP BY x.licensee ORDER BY COUNT(*) DESC LIMIT 1) AS licensee
         FROM systems y WHERE y.id IN (${marks(some.length)}) AND y.status = 'active'`,
      countiesIn ? [countiesIn, ...some] : some,
    );
    for (const r of rows) {
      const last = r.last_heard as number | null;
      out.push({ id: r.id as string, name: r.name as string, type: r.type as string, licensee: (r.licensee as string) ?? "", sites: r.sites as number, counties: r.counties as number, talkgroupCount: r.tgs as number, lastHeard: last, stale: !last || now - last > STALE_MS });
    }
  }
  return out.sort((a, b) => (a.name || a.licensee || a.id).localeCompare(b.name || b.licensee || b.id));
}

/** Systems with a transmitter where `where` says (SQL on site_transmitters x), of these types. */
async function systemsWhere(db: Db, where: string, params: unknown[], types: string[]): Promise<string[]> {
  const t = typeSql(types);
  const rows = await db.all<{ id: string }>(
    `SELECT DISTINCT y.id FROM site_transmitters x JOIN sites s ON s.id = x.site_id JOIN systems y ON y.id = s.system_id
      WHERE ${where} AND y.status = 'active' AND s.status IN ('heard', 'announced') AND ${t.sql}`,
    [...params, ...t.params],
  );
  return rows.map((r) => r.id);
}

const placeName = (db: Db, geoid: string) => first<Row>(db, "SELECT geoid, kind, state, name, full_name, lat, lon FROM places WHERE geoid = ?", [geoid]);

/** Every state with systems, how many of each type, and how many systems aren't placed yet. */
export async function states(db: Db, types: string[]) {
  const t = typeSql(types);
  const rows = await db.all<{ state: string; type: string; n: number }>(
    `SELECT x.state, y.type, COUNT(DISTINCT y.id) AS n FROM site_transmitters x JOIN sites s ON s.id = x.site_id JOIN systems y ON y.id = s.system_id
      WHERE x.state != '' AND y.status = 'active' AND ${t.sql} GROUP BY x.state, y.type`,
    t.params,
  );
  const names = new Map((await db.all<Row>("SELECT geoid, name FROM places WHERE kind = 'state'")).map((r) => [r.geoid as string, r.name as string]));
  const by = new Map<string, { state: string; name: string; systems: number; byType: Record<string, number> }>();
  for (const r of rows) {
    const e = by.get(r.state) ?? { state: r.state, name: names.get(r.state) ?? r.state, systems: 0, byType: {} };
    e.byType[r.type] = r.n;
    by.set(r.state, e);
  }
  for (const [st, e] of by) e.systems = (await systemsWhere(db, "x.state = ?", [st], types)).length;
  const unplaced = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM systems y WHERE y.status = 'active' AND ${t.sql}
       AND NOT EXISTS (SELECT 1 FROM sites s JOIN site_transmitters x ON x.site_id = s.id WHERE s.system_id = y.id)`,
    t.params,
  );
  return { states: [...by.values()].sort((a, b) => a.name.localeCompare(b.name)), unplaced: unplaced?.n ?? 0 };
}

/** A state: its counties with systems, and the regional systems (in many of its counties). */
export async function state(db: Db, st: string, types: string[], now = Date.now()) {
  const info = await placeName(db, st);
  if (!info || info.kind !== "state") return null;
  const ids = await systemsWhere(db, "x.state = ?", [st], types);
  const all = await summaries(db, ids, now, st);
  const regional = all.filter((s) => s.counties >= REGIONAL_COUNTIES);
  const t = typeSql(types);
  const counts = await db.all<{ county: string; n: number }>(
    `SELECT x.county, COUNT(DISTINCT y.id) AS n FROM site_transmitters x JOIN sites s ON s.id = x.site_id JOIN systems y ON y.id = s.system_id
      WHERE x.state = ? AND x.county != '' AND y.status = 'active' AND ${t.sql} GROUP BY x.county`,
    [st, ...t.params],
  );
  const counties = [];
  for (const c of counts) {
    const p = await placeName(db, c.county);
    counties.push({ geoid: c.county, name: (p?.full_name as string) ?? c.county, systems: c.n });
  }
  return { state: st, name: info.name as string, systems: all.length, regional, counties: counties.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** A county: its systems (regional ones apart), and its cities with systems. */
export async function county(db: Db, st: string, geoid: string, types: string[], now = Date.now()) {
  const info = await placeName(db, geoid);
  if (!info || info.kind !== "county" || info.state !== st) return null;
  const all = await summaries(db, await systemsWhere(db, "x.county = ?", [geoid], types), now, st);
  const t = typeSql(types);
  const counts = await db.all<{ place: string; n: number }>(
    `SELECT x.place, COUNT(DISTINCT y.id) AS n FROM site_transmitters x JOIN sites s ON s.id = x.site_id JOIN systems y ON y.id = s.system_id
      WHERE x.county = ? AND x.place != '' AND y.status = 'active' AND ${t.sql} GROUP BY x.place`,
    [geoid, ...t.params],
  );
  const cities = [];
  for (const c of counts) {
    const p = await placeName(db, c.place);
    cities.push({ geoid: c.place, name: (p?.full_name as string) ?? c.place, systems: c.n });
  }
  return {
    state: st, stateName: ((await placeName(db, st))?.name as string) ?? st, geoid, name: info.full_name as string, lat: info.lat, lon: info.lon,
    systems: all.filter((s) => s.counties < REGIONAL_COUNTIES),
    regional: all.filter((s) => s.counties >= REGIONAL_COUNTIES),
    cities: cities.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** A city (Census place): its systems. */
export async function city(db: Db, st: string, countyId: string, geoid: string, types: string[], now = Date.now()) {
  const info = await placeName(db, geoid);
  if (!info || info.kind !== "place" || info.state !== st) return null;
  const c = await placeName(db, countyId);
  const all = await summaries(db, await systemsWhere(db, "x.place = ?", [geoid], types), now, st);
  return {
    state: st, stateName: ((await placeName(db, st))?.name as string) ?? st, county: countyId, countyName: (c?.full_name as string) ?? countyId, geoid, name: info.full_name as string, lat: info.lat, lon: info.lon,
    systems: all.filter((s) => s.counties < REGIONAL_COUNTIES),
    regional: all.filter((s) => s.counties >= REGIONAL_COUNTIES),
  };
}

export interface MapSite {
  site: string;
  system: string;
  name: string;
  type: string;
  stale: boolean;
  /** Its transmitters: [lat, lon]. */
  at: [number, number][];
}

/** Every placed site, for the map (of these types). */
export async function mapSites(db: Db, types: string[], now = Date.now()): Promise<MapSite[]> {
  const t = typeSql(types);
  const rows = await db.all<Row>(
    `SELECT s.id AS site, y.id AS system, y.name, y.type, s.last_heard, x.lat, x.lon, x.licensee
       FROM site_transmitters x JOIN sites s ON s.id = x.site_id JOIN systems y ON y.id = s.system_id
      WHERE y.status = 'active' AND s.status IN ('heard', 'announced') AND ${t.sql} ORDER BY s.id`,
    t.params,
  );
  const by = new Map<string, MapSite>();
  for (const r of rows) {
    let e = by.get(r.site as string);
    if (!e) {
      const last = r.last_heard as number | null;
      e = { site: r.site as string, system: r.system as string, name: (r.name as string) || (r.licensee as string) || "", type: r.type as string, stale: !last || now - last > STALE_MS, at: [] };
      by.set(e.site, e);
    }
    e.at.push([r.lat as number, r.lon as number]);
  }
  return [...by.values()];
}

/** How many systems (of these types) each county has: the map's shading. */
export async function countyCounts(db: Db, types: string[]): Promise<Record<string, number>> {
  const t = typeSql(types);
  const rows = await db.all<{ county: string; n: number }>(
    `SELECT x.county, COUNT(DISTINCT y.id) AS n FROM site_transmitters x JOIN sites s ON s.id = x.site_id JOIN systems y ON y.id = s.system_id
      WHERE x.county != '' AND y.status = 'active' AND ${t.sql} GROUP BY x.county`,
    t.params,
  );
  return Object.fromEntries(rows.map((r) => [r.county, r.n]));
}

/** The largest box the licensed layer answers for (degrees), so a request stays one index range. */
export const LICENSED_MAX_DEG = 3;

export interface Licensed {
  callSign: string;
  licensee: string;
  service: string;
  serviceDesc: string;
  lat: number;
  lon: number;
  stationClass: string;
  frequencies: number;
}

/**
 * Trunked systems licensed in a box that no one has shared: base and repeater
 * stations of the FCC's trunked radio services (and centralized trunk relays,
 * FB8, of any), one per call sign and spot, leaving out call signs the
 * directory already has.
 */
export async function licensed(db: Db, fcc: Db, box: { west: number; south: number; east: number; north: number }, limit = 2000): Promise<Licensed[]> {
  const rows = await fcc.all<Row>(
    `SELECT t.call_sign, t.licensee_name, t.radio_service_code, rs.description AS service_desc, ROUND(t.lat, 4) AS lat, ROUND(t.lon, 4) AS lon, MAX(t.class_station_code) AS class, COUNT(*) AS n
       FROM transmitter t LEFT JOIN radio_service rs ON rs.code = t.radio_service_code
      WHERE t.lat BETWEEN ? AND ? AND t.lon BETWEEN ? AND ? AND t.license_status = 'A' AND t.class_station_code LIKE 'FB%'
        AND (rs.description LIKE '%Trunked%' OR t.class_station_code LIKE 'FB8%')
      GROUP BY t.call_sign, ROUND(t.lat, 4), ROUND(t.lon, 4) LIMIT ?`,
    [box.south, box.north, box.west, box.east, limit],
  );
  const calls = [...new Set(rows.map((r) => r.call_sign as string))];
  const known = new Set<string>();
  // (45 at a time: twice in one statement, under D1's 100 parameters.)
  for (let i = 0; i < calls.length; i += 45) {
    const some = calls.slice(i, i + 45);
    for (const r of await db.all<{ c: string }>(
      `SELECT x.call_sign AS c FROM site_transmitters x JOIN sites s ON s.id = x.site_id JOIN systems y ON y.id = s.system_id WHERE x.call_sign IN (${marks(some.length)}) AND y.status = 'active'
       UNION SELECT l.call_sign FROM fcc_licenses l JOIN systems y ON y.id = l.system_id WHERE l.call_sign IN (${marks(some.length)}) AND y.status = 'active'`,
      [...some, ...some],
    )) known.add(r.c);
  }
  return rows
    .filter((r) => !known.has(r.call_sign as string))
    .map((r) => ({ callSign: r.call_sign as string, licensee: (r.licensee_name as string) ?? "", service: (r.radio_service_code as string) ?? "", serviceDesc: (r.service_desc as string) ?? "", lat: r.lat as number, lon: r.lon as number, stationClass: (r.class as string) ?? "", frequencies: r.n as number }));
}

export interface NearSystem extends SystemSummary {
  /** Its nearest transmitter: how far (km) and which way (degrees). */
  distanceKm: number;
  bearingDeg: number;
  /** Its control channels' band, MHz (the lowest). */
  bandMhz: number | null;
  /** Its transmitters in range, for the reception estimate (the page computes it). */
  transmitters: { lat: number; lon: number; heightM: number | null; erpW: number | null; freqHz: number | null; callSign: string }[];
}

const bearing = (a: [number, number], b: [number, number]) => {
  const r = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(r(b[1] - a[1])) * Math.cos(r(b[0]));
  const x = Math.cos(r(a[0])) * Math.sin(r(b[0])) - Math.sin(r(a[0])) * Math.cos(r(b[0])) * Math.cos(r(b[1] - a[1]));
  return (Math.atan2(y, x) * 180) / Math.PI + 360;
};

/** Systems with a transmitter within `radiusKm` of a point (of these types), nearest first. */
export async function nearby(db: Db, at: [number, number], radiusKm: number, types: string[], now = Date.now()): Promise<NearSystem[]> {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.max(0.2, Math.cos((at[0] * Math.PI) / 180)));
  const t = typeSql(types);
  const rows = await db.all<Row>(
    `SELECT y.id AS system, x.lat, x.lon, x.height_m, x.erp_w, x.freq_hz, x.call_sign
       FROM site_transmitters x JOIN sites s ON s.id = x.site_id JOIN systems y ON y.id = s.system_id
      WHERE x.lat BETWEEN ? AND ? AND x.lon BETWEEN ? AND ? AND y.status = 'active' AND s.status IN ('heard', 'announced') AND ${t.sql}`,
    [at[0] - dLat, at[0] + dLat, at[1] - dLon, at[1] + dLon, ...t.params],
  );
  const by = new Map<string, { d: number; b: number; tx: NearSystem["transmitters"]; band: number | null }>();
  for (const r of rows) {
    const p: [number, number] = [r.lat as number, r.lon as number];
    const d = distanceKm(at, p);
    if (d > radiusKm) continue;
    const sys = await resolve(db, r.system as string);
    const e = by.get(sys) ?? { d: Infinity, b: 0, tx: [], band: null };
    if (d < e.d) [e.d, e.b] = [d, bearing(at, p) % 360];
    const f = r.freq_hz as number | null;
    if (f && (e.band === null || f / 1e6 < e.band)) e.band = Math.round(f / 1e5) / 10;
    e.tx.push({ lat: p[0], lon: p[1], heightM: r.height_m as number | null, erpW: r.erp_w as number | null, freqHz: f, callSign: r.call_sign as string });
    by.set(sys, e);
  }
  const sums = await summaries(db, [...by.keys()], now);
  return sums
    .map((s) => {
      const e = by.get(s.id)!;
      return { ...s, distanceKm: Math.round(e.d * 10) / 10, bearingDeg: Math.round(e.b), bandMhz: e.band, transmitters: e.tx };
    })
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

/** Places by name (for search): counties and cities first by how many systems they have, then by name. */
export async function placesNamed(db: Db, q: string, limit = 10) {
  const text = q.trim();
  if (text.length < 3) return [];
  const rows = await db.all<Row>(
    `SELECT p.geoid, p.kind, p.state, p.full_name,
            (SELECT COUNT(*) FROM site_transmitters x WHERE (p.kind = 'county' AND x.county = p.geoid) OR (p.kind = 'place' AND x.place = p.geoid) OR (p.kind = 'state' AND x.state = p.geoid)) AS n,
            (SELECT x.county FROM site_transmitters x WHERE p.kind = 'place' AND x.place = p.geoid LIMIT 1) AS county
       FROM places p WHERE p.name LIKE ? OR p.full_name LIKE ? ORDER BY n DESC, LENGTH(p.full_name) LIMIT ?`,
    [`${text}%`, `${text}%`, limit],
  );
  return rows.map((r) => ({ geoid: r.geoid as string, kind: r.kind as string, state: r.state as string, name: r.full_name as string, transmitters: r.n as number, county: (r.county as string) ?? null }));
}
