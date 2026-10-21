// The FCC license lookup that Trunk Recorder Pro asks (moved here from
// robotastic/argusrf trp-api): on its own route, trunkrecorder.pro/api/v1/fcc/*,
// over ArgusRF's FCC ULS database (D1 `argus`, read only).
//
//   POST /api/v1/fcc/identify   which licensees hold each frequency near a point (the survey, Identify)
//   POST /api/v1/fcc/callsigns  who holds each call sign heard on the air (no location)
//   GET  /api/v1/fcc/meta       how fresh the FCC data is
//
// Requests carry the user's location: nothing here logs or keeps a body.

import type { Db } from "../db.ts";
import { lookupTransmitters, type TransmitterHit } from "./query.ts";

export const FCC_BASE = "/api/v1/fcc";

export interface IdentifyRequest {
  lat: number;
  lon: number;
  /** Search radius around lat/lon. Default 50 km, clamped to 1-150 km. */
  radiusM?: number;
  signals: { freqHz: number; widthHz?: number }[];
}

export interface License {
  callSign: string | null;
  licensee: string | null;
  serviceCode: string | null;
  serviceDesc: string | null;
  freqHz: number;
  emission: string | null;
  distanceM: number;
  bearingDeg: number;
  bearingCardinal: string;
  city: string | null;
  state: string | null;
  status: string | null;
  locationKind: string;
}

export interface IdentifyResponse {
  v: 1;
  query: { lat: number; lon: number; radiusM: number };
  results: {
    freqHz: number;
    /** True when `licenses` are lapsed ones: who *was* here, not who is. */
    historical: boolean;
    licenses: License[];
  }[];
}

/** An active license's holder, by its call sign. Call signs not found (or only lapsed) are left out. */
export interface CallSignsResponse {
  v: 1;
  results: { callSign: string; licensee: string | null; serviceCode: string | null; serviceDesc: string | null; status: string | null; city: string | null; state: string | null }[];
}

const MAX_SIGNALS = 64;
const MAX_CALL_SIGNS = 64;
const CALL_SIGN = /^[A-Z0-9]{3,8}$/;
const DEFAULT_RADIUS_M = 50_000;
const MIN_RADIUS_M = 1_000;
const MAX_RADIUS_M = 150_000;
const DEFAULT_WIDTH_HZ = 12_500;
const MAX_WIDTH_HZ = 1_000_000;
const PER_SIGNAL_LIMIT = 5;
/** Rows fetched per license returned, before collapsing them by call sign. */
const SCAN_FACTOR = 8;
/** Survey frequencies come from an uncalibrated SDR; allow a flat slop. */
const TOLERANCE_HZ = 2_500;

