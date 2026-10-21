// The API's surface: methods, statuses, headers, auth, limits.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, handle } from "../src/api.ts";
import { sqlite } from "../src/sqlite.ts";
import { directory, obs, p25Site, recorder, TOKEN } from "./helpers.ts";

const env = () => ({ db: sqlite(), adminToken: TOKEN, putObservation: async () => {} });
const req = (method: string, path: string, init: RequestInit = {}) => new Request(`http://x${BASE}${path}`, { method, ...init });

test("CORS: preflight answered; reads and errors say any origin may", async () => {
  const e = env();
  const pre = await handle(e, req("OPTIONS", "/observations"));
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.match(pre.headers.get("access-control-allow-methods")!, /POST/);
  const r = await handle(e, req("GET", "/meta"));
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.equal((await handle(e, req("GET", "/nope"))).headers.get("access-control-allow-origin"), "*");
});

test("reads cache briefly; errors and moderation views don't", async () => {
  const e = env();
  assert.match((await handle(e, req("GET", "/meta"))).headers.get("cache-control")!, /max-age=60/);
  assert.equal((await handle(e, req("GET", "/systems/sys_nope000000"))).headers.get("cache-control"), "no-store");
  assert.equal((await handle(e, req("GET", "/merge-proposals"))).headers.get("cache-control"), "no-store");
});

test("a system's version is its ETag", async () => {
  const d = directory();
  const a = await d.share(obs(recorder(), [p25Site(1, 1, 851e6)]));
  const r = await d.get(`/systems/${a.json.system}`);
  assert.equal(r.headers.get("etag"), `"${a.json.system}.${a.json.rev}"`);
  assert.equal((await d.get(`/systems/${a.json.system}/config`)).headers.get("etag"), `"${a.json.system}.${a.json.rev}"`);
});

test("unknown paths and IDs are 404s; malformed IDs don't reach the database", async () => {
  const e = env();
  for (const p of ["/", "/systems/sys_nope000000", "/systems/sys_nope000000/talkgroups", "/systems/sys_nope000000/config", "/changesets/cs_nope000000", "/systems/NOT_AN_ID", "/systems/sys_x'--"]) {
    assert.equal((await handle(e, req("GET", p))).status, 404, p);
  }
});

test("a share: 201 with what it was matched to; bad JSON, a bad shape and a too-big body are 400s", async () => {
  const e = env();
  const ok = await handle(e, req("POST", "/observations", { body: JSON.stringify(obs(recorder(), [p25Site(1, 1, 851e6)])) }));
  assert.equal(ok.status, 201);
  const j = (await ok.json()) as any;
  assert.match(j.observation, /^obs_/);
  assert.match(j.system, /^sys_/);
  assert.match(j.sites[0], /^site_/);
  assert.equal((await handle(e, req("POST", "/observations", { body: "{" }))).status, 400);
  assert.equal((await handle(e, req("POST", "/observations", { body: JSON.stringify({ v: 1 }) }))).status, 400);
  assert.equal((await handle(e, req("POST", "/observations", { body: "x".repeat(5 << 20) }))).status, 400);
});

test("a quarantined recorder's share is answered as if taken (202), and not applied", async () => {
  const d = directory();
  const r = recorder();
  await d.post("/quarantine", { actor: r, reason: "spam" });
  const s = await d.share(obs(r, [p25Site(1, 1, 851e6)]));
  assert.equal(s.status, 202);
  assert.equal((await d.get("/meta")).json.systems, 0);
  assert.equal((await d.db.all<any>("SELECT status FROM observations"))[0].status, "quarantined");
  // Let out again: its next share counts.
  assert.equal((await d.del(`/quarantine/${r}`)).status, 200);
  assert.equal((await d.share(obs(r, [p25Site(1, 1, 851e6)]))).status, 201);
});

test("moderation needs the token: none, a wrong one, or one of another length are refused", async () => {
  const e = env();
  const paths: [string, string][] = [["POST", "/merges"], ["POST", "/locks"], ["POST", "/quarantine"], ["POST", "/changesets/cs_x0000000000/revert"], ["POST", "/systems/sys_x0000000000/hide"], ["DELETE", "/quarantine/r_0000000000"]];
  for (const [m, p] of paths) {
    for (const auth of [undefined, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}X`, `Basic ${TOKEN}`]) {
      const r = await handle(e, req(m, p, { body: "{}", headers: auth ? { authorization: auth } : {} }));
      assert.equal(r.status, 401, `${m} ${p} ${auth}`);
    }
  }
  // No token configured: nobody is admin.
  const open = { ...env(), adminToken: undefined };
  assert.equal((await handle(open, req("POST", "/quarantine", { body: "{}", headers: { authorization: "Bearer " } }))).status, 401);
});

test("moderation input is checked", async () => {
  const d = directory();
  assert.equal((await d.post("/merges", {})).status, 400);
  assert.equal((await d.post("/locks", { id: "sys_x0000000000" })).status, 400);
  assert.equal((await d.post("/locks", { id: "lic_x0000000000", field: "x", value: "y" })).status, 400, "only systems, sites and talkgroups");
  assert.equal((await d.post("/quarantine", {})).status, 400);
});

test("identify: what an identity heard on the air is, by its claim", async () => {
  const d = directory();
  const a = await d.share(obs(recorder(), [p25Site(1, 3, 851e6)]));
  const m = (await d.get("/identify?claim=p25:BEE01.3A9/1.3")).json.matches;
  assert.deepEqual(m.map((x: any) => [x.kind, x.id]), [["site", a.json.sites[0]]]);
  assert.equal((await d.get("/identify?claim=p25:bee01.3a9")).json.matches[0].id, a.json.system);
  assert.equal((await d.get("/identify")).status, 400);
});

test("meta counts what's there", async () => {
  const d = directory();
  await d.share(obs(recorder(), [p25Site(1, 1, 851e6)], { talkgroups: [{ number: 1, alpha: "x" }] }));
  const m = (await d.get("/meta")).json;
  assert.deepEqual([m.v, m.systems, m.sites, m.talkgroups, m.shares], [1, 1, 1, 1, 1]);
});

test("a system's candidates: only fields with a disagreement", async () => {
  const d = directory();
  const a = await d.share(obs(recorder(), [p25Site(1, 1, 851e6)], { talkgroups: [{ number: 1, alpha: "A", tag: "Law" }] }));
  await d.share(obs(recorder(), [p25Site(1, 1, 851e6)], { talkgroups: [{ number: 1, alpha: "B", tag: "Law" }] }));
  const c = (await d.get(`/systems/${a.json.system}/candidates`)).json.candidates;
  const only = Object.values(c)[0] as any;
  assert.deepEqual(Object.keys(only), ["alpha"]);
});
