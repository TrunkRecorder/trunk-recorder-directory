// The FCC license lookup (moved from robotastic/argusrf trp-api; the same
// tests), on ArgusRF's schema: synthetic licenses for the rules, and the real
// rows of the fixture for what TRP asks of it.

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleFcc, nearestPerCallSign, type CallSignsResponse, type IdentifyResponse } from "../src/fcc/api.ts";
import { boundingBox, haversineMetres, lookupTransmitters, toleranceHz } from "../src/fcc/query.ts";
import { fccSqlite } from "../src/sqlite.ts";
import type { Db } from "../src/db.ts";

// A tiny database on the real schema, with made-up licenses.
const raw = new Database(":memory:");
let queries: unknown[][] = [];
const db: Db = {
  async all<T>(sql: string, params: unknown[] = []) {
    queries.push(params);
    return raw.prepare(sql).all(...(params as never[])) as T[];
  },
  async batch() {},
};

function insert(table: string, o: { call: string; name: string; hz: number; lat: number; lon: number; status: string }) {
  raw.prepare(
    `INSERT INTO ${table} (source, call_sign, freq_center_hz, freq_lower_hz, freq_upper_hz, emission_designator,
        lat, lon, location_kind, location_confidence, location_city, location_state, licensee_name,
        radio_service_code, license_status)
     VALUES ('uls', ?, ?, ?, ?, '11K0F1E', ?, ?, 'fixed', 'exact', 'WASHINGTON', 'DC', ?, 'YG', ?)`,
  ).run(o.call, o.hz, o.hz - 6_250, o.hz + 6_250, o.lat, o.lon, o.name, o.status);
}

before(() => {
  raw.exec(readFileSync(join(import.meta.dirname, "..", "src", "fcc", "schema.sql"), "utf8"));
  raw.prepare(`INSERT INTO radio_service (code, description) VALUES ('YG', 'Industrial/Business Pool, Trunked')`).run();
  raw.prepare(`INSERT INTO source_file (filename, url, sha256, downloaded_at, fcc_published_at) VALUES ('a.zip', 'u', 's', '2026-09-01', '2026-08-30')`).run();
  raw.prepare(`INSERT INTO source_file (filename, url, sha256, downloaded_at, fcc_published_at) VALUES ('b.zip', 'u', 's', '2026-09-02', NULL)`).run();
  // Two active licenses on one channel: nearer one in DC, farther one ~30 km out.
  insert("transmitter", { call: "WQXY123", name: "DISTRICT OF COLUMBIA", hz: 857_987_500, lat: 38.9, lon: -77.03, status: "A" });
  insert("transmitter", { call: "WQXY124", name: "PRINCE GEORGES COUNTY", hz: 857_987_500, lat: 39.15, lon: -77.03, status: "A" });
  // Far away (Los Angeles): outside any allowed radius.
  insert("transmitter", { call: "WQAA001", name: "CITY OF LOS ANGELES", hz: 857_987_500, lat: 34.05, lon: -118.24, status: "A" });
  // One license with six sites on 854.2375, and a second licensee farther out than all of them.
  for (let i = 0; i < 6; i++) insert("transmitter", { call: "WMANY01", name: "BIG COUNTY", hz: 854_237_500, lat: 38.9 + i * 0.01, lon: -77.03, status: "A" });
  insert("transmitter", { call: "WOTHER1", name: "OTHER CITY", hz: 854_237_500, lat: 39.2, lon: -77.03, status: "A" });
  // Lapsed only, on another channel.
  insert("transmitter_inactive", { call: "KAAA999", name: "OLD PAGING CO", hz: 931_337_500, lat: 38.95, lon: -77.0, status: "C" });
});

const post = (path: string, body: unknown, raw = false) =>
  handleFcc(db, new Request(`http://x/api/v1/fcc/${path}`, { method: "POST", body: raw ? (body as string) : JSON.stringify(body) })).then((r) => r!);

