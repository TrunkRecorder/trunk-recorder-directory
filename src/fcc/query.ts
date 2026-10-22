// ArgusRF's FCC license lookup: which licensed transmitters are on a band near
// a point, from its FCC ULS database (D1 `argus`, schema in schema.sql).
//
// COPIED from robotastic/argusrf at 03ea815: shared/src/query.ts and the
// functions of shared/src/geo.ts it uses, unchanged but for this header and
// the one import made local. ArgusRF owns the data and its schema; this copy
// is how the directory's Worker reads it. If ArgusRF changes either, copy them
// again (test/fcc.test.ts runs them on a database built from schema.sql).
//
// ── query.ts ──

// The core lookup (ArgusRF spec §5.1), written to run unchanged on better-sqlite3
// locally and on Cloudflare D1 in production.
//
// No R-tree. D1 has no virtual tables, so the spec's 3D R-tree cannot survive
// the intended deployment; rather than keep two query paths in step, the
// interval test is a bounded range scan:
//
//   freq_lower_hz >  :hi - MAX_BANDWIDTH_HZ   -- bounds the scan
//   freq_lower_hz <= :hi                      -- band starts at/below the top
//   freq_upper_hz >= :lo                      -- and ends at/above the bottom
//
// The first clause is what makes this cheap. "Find every interval overlapping
// [lo,hi]" is otherwise unindexable on a B-tree — an interval starting at 1 MHz
// could in principle still be open at 500 MHz, so the engine has to consider
// everything below :hi. Bounding the widest possible emission at 50 MHz turns
// that into a range of known width, which idx_tx_lower answers directly.
// MAX_BANDWIDTH_HZ is enforced at ingest, so the bound is a fact about the data
// rather than an assumption.
//
// The comparisons are on INTEGER Hz, so they are exact. There is no "prefilter,
// then re-check" step the way the spec's REAL-valued R-tree needs.

/** The widest emission ingest keeps (ArgusRF's shared/src/units.ts): what bounds the range scan. */
export const MAX_BANDWIDTH_HZ = 50_000_000;

/** Minimal shape both better-sqlite3 and D1 can satisfy. */
export interface QueryRunner {
  all<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> | T[];
}

export interface LookupInput {
  /** Observed band. For a point tune, pass the same value twice. */
  freqLoHz: number;
  freqHiHz: number;
  lat: number;
  lon: number;
  radiusM: number;
  limit?: number;
  /** Extra slop for RTL-SDR tuning error; see toleranceHz(). */
  toleranceHz?: number;
}

/**
 * Frequency slop to allow for an uncalibrated receiver.
 *
 * The spec suggests a flat ±2.5 kHz below 1 GHz. That under-corrects for the
 * actual error source: an RTL-SDR's error is a crystal offset in ppm, so it
 * scales with frequency. A typical uncalibrated dongle is ±20–50 ppm, which is
 * ±3 kHz at 150 MHz but ±22 kHz at 450 MHz — where a flat 2.5 kHz would miss
 * the correct license entirely on a 12.5 kHz channel.
 *
 * So: the greater of the spec's floor and a ppm-scaled term.
 */
export function toleranceHz(freqHz: number, ppm = 20): number {
  return Math.max(2_500, Math.round((freqHz * ppm) / 1_000_000));
}

export interface TransmitterRow {
  id: number;
  call_sign: string | null;
  freq_center_hz: number;
  freq_lower_hz: number;
  freq_upper_hz: number;
  bandwidth_hz: number | null;
  bandwidth_source: string | null;
  emission_designator: string | null;
  power_output_w: number | null;
  power_erp_w: number | null;
  lat: number;
  lon: number;
  location_kind: string;
  location_confidence: string;
  area_radius_m: number | null;
  tower_registration_number: string | null;
  structure_height_m: number | null;
  structure_type: string | null;
  location_name: string | null;
  location_city: string | null;
  location_state: string | null;
  licensee_name: string | null;
  frn: string | null;
  radio_service_code: string | null;
  radio_service_desc: string | null;
  /** The FCC's station class, verbatim (FB2 a repeater, FB8 a centralized trunk relay, FX1 a control station, MO a mobile; a C suffix: interconnect, T: temporary). Null before the column existed. */
  class_station_code: string | null;
  license_status: string | null;
  grant_date: string | null;
  expired_date: string | null;
}

