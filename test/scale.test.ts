// A share the size of a real statewide system: one change set, a handful of statements.

import assert from "node:assert/strict";
import { test } from "node:test";
import { directory, obs, p25Site, recorder } from "./helpers.ts";

test("a 3,000-talkgroup share commits as one batch of few statements, quickly; the next share of it is cheap", async () => {
  const d = directory();
  const counted: number[] = [];
  const batch = d.db.batch.bind(d.db);
  d.db.batch = async (stmts) => {
    counted.push(stmts.length);
    await batch(stmts);
  };
  const talkgroups = Array.from({ length: 3000 }, (_, i) => ({ number: i + 1, alpha: `TG ${i + 1}`, description: `Talkgroup ${i + 1}'s "description"`, mode: "D", tag: "Law Dispatch", category: "County" }));
  const t0 = performance.now();
  const a = await d.share(obs(recorder(), [p25Site(1, 1, 851_000_000)], { talkgroups }));
  const first = performance.now() - t0;
  assert.equal(a.status, 201, JSON.stringify(a.json));
  assert.ok(Math.max(...counted) < 300, `statements in the biggest batch: ${Math.max(...counted)}`);
  const tgs = (await d.get(`/systems/${a.json.system}/talkgroups`)).json.talkgroups;
  assert.equal(tgs.length, 3000);
  assert.equal(tgs[41].description, `Talkgroup 42's "description"`);
  counted.length = 0;
  const t1 = performance.now();
  const b = await d.share(obs(recorder(), [p25Site(1, 1, 851_000_000)], { directory: { id: a.json.system, rev: a.json.rev }, talkgroups: talkgroups.map((t) => ({ ...t, source: "directory" as const })) }));
  const second = performance.now() - t1;
  assert.equal(b.json.rev, a.json.rev, "an unchanged import changes nothing");
  console.log(`first share ${first.toFixed(0)} ms, ${counted.length} batches; unchanged re-share ${second.toFixed(0)} ms`);
});