describe("POST /api/v1/fcc/identify", () => {
  it("names each call sign once, at its nearest site, so other licensees still show", async () => {
    const body = (await (await post("identify", { lat: 38.9, lon: -77.03, radiusM: 50_000, signals: [{ freqHz: 854_237_500 }] })).json()) as IdentifyResponse;
    assert.deepEqual(body.results[0].licenses.map((l) => l.callSign), ["WMANY01", "WOTHER1"]);
    assert.equal(body.results[0].licenses[0].distanceM, 0);
  });

  it("returns active matches nearest first with mapped fields", async () => {
    const res = await post("identify", { lat: 38.9, lon: -77.03, radiusM: 50_000, signals: [{ freqHz: 857_987_500 }] });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as IdentifyResponse;
    assert.deepEqual(body.query, { lat: 38.9, lon: -77.03, radiusM: 50_000 });
    const [r] = body.results;
    assert.equal(r.historical, false);
    assert.deepEqual(r.licenses.map((l) => l.callSign), ["WQXY123", "WQXY124"]);
    const first = r.licenses[0];
    assert.deepEqual(
      [first.licensee, first.serviceCode, first.serviceDesc, first.freqHz, first.emission, first.distanceM, first.city, first.state, first.status, first.locationKind],
      ["DISTRICT OF COLUMBIA", "YG", "Industrial/Business Pool, Trunked", 857_987_500, "11K0F1E", 0, "WASHINGTON", "DC", "A", "fixed"],
    );
    assert.equal(r.licenses[1].bearingCardinal, "N");
  });

  it("excludes licenses outside the radius", async () => {
    const body = (await (await post("identify", { lat: 38.9, lon: -77.03, radiusM: 5_000, signals: [{ freqHz: 857_987_500 }] })).json()) as IdentifyResponse;
    assert.deepEqual(body.results[0].licenses.map((l) => l.callSign), ["WQXY123"]);
  });

  it("falls back to lapsed licenses, flagged historical", async () => {
    const body = (await (await post("identify", { lat: 38.9, lon: -77.03, signals: [{ freqHz: 931_337_500 }] })).json()) as IdentifyResponse;
    assert.equal(body.results[0].historical, true);
    assert.equal(body.results[0].licenses[0].callSign, "KAAA999");
  });

  it("defaults the radius to 50 km and clamps it to 1–150 km", async () => {
    const at = async (radiusM?: number) => ((await (await post("identify", { lat: 38.9, lon: -77.03, radiusM, signals: [{ freqHz: 857_987_500 }] })).json()) as IdentifyResponse).query.radiusM;
    assert.deepEqual([await at(), await at(10), await at(9e9)], [50_000, 1_000, 150_000]);
    // And reaches the query's bounding box.
    queries = [];
    await post("identify", { lat: 38.9, lon: -77.03, radiusM: 9e9, signals: [{ freqHz: 857_987_500 }] });
    const bb = boundingBox(38.9, -77.03, 150_000);
    assert.ok(queries[0].some((v) => typeof v === "number" && Math.abs(v - bb.minLat) < 1e-9), JSON.stringify(queries[0]));
  });

  it("clamps a signal's width", async () => {
    queries = [];
    await post("identify", { lat: 38.9, lon: -77.03, signals: [{ freqHz: 857_987_500, widthHz: 9e12 }] });
    assert.equal(queries[0][1], 857_987_500 + 500_000 + 2_500, "hi = freq + 1 MHz / 2 + tolerance");
  });

  it("takes 64 signals, refuses 65", async () => {
    const signals = (n: number) => Array.from({ length: n }, () => ({ freqHz: 857_987_500 }));
    assert.equal((await post("identify", { lat: 38.9, lon: -77.03, signals: signals(64) })).status, 200);
    assert.equal((await post("identify", { lat: 38.9, lon: -77.03, signals: signals(65) })).status, 400);
  });

  it("refuses a bad location, bad signals and invalid JSON; GET isn't allowed", async () => {
    for (const b of [{ lat: 91, lon: 0, signals: [{ freqHz: 1 }] }, { lat: 0, lon: 181, signals: [{ freqHz: 1 }] }, { lat: 0, lon: 0, signals: [] }, { lat: 0, lon: 0, signals: [{ freqHz: -5 }] }, { lat: 0, lon: 0, signals: [{ freqHz: 1, widthHz: "x" }] }, { lat: 0, lon: 0, radiusM: "x", signals: [{ freqHz: 1 }] }, null]) {
      assert.equal((await post("identify", b)).status, 400, JSON.stringify(b));
    }
    assert.equal((await post("identify", "{", true)).status, 400);
    assert.equal((await handleFcc(db, new Request("http://x/api/v1/fcc/identify")))!.status, 405);
  });
});