export interface TransmitterHit extends TransmitterRow {
  distance_m: number;
  bearing_deg: number;
  bearing_cardinal: string;
}

/**
 * The bounded range scan, over either transmitter table. The active table
 * (`transmitter`) is the hot path; `transmitter_inactive` holds
 * cancelled/expired/terminated licenses and is scanned only as a fallback.
 * Both are the same shape and the same index, so the SQL differs only in the
 * table name — the status filter is redundant on each (every row in a table
 * already has the matching status class) and kept only for the active table as
 * belt-and-suspenders.
 */
function lookupSql(table: "transmitter" | "transmitter_inactive"): string {
  const activeClause = table === "transmitter" ? "AND t.license_status = 'A'" : "";
  return `
SELECT t.*, rs.description AS radio_service_desc
  FROM ${table} t
  LEFT JOIN radio_service rs ON rs.code = t.radio_service_code
 WHERE t.freq_lower_hz >  ?
   AND t.freq_lower_hz <= ?
   AND t.freq_upper_hz >= ?
   ${activeClause}
   AND t.lat BETWEEN ? AND ?
   AND t.lon BETWEEN ? AND ?
 LIMIT ?
`;
}

export const LOOKUP_SQL = lookupSql("transmitter");
export const LOOKUP_INACTIVE_SQL = lookupSql("transmitter_inactive");

export interface LookupResult {
  transmitters: TransmitterHit[];
  /**
   * True when no *active* license overlapped the band and these hits come from
   * the cancelled/expired/terminated pool instead — a "who *was* licensed here"
   * answer, not "who is". The caller must label them as historical.
   */
  historical: boolean;
}

/** Scan one transmitter table and reduce to distance-filtered, nearest-first hits. */
async function scan(
  runner: QueryRunner,
  sql: string,
  input: LookupInput,
  lo: number,
  hi: number,
  limit: number
): Promise<TransmitterHit[]> {
  const bb = boundingBox(input.lat, input.lon, input.radiusM);
  const rows = (await runner.all<TransmitterRow>(sql, [
    hi - MAX_BANDWIDTH_HZ,
    hi,
    lo,
    bb.minLat, bb.maxLat,
    bb.minLon, bb.maxLon,
    // Over-fetch: the bbox is looser than the radius, so some rows will be
    // dropped by the exact distance pass below and the caller's limit must still
    // be satisfiable afterwards.
    limit * 4,
  ])) as TransmitterRow[];

  const hits: TransmitterHit[] = [];
  for (const r of rows) {
    const distance_m = haversineMetres(input.lat, input.lon, r.lat, r.lon);
    // A mobile_area record describes a circle, not a point: the observer can be
    // inside it while its centroid is far away. Measure to the area's edge so
    // "within radius" means what the user expects.
    const effective = r.location_kind === "mobile_area" && r.area_radius_m
      ? Math.max(0, distance_m - r.area_radius_m)
      : distance_m;
    if (effective > input.radiusM) continue;
    const bearing_deg = initialBearingDeg(input.lat, input.lon, r.lat, r.lon);
    hits.push({ ...r, distance_m, bearing_deg, bearing_cardinal: cardinal(bearing_deg) });
  }
  hits.sort((a, b) => a.distance_m - b.distance_m);
  return hits.slice(0, limit);
}

/**
 * Licensed transmitters plausibly operating on `[freqLo, freqHi]` near the
 * observer, nearest first.
 *
 * Matching is band-overlap, not centre-frequency-±-tolerance: a hit is any
 * license whose *occupied band* intersects the observed band. That handles the
 * wideband case for free — if you are parked inside a signal wider than the
 * SDR's reception bandwidth, the selector sits entirely within the license's
 * band and still matches.
 *
 * When nothing *active* overlaps the band, it falls back to the
 * cancelled/expired/terminated pool and flags the result `historical`. A
 * paging channel whose licenses have all lapsed (the common case) then still
 * names who used to hold it, instead of showing nothing.
 */
