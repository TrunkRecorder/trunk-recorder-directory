// Reading: versions, diffs, search, near, talkgroups for part of a system, TRP's config.

import assert from "node:assert/strict";
import { test } from "node:test";
import { talkgroupsCsv, trpSystem } from "../src/read.ts";
import { DC, DENVER, directory, obs, p25Site, recorder } from "./helpers.ts";

test("any version reads as it was: sites, talkgroups and licenses", async () => {
  const d = directory();
  const s = p25Site(1, 1, 851e6);
  const a = await d.share(obs(recorder(), [s], { talkgroups: [{ number: 1, alpha: "One" }], system: { type: "p25", name: "First", fcc: { "851000000": { callSign: "WAAA111", from: "lookup" } }, sites: [s] } }));
  const v1 = a.json.rev;
  await d.share(obs(recorder(), [p25Site(1, 2, 852e6)], { talkgroups: [{ number: 2, alpha: "Two" }] }));
  const id = a.json.system;
  const old = (await d.get(`/systems/${id}?rev=${v1}`)).json;
  assert.equal(old.rev, v1);
  assert.deepEqual(old.sites.map((x: any) => [x.rfss, x.site]), [[1, 1]]);
  assert.deepEqual(Object.keys(old.licenses), ["851000000"]);
  assert.equal(old.name, "First");
  assert.equal(old.talkgroupCount, 1);
  assert.deepEqual((await d.get(`/systems/${id}/talkgroups?rev=${v1}`)).json.talkgroups.map((t: any) => t.number), [1]);
  // A version past now is now.
  assert.equal((await d.get(`/systems/${id}?rev=999`)).json.sites.length, 2);
});

test("a diff: sites and talkgroups added, removed, changed; the name", async () => {
  const d = directory();
  const a = await d.share(obs(recorder(), [p25Site(1, 1, 851e6)], { talkgroups: [{ number: 1, alpha: "One" }] }));
  const id = a.json.system;
  await d.share(obs(recorder(), [p25Site(1, 2, 852e6)], { talkgroups: [{ number: 2, alpha: "Two" }] }));
  const now = (await d.get(`/systems/${id}`)).json.rev;
  const df = (await d.get(`/systems/${id}/diff?from=${a.json.rev}&to=${now}`)).json;
  assert.deepEqual(df.sites.added.map((s: any) => [s.rfss, s.site]), [[1, 2]]);
  assert.deepEqual(df.talkgroups.added.map((t: any) => t.number), [2]);
  assert.deepEqual(df.talkgroups.removed, []);
  assert.equal(df.name, null);
  assert.equal((await d.get(`/systems/${id}/diff?from=1`)).status, 400);
});

test("search: a frequency exactly or by prefix, words with prefixes, nothing for nothing", async () => {
  const d = directory();
  const a = await d.share(obs(recorder(), [p25Site(1, 1, 857_987_500)], { talkgroups: [{ number: 716, alpha: "Engine 16 Tac", tag: "Fire-Tac" }] }));
  const id = a.json.system;
  assert.deepEqual((await d.get("/search?q=857.9875")).json.hits.map((h: any) => h.label), ["857.98750 MHz (control)"]);
  assert.equal((await d.get("/search?q=857.9")).json.hits[0].systemId, id, "a prefix is a range");
  assert.equal((await d.get("/search?q=858.98")).json.hits.length, 1, "the voice channel");
  assert.equal((await d.get("/search?q=engi")).json.hits[0].label, "Engine 16 Tac Fire-Tac");
  assert.equal((await d.get("/search?q=fire-tac")).json.hits.length, 1);
  assert.deepEqual((await d.get("/search?q=")).json.hits, []);
  assert.deepEqual((await d.get('/search?q="*(')).json.hits, [], "FTS syntax is neutralised");
  assert.deepEqual((await d.get("/search?q=716")).json.hits, [], "a bare number needs a system");
});

