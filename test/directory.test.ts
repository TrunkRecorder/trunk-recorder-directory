// The directory through its API: sharing, partial views, merging, names, versions, revert.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ARLINGTON, DC, DENVER, directory, obs, p25Site, recorder } from "./helpers.ts";

const tg = (number: number, alpha: string, more = {}) => ({ number, alpha, mode: "D", tag: "Fire Dispatch", ...more });

test("a share makes a system with its sites, frequencies, licenses and talkgroups; the same share again changes nothing", async () => {
  const d = directory();
  const r = recorder();
  const o = obs(r, [p25Site(1, 1, 857_987_500, { name: "dcfd", heard: { identity: { wacn: 0xbee01, sysId: 0x3a9, rfss: 1, site: 1, nac: 0x443 }, voice: [{ freqHz: 858_587_500, grants: 40 }], callSigns: [{ freqHz: 859_087_500, callSign: "KNJA391" }] } })], {
    talkgroups: [tg(716, "FD Disp"), tg(717, "FD Tac 1")],
    heardTalkgroups: [{ number: 716, grants: 30, sites: [0] }, { number: 999, grants: 2, sites: [0], encrypted: true }],
    system: { type: "p25", name: "DC Fire and EMS", fcc: { "857987500": { callSign: "WPXT459", name: "DISTRICT OF COLUMBIA", from: "lookup" } }, sites: [] },
  });
  o.system.sites = [p25Site(1, 1, 857_987_500, { name: "dcfd" })];
  o.system.sites[0].heard!.callSigns = [{ freqHz: 859_087_500, callSign: "KNJA391" }];
  const res = await d.share(o);
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.created, true);
  const id = res.json.system;
  const s = (await d.get(`/systems/${id}`)).json;
  assert.equal(s.name, "DC Fire and EMS");
  assert.equal((s.wacn as number).toString(16), "bee01");
  assert.equal(s.sites.length, 1);
  assert.deepEqual(s.sites[0].controlChannelsHz, [857_987_500]);
  assert.deepEqual(s.sites[0].voiceChannelsHz, [858_987_500]);
  assert.equal(s.sites[0].heardCells, 1);
  assert.deepEqual(s.licenses["859087500"], { callSign: "KNJA391", name: "", source: "air" });
  assert.equal(s.licenses["857987500"].callSign, "WPXT459");
  const tgs = (await d.get(`/systems/${id}/talkgroups`)).json.talkgroups;
  assert.deepEqual(tgs.map((t: any) => [t.number, t.alpha, t.status]), [[716, "FD Disp", "active"], [717, "FD Tac 1", "active"], [999, "", "heard"]]);
  assert.equal(tgs.find((t: any) => t.number === 999).encrypted, true);
  assert.deepEqual(tgs.find((t: any) => t.number === 716).sites, [s.sites[0].id]);
  // Again, linked as TRP will be: the same system, nothing new to version.
  const again = await d.share({ ...o, directory: { id, rev: res.json.rev }, system: { ...o.system, sites: o.system.sites.map((x) => ({ ...x, directoryId: s.sites[0].id })) } });
  assert.equal(again.json.system, id);
  assert.equal(again.json.created, false);
  assert.equal(again.json.rev, res.json.rev);
});

test("a statewide system is built from partial views: each recorder adds its site; neighbours are announced sites until heard", async () => {
  const d = directory();
  // Recorder A hears site 1-1, which announces 1-2 and 1-3.
  const a = await d.share(obs(recorder(), [p25Site(1, 1, 851_000_000, { neighbours: [[1, 2, 852_000_000], [1, 3, 853_000_000]] })]));
  const id = a.json.system;
  let s = (await d.get(`/systems/${id}`)).json;
  assert.deepEqual(s.sites.map((x: any) => [x.rfss, x.site, x.status]), [[1, 1, "heard"], [1, 2, "announced"], [1, 3, "announced"]]);
  assert.deepEqual(s.sites[1].controlChannelsHz, [852_000_000]);
  // Recorder B, far away (another region), hears site 1-2: the same system (its WACN isn't the default).
  const b = await d.share(obs(recorder(), [p25Site(1, 2, 852_000_000)], { cell: DENVER, talkgroups: [tg(42, "Statewide Interop")], heardTalkgroups: [{ number: 42, grants: 5, sites: [0] }] }));
  assert.equal(b.json.system, id);
  assert.equal(b.json.created, false);
  s = (await d.get(`/systems/${id}`)).json;
  assert.deepEqual(s.sites.map((x: any) => [x.rfss, x.site, x.status]), [[1, 1, "heard"], [1, 2, "heard"], [1, 3, "announced"]]);
  assert.equal(b.json.sites[0], s.sites[1].id, "the announced site is the one heard now");
  // Importing part of it: the talkgroups heard at the sites chosen.
  const part = (await d.get(`/systems/${id}/talkgroups?sites=${s.sites[0].id}`)).json.talkgroups;
  assert.deepEqual(part.map((t: any) => t.number), []);
  const there = (await d.get(`/systems/${id}/talkgroups?sites=${s.sites[1].id}`)).json.talkgroups;
  assert.deepEqual(there.map((t: any) => t.number), [42]);
});

