// Change sets: what they write, what they record, versions.

import assert from "node:assert/strict";
import { test } from "node:test";
import { insertRows, lit, MAX_SQL } from "../src/db.ts";
import { sqlite } from "../src/sqlite.ts";
import { ChangeSet } from "../src/store.ts";

const actor = { actorKind: "admin" as const, actorId: "test", kind: "edit" as const };
const system = (cs: ChangeSet, name = "") => cs.create("system", { type: "p25", name, status: "active", created_at: 1, updated_at: 1 });

test("a change set writes its records and a revision for each change; the system's version goes up once", async () => {
  const db = sqlite();
  const cs = new ChangeSet(db, actor, 1000);
  const s = await system(cs, "A");
  const site = await cs.create("site", { system_id: s.id, name: "north", status: "heard" });
  await cs.set("system", s.id as string, "name", "B");
  await cs.set("site", site.id as string, "name", "north"); // no change: no revision
  const revs = await cs.commit();
  assert.equal(revs.get(s.id as string), 1);
  const rows = await db.all<any>("SELECT record_kind, field, before, after FROM revisions ORDER BY seq");
  assert.deepEqual(rows.map((r) => [r.record_kind, r.field]), [["system", "*"], ["site", "*"], ["system", "name"]]);
  assert.equal(JSON.parse(rows[2].before), "A");
  assert.deepEqual((await db.all<any>("SELECT name, rev FROM systems"))[0], { name: "B", rev: 1 });
  assert.deepEqual(await db.all("SELECT system_id, rev, changeset_id FROM system_revs"), [{ system_id: s.id, rev: 1, changeset_id: cs.id }]);
  assert.equal((await db.all<any>("SELECT kind, actor_id FROM changesets"))[0].actor_id, "test");
});

test("reads see the change set's own writes; queries mix its new rows with the database's", async () => {
  const db = sqlite();
  const a = new ChangeSet(db, actor);
  const s = await system(a);
  await a.create("talkgroup", { system_id: s.id, number: 1, alpha: "one", status: "active" });
  await a.commit();
  const b = new ChangeSet(db, actor);
  await b.create("talkgroup", { system_id: s.id, number: 2, alpha: "two", status: "active" });
  const all = await b.query("talkgroup", "system_id = ?", [s.id], (r) => r.system_id === s.id);
  assert.deepEqual(all.map((t) => t.number).sort(), [1, 2]);
  const one = all.find((t) => t.number === 1)!;
  await b.set("talkgroup", one.id as string, "alpha", "uno");
  assert.equal((await b.get("talkgroup", one.id as string))!.alpha, "uno");
  assert.equal((await db.all<any>("SELECT alpha FROM talkgroups WHERE number = 1"))[0].alpha, "one", "not written before commit");
  await b.commit();
  assert.deepEqual((await db.all<any>("SELECT number, alpha FROM talkgroups ORDER BY number")).map((r) => [r.number, r.alpha]), [[1, "uno"], [2, "two"]]);
});

test("evidence counters change without revisions or a new version", async () => {
  const db = sqlite();
  const a = new ChangeSet(db, actor);
  const s = await system(a);
  const t = await a.create("talkgroup", { system_id: s.id, number: 1, status: "heard", grants: 0 });
  await a.commit();
  const b = new ChangeSet(db, actor);
  await b.stat("talkgroup", t.id as string, { last_heard: 5 }, { grants: 3 });
  await b.stat("talkgroup", t.id as string, {}, { grants: 2 });
  const revs = await b.commit();
  assert.equal(revs.size, 0);
  assert.equal(b.empty, true);
  assert.deepEqual((await db.all<any>("SELECT grants, last_heard FROM talkgroups"))[0], { grants: 5, last_heard: 5 });
  assert.equal((await db.all<any>("SELECT COUNT(*) AS n FROM changesets"))[0].n, 1, "no change set for evidence only");
});

test("moving a record from one system to another versions both", async () => {
  const db = sqlite();
  const a = new ChangeSet(db, actor);
  const x = await system(a);
  const y = await system(a);
  const site = await a.create("site", { system_id: x.id, status: "heard" });
  await a.commit();
  const b = new ChangeSet(db, actor);
  await b.set("site", site.id as string, "system_id", y.id);
  const revs = await b.commit();
  assert.deepEqual([...revs.keys()].sort(), [x.id, y.id].sort());
});