export async function lookupTransmitters(
  runner: QueryRunner,
  input: LookupInput
): Promise<LookupResult> {
  const tol = input.toleranceHz ?? toleranceHz((input.freqLoHz + input.freqHiHz) / 2);
  const lo = Math.min(input.freqLoHz, input.freqHiHz) - tol;
  const hi = Math.max(input.freqLoHz, input.freqHiHz) + tol;
  const limit = input.limit ?? 200;

  const active = await scan(runner, LOOKUP_SQL, input, lo, hi, limit);
  if (active.length > 0) return { transmitters: active, historical: false };

  const historical = await scan(runner, LOOKUP_INACTIVE_SQL, input, lo, hi, limit);
  return { transmitters: historical, historical: historical.length > 0 };
}

// ── geo.ts (distance and bearing; metres and degrees true) ──


/** IUGG mean Earth radius, metres (spec §5.2). */
export const EARTH_RADIUS_M = 6_371_008.8;

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance between two points, metres. */
export function haversineMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Initial great-circle bearing FROM (lat1,lon1) TO (lat2,lon2), degrees true,
 * 0 = north, clockwise. This is the heading to point a directional antenna
 * along — it is not constant over a long path, but for the ranges here
 * (tens of km) the distinction is immaterial.
 */
export function initialBearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const COMPASS_16 = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
] as const;

export type CardinalPoint = (typeof COMPASS_16)[number];

/** 16-point cardinal label for a true bearing. */
export function cardinal(bearingDeg: number): CardinalPoint {
  const i = Math.round((((bearingDeg % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS_16[i];
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/**
 * Bounding box of the spherical cap of radius `radiusM` around a point
 * (spec §5.1 step 1): a cheap prefilter that the exact haversine pass trims.
 * It must never be too small, or real transmitters vanish before distance is
 * ever computed — a silent false negative, the worst failure this app has.
 *
 * The longitude half-width is asin(sin δ / cos φ), NOT the small-angle δ/cos φ.
 * The two agree to ~7 digits at 50 km, but the cheap version is biased *narrow*,
 * and the reason is geometric rather than a rounding artefact: the easternmost
 * point of the cap does not sit on the centre's parallel, it sits slightly
 * poleward of it. A box sized to the parallel therefore clips the cap's widest
 * point. Being wrong in the inclusive direction is free here (the haversine
 * pass drops the extras); being wrong the other way loses records.
 *
 * When the cap reaches a pole, no longitude bound is meaningful and the box
 * opens to the full range.
 */
export function boundingBox(lat: number, lon: number, radiusM: number): BoundingBox {
  const delta = radiusM / EARTH_RADIUS_M; // angular radius, radians
  const latDelta = toDeg(delta);
  const minLat = lat - latDelta - EPS_DEG;
  const maxLat = lat + latDelta + EPS_DEG;

  // Cap touches a pole -> every meridian is inside it.
  if (minLat <= -90 || maxLat >= 90) {
    return { minLat: Math.max(-90, minLat), maxLat: Math.min(90, maxLat), minLon: -180, maxLon: 180 };
  }

  const cosLat = Math.cos(toRad(lat));
  const ratio = Math.sin(delta) / cosLat;
  if (!Number.isFinite(ratio) || Math.abs(ratio) >= 1) {
    return { minLat: Math.max(-90, minLat), maxLat: Math.min(90, maxLat), minLon: -180, maxLon: 180 };
  }
  const lonDelta = toDeg(Math.asin(ratio)) + EPS_DEG;

  return {
    minLat: Math.max(-90, minLat),
    maxLat: Math.min(90, maxLat),
    minLon: Math.max(-180, lon - lonDelta),
    maxLon: Math.min(180, lon + lonDelta),
  };
}

/**
 * Inclusive pad on the box, in degrees (~0.1 mm). The cap formula is exact in
 * real arithmetic, so a point dead on the circle lands on the boundary to
 * within an ulp — and `lat BETWEEN min AND max` in SQL is an exact float
 * compare that can then fall either way. Pad so the boundary case is always
 * kept; the haversine pass removes anything that does not belong.
 */
const EPS_DEG = 1e-9;