test("a default-WACN identity is scoped to its region: far apart, two systems; a recorder hearing both merges them; the merge reverts", async () => {
  const d = directory();
  const bee = { wacn: 0xbee00, sysId: 0x1a2 };
  const east = await d.share(obs(recorder(), [p25Site(1, 1, 851_000_000, bee)], { cell: DC, talkgroups: [tg(100, "Dispatch East")] }));
  const west = await d.share(obs(recorder(), [p25Site(1, 2, 852_000_000, bee)], { cell: DENVER, talkgroups: [tg(100, "Dispatch West"), tg(200, "West Only")] }));
  assert.notEqual(east.json.system, west.json.system, "BEE00.1A2 far apart: not assumed to be one");
  // A recorder linked to east that also records west's site, as one system: decisive.
  const eastView = (await d.get(`/systems/${east.json.system}`)).json;
  const both = await d.share(obs(recorder(), [p25Site(1, 1, 851_000_000, { ...bee, directoryId: eastView.sites[0].id }), p25Site(1, 2, 852_000_000, bee)], {
    cell: DENVER,
    directory: { id: east.json.system, rev: east.json.rev },
  }));
  assert.deepEqual(both.json.merged, [west.json.system]);
  assert.equal(both.json.system, east.json.system, "the older one kept");
  const merged = (await d.get(`/systems/${east.json.system}`)).json;
  assert.deepEqual(merged.sites.map((x: any) => [x.rfss, x.site]), [[1, 1], [1, 2]]);
  const tgs = (await d.get(`/systems/${east.json.system}/talkgroups`)).json.talkgroups;
  assert.deepEqual(tgs.map((t: any) => t.number), [100, 200]);
  assert.equal(tgs[0].alpha, "Dispatch East", "the shown name stays; the other is kept as a candidate");
  assert.deepEqual(tgs[0].alternatives, [{ field: "alpha", value: "Dispatch West", supporters: 1 }]);
  // The gone system's ID answers with where it went.
  const old = await d.get(`/systems/${west.json.system}`);
  assert.equal(old.status, 301);
  assert.equal(old.json.movedTo, east.json.system);
  // Reverting the merge: both come back, with their own sites and talkgroups.
  const h = (await d.get(`/systems/${east.json.system}/history`)).json.history;
  const mergeCs = h.find((x: any) => x.kind === "merge").changesetId;
  const rev = await d.post(`/changesets/${mergeCs}/revert`, {});
  assert.equal(rev.status, 200, JSON.stringify(rev.json));
  assert.deepEqual(rev.json.conflicts, []);
  const w = (await d.get(`/systems/${west.json.system}`));
  assert.equal(w.status, 200);
  assert.deepEqual(w.json.sites.map((x: any) => [x.rfss, x.site]), [[1, 2]]);
  assert.deepEqual((await d.get(`/systems/${west.json.system}/talkgroups`)).json.talkgroups.map((t: any) => [t.number, t.alpha]), [[100, "Dispatch West"], [200, "West Only"]]);
  assert.deepEqual((await d.get(`/systems/${east.json.system}`)).json.sites.map((x: any) => [x.rfss, x.site]), [[1, 1]]);
});