test("records of records find their system: a site's frequency, a talkgroup's candidate's supporter", async () => {
  const db = sqlite();
  const cs = new ChangeSet(db, actor);
  const s = await system(cs);
  const site = await cs.create("site", { system_id: s.id, status: "heard" });
  const t = await cs.create("talkgroup", { system_id: s.id, number: 1, status: "active" });
  const c = await cs.create("candidate", { record_id: t.id, field: "alpha", value: "x" });
  assert.equal(await cs.systemOf(site.id as string), s.id);
  assert.equal(await cs.systemOf(c.id as string), s.id);
  const f = await cs.create("freq", { site_id: site.id, freq_hz: 1, use: "control" });
  assert.equal(await cs.systemOf(f.id as string), s.id);
  assert.equal(await cs.systemOf("r_0000000001"), null);
  assert.equal(await cs.systemOf(null), null);
});

test("remove and restore are revisions too", async () => {
  const db = sqlite();
  const a = new ChangeSet(db, actor);
  const s = await system(a);
  const t = await a.create("talkgroup", { system_id: s.id, number: 7, alpha: "seven", status: "active" });
  await a.commit();
  const b = new ChangeSet(db, actor);
  await b.remove("talkgroup", t.id as string);
  await b.commit();
  assert.equal((await db.all("SELECT * FROM talkgroups")).length, 0);
  const row = JSON.parse((await db.all<any>("SELECT before FROM revisions WHERE field = '*' AND after IS NULL"))[0].before);
  const c = new ChangeSet(db, actor);
  await c.restore("talkgroup", row);
  await c.commit();
  assert.equal((await db.all<any>("SELECT alpha FROM talkgroups"))[0].alpha, "seven");
});

test("only revisioned fields can be set", async () => {
  const cs = new ChangeSet(sqlite(), actor);
  const s = await system(cs);
  await assert.rejects(cs.set("system", s.id as string, "rev", 9), /isn't a revisioned field/);
  await assert.rejects(cs.set("system", "sys_nope000000", "name", "x"), /no system/);
});

test("SQL literals: quotes doubled, NUL dropped, numbers and nulls as themselves, objects as JSON", () => {
  assert.equal(lit("it's"), "'it''s'");
  assert.equal(lit("a\0b"), "'ab'");
  assert.equal(lit(5), "5");
  assert.equal(lit(NaN), "NULL");
  assert.equal(lit(null), "NULL");
  assert.equal(lit(undefined), "NULL");
  assert.equal(lit(true), "1");
  assert.equal(lit({ a: "b'c" }), `'{"a":"b''c"}'`);
});

test("multi-row INSERTs split under the size limit, and round-trip awkward text exactly", async () => {
  const db = sqlite();
  const nasty = ["'; DROP TABLE systems; --", 'quote " and \\ backslash', "emoji 📻 and ünïcödé", "new\nline", "x".repeat(3000)];
  const rows = Array.from({ length: 200 }, (_, i) => [`cand_${String(i).padStart(10, "0")}`, "tg_0000000001", "alpha", nasty[i % nasty.length]]);
  const stmts = insertRows("candidates", ["id", "record_id", "field", "value"], rows);
  assert.ok(stmts.length > 1, "split");
  assert.ok(stmts.every((s) => s.sql.length <= MAX_SQL + 100));
  await db.batch(stmts);
  const got = await db.all<any>("SELECT value FROM candidates ORDER BY id");
  assert.equal(got.length, 200);
  for (let i = 0; i < 200; i++) assert.equal(got[i].value, nasty[i % nasty.length]);
  assert.equal((await db.all("SELECT * FROM systems")).length, 0);
});

test("a commit is all or nothing", async () => {
  const db = sqlite();
  const cs = new ChangeSet(db, actor);
  await system(cs);
  cs.raw({ sql: "INSERT INTO nowhere VALUES (1)", params: [] });
  await assert.rejects(cs.commit());
  assert.equal((await db.all("SELECT * FROM systems")).length, 0);
  assert.equal((await db.all("SELECT * FROM revisions")).length, 0);
});