class BadRequest extends Error {}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Validate and normalise the body; throws BadRequest with a message for the caller. */
function parseIdentify(body: unknown) {
  if (typeof body !== "object" || body === null) throw new BadRequest("body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (!isNum(b.lat) || b.lat < -90 || b.lat > 90) throw new BadRequest("lat must be a number in [-90, 90]");
  if (!isNum(b.lon) || b.lon < -180 || b.lon > 180) throw new BadRequest("lon must be a number in [-180, 180]");
  if (b.radiusM !== undefined && !isNum(b.radiusM)) throw new BadRequest("radiusM must be a number");
  const radiusM = clamp((b.radiusM as number | undefined) ?? DEFAULT_RADIUS_M, MIN_RADIUS_M, MAX_RADIUS_M);
  if (!Array.isArray(b.signals) || b.signals.length === 0) throw new BadRequest("signals must be a non-empty array");
  if (b.signals.length > MAX_SIGNALS) throw new BadRequest(`at most ${MAX_SIGNALS} signals per request`);
  const signals = b.signals.map((s: unknown) => {
    const o = (typeof s === "object" && s !== null ? s : {}) as Record<string, unknown>;
    if (!isNum(o.freqHz) || o.freqHz <= 0) throw new BadRequest("each signal needs a positive freqHz");
    if (o.widthHz !== undefined && !isNum(o.widthHz)) throw new BadRequest("widthHz must be a number");
    return { freqHz: o.freqHz, widthHz: clamp((o.widthHz as number | undefined) ?? DEFAULT_WIDTH_HZ, 0, MAX_WIDTH_HZ) };
  });
  return { lat: b.lat, lon: b.lon, radiusM, signals };
}

/** Each call sign once, at its nearest site (the rows come nearest first), up to PER_SIGNAL_LIMIT. */
export function nearestPerCallSign(rows: License[]): License[] {
  const seen = new Set<string>();
  const out: License[] = [];
  for (const l of rows) {
    const key = l.callSign ?? `${l.licensee}|${l.distanceM}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
    if (out.length === PER_SIGNAL_LIMIT) break;
  }
  return out;
}

function toLicense(t: TransmitterHit): License {
  return {
    callSign: t.call_sign ?? null,
    licensee: t.licensee_name ?? null,
    serviceCode: t.radio_service_code ?? null,
    serviceDesc: t.radio_service_desc ?? null,
    freqHz: t.freq_center_hz,
    emission: t.emission_designator ?? null,
    distanceM: Math.round(t.distance_m),
    bearingDeg: Math.round(t.bearing_deg),
    bearingCardinal: t.bearing_cardinal,
    city: t.location_city ?? null,
    state: t.location_state ?? null,
    status: t.license_status ?? null,
    locationKind: t.location_kind,
  };
}

async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new BadRequest("invalid JSON");
  }
}

async function identify(db: Db, request: Request): Promise<Response> {
  const req = parseIdentify(await body(request));
  const { lat, lon, radiusM } = req;
  const results: IdentifyResponse["results"] = [];
  // One indexed range scan each (at most 64): D1 is fine with that, in order.
  for (const s of req.signals) {
    const r = await lookupTransmitters(db, {
      freqLoHz: s.freqHz - s.widthHz / 2,
      freqHiHz: s.freqHz + s.widthHz / 2,
      lat,
      lon,
      radiusM,
      // A license has a row per site, antenna and emission: enough rows that
      // one license's many sites don't crowd out the next licensee.
      limit: PER_SIGNAL_LIMIT * SCAN_FACTOR,
      toleranceHz: TOLERANCE_HZ,
    });
    results.push({ freqHz: s.freqHz, historical: r.historical, licenses: nearestPerCallSign(r.transmitters.map(toLicense)) });
  }
  return json({ v: 1, query: { lat, lon, radiusM }, results } satisfies IdentifyResponse);
}

async function callSigns(db: Db, request: Request): Promise<Response> {
  const b = (await body(request)) as { callSigns?: unknown };
  if (!Array.isArray(b?.callSigns) || b.callSigns.length === 0) throw new BadRequest("callSigns must be a non-empty array");
  if (b.callSigns.length > MAX_CALL_SIGNS) throw new BadRequest(`at most ${MAX_CALL_SIGNS} callSigns`);
  const calls = [...new Set(b.callSigns.map((c) => (typeof c === "string" ? c.trim().toUpperCase() : "")))];
  if (!calls.every((c) => CALL_SIGN.test(c))) throw new BadRequest("each call sign must be 3-8 letters and digits");
  // Active licenses only: idx_tx_call makes this an index lookup (the
  // inactive table has no call sign index, and is too big to scan on D1).
  const rows = await db.all<Record<string, string | null>>(
    `SELECT t.call_sign, t.licensee_name, t.radio_service_code, rs.description AS radio_service_desc,
            t.license_status, t.location_city, t.location_state
       FROM transmitter t LEFT JOIN radio_service rs ON rs.code = t.radio_service_code
      WHERE t.call_sign IN (${calls.map(() => "?").join(", ")})
      GROUP BY t.call_sign`,
    calls,
  );
  return json({
    v: 1,
    results: rows.map((r) => ({
      callSign: r.call_sign as string,
      licensee: r.licensee_name ?? null,
      serviceCode: r.radio_service_code ?? null,
      serviceDesc: r.radio_service_desc ?? null,
      status: r.license_status ?? null,
      city: r.location_city ?? null,
      state: r.location_state ?? null,
    })),
  } satisfies CallSignsResponse);
}

/** How fresh the data is. (`transmitters`: the highest row id, cheaply; COUNT(*) would read 1.7M rows on D1.) */
async function meta(db: Db): Promise<Response> {
  const [src] = await db.all<{ d: string | null; files: number }>("SELECT MAX(COALESCE(fcc_published_at, downloaded_at)) AS d, COUNT(*) AS files FROM source_file");
  const [tx] = await db.all<{ n: number | null }>("SELECT MAX(id) AS n FROM transmitter");
  return json({ v: 1, dataDate: src?.d ?? null, files: src?.files ?? 0, transmitters: tx?.n ?? 0 }, 200, "public, max-age=3600");
}

/** The FCC routes; null for a path that isn't one. */
export async function handleFcc(db: Db, request: Request): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const post = (f: (db: Db, r: Request) => Promise<Response>) => (request.method === "POST" ? f(db, request) : json({ error: "method not allowed" }, 405));
  try {
    if (request.method === "OPTIONS" && path.startsWith(`${FCC_BASE}/`)) {
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" } });
    }
    if (path === `${FCC_BASE}/identify`) return await post(identify);
    if (path === `${FCC_BASE}/callsigns`) return await post(callSigns);
    if (path === `${FCC_BASE}/meta`) return request.method === "GET" ? await meta(db) : json({ error: "method not allowed" }, 405);
    return null;
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    throw e;
  }
}

export function json(body: unknown, status = 200, cache = "no-store"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": cache },
  });
}
