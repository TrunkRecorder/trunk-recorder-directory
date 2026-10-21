// The Worker itself: routing between the API and the website, rate limits, errors —
// with a D1 stand-in (on SQLite, through the d1() adapter the Worker uses).

import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { type Env } from "../src/worker.ts";
import type { Db } from "../src/db.ts";
import { fccSqlite, sqlite } from "../src/sqlite.ts";
import { obs, p25Site, recorder, TOKEN } from "./helpers.ts";

/** D1's prepare/bind/all/batch, on SQLite. */
function fakeD1(db: Db = sqlite()) {
  const stmt = (sql: string, params: unknown[] = []): any => ({
    sql,
    params,
    bind: (...p: unknown[]) => stmt(sql, p),
    all: async () => ({ results: await db.all(sql, params) }),
  });
  return {
    raw: db,
    d1: { prepare: (sql: string) => stmt(sql), batch: async (s: any[]) => void (await db.batch(s.map((x) => ({ sql: x.sql, params: x.params })))) } as unknown as D1Database,
  };
}

function env(over: Partial<Env> = {}) {
  const put: string[] = [];
  // (As Cloudflare's assets do: index.html is served at its folder, and redirects there.)
  const files: Record<string, string> = { "/directory/": "<html>app</html>", "/directory/assets/app.js": "js" };
  let allowed = true;
  const e: Env = {
    DB: fakeD1().d1,
    OBSERVATIONS: { put: async (k: string) => void put.push(k) } as unknown as R2Bucket,
    ASSETS: {
      fetch: async (r: Request) => {
        const p = new URL(r.url).pathname;
        if (p.endsWith("/index.html")) return new Response(null, { status: 307, headers: { location: p.slice(0, -10) } });
        return new Response(files[p] ?? "missing", { status: files[p] ? 200 : 404 });
      },
    } as unknown as Fetcher,
    SHARE_LIMIT: { limit: async () => ({ success: allowed }) } as unknown as RateLimit,
    ADMIN_TOKEN: TOKEN,
    FCC_DB: fakeD1(fccSqlite()).d1,
    FCC_LIMIT: { limit: async () => ({ success: allowed }) } as unknown as RateLimit,
    ...over,
  };
  return { e, put, block: () => (allowed = false) };
}
const get = (e: Env, path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://trunkrecorder.pro${path}`, init), e);

test("/directory redirects to /directory/; other paths aren't this Worker's", async () => {
  const { e } = env();
  const r = await get(e, "/directory");
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "https://trunkrecorder.pro/directory/");
  assert.equal((await get(e, "/somewhere")).status, 404);
});

test("files are served as they are; the app's own routes get the app; a missing file is a 404", async () => {
  const { e } = env();
  assert.equal(await (await get(e, "/directory/assets/app.js")).text(), "js");
  for (const p of ["/directory/", "/directory/systems/sys_abc", "/directory/changesets/cs_x"]) {
    const r = await get(e, p);
    assert.equal(r.status, 200, `${p}: the app itself, not a redirect`);
    assert.equal(await r.text(), "<html>app</html>", p);
  }
  assert.equal((await get(e, "/directory/assets/gone.js")).status, 404);
});

test("the API through the Worker, on D1: a share kept in R2 and applied", async () => {
  const { e, put } = env();
  const s = await get(e, "/directory/api/v1/observations", { method: "POST", body: JSON.stringify(obs(recorder(), [p25Site(1, 1, 851e6)])) });
  assert.equal(s.status, 201);
  assert.equal(put.length, 1);
  const id = ((await s.json()) as any).system;
  const v = await get(e, `/directory/api/v1/systems/${id}`);
  assert.equal(((await v.json()) as any).sites.length, 1);
});

test("shares past the rate limit are 429s; reads aren't limited", async () => {
  const { e, block } = env();
  block();
  const s = await get(e, "/directory/api/v1/observations", { method: "POST", body: JSON.stringify(obs(recorder(), [p25Site(1, 1, 851e6)])) });
  assert.equal(s.status, 429);
  assert.equal((await get(e, "/directory/api/v1/meta")).status, 200);
});

test("without a rate limiter (local), shares still work", async () => {
  const { e } = env({ SHARE_LIMIT: undefined });
  assert.equal((await get(e, "/directory/api/v1/observations", { method: "POST", body: JSON.stringify(obs(recorder(), [p25Site(1, 1, 851e6)])) })).status, 201);
});

test("an unexpected failure is a JSON 500, not a crash", async () => {
  const { e } = env({ DB: { prepare: () => { throw new Error("D1 is down"); }, batch: async () => {} } as unknown as D1Database });
  const r = await get(e, "/directory/api/v1/meta");
  assert.equal(r.status, 500);
  assert.equal(((await r.json()) as any).error, "D1 is down");
});

test("/api/v1/fcc/* is the FCC lookup, on ArgusRF's database: identify, call signs, meta", async () => {
  const { e } = env();
  const id = await get(e, "/api/v1/fcc/identify", { method: "POST", body: JSON.stringify({ lat: 38.9, lon: -77.03, signals: [{ freqHz: 857_987_500 }] }) });
  assert.equal(id.status, 200);
  assert.equal(((await id.json()) as any).results[0].licenses[0].callSign, "WPXT459");
  const cs = await get(e, "/api/v1/fcc/callsigns", { method: "POST", body: JSON.stringify({ callSigns: ["KNJA391"] }) });
  assert.equal(((await cs.json()) as any).results[0].licensee, "DISTRICT OF COLUMBIA");
  assert.equal((await get(e, "/api/v1/fcc/meta")).status, 200);
  assert.equal((await get(e, "/api/v1/fcc/nothing")).status, 404);
  assert.equal((await get(e, "/api/v1/other")).status, 404, "only /api/v1/fcc/ is this Worker's");
});

test("FCC lookups past the rate limit are 429s; its meta isn't limited", async () => {
  const { e, block } = env();
  block();
  assert.equal((await get(e, "/api/v1/fcc/identify", { method: "POST", body: "{}" })).status, 429);
  assert.equal((await get(e, "/api/v1/fcc/meta")).status, 200);
});

test("an FCC database failure is a JSON 500", async () => {
  const { e } = env({ FCC_DB: { prepare: () => { throw new Error("argus is down"); }, batch: async () => {} } as unknown as D1Database });
  const r = await get(e, "/api/v1/fcc/meta");
  assert.equal(r.status, 500);
  assert.equal(((await r.json()) as any).error, "argus is down");
});
