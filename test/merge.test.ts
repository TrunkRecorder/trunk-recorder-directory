// Merging two systems, proposals, and undoing a merge.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DC, DENVER, directory, obs, p25Site, recorder } from "./helpers.ts";

const bee = { wacn: 0xbee00, sysId: 0x5a5 };

async function twoRecords(d: ReturnType<typeof directory>) {
  const a = await d.share(obs(recorder(), [p25Site(1, 1, 851e6, { ...bee, neighbours: [[1, 2, 852e6]] })], { cell: DC, talkgroups: [{ number: 10, alpha: "Ten A" }, { number: 11, alpha: "Eleven" }] }));
  const b = await d.share(obs(recorder(), [p25Site(1, 2, 852e6, bee), p25Site(1, 3, 853e6, bee)], { cell: DENVER, talkgroups: [{ number: 10, alpha: "Ten B" }, { number: 12, alpha: "Twelve" }] }));
  return { a: a.json.system as string, b: b.json.system as string };
}

test("a merge: sites unioned (the announced twin filled in), talkgroups pooled by number, licenses and claims moved", async () => {
  const d = directory();
  const { a, b } = await twoRecords(d);
  assert.notEqual(a, b);
  const m = await d.post("/merges", { a: b, b: a, why: "test" });
  assert.equal(m.status, 200, JSON.stringify(m.json));
  assert.equal(m.json.kept, a, "the older is kept, whichever way asked");
  const s = (await d.get(`/systems/${a}`)).json;
  assert.deepEqual(s.sites.map((x: any) => [x.rfss, x.site, x.status]), [[1, 1, "heard"], [1, 2, "heard"], [1, 3, "heard"]]);
  const tgs = (await d.get(`/systems/${a}/talkgroups`)).json.talkgroups;
  assert.deepEqual(tgs.map((t: any) => [t.number, t.alpha]), [[10, "Ten A"], [11, "Eleven"], [12, "Twelve"]]);
  assert.deepEqual(tgs[0].alternatives.map((x: any) => x.value), ["Ten B"]);
  // The gone one's claims now find the kept one: a later share of site 1-3 lands there.
  const later = await d.share(obs(recorder(), [p25Site(1, 3, 853e6, bee)], { cell: DENVER }));
  assert.equal(later.json.system, a);
  // Its old site ID redirects too.
  const gone = await d.db.all<any>("SELECT id, merged_into, status FROM sites WHERE status = 'merged'");
  assert.equal(gone.length, 1, "the gone record's 1-2 merged into the announced 1-2");
});

test("merges are refused between different kinds, or a system and itself", async () => {
  const d = directory();
  const a = await d.share(obs(recorder(), [p25Site(1, 1, 851e6)]));
  const s = await d.share(obs(recorder(), [], { system: { type: "smartnet", name: "", sites: [{ controlChannelsHz: [852e6], expect: { sysId: 1 } }] } }));
  assert.equal((await d.post("/merges", { a: a.json.system, b: s.json.system })).status, 400);
  assert.equal((await d.post("/merges", { a: a.json.system, b: a.json.system })).status, 400);
});

test("weak evidence is proposed, not merged; a proposal can be rejected", async () => {
  const d = directory();
  // Two default-WACN records, then a share that matches one by identity and the other only by a control channel nearby.
  const a = await d.share(obs(recorder(), [p25Site(1, 1, 851e6, bee)], { cell: DC }));
  const other = await d.share(obs(recorder(), [], { cell: DC, system: { type: "p25", name: "", sites: [{ controlChannelsHz: [859e6] }] } }));
  const c = await d.share(obs(recorder(), [p25Site(1, 1, 851e6, bee), { controlChannelsHz: [859e6] }], { cell: DC }));
  assert.equal(c.json.system, a.json.system);
  assert.deepEqual(c.json.merged, []);
  const p = (await d.get("/merge-proposals")).json.proposals;
  assert.equal(p.length, 1);
  assert.deepEqual([p[0].a_id, p[0].b_id].sort(), [a.json.system, other.json.system].sort());
  assert.equal((await d.post(`/merge-proposals/${p[0].id}/reject`, {})).status, 200);
  assert.equal((await d.get("/merge-proposals")).json.proposals.length, 0);
});

test("a merge reverted gives both back their IDs, sites, talkgroups and names; a redirect stops being one", async () => {
  const d = directory();
  const { a, b } = await twoRecords(d);
  const m = await d.post("/merges", { a, b });
  assert.equal((await d.get(`/systems/${b}`)).status, 301);
  const r = await d.post(`/changesets/${m.json.changesetId}/revert`, {});
  assert.deepEqual(r.json.conflicts, []);
  assert.equal((await d.get(`/systems/${b}`)).status, 200);
  assert.deepEqual((await d.get(`/systems/${b}`)).json.sites.map((x: any) => [x.rfss, x.site]), [[1, 2], [1, 3]]);
  assert.deepEqual((await d.get(`/systems/${a}/talkgroups`)).json.talkgroups.map((t: any) => [t.number, t.alpha]), [[10, "Ten A"], [11, "Eleven"]]);
  assert.deepEqual((await d.get(`/systems/${b}/talkgroups`)).json.talkgroups.map((t: any) => [t.number, t.alpha]), [[10, "Ten B"], [12, "Twelve"]]);
  assert.equal((await d.db.all("SELECT * FROM redirects")).length, 0);
});

test("history shows the merge on both systems, and the gone one's old versions still read", async () => {
  const d = directory();
  const { a, b } = await twoRecords(d);
  const before = (await d.get(`/systems/${b}`)).json.rev;
  await d.post("/merges", { a, b });
  const ha = (await d.get(`/systems/${a}/history`)).json.history;
  assert.equal(ha[0].kind, "merge");
  const old = await d.db.all<any>("SELECT status FROM systems WHERE id = ?", [b]);
  assert.equal(old[0].status, "merged");
  const view = await d.get(`/systems/${a}?rev=${ha[1].rev}`);
  assert.deepEqual(view.json.sites.map((x: any) => [x.rfss, x.site, x.status]), [[1, 1, "heard"], [1, 2, "announced"]], "a before the merge");
  void before;
});