test("names: a challenger must lead by the margin; what a recorder imported isn't a vote; a lock beats everything", async () => {
  const d = directory();
  const site = p25Site(1, 1, 851_000_000);
  const first = await d.share(obs(recorder(), [site], { talkgroups: [tg(100, "Fire Dispatch")] }));
  const id = first.json.system;
  const name = async () => (await d.get(`/systems/${id}/talkgroups`)).json.talkgroups[0].alpha;
  // One for another name: not enough.
  await d.share(obs(recorder(), [site], { talkgroups: [tg(100, "FD Dispatch")] }));
  assert.equal(await name(), "Fire Dispatch");
  // A recorder that imported it and changed nothing: not a vote either way.
  const v = (await d.get(`/systems/${id}`)).json;
  await d.share(obs(recorder(), [site], { directory: { id, rev: v.rev }, talkgroups: [tg(100, "Fire Dispatch", { source: "directory" })] }));
  const cands = (await d.get(`/systems/${id}/candidates`)).json.candidates;
  const alpha = Object.values(cands)[0] as any;
  assert.deepEqual(alpha.alpha.map((c: any) => [c.value, c.supporters]), [["Fire Dispatch", 1], ["FD Dispatch", 1]]);
  // Two more for the challenger: 3 against 1, past the margin.
  await d.share(obs(recorder(), [site], { talkgroups: [tg(100, "FD Dispatch")] }));
  assert.equal(await name(), "Fire Dispatch", "2 to 1 isn't a lead of 2");
  await d.share(obs(recorder(), [site], { talkgroups: [tg(100, "FD Dispatch")] }));
  assert.equal(await name(), "FD Dispatch");
  // A steward's lock.
  const tgId = (await d.get(`/systems/${id}/talkgroups`)).json.talkgroups[0].id;
  assert.equal((await d.post("/locks", { id: tgId, field: "alpha", value: "Fire Dispatch", reason: "the county's own name" })).status, 200);
  await d.share(obs(recorder(), [site], { talkgroups: [tg(100, "FD Dispatch")] }));
  assert.equal(await name(), "Fire Dispatch");
});

test("versions: every change is kept; a share reverts; any version can be read, and two compared", async () => {
  const d = directory();
  const site = p25Site(1, 1, 851_000_000);
  const a = await d.share(obs(recorder(), [site], { talkgroups: [tg(100, "Dispatch")] }));
  const id = a.json.system;
  const v1 = a.json.rev;
  // A vandal renames everything (three of them, to beat the margin), and adds a talkgroup.
  const vandal = recorder();
  const b = await d.share(obs(vandal, [site], { talkgroups: [tg(100, "LOL"), tg(666, "Junk")] }));
  for (const r of [recorder(), recorder()]) await d.share(obs(r, [site], { talkgroups: [tg(100, "LOL")] }));
  const now = (await d.get(`/systems/${id}`)).json.rev;
  assert.equal((await d.get(`/systems/${id}/talkgroups`)).json.talkgroups[0].alpha, "LOL");
  // As it was.
  const old = (await d.get(`/systems/${id}/talkgroups?rev=${v1}`)).json.talkgroups;
  assert.deepEqual(old.map((t: any) => [t.number, t.alpha]), [[100, "Dispatch"]]);
  const df = (await d.get(`/systems/${id}/diff?from=${v1}&to=${now}`)).json;
  assert.deepEqual(df.talkgroups.added.map((t: any) => t.number), [666]);
  assert.deepEqual(df.talkgroups.changed.map((c: any) => [c.from.alpha, c.to.alpha]), [["Dispatch", "LOL"]]);
  // History: a version each, recorders not named.
  const h = (await d.get(`/systems/${id}/history`)).json.history;
  assert.equal(h[0].rev, now);
  assert.ok(h.every((x: any) => x.actor === "a recorder"));
  // Back to version 1, as one change set.
  const back = await d.post(`/systems/${id}/revert`, { to: v1 });
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.deepEqual((await d.get(`/systems/${id}/talkgroups`)).json.talkgroups.map((t: any) => [t.number, t.alpha]), [[100, "Dispatch"]]);
  // The revert is a version too, and can itself be reverted.
  const h2 = (await d.get(`/systems/${id}/history`)).json.history;
  assert.equal(h2[0].kind, "revert");
  await d.post(`/changesets/${h2[0].changesetId}/revert`, {});
  assert.equal((await d.get(`/systems/${id}/talkgroups`)).json.talkgroups[0].alpha, "LOL");
  void b;
});

