// Shares, in the cases that matter: identities, links, licenses, talkgroups heard, sites announced.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ARLINGTON, DC, DENVER, directory, obs, p25Site, recorder } from "./helpers.ts";

const smartnet = (sysId: number, cc: number) => ({ controlChannelsHz: [cc], expect: { sysId }, heard: { identity: { sysId }, controlChannelHz: cc } });

test("SmartNet system IDs repeat: the same one near is one system, far away another", async () => {
  const d = directory();
  const a = await d.share(obs(recorder(), [smartnet(0xbeef, 851_012_500)], { cell: DC, system: { type: "smartnet", name: "", sites: [smartnet(0xbeef, 851_012_500)] } }));
  const b = await d.share(obs(recorder(), [], { cell: ARLINGTON, system: { type: "smartnet", name: "", sites: [smartnet(0xbeef, 851_012_500)] } }));
  const c = await d.share(obs(recorder(), [], { cell: DENVER, system: { type: "smartnet", name: "", sites: [smartnet(0xbeef, 851_012_500)] } }));
  assert.equal(b.json.system, a.json.system);
  assert.notEqual(c.json.system, a.json.system);
});

test("without a location, a weak identity can't be matched: a new system each time (unless linked)", async () => {
  const d = directory();
  const bee = { wacn: 0xbee00, sysId: 0x111 };
  const a = await d.share(obs(recorder(), [p25Site(1, 1, 851e6, bee)], { cell: null }));
  const b = await d.share(obs(recorder(), [p25Site(1, 1, 851e6, bee)], { cell: null }));
  assert.notEqual(a.json.system, b.json.system);
  // Linked (TRP keeps what the directory answered): the same one.
  const c = await d.share(obs(recorder(), [p25Site(1, 1, 851e6, { ...bee, directoryId: a.json.sites[0] })], { cell: null, directory: { id: a.json.system, rev: a.json.rev } }));
  assert.equal(c.json.system, a.json.system);
  assert.equal(c.json.sites[0], a.json.sites[0]);
});

test("a strong identity matches without a location", async () => {
  const d = directory();
  const a = await d.share(obs(recorder(), [p25Site(1, 1, 851e6)], { cell: null }));
  const b = await d.share(obs(recorder(), [p25Site(1, 1, 851e6)], { cell: DENVER }));
  assert.equal(b.json.system, a.json.system);
});

test("a link to a merged system goes to the one it went into; a link to a hidden one isn't followed", async () => {
  const d = directory();
  const bee = { wacn: 0xbee00, sysId: 0x222 };
  const a = await d.share(obs(recorder(), [p25Site(1, 1, 851e6, bee)], { cell: DC }));
  const b = await d.share(obs(recorder(), [p25Site(1, 2, 852e6, bee)], { cell: DENVER }));
  assert.equal((await d.post("/merges", { a: a.json.system, b: b.json.system })).status, 200);
  const c = await d.share(obs(recorder(), [p25Site(1, 2, 852e6, bee)], { cell: DENVER, directory: { id: b.json.system, rev: 1 } }));
  assert.equal(c.json.system, a.json.system);
  // Hidden: a share linked to it makes its own.
  assert.equal((await d.post(`/systems/${a.json.system}/hide`, {})).status, 200);
  assert.equal((await d.get(`/systems/${a.json.system}`)).status, 404);
  const e = await d.share(obs(recorder(), [p25Site(5, 5, 855e6, { wacn: 0xbee99, sysId: 1 })], { directory: { id: a.json.system, rev: 1 } }));
  assert.notEqual(e.json.system, a.json.system);
});

test("licenses: a call sign heard replaces a lookup's (keeping its name if the same), never the user's", async () => {
  const d = directory();
  const site = (callSigns: [number, string][]) => {
    const s = p25Site(1, 1, 851e6);
    s.heard!.callSigns = callSigns.map(([freqHz, callSign]) => ({ freqHz, callSign }));
    return s;
  };
  const sys = (fcc: Record<string, { callSign: string; name?: string; from?: "user" | "air" | "lookup" }>, cs: [number, string][]) => ({ type: "p25" as const, name: "", fcc, sites: [site(cs)] });
  const a = await d.share(obs(recorder(), [], { system: sys({ "851000000": { callSign: "WAAA111", name: "LOOKED UP", from: "lookup" }, "852000000": { callSign: "WUSR222", name: "MINE", from: "user" }, "853000000": { callSign: "WLKP333", name: "COUNTY", from: "lookup" } }, []) }));
  await d.share(obs(recorder(), [], { system: sys({}, [[851e6, "WAAA111"], [852e6, "WAIR999"], [853e6, "WAIR333"]]) }));
  const l = (await d.get(`/systems/${a.json.system}`)).json.licenses;
  assert.deepEqual(l["851000000"], { callSign: "WAAA111", name: "LOOKED UP", source: "air" });
  assert.deepEqual(l["852000000"], { callSign: "WUSR222", name: "MINE", source: "user" });
  assert.deepEqual(l["853000000"], { callSign: "WAIR333", name: "", source: "air" });
});

