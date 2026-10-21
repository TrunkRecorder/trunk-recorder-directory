// Which name is shown: support, the margin, decay, changing one's mind, quarantine, locks.

import assert from "node:assert/strict";
import { test } from "node:test";
import { HALF_LIFE_MS, NameIndex } from "../src/names.ts";
import { sqlite } from "../src/sqlite.ts";
import { ChangeSet } from "../src/store.ts";

const DAY = 86400_000;
const T0 = Date.UTC(2026, 0, 1);

async function setup() {
  const db = sqlite();
  const cs = new ChangeSet(db, { actorKind: "system", actorId: "t", kind: "edit" }, T0);
  const s = await cs.create("system", { type: "p25", name: "", status: "active", created_at: T0, updated_at: T0 });
  const t = await cs.create("talkgroup", { system_id: s.id, number: 1, alpha: "", mode: "", status: "active" });
  await cs.commit();
  const tg = t.id as string;
  /** Actors assert values at a time, each its own change set; the value shown after. */
  const say = async (at: number, field: string, pairs: [string, string][]) => {
    const c = new ChangeSet(db, { actorKind: "recorder", actorId: "t", kind: "share" }, at);
    const names = await NameIndex.load(c, [tg]);
    for (const [actor, value] of pairs) await names.assert("talkgroup", tg, field, value, actor);
    await c.commit();
    return (await db.all<any>(`SELECT ${field} AS v FROM talkgroups WHERE id = ?`, [tg]))[0].v as string;
  };
  return { db, tg, say };
}

test("an empty name takes the first given; then a challenger needs a lead of 2", async () => {
  const { say } = await setup();
  assert.equal(await say(T0, "alpha", [["r_a", "Fire"]]), "Fire");
  assert.equal(await say(T0, "alpha", [["r_b", "FD"]]), "Fire", "1 to 1");
  assert.equal(await say(T0, "alpha", [["r_c", "FD"]]), "Fire", "2 to 1");
  assert.equal(await say(T0, "alpha", [["r_d", "FD"]]), "FD", "3 to 1");
  assert.equal(await say(T0, "alpha", [["r_e", "Fire"]]), "FD", "3 to 2: the one shown stays (no flip-flop)");
});

test("settings (mode, tag…) change on any lead", async () => {
  const { say } = await setup();
  assert.equal(await say(T0, "mode", [["r_a", "D"]]), "D");
  assert.equal(await say(T0, "mode", [["r_b", "E"], ["r_c", "E"]]), "E");
});

test("an actor that changes its mind moves its support (no double counting)", async () => {
  const { say, db } = await setup();
  await say(T0, "alpha", [["r_a", "One"], ["r_b", "Two"], ["r_c", "Two"], ["r_d", "Two"]]);
  assert.equal(await say(T0, "alpha", [["r_a", "Two"], ["r_a", "One"]]), "Two", "back where it was: 1 to 3");
  assert.equal(await say(T0, "alpha", [["r_b", "One"]]), "Two", "2 to 2: the one shown stays");
  assert.equal(await say(T0, "alpha", [["r_c", "One"]]), "One", "3 to 1");
  const live = await db.all<any>("SELECT c.value, COUNT(*) AS n FROM supporters s JOIN candidates c ON c.id = s.candidate_id WHERE s.void = 0 GROUP BY c.value ORDER BY c.value");
  assert.deepEqual(live.map((r) => [r.value, r.n]), [["One", 3], ["Two", 1]]);
  assert.equal(await say(T0, "alpha", [["r_e", "One"]]), "One");
  // Back to its first choice: the old support comes back, not a new one.
  await say(T0, "alpha", [["r_b", "Two"]]);
  const sup = await db.all<any>("SELECT COUNT(*) AS n FROM supporters WHERE actor = 'r_b'");
  assert.equal(sup[0].n, 2);
});

test("old support fades: a year-old majority loses to fresh voices", async () => {
  const { say } = await setup();
  await say(T0, "alpha", [["r_a", "Old"], ["r_b", "Old"], ["r_c", "Old"]]);
  const later = T0 + 2 * HALF_LIFE_MS; // 3 supporters at a quarter weight: 0.75
  assert.equal(await say(later, "alpha", [["r_d", "New"], ["r_e", "New"]]), "Old", "2 against 0.75: not past the margin");
  assert.equal(await say(later + DAY, "alpha", [["r_f", "New"]]), "New", "3 against 0.75");
});

test("quarantined actors' support doesn't count", async () => {
  const { say, db } = await setup();
  await say(T0, "alpha", [["r_a", "Real"]]);
  await db.batch([{ sql: "INSERT INTO quarantined (actor, at) VALUES ('r_x', 0), ('r_y', 0), ('r_z', 0)", params: [] }]);
  assert.equal(await say(T0, "alpha", [["r_x", "Spam"], ["r_y", "Spam"], ["r_z", "Spam"]]), "Real");
});

test("a lock beats any support; the latest lock wins", async () => {
  const { db, tg, say } = await setup();
  const lock = async (value: string, at: number) => {
    const c = new ChangeSet(db, { actorKind: "steward", actorId: "a_s", kind: "lock" }, at);
    const names = await NameIndex.load(c, [tg]);
    await names.lock("talkgroup", tg, "alpha", value, "a_s", "");
    await c.commit();
  };
  await lock("Locked", T0);
  assert.equal(await say(T0, "alpha", [["r_a", "X"], ["r_b", "X"], ["r_c", "X"], ["r_d", "X"]]), "Locked");
  await lock("Relocked", T0 + 1);
  assert.equal(await say(T0 + 2, "alpha", [["r_e", "X"]]), "Relocked");
});

test("the candidates' view: values with their support, best first", async () => {
  const { db, tg, say } = await setup();
  await say(T0, "alpha", [["r_a", "A"], ["r_b", "B"], ["r_c", "B"]]);
  const c = new ChangeSet(db, { actorKind: "system", actorId: "t", kind: "edit" }, T0);
  const v = (await NameIndex.load(c, [tg])).view(tg, "alpha");
  assert.deepEqual(v.map((x) => [x.value, x.supporters]), [["B", 2], ["A", 1]]);
});