test("a quarantined recorder's shares and support stop counting; everything it did can be reverted", async () => {
  const d = directory();
  const site = p25Site(1, 1, 851_000_000);
  const a = await d.share(obs(recorder(), [site], { talkgroups: [tg(100, "Dispatch")] }));
  const bad = recorder();
  await d.share(obs(bad, [site], { talkgroups: [tg(100, "Dispatch"), tg(666, "Spam")] }));
  assert.equal((await d.post("/quarantine", { actor: bad, reason: "spam" })).status, 200);
  const later = await d.share(obs(bad, [site], { talkgroups: [tg(777, "More spam")] }));
  assert.equal(later.status, 202);
  assert.deepEqual((await d.get(`/systems/${a.json.system}/talkgroups`)).json.talkgroups.map((t: any) => t.number), [100, 666]);
  const r = await d.post(`/actors/${bad}/revert`, {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual((await d.get(`/systems/${a.json.system}/talkgroups`)).json.talkgroups.map((t: any) => [t.number, t.alpha]), [[100, "Dispatch"]]);
});

test("what's near: systems heard from cells in range, nearest and most heard first", async () => {
  const d = directory();
  const dc = await d.share(obs(recorder(), [p25Site(1, 1, 851_000_000)], { cell: DC }));
  const o = obs(recorder(), [], { cell: DENVER, system: { type: "p25", name: "Denver", sites: [p25Site(1, 1, 852_000_000, { wacn: 0xbee02 })] } });
  assert.equal((await d.share(o)).status, 201);
  const near = (await d.get(`/systems?lat=38.88&lon=-77.1&radiusKm=30`)).json.systems;
  assert.deepEqual(near.map((s: any) => s.id), [dc.json.system]);
  assert.equal(near[0].sitesHeard, 1);
  void ARLINGTON;
});

test("search by frequency, call sign, identity and words; a system exports as TRP's config", async () => {
  const d = directory();
  const site = p25Site(1, 1, 857_987_500);
  site.heard!.callSigns = [{ freqHz: 859_087_500, callSign: "KNJA391" }];
  const a = await d.share(obs(recorder(), [site], { talkgroups: [tg(716, "Engine 16 Tac")] }));
  const id = a.json.system;
  assert.equal((await d.get("/search?q=857.9875")).json.hits[0].systemId, id);
  assert.equal((await d.get("/search?q=KNJA391")).json.hits[0].kind, "license");
  assert.equal((await d.get("/search?q=BEE01.3A9")).json.hits[0].systemId, id);
  assert.equal((await d.get("/search?q=engine")).json.hits[0].kind, "talkgroup");
  assert.equal((await d.get(`/search?q=716&system=${id}`)).json.hits[0].label, "716 Engine 16 Tac");
  const cfg = (await d.get(`/systems/${id}/config`)).json;
  assert.deepEqual(cfg.system.directory, { id, rev: a.json.rev });
  assert.deepEqual(cfg.system.sites[0].expect, { nac: 0x443, wacn: 0xbee01, sysId: 0x3a9, rfss: 1, site: 1 });
  assert.equal(cfg.system.sites[0].directoryId.slice(0, 5), "site_");
  assert.equal(cfg.talkgroupsCsv, "Decimal,Hex,Alpha Tag,Mode,Description,Tag,Category,Priority\n716,2cc,Engine 16 Tac,D,,Fire Dispatch,,\n");
  const csv = await d.get(`/systems/${id}/talkgroups.csv`);
  assert.match(csv.json, /^Decimal,Hex/);
});

test("a share is checked: a broken one is refused; stewards' actions need the token", async () => {
  const d = directory();
  assert.equal((await d.share({ v: 1 } as never)).status, 400);
  assert.equal((await d.share(obs("bad id", [p25Site(1, 1, 851e6)]))).status, 400);
  assert.equal((await d.share(obs(recorder(), []))).status, 400);
  assert.equal((await d.post("/quarantine", { actor: "r_x" }, false)).status, 401);
  assert.equal((await d.get("/systems/sys_nope0000")).status, 404);
});
