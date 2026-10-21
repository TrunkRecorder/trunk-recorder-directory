// Reverting: what goes back, what's a conflict, reverting reverts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { directory, obs, p25Site, recorder } from "./helpers.ts";

const site = p25Site(1, 1, 851e6);
const tgs = (pairs: [number, string][]) => pairs.map(([number, alpha]) => ({ number, alpha }));
const names = async (d: ReturnType<typeof directory>, id: string) => (await d.get(`/systems/${id}/talkgroups`)).json.talkgroups.map((t: any) => [t.number, t.alpha]);

test("reverting a share removes what it added and puts back what it changed", async () => {
  const d = directory();
  const a = await d.share(obs(recorder(), [site], { talkgroups: tgs([[1, "One"]]) }));
  const b = await d.share(obs(recorder(), [site], { talkgroups: tgs([[2, "Two"]]) }));
  const h = (await d.get(`/systems/${a.json.system}/history`)).json.history;
  const r = await d.post(`/changesets/${h[0].changesetId}/revert`, {});
  assert.equal(r.status, 200);
  assert.ok(r.json.reverted > 0);
  assert.deepEqual(await names(d, a.json.system), [[1, "One"]]);
  const obsRow = await d.db.all<any>("SELECT status FROM observations WHERE system_id = ? ORDER BY at", [a.json.system]);
  assert.deepEqual(obsRow.map((o) => o.status), ["applied", "reverted"]);
  void b;
});

test("a field changed again since is a conflict: left as it is, and reported", async () => {
  const d = directory();
  const a = await d.share(obs(recorder(), [site], { talkgroups: tgs([[1, "One"]]) }));
  const id = a.json.system;
  const tg = (await d.get(`/systems/${id}/talkgroups`)).json.talkgroups[0].id;
  await d.post("/locks", { id: tg, field: "alpha", value: "Locked one" });
  const lockCs = (await d.get(`/systems/${id}/history`)).json.history[0].changesetId;
  await d.post("/locks", { id: tg, field: "alpha", value: "Locked two" });
  const r = await d.post(`/changesets/${lockCs}/revert`, {});
  assert.deepEqual(r.json.conflicts.map((c: any) => [c.kind, c.field]), [["talkgroup", "alpha"]]);
  assert.deepEqual(await names(d, id), [[1, "Locked two"]]);
});

test("a revert is a version, and reverting it brings the change back", async () => {
  const d = directory();
  const a = await d.share(obs(recorder(), [site], { talkgroups: tgs([[1, "One"]]) }));
  await d.share(obs(recorder(), [site], { talkgroups: tgs([[2, "Two"]]) }));
  const id = a.json.system;
  const h = (await d.get(`/systems/${id}/history`)).json.history;
  const r1 = await d.post(`/changesets/${h[0].changesetId}/revert`, {});
  assert.deepEqual(await names(d, id), [[1, "One"]]);
  const h2 = (await d.get(`/systems/${id}/history`)).json.history;
  assert.equal(h2[0].kind, "revert");
  assert.equal(h2[0].revertsId, h[0].changesetId);
  await d.post(`/changesets/${r1.json.changesetId}/revert`, {});
  assert.deepEqual(await names(d, id), [[1, "One"], [2, "Two"]]);
});

test("back to a version: every change since undone as one change set", async () => {
  const d = directory();
  const a = await d.share(obs(recorder(), [site], { talkgroups: tgs([[1, "One"]]) }));
  const id = a.json.system;
  for (let i = 2; i <= 5; i++) await d.share(obs(recorder(), [site], { talkgroups: tgs([[i, `T${i}`]]) }));
  const r = await d.post(`/systems/${id}/revert`, { to: a.json.rev });
  assert.equal(r.status, 200);
  assert.deepEqual(await names(d, id), [[1, "One"]]);
  assert.equal(Object.keys(r.json.systems).length, 1);
  // Nothing to revert: no change set.
  const none = await d.post(`/systems/${id}/revert`, { to: (await d.get(`/systems/${id}`)).json.rev });
  assert.equal(none.json.changesetId, null);
  assert.equal((await d.post(`/systems/${id}/revert`, {})).status, 400);
});

test("everything one recorder did, across systems, reverted", async () => {
  const d = directory();
  const good = await d.share(obs(recorder(), [site], { talkgroups: tgs([[1, "One"]]) }));
  const other = await d.share(obs(recorder(), [p25Site(2, 2, 852e6, { wacn: 0xbee07 })], { talkgroups: tgs([[9, "Nine"]]) }));
  const bad = recorder();
  await d.share(obs(bad, [site], { talkgroups: tgs([[66, "Junk"]]) }));
  await d.share(obs(bad, [p25Site(2, 2, 852e6, { wacn: 0xbee07 })], { talkgroups: tgs([[67, "Junk"]]) }));
  const r = await d.post(`/actors/${bad}/revert`, {});
  assert.equal(Object.keys(r.json.systems).length, 2);
  assert.deepEqual(await names(d, good.json.system), [[1, "One"]]);
  assert.deepEqual(await names(d, other.json.system), [[9, "Nine"]]);
});

test("reverting what doesn't exist is an error", async () => {
  const d = directory();
  assert.equal((await d.post("/changesets/cs_nope000000/revert", {})).status, 400);
});
