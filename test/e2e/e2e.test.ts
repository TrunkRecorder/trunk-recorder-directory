// The directory end to end, over HTTP, against a running Worker: `wrangler
// dev` offline (npm run test:local), staging (npm run test:staging) or
// production (npm run test:production). scripts/e2e.ts sets these:
//
//   E2E_BASE_URL       where it runs (https://trunkrecorder.pro, http://127.0.0.1:8799…)
//   E2E_WRITE=1        also share, merge, revert… (never against production by default)
//   E2E_ADMIN_TOKEN    the target's ADMIN_TOKEN (writes clean up with it)
//   E2E_LANDING=1      the domain's root is the landing page, not this Worker
//
// Writes use identities made up for the run (a random WACN), and hide what
// they made at the end, so they can run again and again against one database.

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { latLngToCell } from "h3-js";

const BASE = (process.env.E2E_BASE_URL ?? "").replace(/\/+$/, "");
const WRITE = process.env.E2E_WRITE === "1";
const TOKEN = process.env.E2E_ADMIN_TOKEN ?? "";
const API = `${BASE}/directory/api/v1`;
if (!BASE) throw new Error("E2E_BASE_URL is required (scripts/e2e.ts sets it)");

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
const rand = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => CROCKFORD[b & 31]).join("");
const recorder = () => `r_e2e${rand(12)}`;
/** A WACN for this run only (never the default BEE00). */
const WACN = 0xe0000 + (crypto.getRandomValues(new Uint16Array(1))[0] & 0xffff);
const DC = latLngToCell(38.9, -77.03, 6);
const FAR = latLngToCell(45.5, -122.6, 6);

async function call(method: string, path: string, body?: unknown, admin = false) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", "user-agent": "trunk-recorder-directory-e2e", ...(admin ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await r.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, headers: r.headers };
}

/** A site of made-up system `sysId` (each test its own system). */
const site = (sysId: number, rfss: number, s: number, cc: number, neighbours: [number, number, number][] = []) => ({
  controlChannelsHz: [cc],
  expect: { wacn: WACN, sysId, rfss, site: s },
  heard: {
    identity: { nac: 0x443, wacn: WACN, sysId, rfss, site: s },
    controlChannelHz: cc,
    voice: [{ freqHz: cc + 500_000, grants: 7 }],
    neighbours: neighbours.map(([r, x, f]) => ({ sysId, rfss: r, site: x, freqHz: f })),
    callSigns: [{ freqHz: cc + 1_000_000, callSign: "WE2E001" }],
  },
});
const share = (rec: string, sites: unknown[], more: Record<string, unknown> = {}) =>
  call("POST", "/observations", { v: 1, recorder: rec, app: "e2e", cell: DC, system: { type: "p25", name: `E2E ${WACN.toString(16)}`, sites }, ...more });