describe("POST /api/v1/fcc/callsigns", () => {
  it("names each active call sign once (any case); unknown and lapsed ones are left out", async () => {
    const body = (await (await post("callsigns", { callSigns: ["wqxy123", "WMANY01", "KAAA999", "NOPE99"] })).json()) as CallSignsResponse;
    assert.deepEqual(body.results.map((r) => [r.callSign, r.licensee]).sort(), [["WMANY01", "BIG COUNTY"], ["WQXY123", "DISTRICT OF COLUMBIA"]]);
  });

  it("refuses what isn't a list of call signs", async () => {
    for (const b of [{ callSigns: [] }, { callSigns: ["W1; DROP TABLE"] }, { callSigns: Array.from({ length: 65 }, (_, i) => `W${i}AB`) }, {}]) {
      assert.equal((await post("callsigns", b)).status, 400, JSON.stringify(b).slice(0, 40));
    }
    assert.equal((await post("callsigns", "{", true)).status, 400);
    assert.equal((await handleFcc(db, new Request("http://x/api/v1/fcc/callsigns")))!.status, 405);
  });
});

describe("GET /api/v1/fcc/meta", () => {
  it("reports the data date, cheaply, and caches", async () => {
    const r = await handleFcc(db, new Request("http://x/api/v1/fcc/meta"));
    assert.deepEqual(await r!.json(), { v: 1, dataDate: "2026-09-02", files: 2, transmitters: 10 });
    assert.match(r!.headers.get("cache-control")!, /max-age=3600/);
  });
});

describe("the FCC routes", () => {
  it("preflight; paths that aren't theirs are null (the Worker's 404)", async () => {
    assert.equal((await handleFcc(db, new Request("http://x/api/v1/fcc/identify", { method: "OPTIONS" })))!.status, 204);
    assert.equal(await handleFcc(db, new Request("http://x/api/v1/fcc/nothing")), null);
  });
});

describe("the copied query code", () => {
  it("tolerance scales with frequency above its floor; distances are great-circle", () => {
    assert.equal(toleranceHz(150e6), 3_000);
    assert.equal(toleranceHz(50e6), 2_500);
    const km = haversineMetres(38.9, -77.03, 39.74, -104.99) / 1000;
    assert.ok(km > 2390 && km < 2420, `${km}`);
  });

  it("nearestPerCallSign keeps the first of each call sign, up to 5", () => {
    const l = (c: string, d: number) => ({ callSign: c, distanceM: d }) as never;
    assert.deepEqual(nearestPerCallSign([l("A", 1), l("A", 2), l("B", 3), l("C", 4), l("D", 5), l("E", 6), l("F", 7)]).map((x: any) => x.callSign), ["A", "B", "C", "D", "E"]);
  });
});

describe("the fixture: real licenses, as production has them", () => {
  const real = fccSqlite();
  it("DC Fire and EMS, WMATA and Arlington near DC; DC's call signs by name", async () => {
    const r = await lookupTransmitters(real, { freqLoHz: 857_987_500, freqHiHz: 857_987_500, lat: 38.9, lon: -77.03, radiusM: 50_000, limit: 10, toleranceHz: 2500 });
    assert.equal(r.transmitters[0].call_sign, "WPXT459");
    const id = (await (await handleFcc(real, new Request("http://x/api/v1/fcc/identify", { method: "POST", body: JSON.stringify({ lat: 38.9, lon: -77.03, signals: [{ freqHz: 489_087_500 }, { freqHz: 860_437_500 }] }) })))!.json()) as IdentifyResponse;
    assert.equal(id.results[0].licenses[0].licensee, "Washington Metropolitan Area Transit Authority");
    assert.equal(id.results[1].licenses[0].callSign, "KNIQ704");
    const cs = (await (await handleFcc(real, new Request("http://x/api/v1/fcc/callsigns", { method: "POST", body: JSON.stringify({ callSigns: ["KNJA391", "KNJE616"] }) })))!.json()) as CallSignsResponse;
    assert.deepEqual(cs.results.map((x) => x.licensee), ["DISTRICT OF COLUMBIA", "DISTRICT OF COLUMBIA"]);
  });
  it("has the columns the lookup reads (a check against ArgusRF's schema changing under the copy)", () => {
    const cols = new Set((real.raw.prepare("PRAGMA table_info(transmitter)").all() as { name: string }[]).map((c) => c.name));
    for (const c of ["call_sign", "freq_center_hz", "freq_lower_hz", "freq_upper_hz", "lat", "lon", "location_kind", "area_radius_m", "licensee_name", "radio_service_code", "license_status", "location_city", "location_state", "emission_designator"]) assert.ok(cols.has(c), c);
  });
});