test("talkgroups only heard are listed as not named yet; a name makes them active; encryption and sites are kept", async () => {
  const d = directory();
  const a = await d.share(obs(recorder(), [p25Site(1, 1, 851e6)], { heardTalkgroups: [{ number: 5, grants: 3, sites: [0], encrypted: true }] }));
  let t = (await d.get(`/systems/${a.json.system}/talkgroups`)).json.talkgroups[0];
  assert.deepEqual([t.number, t.status, t.encrypted, t.grants, t.alpha], [5, "heard", true, 3, ""]);
  await d.share(obs(recorder(), [p25Site(1, 1, 851e6)], { talkgroups: [{ number: 5, alpha: "SWAT" }], heardTalkgroups: [{ number: 5, grants: 2, sites: [0] }] }));
  t = (await d.get(`/systems/${a.json.system}/talkgroups`)).json.talkgroups[0];
  assert.deepEqual([t.status, t.alpha, t.grants, t.encrypted], ["active", "SWAT", 5, true]);
});

test("a site's facts fill in, never erase: identity, modulation, band plan; frequencies on the raster", async () => {
  const d = directory();
  const s1 = p25Site(1, 1, 851_012_600);
  s1.expect = { wacn: 0xbee01, sysId: 0x3a9, rfss: 1, site: 1 };
  s1.heard!.identity = { wacn: 0xbee01, sysId: 0x3a9, rfss: 1, site: 1 };
  const a = await d.share(obs(recorder(), [s1]));
  const s2 = p25Site(1, 1, 851_012_500, { modulation: "qpsk" });
  await d.share(obs(recorder(), [s2]));
  const site = (await d.get(`/systems/${a.json.system}`)).json.sites[0];
  assert.deepEqual(site.controlChannelsHz, [851_012_500]);
  assert.equal(site.nac, 0x443);
  assert.equal(site.modulation, "qpsk");
});

test("a neighbour with another SysID isn't made a site of this system", async () => {
  const d = directory();
  const s = p25Site(1, 1, 851e6);
  s.heard!.neighbours = [{ sysId: 0x999, rfss: 2, site: 1, freqHz: 852e6 }, { sysId: null, rfss: 1, site: 2, freqHz: 853e6 }];
  const a = await d.share(obs(recorder(), [s]));
  const sites = (await d.get(`/systems/${a.json.system}`)).json.sites;
  assert.deepEqual(sites.map((x: any) => [x.rfss, x.site, x.status]), [[1, 1, "heard"], [1, 2, "announced"]]);
});

test("each share is kept as it came, and recorded", async () => {
  const d = directory();
  const r = recorder();
  const a = await d.share(obs(r, [p25Site(1, 1, 851e6)]));
  const rows = await d.db.all<any>("SELECT recorder_id, status, system_id, r2_key FROM observations");
  assert.deepEqual([rows[0].recorder_id, rows[0].status, rows[0].system_id], [r, "applied", a.json.system]);
  assert.equal(JSON.parse(d.kept[rows[0].r2_key]).recorder, r);
});

test("a control channel nearby isn't enough when the identities disagree, or the system is hidden", async () => {
  const d = directory();
  const a = await d.share(obs(recorder(), [p25Site(1, 1, 851e6, { wacn: 0xbee01, sysId: 0x100 })], { cell: DC }));
  // Same frequency, same place, another system's identity: its own system.
  const b = await d.share(obs(recorder(), [p25Site(1, 1, 851e6, { wacn: 0xbee01, sysId: 0x200 })], { cell: DC }));
  assert.notEqual(b.json.system, a.json.system);
  // Same identity but another site number on that frequency: not that site.
  const c = await d.share(obs(recorder(), [p25Site(1, 9, 851e6, { wacn: 0xbee01, sysId: 0x100 })], { cell: DC }));
  assert.equal(c.json.system, a.json.system, "the same system (by its identity)");
  assert.notEqual(c.json.sites[0], a.json.sites[0], "but another site");
  // A site with no identity on the air, matched by its frequency only — unless that system is hidden.
  const bare = (cc: number) => ({ controlChannelsHz: [cc] });
  const e = await d.share(obs(recorder(), [], { cell: DC, system: { type: "p25", name: "", sites: [bare(855e6)] } }));
  const f = await d.share(obs(recorder(), [], { cell: DC, system: { type: "p25", name: "", sites: [bare(855e6)] } }));
  assert.equal(f.json.system, e.json.system);
  await d.post(`/systems/${e.json.system}/hide`, {});
  const g = await d.share(obs(recorder(), [], { cell: DC, system: { type: "p25", name: "", sites: [bare(855e6)] } }));
  assert.notEqual(g.json.system, e.json.system);
});

test("a hidden system's own identity still finds it, and it stays hidden (a takedown isn't undone by the next share)", async () => {
  const d = directory();
  const a = await d.share(obs(recorder(), [p25Site(1, 1, 851e6, { wacn: 0xbee05 })]));
  await d.post(`/systems/${a.json.system}/hide`, {});
  const b = await d.share(obs(recorder(), [p25Site(1, 1, 851e6, { wacn: 0xbee05 })]));
  assert.equal(b.json.system, a.json.system);
  assert.equal((await d.get(`/systems/${a.json.system}`)).status, 404);
});