describe("the website", () => {
  test("/directory/ is the app", async () => {
    const r = await fetch(`${BASE}/directory/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    const html = await r.text();
    assert.match(html, /<div id="root">/);
    assert.match(html, /Systems directory/);
  });

  test("its scripts and styles load", async () => {
    const html = await (await fetch(`${BASE}/directory/`)).text();
    const assets = [...html.matchAll(/(?:src|href)="(\/directory\/assets\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(assets.length >= 2, html);
    for (const a of assets) {
      const r = await fetch(`${BASE}${a}`);
      assert.equal(r.status, 200, a);
      assert.match(r.headers.get("content-type") ?? "", /javascript|css/, a);
    }
  });

  test("the app's own routes get the app; /directory goes to /directory/", async () => {
    for (const p of ["/directory/systems/sys_00000000000", "/directory/systems/sys_00000000000/talkgroups", "/directory/changesets/cs_00000000000", "/directory/?at=38.9,-77.03"]) {
      // Served at the deep link itself: a redirect would lose the path.
      const r = await fetch(`${BASE}${p}`, { redirect: "manual" });
      assert.equal(r.status, 200, p);
      assert.match(await r.text(), /<div id="root">/, p);
    }
    const r = await fetch(`${BASE}/directory`, { redirect: "manual" });
    assert.equal(r.status, 301);
    assert.match(r.headers.get("location") ?? "", /\/directory\/$/);
  });

  test("the landing page is still the landing page", { skip: process.env.E2E_LANDING !== "1" }, async () => {
    const r = await fetch(`${BASE}/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.doesNotMatch(html, /Systems directory/);
    assert.match(html, /Trunk Recorder/);
  });
});

describe("the API, reading", () => {
  test("meta", async () => {
    const r = await call("GET", "/meta");
    assert.equal(r.status, 200);
    assert.equal(r.json.v, 1);
    assert.equal(typeof r.json.systems, "number");
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
  });

  test("near, search, identify answer; unknown things are 404s", async () => {
    assert.ok(Array.isArray((await call("GET", "/systems?lat=38.9&lon=-77.03&radiusKm=50")).json.systems));
    assert.ok(Array.isArray((await call("GET", "/search?q=857.9875")).json.hits));
    assert.ok(Array.isArray((await call("GET", "/identify?claim=p25:bee00.1")).json.matches));
    assert.equal((await call("GET", "/systems/sys_00000000000")).status, 404);
    assert.equal((await call("GET", "/changesets/cs_00000000000")).status, 404);
    assert.equal((await call("GET", "/nothing")).status, 404);
  });

  test("CORS preflight", async () => {
    const r = await fetch(`${API}/observations`, { method: "OPTIONS" });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
  });

  test("moderation without the token is refused", async () => {
    assert.equal((await call("POST", "/quarantine", { actor: "r_00000000000" })).status, 401);
    assert.equal((await call("POST", "/merges", {}, false)).status, 401);
  });

  test("a broken share is refused (and nothing is written)", async () => {
    assert.equal((await call("POST", "/observations", { v: 1 })).status, 400);
    assert.equal((await call("POST", "/observations", "{")).status, 400);
  });
});

// Real licenses: the same answers offline (the fixture is real rows), on staging and on production.
describe("the FCC lookup (/api/v1/fcc)", () => {
  const FCC = `${BASE}/api/v1/fcc`;
  const post = (path: string, body: unknown) => fetch(`${FCC}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

  test("identify: DC Fire and EMS, WMATA and Arlington County near DC, nearest first", async () => {
    const r = await post("identify", { lat: 38.9, lon: -77.03, radiusM: 50_000, signals: [{ freqHz: 857_987_500 }, { freqHz: 489_087_500 }, { freqHz: 860_437_500 }] });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    const j = (await r.json()) as any;
    assert.deepEqual(j.query, { lat: 38.9, lon: -77.03, radiusM: 50_000 });
    assert.equal(j.results[0].licenses[0].callSign, "WPXT459");
    assert.equal(j.results[0].licenses[0].licensee, "DISTRICT OF COLUMBIA");
    assert.equal(j.results[1].licenses[0].licensee, "Washington Metropolitan Area Transit Authority");
    assert.equal(j.results[2].licenses[0].callSign, "KNIQ704");
    for (const res of j.results) {
      const d = res.licenses.map((l: any) => l.distanceM);
      assert.deepEqual(d, [...d].sort((a: number, b: number) => a - b));
      assert.equal(new Set(res.licenses.map((l: any) => l.callSign)).size, res.licenses.length, "each call sign once");
    }
  });

  test("call signs heard on the air, named without a location", async () => {
    const j = (await (await post("callsigns", { callSigns: ["KNJA391", "knje616", "ZZ9ZZZZ"] })).json()) as any;
    assert.deepEqual(j.results.map((r: any) => [r.callSign, r.licensee]).sort(), [["KNJA391", "DISTRICT OF COLUMBIA"], ["KNJE616", "DISTRICT OF COLUMBIA"]]);
  });

  test("meta, errors and methods", async () => {
    const m = (await (await fetch(`${FCC}/meta`)).json()) as any;
    assert.equal(m.v, 1);
    assert.ok(m.transmitters > 0 && m.dataDate);
    assert.equal((await post("identify", { lat: 99, lon: 0, signals: [{ freqHz: 1 }] })).status, 400);
    assert.equal((await post("identify", "{")).status, 400);
    assert.equal((await fetch(`${FCC}/identify`)).status, 405);
    assert.equal((await fetch(`${FCC}/nothing`)).status, 404);
    assert.equal((await fetch(`${FCC}/identify`, { method: "OPTIONS" })).status, 204);
  });
});

describe("the API, writing", { skip: !WRITE && "E2E_WRITE isn't set (read-only run)" }, () => {
  const made = new Set<string>();
  const actors = new Set<string>();
  after(async () => {
    if (!TOKEN) return;
    for (const id of made) await call("POST", `/systems/${id}/hide`, {}, true);
  });

  test("a statewide system from two recorders, far apart; announced sites; versions; licenses", async () => {
    const a = await share(recorder(), [site(0x101, 1, 1, 851_012_500, [[1, 2, 852_012_500], [1, 3, 853_012_500]])], {
      talkgroups: [{ number: 100, alpha: "E2E Dispatch", tag: "Law Dispatch" }],
      heardTalkgroups: [{ number: 100, grants: 9, sites: [0] }],
    });
    assert.equal(a.status, 201, JSON.stringify(a.json));
    made.add(a.json.system);
    const b = await share(recorder(), [site(0x101, 1, 2, 852_012_500)], { cell: FAR, talkgroups: [{ number: 200, alpha: "E2E West" }] });
    assert.equal(b.json.system, a.json.system);
    const s = (await call("GET", `/systems/${a.json.system}`)).json;
    assert.deepEqual(s.sites.map((x: any) => [x.rfss, x.site, x.status]), [[1, 1, "heard"], [1, 2, "heard"], [1, 3, "announced"]]);
    assert.equal(s.licenses["852012500"].callSign, "WE2E001");
    assert.ok(s.rev >= 2);
    assert.equal((await call("GET", `/systems/${a.json.system}?rev=${a.json.rev}`)).json.sites.filter((x: any) => x.status === "heard").length, 1);
    const tgs = (await call("GET", `/systems/${a.json.system}/talkgroups`)).json.talkgroups;
    assert.deepEqual(tgs.map((t: any) => t.number), [100, 200]);
    const csv = await fetch(`${API}/systems/${a.json.system}/talkgroups.csv`);
    assert.match(await csv.text(), /^Decimal,Hex,Alpha Tag/);
    const cfg = (await call("GET", `/systems/${a.json.system}/config`)).json;
    assert.equal(cfg.system.directory.id, a.json.system);
    assert.equal(cfg.system.sites[0].expect.wacn, WACN);
    assert.ok((await call("GET", `/search?q=${WACN.toString(16)}.101`)).json.hits.some((h: any) => h.systemId === a.json.system));
  });

  test("names: the margin, and a lock (token)", { skip: !TOKEN && "no E2E_ADMIN_TOKEN" }, async () => {
    const r1 = recorder();
    const a = await share(r1, [site(0x102, 2, 1, 855_012_500)], { talkgroups: [{ number: 7, alpha: "Seven" }] });
    made.add(a.json.system);
    for (let i = 0; i < 3; i++) await share(recorder(), [site(0x102, 2, 1, 855_012_500)], { talkgroups: [{ number: 7, alpha: "VII" }] });
    const tg = (await call("GET", `/systems/${a.json.system}/talkgroups`)).json.talkgroups[0];
    assert.equal(tg.alpha, "VII");
    assert.deepEqual(tg.alternatives.map((x: any) => x.value), ["Seven"]);
    assert.equal((await call("POST", "/locks", { id: tg.id, field: "alpha", value: "Seven", reason: "e2e" }, true)).status, 200);
    assert.equal((await call("GET", `/systems/${a.json.system}/talkgroups`)).json.talkgroups[0].alpha, "Seven");
  });

  test("revert: a share, a version, everything a recorder did; a merge and its revert (token)", { skip: !TOKEN && "no E2E_ADMIN_TOKEN" }, async () => {
    const rec = recorder();
    actors.add(rec);
    const a = await share(recorder(), [site(0x103, 3, 1, 856_012_500)], { talkgroups: [{ number: 1, alpha: "Keep" }] });
    made.add(a.json.system);
    await share(rec, [site(0x103, 3, 1, 856_012_500)], { talkgroups: [{ number: 66, alpha: "Junk" }] });
    const r = await call("POST", `/actors/${rec}/revert`, {}, true);
    assert.equal(r.status, 200);
    assert.deepEqual((await call("GET", `/systems/${a.json.system}/talkgroups`)).json.talkgroups.map((t: any) => t.number), [1]);
    const h = (await call("GET", `/systems/${a.json.system}/history`)).json.history;
    assert.equal(h[0].kind, "revert");
    assert.equal((await call("POST", `/changesets/${h[0].changesetId}/revert`, {}, true)).status, 200);
    assert.deepEqual((await call("GET", `/systems/${a.json.system}/talkgroups`)).json.talkgroups.map((t: any) => t.number), [1, 66]);
    assert.equal((await call("POST", `/systems/${a.json.system}/revert`, { to: a.json.rev }, true)).status, 200);
    assert.deepEqual((await call("GET", `/systems/${a.json.system}/talkgroups`)).json.talkgroups.map((t: any) => t.number), [1]);
    // A second record of another made-up system, merged in and back out.
    const other = await call("POST", "/observations", { v: 1, recorder: recorder(), app: "e2e", cell: DC, system: { type: "p25", name: "", sites: [site(0x104, 4, 1, 857_012_500)] } });
    made.add(other.json.system);
    const m = await call("POST", "/merges", { a: a.json.system, b: other.json.system, why: "e2e" }, true);
    assert.equal(m.status, 200, JSON.stringify(m.json));
    assert.equal((await call("GET", `/systems/${other.json.system}`)).status, 301);
    assert.equal((await call("POST", `/changesets/${m.json.changesetId}/revert`, {}, true)).status, 200);
    assert.equal((await call("GET", `/systems/${other.json.system}`)).status, 200);
  });

  test("quarantine: a recorder's shares stop counting, then count again (token)", { skip: !TOKEN && "no E2E_ADMIN_TOKEN" }, async () => {
    const rec = recorder();
    assert.equal((await call("POST", "/quarantine", { actor: rec, reason: "e2e" }, true)).status, 200);
    assert.equal((await share(rec, [site(0x105, 5, 1, 858_012_500)])).status, 202);
    assert.equal((await call("DELETE", `/quarantine/${rec}`, undefined, true)).status, 200);
    const s = await share(rec, [site(0x105, 5, 1, 858_012_500)]);
    assert.equal(s.status, 201);
    made.add(s.json.system);
  });
});