test("near: by radius, cells, and only systems shown (merged and hidden ones aren't)", async () => {
  const d = directory();
  const dc = await d.share(obs(recorder(), [p25Site(1, 1, 851e6)], { cell: DC }));
  const den = await d.share(obs(recorder(), [p25Site(1, 1, 851e6, { wacn: 0xbee03 })], { cell: DENVER }));
  assert.deepEqual((await d.get(`/systems?cell=${DC}&radiusKm=10`)).json.systems.map((s: any) => s.id), [dc.json.system]);
  assert.deepEqual((await d.get(`/systems?lat=39.74&lon=-104.99&radiusKm=10`)).json.systems.map((s: any) => s.id), [den.json.system]);
  assert.deepEqual((await d.get(`/systems?lat=0&lon=0&radiusKm=50`)).json.systems, []);
  assert.deepEqual((await d.get(`/systems`)).json.systems, [], "no place: nothing");
  await d.post(`/systems/${dc.json.system}/hide`, {});
  assert.deepEqual((await d.get(`/systems?cell=${DC}&radiusKm=10`)).json.systems, []);
});

test("talkgroups for part of a system: heard at those sites, everywhere, or nowhere yet", async () => {
  const d = directory();
  const a = await d.share(obs(recorder(), [p25Site(1, 1, 851e6), p25Site(1, 2, 852e6)], {
    talkgroups: [{ number: 1, alpha: "North" }, { number: 2, alpha: "South" }, { number: 3, alpha: "Both" }, { number: 4, alpha: "Unheard" }],
    heardTalkgroups: [{ number: 1, grants: 1, sites: [0] }, { number: 2, grants: 1, sites: [1] }, { number: 3, grants: 1, sites: [0, 1] }],
  }));
  const [north, south] = a.json.sites;
  const pick = async (sites: string) => (await d.get(`/systems/${a.json.system}/talkgroups?sites=${sites}`)).json.talkgroups.map((t: any) => t.number);
  assert.deepEqual(await pick(north), [1, 3, 4]);
  assert.deepEqual(await pick(south), [2, 3, 4]);
  const cfg = (await d.get(`/systems/${a.json.system}/config?sites=${south}`)).json;
  assert.deepEqual(cfg.system.sites.map((s: any) => s.directoryId), [south]);
  assert.match(cfg.talkgroupsCsv, /^Decimal.*\n2,.*\n3,.*\n4,/s);
});

test("TRP's config: modulation it knows, band plan in its terms, licenses not the user's own", () => {
  const sys = {
    id: "sys_x", rev: 3, type: "smartnet", name: "Big County!", wacn: null, sysId: 0x1234, status: "active", mergedInto: null, lat: null, lon: null, createdAt: 0, updatedAt: 0, talkgroupCount: 0,
    licenses: { "851000000": { callSign: "WAAA111", name: "", source: "user" }, "852000000": { callSign: "WBBB222", name: "B", source: "air" } },
    sites: [
      { id: "site_a", name: "", rfss: null, site: null, nac: null, status: "heard", modulation: "fm", bandplan: { bandplan: "800_reband" }, lat: null, lon: null, controlChannelsHz: [851e6], voiceChannelsHz: [], neighbours: [], firstHeard: 0, lastHeard: 0, heardCells: 0 },
      { id: "site_b", name: "", rfss: null, site: null, nac: null, status: "retired", modulation: "qpsk", bandplan: null, lat: null, lon: null, controlChannelsHz: [852e6], voiceChannelsHz: [], neighbours: [], firstHeard: 0, lastHeard: 0, heardCells: 0 },
    ],
  } as never;
  const c = trpSystem(sys) as any;
  assert.equal(c.shortName, "big-county");
  assert.deepEqual(c.sites.map((s: any) => s.directoryId), ["site_a"], "retired sites aren't added");
  assert.equal(c.sites[0].modulation, "auto");
  assert.equal(c.sites[0].bandplan, "800_reband");
  assert.deepEqual(c.sites[0].expect, { sysId: 0x1234 });
  assert.deepEqual(c.fcc["851000000"], { callSign: "WAAA111", from: "lookup" });
  assert.deepEqual(c.fcc["852000000"], { callSign: "WBBB222", name: "B", from: "air" });
});

test("the talkgroup CSV quotes what needs it", () => {
  const csv = talkgroupsCsv([{ number: 10, alpha: 'A, "b"', description: "line\nbreak", mode: "", tag: "", category: "", priority: "", status: "active" } as never]);
  assert.equal(csv, 'Decimal,Hex,Alpha Tag,Mode,Description,Tag,Category,Priority\n10,a,"A, ""b""",D,"line\nbreak",,,\n');
});
